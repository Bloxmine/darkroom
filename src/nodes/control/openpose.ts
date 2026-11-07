/**
 * control.openpose: the standard OpenPose control image (black background, 18-keypoint COCO skeleton in the
 * exact controlnet_aux colours, optional 21-point hands and 68-point face dots), drawn from MediaPipe
 * landmarks: ai.pose's analysis (pose-analysis.ts, shared memo), MediaPipe Hand Landmarker and the face
 * analysis shared with ai.faces.
 */
import { InferenceMemo } from '../../core/ai/image';
import { MP_HAND } from '../../core/ai/models-control';
import { getTask, mpStatus, noteRun } from '../../core/ai/mediapipe';
import { defineNode } from '../../core/registry';
import type { NodeDef, RawTex } from '../../core/types';
import { analyzeFaces, regionImageData, texFingerprint } from '../ai/face-analysis';
import { makeCanvas, type Ctx2D } from '../ai/face-draw';
import { analyzePose } from '../ai/pose-analysis';
import { CATEGORY, CONTROL_COLOR, detectDims, resolutionParam } from './_shared';
import {
  handEdgeColor, HAND_EDGES, limbColor, LIMB_SEQ, mediapipeToOpenpose, MESH_TO_FACE68, OPENPOSE_COLORS, type Body18,
} from './_openpose';

const MODES = ['openpose', 'openpose_hand', 'openpose_face', 'openpose_faceonly', 'openpose_full'];
const MODELS = ['Lite', 'Full'];
const rgb = (c: number[]) => `rgb(${c[0]},${c[1]},${c[2]})`;

const handMemo = new InferenceMemo<[number, number][][]>(6);
let handQueue: Promise<unknown> = Promise.resolve();

/** 21-point hands (normalised), MediaPipe Hand Landmarker on the whole image. */
function analyzeHands(src: RawTex, maxHands: number, fp: Uint8Array): Promise<[number, number][][]> {
  const n = Math.max(1, Math.min(8, maxHands));
  return handMemo.get(`hands:${n}`, fp, Math.min(src.width, src.height), 768, async () => {
    const task = await getTask(`hands:${n}`, MP_HAND, (v) => v.HandLandmarker, { numHands: n, minHandDetectionConfidence: 0.4, minHandPresenceConfidence: 0.4 });
    const img = regionImageData(src, [0, 0, 1, 1], 1280);
    const run = handQueue.catch(() => {}).then(() => {
      const t0 = performance.now();
      const r = task.detect(img);
      noteRun('hands', performance.now() - t0, img.width, img.height);
      return r.landmarks.map((h) => h.map((p) => [p.x, p.y] as [number, number]));
    });
    handQueue = run;
    return run;
  });
}

export function drawBody(g: Ctx2D, body: Body18, W: number, H: number) {
  for (let i = 0; i < LIMB_SEQ.length; i++) {
    const a = body[LIMB_SEQ[i][0] - 1], b = body[LIMB_SEQ[i][1] - 1];
    if (!a || !b) continue;
    const x0 = a[0] * W, y0 = a[1] * H, x1 = b[0] * W, y1 = b[1] * H;
    const len = Math.hypot(x1 - x0, y1 - y0);
    g.fillStyle = rgb(limbColor(i));
    g.beginPath();
    g.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.max(0.5, len / 2), 4, Math.atan2(y0 - y1, x0 - x1), 0, Math.PI * 2);
    g.fill();
  }
  for (let k = 0; k < 18; k++) {
    const p = body[k];
    if (!p) continue;
    g.fillStyle = rgb(OPENPOSE_COLORS[k]);
    g.beginPath();
    g.arc(Math.floor(p[0] * W), Math.floor(p[1] * H), 4, 0, Math.PI * 2);
    g.fill();
  }
}

