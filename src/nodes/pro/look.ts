/**
 * LUT workflow nodes: Hald CLUT (apply a .png Hald colour lookup image, or output an identity Hald to
 * grade elsewhere) and Look (a pack of original, procedurally defined film-ish looks — no third-party
 * LUT data). Both are per-pixel, so they bake into File › Export LUT.
 */
import { defineNode } from '../../core/registry';
import type { CpuContext, NodeDef, PassContext, RawTex } from '../../core/types';
import { cubeToAtlas, type CubeLut } from '../library/shared';

const C = '#5b8fb9';

/** Trilinear lookup in a cubeToAtlas() atlas (u_lut: N² × N, x = r + b·N, y = g). */
const GLSL_ATLAS = /* glsl */ `
vec3 sampleAtlas(vec3 c) {
  float N = u_lut_size.y;
  vec3 x = clamp(c, 0.0, 1.0) * (N - 1.0);
  float b0 = floor(x.b), b1 = min(b0 + 1.0, N - 1.0), fb = x.b - b0;
  vec2 inSlice = vec2(x.r + 0.5, x.g + 0.5);
  vec2 W = vec2(N * N, N);
  return mix(texture(u_lut, (inSlice + vec2(b0 * N, 0.0)) / W).rgb, texture(u_lut, (inSlice + vec2(b1 * N, 0.0)) / W).rgb, fb);
}`;

/** Hald level L ⇒ cube size L², image L³ × L³; entry i = r + g·N + b·N² in reading order. */
export function haldToCube(px: Uint8ClampedArray | Float32Array, side: number, scale = 255): CubeLut {
  const L = Math.round(Math.cbrt(side));
  if (L * L * L !== side) throw new Error(`Hald CLUT: ${side}×${side} is not a Hald image (side must be L³, e.g. 512 for level 8)`);
  const N = L * L;
  const data = new Float32Array(N * N * N * 3);
  for (let i = 0; i < N * N * N; i++) {
    data[i * 3] = px[i * 4] / scale;
    data[i * 3 + 1] = px[i * 4 + 1] / scale;
    data[i * 3 + 2] = px[i * 4 + 2] / scale;
  }
  return { size: N, data, domainMin: [0, 0, 0], domainMax: [1, 1, 1] };
}

/** Identity Hald image of level L (RGBA8). */
export function identityHald(L: number): RawTex {
  const N = L * L, side = L * L * L;
  const data = new Uint8Array(side * side * 4);
  for (let i = 0; i < N * N * N; i++) {
    const r = i % N, g = Math.floor(i / N) % N, b = Math.floor(i / (N * N));
    data.set([Math.round((r / (N - 1)) * 255), Math.round((g / (N - 1)) * 255), Math.round((b / (N - 1)) * 255), 255], i * 4);
  }
  return { width: side, height: side, data };
}

const haldLevel = (p: CpuContext['params']) => Math.min(16, Math.max(2, Math.round(Number(p.level) || 8)));

const hald = defineNode({
  id: 'pro.haldClut',
  name: 'Hald CLUT',
  category: 'Color Management',
  color: C,
  colorOnly: true,
  description:
    'Applies a Hald CLUT — a colour lookup table stored as a square PNG (level 8 = 512×512, 64³ entries) as used by G\'MIC, RawTherapee, darktable and many free film-emulation packs — with trilinear interpolation. ' +
    'Turn on "Output identity Hald" to get a neutral Hald image instead: export it, grade it in any editor, and load the result back here. For .cube files use LUT (.cube).',
  tags: ['hald', 'clut', 'lut', 'png lut', 'film emulation', 'look', 'grade', 'gmic', 'rawtherapee'],
  inputs: { image: { type: 'image' } },
  params: {
    clut: { type: 'asset', default: '', accept: 'image/png,image/*', label: 'Hald image' },
    amount: { type: 'float', default: 1, min: 0, max: 1, step: 0.01, label: 'Amount' },
    identity: { type: 'bool', default: false, label: 'Output identity Hald' },
    level: { type: 'int', default: 8, min: 2, max: 16, step: 1, label: 'Identity level', description: 'Level of the identity image (8 → 512×512).' },
  },
  size: ({ params, inputSizes, projectSize }) => {
    if (params.identity) { const s = haldLevel(params) ** 3; return [s, s]; }
    const s = inputSizes.image ?? projectSize;
    return [s.width, s.height];
  },
  cpu: (ctx) => {
    const out: Record<string, RawTex> = {};
    out.ident = ctx.params.identity ? { ...identityHald(haldLevel(ctx.params)), filter: 'nearest' } : { width: 1, height: 1, data: new Uint8Array(4) };
    const a = ctx.getAsset(String(ctx.params.clut ?? ''));
    if (!a?.image) {
      out.lut = { width: 1, height: 1, data: new Float32Array([0, 0, 0, 1]) };
      return out;
    }
    const side = a.image.width;
    if (a.image.height !== side) throw new Error('Hald CLUT: the image must be square');
    const cv = new OffscreenCanvas(side, side);
    const g = cv.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(a.image, 0, 0);
    out.lut = cubeToAtlas(haldToCube(g.getImageData(0, 0, side, side).data, side));
    return out;
  },
  passes: [{
    frag: /* glsl */ `
${GLSL_ATLAS}
void main() {
  if (u_identity) { fragColor = texture(u_ident, v_uv); return; }
  vec4 c = texture(u_image, v_uv);
  if (u_lut_size.x < 2.0) { fragColor = c; return; }
  fragColor = vec4(mix(c.rgb, sampleAtlas(c.rgb), u_amount), c.a);
}`,
  }],
});

