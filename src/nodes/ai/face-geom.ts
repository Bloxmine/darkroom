/**
 * Pure face geometry for the people AI nodes (ai.faces, ai.faceRestore, ai.autoCrop): MediaPipe Face Mesh
 * landmark index sets, 5-point extraction, least-squares similarity transforms (Umeyama), and merging of
 * detections from overlapping tiles. No DOM, no models: unit-tested in face-geom.test.ts.
 * Exports an empty NodeDef[] so the auto-registration glob is satisfied.
 */
import type { NodeDef } from '../../core/types';

export default [] as NodeDef[];

/** One detected face: 478 landmarks (x, y normalised to the image, z ≈ depth in x units), flattened xyz. */
export interface FaceLm {
  pts: Float32Array;
  /** Landmark bounding box, normalised [x0, y0, x1, y1]. */
  box: [number, number, number, number];
}

// ---------------------------------------------------------------------------
// MediaPipe Face Mesh (478 points) index loops, ordered around each contour
// ---------------------------------------------------------------------------
export const FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
export const LIPS_OUTER = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146];
export const LIPS_INNER = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95];
/** The subject's right eye (image left in a frontal photo). */
export const RIGHT_EYE = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
export const LEFT_EYE = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466];
export const RIGHT_BROW = [46, 53, 52, 65, 55, 107, 66, 105, 63, 70];
export const LEFT_BROW = [276, 283, 282, 295, 285, 336, 296, 334, 293, 300];
/** Iris centre + 4 ring points. */
export const RIGHT_IRIS = [468, 469, 470, 471, 472];
export const LEFT_IRIS = [473, 474, 475, 476, 477];
/** Points on and around the nose; the region is their convex hull. */
export const NOSE_POINTS = [168, 193, 417, 196, 419, 3, 248, 198, 420, 131, 360, 49, 279, 48, 278, 64, 294, 98, 327, 97, 326, 2, 94, 19, 1, 4, 5, 195, 197, 6, 129, 358, 102, 331, 240, 460, 75, 305];
export const POSE_CONNECTIONS: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 7], [0, 4], [4, 5], [5, 6], [6, 8], [9, 10], [11, 12], [11, 13], [13, 15], [15, 17], [15, 19], [15, 21], [17, 19],
  [12, 14], [14, 16], [16, 18], [16, 20], [16, 22], [18, 20], [11, 23], [12, 24], [23, 24], [23, 25], [24, 26], [25, 27], [26, 28], [27, 29],
  [28, 30], [29, 31], [30, 32], [27, 31], [28, 32],
];

/** FFHQ 5-point template for a 512×512 aligned face (facexlib / GFPGAN): eyes (image left, right), nose tip, mouth corners. */
export const FFHQ_512: [number, number][] = [
  [192.98138, 239.94708],
  [318.90277, 240.1936],
  [256.63416, 314.01935],
  [201.26117, 371.41043],
  [313.08905, 371.15118],
];

export type Pt = [number, number];

/** Landmark i in pixels of a W×H image. */
export const lmPx = (f: FaceLm, i: number, W: number, H: number): Pt => [f.pts[i * 3] * W, f.pts[i * 3 + 1] * H];

const mean = (ps: Pt[]): Pt => {
  let x = 0, y = 0;
  for (const p of ps) {
    x += p[0];
    y += p[1];
  }
  return [x / ps.length, y / ps.length];
};

/** 5 points in pixels (image-left eye, image-right eye, nose tip, image-left mouth corner, image-right mouth corner). */
export function fivePoints(f: FaceLm, W: number, H: number): Pt[] {
  const P = (i: number) => lmPx(f, i, W, H);
  const has = f.pts.length >= 478 * 3;
  // eye centres: iris centres when the model provides them (478-point mesh), else the eye-contour mean
  const eA = has ? P(468) : mean(RIGHT_EYE.map(P));
  const eB = has ? P(473) : mean(LEFT_EYE.map(P));
  const mA = P(61), mB = P(291);
  const nose = P(1);
  // order by image x so a mirrored/turned face still maps left→left
  const [le, re] = eA[0] <= eB[0] ? [eA, eB] : [eB, eA];
  const [lm, rm] = mA[0] <= mB[0] ? [mA, mB] : [mB, mA];
  return [le, re, nose, lm, rm];
}

