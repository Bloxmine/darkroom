/**
 * GLSL snippets for the pro colour nodes (tone curves, transfer functions). The JS mirrors in
 * color-math.ts are what the unit tests check; keep the constants identical.
 */
import type { NodeDef } from '../../core/types';

export default [] as NodeDef[];

/** Transfer functions by id index (see TRANSFER_IDS in color-math.ts): 0 sRGB, 1 linear, 2 γ2.2, 3 Adobe, 4 ProPhoto, 5 BT.1886. */
export const GLSL_TRANSFER = /* glsl */ `
vec3 trDecode(vec3 v, int t) {
  vec3 s = sign(v), a = abs(v);
  if (t == 0) return s * mix(a / 12.92, pow((a + 0.055) / 1.055, vec3(2.4)), step(0.04045, a));
  if (t == 1) return v;
  if (t == 2) return s * pow(a, vec3(2.2));
  if (t == 3) return s * pow(a, vec3(563.0 / 256.0));
  if (t == 4) return s * mix(a / 16.0, pow(a, vec3(1.8)), step(16.0 / 512.0, a));
  return s * pow(a, vec3(2.4));
}
vec3 trEncode(vec3 v, int t) {
  vec3 s = sign(v), a = abs(v);
  if (t == 0) return s * mix(a * 12.92, 1.055 * pow(a, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, a));
  if (t == 1) return v;
  if (t == 2) return s * pow(a, vec3(1.0 / 2.2));
  if (t == 3) return s * pow(a, vec3(256.0 / 563.0));
  if (t == 4) return s * mix(a * 16.0, pow(a, vec3(1.0 / 1.8)), step(1.0 / 512.0, a));
  return s * pow(a, vec3(1.0 / 2.4));
}`;

/**
 * Tone curves on scene-linear Rec.709 input. Each returns DISPLAY-ENCODED values (sRGB-ish) so the
 * node can output them directly; the display-linear operators are encoded with the sRGB OETF.
 */
