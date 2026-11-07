/**
 * Pure maths for Smart Auto-Crop (ai.autoCrop): target aspect, crop size (from params only, so the node's
 * `size()` can report it), and a deterministic search for the best crop position scored on a saliency grid
 * and face boxes. No DOM, no models: unit-tested in autocrop-score.test.ts.
 * Exports an empty NodeDef[] so the auto-registration glob is satisfied.
 */
import type { NodeDef } from '../../core/types';

export default [] as NodeDef[];

export const CROP_ASPECTS = ['4:5', '1:1', '3:2', '2:3', '16:9', '9:16', '4:3', '3:4', '5:4', 'original', 'custom'];
export const CROP_MODES = ['subject', 'faces', 'thirds'];

/** Width / height of the target crop. */
export function targetAspect(aspect: string, W: number, H: number, customW = 1, customH = 1): number {
  if (aspect === 'original') return W / H;
  if (aspect === 'custom') return Math.max(1e-3, customW) / Math.max(1e-3, customH);
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(aspect);
  return m ? Number(m[1]) / Number(m[2]) : W / H;
}

/** Largest rect of `ratio` inside W×H, shrunk by `zoom` (0 = largest, 1 = 40 % of it), integer px, ≥ 1. */
export function cropSize(W: number, H: number, ratio: number, zoom: number): [number, number] {
  const k = 1 - 0.6 * Math.min(1, Math.max(0, zoom));
  let w = W, h = W / ratio;
  if (h > H) {
    h = H;
    w = H * ratio;
  }
  return [Math.max(1, Math.min(W, Math.round(w * k))), Math.max(1, Math.min(H, Math.round(h * k)))];
}

export interface CropFace {
  /** Normalised [x0, y0, x1, y1] (landmark or detector box). */
  box: [number, number, number, number];
  /** Normalised eye-line height. */
  eyeY: number;
}

export interface CropInput {
  /** Saliency / subject grid, row-major, 0..1. */
  sal: Float32Array;
  sw: number;
  sh: number;
  faces: CropFace[];
}

export interface CropScore {
  x: number;
  y: number;
  score: number;
}

/** Summed-area table of a grid (size (sw+1)×(sh+1)). */
function integral(g: Float32Array, sw: number, sh: number) {
  const I = new Float64Array((sw + 1) * (sh + 1));
  for (let y = 0; y < sh; y++) {
    let row = 0;
    for (let x = 0; x < sw; x++) {
      row += g[y * sw + x];
      I[(y + 1) * (sw + 1) + x + 1] = I[y * (sw + 1) + x + 1] + row;
    }
  }
  return I;
}

/** Sum of a normalised rect [x0,y0,x1,y1] over the grid (bilinear-free: fractional cells by area). */
function rectSum(I: Float64Array, sw: number, sh: number, x0: number, y0: number, x1: number, y1: number) {
  const at = (x: number, y: number) => {
    // integral at a fractional grid position (bilinear in the SAT)
    const gx = Math.min(sw, Math.max(0, x * sw)), gy = Math.min(sh, Math.max(0, y * sh));
    const ix = Math.min(sw - 1, Math.floor(gx)), iy = Math.min(sh - 1, Math.floor(gy));
    const fx = gx - ix, fy = gy - iy;
    const v = (a: number, b: number) => I[b * (sw + 1) + a];
    return (v(ix, iy) * (1 - fx) + v(ix + 1, iy) * fx) * (1 - fy) + (v(ix, iy + 1) * (1 - fx) + v(ix + 1, iy + 1) * fx) * fy;
  };
  return Math.max(0, at(x1, y1) - at(x0, y1) - at(x1, y0) + at(x0, y0));
}

/**
 * Score of a crop with top-left (x, y) and size (fw, fh), all normalised to the image.
 * Higher is better. Components:
 *  - kept: share of the subject mass inside the crop;
 *  - cut: mean saliency in thin bands along crop edges that are inside the image (cutting through the subject);
 *  - pad: subject mass inside the crop but within `padding` of its edges;
 *  - placement: subject centroid near the centre (subject), a thirds point (thirds), or the eye line on the
 *    upper third (faces);
 *  - faces: cutting a face is heavily penalised; heads need headroom above them.
 */
