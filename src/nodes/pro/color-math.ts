/**
 * Colour-management maths shared by the pro colour nodes (pure TS, unit-tested):
 * RGB↔XYZ matrices derived from primaries + white point, Bradford chromatic adaptation,
 * transfer functions, Planckian white points, and JS mirrors of the tone-mapping curves
 * whose GLSL lives in color-glsl.ts (the tests check the JS versions; keep them in sync).
 *
 * Matrices are row-major `number[9]` here; `toGlsl()` converts to the column-major order a
 * GLSL `mat3` uniform expects.
 */
import type { NodeDef } from '../../core/types';

export default [] as NodeDef[];

export type Mat3 = number[];
export type Vec3 = [number, number, number];
export type XY = [number, number];

// ---------------------------------------------------------------------------
// basic linear algebra
// ---------------------------------------------------------------------------
export function mul(a: Mat3, b: Mat3): Mat3 {
  const o = new Array(9).fill(0);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) o[r * 3 + c] += a[r * 3 + k] * b[k * 3 + c];
  return o;
}
export function apply(m: Mat3, v: Vec3): Vec3 {
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
}
export function inv(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) throw new Error('singular matrix');
  const k = 1 / det;
  return [A * k, -(b * i - c * h) * k, (b * f - c * e) * k, B * k, (a * i - c * g) * k, -(a * f - c * d) * k, C * k, -(a * h - b * g) * k, (a * e - b * d) * k];
}
export const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const diag = (v: Vec3): Mat3 => [v[0], 0, 0, 0, v[1], 0, 0, 0, v[2]];
/** Row-major → column-major (GLSL mat3 uniform layout). */
export const toGlsl = (m: Mat3): number[] => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];

// ---------------------------------------------------------------------------
// white points, primaries
// ---------------------------------------------------------------------------
export const WHITE = {
  D65: [0.3127, 0.329] as XY,
  D50: [0.3457, 0.3585] as XY,
  /** ACES white (≈ D60), SMPTE ST 2065-1. */
  ACES: [0.32168, 0.33767] as XY,
};
export const xyToXYZ = ([x, y]: XY): Vec3 => [x / y, 1, (1 - x - y) / y];

export interface RgbSpace {
  id: string;
  label: string;
  /** Primaries r, g, b as CIE xy. */
  primaries: [XY, XY, XY];
  white: XY;
  /** Transfer function (encoded ↔ linear). */
  transfer: 'srgb' | 'linear' | 'gamma22' | 'adobe' | 'prophoto' | 'bt1886';
}

/** Supported working / output spaces (enum order of pro.colorSpace). */
export const SPACES: RgbSpace[] = [
  { id: 'srgb', label: 'sRGB', primaries: [[0.64, 0.33], [0.3, 0.6], [0.15, 0.06]], white: WHITE.D65, transfer: 'srgb' },
  { id: 'linsrgb', label: 'Linear sRGB / Rec.709', primaries: [[0.64, 0.33], [0.3, 0.6], [0.15, 0.06]], white: WHITE.D65, transfer: 'linear' },
  // Display P3: DCI-P3 primaries, D65 white, sRGB transfer curve (Apple)
  { id: 'p3', label: 'Display P3', primaries: [[0.68, 0.32], [0.265, 0.69], [0.15, 0.06]], white: WHITE.D65, transfer: 'srgb' },
  // ITU-R BT.2020 primaries; display-referred BT.1886 (pure 2.4 power with zero black)
  { id: 'rec2020', label: 'Rec.2020', primaries: [[0.708, 0.292], [0.17, 0.797], [0.131, 0.046]], white: WHITE.D65, transfer: 'bt1886' },
  // ROMM RGB (ISO 22028-2), D50 white, 1.8 gamma with a linear segment below 1/512
  { id: 'prophoto', label: 'ProPhoto RGB', primaries: [[0.7347, 0.2653], [0.1596, 0.8404], [0.0366, 0.0001]], white: WHITE.D50, transfer: 'prophoto' },
  // Adobe RGB (1998): gamma 563/256 ≈ 2.19921875
  { id: 'adobe', label: 'Adobe RGB (1998)', primaries: [[0.64, 0.33], [0.21, 0.71], [0.15, 0.06]], white: WHITE.D65, transfer: 'adobe' },
  // ACEScg (AP1 primaries, ACES white), scene-linear
  { id: 'acescg', label: 'ACEScg (linear)', primaries: [[0.713, 0.293], [0.165, 0.83], [0.128, 0.044]], white: WHITE.ACES, transfer: 'linear' },
];
export const SPACE_LABELS = SPACES.map((s) => s.label);
export const spaceByLabel = (l: unknown) => SPACES.find((s) => s.label === l || s.id === l) ?? SPACES[0];

