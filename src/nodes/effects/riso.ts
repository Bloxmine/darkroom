/**
 * Risograph: spot-colour stencil printing. One combined multi-layer node (separation by
 * ink unmixing + per-layer screens/misregistration) and a single-layer node for remixing.
 */
import { defineNode } from '../../core/registry';
import type { NodeDef, ParamDef, Params, PassContext } from '../../core/types';
import { colorParam, FE, hex, num } from './_shared';

const C = '#ff48b0';

/** Real Riso ink colours (RISO Kagaku / riso-colors references). */
export const RISO_INKS: [string, string][] = [
  ['Fluorescent Pink', '#FF48B0'],
  ['Blue', '#0078BF'],
  ['Yellow', '#FFE800'],
  ['Teal', '#00838A'],
  ['Orange', '#FF6C2F'],
  ['Red', '#FF665E'],
  ['Green', '#00A95C'],
  ['Purple', '#765BA7'],
  ['Black', '#000000'],
  ['Bright Red', '#F15060'],
  ['Federal Blue', '#3D5588'],
  ['Metallic Gold', '#AC936E'],
  ['Medium Blue', '#3255A4'],
  ['Burgundy', '#914E72'],
  ['Sunflower', '#FFB511'],
  ['Aqua', '#5EC8E5'],
  ['Mint', '#82D8D5'],
  ['Fluorescent Orange', '#FF7477'],
  ['Fluorescent Red', '#FF4C65'],
  ['Fluorescent Green', '#44D62C'],
  ['Hunter Green', '#407060'],
  ['Violet', '#9D7AD2'],
  ['Cornflower', '#62A8E5'],
  ['Brown', '#925F52'],
  ['Light Gray', '#88898A'],
  ['Flat Gold', '#BB8B41'],
];
export const INK_OPTIONS = [...RISO_INKS.map(([n]) => n), 'Custom'];

export function inkRgb(params: Params, inkKey: string, customKey: string): number[] {
  const name = String(params[inkKey] ?? '');
  const found = RISO_INKS.find(([n]) => n === name);
  if (found) return hex(found[1]);
  return colorParam(params, customKey, [0.2, 0.2, 0.2]).slice(0, 3);
}

const SCREENS = ['Grain touch', 'Halftone dots', 'Line screen', 'Solid (no screen)'];

