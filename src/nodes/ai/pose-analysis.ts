/**
 * Shared body analysis for the people AI nodes: MediaPipe Pose Landmarker (33 landmarks + a person
 * segmentation mask per pose) and the Selfie Multiclass segmenter (background / hair / body skin / face skin /
 * clothes / accessories), memoised by input fingerprint.
 * The multiclass model is 256×256 and trained on selfies, so it runs on a crop around the people the pose
 * model found (much more detail for a full-body shot), or on the whole image when there are none.
 * Exports an empty NodeDef[] so the auto-registration glob is satisfied.
 */
import { InferenceMemo } from '../../core/ai/image';
import { getTask, MP_MODELS, noteRun } from '../../core/ai/mediapipe';
import type { NodeDef, RawTex } from '../../core/types';
import { analyzeFaces, regionImageData, texFingerprint } from './face-analysis';

export default [] as NodeDef[];

export interface PoseAnalysis {
  /** Per person: 33 × (x, y, z, visibility), x/y normalised to the image. */
  people: Float32Array[];
  /** Max over people of the pose segmentation masks (mw × mh), or null. */
  mask: Float32Array | null;
  mw: number;
  mh: number;
}

export interface PartsAnalysis {
  /** Normalised region the segmenter ran on. */
  region: [number, number, number, number];
  /** 6 confidence masks (background, hair, body skin, face skin, clothes, accessories), each w × h. */
  masks: Float32Array[];
  w: number;
  h: number;
}

const poseMemo = new InferenceMemo<PoseAnalysis>(6);
const partsMemo = new InferenceMemo<PartsAnalysis>(6);
const NEED_SHORT = 768;
let queue: Promise<unknown> = Promise.resolve();

type Region = [number, number, number, number];

/** Paste a w×h mask covering `r` (normalised) into the MW×MH grid of the whole image (max). */
function paste(dst: Float32Array, MW: number, MH: number, m: Float32Array, w: number, h: number, r: Region) {
  const x0 = Math.max(0, Math.floor(r[0] * MW)), x1 = Math.min(MW, Math.ceil(r[2] * MW));
  const y0 = Math.max(0, Math.floor(r[1] * MH)), y1 = Math.min(MH, Math.ceil(r[3] * MH));
  for (let y = y0; y < y1; y++) {
    const v = ((y + 0.5) / MH - r[1]) / (r[3] - r[1]);
    const sy = Math.min(h - 1, Math.max(0, Math.round(v * h - 0.5)));
    for (let x = x0; x < x1; x++) {
      const u = ((x + 0.5) / MW - r[0]) / (r[2] - r[0]);
      const sx = Math.min(w - 1, Math.max(0, Math.round(u * w - 0.5)));
      const i = y * MW + x;
      if (m[sy * w + sx] > dst[i]) dst[i] = m[sy * w + sx];
    }
  }
}

/** Crop (normalised) for a person seeded by a face box: ~5 faces wide, from just above the head to ~8 faces down. */
export function personCrop(face: Region, W: number, H: number): Region {
  const fw = (face[2] - face[0]) * W, fh = (face[3] - face[1]) * H, s = Math.max(fw, fh);
  const cx = ((face[0] + face[2]) / 2) * W;
  const top = face[1] * H - 0.9 * s, bottom = face[3] * H + 7 * s;
  const half = Math.max(2.6 * s, ((bottom - top) * 0.75) / 2);
  return [Math.max(0, (cx - half) / W), Math.max(0, top / H), Math.min(1, (cx + half) / W), Math.min(1, bottom / H)];
}

/**
 * Pose landmarks + segmentation, cached by content and settings. Top-down where faces are known: the pose
 * model runs on a crop around each detected face (MediaPipe's multi-pose output mixes limbs of neighbours in
 * group shots and misses tight portraits); whole-image poses are kept for people without a detected face
 * (e.g. seen from behind).
 */