export const GLSL_TONEMAP = /* glsl */ `
// --- AgX (Troy Sobotka; constants from Blender 4 / Benjamin Wrensch's "AgX minimal") ---
vec3 agxContrastCurve(vec3 x) {
  vec3 x2 = x * x, x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
vec3 tmAgx(vec3 lin, int look) {
  const mat3 agxIn = mat3(0.842479062253094, 0.0423282422610123, 0.0423756549057051,
                          0.0784335999999992, 0.878468636469772, 0.0784336,
                          0.0792237451477643, 0.0791661274605434, 0.879142973793104);
  const mat3 agxOut = mat3(1.19687900512017, -0.0528968517574562, -0.0529716355144438,
                           -0.0980208811401368, 1.15190312990417, -0.0980434501171241,
                           -0.0990297440797205, -0.0989611768448433, 1.15107367264116);
  const float minEv = -12.47393, maxEv = 4.026069;
  vec3 v = agxIn * max(lin, vec3(1e-10));
  v = clamp((log2(max(v, vec3(1e-10))) - minEv) / (maxEv - minEv), 0.0, 1.0);
  v = agxContrastCurve(v);
  // looks (ASC CDL slope/offset/power + saturation), applied in AgX's encoded space
  if (look == 1) { // Punchy
    v = pow(max(v, 0.0), vec3(1.35));
    float l = dot(v, vec3(0.2126, 0.7152, 0.0722));
    v = l + 1.4 * (v - l);
  } else if (look == 2) { // Golden
    v = pow(max(v, 0.0), vec3(1.0, 0.9, 0.5));
    float l = dot(v, vec3(0.2126, 0.7152, 0.0722));
    v = l + 0.8 * (v - l);
  }
  return clamp(agxOut * v, 0.0, 1.0); // already a ~2.2 display encoding
}
// --- ACES: Stephen Hill's fit of the RRT + sRGB ODT (BakingLab) ---
vec3 tmAcesHill(vec3 lin) {
  const mat3 inM = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
  const mat3 outM = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
  vec3 v = inM * lin;
  v = (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.4329510) + 0.238081);
  return linearToSrgb(clamp(outM * v, 0.0, 1.0));
}
// --- ACES: Krzysztof Narkowicz's single-curve fit (input pre-scaled by 0.6) ---
vec3 tmAcesNarkowicz(vec3 x) {
  x *= 0.6;
  return linearToSrgb(clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0));
}
// --- Filmic (Blender-style approximation): log2 −10..+6.5 stops around 0.18, logistic contrast ---
vec3 tmFilmic(vec3 lin, float contrast) {
  vec3 l = clamp((log2(max(lin, vec3(1e-10)) / 0.18) + 10.0) / 16.5, 0.0, 1.0);
  float k = 4.0 + 4.0 * contrast, l0 = 10.0 / 16.5, y0 = 0.46;
  float r = (1.0 - y0) / y0;
  vec3 f = 1.0 / (1.0 + exp(-k * (l - l0)) * r);
  float f0 = 1.0 / (1.0 + exp(k * l0) * r), f1 = 1.0 / (1.0 + exp(-k * (1.0 - l0)) * r);
  return clamp((f - f0) / (f1 - f0), 0.0, 1.0);
}
// --- Reinhard extended (Reinhard et al. 2002, eq. 4) on luminance, white point Lw ---
vec3 tmReinhard(vec3 lin, float Lw) {
  float L = dot(lin, vec3(0.2126, 0.7152, 0.0722));
  float Ld = L * (1.0 + L / (Lw * Lw)) / (1.0 + L);
  vec3 c = lin * (Ld / max(L, 1e-6));
  // above white the hue-preserving scale can leave a channel > 1: bleed it to white
  float m = max(c.r, max(c.g, c.b));
  c = m > 1.0 ? mix(c / m, vec3(1.0), clamp((m - 1.0) / m, 0.0, 1.0)) : c;
  return linearToSrgb(clamp(c, 0.0, 1.0));
}
// --- Uchimura 2017 (Gran Turismo) P=1 a=1 m=0.22 l=0.4 c=1.33 b=0 ---
vec3 tmUchimura(vec3 x) {
  const float P = 1.0, a = 1.0, m = 0.22, l = 0.4, c = 1.33, b = 0.0;
  float l0 = ((P - m) * l) / a;
  float S0 = m + l0, S1 = m + a * l0, C2 = (a * P) / (P - S1), CP = -C2 / P;
  vec3 w0 = 1.0 - smoothstep(0.0, m, x);
  vec3 w2 = step(m + l0, x);
  vec3 w1 = 1.0 - w0 - w2;
  vec3 T = m * pow(max(x, 0.0) / m, vec3(c)) + b;
  vec3 S = P - (P - S1) * exp(CP * (x - S0));
  vec3 L = m + a * (x - m);
  return linearToSrgb(clamp(T * w0 + L * w1 + S * w2, 0.0, 1.0));
}
// --- Hable / Uncharted 2 filmic (John Hable 2010), exposure bias 2, white W ---
vec3 hableF(vec3 x) {
  const float A = 0.15, B = 0.50, C = 0.10, D = 0.20, E = 0.02, F = 0.30;
  return ((x * (A * x + C * B) + D * E) / (x * (A * x + B) + D * F)) - E / F;
}
vec3 tmHable(vec3 lin, float W) {
  return linearToSrgb(clamp(hableF(2.0 * lin) / hableF(vec3(W)), 0.0, 1.0));
}
/** op = index into TONEMAPS (color-math.ts). */
vec3 tonemapOp(vec3 lin, int op, int look, float contrast, float white) {
  lin = max(lin, 0.0);
  if (op == 0) return tmAgx(lin, look);
  if (op == 1) return tmAcesHill(lin);
  if (op == 2) return tmAcesNarkowicz(lin);
  if (op == 3) return tmFilmic(lin, contrast);
  if (op == 4) return tmReinhard(lin, white);
  if (op == 5) return tmUchimura(lin);
  return tmHable(lin, white * 2.8);
}`;