/** 2×3 affine [a, b, tx, c, d, ty]: x' = a·x + b·y + tx, y' = c·x + d·y + ty. */
export type Affine = [number, number, number, number, number, number];

/**
 * Least-squares similarity transform (rotation + uniform scale + translation) mapping `src` onto `dst`
 * (Umeyama 1991, 2-D closed form, no reflection).
 */
export function similarity(src: Pt[], dst: Pt[]): Affine {
  const n = Math.min(src.length, dst.length);
  const ms = mean(src.slice(0, n)), md = mean(dst.slice(0, n));
  let sxx = 0, sxy = 0, varS = 0;
  for (let i = 0; i < n; i++) {
    const x = src[i][0] - ms[0], y = src[i][1] - ms[1];
    const u = dst[i][0] - md[0], v = dst[i][1] - md[1];
    // a = Σ(x·u + y·v), b = Σ(x·v − y·u) → rotation+scale as a complex number (a + ib)/Σ|s|²
    sxx += x * u + y * v;
    sxy += x * v - y * u;
    varS += x * x + y * y;
  }
  if (varS < 1e-12) return [1, 0, md[0] - ms[0], 0, 1, md[1] - ms[1]];
  const a = sxx / varS, b = sxy / varS;
  // [a −b; b a]
  return [a, -b, md[0] - (a * ms[0] - b * ms[1]), b, a, md[1] - (b * ms[0] + a * ms[1])];
}

export function applyAffine(m: Affine, p: Pt): Pt {
  return [m[0] * p[0] + m[1] * p[1] + m[2], m[3] * p[0] + m[4] * p[1] + m[5]];
}

export function invertAffine(m: Affine): Affine {
  const [a, b, tx, c, d, ty] = m;
  const det = a * d - b * c || 1e-12;
  const ia = d / det, ib = -b / det, ic = -c / det, id = a / det;
  return [ia, ib, -(ia * tx + ib * ty), ic, id, -(ic * tx + id * ty)];
}

/** Uniform scale of a similarity transform. */
export const affineScale = (m: Affine) => Math.hypot(m[0], m[3]);

/** Bounding box of a set of normalised landmarks. */
export function lmBox(pts: Float32Array): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < pts.length; i += 3) {
    const x = pts[i], y = pts[i + 1];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

export function iou(a: [number, number, number, number], b: [number, number, number, number]) {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return ua > 0 ? inter / ua : 0;
}

/** A detection plus how trustworthy its placement was (detector pixels on the face, distance from a tile edge). */
export interface Candidate {
  face: FaceLm;
  quality: number;
}

/**
 * Merge detections from the full image and overlapping tiles: boxes overlapping by IoU > `thr` (or one
 * mostly containing the other) are the same face; the highest-quality one wins. Result sorted by area,
 * largest first (ties broken by position, so the order is deterministic).
 */
export function mergeFaces(cands: Candidate[], thr = 0.3): FaceLm[] {
  const sorted = [...cands].sort((a, b) => b.quality - a.quality);
  const kept: FaceLm[] = [];
  const contains = (a: FaceLm['box'], b: FaceLm['box']) => {
    const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
    const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
    const small = Math.min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]));
    return small > 0 && (ix * iy) / small > 0.6;
  };
  for (const c of sorted) if (!kept.some((k) => iou(k.box, c.face.box) > thr || contains(k.box, c.face.box))) kept.push(c.face);
  const area = (f: FaceLm) => (f.box[2] - f.box[0]) * (f.box[3] - f.box[1]);
  return kept.sort((a, b) => area(b) - area(a) || a.box[0] - b.box[0] || a.box[1] - b.box[1]);
}

/**
 * Overlapping square-ish tiles (normalised [x0, y0, x1, y1]) for small-face detection: tiles of about
 * `frac` × the short side, overlapping by half a tile. Empty when the image is too small to benefit.
 */