/** RGB → XYZ (Y of white = 1) from primaries and white (the standard SMPTE RP 177 derivation). */
export function rgbToXyz(space: Pick<RgbSpace, 'primaries' | 'white'>): Mat3 {
  const P = space.primaries.map(xyToXYZ);
  const m: Mat3 = [P[0][0], P[1][0], P[2][0], P[0][1], P[1][1], P[2][1], P[0][2], P[1][2], P[2][2]];
  const S = apply(inv(m), xyToXYZ(space.white));
  return mul(m, diag(S));
}

/** Bradford cone response matrix (Lam 1985, as used by ICC v4 / Lindbloom). */
export const BRADFORD: Mat3 = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296];

/** Bradford chromatic adaptation XYZ(src white) → XYZ(dst white). */
export function bradford(src: XY, dst: XY): Mat3 {
  const s = apply(BRADFORD, xyToXYZ(src)), d = apply(BRADFORD, xyToXYZ(dst));
  return mul(inv(BRADFORD), mul(diag([d[0] / s[0], d[1] / s[1], d[2] / s[2]]), BRADFORD));
}

/** Linear RGB(src) → linear RGB(dst) including Bradford white adaptation when the whites differ. */
export function convertMatrix(src: RgbSpace, dst: RgbSpace): Mat3 {
  const same = Math.abs(src.white[0] - dst.white[0]) < 1e-6 && Math.abs(src.white[1] - dst.white[1]) < 1e-6;
  const adapt = same ? IDENTITY : bradford(src.white, dst.white);
  return mul(inv(rgbToXyz(dst)), mul(adapt, rgbToXyz(src)));
}

// ---------------------------------------------------------------------------
// transfer functions (scalar mirrors of the GLSL)
// ---------------------------------------------------------------------------
export const TRANSFER_IDS = ['srgb', 'linear', 'gamma22', 'adobe', 'prophoto', 'bt1886'] as const;
export function decode(t: RgbSpace['transfer'], v: number): number {
  const s = Math.sign(v), a = Math.abs(v);
  switch (t) {
    case 'srgb': return s * (a <= 0.04045 ? a / 12.92 : Math.pow((a + 0.055) / 1.055, 2.4));
    case 'linear': return v;
    case 'gamma22': return s * Math.pow(a, 2.2);
    case 'adobe': return s * Math.pow(a, 563 / 256);
    case 'prophoto': return s * (a < 16 / 512 ? a / 16 : Math.pow(a, 1.8));
    case 'bt1886': return s * Math.pow(a, 2.4);
  }
}
export function encode(t: RgbSpace['transfer'], v: number): number {
  const s = Math.sign(v), a = Math.abs(v);
  switch (t) {
    case 'srgb': return s * (a <= 0.0031308 ? a * 12.92 : 1.055 * Math.pow(a, 1 / 2.4) - 0.055);
    case 'linear': return v;
    case 'gamma22': return s * Math.pow(a, 1 / 2.2);
    case 'adobe': return s * Math.pow(a, 256 / 563);
    case 'prophoto': return s * (a < 1 / 512 ? a * 16 : Math.pow(a, 1 / 1.8));
    case 'bt1886': return s * Math.pow(a, 1 / 2.4);
  }
}

// ---------------------------------------------------------------------------
// white balance: Planckian locus
// ---------------------------------------------------------------------------
/** CIE xy of a Planckian (blackbody) radiator, Kim et al. 2002 cubic spline (1667–25000 K). */
export function planckianXY(T: number): XY {
  T = Math.min(25000, Math.max(1667, T));
  const t = 1e3 / T, t2 = t * t, t3 = t2 * t;
  const x = T <= 4000 ? -0.2661239 * t3 - 0.234358 * t2 + 0.8776956 * t + 0.17991 : -3.0258469 * t3 + 2.1070379 * t2 + 0.2226347 * t + 0.24039;
  const x2 = x * x, x3 = x2 * x;
  const y = T <= 2222 ? -1.1063814 * x3 - 1.3481102 * x2 + 2.18555832 * x - 0.20219683
    : T <= 4000 ? -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867
      : 3.081758 * x3 - 5.8733867 * x2 + 3.75112997 * x - 0.37001483;
  return [x, y];
}
const xyToUv = ([x, y]: XY): XY => { const d = -2 * x + 12 * y + 3; return [(4 * x) / d, (6 * y) / d]; };
const uvToXy = ([u, v]: XY): XY => { const d = 2 * u - 8 * v + 4; return [(3 * u) / d, (2 * v) / d]; };

/**
 * Scene illuminant for a temperature (K) and tint (−1..1, + = magenta correction ⇒ the light was green):
 * the Planckian point offset perpendicular to the locus in CIE 1960 uv by up to ±0.02 Duv.
 */
export function illuminantXY(T: number, tint: number): XY {
  const a = xyToUv(planckianXY(T)), b = xyToUv(planckianXY(T * 1.01));
  let nx = -(b[1] - a[1]), ny = b[0] - a[0];
  const l = Math.hypot(nx, ny) || 1;
  nx /= l; ny /= l;
  if (ny < 0) { nx = -nx; ny = -ny; } // +v = towards green
  return uvToXy([a[0] + nx * tint * 0.02, a[1] + ny * tint * 0.02]);
}

