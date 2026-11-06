/**
 * Shared GLSL ES 3.00 library, prepended to every node shader.
 * Conventions: v_uv (0,0) = TOP-LEFT of the image, (1,1) = bottom-right.
 * Colours are display-referred sRGB values in [0,1] (may exceed in float buffers).
 */
export const GLSL_LIB = /* glsl */ `
#define PI 3.14159265359
#define TAU 6.28318530718

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float luma601(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
float saturate(float x) { return clamp(x, 0.0, 1.0); }
vec3 saturate(vec3 x) { return clamp(x, 0.0, 1.0); }

// --- colour spaces --------------------------------------------------------
vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
vec3 rgb2yiq(vec3 c) {
  return mat3(0.299, 0.596, 0.211, 0.587, -0.274, -0.523, 0.114, -0.322, 0.312) * c;
}
vec3 yiq2rgb(vec3 c) {
  return mat3(1.0, 1.0, 1.0, 0.956, -0.272, -1.106, 0.621, -0.647, 1.703) * c;
}
vec3 rgb2yuv(vec3 c) { // BT.601, U/V centred on 0
  return mat3(0.299, -0.14713, 0.615, 0.587, -0.28886, -0.51499, 0.114, 0.436, -0.10001) * c;
}
vec3 yuv2rgb(vec3 c) {
  return mat3(1.0, 1.0, 1.0, 0.0, -0.39465, 2.03211, 1.13983, -0.58060, 0.0) * c;
}
vec3 rgb2ycbcr(vec3 c) { // JPEG full range, Cb/Cr centred on 0.5
  float y = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
  return vec3(y, 0.5 + (c.b - y) * 0.564, 0.5 + (c.r - y) * 0.713);
}
vec3 ycbcr2rgb(vec3 c) {
  float y = c.x, cb = c.y - 0.5, cr = c.z - 0.5;
  return vec3(y + 1.403 * cr, y - 0.344 * cb - 0.714 * cr, y + 1.773 * cb);
}
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}
vec3 rgb2hsl(vec3 c) {
  float mx = max(max(c.r, c.g), c.b), mn = min(min(c.r, c.g), c.b);
  float l = (mx + mn) * 0.5;
  if (mx == mn) return vec3(0.0, 0.0, l);
  float d = mx - mn;
  float s = l > 0.5 ? d / (2.0 - mx - mn) : d / (mx + mn);
  float h;
  if (mx == c.r) h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
  else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
  else h = (c.r - c.g) / d + 4.0;
  return vec3(h / 6.0, s, l);
}
vec3 hsl2rgb(vec3 hsl) {
  vec3 rgb = clamp(abs(mod(hsl.x * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  return hsl.z + hsl.y * (rgb - 0.5) * (1.0 - abs(2.0 * hsl.z - 1.0));
}
/** Approximate white-balance multiplier for a colour temperature in Kelvin (1000..40000). */
vec3 kelvinToRgb(float k) {
  k = clamp(k, 1000.0, 40000.0) / 100.0;
  vec3 c;
  c.r = k <= 66.0 ? 1.0 : clamp(1.29293618606 * pow(k - 60.0, -0.1332047592), 0.0, 1.0);
  c.g = k <= 66.0 ? clamp(0.39008157876 * log(k) - 0.63184144378, 0.0, 1.0)
                  : clamp(1.12989086089 * pow(k - 60.0, -0.0755148492), 0.0, 1.0);
  c.b = k >= 66.0 ? 1.0 : (k <= 19.0 ? 0.0 : clamp(0.54320678911 * log(k - 10.0) - 1.19625408914, 0.0, 1.0));
  return c;
}

// --- hashing & noise ------------------------------------------------------
// Hash without Sine (Dave Hoskins) — stable across GPUs.
float hash11(float p) { p = fract(p * .1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
vec3 hash32(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yzz) * p3.zyx); }
float hash13(vec3 p3) { p3 = fract(p3 * .1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
/** Approximately gaussian random (mean 0, sd ~1) from a 2D seed. */
float gaussRand(vec2 p) {
  vec2 u = hash22(p);
  return sqrt(-2.0 * log(max(u.x, 1e-6))) * cos(TAU * u.y);
}
float valueNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float gradNoise(vec2 p) { // Perlin-style gradient noise, roughly -1..1
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 ga = hash22(i) * 2.0 - 1.0, gb = hash22(i + vec2(1, 0)) * 2.0 - 1.0;
  vec2 gc = hash22(i + vec2(0, 1)) * 2.0 - 1.0, gd = hash22(i + vec2(1, 1)) * 2.0 - 1.0;
  float a = dot(ga, f), b = dot(gb, f - vec2(1, 0)), c = dot(gc, f - vec2(0, 1)), d = dot(gd, f - vec2(1, 1));
  return 1.4 * mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p, int octaves) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 12; i++) { if (i >= octaves) break; s += a * valueNoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s;
}

// --- blending -------------------------------------------------------------
vec3 blendMultiply(vec3 a, vec3 b) { return a * b; }
vec3 blendScreen(vec3 a, vec3 b) { return 1.0 - (1.0 - a) * (1.0 - b); }
vec3 blendOverlay(vec3 a, vec3 b) { return mix(2.0 * a * b, 1.0 - 2.0 * (1.0 - a) * (1.0 - b), step(0.5, a)); }
vec3 blendSoftLight(vec3 a, vec3 b) { return mix(2.0 * a * b + a * a * (1.0 - 2.0 * b), sqrt(max(a, 0.0)) * (2.0 * b - 1.0) + 2.0 * a * (1.0 - b), step(0.5, b)); }
vec3 blendHardLight(vec3 a, vec3 b) { return blendOverlay(b, a); }
vec3 blendColorDodge(vec3 a, vec3 b) { return min(a / max(1.0 - b, 1e-4), 1.0); }
vec3 blendColorBurn(vec3 a, vec3 b) { return 1.0 - min((1.0 - a) / max(b, 1e-4), 1.0); }
vec3 blendLinearLight(vec3 a, vec3 b) { return a + 2.0 * b - 1.0; }

// --- sampling helpers -----------------------------------------------------
/** Sample with clamp-to-edge regardless of the wrap mode. */
vec4 texClamp(sampler2D t, vec2 uv) { return texture(t, clamp(uv, vec2(0.0), vec2(1.0))); }
/** Read exact texel by integer pixel coordinate (clamped). */
vec4 texel(sampler2D t, ivec2 p) { ivec2 s = textureSize(t, 0); return texelFetch(t, clamp(p, ivec2(0), s - 1), 0); }
/** Current output pixel coordinate (integer-ish, origin top-left). */
vec2 pixelCoord() { return v_uv * u_resolution; }
`;
