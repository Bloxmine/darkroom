/**
 * Shared helpers for the extra-* node files: pure-JS size maths (crop, resize,
 * canvas, straighten), homographies, histogram/CDF statistics, plus GLSL
 * snippets (fast gaussian blur chain, bicubic sampling, Oklab, CIELAB).
 * Exports an empty NodeDef[] so the auto-registration glob is satisfied.
 */
import type { NodeDef, Params, PassContext, ShaderPass } from '../../core/types';
import { GLSL_CONV1D, num } from './shared';

export default [] as NodeDef[];

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const MAX_DIM = 16384;

// ---------------------------------------------------------------------------
// Aspect ratios
// ---------------------------------------------------------------------------

export const ASPECTS = ['free', 'original', '1:1', '4:5', '5:4', '3:4', '4:3', '2:3', '3:2', '9:16', '16:9', '1.85:1', '2.39:1'];
export const FIXED_ASPECTS = ASPECTS.filter((a) => a !== 'free' && a !== 'original');

/** Width / height for an aspect preset name; null for 'free' or unknown. */
export function aspectRatio(name: unknown, w: number, h: number): number | null {
  const s = String(name ?? 'free');
  if (s === 'original') return w / Math.max(1, h);
  const m = /^([\d.]+):([\d.]+)$/.exec(s);
  if (!m) return null;
  const a = parseFloat(m[1]), b = parseFloat(m[2]);
  return a > 0 && b > 0 ? a / b : null;
}

// ---------------------------------------------------------------------------
// Crop
// ---------------------------------------------------------------------------

export interface Rect { x: number; y: number; w: number; h: number }

/**
 * Crop rectangle in full-resolution pixels (integers, inside the image, ≥ 1px).
 * `units` 'relative' uses x/y/width/height (0..1); 'pixels' uses pxX/pxY/pxWidth/pxHeight.
 * A fixed aspect shrinks the rect to the largest one of that ratio, centred inside it.
 */
export function cropRect(p: Params, W: number, H: number): Rect {
  let x: number, y: number, w: number, h: number;
  if (p.units === 'pixels') {
    x = num(p, 'pxX', 0); y = num(p, 'pxY', 0);
    w = num(p, 'pxWidth', W); h = num(p, 'pxHeight', H);
  } else {
    x = num(p, 'x', 0.1) * W; y = num(p, 'y', 0.1) * H;
    w = num(p, 'width', 0.8) * W; h = num(p, 'height', 0.8) * H;
  }
  x = clamp(x, 0, W - 1); y = clamp(y, 0, H - 1);
  w = clamp(w, 1, W - x); h = clamp(h, 1, H - y);
  const ar = aspectRatio(p.aspect, W, H);
  if (ar) {
    if (w / h > ar) { const nw = h * ar; x += (w - nw) / 2; w = nw; }
    else { const nh = w / ar; y += (h - nh) / 2; h = nh; }
  }
  const rx = clamp(Math.round(x), 0, W - 1), ry = clamp(Math.round(y), 0, H - 1);
  return { x: rx, y: ry, w: clamp(Math.round(w), 1, W - rx), h: clamp(Math.round(h), 1, H - ry) };
}

// ---------------------------------------------------------------------------
// Resize
// ---------------------------------------------------------------------------

export const RESIZE_MODES = ['percent', 'width', 'height', 'longEdge', 'shortEdge', 'fit', 'exact'];

/** Output size (full-res px) for transform.resize. Aspect is kept except in 'exact'. */
export function resizeSize(p: Params, W: number, H: number): [number, number] {
  const mode = String(p.mode ?? 'percent');
  const tw = Math.max(1, num(p, 'width', 1920)), th = Math.max(1, num(p, 'height', 1080));
  const edge = Math.max(1, num(p, 'edge', 1024));
  let k: number;
  switch (mode) {
    case 'width': k = tw / W; break;
    case 'height': k = th / H; break;
    case 'longEdge': k = edge / Math.max(W, H); break;
    case 'shortEdge': k = edge / Math.min(W, H); break;
    case 'fit': k = Math.min(tw / W, th / H); break;
    case 'exact': return [clamp(Math.round(tw), 1, MAX_DIM), clamp(Math.round(th), 1, MAX_DIM)];
    default: k = Math.max(0.0001, num(p, 'percent', 50) / 100);
  }
  return [clamp(Math.round(W * k), 1, MAX_DIM), clamp(Math.round(H * k), 1, MAX_DIM)];
}