/** GLSL shared by both riso nodes. */
const RISO_GLSL = /* glsl */ `
// Ink mask (0..1) for coverage a at layer-space full-res point q.
float risoScreen(float a, vec2 q, int mode, float cellPx, float grainPx, float ang, float spread, float seed) {
  float aaPx = 1.0 / u_scale; // full-res px per output px
  a = clamp(a, 0.0, 1.0);
  a = clamp(a + spread * 0.18 * a * (1.0 - a), 0.0, 1.0); // dot gain
  if (mode == 3) return a;
  if (mode == 0) { // grain touch: blobby stochastic (FM) screen; gaussian field -> ~uniform threshold
    float g = max(grainPx, 0.3);
    vec2 r = rot2(ang) * q / g;
    float x = 0.9 * gnoise(r + seed) + 0.44 * gnoise(r * 2.1 + seed * 1.3 + 41.0);
    x += spread * 0.35 * gnoise(r * 3.7 + seed * 2.1);
    float t = 1.0 / (1.0 + exp(-1.702 * x));
    float w = max(fwidth(t) * 0.7, 1e-3);
    return smoothstep(t - w, t + w, a * 1.04 - 0.02);
  }
  float cell = max(cellPx, 1.0);
  vec2 r = rot2(ang) * q / cell;
  float spot;
  if (mode == 1) {
    vec2 f = fract(r) - 0.5;
    spot = 0.5 - 0.25 * (cos(TAU * f.x) + cos(TAU * f.y));
  } else {
    spot = 0.5 - 0.5 * cos(TAU * r.y);
  }
  spot += spread * 0.07 * gnoise(q * 0.9 + seed * 5.0) + 0.02 * gnoise(q * 2.3 + seed);
  float w = max(fwidth(spot) * 0.8, 1e-3);
  float m = smoothstep(spot - w, spot + w, a * 1.02 - 0.01);
  float k = clamp(cell / aaPx / 2.5 - 0.3, 0.0, 1.0); // screens finer than the preview pixel average out
  return mix(a, m, k);
}
// Ink density multiplier: uneven coverage, roller banding, starvation streaks, skipped paper tooth.
float inkTex(vec2 p, float seed, float uneven, float banding) {
  float low = fbm(p / 260.0 + seed * 1.7, 3);
  float d = 1.0 - uneven * 0.6 * smoothstep(0.3, 0.75, low);
  float band = gnoiseX(p.y / 90.0, seed * 3.1) * 0.6 + gnoiseX(p.y / 11.0, seed * 3.1 + 5.0) * 0.3;
  d *= 1.0 - banding * 0.22 * (0.5 + 0.5 * clamp(band, -1.0, 1.0));
  float streak = gnoiseX(p.x / 2.5, seed * 3.1 + 11.0) * 0.7 + gnoiseX(p.x / 40.0, seed * 3.1 + 13.0) * 0.5;
  d *= 1.0 - banding * 0.18 * smoothstep(0.7, 1.8, streak);
  float sp = gnoise(p * 0.6 + seed * 5.0) + 0.6 * gnoise(p * 0.21 + seed * 2.0);
  d *= 1.0 - uneven * 0.85 * smoothstep(1.2, 2.3, sp);
  return clamp(d, 0.0, 1.0);
}
vec2 misreg(vec2 P, vec2 centre, vec2 off, float rotDeg) {
  return rot2(-radians(rotDeg)) * (P - centre) + centre - off;
}
float covSample(sampler2D s, vec2 q, int ch) {
  vec2 uv = fullToUv(q); // pass0 has the output size
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 0.0;
  vec4 v = texture(s, uv);
  return ch == 0 ? v.r : ch == 1 ? v.g : ch == 2 ? v.b : v.a;
}
// Coverage pre-filtered at the screen scale (halftone dots read the local tone).
float covScreen(sampler2D s, vec2 q, int ch, int mode, float cellPx, float grainPx) {
  float r = mode == 1 || mode == 2 ? cellPx * 0.3 : grainPx * 0.5;
  float c = covSample(s, q, ch) * 2.0;
  c += covSample(s, q + vec2(r, 0.0), ch) + covSample(s, q - vec2(r, 0.0), ch);
  c += covSample(s, q + vec2(0.0, r), ch) + covSample(s, q - vec2(0.0, r), ch);
  return c / 6.0;
}
`;

const inkParam = (n: number, def: string): ParamDef => ({ type: 'enum', default: def, options: INK_OPTIONS, label: `Ink ${n}`, description: 'Riso drum colour.' });
const customParam = (n: number, def: number[]): ParamDef => ({ type: 'color', default: def, label: `Custom colour ${n}`, description: 'Used when the ink is set to Custom.' });

function layerParams(n: number, ink: string, off: [number, number], rot: number, angle: number, custom: number[]): Record<string, ParamDef> {
  return {
    [`ink${n}`]: inkParam(n, ink),
    [`custom${n}`]: customParam(n, custom),
    [`density${n}`]: { type: 'float', default: 0.95, min: 0, max: 1.5, step: 0.01, label: `Ink ${n} density` },
    [`offset${n}X`]: { type: 'float', default: off[0], min: -100, max: 100, step: 0.5, pixels: true, label: `Ink ${n} offset X`, description: 'Misregistration of this drum, full-res px.' },
    [`offset${n}Y`]: { type: 'float', default: off[1], min: -100, max: 100, step: 0.5, pixels: true, label: `Ink ${n} offset Y` },
    [`rotate${n}`]: { type: 'float', default: rot, min: -5, max: 5, step: 0.01, label: `Ink ${n} skew (°)`, description: 'Small rotation of the sheet as this drum printed it.' },
    [`angle${n}`]: { type: 'float', default: angle, min: -90, max: 90, step: 1, label: `Ink ${n} screen angle` },
  };
}

const MAXL = 4;

