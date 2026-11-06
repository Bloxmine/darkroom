/**
 * Shared helpers for the analog / stylize nodes: GLSL snippets and pass builders.
 * Exports an empty NodeDef[] as default so the auto-registration glob is satisfied.
 */
import type { NodeDef, Params, PassContext, ShaderPass } from '../../core/types';

export default [] as NodeDef[];

export function num(params: Params, key: string, def: number): number {
  const v = params[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'boolean' ? (v ? 1 : 0) : def;
}

/** GLSL helpers prepended to analog shaders (on top of the core library). */
export const A_GLSL = /* glsl */ `
// Smooth gaussian noise with stationary variance (sd ~1): bilinear/smoothstep
// interpolation of gaussian lattice values, renormalised so the grid doesn't show.
float gnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = gaussRand(i), b = gaussRand(i + vec2(1.0, 0.0));
  float c = gaussRand(i + vec2(0.0, 1.0)), d = gaussRand(i + vec2(1.0, 1.0));
  vec4 w = vec4((1.0 - u.x) * (1.0 - u.y), u.x * (1.0 - u.y), (1.0 - u.x) * u.y, u.x * u.y);
  return dot(w, vec4(a, b, c, d)) / sqrt(dot(w, w));
}
// 1D version along x of a 2D lattice (rows stay independent) — for scanline noise.
float gnoiseX(float x, float row) {
  float i = floor(x), f = fract(x);
  float u = f * f * (3.0 - 2.0 * f);
  float a = gaussRand(vec2(i, row)), b = gaussRand(vec2(i + 1.0, row));
  return mix(a, b, u) / sqrt((1.0 - u) * (1.0 - u) + u * u);
}
float bayer2(vec2 a) { a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
float bayer8(vec2 a) { return bayer4(0.5 * a) * 0.25 + bayer2(a); }
/** Interleaved gradient noise — cheap, blue-noise-like threshold in [0,1). */
float ign(vec2 p) { return fract(52.9829189 * fract(dot(floor(p), vec2(0.06711056, 0.00583715)))); }
vec3 toLin(vec3 c) { return srgbToLinear(max(c, 0.0)); }
vec3 toSrgb(vec3 c) { return linearToSrgb(max(c, 0.0)); }
mat2 rot2(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }
`;

/** Prepend the analog helpers to a fragment body. */
export const F = (body: string) => A_GLSL + body;

const ceilDiv = (a: number, b: number) => Math.max(1, Math.ceil(a / b));

/** Dual-filter downsample (box-ish 4x4 footprint) of u_prev into a half-size target. */
export const DOWN_FRAG = F(`
void main() {
  vec2 t = 1.0 / u_prev_size;
  vec4 s = texture(u_prev, v_uv) * 4.0;
  s += texture(u_prev, v_uv + t * vec2(-1.0, -1.0));
  s += texture(u_prev, v_uv + t * vec2(1.0, -1.0));
  s += texture(u_prev, v_uv + t * vec2(-1.0, 1.0));
  s += texture(u_prev, v_uv + t * vec2(1.0, 1.0));
  fragColor = s / 8.0;
}`);

/** GLSL: 9-tap tent upsample of a level texture. */
export const TENT_GLSL = `
vec3 tent(sampler2D s, vec2 size, vec2 uv) {
  vec2 t = 1.0 / size;
  vec3 c = texture(s, uv).rgb * 4.0;
  c += (texture(s, uv + vec2(t.x, 0.0)).rgb + texture(s, uv - vec2(t.x, 0.0)).rgb + texture(s, uv + vec2(0.0, t.y)).rgb + texture(s, uv - vec2(0.0, t.y)).rgb) * 2.0;
  c += texture(s, uv + t).rgb + texture(s, uv - t).rgb + texture(s, uv + vec2(t.x, -t.y)).rgb + texture(s, uv + vec2(-t.x, t.y)).rgb;
  return c / 16.0;
}`;

export const GLOW_LEVELS = 7;

/** Level weights for a multiscale glow of radius R (output px). Level i blurs roughly 2^(i+1) px. */
export function glowWeights(R: number): number[] {
  const w: number[] = [];
  for (let i = 0; i < GLOW_LEVELS; i++) {
    const b = 2 ** (i + 1);
    w.push(b <= R ? 1 : Math.exp(-2.5 * Math.log2(b / Math.max(R, 0.5)) ** 2));
  }
  const s = w.reduce((a, b) => a + b, 0) || 1;
  return w.map((x) => x / s);
}

/**
 * Multiscale glow: `prefilter` renders the bright-pass at half res (reads u_image),
 * then GLOW_LEVELS-1 downsamples, then `combine` (reads u_image, u_pass0..u_pass6 and
 * `uniform float u_w[7]` + helper `vec3 glow(vec2 uv)`).
 */
export function glowPasses(prefilter: string, combine: string, radiusKey = 'radius'): ShaderPass[] {
  const passes: ShaderPass[] = [{ frag: F(prefilter), size: (c) => [ceilDiv(c.width, 2), ceilDiv(c.height, 2)] }];
  for (let i = 1; i < GLOW_LEVELS; i++) {
    const d = 2 ** (i + 1);
    passes.push({ frag: DOWN_FRAG, size: (c) => [ceilDiv(c.width, d), ceilDiv(c.height, d)] });
  }
  const glowFn = `
uniform float u_w[${GLOW_LEVELS}];
${TENT_GLSL}
vec3 glow(vec2 uv) {
  vec3 g = vec3(0.0);
  g += u_w[0] * tent(u_pass0, u_pass0_size, uv);
  g += u_w[1] * tent(u_pass1, u_pass1_size, uv);
  g += u_w[2] * tent(u_pass2, u_pass2_size, uv);
  g += u_w[3] * tent(u_pass3, u_pass3_size, uv);
  g += u_w[4] * tent(u_pass4, u_pass4_size, uv);
  g += u_w[5] * tent(u_pass5, u_pass5_size, uv);
  g += u_w[6] * tent(u_pass6, u_pass6_size, uv);
  return g;
}`;
  passes.push({
    frag: F(glowFn + combine),
    uniforms: (ctx: PassContext) => ({ u_w: glowWeights(num(ctx.params, radiusKey, 20) * ctx.scale) }),
  });
  return passes;
}

/**
 * Separable gaussian blur pass of u_prev. `sigmaExpr` is a GLSL float expression in
 * output pixels of this pass; `dir` the axis.
 */
export function blurPass(dir: 'x' | 'y', sigmaExpr: string, size?: ShaderPass['size']): ShaderPass {
  const d = dir === 'x' ? 'vec2(1.0, 0.0)' : 'vec2(0.0, 1.0)';
  return {
    size,
    frag: F(`
void main() {
  float sigma = max(${sigmaExpr}, 0.001);
  vec2 dir = ${d} / u_resolution;
  float stepPx = max(sigma / 4.0, 1.0);
  vec4 acc = vec4(0.0); float ws = 0.0;
  for (int i = -16; i <= 16; i++) {
    float x = float(i) * stepPx;
    if (abs(x) > sigma * 3.2 + 0.5) continue;
    float w = exp(-0.5 * x * x / (sigma * sigma));
    acc += texture(u_prev, v_uv + dir * x) * w; ws += w;
  }
  fragColor = acc / ws;
}`),
  };
}