export function analyzePose(src: RawTex, full: boolean, maxPeople: number, minConfidence: number, fp = texFingerprint(src)): Promise<PoseAnalysis> {
  const conf = Math.round(Math.min(0.95, Math.max(0.05, minConfidence)) * 20) / 20;
  const n = Math.max(1, Math.min(10, Math.round(maxPeople)));
  return poseMemo.get(`pose:${full}:${n}:${conf}`, fp, Math.min(src.width, src.height), NEED_SHORT, async () => {
    const model = full ? MP_MODELS.poseFull : MP_MODELS.poseLite;
    const key = `pose-${full ? 'full' : 'lite'}`;
    const optsFor = (k: number, seg: boolean) => ({ numPoses: k, minPoseDetectionConfidence: conf, minPosePresenceConfidence: conf, minTrackingConfidence: conf, outputSegmentationMasks: seg });
    // a task per (count, confidence, masks): re-configuring one task with setOptions aborted the wasm graph, and
    // segmentation on small crops trips a MediaPipe check (image_frame.cc ChannelSize), so crops are landmarks-only
    const taskFor = (k: number, seg: boolean) => getTask(`${key}:${k}:${conf}:${seg}`, model, (v) => v.PoseLandmarker, optsFor(k, seg));
    const W = src.width, H = src.height;
    const whole = regionImageData(src, [0, 0, 1, 1], 1024);
    const MW = whole.width, MH = whole.height;
    const mask = new Float32Array(MW * MH);
    let any = false;
    const t0 = performance.now();
    /** Poses in region r (landmarks mapped to the whole image) with their masks. */
    const detectIn = async (r: Region, k: number, seg: boolean, img = regionImageData(src, r, 512)) => {
      const task = await taskFor(k, seg);
      const run = queue.catch(() => {}).then(async () => {
        const res = task.detect(img);
        const out = res.landmarks.map((lms, j) => {
          const a = new Float32Array(33 * 4);
          lms.forEach((l, i) => a.set([r[0] + l.x * (r[2] - r[0]), r[1] + l.y * (r[3] - r[1]), l.z, l.visibility ?? 1], i * 4));
          const m = res.segmentationMasks?.[j];
          return { lm: a, mask: m ? new Float32Array(m.getAsFloat32Array()) : null, mw: m?.width ?? 0, mh: m?.height ?? 0 };
        });
        for (const m of res.segmentationMasks ?? []) m.close();
        (res as { close?: () => void }).close?.();
        return out;
      });
      queue = run;
      return run;
    };
    const people: Float32Array[] = [];
    const seeds: Region[] = [];
    // 1) top-down from faces
    const F = await analyzeFaces(src, 0.5, fp).catch(() => null);
    const faceBoxes: Region[] = [...(F?.faces ?? []).map((f) => f.box), ...(F?.extra ?? []).map((e) => e.box)].slice(0, n);
    for (const fb of faceBoxes) {
      const r = personCrop(fb, W, H);
      const [p] = await detectIn(r, 1, false);
      if (!p) continue;
      // the pose must belong to this face: its nose inside the (generously grown) face box
      const g = (fb[2] - fb[0]) * 0.75, nx = p.lm[0], ny = p.lm[1];
      if (nx < fb[0] - g || nx > fb[2] + g || ny < fb[1] - g || ny > fb[3] + g) continue;
      people.push(p.lm);
      seeds.push(fb);
      if (p.mask) {
        paste(mask, MW, MH, p.mask, p.mw, p.mh, r);
        any = true;
      }
    }
    // 2) whole image: people without a detected face, and the segmentation masks
    {
      for (const p of await detectIn([0, 0, 1, 1], n, true, whole)) {
        if (p.mask) {
          paste(mask, MW, MH, p.mask, p.mw, p.mh, [0, 0, 1, 1]);
          any = true;
        }
        if (people.length >= n) continue;
        const nose: [number, number] = [p.lm[0], p.lm[1]];
        const dup = seeds.some((fb) => {
          const g = fb[2] - fb[0];
          return nose[0] > fb[0] - g && nose[0] < fb[2] + g && nose[1] > fb[1] - g && nose[1] < fb[3] + g;
        });
        if (dup) continue;
        people.push(p.lm);
      }
    }
    noteRun(key, performance.now() - t0, W, H);
    return { people, mask: any ? mask : null, mw: MW, mh: MH };
  });
}

/** Box (normalised) around the people, padded for hair and loose clothes; whole image without people. */
export function peopleRegion(people: Float32Array[]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of people) {
    for (let i = 0; i < 33; i++) {
      if (p[i * 4 + 3] < 0.3) continue;
      const x = p[i * 4], y = p[i * 4 + 1];
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
  }
  if (!(x1 > x0 && y1 > y0)) return [0, 0, 1, 1];
  const w = x1 - x0, h = y1 - y0, s = Math.max(w, h);
  const r: [number, number, number, number] = [x0 - 0.3 * s, y0 - 0.35 * s, x1 + 0.3 * s, y1 + 0.2 * s];
  return [Math.max(0, r[0]), Math.max(0, r[1]), Math.min(1, r[2]), Math.min(1, r[3])];
}

/** Selfie Multiclass confidence masks on `region` of the image. */
export function analyzeParts(src: RawTex, region: [number, number, number, number], fp = texFingerprint(src)): Promise<PartsAnalysis> {
  const key = `parts:${region.map((v) => v.toFixed(3)).join(',')}`;
  return partsMemo.get(key, fp, Math.min(src.width, src.height), NEED_SHORT, async () => {
    const task = await getTask('selfieMulticlass', MP_MODELS.selfie, (v) => v.ImageSegmenter, { outputConfidenceMasks: true, outputCategoryMask: false });
    const img = regionImageData(src, region, 512);
    const t0 = performance.now();
    const res = task.segment(img);
    noteRun('selfieMulticlass', performance.now() - t0, img.width, img.height);
    const masks: Float32Array[] = [];
    let w = img.width, h = img.height;
    for (const m of res.confidenceMasks ?? []) {
      masks.push(new Float32Array(m.getAsFloat32Array()));
      w = m.width;
      h = m.height;
      m.close();
    }
    (res as { close?: () => void }).close?.();
    return { region, masks, w, h };
  });
}