// ---------------------------------------------------------------------------
// Canvas size
// ---------------------------------------------------------------------------

export const ANCHORS = ['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right'];

export function anchorXY(a: unknown): [number, number] {
  const i = Math.max(0, ANCHORS.indexOf(String(a ?? 'center')));
  return [(i % 3) / 2, Math.floor(i / 3) / 2];
}

/** New canvas size and the image's offset in it (full-res px). Smaller sizes crop. */
export function canvasLayout(p: Params, W: number, H: number): { w: number; h: number; ox: number; oy: number } {
  const mode = String(p.mode ?? 'add');
  let w = W, h = H;
  if (mode === 'add') { w = W + num(p, 'width', 100); h = H + num(p, 'height', 100); }
  else if (mode === 'absolute') { w = num(p, 'width', W); h = num(p, 'height', H); }
  else if (mode === 'percent') { const k = num(p, 'percent', 110) / 100; w = W * k; h = H * k; }
  else if (mode === 'aspect') {
    const ar = aspectRatio(p.aspect ?? '1:1', W, H) ?? 1;
    if (W / H < ar) w = H * ar; else h = W / ar;
  }
  w = clamp(Math.round(w), 1, MAX_DIM); h = clamp(Math.round(h), 1, MAX_DIM);
  const [ax, ay] = anchorXY(p.anchor);
  return { w, h, ox: Math.round((w - W) * ax) + 0, oy: Math.round((h - H) * ay) + 0 };
}

// ---------------------------------------------------------------------------
// Straighten
// ---------------------------------------------------------------------------

/** Largest scale k such that a centred k·W × k·H rect fits inside the W×H image rotated by `deg`. */
export function straightenFactor(W: number, H: number, deg: number): number {
  const a = Math.abs((deg * Math.PI) / 180) % Math.PI;
  const c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
  return Math.min(W / (W * c + H * s), H / (W * s + H * c));
}

export const STRAIGHTEN_MODES = ['zoom to fill', 'crop', 'none', 'expand'];

/** Output size of transform.straighten (full-res px). */
export function straightenSize(p: Params, W: number, H: number): [number, number] {
  const mode = String(p.crop ?? 'zoom to fill');
  const deg = num(p, 'angle', 3);
  if (mode === 'crop') {
    const k = straightenFactor(W, H, deg);
    return [Math.max(1, Math.floor(W * k)), Math.max(1, Math.floor(H * k))];
  }
  if (mode === 'expand') {
    const a = (deg * Math.PI) / 180, c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
    return [clamp(Math.ceil(W * c + H * s - 1e-6), 1, MAX_DIM), clamp(Math.ceil(W * s + H * c - 1e-6), 1, MAX_DIM)];
  }
  return [W, H];
}

// ---------------------------------------------------------------------------
// Homography
// ---------------------------------------------------------------------------

export type Mat3 = [number, number, number, number, number, number, number, number, number]; // row-major

/** Projective map taking the unit square (0,0),(1,0),(1,1),(0,1) to quad p0..p3 (Heckbert). */
export function squareToQuad(q: [number, number][]): Mat3 {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const dx3 = x0 - x1 + x2 - x3, dy3 = y0 - y1 + y2 - y3;
  if (Math.abs(dx3) < 1e-12 && Math.abs(dy3) < 1e-12) {
    return [x1 - x0, x2 - x1, x0, y1 - y0, y2 - y1, y0, 0, 0, 1];
  }
  const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2;
  const det = dx1 * dy2 - dx2 * dy1 || 1e-12;
  const g = (dx3 * dy2 - dx2 * dy3) / det;
  const h = (dx1 * dy3 - dx3 * dy1) / det;
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h, 1];
}

export function invert3(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), Cc = d * h - e * g;
  const det = a * A + b * B + c * Cc || 1e-12;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, Cc / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

export function applyH(m: Mat3, x: number, y: number): [number, number] {
  const w = m[6] * x + m[7] * y + m[8];
  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
}

/** Row-major → column-major array for a GLSL mat3 uniform. */
export const toGlMat3 = (m: Mat3): number[] => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];

// ---------------------------------------------------------------------------
// Histograms
// ---------------------------------------------------------------------------

export interface Histograms { r: Float64Array; g: Float64Array; b: Float64Array; l: Float64Array; total: number; bins: number }

/**
 * RGB + Rec.709 luma histograms of RGBA float pixels (values clamped to 0..1).
 * Pixels with alpha < 0.5 are skipped. Large images are sampled on a regular grid
 * of at most ~`maxSamples` pixels.
 */