// ---------------------------------------------------------------------------
// Look pack (original procedural grades)
// ---------------------------------------------------------------------------
interface Look {
  exposure?: number;
  lift?: number[]; gamma?: number[]; gain?: number[];
  contrast?: number;
  saturation?: number;
  shadowTint?: number[]; highlightTint?: number[];
  tealOrange?: number;
  bleach?: number;
  black?: number; white?: number;
  mono?: number; monoWeights?: number[];
  highlightDesat?: number;
}

/** The looks. Values were tuned by eye on the bundled samples; none is derived from a commercial LUT. */
export const LOOKS: Record<string, Look> = {
  'Teal & Orange': { contrast: 0.25, saturation: 1.15, tealOrange: 0.75, shadowTint: [-0.04, 0.02, 0.05], highlightTint: [0.05, 0.015, -0.04], gamma: [1, 1, 1.02] },
  'Bleach Bypass': { bleach: 0.55, saturation: 0.5, contrast: 0.12, gamma: [1.06, 1.06, 1.06], black: 0.02, white: 0.96, highlightDesat: 0.3 },
  'Kodachrome-ish': { contrast: 0.28, saturation: 1.22, lift: [0.0, -0.01, -0.01], gamma: [1.03, 1.0, 0.97], gain: [1.03, 1.0, 0.98], shadowTint: [0.0, -0.005, 0.03], highlightTint: [0.02, 0.008, -0.015], black: 0.015 },
  'Cross Cool': { contrast: 0.3, saturation: 1.05, gamma: [0.94, 1.04, 1.06], gain: [0.97, 1.02, 0.96], lift: [-0.02, 0.0, 0.05], shadowTint: [-0.02, 0.0, 0.05], highlightTint: [0.0, 0.02, -0.025] },
  'Faded Matte': { contrast: -0.1, saturation: 0.75, black: 0.11, white: 0.93, shadowTint: [0.02, 0.01, 0.03], highlightTint: [0.025, 0.015, -0.01], gamma: [1.02, 1.0, 0.98] },
  'Day for Night': { exposure: -1.9, saturation: 0.45, gain: [0.75, 0.92, 1.25], lift: [0.0, 0.005, 0.03], contrast: 0.25, highlightDesat: 0.6, highlightTint: [-0.02, 0.0, 0.04] },
  'Golden Hour': { exposure: 0.05, saturation: 1.08, gain: [1.05, 1.0, 0.92], gamma: [1.04, 1.0, 0.97], highlightTint: [0.025, 0.012, -0.015], shadowTint: [0.015, 0.0, -0.01], contrast: 0.1 },
  'Nordic Cold': { saturation: 0.7, gain: [0.94, 1.0, 1.06], gamma: [0.97, 1.0, 1.03], shadowTint: [-0.02, 0.0, 0.025], contrast: 0.12, black: 0.03, highlightDesat: 0.3 },
  'Noir (red filter)': { mono: 1, monoWeights: [0.75, 0.25, 0.0], contrast: 0.55, black: 0.0, gamma: [1.05, 1.05, 1.05] },
};
export const LOOK_NAMES = Object.keys(LOOKS);

function lookUniforms(ctx: PassContext) {
  const L = LOOKS[String(ctx.params.look)] ?? LOOKS[LOOK_NAMES[0]];
  return {
    u_L_exposure: L.exposure ?? 0,
    u_L_lift: L.lift ?? [0, 0, 0],
    u_L_gamma: L.gamma ?? [1, 1, 1],
    u_L_gain: L.gain ?? [1, 1, 1],
    u_L_contrast: L.contrast ?? 0,
    u_L_sat: L.saturation ?? 1,
    u_L_shadowTint: L.shadowTint ?? [0, 0, 0],
    u_L_highlightTint: L.highlightTint ?? [0, 0, 0],
    u_L_tealOrange: L.tealOrange ?? 0,
    u_L_bleach: L.bleach ?? 0,
    u_L_black: L.black ?? 0,
    u_L_white: L.white ?? 1,
    u_L_mono: L.mono ?? 0,
    u_L_monoW: L.monoWeights ?? [0.2126, 0.7152, 0.0722],
    u_L_hiDesat: L.highlightDesat ?? 0,
  };
}