/**
 * Linear-sRGB white-balance matrix: Bradford adaptation from the scene illuminant (T, tint) to the
 * reference (6500 K Planckian, i.e. identity at T = 6500, tint = 0).
 */
export function whiteBalanceMatrix(T: number, tint: number): Mat3 {
  const srgb = SPACES[1];
  const M = rgbToXyz(srgb);
  const A = bradford(illuminantXY(T, tint), illuminantXY(6500, 0));
  return mul(inv(M), mul(A, M));
}

// ---------------------------------------------------------------------------
// tone-mapping curves (JS mirrors of color-glsl.ts, for tests and LUT previews)
// ---------------------------------------------------------------------------
export const TONEMAPS = ['AgX', 'ACES (fitted RRT+ODT)', 'ACES (Narkowicz)', 'Filmic', 'Reinhard (extended)', 'Uchimura (GT)', 'Hable (Uncharted 2)'] as const;

/** AgX default contrast sigmoid (6th-order polynomial fit, Benjamin Wrensch's "AgX minimal"). */
export function agxContrast(x: number): number {
  const x2 = x * x, x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
export const AGX_MIN_EV = -12.47393, AGX_MAX_EV = 4.026069;
/** AgX on a grey value (the inset/outset matrices are identity for neutral greys). Returns display-encoded. */
export function agxGrey(v: number): number {
  const l = Math.min(1, Math.max(0, (Math.log2(Math.max(v, 1e-10)) - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV)));
  return agxContrast(l);
}
export function acesNarkowicz(x: number): number {
  x *= 0.6;
  return Math.min(1, Math.max(0, (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)));
}
/** Stephen Hill's RRT+ODT fit (grey axis; the input/output matrices preserve neutrals). */
export function acesRrtOdtFit(v: number): number {
  return (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);
}
/** Blender-Filmic-style: log2 encoding of −10..+6.5 stops around 0.18, then a contrast sigmoid. */
export function filmic(v: number, contrast = 1): number {
  const l = Math.min(1, Math.max(0, (Math.log2(Math.max(v, 1e-10) / 0.18) + 10) / 16.5));
  return filmicSigmoid(l, contrast);
}
export function filmicSigmoid(l: number, contrast: number): number {
  const k = 4.0 + 4.0 * contrast, l0 = 10 / 16.5, y0 = 0.46;
  // logistic in log space through (l0, y0), renormalised so 0 → 0 and 1 → 1
  const f = (x: number) => 1 / (1 + Math.exp(-k * (x - l0)) * ((1 - y0) / y0));
  return (f(l) - f(0)) / (f(1) - f(0));
}
export function reinhardExt(L: number, white: number): number {
  return Math.min(1, (L * (1 + L / (white * white))) / (1 + L));
}
/** Uchimura 2017 ("HDR theory and practice", Gran Turismo Sport) with its default parameters. */
export function uchimura(x: number, P = 1, a = 1, m = 0.22, l = 0.4, c = 1.33, b = 0): number {
  const l0 = ((P - m) * l) / a;
  const S0 = m + l0, S1 = m + a * l0, C2 = (a * P) / (P - S1), CP = -C2 / P;
  const ss = (e0: number, e1: number, t: number) => { const u = Math.min(1, Math.max(0, (t - e0) / (e1 - e0))); return u * u * (3 - 2 * u); };
  const w0 = 1 - ss(0, m, x), w2 = x >= m + l0 ? 1 : 0, w1 = 1 - w0 - w2;
  const T = m * Math.pow(x / m, c) + b, S = P - (P - S1) * Math.exp(CP * (x - S0)), Ln = m + a * (x - m);
  return T * w0 + Ln * w1 + S * w2;
}
/** John Hable's Uncharted 2 curve, exposure bias 2, white point W. */
export function hable(x: number, W = 11.2): number {
  const A = 0.15, B = 0.5, C = 0.1, D = 0.2, E = 0.02, F = 0.3;
  const f = (v: number) => (v * (A * v + C * B) + D * E) / (v * (A * v + B) + D * F) - E / F;
  return Math.min(1, f(2 * x) / f(W));
}

/** Grey-axis response of an operator for a linear input (display-linear output except AgX/Filmic → encoded). */
export function tonemapGrey(op: (typeof TONEMAPS)[number], v: number, white = 4): number {
  switch (op) {
    case 'AgX': return agxGrey(v);
    case 'ACES (fitted RRT+ODT)': return acesRrtOdtFit(v);
    case 'ACES (Narkowicz)': return acesNarkowicz(v);
    case 'Filmic': return filmic(v);
    case 'Reinhard (extended)': return reinhardExt(v, white);
    case 'Uchimura (GT)': return uchimura(v);
    case 'Hable (Uncharted 2)': return hable(v, white * 2.8);
  }
}
