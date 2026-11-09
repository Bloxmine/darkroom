/**
 * Pure maths for the optical-flow nodes (unit-tested in flowMath.test.ts):
 *  - the Middlebury colour wheel (Baker et al., "A Database and Evaluation Methodology for Optical
 *    Flow", IJCV 2011) used by the `viz` output;
 *  - the flow encoding of `ai.opticalFlow`'s `flow` output;
 *  - bilinear sampling / warping by a flow field (CPU reference of the GPU warp, used by the datamosh
 *    feedback which accumulates on the CPU);
 *  - block quantisation of a flow field (datamosh macroblocks).
 *
 * Flow encoding (the `flow` port): an RGBA float image on frame B's pixel grid. R, G = the motion
 * (dx, dy) of the content from frame A to frame B, in units of the image width / height (so the same
 * texture works at any render scale); B = 0, A = 1. Frame B is reproduced by sampling A at
 * uv − flow(uv) (a backward warp).
 * Exports an empty NodeDef[] for the auto-registration glob.
 */
import type { NodeDef } from '../../core/types';

export default [] as NodeDef[];

/** Middlebury colour wheel: 55 RGB entries (0..255). */
export function makeColorWheel(): Uint8Array {
  const seg: [number, (i: number, n: number) => [number, number, number]][] = [
    [15, (i, n) => [255, Math.floor((255 * i) / n), 0]], // RY
    [6, (i, n) => [255 - Math.floor((255 * i) / n), 255, 0]], // YG
    [4, (i, n) => [0, 255, Math.floor((255 * i) / n)]], // GC
    [11, (i, n) => [0, 255 - Math.floor((255 * i) / n), 255]], // CB
    [13, (i, n) => [Math.floor((255 * i) / n), 0, 255]], // BM
    [6, (i, n) => [255, 0, 255 - Math.floor((255 * i) / n)]], // MR
  ];
  const out: number[] = [];
  for (const [n, f] of seg) for (let i = 0; i < n; i++) out.push(...f(i, n));
  return Uint8Array.from(out);
}

export const WHEEL = makeColorWheel();
export const WHEEL_SIZE = WHEEL.length / 3;

/**
 * Colour of a flow vector (u, v), already divided by the normalising magnitude: white at 0, fully
 * saturated at |(u,v)| = 1, dimmed (× 0.75) beyond. Returns RGB 0..1. (x right, y down, as in images.)
 */
export function flowColor(u: number, v: number): [number, number, number] {
  const n = WHEEL_SIZE;
  const rad = Math.hypot(u, v);
  const a = Math.atan2(0 - v, 0 - u) / Math.PI; // 0 − x: no negative zero at the wheel seam
  const fk = ((a + 1) / 2) * (n - 1);
  const k0 = Math.floor(fk);
  const k1 = k0 + 1 === n ? 0 : k0 + 1;
  const f = fk - k0;
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const col = ((1 - f) * WHEEL[k0 * 3 + c] + f * WHEEL[k1 * 3 + c]) / 255;
    out[c] = rad <= 1 ? 1 - rad * (1 - col) : col * 0.75;
  }
  return out;
}

/** The wheel as a 55×1 RGBA8 texture (for the GPU visualisation). */
export function wheelTexture(): { width: number; height: number; data: Uint8Array; filter: 'nearest' } {
  const data = new Uint8Array(WHEEL_SIZE * 4);
  for (let i = 0; i < WHEEL_SIZE; i++) {
    data.set(WHEEL.subarray(i * 3, i * 3 + 3), i * 4);
    data[i * 4 + 3] = 255;
  }
  return { width: WHEEL_SIZE, height: 1, data, filter: 'nearest' };
}

/**
 * Model output → `flow` encoding. `raw` is the network's NCHW [1, 2, h, w] flow in network pixels,
 * computed from image1 = B to image2 = A (so B's pixel x is found at x + raw(x) in A). The motion
 * A → B at B's pixels is −raw; it is divided by the network size to get image-relative units.
 */
export function encodeFlow(raw: Float32Array, w: number, h: number): Float32Array {
  const n = w * h;
  const out = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    out[i * 4] = -raw[i] / w;
    out[i * 4 + 1] = -raw[n + i] / h;
    out[i * 4 + 3] = 1;
  }
  return out;
}

