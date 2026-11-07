/**
 * Helpers shared by the image-to-image AI nodes (upscale, inpaint, colorize, style, low-light, line art).
 * Exports an empty NodeDef[] so the auto-registration glob is satisfied.
 */
import '../../core/ai/models-img';
import { fingerprint } from '../../core/ai/image';
import { setAiTask } from '../../core/ai/runtime';
import type { NodeDef, RawTex } from '../../core/types';

export default [] as NodeDef[];

/** RGBA float texture → RGB HWC float32, clamped to 0..1. */
export function rgbOf(src: RawTex): Float32Array {
  const n = src.width * src.height;
  const out = new Float32Array(n * 3);
  const d = src.data;
  const k = d instanceof Uint8Array ? 1 / 255 : 1;
  for (let i = 0; i < n; i++) {
    out[i * 3] = Math.min(1, Math.max(0, d[i * 4] * k));
    out[i * 3 + 1] = Math.min(1, Math.max(0, d[i * 4 + 1] * k));
    out[i * 3 + 2] = Math.min(1, Math.max(0, d[i * 4 + 2] * k));
  }
  return out;
}

/** True for a constant image (e.g. the black frame a downstream node renders while an upstream AI node is pending). */
export function isFlat(fp: Uint8Array) {
  let lo = 255, hi = 0;
  for (let i = 0; i < fp.length; i++) {
    if (fp[i] < lo) lo = fp[i];
    if (fp[i] > hi) hi = fp[i];
  }
  return hi - lo <= 1;
}

/** Content fingerprint + exact size, for memo keys of results that are tied to one resolution. */
export function sizedFp(rgb: Float32Array, w: number, h: number) {
  return { fp: fingerprint(rgb, w, h), size: `${w}x${h}` };
}

/** Crop (x0, y0, w, h) of an RGB HWC image (row stride W) into a [1,3,h,w] tensor, times `mul`. */
export function cropCHW(rgb: Float32Array, W: number, x0: number, y0: number, w: number, h: number, mul = 1): Float32Array {
  const n = w * h;
  const out = new Float32Array(3 * n);
  for (let y = 0; y < h; y++) {
    let s = ((y0 + y) * W + x0) * 3;
    const o = y * w;
    for (let x = 0; x < w; x++, s += 3) {
      out[o + x] = rgb[s] * mul;
      out[n + o + x] = rgb[s + 1] * mul;
      out[2 * n + o + x] = rgb[s + 2] * mul;
    }
  }
  return out;
}

/** NCHW planes (c channels) → RGBA float RawTex; channel i goes to component i (others 0, alpha 1 if c < 4). */
export function planesTex(data: Float32Array, c: number, w: number, h: number, offset = 0): RawTex {
  const n = w * h;
  const out = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 4; k++) out[i * 4 + k] = k < c ? data[(offset + k) * n + i] : k === 3 ? 1 : 0;
  }
  return { width: w, height: h, data: out };
}

let seq = 0;
/** Progress of a multi-step job in the AI toast (cleared by end()). */
export function progress(label: string) {
  const id = `img${++seq}`;
  return {
    step: (done: number, total: number) => setAiTask(id, { label, done, total }),
    end: () => setAiTask(id, null),
  };
}

/** Bicubic (Catmull-Rom) sampling of `tex` at v_uv, for blends against the original. */
export const BICUBIC_GLSL = /* glsl */ `
vec4 bicubic(sampler2D tex, vec2 size, vec2 uv) {
  vec2 p = uv * size - 0.5;
  vec2 f = fract(p);
  ivec2 b = ivec2(floor(p));
  vec2 f2 = f * f, f3 = f2 * f;
  vec2 w0 = -0.5 * f3 + f2 - 0.5 * f;
  vec2 w1 = 1.5 * f3 - 2.5 * f2 + 1.0;
  vec2 w2 = -1.5 * f3 + 2.0 * f2 + 0.5 * f;
  vec2 w3 = 0.5 * f3 - 0.5 * f2;
  vec2 wx[4] = vec2[4](vec2(w0.x), vec2(w1.x), vec2(w2.x), vec2(w3.x));
  float wy[4] = float[4](w0.y, w1.y, w2.y, w3.y);
  ivec2 mx = ivec2(size) - 1;
  vec4 acc = vec4(0.0);
  for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) {
    ivec2 q = clamp(b + ivec2(i - 1, j - 1), ivec2(0), mx);
    acc += texelFetch(tex, q, 0) * wx[i].x * wy[j];
  }
  return acc;
}`;