const risograph = defineNode({
  id: 'effects.risograph',
  name: 'Risograph',
  category: 'Print',
  color: C,
  description:
    'Multi-drum Risograph print. The image is separated into 1–4 spot inks by unmixing it against the chosen ink colours (or by luma), ' +
    'each layer is screened (grain touch stochastic screen, halftone dots or lines), misregistered per drum, and overprinted with semi-transparent ' +
    'multiplying inks on textured paper with uneven coverage and roller banding.',
  tags: ['riso', 'risograph', 'print', 'zine', 'duotone', 'spot colour', 'halftone', 'grain', 'fluorescent', 'stencil'],
  inputs: { image: { type: 'image' } },
  params: {
    layers: { type: 'int', default: 2, min: 1, max: 4, step: 1, label: 'Ink layers', description: 'Number of drums (1–4).' },
    separation: { type: 'enum', default: 'Auto (ink unmixing)', options: ['Auto (ink unmixing)', 'Luma (all inks)', 'Luma split (darks / mids / lights)'], label: 'Separation', description: 'Auto finds how much of each ink reproduces each colour. Luma prints the same tone through every drum. Luma split gives each drum a tonal band.' },
    brightness: { type: 'float', default: 0, min: -1, max: 1, step: 0.01, label: 'Brightness' },
    contrast: { type: 'float', default: 1.15, min: 0, max: 3, step: 0.01, label: 'Contrast' },
    gamma: { type: 'float', default: 1, min: 0.2, max: 3, step: 0.01, label: 'Coverage gamma', description: '>1 = less ink in the midtones.' },
    screen: { type: 'enum', default: 'Grain touch', options: SCREENS, label: 'Screen' },
    cellSize: { type: 'float', default: 7, min: 2, max: 60, step: 0.5, pixels: true, label: 'Halftone cell', description: 'Halftone / line cell in full-res px (≈ 600 dpi ÷ LPI).' },
    grainSize: { type: 'float', default: 2.4, min: 0.5, max: 12, step: 0.1, pixels: true, label: 'Grain size', description: 'Grain-touch dot size in full-res px.' },
    misregister: { type: 'float', default: 1, min: 0, max: 4, step: 0.01, label: 'Misregistration', description: 'Multiplies every drum offset and skew.' },
    spread: { type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Ink spread', description: 'Dot gain and rough, bleeding dot edges.' },
    uneven: { type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Uneven ink', description: 'Blotchy coverage and paper tooth showing through solids.' },
    banding: { type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Roller banding' },
    paper: { type: 'color', default: [0.96, 0.94, 0.89, 1], label: 'Paper' },
    paperTexture: { type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Paper texture' },
    seed: { type: 'int', default: 7, min: 0, max: 9999, step: 1, label: 'Seed' },
    ...layerParams(1, 'Blue', [0, 0], 0, 15, [0.24, 0.33, 0.53, 1]),
    ...layerParams(2, 'Fluorescent Pink', [5, -3], 0.12, 75, [1, 0.28, 0.69, 1]),
    ...layerParams(3, 'Yellow', [-3, 4], -0.08, 0, [1, 0.91, 0, 1]),
    ...layerParams(4, 'Black', [2, 2], 0.05, 45, [0, 0, 0, 1]),
  },
  passes: [
    { // 0: separation -> coverage per layer in rgba
      uniforms: (c: PassContext) => sepUniforms(c),
      frag: FE(RISO_GLSL + `
uniform vec3 u_inkc[4];
uniform int u_n;
void main() {
  vec3 c = texture(u_image, v_uv).rgb;
  c = clamp((c - 0.5) * u_contrast + 0.5 + u_brightness, 0.0, 1.0);
  vec4 a = vec4(0.0);
  int n = clamp(u_n, 1, 4);
  if (u_separation == 0) {
    for (int it = 0; it < 16; it++) {
      for (int i = 0; i < 4; i++) {
        if (i >= n) break;
        vec3 prod = vec3(1.0);
        for (int j = 0; j < 4; j++) { if (j >= n) break; if (j != i) prod *= 1.0 - a[j] * (1.0 - u_inkc[j]); }
        vec3 tgt = c / max(prod, vec3(0.03));
        vec3 k = 1.0 - u_inkc[i];
        a[i] = clamp(dot(1.0 - tgt, k) / (dot(k, k) + 1e-3), 0.0, 1.0);
      }
    }
  } else if (u_separation == 1) {
    float d = 1.0 - luma(c);
    a = vec4(d);
  } else {
    float d = 1.0 - luma(c);
    for (int i = 0; i < 4; i++) {
      if (i >= n) break;
      // drum i covers the tonal band starting at i/n (darkest drum = last)
      float lo = float(i) / float(n);
      a[i] = smoothstep(lo, lo + 1.0 / float(n) + 0.15, d);
    }
  }
  a = pow(clamp((a - 0.04) / 0.94, 0.0, 1.0), vec4(u_gamma));
  fragColor = a;
}`),
    },
    { // 1: screen + print
      uniforms: (c: PassContext) => sepUniforms(c),
      frag: FE(RISO_GLSL + `
uniform vec3 u_inkc[4];
uniform vec2 u_off[4];
uniform float u_rot[4];
uniform float u_ang[4];
uniform float u_dens[4];
uniform int u_n;
void main() {
  vec2 P = fullPx();
  vec2 centre = u_resolution / u_scale * 0.5;
  float sd = float(u_seed);
  vec3 col = u_paper.rgb;
  float pt = paperTex(P, sd);
  int n = clamp(u_n, 1, 4);
  for (int i = 0; i < 4; i++) {
    if (i >= n) break;
    vec2 q = misreg(P, centre, u_off[i] * u_misregister, u_rot[i] * u_misregister);
    float cov = covScreen(u_pass0, q, i, u_screen, u_cellSize, u_grainSize);
    float lsd = sd * 13.7 + float(i) * 101.3;
    float m = risoScreen(cov, q, u_screen, u_cellSize, u_grainSize, radians(u_ang[i]), u_spread, lsd);
    float d = u_dens[i] * inkTex(q, lsd, u_uneven, u_banding);
    d *= 1.0 - u_paperTexture * 0.25 * smoothstep(0.2, 0.9, pt);
    col *= mix(vec3(1.0), u_inkc[i], clamp(m * d, 0.0, 1.0));
  }
  col *= 1.0 + u_paperTexture * 0.045 * pt;
  fragColor = vec4(clamp(col, 0.0, 1.0), texture(u_image, v_uv).a);
}`),
    },
  ],
});

function sepUniforms(c: PassContext) {
  const p = c.params;
  const inks: number[] = [], off: number[] = [], rot: number[] = [], ang: number[] = [], dens: number[] = [];
  for (let i = 1; i <= MAXL; i++) {
    inks.push(...inkRgb(p, `ink${i}`, `custom${i}`));
    off.push(num(p, `offset${i}X`, 0), num(p, `offset${i}Y`, 0));
    rot.push(num(p, `rotate${i}`, 0));
    ang.push(num(p, `angle${i}`, 0));
    dens.push(num(p, `density${i}`, 1));
  }
  return { u_inkc: inks, u_off: off, u_rot: rot, u_ang: ang, u_dens: dens, u_n: Math.round(num(p, 'layers', 2)) };
}

const SEPARATIONS = ['Luma (darks)', 'Luma (lights)', 'Cyan', 'Magenta', 'Yellow', 'Black (K)', 'Ink projection', 'Colour key'];

const risoLayer = defineNode({
  id: 'effects.risoLayer',
  name: 'Riso Layer',
  category: 'Print',
  color: C,
  description:
    'One Risograph drum. Separates the image into a single spot ink (luma, CMYK channel, projection onto the ink colour or a colour key), ' +
    'applies levels, screens it, misregisters it and multiplies the ink onto `Under` (a previous Riso Layer) or onto blank paper. Chain several to build custom riso stacks.',
  tags: ['riso', 'risograph', 'print', 'spot colour', 'layer', 'separation', 'zine'],
  inputs: {
    image: { type: 'image', label: 'Image' },
    under: { type: 'image', optional: true, fallback: 'transparent', label: 'Under (previous print)' },
  },
  params: {
    ink: { type: 'enum', default: 'Fluorescent Pink', options: INK_OPTIONS, label: 'Ink' },
    custom: { type: 'color', default: [0.9, 0.3, 0.5, 1], label: 'Custom colour' },
    separation: { type: 'enum', default: 'Luma (darks)', options: SEPARATIONS, label: 'Separation', description: 'What decides where ink goes.' },
    keyColor: { type: 'color', default: [0.85, 0.2, 0.2, 1], label: 'Key colour', description: 'For Colour key: ink goes where the image is close to this colour.' },
    tolerance: { type: 'float', default: 0.25, min: 0.01, max: 1, step: 0.01, label: 'Key tolerance' },
    invert: { type: 'bool', default: false, label: 'Invert separation' },
    low: { type: 'float', default: 0.05, min: 0, max: 1, step: 0.01, label: 'Levels: low', description: 'Coverage below this prints nothing.' },
    high: { type: 'float', default: 0.95, min: 0, max: 1, step: 0.01, label: 'Levels: high', description: 'Coverage above this prints solid.' },
    gamma: { type: 'float', default: 1, min: 0.2, max: 3, step: 0.01, label: 'Levels: gamma' },
    screen: { type: 'enum', default: 'Grain touch', options: SCREENS, label: 'Screen' },
    cellSize: { type: 'float', default: 7, min: 2, max: 60, step: 0.5, pixels: true, label: 'Halftone cell' },
    grainSize: { type: 'float', default: 2.4, min: 0.5, max: 12, step: 0.1, pixels: true, label: 'Grain size' },
    angle: { type: 'float', default: 15, min: -90, max: 90, step: 1, label: 'Screen angle' },
    offsetX: { type: 'float', default: 3, min: -100, max: 100, step: 0.5, pixels: true, label: 'Offset X' },
    offsetY: { type: 'float', default: -2, min: -100, max: 100, step: 0.5, pixels: true, label: 'Offset Y' },
    rotate: { type: 'float', default: 0.1, min: -5, max: 5, step: 0.01, label: 'Skew (°)' },
    density: { type: 'float', default: 0.95, min: 0, max: 1.5, step: 0.01, label: 'Ink density' },
    spread: { type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Ink spread' },
    uneven: { type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Uneven ink' },
    banding: { type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Roller banding' },
    paper: { type: 'color', default: [0.96, 0.94, 0.89, 1], label: 'Paper (if nothing under)' },
    paperTexture: { type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Paper texture' },
    seed: { type: 'int', default: 3, min: 0, max: 9999, step: 1, label: 'Seed' },
  },
  passes: [
    {
      uniforms: (c) => ({ u_inkc: inkRgb(c.params, 'ink', 'custom') }),
      frag: FE(`
uniform vec3 u_inkc;
void main() {
  vec3 c = clamp(texture(u_image, v_uv).rgb, 0.0, 1.0);
  float a;
  vec3 cmy = 1.0 - c;
  float k = min(cmy.x, min(cmy.y, cmy.z));
  if (u_separation == 0) a = 1.0 - luma(c);
  else if (u_separation == 1) a = luma(c);
  else if (u_separation == 2) a = (cmy.x - k) / max(1.0 - k, 1e-3);
  else if (u_separation == 3) a = (cmy.y - k) / max(1.0 - k, 1e-3);
  else if (u_separation == 4) a = (cmy.z - k) / max(1.0 - k, 1e-3);
  else if (u_separation == 5) a = k;
  else if (u_separation == 6) { vec3 kk = 1.0 - u_inkc; a = dot(cmy, kk) / (dot(kk, kk) + 1e-3); }
  else { float d = distance(rgb2oklab(c), rgb2oklab(u_keyColor.rgb)); a = 1.0 - smoothstep(u_tolerance * 0.3, u_tolerance, d); }
  a = clamp(a, 0.0, 1.0);
  if (u_invert) a = 1.0 - a;
  a = pow(clamp((a - u_low) / max(u_high - u_low, 1e-3), 0.0, 1.0), u_gamma);
  fragColor = vec4(a, a, a, 1.0);
}`),
    },
    {
      uniforms: (c) => ({ u_inkc: inkRgb(c.params, 'ink', 'custom') }),
      frag: FE(RISO_GLSL + `
uniform vec3 u_inkc;
void main() {
  vec2 P = fullPx();
  vec2 centre = u_resolution / u_scale * 0.5;
  float sd = float(u_seed) * 13.7 + 5.0;
  vec4 under = texture(u_under, v_uv);
  bool hasUnder = u_under_size.x > 1.5 || u_under_size.y > 1.5;
  vec3 col = hasUnder ? under.rgb : u_paper.rgb;
  vec2 q = misreg(P, centre, vec2(u_offsetX, u_offsetY), u_rotate);
  float cov = covScreen(u_pass0, q, 0, u_screen, u_cellSize, u_grainSize);
  float m = risoScreen(cov, q, u_screen, u_cellSize, u_grainSize, radians(u_angle), u_spread, sd);
  float pt = paperTex(P, float(u_seed));
  float d = u_density * inkTex(q, sd, u_uneven, u_banding);
  d *= 1.0 - u_paperTexture * 0.25 * smoothstep(0.2, 0.9, pt);
  col *= mix(vec3(1.0), u_inkc, clamp(m * d, 0.0, 1.0));
  if (!hasUnder) col *= 1.0 + u_paperTexture * 0.045 * pt;
  fragColor = vec4(clamp(col, 0.0, 1.0), hasUnder ? max(under.a, texture(u_image, v_uv).a) : texture(u_image, v_uv).a);
}`),
    },
  ],
});

export default [risograph, risoLayer] satisfies NodeDef[];
