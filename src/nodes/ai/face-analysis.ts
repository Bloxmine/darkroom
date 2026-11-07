/**
 * Shared face analysis for the people AI nodes: MediaPipe Face Landmarker (478 landmarks) on the whole
 * image, plus YuNet (OpenCV Zoo, ONNX Runtime; the landmarker's built-in short-range BlazeFace only finds
 * faces that fill a fair part of the frame) with the landmarker re-run on a crop around each YuNet box,
 * so the small faces of group photos get landmarks too. Duplicates are merged by IoU.
 *
 * The result is memoised by a content fingerprint of the input (InferenceMemo), so ai.faces, ai.faceRestore
 * and ai.autoCrop on the same image run detection once, at any render scale.
 * Exports an empty NodeDef[] so the auto-registration glob is satisfied.
 */
import { fingerprint, InferenceMemo, resampleRGB } from '../../core/ai/image';
import '../../core/ai/models-face';
import { getTask, MP_MODELS, noteRun } from '../../core/ai/mediapipe';
import { runModelMulti } from '../../core/ai/runtime';
import type { NodeDef, RawTex } from '../../core/types';
import { decodeYunet, iou, lmBox, mergeFaces, type Candidate, type FaceBox, type FaceLm } from './face-geom';

export default [] as NodeDef[];

export interface FaceAnalysis {
  /** Largest first. Landmarks normalised to the whole image. */
  faces: FaceLm[];
  /** YuNet detections the landmarker could not fit (profiles, heavy occlusion): box + 5 keypoints only. */
  extra: FaceBox[];
  /** Size of the image the analysis ran on. */
  width: number;
  height: number;
  ms: number;
}

/** Region (normalised x0,y0,x1,y1) of an RGBA float image → ImageData, resampled so its long side ≤ maxLong. */
export function regionImageData(src: RawTex, r: [number, number, number, number] = [0, 0, 1, 1], maxLong = 2048): ImageData {
  const x0 = Math.max(0, Math.floor(r[0] * src.width)), y0 = Math.max(0, Math.floor(r[1] * src.height));
  const x1 = Math.min(src.width, Math.ceil(r[2] * src.width)), y1 = Math.min(src.height, Math.ceil(r[3] * src.height));
  const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
  const k = Math.min(1, maxLong / Math.max(w, h));
  const dw = Math.max(1, Math.round(w * k)), dh = Math.max(1, Math.round(h * k));
  const d = src.data;
  const scale = d instanceof Uint8Array ? 1 / 255 : 1;
  let sub: Float32Array;
  if (x0 === 0 && y0 === 0 && w === src.width && h === src.height && d instanceof Float32Array) sub = d;
  else {
    sub = new Float32Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      const so = ((y0 + y) * src.width + x0) * 4;
      for (let i = 0; i < w * 4; i++) sub[y * w * 4 + i] = d[so + i] * scale;
    }
  }
  const out = new ImageData(dw, dh);
  if (dw === w && dh === h) {
    for (let i = 0, n = w * h; i < n; i++) {
      out.data[i * 4] = sub[i * 4] * 255 + 0.5;
      out.data[i * 4 + 1] = sub[i * 4 + 1] * 255 + 0.5;
      out.data[i * 4 + 2] = sub[i * 4 + 2] * 255 + 0.5;
      out.data[i * 4 + 3] = 255;
    }
    return out;
  }
  const rgb = resampleRGB(sub, w, h, dw, dh, 4);
  for (let i = 0, n = dw * dh; i < n; i++) {
    out.data[i * 4] = rgb[i * 3] * 255 + 0.5;
    out.data[i * 4 + 1] = rgb[i * 3 + 1] * 255 + 0.5;
    out.data[i * 4 + 2] = rgb[i * 3 + 2] * 255 + 0.5;
    out.data[i * 4 + 3] = 255;
  }
  return out;
}

/** Scale-independent content fingerprint of a RawTex (24×24 RGB). */
export function texFingerprint(src: RawTex): Uint8Array {
  const k = Math.min(1, 96 / Math.max(src.width, src.height));
  const w = Math.max(1, Math.round(src.width * k)), h = Math.max(1, Math.round(src.height * k));
  const d = src.data instanceof Float32Array ? src.data : Float32Array.from(src.data, (v) => v / 255);
  return fingerprint(resampleRGB(d, src.width, src.height, w, h, 4), w, h);
}

const memo = new InferenceMemo<FaceAnalysis>(8);

/** Internal face cap per pass; the nodes then keep their own `max faces`. */
const NUM_FACES = 20;
/** Detection runs on the image at most this big (short side); bigger sources reuse the result. */
const NEED_SHORT = 1024;

/**
 * Faces in `src` (any render scale). Cached by content: other nodes asking about the same image (and the
 * same confidence) get the same promise.
 */
