/**
 * Shared helpers for the node library: pure-JS logic (curve baking, .cube parsing)
 * and GLSL snippets used by several nodes. Exports an empty NodeDef[] as default so
 * the auto-registration glob is satisfied.
 */
import type { NodeDef, Params, RawTex } from '../../core/types';

export default [] as NodeDef[];

/** Read a numeric param with a fallback. */
export function num(params: Params, key: string, def: number): number {
  const v = params[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'boolean' ? (v ? 1 : 0) : def;
}

// ---------------------------------------------------------------------------
// Curves
// ---------------------------------------------------------------------------

/** Sanitise curve points: clamp to 0..1, sort by x, drop duplicate x. Falls back to identity. */
export function normalizeCurve(points: unknown): [number, number][] {
  const pts: [number, number][] = [];
  if (Array.isArray(points)) {
    for (const p of points) {
      if (Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])) {
        pts.push([Math.min(1, Math.max(0, p[0])), Math.min(1, Math.max(0, p[1]))]);
      }
    }
  }
  pts.sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const p of pts) {
    if (out.length && Math.abs(out[out.length - 1][0] - p[0]) < 1e-6) out[out.length - 1] = p;
    else out.push(p);
  }
  if (out.length === 0) return [[0, 0], [1, 1]];
  return out;
}

/**
 * Monotone cubic (Fritsch–Carlson) interpolation through points sorted by x.
 * Outside the first/last point the curve is held flat. Returns `n` samples over x in [0,1].
 */
export function sampleCurve(points: unknown, n = 256): Float32Array {
  const p = normalizeCurve(points);
  const out = new Float32Array(n);
  if (p.length === 1) return out.fill(p[0][1]);
  const k = p.length;
  const d: number[] = []; // secant slopes
  for (let i = 0; i < k - 1; i++) d.push((p[i + 1][1] - p[i][1]) / (p[i + 1][0] - p[i][0]));
  const m: number[] = new Array(k);
  m[0] = d[0];
  m[k - 1] = d[k - 2];
  for (let i = 1; i < k - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < k - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  let seg = 0;
  for (let j = 0; j < n; j++) {
    const x = j / (n - 1);
    if (x <= p[0][0]) { out[j] = p[0][1]; continue; }
    if (x >= p[k - 1][0]) { out[j] = p[k - 1][1]; continue; }
    while (seg < k - 2 && x > p[seg + 1][0]) seg++;
    const h = p[seg + 1][0] - p[seg][0];
    const t = (x - p[seg][0]) / h;
    const t2 = t * t, t3 = t2 * t;
    const v = (2 * t3 - 3 * t2 + 1) * p[seg][1] + (t3 - 2 * t2 + t) * h * m[seg] + (-2 * t3 + 3 * t2) * p[seg + 1][1] + (t3 - t2) * h * m[seg + 1];
    out[j] = Math.min(1, Math.max(0, v));
  }
  return out;
}

// ---------------------------------------------------------------------------
// .cube LUTs
// ---------------------------------------------------------------------------

export interface CubeLut {
  size: number;
  /** RGB triples, red fastest, then green, then blue (size^3 entries). */
  data: Float32Array;
  domainMin: [number, number, number];
  domainMax: [number, number, number];
}

/**
 * Parse an Adobe/Resolve .cube file. 3D LUTs are returned as is; 1D LUTs are
 * expanded into an equivalent 33³ 3D LUT so the shader only handles one kind.
 */
export function parseCube(text: string): CubeLut {
  let size3 = 0, size1 = 0;
  let dmin: [number, number, number] = [0, 0, 0], dmax: [number, number, number] = [1, 1, 1];
  const vals: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const kw = parts[0].toUpperCase();
    if (kw === 'TITLE') continue;
    if (kw === 'LUT_3D_SIZE') { size3 = parseInt(parts[1], 10); continue; }
    if (kw === 'LUT_1D_SIZE') { size1 = parseInt(parts[1], 10); continue; }
    if (kw === 'DOMAIN_MIN') { dmin = [+parts[1], +parts[2], +parts[3]]; continue; }
    if (kw === 'DOMAIN_MAX') { dmax = [+parts[1], +parts[2], +parts[3]]; continue; }
    if (kw === 'LUT_1D_INPUT_RANGE' || kw === 'LUT_3D_INPUT_RANGE') {
      const a = +parts[1], b = +parts[2];
      dmin = [a, a, a]; dmax = [b, b, b];
      continue;
    }
    if (/^[-+.\d]/.test(parts[0]) && parts.length >= 3) {
      vals.push(+parts[0], +parts[1], +parts[2]);
      continue;
    }
    // unknown keyword: ignore
  }
  if (vals.some((v) => !Number.isFinite(v))) throw new Error('.cube: invalid number in table');
  if (size3 > 0) {
    if (size3 < 2 || size3 > 256) throw new Error(`.cube: unsupported LUT_3D_SIZE ${size3}`);
    if (vals.length < size3 ** 3 * 3) throw new Error(`.cube: expected ${size3 ** 3} entries, got ${vals.length / 3}`);
    return { size: size3, data: new Float32Array(vals.slice(0, size3 ** 3 * 3)), domainMin: dmin, domainMax: dmax };
  }
  if (size1 > 0) {
    if (size1 < 2 || vals.length < size1 * 3) throw new Error('.cube: truncated 1D LUT');
    const N = 33;
    const data = new Float32Array(N * N * N * 3);
    const lookup = (ch: number, x: number) => {
      const f = Math.min(1, Math.max(0, x)) * (size1 - 1);
      const i = Math.min(size1 - 2, Math.floor(f));
      const t = f - i;
      return vals[i * 3 + ch] * (1 - t) + vals[(i + 1) * 3 + ch] * t;
    };
    for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++) {
      const o = (r + g * N + b * N * N) * 3;
      data[o] = lookup(0, r / (N - 1));
      data[o + 1] = lookup(1, g / (N - 1));
      data[o + 2] = lookup(2, b / (N - 1));
    }
    return { size: N, data, domainMin: dmin, domainMax: dmax };
  }
  throw new Error('.cube: missing LUT_3D_SIZE / LUT_1D_SIZE');
}