export function scoreCrop(inp: CropInput, I: Float64Array, total: number, x: number, y: number, fw: number, fh: number, mode: string, padding: number): number {
  const { sw, sh } = inp;
  const x1 = x + fw, y1 = y + fh;
  const inside = rectSum(I, sw, sh, x, y, x1, y1);
  const kept = total > 0 ? inside / total : 0;
  // cut bands (2.5 % of the crop) on edges that are not the image border
  const bx = fw * 0.025, by = fh * 0.025;
  let cut = 0, bands = 0;
  const band = (a: number, b: number, c: number, d: number) => {
    const area = (c - a) * (d - b) * sw * sh;
    if (area > 0) {
      cut += rectSum(I, sw, sh, a, b, c, d) / area;
      bands++;
    }
  };
  if (x > 1e-4) band(x, y, x + bx, y1);
  if (x1 < 1 - 1e-4) band(x1 - bx, y, x1, y1);
  if (y > 1e-4) band(x, y, x1, y + by);
  if (y1 < 1 - 1e-4) band(x, y1 - by, x1, y1);
  // subject mass in the padding margin
  const px = fw * padding, py = fh * padding;
  const pad = total > 0 && padding > 0 ? (inside - rectSum(I, sw, sh, x + px, y + py, x1 - px, y1 - py)) / total : 0;

  // centroid of the subject within the crop (via moments on a coarse pass)
  let cx = 0.5, cy = 0.5;
  if (inside > 1e-6) {
    let mx = 0, my = 0, m = 0;
    const gx0 = Math.floor(x * sw), gx1 = Math.ceil(x1 * sw), gy0 = Math.floor(y * sh), gy1 = Math.ceil(y1 * sh);
    for (let gy = gy0; gy < gy1; gy++) {
      for (let gx = gx0; gx < gx1; gx++) {
        const v = inp.sal[gy * sw + gx];
        if (!v) continue;
        mx += v * ((gx + 0.5) / sw);
        my += v * ((gy + 0.5) / sh);
        m += v;
      }
    }
    if (m > 0) {
      cx = (mx / m - x) / fw;
      cy = (my / m - y) / fh;
    }
  }
  const thirds = Math.min(...[1 / 3, 2 / 3].flatMap((a) => [1 / 3, 2 / 3].map((b) => Math.hypot(cx - a, cy - b))));
  const centre = Math.hypot(cx - 0.5, cy - 0.45);

  // faces
  let faceCut = 0, faceKept = 0, headroom = 0, eye = 0, faceW = 0;
  for (const f of inp.faces) {
    const [a, b, c, d] = f.box;
    const w = (c - a) * (d - b);
    faceW += w;
    // the head extends ~35 % of the face height above the landmark box
    const top = b - (d - b) * 0.35;
    const ix = Math.max(0, Math.min(c, x1) - Math.max(a, x)), iy = Math.max(0, Math.min(d, y1) - Math.max(b, y));
    const frac = (ix * iy) / Math.max(1e-9, w);
    if (frac > 0.98) {
      faceKept += w;
      const room = (top - y) / fh;
      if (room < 0.03) headroom += w * (0.03 - room) * 10;
      eye += w * Math.abs((f.eyeY - y) / fh - 1 / 3);
    } else if (frac > 0) faceCut += w * (1 + frac);
    else faceCut += w * 0.6; // a face left out entirely is also a loss
  }
  const nf = faceW > 0 ? 1 / faceW : 0;

  const W8 =
    mode === 'faces'
      ? { kept: 1.5, cut: 1.5, pad: 1, place: 0, centre: 0.3, fcut: 6, fkept: 1, head: 3, eye: 3 }
      : mode === 'thirds'
        ? { kept: 2, cut: 1.5, pad: 1, place: 2.5, centre: 0, fcut: 4, fkept: 0.5, head: 2, eye: 0.5 }
        : { kept: 3, cut: 2, pad: 1.5, place: 0, centre: 1.2, fcut: 5, fkept: 0.5, head: 2, eye: 1 };
  return (
    W8.kept * kept -
    W8.cut * (bands ? cut / bands : 0) -
    W8.pad * pad -
    W8.place * thirds -
    W8.centre * centre +
    nf * (W8.fkept * faceKept - W8.fcut * faceCut - W8.head * headroom - W8.eye * eye)
  );
}

/**
 * Best crop position for a crop of normalised size fw×fh: a 41×41 grid search over all positions, then a
 * finer search around the winner. Deterministic (ties go to the position closer to the centre).
 * Returns the normalised top-left.
 */
export function bestCrop(inp: CropInput, fw: number, fh: number, mode: string, padding: number): CropScore {
  fw = Math.min(1, fw);
  fh = Math.min(1, fh);
  const I = integral(inp.sal, inp.sw, inp.sh);
  const total = I[I.length - 1];
  const sx = 1 - fw, sy = 1 - fh;
  let best: CropScore = { x: sx / 2, y: sy / 2, score: -Infinity };
  const tryAt = (x: number, y: number) => {
    x = Math.min(sx, Math.max(0, x));
    y = Math.min(sy, Math.max(0, y));
    const s = scoreCrop(inp, I, total, x, y, fw, fh, mode, padding) - 1e-4 * Math.hypot(x - sx / 2, y - sy / 2);
    if (s > best.score + 1e-9) best = { x, y, score: s };
  };
  const N = 40;
  const nx = sx > 1e-6 ? N : 0, ny = sy > 1e-6 ? N : 0;
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) tryAt(nx ? (sx * i) / nx : 0, ny ? (sy * j) / ny : 0);
  const stx = nx ? sx / nx : 0, sty = ny ? sy / ny : 0;
  const c = best;
  for (let j = -5; j <= 5; j++) for (let i = -5; i <= 5; i++) tryAt(c.x + (i * stx) / 5, c.y + (j * sty) / 5);
  return best;
}