export function analyzeFaces(src: RawTex, minConfidence = 0.5, fp = texFingerprint(src)): Promise<FaceAnalysis> {
  const conf = Math.round(Math.min(0.95, Math.max(0.05, minConfidence)) * 20) / 20;
  return memo.get(`faces:${conf}`, fp, Math.min(src.width, src.height), NEED_SHORT, () => detect(src, conf));
}

async function detect(src: RawTex, conf: number): Promise<FaceAnalysis> {
  const landmarker = await getTask('faceLandmarker', MP_MODELS.face, (v) => v.FaceLandmarker, {
    numFaces: NUM_FACES,
    minFaceDetectionConfidence: conf,
    minFacePresenceConfidence: conf,
    minTrackingConfidence: conf,
    outputFaceBlendshapes: false,
    outputFacialTransformationMatrixes: false,
  });
  const t0 = performance.now();
  const W = src.width, H = src.height;
  const cands: Candidate[] = [];
  /** Landmarker on region r (normalised); `want` = the detector box the crop was made for (keep only that face). */
  const run = (r: [number, number, number, number], maxLong: number, want?: [number, number, number, number]) => {
    const img = regionImageData(src, r, maxLong);
    const res = landmarker.detect(img);
    const rw = r[2] - r[0], rh = r[3] - r[1];
    let best: Candidate | null = null;
    for (const lms of res.faceLandmarks) {
      const pts = new Float32Array(lms.length * 3);
      for (let i = 0; i < lms.length; i++) {
        pts[i * 3] = r[0] + lms[i].x * rw;
        pts[i * 3 + 1] = r[1] + lms[i].y * rh;
        pts[i * 3 + 2] = lms[i].z * rw;
      }
      const box = lmBox(pts);
      // crops around a detection see the face big → better landmarks than the whole-image pass
      const c: Candidate = { face: { pts, box }, quality: want ? 1 + iou(box, want) : (box[2] - box[0]) / rw };
      if (!want) cands.push(c);
      else if (iou(box, want) > 0.1 && (!best || c.quality > best.quality)) best = c;
    }
    if (best) cands.push(best);
  };
  // 1) the whole image (big faces)
  run([0, 0, 1, 1], 2048);
  // 2) YuNet for small / distant faces (the landmarker's own short-range BlazeFace misses faces under
  //    ~1/10 of the frame), then landmarks on a crop around each detection
  let yn: FaceBox[] = [];
  try {
    yn = await yunet(src, Math.max(0.3, conf * 0.9));
  } catch (e) {
    console.warn('[darkroom ai] YuNet face detector failed; only large faces will be found', e);
  }
  for (const { box: b } of yn) {
    // square crop ≈ 2.4× the face, in pixels
    const cx = ((b[0] + b[2]) / 2) * W, cy = ((b[1] + b[3]) / 2) * H;
    const side = Math.max((b[2] - b[0]) * W, (b[3] - b[1]) * H) * 2.4;
    const r: [number, number, number, number] = [
      Math.max(0, (cx - side / 2) / W), Math.max(0, (cy - side / 2) / H), Math.min(1, (cx + side / 2) / W), Math.min(1, (cy + side / 2) / H),
    ];
    run(r, 512, b);
  }
  const faces = mergeFaces(cands);
  const inside = (p: [number, number], b: number[]) => p[0] > b[0] && p[0] < b[2] && p[1] > b[1] && p[1] < b[3];
  const centre = (b: number[]): [number, number] => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  const extra = yn.filter((y) => !faces.some((f) => inside(centre(y.box), f.box) || inside(centre(f.box), y.box)));
  const ms = performance.now() - t0;
  noteRun('faceLandmarker', ms, W, H);
  return { faces, extra, width: W, height: H, ms };
}

/** YuNet on the image (long side ≤ 1280, padded to a multiple of 32): BGR 0..255 NCHW, no normalisation. */
async function yunet(src: RawTex, scoreThr: number): Promise<FaceBox[]> {
  const W = src.width, H = src.height;
  const k = Math.min(1, 1280 / Math.max(W, H));
  const w = Math.max(32, Math.round(W * k)), h = Math.max(32, Math.round(H * k));
  const pw = Math.ceil(w / 32) * 32, ph = Math.ceil(h / 32) * 32;
  const d = src.data instanceof Float32Array ? src.data : Float32Array.from(src.data, (v) => v / 255);
  const rgb = resampleRGB(d, W, H, w, h, 4);
  const n = pw * ph;
  const t = new Float32Array(3 * n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3, o = y * pw + x;
      t[o] = rgb[i + 2] * 255;
      t[n + o] = rgb[i + 1] * 255;
      t[2 * n + o] = rgb[i] * 255;
    }
  }
  const names = [8, 16, 32].flatMap((s) => [`cls_${s}`, `obj_${s}`, `bbox_${s}`, `kps_${s}`]);
  const out = await runModelMulti('yunet', { input: { data: t, dims: [1, 3, ph, pw] } }, names);
  return decodeYunet(out, pw, ph, w, h, scoreThr);
}