/** Lay a 3D LUT out as a (size*size) x size RGBA atlas: x = r + b*size, y = g. */
export function cubeToAtlas(lut: CubeLut): RawTex {
  const N = lut.size;
  const w = N * N, h = N;
  const data = new Float32Array(w * h * 4);
  for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++) {
    const s = (r + g * N + b * N * N) * 3;
    const d = (g * w + (r + b * N)) * 4;
    data[d] = lut.data[s];
    data[d + 1] = lut.data[s + 1];
    data[d + 2] = lut.data[s + 2];
    data[d + 3] = 1;
  }
  return { width: w, height: h, data, filter: 'linear' };
}

// ---------------------------------------------------------------------------
// GLSL snippets (prefixed `lib_` to avoid clashes with the shared library)
// ---------------------------------------------------------------------------

/** Premultiplied linear-light conversions used by the blurs. */
export const GLSL_LINEAR = /* glsl */ `
vec4 lib_toLinPremul(vec4 c) { vec3 l = srgbToLinear(max(c.rgb, 0.0)); return vec4(l * c.a, c.a); }
vec4 lib_fromLinPremul(vec4 c) { vec3 l = c.a > 1e-5 ? c.rgb / c.a : vec3(0.0); return vec4(linearToSrgb(l), c.a); }
`;

/**
 * Generic separable 1D convolution with the bilinear "two taps per fetch" trick.
 * Expects `float lib_w(float i)` (weight of integer offset i, symmetric) to be defined
 * before inclusion. Samples `t` at `uv` along `dir` (in uv units per texel), offsets
 * -R..R, and returns the normalised sum.
 */
export const GLSL_CONV1D = /* glsl */ `
vec4 lib_conv1d(sampler2D t, vec2 uv, vec2 dir, int R) {
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  for (int k = 0; k < 160; k++) {
    int i = -R + 2 * k;
    if (i > R) break;
    float fi = float(i);
    float w1 = lib_w(fi);
    float w2 = (i + 1 <= R) ? lib_w(fi + 1.0) : 0.0;
    float w = w1 + w2;
    if (w <= 0.0) continue;
    float off = fi + w2 / w;
    acc += texture(t, uv + dir * off) * w;
    wsum += w;
  }
  return acc / max(wsum, 1e-8);
}
`;
