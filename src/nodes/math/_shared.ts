/**
 * Shared helpers for the Blender-style math / mix / converter / texture nodes:
 *  - GLSL snippets (Blender's HSV/HSL conversions, Jenkins lookup3 hash, Perlin noise and
 *    fractal variants, Mix Color blend types),
 *  - pure-JS ports used for CPU baking (Color Ramp, Wavelength) and for unit tests
 *    (Mix Color reference, Blackbody).
 *
 * Formulas follow Blender's definitions (blenkernel `ramp_blend` / GPU
 * `gpu_shader_material_mix_color.glsl`, `gpu_shader_common_hash.glsl`,
 * `gpu_shader_material_noise.glsl`, `gpu_shader_material_fractal_noise.glsl`,
 * BKE_colorband_evaluate, Cycles `svm_math_blackbody_color`, `svm_node_wavelength`).
 *
 * Exports an empty NodeDef[] so the auto-registration glob is satisfied.
 */
import type { NodeDef, Params, PassContext } from '../../core/types';

export default [] as NodeDef[];

export const C_MATH = '#6e56cf';
export const C_MIX = '#c2410c';
export const C_CONVERT = '#0e7490';
export const C_TEXTURE = '#a16207';
export const C_VECTOR = '#4338ca';

/** Read a numeric param with a fallback. */
export function num(params: Params, key: string, def: number): number {
  const v = params[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'boolean' ? (v ? 1 : 0) : def;
}

/** Uniforms `u_has<Name>` (1/0) telling the shader which optional inputs are connected. */
export function hasInputs(names: string[]) {
  return (ctx: PassContext) => {
    const u: Record<string, number> = {};
    for (const n of names) u['u_has' + n[0].toUpperCase() + n.slice(1)] = ctx.inputSizes[n] ? 1 : 0;
    return u;
  };
}
export const hasDecl = (names: string[]) => names.map((n) => `uniform float u_has${n[0].toUpperCase() + n.slice(1)};`).join('\n');

// ---------------------------------------------------------------------------
// GLSL: basics + Blender colour conversions
// ---------------------------------------------------------------------------

export const GLSL_BASE = /* glsl */ `
#define BL_FLT_MAX 3.402823e+38
/** Implicit colour → float conversion (Blender uses the scene luminance weights). Grey masks pass unchanged. */
float bl_float(vec4 c) { return dot(c.rgb, vec3(0.2126, 0.7152, 0.0722)); }
float bl_safe_div(float a, float b) { return b != 0.0 ? a / b : 0.0; }
vec3 bl_safe_div(vec3 a, vec3 b) { return vec3(bl_safe_div(a.x, b.x), bl_safe_div(a.y, b.y), bl_safe_div(a.z, b.z)); }
vec3 bl_safe_normalize(vec3 v) { float l = length(v); return l != 0.0 ? v / l : vec3(0.0); }

// Blender's rgb_to_hsv / hsv_to_rgb (gpu_shader_common_color_utils.glsl)
vec3 bl_rgb2hsv(vec3 rgb) {
  float cmax = max(rgb.r, max(rgb.g, rgb.b)), cmin = min(rgb.r, min(rgb.g, rgb.b));
  float cdelta = cmax - cmin, h = 0.0, s = 0.0, v = cmax;
  if (cmax != 0.0) s = cdelta / cmax;
  if (s != 0.0) {
    vec3 c = (vec3(cmax) - rgb) / cdelta;
    if (rgb.r == cmax) h = c.b - c.g;
    else if (rgb.g == cmax) h = 2.0 + c.r - c.b;
    else h = 4.0 + c.g - c.r;
    h /= 6.0;
    if (h < 0.0) h += 1.0;
  }
  return vec3(h, s, v);
}
vec3 bl_hsv2rgb(vec3 hsv) {
  float h = hsv.x, s = hsv.y, v = hsv.z;
  if (s == 0.0) return vec3(v);
  if (h == 1.0) h = 0.0;
  h *= 6.0;
  float i = floor(h), f = h - i;
  float p = v * (1.0 - s), q = v * (1.0 - s * f), t = v * (1.0 - s * (1.0 - f));
  if (i == 0.0) return vec3(v, t, p);
  if (i == 1.0) return vec3(q, v, p);
  if (i == 2.0) return vec3(p, v, t);
  if (i == 3.0) return vec3(p, q, v);
  if (i == 4.0) return vec3(t, p, v);
  return vec3(v, p, q);
}
vec3 bl_rgb2hsl(vec3 rgb) {
  float cmax = max(rgb.r, max(rgb.g, rgb.b)), cmin = min(rgb.r, min(rgb.g, rgb.b));
  float h = 0.0, s = 0.0, l = min(1.0, (cmax + cmin) / 2.0);
  if (cmax != cmin) {
    float d = cmax - cmin;
    s = l > 0.5 ? d / (2.0 - cmax - cmin) : d / (cmax + cmin);
    if (cmax == rgb.r) h = (rgb.g - rgb.b) / d + (rgb.g < rgb.b ? 6.0 : 0.0);
    else if (cmax == rgb.g) h = (rgb.b - rgb.r) / d + 2.0;
    else h = (rgb.r - rgb.g) / d + 4.0;
  }
  return vec3(h / 6.0, s, l);
}
vec3 bl_hsl2rgb(vec3 hsl) {
  float h = hsl.x, s = hsl.y, l = hsl.z;
  float nr = clamp(abs(h * 6.0 - 3.0) - 1.0, 0.0, 1.0);
  float ng = clamp(2.0 - abs(h * 6.0 - 2.0), 0.0, 1.0);
  float nb = clamp(2.0 - abs(h * 6.0 - 4.0), 0.0, 1.0);
  float chroma = (1.0 - abs(2.0 * l - 1.0)) * s;
  return (vec3(nr, ng, nb) - 0.5) * chroma + l;
}
`;

// ---------------------------------------------------------------------------
// GLSL: Mix Color (Blender ramp_blend / gpu_shader_material_mix_color.glsl)
// ---------------------------------------------------------------------------

export const MIX_BLEND_TYPES = ['Mix', 'Darken', 'Multiply', 'Color Burn', 'Lighten', 'Screen', 'Color Dodge', 'Add', 'Overlay', 'Soft Light', 'Linear Light', 'Difference', 'Exclusion', 'Subtract', 'Divide', 'Hue', 'Saturation', 'Color', 'Value'];

/** `vec3 bl_mixColor(int type, float fac, vec3 a, vec3 b)`; type indexes MIX_BLEND_TYPES. Follows Blender's definitions exactly. */
export const GLSL_MIX = /* glsl */ `
float bl_dodge(float a, float b, float fac) {
  if (a == 0.0) return a;
  float tmp = 1.0 - fac * b;
  if (tmp <= 0.0) return 1.0;
  tmp = a / tmp;
  return tmp > 1.0 ? 1.0 : tmp;
}
float bl_burn(float a, float b, float facm, float fac) {
  float tmp = facm + fac * b;
  if (tmp <= 0.0) return 0.0;
  tmp = 1.0 - (1.0 - a) / tmp;
  return clamp(tmp, 0.0, 1.0);
}
vec3 bl_mixColor(int type, float fac, vec3 a, vec3 b) {
  float facm = 1.0 - fac;
  if (type == 0) return facm * a + fac * b;                                     // Mix
  if (type == 1) return mix(a, min(a, b), fac);                                  // Darken
  if (type == 2) return a * (facm + fac * b);                                    // Multiply
  if (type == 3) return vec3(bl_burn(a.r, b.r, facm, fac), bl_burn(a.g, b.g, facm, fac), bl_burn(a.b, b.b, facm, fac)); // Color Burn
  if (type == 4) return mix(a, max(a, b), fac);                                  // Lighten
  if (type == 5) return 1.0 - (facm + fac * (1.0 - b)) * (1.0 - a);              // Screen
  if (type == 6) return vec3(bl_dodge(a.r, b.r, fac), bl_dodge(a.g, b.g, fac), bl_dodge(a.b, b.b, fac)); // Color Dodge
  if (type == 7) return a + fac * b;                                             // Add
  if (type == 8) {                                                               // Overlay
    vec3 o;
    for (int i = 0; i < 3; i++) o[i] = a[i] < 0.5 ? a[i] * (facm + 2.0 * fac * b[i]) : 1.0 - (facm + 2.0 * fac * (1.0 - b[i])) * (1.0 - a[i]);
    return o;
  }
  if (type == 9) {                                                               // Soft Light
    vec3 scr = 1.0 - (1.0 - b) * (1.0 - a);
    return facm * a + fac * ((1.0 - a) * b * a + a * scr);
  }
  if (type == 10) return a + fac * (2.0 * (b - 0.5));                           // Linear Light
  if (type == 11) return facm * a + fac * abs(a - b);                           // Difference
  if (type == 12) return max(mix(a, a + b - 2.0 * a * b, fac), 0.0);            // Exclusion
  if (type == 13) return a - fac * b;                                           // Subtract
  if (type == 14) {                                                             // Divide
    vec3 o = a;
    for (int i = 0; i < 3; i++) if (b[i] != 0.0) o[i] = facm * a[i] + fac * a[i] / b[i];
    return o;
  }
  if (type == 15) {                                                             // Hue
    vec3 hsv2 = bl_rgb2hsv(b);
    if (hsv2.y == 0.0) return a;
    vec3 hsv = bl_rgb2hsv(a);
    hsv.x = hsv2.x;
    return mix(a, bl_hsv2rgb(hsv), fac);
  }
  if (type == 16) {                                                             // Saturation
    vec3 hsv = bl_rgb2hsv(a);
    if (hsv.y == 0.0) return a;
    vec3 hsv2 = bl_rgb2hsv(b);
    hsv.y = facm * hsv.y + fac * hsv2.y;
    return bl_hsv2rgb(hsv);
  }
  if (type == 17) {                                                             // Color
    vec3 hsv2 = bl_rgb2hsv(b);
    if (hsv2.y == 0.0) return a;
    vec3 hsv = bl_rgb2hsv(a);
    hsv.xy = hsv2.xy;
    return mix(a, bl_hsv2rgb(hsv), fac);
  }
  vec3 hsv = bl_rgb2hsv(a), hsv2 = bl_rgb2hsv(b);                              // Value
  hsv.z = facm * hsv.z + fac * hsv2.z;
  return bl_hsv2rgb(hsv);
}
`;

// ---------------------------------------------------------------------------
// GLSL: Blender hash (Bob Jenkins lookup3, gpu_shader_common_hash.glsl)
// ---------------------------------------------------------------------------

export const GLSL_HASH = /* glsl */ `
#define bl_rot(x, k) (((x) << (k)) | ((x) >> (32 - (k))))
#define bl_final(a, b, c) { c ^= b; c -= bl_rot(b, 14); a ^= c; a -= bl_rot(c, 11); b ^= a; b -= bl_rot(a, 25); c ^= b; c -= bl_rot(b, 16); a ^= c; a -= bl_rot(c, 4); b ^= a; b -= bl_rot(a, 14); c ^= b; c -= bl_rot(b, 24); }
#define bl_mixh(a, b, c) { a -= c; a ^= bl_rot(c, 4); c += b; b -= a; b ^= bl_rot(a, 6); a += c; c -= b; c ^= bl_rot(b, 8); b += a; a -= c; a ^= bl_rot(c, 16); c += b; b -= a; b ^= bl_rot(a, 19); a += c; c -= b; c ^= bl_rot(b, 4); b += a; }
uint bl_hash_uint(uint kx) { uint a, b, c; a = b = c = 0xdeadbeefu + (1u << 2u) + 13u; a += kx; bl_final(a, b, c); return c; }
uint bl_hash_uint2(uint kx, uint ky) { uint a, b, c; a = b = c = 0xdeadbeefu + (2u << 2u) + 13u; b += ky; a += kx; bl_final(a, b, c); return c; }
uint bl_hash_uint3(uint kx, uint ky, uint kz) { uint a, b, c; a = b = c = 0xdeadbeefu + (3u << 2u) + 13u; c += kz; b += ky; a += kx; bl_final(a, b, c); return c; }
uint bl_hash_uint4(uint kx, uint ky, uint kz, uint kw) {
  uint a, b, c; a = b = c = 0xdeadbeefu + (4u << 2u) + 13u;
  a += kx; b += ky; c += kz; bl_mixh(a, b, c);
  a += kw; bl_final(a, b, c); return c;
}
#define BL_U2F(h) (float(h) / float(0xFFFFFFFFu))
float bl_hash_f(float k) { return BL_U2F(bl_hash_uint(floatBitsToUint(k))); }
float bl_hash_f(vec2 k) { return BL_U2F(bl_hash_uint2(floatBitsToUint(k.x), floatBitsToUint(k.y))); }
float bl_hash_f(vec3 k) { return BL_U2F(bl_hash_uint3(floatBitsToUint(k.x), floatBitsToUint(k.y), floatBitsToUint(k.z))); }
float bl_hash_f(vec4 k) { return BL_U2F(bl_hash_uint4(floatBitsToUint(k.x), floatBitsToUint(k.y), floatBitsToUint(k.z), floatBitsToUint(k.w))); }
vec2 bl_hash_v2(vec2 k) { return vec2(bl_hash_f(k), bl_hash_f(vec3(k, 1.0))); }
vec3 bl_hash_v3(float k) { return vec3(bl_hash_f(k), bl_hash_f(vec2(k, 1.0)), bl_hash_f(vec2(k, 2.0))); }
vec3 bl_hash_v3(vec2 k) { return vec3(bl_hash_f(k), bl_hash_f(vec3(k, 1.0)), bl_hash_f(vec3(k, 2.0))); }
vec3 bl_hash_v3(vec3 k) { return vec3(bl_hash_f(k), bl_hash_f(vec4(k, 1.0)), bl_hash_f(vec4(k, 2.0))); }
vec3 bl_hash_v3(vec4 k) { return vec3(bl_hash_f(k.xyzw), bl_hash_f(k.zxwy), bl_hash_f(k.wzyx)); }
`;

// ---------------------------------------------------------------------------
// GLSL: Perlin noise + fractals (gpu_shader_material_noise / fractal_noise)
// Requires GLSL_HASH. Fractal functions are generated per dimension (see noiseLib).
// ---------------------------------------------------------------------------

export const GLSL_PERLIN = /* glsl */ `
float bl_fade(float t) { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }
float bl_negif(float v, uint c) { return c != 0u ? -v : v; }
float bl_grad(uint hash, float x) { uint h = hash & 15u; float g = float(1u + (h & 7u)); return bl_negif(g, h & 8u) * x; }
float bl_grad(uint hash, float x, float y) { uint h = hash & 7u; float u = h < 4u ? x : y; float v = 2.0 * (h < 4u ? y : x); return bl_negif(u, h & 1u) + bl_negif(v, h & 2u); }
float bl_grad(uint hash, float x, float y, float z) {
  uint h = hash & 15u; float u = h < 8u ? x : y; float vt = (h == 12u || h == 14u) ? x : z; float v = h < 4u ? y : vt;
  return bl_negif(u, h & 1u) + bl_negif(v, h & 2u);
}
float bl_grad(uint hash, float x, float y, float z, float w) {
  uint h = hash & 31u; float u = h < 24u ? x : y; float v = h < 16u ? y : z; float s = h < 8u ? z : w;
  return bl_negif(u, h & 1u) + bl_negif(v, h & 2u) + bl_negif(s, h & 4u);
}
#define BL_U(i) uint(i)
float bl_perlin(float p) {
  float fl = floor(p); int X = int(fl); float fx = p - fl; float u = bl_fade(fx);
  return mix(bl_grad(bl_hash_uint(BL_U(X)), fx), bl_grad(bl_hash_uint(BL_U(X + 1)), fx - 1.0), u);
}
float bl_perlin(vec2 p) {
  vec2 fl = floor(p); ivec2 I = ivec2(fl); vec2 f = p - fl; float u = bl_fade(f.x), v = bl_fade(f.y);
  float v0 = bl_grad(bl_hash_uint2(BL_U(I.x), BL_U(I.y)), f.x, f.y);
  float v1 = bl_grad(bl_hash_uint2(BL_U(I.x + 1), BL_U(I.y)), f.x - 1.0, f.y);
  float v2 = bl_grad(bl_hash_uint2(BL_U(I.x), BL_U(I.y + 1)), f.x, f.y - 1.0);
  float v3 = bl_grad(bl_hash_uint2(BL_U(I.x + 1), BL_U(I.y + 1)), f.x - 1.0, f.y - 1.0);
  return mix(mix(v0, v1, u), mix(v2, v3, u), v);
}
float bl_perlin(vec3 p) {
  vec3 fl = floor(p); ivec3 I = ivec3(fl); vec3 f = p - fl;
  float u = bl_fade(f.x), v = bl_fade(f.y), w = bl_fade(f.z);
  float c[8];
  for (int k = 0; k < 8; k++) {
    ivec3 o = ivec3(k & 1, (k >> 1) & 1, (k >> 2) & 1);
    ivec3 q = I + o; vec3 d = f - vec3(o);
    c[k] = bl_grad(bl_hash_uint3(BL_U(q.x), BL_U(q.y), BL_U(q.z)), d.x, d.y, d.z);
  }
  return mix(mix(mix(c[0], c[1], u), mix(c[2], c[3], u), v), mix(mix(c[4], c[5], u), mix(c[6], c[7], u), v), w);
}
float bl_perlin(vec4 p) {
  vec4 fl = floor(p); ivec4 I = ivec4(fl); vec4 f = p - fl;
  float u = bl_fade(f.x), v = bl_fade(f.y), t = bl_fade(f.z), s = bl_fade(f.w);
  float c[16];
  for (int k = 0; k < 16; k++) {
    ivec4 o = ivec4(k & 1, (k >> 1) & 1, (k >> 2) & 1, (k >> 3) & 1);
    ivec4 q = I + o; vec4 d = f - vec4(o);
    c[k] = bl_grad(bl_hash_uint4(BL_U(q.x), BL_U(q.y), BL_U(q.z), BL_U(q.w)), d.x, d.y, d.z, d.w);
  }
  float a = mix(mix(mix(c[0], c[1], u), mix(c[2], c[3], u), v), mix(mix(c[4], c[5], u), mix(c[6], c[7], u), v), t);
  float b = mix(mix(mix(c[8], c[9], u), mix(c[10], c[11], u), v), mix(mix(c[12], c[13], u), mix(c[14], c[15], u), v), t);
  return mix(a, b, s);
}
// Signed noise (≈ -1..1) with Blender's per-dimension scale factors and precision remap.
// (Blender remaps with a truncated fmod, i.e. identity for |p| < 1e5.)
#define BL_REMAP(p) ((p) - 100000.0 * trunc((p) / 100000.0))
float bl_snoise(float p) { return 0.2500 * bl_perlin(BL_REMAP(p)); }
float bl_snoise(vec2 p) { return 0.6616 * bl_perlin(BL_REMAP(p)); }
float bl_snoise(vec3 p) { return 0.9820 * bl_perlin(BL_REMAP(p)); }
float bl_snoise(vec4 p) { return 0.8344 * bl_perlin(BL_REMAP(p)); }
float bl_noise(float p) { return 0.5 * bl_snoise(p) + 0.5; }
float bl_noise(vec2 p) { return 0.5 * bl_snoise(p) + 0.5; }
float bl_noise(vec3 p) { return 0.5 * bl_snoise(p) + 0.5; }
float bl_noise(vec4 p) { return 0.5 * bl_snoise(p) + 0.5; }
float bl_rand_off(float seed, float i) { return 100.0 + bl_hash_f(vec2(seed, i)) * 100.0; }
`;

/** Fractal noise functions for one vector type (`float`, `vec2`, `vec3`, `vec4`). Names are suffixed with the type. */
export function fractalLib(T: string): string {
  return /* glsl */ `
float bl_fbm_${T}(${T} p, float detail, float roughness, float lacunarity, bool normalize) {
  float fscale = 1.0, amp = 1.0, maxamp = 0.0, sum = 0.0;
  for (int i = 0; i <= 15; i++) {
    if (i > int(detail)) break;
    float t = bl_snoise(fscale * p);
    sum += t * amp; maxamp += amp; amp *= roughness; fscale *= lacunarity;
  }
  float rmd = detail - floor(detail);
  if (rmd != 0.0) {
    float t = bl_snoise(fscale * p);
    float sum2 = sum + t * amp;
    return normalize ? mix(0.5 * sum / maxamp + 0.5, 0.5 * sum2 / (maxamp + amp) + 0.5, rmd) : mix(sum, sum2, rmd);
  }
  return normalize ? 0.5 * sum / maxamp + 0.5 : sum;
}
float bl_multi_${T}(${T} p, float detail, float roughness, float lacunarity) {
  float value = 1.0, pwr = 1.0;
  for (int i = 0; i <= 15; i++) {
    if (i > int(detail)) break;
    value *= (pwr * bl_snoise(p) + 1.0); pwr *= roughness; p *= lacunarity;
  }
  float rmd = detail - floor(detail);
  if (rmd != 0.0) value *= (rmd * pwr * bl_snoise(p) + 1.0);
  return value;
}
float bl_hetero_${T}(${T} p, float detail, float roughness, float lacunarity, float offset) {
  float pwr = roughness;
  float value = offset + bl_snoise(p);
  p *= lacunarity;
  for (int i = 1; i <= 15; i++) {
    if (i > int(detail)) break;
    float increment = (bl_snoise(p) + offset) * pwr * value;
    value += increment; pwr *= roughness; p *= lacunarity;
  }
  float rmd = detail - floor(detail);
  if (rmd != 0.0) { float increment = (bl_snoise(p) + offset) * pwr * value; value += rmd * increment; }
  return value;
}
float bl_hybrid_${T}(${T} p, float detail, float roughness, float lacunarity, float offset, float gain) {
  float pwr = 1.0, value = 0.0, weight = 1.0;
  for (int i = 0; i <= 15; i++) {
    if (i > int(detail) || weight <= 0.001) break;
    if (weight > 1.0) weight = 1.0;
    float signal = (bl_snoise(p) + offset) * pwr;
    pwr *= roughness; value += weight * signal; weight *= gain * signal; p *= lacunarity;
  }
  float rmd = detail - floor(detail);
  if (rmd != 0.0 && weight > 0.001) {
    if (weight > 1.0) weight = 1.0;
    float signal = (bl_snoise(p) + offset) * pwr;
    value += rmd * weight * signal;
  }
  return value;
}
float bl_ridged_${T}(${T} p, float detail, float roughness, float lacunarity, float offset, float gain) {
  float pwr = roughness;
  float signal = offset - abs(bl_snoise(p));
  signal *= signal;
  float value = signal, weight = 1.0;
  for (int i = 1; i <= 15; i++) {
    if (i > int(detail)) break;
    p *= lacunarity;
    weight = clamp(signal * gain, 0.0, 1.0);
    signal = offset - abs(bl_snoise(p));
    signal *= signal; signal *= weight;
    value += signal * pwr; pwr *= roughness;
  }
  return value;
}
/** type: 0 Multifractal, 1 Ridged, 2 Hybrid, 3 fBM, 4 Hetero Terrain (Blender's enum order). */
float bl_fractal_${T}(${T} p, float detail, float roughness, float lacunarity, float offset, float gain, int type, bool normalize) {
  detail = clamp(detail, 0.0, 15.0);
  roughness = max(roughness, 0.0);
  if (type == 0) return bl_multi_${T}(p, detail, roughness, lacunarity);
  if (type == 1) return bl_ridged_${T}(p, detail, roughness, lacunarity, offset, gain);
  if (type == 2) return bl_hybrid_${T}(p, detail, roughness, lacunarity, offset, gain);
  if (type == 4) return bl_hetero_${T}(p, detail, roughness, lacunarity, offset);
  return bl_fbm_${T}(p, detail, roughness, lacunarity, normalize);
}
`;
}

// ---------------------------------------------------------------------------
// GLSL: texture coordinates
// ---------------------------------------------------------------------------

/**
 * Coordinate conventions (Blender-like, y up):
 *  - uv:        (x, 1 - y) of v_uv — origin bottom-left, 0..1.
 *  - generated: centred, aspect-corrected: y in -1..1 (bottom→top), x in -aspect..aspect.
 *  - pixel:     full-resolution pixel coordinates / 1000, origin bottom-left.
 * All depend only on v_uv and the output aspect, so they are render-scale invariant.
 */
export const GLSL_COORDS = /* glsl */ `
vec3 bl_uvCoord() { return vec3(v_uv.x, 1.0 - v_uv.y, 0.0); }
vec3 bl_generatedCoord() {
  float aspect = u_resolution.x / max(u_resolution.y, 1.0);
  return vec3((v_uv.x * 2.0 - 1.0) * aspect, (1.0 - v_uv.y) * 2.0 - 1.0, 0.0);
}
vec3 bl_pixelCoord() { return vec3(v_uv.x * u_resolution.x, (1.0 - v_uv.y) * u_resolution.y, 0.0) / max(u_scale, 1e-6) / 1000.0; }
`;

// ---------------------------------------------------------------------------
// JS: Blender colour conversions (for baking + tests)
// ---------------------------------------------------------------------------

export type RGB = [number, number, number];
export type RGBA = [number, number, number, number];

export function rgbToHsv([r, g, b]: RGB): RGB {
  const cmax = Math.max(r, g, b), cmin = Math.min(r, g, b), d = cmax - cmin;
  let h = 0;
  const s = cmax !== 0 ? d / cmax : 0;
  if (s !== 0) {
    const cr = (cmax - r) / d, cg = (cmax - g) / d, cb = (cmax - b) / d;
    if (r === cmax) h = cb - cg;
    else if (g === cmax) h = 2 + cr - cb;
    else h = 4 + cg - cr;
    h /= 6;
    if (h < 0) h += 1;
  }
  return [h, s, cmax];
}

export function hsvToRgb([h, s, v]: RGB): RGB {
  if (s === 0) return [v, v, v];
  if (h === 1) h = 0;
  h *= 6;
  const i = Math.floor(h), f = h - i;
  const p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
  switch (i) {
    case 0: return [v, t, p];
    case 1: return [q, v, p];
    case 2: return [p, v, t];
    case 3: return [p, q, v];
    case 4: return [t, p, v];
    default: return [v, p, q];
  }
}

export function rgbToHsl([r, g, b]: RGB): RGB {
  const cmax = Math.max(r, g, b), cmin = Math.min(r, g, b);
  const l = Math.min(1, (cmax + cmin) / 2);
  if (cmax === cmin) return [0, 0, l];
  const d = cmax - cmin;
  const s = l > 0.5 ? d / (2 - cmax - cmin) : d / (cmax + cmin);
  let h;
  if (cmax === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (cmax === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

export function hslToRgb([h, s, l]: RGB): RGB {
  const cl = (x: number) => Math.min(1, Math.max(0, x));
  const nr = cl(Math.abs(h * 6 - 3) - 1), ng = cl(2 - Math.abs(h * 6 - 2)), nb = cl(2 - Math.abs(h * 6 - 4));
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  return [(nr - 0.5) * chroma + l, (ng - 0.5) * chroma + l, (nb - 0.5) * chroma + l];
}

// ---------------------------------------------------------------------------
// JS: Mix Color reference (mirror of GLSL_MIX; used by tests and the harness check)
// ---------------------------------------------------------------------------

export function mixColorRef(type: string, fac: number, a: RGB, b: RGB): RGB {
  const facm = 1 - fac;
  const per = (f: (x: number, y: number) => number): RGB => [f(a[0], b[0]), f(a[1], b[1]), f(a[2], b[2])];
  switch (type) {
    case 'Mix': return per((x, y) => facm * x + fac * y);
    case 'Darken': return per((x, y) => x + (Math.min(x, y) - x) * fac);
    case 'Multiply': return per((x, y) => x * (facm + fac * y));
    case 'Color Burn': return per((x, y) => {
      const t = facm + fac * y;
      if (t <= 0) return 0;
      return Math.min(1, Math.max(0, 1 - (1 - x) / t));
    });
    case 'Lighten': return per((x, y) => x + (Math.max(x, y) - x) * fac);
    case 'Screen': return per((x, y) => 1 - (facm + fac * (1 - y)) * (1 - x));
    case 'Color Dodge': return per((x, y) => {
      if (x === 0) return x;
      const t = 1 - fac * y;
      if (t <= 0) return 1;
      return Math.min(1, x / t);
    });
    case 'Add': return per((x, y) => x + fac * y);
    case 'Overlay': return per((x, y) => (x < 0.5 ? x * (facm + 2 * fac * y) : 1 - (facm + 2 * fac * (1 - y)) * (1 - x)));
    case 'Soft Light': return per((x, y) => {
      const scr = 1 - (1 - y) * (1 - x);
      return facm * x + fac * ((1 - x) * y * x + x * scr);
    });
    case 'Linear Light': return per((x, y) => x + fac * (2 * (y - 0.5)));
    case 'Difference': return per((x, y) => facm * x + fac * Math.abs(x - y));
    case 'Exclusion': return per((x, y) => Math.max(x + (x + y - 2 * x * y - x) * fac, 0));
    case 'Subtract': return per((x, y) => x - fac * y);
    case 'Divide': return per((x, y) => (y !== 0 ? facm * x + (fac * x) / y : x));
    case 'Hue': {
      const h2 = rgbToHsv(b);
      if (h2[1] === 0) return [...a];
      const h = rgbToHsv(a);
      const t = hsvToRgb([h2[0], h[1], h[2]]);
      return a.map((x, i) => x + (t[i] - x) * fac) as RGB;
    }
    case 'Saturation': {
      const h = rgbToHsv(a);
      if (h[1] === 0) return [...a];
      const h2 = rgbToHsv(b);
      return hsvToRgb([h[0], facm * h[1] + fac * h2[1], h[2]]);
    }
    case 'Color': {
      const h2 = rgbToHsv(b);
      if (h2[1] === 0) return [...a];
      const h = rgbToHsv(a);
      const t = hsvToRgb([h2[0], h2[1], h[2]]);
      return a.map((x, i) => x + (t[i] - x) * fac) as RGB;
    }
    case 'Value': {
      const h = rgbToHsv(a), h2 = rgbToHsv(b);
      return hsvToRgb([h[0], h[1], facm * h[2] + fac * h2[2]]);
    }
  }
  throw new Error('unknown blend type ' + type);
}

// ---------------------------------------------------------------------------
// JS: Color Ramp (port of BKE_colorband_evaluate)
// ---------------------------------------------------------------------------

export const RAMP_INTERP = ['Constant', 'Linear', 'Ease', 'Cardinal', 'B-Spline'];
export const RAMP_MODES = ['RGB', 'HSV', 'HSL'];
export const RAMP_HUE = ['Near', 'Far', 'Clockwise', 'Counter-Clockwise'];
export const RAMP_MAX = 8;

export interface RampStop { pos: number; color: RGBA }
export interface Ramp { stops: RampStop[]; interpolation: string; mode: string; hue: string }

/** Blender's key_curve_position_weights for KEY_CARDINAL / KEY_BSPLINE. */
function curveWeights(t: number, cardinal: boolean): [number, number, number, number] {
  const t2 = t * t, t3 = t2 * t;
  if (cardinal) {
    const fc = 0.71;
    return [-fc * t3 + 2 * fc * t2 - fc * t, (2 - fc) * t3 + (fc - 3) * t2 + 1, (fc - 2) * t3 + (3 - 2 * fc) * t2 + fc * t, fc * t3 - fc * t2];
  }
  return [-0.16666666 * t3 + 0.5 * t2 - 0.5 * t + 0.16666666, 0.5 * t3 - t2 + 0.66666666, -0.5 * t3 + 0.5 * t2 + 0.5 * t + 0.16666666, 0.16666666 * t3];
}

/** Blender's colorband_hue_interp. h1 belongs to the right stop (weight mfac), h2 to the left one (weight fac). */
function hueInterp(mode: string, mfac: number, fac: number, h1: number, h2: number): number {
  const mod = (h: number) => (h < 1 ? h : h - 1);
  h1 = mod(h1); h2 = mod(h2);
  let m = 0;
  switch (mode) {
    case 'Near': m = h1 < h2 && h2 - h1 > 0.5 ? 1 : h1 > h2 && h2 - h1 < -0.5 ? 2 : 0; break;
    case 'Far': m = h1 === h2 ? 1 : h1 < h2 && h2 - h1 < 0.5 ? 1 : h1 > h2 && h2 - h1 > -0.5 ? 2 : 0; break;
    case 'Counter-Clockwise': m = h1 > h2 ? 2 : 0; break;
    case 'Clockwise': m = h1 < h2 ? 1 : 0; break;
  }
  if (m === 1) return mod(mfac * (h1 + 1) + fac * h2);
  if (m === 2) return mod(mfac * h1 + fac * (h2 + 1));
  return mfac * h1 + fac * h2;
}

export function evalRamp(ramp: Ramp, t: number): RGBA {
  const stops = [...ramp.stops].sort((a, b) => a.pos - b.pos);
  const tot = stops.length;
  if (tot === 0) return [0, 0, 0, 0];
  const ip = ramp.interpolation;
  const simple = ip === 'Linear' || ip === 'Ease' || ip === 'Constant';
  if (tot === 1 || (t <= stops[0].pos && simple)) return [...stops[0].color];
  // first stop with pos > t
  let a = 0;
  while (a < tot && stops[a].pos <= t) a++;
  // cbd1 = right stop, cbd2 = left stop (Blender naming); virtual copies at 0/1 beyond the ends
  let cbd1: RampStop, cbd2: RampStop;
  if (a === tot) { cbd2 = stops[tot - 1]; cbd1 = { pos: 1, color: stops[tot - 1].color }; }
  else if (a === 0) { cbd1 = stops[0]; cbd2 = { pos: 0, color: stops[0].color }; }
  else { cbd1 = stops[a]; cbd2 = stops[a - 1]; }
  if ((a === tot && simple) || ip === 'Constant') return [...cbd2.color];
  let fac = cbd2.pos !== cbd1.pos ? (t - cbd1.pos) / (cbd2.pos - cbd1.pos) : a !== tot ? 0 : 1;
  if (ip === 'Cardinal' || ip === 'B-Spline') {
    const cbd0 = a >= tot - 1 ? cbd1 : stops[a + 1];
    const cbd3 = a < 2 ? cbd2 : stops[a - 2];
    fac = Math.min(1, Math.max(0, fac));
    const w = curveWeights(fac, ip === 'Cardinal');
    return [0, 1, 2, 3].map((i) => Math.min(1, Math.max(0, w[3] * cbd3.color[i] + w[2] * cbd2.color[i] + w[1] * cbd1.color[i] + w[0] * cbd0.color[i]))) as RGBA;
  }
  if (ip === 'Ease') { const f2 = fac * fac; fac = 3 * f2 - 2 * f2 * fac; }
  const mfac = 1 - fac;
  const c1 = cbd1.color, c2 = cbd2.color;
  if (ramp.mode === 'HSV' || ramp.mode === 'HSL') {
    const to = ramp.mode === 'HSV' ? rgbToHsv : rgbToHsl, from = ramp.mode === 'HSV' ? hsvToRgb : hslToRgb;
    const h1 = to([c1[0], c1[1], c1[2]]), h2 = to([c2[0], c2[1], c2[2]]);
    const rgb = from([hueInterp(ramp.hue, mfac, fac, h1[0], h2[0]), mfac * h1[1] + fac * h2[1], mfac * h1[2] + fac * h2[2]]);
    return [rgb[0], rgb[1], rgb[2], mfac * c1[3] + fac * c2[3]];
  }
  return [0, 1, 2, 3].map((i) => mfac * c1[i] + fac * c2[i]) as RGBA;
}

/** Read a ramp from node params (`count`, `pos0..7`, `color0..7`, `interpolation`, `colorMode`, `hueInterpolation`). */
export function rampFromParams(params: Params): Ramp {
  const count = Math.max(1, Math.min(RAMP_MAX, Math.round(num(params, 'count', 2))));
  const stops: RampStop[] = [];
  for (let i = 0; i < count; i++) {
    const c = params['color' + i];
    const col = Array.isArray(c) ? (c as number[]) : [0, 0, 0, 1];
    stops.push({ pos: Math.min(1, Math.max(0, num(params, 'pos' + i, i / Math.max(1, count - 1)))), color: [col[0] ?? 0, col[1] ?? 0, col[2] ?? 0, col[3] ?? 1] });
  }
  return { stops, interpolation: String(params.interpolation ?? 'Linear'), mode: String(params.colorMode ?? 'RGB'), hue: String(params.hueInterpolation ?? 'Near') };
}

/** Bake a ramp into `n` RGBA samples over t ∈ [0,1] (sample j at t = j/(n-1)). */
export function bakeRamp(ramp: Ramp, n = 256): Float32Array {
  const out = new Float32Array(n * 4);
  for (let j = 0; j < n; j++) out.set(evalRamp(ramp, j / (n - 1)), j * 4);
  return out;
}

// ---------------------------------------------------------------------------
// JS: Blackbody (Cycles svm_math_blackbody_color fit, normalised to luminance 1)
// ---------------------------------------------------------------------------

export const BLACKBODY_R = [
  [2.52432244e3, -1.06185848e-3, 3.11067539],
  [3.37763626e3, -4.34581697e-4, 1.64843306],
  [4.10671449e3, -8.61949938e-5, 6.41423749e-1],
  [4.66849800e3, 2.85655028e-5, 1.29075375e-1],
  [4.60124770e3, 2.89727618e-5, 1.48001316e-1],
  [3.78765709e3, 9.36026367e-6, 3.98995841e-1],
];
export const BLACKBODY_G = [
  [-7.50343014e2, 3.15679613e-4, 4.73464526e-1],
  [-1.00402363e3, 1.29189794e-4, 9.08181524e-1],
  [-1.22075471e3, 2.56245413e-5, 1.20753416],
  [-1.42546105e3, -4.01730887e-5, 1.44002695],
  [-1.18134453e3, -2.18913373e-5, 1.30656109],
  [-5.00279505e2, -4.59745390e-6, 1.09090465],
];
export const BLACKBODY_B = [
  [0, 0, 0, 0],
  [0, 0, 0, 0],
  [0, 0, 0, 0],
  [-2.02524603e-11, 1.79435860e-7, -2.60561875e-4, -1.41761141e-2],
  [-2.22463426e-13, -1.55078698e-8, 3.81675160e-4, -7.30646033e-1],
  [6.72595954e-13, -2.73059993e-8, 4.24068546e-4, -7.52204323e-1],
];

/** Un-normalised linear Rec.709 blackbody colour (Cycles' piecewise rational fit, 965..12000 K). */
export function blackbodyRaw(t: number): RGB {
  if (t >= 12000) return [0.826270103, 0.994478524, 1.56626022];
  if (t < 965) return [4.70366907, 0, 0];
  const i = t >= 6365 ? 5 : t >= 3315 ? 4 : t >= 1902 ? 3 : t >= 1449 ? 2 : t >= 1167 ? 1 : 0;
  const r = BLACKBODY_R[i], g = BLACKBODY_G[i], b = BLACKBODY_B[i];
  return [r[0] / t + r[1] * t + r[2], g[0] / t + g[1] * t + g[2], ((b[0] * t + b[1]) * t + b[2]) * t + b[3]];
}

/** Linear Rec.709 blackbody colour scaled to luminance 1 (as Blender's node does). */
export function blackbody(t: number): RGB {
  const c = blackbodyRaw(t);
  const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return l !== 0 ? [c[0] / l, c[1] / l, c[2] / l] : c;
}

export const GLSL_BLACKBODY = /* glsl */ `
vec3 bl_blackbody(float t) {
  vec3 c;
  if (t >= 12000.0) c = vec3(0.826270103, 0.994478524, 1.56626022);
  else if (t < 965.0) c = vec3(4.70366907, 0.0, 0.0);
  else {
    vec3 r, g; vec4 b;
    ${BLACKBODY_R.map((_, i) => {
      const th = [0, 1167, 1449, 1902, 3315, 6365][i];
      const f = (x: number) => x.toExponential(9);
      const rr = BLACKBODY_R[i].map(f).join(', '), gg = BLACKBODY_G[i].map(f).join(', '), bb = BLACKBODY_B[i].map(f).join(', ');
      return `${i ? 'if' : 'r'}${i ? ` (t >= ${th}.0) { r = vec3(${rr}); g = vec3(${gg}); b = vec4(${bb}); }` : ` = vec3(${rr}); g = vec3(${gg}); b = vec4(${bb});`}`;
    }).join('\n    ')}
    c = vec3(r.x / t + r.y * t + r.z, g.x / t + g.y * t + g.z, ((b.x * t + b.y) * t + b.z) * t + b.w);
  }
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  return l != 0.0 ? c / l : c;
}
`;

// ---------------------------------------------------------------------------
// JS: Wavelength (Cycles svm_node_wavelength: CIE 1931 2° CMF table, 380..780 nm / 5 nm)
// ---------------------------------------------------------------------------

export const CIE_CMF: RGB[] = [
  [0.0014, 0.0000, 0.0065], [0.0022, 0.0001, 0.0105], [0.0042, 0.0001, 0.0201],
  [0.0076, 0.0002, 0.0362], [0.0143, 0.0004, 0.0679], [0.0232, 0.0006, 0.1102],
  [0.0435, 0.0012, 0.2074], [0.0776, 0.0022, 0.3713], [0.1344, 0.0040, 0.6456],
  [0.2148, 0.0073, 1.0391], [0.2839, 0.0116, 1.3856], [0.3285, 0.0168, 1.6230],
  [0.3483, 0.0230, 1.7471], [0.3481, 0.0298, 1.7826], [0.3362, 0.0380, 1.7721],
  [0.3187, 0.0480, 1.7441], [0.2908, 0.0600, 1.6692], [0.2511, 0.0739, 1.5281],
  [0.1954, 0.0910, 1.2876], [0.1421, 0.1126, 1.0419], [0.0956, 0.1390, 0.8130],
  [0.0580, 0.1693, 0.6162], [0.0320, 0.2080, 0.4652], [0.0147, 0.2586, 0.3533],
  [0.0049, 0.3230, 0.2720], [0.0024, 0.4073, 0.2123], [0.0093, 0.5030, 0.1582],
  [0.0291, 0.6082, 0.1117], [0.0633, 0.7100, 0.0782], [0.1096, 0.7932, 0.0573],
  [0.1655, 0.8620, 0.0422], [0.2257, 0.9149, 0.0298], [0.2904, 0.9540, 0.0203],
  [0.3597, 0.9803, 0.0134], [0.4334, 0.9950, 0.0087], [0.5121, 1.0000, 0.0057],
  [0.5945, 0.9950, 0.0039], [0.6784, 0.9786, 0.0027], [0.7621, 0.9520, 0.0021],
  [0.8425, 0.9154, 0.0018], [0.9163, 0.8700, 0.0017], [0.9786, 0.8163, 0.0014],
  [1.0263, 0.7570, 0.0011], [1.0567, 0.6949, 0.0010], [1.0622, 0.6310, 0.0008],
  [1.0456, 0.5668, 0.0006], [1.0026, 0.5030, 0.0003], [0.9384, 0.4412, 0.0002],
  [0.8544, 0.3810, 0.0002], [0.7514, 0.3210, 0.0001], [0.6424, 0.2650, 0.0000],
  [0.5419, 0.2170, 0.0000], [0.4479, 0.1750, 0.0000], [0.3608, 0.1382, 0.0000],
  [0.2835, 0.1070, 0.0000], [0.2187, 0.0816, 0.0000], [0.1649, 0.0610, 0.0000],
  [0.1212, 0.0446, 0.0000], [0.0874, 0.0320, 0.0000], [0.0636, 0.0232, 0.0000],
  [0.0468, 0.0170, 0.0000], [0.0329, 0.0119, 0.0000], [0.0227, 0.0082, 0.0000],
  [0.0158, 0.0057, 0.0000], [0.0114, 0.0041, 0.0000], [0.0081, 0.0029, 0.0000],
  [0.0058, 0.0021, 0.0000], [0.0041, 0.0015, 0.0000], [0.0029, 0.0010, 0.0000],
  [0.0020, 0.0007, 0.0000], [0.0014, 0.0005, 0.0000], [0.0010, 0.0004, 0.0000],
  [0.0007, 0.0002, 0.0000], [0.0005, 0.0002, 0.0000], [0.0003, 0.0001, 0.0000],
  [0.0002, 0.0001, 0.0000], [0.0002, 0.0001, 0.0000], [0.0001, 0.0000, 0.0000],
  [0.0001, 0.0000, 0.0000], [0.0001, 0.0000, 0.0000], [0.0000, 0.0000, 0.0000],
];

/** CIE XYZ → linear Rec.709 / sRGB primaries (D65). */
export function xyzToRgb([x, y, z]: RGB): RGB {
  return [
    3.2404542 * x - 1.5371385 * y - 0.4985314 * z,
    -0.969266 * x + 1.8760108 * y + 0.041556 * z,
    0.0556434 * x - 0.2040259 * y + 1.0572252 * z,
  ];
}

/** Wavelength table converted to linear RGB and scaled by 1/2.52 (before the final clamp to ≥0). */
export const WAVELENGTH_RGB: RGB[] = CIE_CMF.map((c) => xyzToRgb(c).map((v) => v / 2.52) as RGB);

/** Linear Rec.709 colour of a wavelength in nm (Blender's Wavelength node). Black outside 380..780. */
export function wavelength(nm: number): RGB {
  let ii = (nm - 380) / 5;
  const i = Math.trunc(ii);
  if (!(ii >= 0) || i < 0 || i >= 80) return [0, 0, 0];
  ii -= i;
  const a = WAVELENGTH_RGB[i], b = WAVELENGTH_RGB[i + 1];
  return [0, 1, 2].map((k) => Math.max(0, a[k] + (b[k] - a[k]) * ii)) as RGB;
}