const look = defineNode({
  id: 'pro.look',
  name: 'Look',
  category: 'Color Management',
  color: C,
  colorOnly: true,
  description:
    'A pack of original film / cinema looks, defined procedurally (lift-gamma-gain, contrast, split toning, hue warps, bleach bypass, fades): Teal & Orange, Bleach Bypass, Kodachrome-ish, ' +
    'Cross Cool, Faded Matte, Day for Night, Golden Hour, Nordic Cold and Noir (red filter). Amount blends with the original; Intensity exaggerates or tones down the look itself. ' +
    'Per-pixel, so a graded chain can be exported with File › Export LUT.',
  tags: ['look', 'lut', 'film', 'cinematic', 'teal orange', 'bleach bypass', 'kodachrome', 'cross process', 'fade', 'matte', 'day for night', 'noir', 'grade', 'preset'],
  inputs: { image: { type: 'image' } },
  params: {
    look: { type: 'enum', default: 'Teal & Orange', options: LOOK_NAMES, label: 'Look' },
    intensity: { type: 'float', default: 1, min: 0, max: 2, step: 0.01, label: 'Intensity' },
    amount: { type: 'float', default: 1, min: 0, max: 1, step: 0.01, label: 'Amount' },
  },
  passes: [{
    uniforms: lookUniforms,
    frag: /* glsl */ `
uniform float u_L_exposure, u_L_contrast, u_L_sat, u_L_tealOrange, u_L_bleach, u_L_black, u_L_white, u_L_mono, u_L_hiDesat;
uniform vec3 u_L_lift, u_L_gamma, u_L_gain, u_L_shadowTint, u_L_highlightTint, u_L_monoW;
float hueDist(float a, float b) { float d = abs(a - b); return min(d, 1.0 - d); }
vec3 grade(vec3 c, float k) {
  // exposure in linear light
  c = linearToSrgb(srgbToLinear(max(c, 0.0)) * exp2(u_L_exposure * k));
  // monochrome (channel-weighted, like a filter on B&W film)
  float m = dot(c, u_L_monoW / max(dot(u_L_monoW, vec3(1.0)), 1e-4));
  c = mix(c, vec3(m), u_L_mono * min(k, 1.0));
  // lift / gamma / gain (ASC-CDL-like, per channel)
  vec3 lift = u_L_lift * k, gain = mix(vec3(1.0), u_L_gain, k), gam = mix(vec3(1.0), u_L_gamma, k);
  c = c * gain + lift * (1.0 - c);
  c = pow(max(c, 0.0), 1.0 / gam);
  // teal & orange: pull warm hues toward amber-skin, the rest toward teal
  if (u_L_tealOrange > 0.0) {
    vec3 h = rgb2hsv(clamp(c, 0.0, 1.0));
    float warm = 1.0 - smoothstep(0.08, 0.16, hueDist(h.x, 0.07));
    float target = warm > 0.5 ? 0.075 : 0.5;
    float d = target - h.x;
    d -= floor(d + 0.5); // shortest way round
    float t = u_L_tealOrange * k * smoothstep(0.05, 0.3, h.y) * (warm > 0.5 ? 0.5 : 0.35);
    h.x = fract(h.x + d * t);
    c = hsv2rgb(h);
  }
  // contrast: S-curve around mid grey
  float ct = u_L_contrast * k;
  if (ct > 0.0) c += ct * 1.4 * (c - 0.5) * (1.0 - abs(2.0 * clamp(c, 0.0, 1.0) - 1.0));
  else c = mix(c, vec3(0.5), -ct * 0.6);
  // bleach bypass: overlay the luminance (silver retained) and desaturate
  if (u_L_bleach > 0.0) {
    float l = luma(clamp(c, 0.0, 1.0));
    vec3 ov = blendOverlay(vec3(l), clamp(c, 0.0, 1.0));
    c = mix(c, ov, u_L_bleach * min(k, 1.0));
  }
  // split toning by luminance
  float l = clamp(luma(c), 0.0, 1.0);
  c += u_L_shadowTint * k * (1.0 - l) * (1.0 - l) * 1.6 + u_L_highlightTint * k * l * (1.0 - 0.5 * l) * 1.6;
  // saturation (+ optional highlight desaturation)
  float Y = luma(c);
  float s = mix(1.0, u_L_sat, k) * (1.0 - u_L_hiDesat * min(k, 1.0) * smoothstep(0.55, 1.0, Y));
  c = mix(vec3(Y), c, s);
  // fade: black / white point
  float kb = min(k, 1.5);
  return mix(vec3(u_L_black * kb), vec3(1.0 - (1.0 - u_L_white) * kb), clamp(c, 0.0, 1.0));
}
void main() {
  vec4 src = texture(u_image, v_uv);
  vec3 g = grade(src.rgb, u_intensity);
  fragColor = vec4(mix(src.rgb, g, u_amount), src.a);
}`,
  }],
});

export default [hald, look] satisfies NodeDef[];