export function faceTiles(W: number, H: number, frac = 0.5, minShort = 700): [number, number, number, number][] {
  const short = Math.min(W, H);
  if (short < minShort) return [];
  const t = short * frac;
  const nx = Math.max(1, Math.ceil((W - t) / (t / 2)) + 1);
  const ny = Math.max(1, Math.ceil((H - t) / (t / 2)) + 1);
  const out: [number, number, number, number][] = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x0 = nx === 1 ? 0 : ((W - t) * i) / (nx - 1);
      const y0 = ny === 1 ? 0 : ((H - t) * j) / (ny - 1);
      out.push([x0 / W, y0 / H, (x0 + t) / W, (y0 + t) / H]);
    }
  }
  return out;
}

/** Convex hull (monotone chain), counter-clockwise. */
export function convexHull(ps: Pt[]): Pt[] {
  const p = [...ps].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: Pt[] = [], hi: Pt[] = [];
  for (const q of p) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop();
    lo.push(q);
  }
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop();
    hi.push(q);
  }
  return lo.slice(0, -1).concat(hi.slice(0, -1));
}

/** Eye-line roll (radians) and inter-ocular distance in pixels. */
export function eyeLine(f: FaceLm, W: number, H: number) {
  const [l, r] = fivePoints(f, W, H);
  return { angle: Math.atan2(r[1] - l[1], r[0] - l[0]), dist: Math.hypot(r[0] - l[0], r[1] - l[1]), mid: [(l[0] + r[0]) / 2, (l[1] + r[1]) / 2] as Pt };
}

/** A face box from a detector, normalised [x0, y0, x1, y1], with its score and 5 keypoints (normalised). */
export interface FaceBox {
  box: [number, number, number, number];
  score: number;
  kps: Pt[];
}

/** Greedy non-maximum suppression (highest score first). */
export function nms(boxes: FaceBox[], thr = 0.3): FaceBox[] {
  const s = [...boxes].sort((a, b) => b.score - a.score);
  const keep: FaceBox[] = [];
  for (const b of s) if (!keep.some((k) => iou(k.box, b.box) > thr)) keep.push(b);
  return keep;
}

/**
 * Decode YuNet (OpenCV Zoo 2023mar) outputs for a padW×padH input, as OpenCV's FaceDetectorYN does:
 * per stride s ∈ {8, 16, 32} and grid cell (r, c): score = √(clamp(cls)·clamp(obj)),
 * centre = (c + dx, r + dy)·s, size = exp(dw, dh)·s, keypoints = (c + kx, r + ky)·s.
 * Boxes are normalised by the un-padded image size w×h.
 */
export function decodeYunet(out: Record<string, { data: Float32Array }>, padW: number, padH: number, w: number, h: number, scoreThr: number): FaceBox[] {
  const res: FaceBox[] = [];
  for (const s of [8, 16, 32]) {
    const cls = out[`cls_${s}`]?.data, obj = out[`obj_${s}`]?.data, bb = out[`bbox_${s}`]?.data, kp = out[`kps_${s}`]?.data;
    if (!cls || !obj || !bb || !kp) continue;
    const cols = Math.floor(padW / s), rows = Math.floor(padH / s);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const score = Math.sqrt(Math.min(1, Math.max(0, cls[i])) * Math.min(1, Math.max(0, obj[i])));
        if (!(score >= scoreThr)) continue;
        const cx = (c + bb[i * 4]) * s, cy = (r + bb[i * 4 + 1]) * s;
        const bw = Math.exp(bb[i * 4 + 2]) * s, bh = Math.exp(bb[i * 4 + 3]) * s;
        const kps: Pt[] = [];
        for (let k = 0; k < 5; k++) kps.push([((kp[i * 10 + 2 * k] + c) * s) / w, ((kp[i * 10 + 2 * k + 1] + r) * s) / h]);
        res.push({ box: [(cx - bw / 2) / w, (cy - bh / 2) / h, (cx + bw / 2) / w, (cy + bh / 2) / h], score, kps });
      }
    }
  }
  return nms(res, 0.3);
}