export function computeHistograms(data: ArrayLike<number>, w: number, h: number, bins = 256, maxSamples = 1 << 20): Histograms {
  const r = new Float64Array(bins), g = new Float64Array(bins), b = new Float64Array(bins), l = new Float64Array(bins);
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / maxSamples)));
  const bin = (v: number) => clamp(Math.floor(v * bins), 0, bins - 1) | 0;
  let total = 0;
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const o = (y * w + x) * 4;
      if (data[o + 3] < 0.5) continue;
      const R = data[o], G = data[o + 1], B = data[o + 2];
      r[bin(R)]++; g[bin(G)]++; b[bin(B)]++;
      l[bin(0.2126 * R + 0.7152 * G + 0.0722 * B)]++;
      total++;
    }
  }
  return { r, g, b, l, total, bins };
}

/**
 * Value (0..1) below which `frac` of the histogram mass lies (`fromTop` → above which).
 * Returns the bin edge, so a clip of 0 gives the darkest/brightest occupied bin.
 */
export function histPercentile(hist: ArrayLike<number>, frac: number, fromTop = false): number {
  const n = hist.length;
  let total = 0;
  for (let i = 0; i < n; i++) total += hist[i];
  if (total <= 0) return fromTop ? 1 : 0;
  const target = clamp(frac, 0, 1) * total;
  let acc = 0;
  if (!fromTop) {
    for (let i = 0; i < n; i++) { acc += hist[i]; if (acc > target) return i / n; }
    return 1;
  }
  for (let i = n - 1; i >= 0; i--) { acc += hist[i]; if (acc > target) return (i + 1) / n; }
  return 0;
}

/** Histogram-equalisation transfer curve (n entries, 0..1, monotone) from a histogram. */
export function equalizeLut(hist: ArrayLike<number>): Float32Array {
  const n = hist.length;
  const out = new Float32Array(n);
  let total = 0, cdfMin = -1;
  for (let i = 0; i < n; i++) { total += hist[i]; if (cdfMin < 0 && hist[i] > 0) cdfMin = hist[i]; }
  if (total <= 0 || total - cdfMin <= 0) { for (let i = 0; i < n; i++) out[i] = i / (n - 1); return out; }
  let acc = 0;
  for (let i = 0; i < n; i++) { acc += hist[i]; out[i] = clamp((acc - cdfMin) / (total - cdfMin), 0, 1); }
  return out;
}

// ---------------------------------------------------------------------------
// Colour statistics (match colour)
// ---------------------------------------------------------------------------

const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/** sRGB (0..1) → CIELAB (D65). Mirrors GLSL `ex_rgb2lab`. */
export function srgbToLab(r: number, g: number, b: number): [number, number, number] {
  const R = lin(clamp(r, 0, 1)), G = lin(clamp(g, 0, 1)), B = lin(clamp(b, 0, 1));
  const X = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
  const Y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B;
  const Z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** JPEG YCbCr, mirrors GLSL `rgb2ycbcr`. */
export function srgbToYcc(r: number, g: number, b: number): [number, number, number] {
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  return [y, 0.5 + (b - y) * 0.564, 0.5 + (r - y) * 0.713];
}

/** Per-channel mean and standard deviation of an image in Lab or YCbCr (alpha < 0.5 skipped, grid-sampled). */
export function colorStats(data: ArrayLike<number>, w: number, h: number, space: 'lab' | 'ycbcr', maxSamples = 1 << 18) {
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / maxSamples)));
  const conv = space === 'lab' ? srgbToLab : srgbToYcc;
  const s = [0, 0, 0], s2 = [0, 0, 0];
  let n = 0;
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
    const o = (y * w + x) * 4;
    if (data[o + 3] < 0.5) continue;
    const v = conv(data[o], data[o + 1], data[o + 2]);
    for (let c = 0; c < 3; c++) { s[c] += v[c]; s2[c] += v[c] * v[c]; }
    n++;
  }
  if (!n) return { mean: [0, 0, 0], std: [1, 1, 1] };
  const mean = s.map((v) => v / n);
  const std = s2.map((v, c) => Math.sqrt(Math.max(v / n - mean[c] * mean[c], 0)));
  return { mean, std };
}

// ---------------------------------------------------------------------------
// GLSL snippets (prefixed `ex_`)
// ---------------------------------------------------------------------------