function drawHand(g: Ctx2D, hand: [number, number][], W: number, H: number) {
  g.lineWidth = 2;
  g.lineCap = 'butt';
  HAND_EDGES.forEach(([a, b], i) => {
    g.strokeStyle = rgb(handEdgeColor(i).map(Math.floor));
    g.beginPath();
    g.moveTo(Math.floor(hand[a][0] * W), Math.floor(hand[a][1] * H));
    g.lineTo(Math.floor(hand[b][0] * W), Math.floor(hand[b][1] * H));
    g.stroke();
  });
  g.fillStyle = 'rgb(0,0,255)';
  for (const p of hand) {
    g.beginPath();
    g.arc(Math.floor(p[0] * W), Math.floor(p[1] * H), 4, 0, Math.PI * 2);
    g.fill();
  }
}

const openpose = defineNode({
  id: 'control.openpose',
  name: 'OpenPose (ControlNet)',
  category: CATEGORY,
  color: CONTROL_COLOR,
  heavy: true,
  description:
    'OpenPose skeleton for the ControlNet openpose models: the standard 18-keypoint COCO body on black, with the exact limb and joint colours of the ' +
    'openpose preprocessor (sd-webui-controlnet / ComfyUI), plus optional hands (21 points) and face (68 dots). ' +
    'Landmarks come from MediaPipe Pose / Hand / Face Landmarker (Apache-2.0), running locally; the neck is the shoulder midpoint.',
  tags: ['controlnet', 'openpose', 'pose', 'skeleton', 'body', 'hands', 'face', 'keypoints', 'control map', 'stable diffusion', 'preprocessor'],
  inputs: { image: { type: 'image', label: 'Image' } },
  params: {
    preprocessor: { type: 'enum', default: MODES[0], options: MODES, label: 'Preprocessor', description: 'openpose = body; _hand / _face add those; _faceonly = face dots only; _full = all.' },
    resolution: resolutionParam(512),
    model: { type: 'enum', default: MODELS[0], options: MODELS, label: 'Pose model' },
    maxPeople: { type: 'int', default: 8, min: 1, max: 10, step: 1, label: 'Max people' },
    minConfidence: { type: 'float', default: 0.5, min: 0.1, max: 0.95, step: 0.05, label: 'Keypoint confidence', description: 'Minimum MediaPipe visibility for a keypoint to be drawn.' },
  },
  cpuReadsInputs: true,
  cpu: async (ctx) => {
    const src = ctx.readInput('image');
    if (!src) return { m: { width: 1, height: 1, data: new Float32Array([0, 0, 0, 1]) } };
    const p = ctx.params;
    const mode = String(p.preprocessor);
    const body = mode !== 'openpose_faceonly';
    const hands = mode === 'openpose_hand' || mode === 'openpose_full';
    const face = mode === 'openpose_face' || mode === 'openpose_faceonly' || mode === 'openpose_full';
    const fp = texFingerprint(src);
    const conf = Number(p.minConfidence ?? 0.5);
    const [W, H] = detectDims(src.width, src.height, Number(p.resolution) || 512);
    const { canvas, g } = makeCanvas(W, H);
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);
    let people = 0;
    if (body) {
      const A = await analyzePose(src, p.model === MODELS[1], Number(p.maxPeople) || 8, conf, fp);
      for (const lm of A.people) drawBody(g, mediapipeToOpenpose(lm, conf), W, H);
      people = A.people.length;
    }
    if (hands) {
      const hs = await analyzeHands(src, 2 * (Number(p.maxPeople) || 8), fp).catch((e) => (console.warn('[darkroom ai] hand landmarker failed', e), []));
      for (const h of hs) drawHand(g, h, W, H);
    }
    if (face) {
      const F = await analyzeFaces(src, 0.5, fp).catch(() => null);
      g.fillStyle = '#fff';
      for (const f of F?.faces ?? []) {
        for (const i of MESH_TO_FACE68) {
          g.beginPath();
          g.arc(Math.floor(f.pts[i * 3] * W), Math.floor(f.pts[i * 3 + 1] * H), 3, 0, Math.PI * 2);
          g.fill();
        }
      }
    }
    if (body && !people) mpStatus('OpenPose: no person found.');
    return { m: canvas };
  },
  passes: [{ frag: `void main() { fragColor = vec4(texture(u_m, v_uv).rgb, 1.0); }` }],
});

export default [openpose] satisfies NodeDef[];
