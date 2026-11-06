/** Pre/post-processing for AI nodes: resampling, tensor packing, and a scale-independent result memo. */
import type { RawTex } from '../types';

/** Separable triangle-filter weights (antialiased when shrinking, bilinear when enlarging). */
function weights(srcN: number, dstN: number) {
  const scale = srcN / dstN;
  const support = Math.max(1, scale);
  const idx: Int32Array[] = [];
  const w: Float32Array[] = [];
  for (let i = 0; i < dstN; i++) {
    const c = (i + 0.5) * scale;
    const lo = Math.max(0, Math.floor(c - support));
    const hi = Math.min(srcN - 1, Math.ceil(c + support));
    const ii: number[] = [];
    const ww: number[] = [];
    let sum = 0;
    for (let j = lo; j <= hi; j++) {
      const k = Math.max(0, 1 - Math.abs(j + 0.5 - c) / support);
      if (k > 0) {
        ii.push(j);
        ww.push(k);
        sum += k;
      }
    }
    if (!ii.length) {
      ii.push(Math.min(srcN - 1, Math.max(0, Math.floor(c))));
      ww.push(1);
      sum = 1;
    }
    idx.push(Int32Array.from(ii));
    w.push(Float32Array.from(ww.map((x) => x / sum)));
  }
  return { idx, w };
}

/**
 * Resample RGBA (or RGB) float pixels to dw×dh RGB (HWC, clamped 0..1).
 * `channels` = components per source pixel (4 for engine RawTex).
 */
export function resampleRGB(src: ArrayLike<number>, sw: number, sh: number, dw: number, dh: number, channels = 4): Float32Array {
  const H = weights(sw, dw);
  const V = weights(sh, dh);
  // horizontal: sh × dw × 3
  const tmp = new Float32Array(sh * dw * 3);
  for (let y = 0; y < sh; y++) {
    const row = y * sw;
    for (let x = 0; x < dw; x++) {
      const ii = H.idx[x], ww = H.w[x];
      let r = 0, g = 0, b = 0;
      for (let k = 0; k < ii.length; k++) {
        const o = (row + ii[k]) * channels;
        const q = ww[k];
        r += Math.min(1, Math.max(0, src[o])) * q;
        g += Math.min(1, Math.max(0, src[o + 1])) * q;
        b += Math.min(1, Math.max(0, src[o + 2])) * q;
      }
      const t = (y * dw + x) * 3;
      tmp[t] = r;
      tmp[t + 1] = g;
      tmp[t + 2] = b;
    }
  }
  const out = new Float32Array(dh * dw * 3);
  for (let y = 0; y < dh; y++) {
    const ii = V.idx[y], ww = V.w[y];
    for (let x = 0; x < dw; x++) {
      let r = 0, g = 0, b = 0;
      for (let k = 0; k < ii.length; k++) {
        const o = (ii[k] * dw + x) * 3;
        const q = ww[k];
        r += tmp[o] * q;
        g += tmp[o + 1] * q;
        b += tmp[o + 2] * q;
      }
      const t = (y * dw + x) * 3;
      out[t] = r;
      out[t + 1] = g;
      out[t + 2] = b;
    }
  }
  return out;
}

/** HWC rgb → NCHW tensor data with (x / div − mean) / std. */
export function toCHW(rgb: Float32Array, w: number, h: number, mean: number[], std: number[], div = 1): Float32Array {
  const n = w * h;
  const out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) out[c * n + i] = (rgb[i * 3 + c] / div - mean[c]) / std[c];
  }
  return out;
}

/** Inference dims: short side ≈ `short`, aspect kept, both sides multiples of `mult`, long side capped at 2×short. */
export function fitDims(w: number, h: number, short: number, mult: number): [number, number] {
  const s = short / Math.min(w, h);
  const r = (v: number) => Math.max(mult, Math.round(Math.min(v * s, short * 2) / mult) * mult);
  return [r(w), r(h)];
}

/** Single-channel values → RGBA float texture (value in r,g,b; a = 1). */
export function maskTex(values: ArrayLike<number>, w: number, h: number): RawTex {
  const data = new Float32Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = values[i];
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v;
    data[i * 4 + 3] = 1;
  }
  return { width: w, height: h, data };
}

/** Normalise to 0..1 between the lo/hi percentiles (robust against a few outliers). */
export function normalizeRobust(v: Float32Array, lo = 0.005, hi = 0.995): Float32Array {
  const step = Math.max(1, Math.floor(v.length / 20000));
  const sample: number[] = [];
  for (let i = 0; i < v.length; i += step) if (Number.isFinite(v[i])) sample.push(v[i]);
  sample.sort((a, b) => a - b);
  const a = sample[Math.floor(lo * (sample.length - 1))] ?? 0;
  const b = sample[Math.ceil(hi * (sample.length - 1))] ?? 1;
  const d = b - a || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = Math.min(1, Math.max(0, (v[i] - a) / d));
  return out;
}

export function normalizeMinMax(v: Float32Array): Float32Array {
  let a = Infinity, b = -Infinity;
  for (let i = 0; i < v.length; i++) {
    if (v[i] < a) a = v[i];
    if (v[i] > b) b = v[i];
  }
  const d = b - a || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = (v[i] - a) / d;
  return out;
}

/** 24×24 8-bit RGB fingerprint of an image (from an already-resampled RGB buffer). */
export function fingerprint(rgb: Float32Array, w: number, h: number): Uint8Array {
  const t = resampleRGB(rgb, w, h, 24, 24, 3);
  const out = new Uint8Array(t.length);
  for (let i = 0; i < t.length; i++) out[i] = Math.round(t[i] * 255);
  return out;
}

function similar(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let sum = 0, max = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    sum += d;
    if (d > max) max = d;
  }
  return sum / a.length < 1.0 && max <= 10;
}

/**
 * Memo of inference results keyed by (model/size key, image fingerprint). The fingerprint makes it
 * independent of render scale: the same photo at preview and at export scale hits the same entry,
 * unless the cached result came from a source smaller than the inference size and a larger one is
 * now available (then it re-runs for quality).
 */
export class InferenceMemo<T> {
  private entries: { key: string; fp: Uint8Array; srcShort: number; value: Promise<T> }[] = [];
  constructor(private max = 8) {}

  get(key: string, fp: Uint8Array, srcShort: number, needShort: number, run: () => Promise<T>): Promise<T> {
    const i = this.entries.findIndex((e) => e.key === key && similar(e.fp, fp) && e.srcShort >= Math.min(srcShort, needShort));
    if (i >= 0) {
      const [e] = this.entries.splice(i, 1);
      this.entries.unshift(e);
      return e.value;
    }
    const entry = { key, fp, srcShort, value: run() };
    entry.value.catch(() => (this.entries = this.entries.filter((e) => e !== entry)));
    this.entries.unshift(entry);
    if (this.entries.length > this.max) this.entries.length = this.max;
    return entry.value;
  }
}