/** Catmull-Rom bicubic sample (clamp-to-edge), 16 texel fetches. */
export const GLSL_CUBIC = /* glsl */ `
vec4 ex_cubic(sampler2D t, vec2 uv) {
  vec2 sz = vec2(textureSize(t, 0));
  vec2 p = uv * sz - 0.5;
  vec2 f = fract(p);
  ivec2 i = ivec2(floor(p));
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec4 wx = vec4(w0.x, w1.x, w2.x, w3.x), wy = vec4(w0.y, w1.y, w2.y, w3.y);
  vec4 acc = vec4(0.0);
  for (int y = 0; y < 4; y++) for (int x = 0; x < 4; x++) {
    vec4 c = texel(t, i + ivec2(x - 1, y - 1));
    acc += vec4(c.rgb * c.a, c.a) * wx[x] * wy[y];
  }
  acc.a = clamp(acc.a, 0.0, 1.0);
  return acc.a > 1e-5 ? vec4(max(acc.rgb / acc.a, 0.0), acc.a) : vec4(0.0);
}
/** Coverage of a sample position against the source rect, antialiased over ~1 output px (pxPerUv = source px per uv). */
float ex_cover(vec2 uv, vec2 pxPerUv, float aa) {
  vec2 d = min(uv, 1.0 - uv) * pxPerUv / max(aa, 1e-4);
  return clamp(min(d.x, d.y) + 0.5, 0.0, 1.0);
}
`;

/** Oklab (Björn Ottosson). Input/output *linear* sRGB. */
export const GLSL_OKLAB = /* glsl */ `
vec3 ex_lin2oklab(vec3 c) {
  vec3 lms = mat3(0.4122214708, 0.2119034982, 0.0883024619, 0.5363325363, 0.6806995451, 0.2817188376, 0.0514459929, 0.1073969566, 0.6299787005) * c;
  lms = sign(lms) * pow(abs(lms), vec3(1.0 / 3.0));
  return mat3(0.2104542553, 1.9779984951, 0.0259040371, 0.7936177850, -2.4285922050, 0.7827717662, -0.0040720468, 0.4505937099, -0.8086757660) * lms;
}
vec3 ex_oklab2lin(vec3 c) {
  vec3 lms = mat3(1.0, 1.0, 1.0, 0.3963377774, -0.1055613458, -0.0894841775, 0.2158037573, -0.0638541728, -1.2914855480) * c;
  return mat3(4.0767416621, -1.2684380046, -0.0041960863, -3.3077115913, 2.6097574011, -0.7034186147, 0.2309699292, -0.3413193965, 1.7076147010) * (lms * lms * lms);
}
vec3 ex_srgb2oklab(vec3 c) { return ex_lin2oklab(srgbToLinear(max(c, 0.0))); }
vec3 ex_oklab2srgb(vec3 c) { return linearToSrgb(ex_oklab2lin(c)); }
/** Unit Oklab a/b direction of an HSL hue in degrees (so hue pickers match the familiar wheel). */
vec2 ex_hueDir(float deg) {
  vec3 lab = ex_srgb2oklab(hsl2rgb(vec3(fract(deg / 360.0), 1.0, 0.5)));
  return lab.yz / max(length(lab.yz), 1e-5);
}
`;

/** CIELAB (D65), sRGB-encoded input/output. Mirrors `srgbToLab` in JS. */
export const GLSL_LAB = /* glsl */ `
float ex_labf(float t) { return t > 0.008856 ? pow(t, 1.0 / 3.0) : 7.787 * t + 16.0 / 116.0; }
float ex_labfi(float t) { return t > 0.206893 ? t * t * t : (t - 16.0 / 116.0) / 7.787; }
vec3 ex_rgb2lab(vec3 c) {
  vec3 l = srgbToLinear(clamp(c, 0.0, 1.0));
  float X = dot(l, vec3(0.4124564, 0.3575761, 0.1804375)) / 0.95047;
  float Y = dot(l, vec3(0.2126729, 0.7151522, 0.0721750));
  float Z = dot(l, vec3(0.0193339, 0.1191920, 0.9503041)) / 1.08883;
  float fx = ex_labf(X), fy = ex_labf(Y), fz = ex_labf(Z);
  return vec3(116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz));
}
vec3 ex_lab2rgb(vec3 lab) {
  float fy = (lab.x + 16.0) / 116.0, fx = fy + lab.y / 500.0, fz = fy - lab.z / 200.0;
  vec3 xyz = vec3(ex_labfi(fx) * 0.95047, ex_labfi(fy), ex_labfi(fz) * 1.08883);
  vec3 l = mat3(3.2404542, -0.9692660, 0.0556434, -1.5371385, 1.8760108, -0.2040259, -0.4985314, 0.0415560, 1.0572252) * xyz;
  return linearToSrgb(l);
}
`;