/** A robust maximum of |flow| in pixels of a `pw`×`ph` image (the 99th percentile, at least `floor`). */
export function robustMaxMagnitude(flow: Float32Array, pw: number, ph: number, q = 0.99, floor = 0.5): number {
  const n = flow.length / 4;
  const step = Math.max(1, Math.floor(n / 20000));
  const m: number[] = [];
  for (let i = 0; i < n; i += step) m.push(Math.hypot(flow[i * 4] * pw, flow[i * 4 + 1] * ph));
  if (!m.length) return floor;
  m.sort((a, b) => a - b);
  return Math.max(floor, m[Math.min(m.length - 1, Math.floor(q * (m.length - 1)))]);
}

/**
 * Bilinear sample of an RGBA float image at normalised (u, v) (0,0 = top-left corner of the first
 * pixel, as `v_uv`), clamped to the edge like `texture()` with CLAMP_TO_EDGE. Writes into `out` at `o`.
 */
export function sampleBilinear(img: Float32Array, w: number, h: number, u: number, v: number, out: Float32Array, o: number) {
  const x = Math.min(w - 1, Math.max(0, u * w - 0.5));
  const y = Math.min(h - 1, Math.max(0, v * h - 0.5));
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  const a = (y0 * w + x0) * 4, b = (y0 * w + x1) * 4, c = (y1 * w + x0) * 4, d = (y1 * w + x1) * 4;
  for (let k = 0; k < 4; k++) {
    const top = img[a + k] + (img[b + k] - img[a + k]) * fx;
    const bot = img[c + k] + (img[d + k] - img[c + k]) * fx;
    out[o + k] = top + (bot - top) * fy;
  }
}

/**
 * Backward warp: out(uv) = src(uv − amount · flow(uv)), with the flow (`flow` encoding, any size)
 * sampled bilinearly at the output pixel. With src = frame A and amount 1 this predicts frame B.
 */
export function warpByFlow(src: Float32Array, w: number, h: number, flow: Float32Array, fw: number, fh: number, amount = 1): Float32Array {
  const out = new Float32Array(w * h * 4);
  const f = new Float32Array(4);
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w;
      sampleBilinear(flow, fw, fh, u, v, f, 0);
      sampleBilinear(src, w, h, u - amount * f[0], v - amount * f[1], out, (y * w + x) * 4);
    }
  }
  return out;
}

/**
 * Macroblock flow: every `block`×`block` cell of a w×h grid gets the mean flow of the cell (sampled
 * from `flow`, any size). Returns a w×h `flow`-encoded image (block ≤ 1 → plain resample).
 */
export function blockFlow(flow: Float32Array, fw: number, fh: number, w: number, h: number, block: number): Float32Array {
  const out = new Float32Array(w * h * 4);
  const f = new Float32Array(4);
  const b = Math.max(1, Math.round(block));
  for (let by = 0; by < h; by += b) {
    for (let bx = 0; bx < w; bx += b) {
      const bw = Math.min(b, w - bx), bh = Math.min(b, h - by);
      // mean of up to 4×4 samples inside the block
      const s = Math.min(4, bw, bh);
      let mx = 0, my = 0;
      for (let j = 0; j < s; j++) for (let i = 0; i < s; i++) {
        sampleBilinear(flow, fw, fh, (bx + ((i + 0.5) / s) * bw) / w, (by + ((j + 0.5) / s) * bh) / h, f, 0);
        mx += f[0];
        my += f[1];
      }
      mx /= s * s;
      my /= s * s;
      for (let y = by; y < by + bh; y++) for (let x = bx; x < bx + bw; x++) {
        const o = (y * w + x) * 4;
        out[o] = mx;
        out[o + 1] = my;
        out[o + 3] = 1;
      }
    }
  }
  return out;
}

/** FNV-1a hash of a float buffer quantised to 8 bits (exact-content memo keys for video frames). */
export function hashPixels(a: ArrayLike<number>, stride = 1): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < a.length; i += stride) {
    h ^= Math.round(Math.min(1, Math.max(0, a[i])) * 255);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36) + ':' + a.length;
}