// ---------------------------------------------------------------------------
// Fast gaussian blur chain
// ---------------------------------------------------------------------------

/**
 * Gaussian plan for a σ in *render* pixels: box-downsample by d (σ > 6), blur the
 * remainder at low res. Cost is O(1) in σ.
 */
export function blurPlan(sigma: number) {
  const s = Math.max(0, sigma);
  const d = s > 6 ? Math.min(32, Math.floor(s / 3)) : 1;
  const rem = Math.sqrt(Math.max(s * s - (d * d - 1) / 12, 0)) / d;
  return { d, s: rem };
}

/**
 * Three passes (downsample, horizontal, vertical) producing a low-res gaussian blur
 * at pass index `first + 2`. `src` must define `vec4 ex_src(ivec2 p)` reading a pixel
 * at node resolution. `sigma(ctx)` is σ in render pixels. Consumers sample the result with
 * `ex_blurUV(v_uv, u_bd, u_passN_size)` and must declare `uniform float u_bd;`, set from
 * `blurUniforms(ctx, sigma)`.
 */
export function blurPasses(first: number, sigma: (ctx: PassContext) => number, src: string, extra: (ctx: PassContext) => Record<string, number | number[]> = () => ({})): ShaderPass[] {
  const plan = (ctx: PassContext) => blurPlan(sigma(ctx));
  const lowSize = (ctx: PassContext): [number, number] => { const d = plan(ctx).d; return [Math.ceil(ctx.width / d), Math.ceil(ctx.height / d)]; };
  const W = /* glsl */ `
uniform float u_bsig;
float lib_w(float i) { return u_bsig < 0.01 ? (i == 0.0 ? 1.0 : 0.0) : exp(-i * i / (2.0 * u_bsig * u_bsig)); }
${GLSL_CONV1D}`;
  return [
    {
      size: lowSize,
      uniforms: (ctx) => ({ u_bd: plan(ctx).d, u_bfull: [ctx.width, ctx.height], ...extra(ctx) }),
      frag: /* glsl */ `
uniform float u_bd;
uniform vec2 u_bfull;
${src}
void main(){
  int d = int(u_bd);
  ivec2 base = ivec2(floor(v_uv * u_resolution)) * d;
  ivec2 isz = ivec2(u_bfull);
  vec4 acc = vec4(0.0); float n = 0.0;
  for (int y = 0; y < 32; y++) { if (y >= d) break;
    for (int x = 0; x < 32; x++) { if (x >= d) break;
      ivec2 p = base + ivec2(x, y);
      if (p.x >= isz.x || p.y >= isz.y) continue;
      acc += ex_src(p); n += 1.0;
    }
  }
  fragColor = acc / max(n, 1.0);
}`,
    },
    {
      size: (ctx) => [ctx.passSizes[first].width, ctx.passSizes[first].height],
      uniforms: (ctx) => ({ u_bsig: plan(ctx).s }),
      frag: `${W}\nvoid main(){ fragColor = lib_conv1d(u_pass${first}, v_uv, vec2(1.0 / u_pass${first}_size.x, 0.0), int(ceil(3.0 * u_bsig))); }`,
    },
    {
      size: (ctx) => [ctx.passSizes[first].width, ctx.passSizes[first].height],
      uniforms: (ctx) => ({ u_bsig: plan(ctx).s }),
      frag: `${W}\nvoid main(){ fragColor = lib_conv1d(u_pass${first + 1}, v_uv, vec2(0.0, 1.0 / u_pass${first + 1}_size.y), int(ceil(3.0 * u_bsig))); }`,
    },
  ];
}

/** Uniforms a consumer pass needs to sample a blur chain made with the same σ. */
export const blurUniforms = (sigma: number) => ({ u_bd: blurPlan(sigma).d });

/** Map the consumer's v_uv onto the low-res blur texture. */
export const GLSL_BLUR_UV = /* glsl */ `
vec2 ex_blurUV(vec2 uv, float d, vec2 lowSize) { return uv * u_resolution / (d * lowSize); }
`;

/** Clamp an int param to a loop-friendly range. */
export const pxParam = (ctx: PassContext, key: string, def: number) => Math.max(0, num(ctx.params, key, def)) * ctx.scale;
