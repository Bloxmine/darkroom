/** Print processes: screenprint, photocopy, fax. */
import { defineNode } from '../../core/registry';
import type { NodeDef, PassContext } from '../../core/types';
import { blurPass, FE, num } from './_shared';
import { ANIMATE_PARAM, animSeed } from '../../core/motion';

const C = '#ff8a5c';
const img = { image: { type: 'image' as const } };

// ---------------------------------------------------------------------------
// Screenprint
// ---------------------------------------------------------------------------
const screenprint = defineNode({
  id: 'effects.screenprint',
  name: 'Screenprint',
  category: 'Print',
  color: C,
  description:
    'Silkscreen / pop-art print: the image is simplified, split into flat C/M/Y stencil layers (posterised to a few ink strengths) and a black key layer, ' +
    'each pulled with its own misregistration. Inks overprint (multiply), pool slightly at stencil edges and show squeegee streaks.',
  tags: ['silkscreen', 'serigraph', 'pop art', 'warhol', 'poster', 'posterize', 'print', 'misregistration'],
  inputs: img,
  params: {
    simplify: { type: 'float', default: 3, min: 0, max: 30, step: 0.1, pixels: true, label: 'Simplify', description: 'Blur before separation, in full-res px (rounder, more graphic shapes).' },
    levels: { type: 'int', default: 2, min: 1, max: 5, step: 1, label: 'Ink steps', description: 'Ink strengths per colour layer (1 = solid or nothing).' },
    saturation: { type: 'float', default: 1.6, min: 0, max: 4, step: 0.01, label: 'Colour pop' },
    contrast: { type: 'float', default: 1.3, min: 0, max: 3, step: 0.01, label: 'Contrast' },
    keyThreshold: { type: 'float', default: 0.28, min: 0, max: 1, step: 0.01, label: 'Black threshold', description: 'Luma below this prints the black key layer.' },
    keyAmount: { type: 'float', default: 1, min: 0, max: 1, step: 0.01, label: 'Black layer' },
    misregister: { type: 'float', default: 8, min: 0, max: 80, step: 0.5, pixels: true, label: 'Misregistration', description: 'Layer offsets in full-res px.' },
    edge: { type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Ink edges', description: 'Rough stencil edges with darker ink pooling along them.' },
    streaks: { type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, label: 'Squeegee streaks' },
    inkC: { type: 'color', default: [0.0, 0.62, 0.86, 1], label: 'Cyan ink' },
    inkM: { type: 'color', default: [0.93, 0.13, 0.52, 1], label: 'Magenta ink' },
    inkY: { type: 'color', default: [1.0, 0.86, 0.0, 1], label: 'Yellow ink' },
    inkK: { type: 'color', default: [0.08, 0.07, 0.09, 1], label: 'Key ink' },
    paper: { type: 'color', default: [0.97, 0.95, 0.9, 1], label: 'Paper' },
    seed: { type: 'int', default: 11, min: 0, max: 9999, step: 1, label: 'Seed' },
  },
  passes: [
    { frag: FE(`void main(){ vec3 c = texture(u_image, v_uv).rgb; vec3 g = vec3(luma(c)); c = mix(g, c, u_saturation); c = (c - 0.5) * u_contrast + 0.5; fragColor = vec4(clamp(c, 0.0, 1.0), luma(c)); }`) },
    blurPass('x', 'u_simplify * u_scale'),
    blurPass('y', 'u_simplify * u_scale'),
    {
      frag: FE(`
vec4 sepAt(vec2 P, vec2 off) { // full-res point -> cmyk-ish coverage of the simplified image
  vec2 uv = fullToUv(P - off);
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec4(0.0);
  vec4 s = texture(u_pass2, uv);
  vec3 cmy = 1.0 - clamp(s.rgb, 0.0, 1.0);
  float k = min(cmy.x, min(cmy.y, cmy.z));
  return vec4((cmy - k * 0.6), s.a);
}
float layer(float v, vec2 P, float sd) {
  float n = float(u_levels);
  float rough = u_edge * 0.05 * (gnoise(P * 0.3 + sd) + 0.35 * gnoise(P * 0.8 + sd));
  float x = clamp(v + rough, 0.0, 1.0) * n;
  float q = floor(x + 0.5 - 0.25);
  float frac = x - floor(x);
  return clamp(q / n, 0.0, 1.0);
}
void main() {
  vec2 P = fullPx();
  float sd = float(u_seed);
  float M = u_misregister;
  vec2 oC = (hash22(vec2(sd, 1.0)) - 0.5) * 2.0 * M, oM = (hash22(vec2(sd, 2.0)) - 0.5) * 2.0 * M;
  vec2 oY = (hash22(vec2(sd, 3.0)) - 0.5) * 2.0 * M, oK = (hash22(vec2(sd, 4.0)) - 0.5) * 1.2 * M;
  vec3 col = u_paper.rgb;
  float streakBase = gnoiseX(P.y / 6.0, sd) * 0.5 + gnoiseX(P.y / 50.0, sd + 4.0);
  vec3 inks[3] = vec3[3](u_inkY.rgb, u_inkM.rgb, u_inkC.rgb);
  vec2 offs[3] = vec2[3](oY, oM, oC);
  for (int i = 0; i < 3; i++) {
    int ch = 2 - i; // Y (from blue), M (green), C (red)
    vec2 off = offs[i];
    float lsd = sd * 7.0 + float(i) * 31.0;
    float v = sepAt(P, off)[ch];
    float a = layer(v, P - off, lsd);
    // ink pooling: darker rim where the stencil edge is (coverage gradient)
    float vx = sepAt(P + vec2(2.0, 0.0), off)[ch], vy = sepAt(P + vec2(0.0, 2.0), off)[ch];
    float rim = clamp(length(vec2(vx - v, vy - v)) * 6.0, 0.0, 1.0) * u_edge * step(0.01, a);
    float streak = 1.0 - u_streaks * 0.18 * smoothstep(-0.3, 1.2, gnoiseX((P.y - off.y) / 7.0, lsd) * 0.5 + gnoiseX((P.y - off.y) / 60.0, lsd + 3.0));
    float d = a * streak * (1.0 + rim * 0.5);
    col *= mix(vec3(1.0), inks[i], clamp(d, 0.0, 1.2));
  }
  // key layer
  float L = 1.0;
  vec2 uvk = fullToUv(P - oK);
  if (uvk.x >= 0.0 && uvk.y >= 0.0 && uvk.x <= 1.0 && uvk.y <= 1.0) L = texture(u_pass2, uvk).a;
  float kr = u_edge * 0.025 * gnoise(P * 0.4 + sd * 9.0);
  float kk = 1.0 - smoothstep(u_keyThreshold - 0.015, u_keyThreshold + 0.015, L + kr);
  col *= mix(vec3(1.0), u_inkK.rgb, kk * u_keyAmount * (1.0 - u_streaks * 0.1 * smoothstep(0.5, 1.5, streakBase)));
  // paper tooth
  col *= 1.0 + 0.03 * gnoise(P * 0.8 + sd) - 0.02 * smoothstep(0.6, 1.0, fbm(P / 120.0 + sd, 3));
  fragColor = vec4(clamp(col, 0.0, 1.0), texture(u_image, v_uv).a);
}`),
    },
  ],
});

// ---------------------------------------------------------------------------
// Photocopy
// ---------------------------------------------------------------------------
const photocopy = defineNode({
  id: 'effects.photocopy',
  name: 'Photocopy',
  category: 'Print',
  color: C,
  description:
    'Xerox look: harsh contrast, midtones collapsing to toner or paper, generation loss (each re-copy blurs, shifts and re-thresholds the image), ' +
    'toner speckle, drum streaks, patchy blacks and the dark lid shadow at the edges.',
  tags: ['xerox', 'copy', 'zine', 'punk', 'toner', 'black and white', 'photocopier', 'diy'],
  inputs: img,
  params: {
    threshold: { type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Darkness', description: 'Toner threshold: higher = more black.' },
    contrast: { type: 'float', default: 6, min: 1, max: 30, step: 0.1, label: 'Contrast', description: 'Steepness of the toner response.' },
    generations: { type: 'int', default: 3, min: 0, max: 12, step: 1, label: 'Generations', description: 'Copies of copies: each adds blur, drift and re-thresholding.' },
    drift: { type: 'float', default: 0.6, min: 0, max: 4, step: 0.01, pixels: true, label: 'Drift per copy', description: 'Blur and sideways creep per generation, full-res px.' },
    speckle: { type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Toner speckle' },
    streaks: { type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Drum streaks' },
    patchy: { type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, label: 'Patchy blacks' },
    edges: { type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, label: 'Lid shadow' },
    toner: { type: 'color', default: [0.08, 0.08, 0.09, 1], label: 'Toner' },
    paper: { type: 'color', default: [0.95, 0.94, 0.91, 1], label: 'Paper' },
    seed: { type: 'int', default: 5, min: 0, max: 9999, step: 1, label: 'Seed' },
    animate: ANIMATE_PARAM,
  },
  passes: [
    { // 0: grey + first threshold (soft)
      frag: FE(`
void main() {
  vec3 c = texture(u_image, v_uv).rgb;
  float y = luma601(c);
  float t = 1.0 - u_threshold;
  float v = 1.0 / (1.0 + exp(-u_contrast * (y - t)));
  fragColor = vec4(v, v, v, 1.0);
}`),
    },
    { // 1..n: generation loss
      repeat: (c: PassContext) => Math.max(1, Math.round(num(c.params, 'generations', 3))),
      frag: FE(`
void main() {
  if (u_generations == 0) { fragColor = texture(u_prev, v_uv); return; }
  float g = float(u_iteration) + float(u_seed) * 3.7;
  vec2 shift = (hash22(vec2(g, 9.0)) - 0.5) * vec2(1.0, 0.6) * u_drift * u_scale;
  shift.x += u_drift * u_scale * 0.4;
  float zoom = 1.0 + (hash11(g * 1.3) - 0.5) * 0.002;
  vec2 uv = (v_uv - 0.5) * zoom + 0.5 - shift / u_resolution;
  vec2 t = max(u_drift * u_scale * 0.8, 0.35) / u_resolution;
  float s = texClamp(u_prev, uv).r * 4.0;
  s += texClamp(u_prev, uv + vec2(t.x, 0.0)).r + texClamp(u_prev, uv - vec2(t.x, 0.0)).r;
  s += texClamp(u_prev, uv + vec2(0.0, t.y)).r + texClamp(u_prev, uv - vec2(0.0, t.y)).r;
  s /= 8.0;
  // each copy: slight darkening + re-threshold (toner fills in, thin lines vanish)
  vec2 P = fullPx();
  float n = 0.06 * gnoise(P * 0.5 + g * 11.0);
  float v = 1.0 / (1.0 + exp(-6.0 * (s - 0.52 + n)));
  fragColor = vec4(vec3(mix(s, v, 0.55)), 1.0);
}`),
    },
    { // final: toner on paper
      uniforms: (c: PassContext) => animSeed(c, 5), // in motion: fresh speckle/streaks every frame
      frag: FE(`
void main() {
  vec2 P = fullPx();
  vec2 full = u_resolution / u_scale;
  float sd = float(u_seed);
  float v = texture(u_prev, v_uv).r;   // 1 = paper, 0 = toner
  float ink = 1.0 - v;
  // final harden
  ink = smoothstep(0.35, 0.65, ink + 0.08 * gnoise(P * 0.9 + sd));
  // patchy solids: toner starved in large blacks
  float patchN = fbm(P / 40.0 + sd, 4);
  ink *= 1.0 - u_patchy * 0.35 * smoothstep(0.55, 0.85, patchN) * smoothstep(0.6, 1.0, ink);
  ink *= 1.0 - u_patchy * 0.9 * step(0.93, hash12(floor(P / 1.5) + sd)) * smoothstep(0.5, 1.0, patchN + 0.2) * ink;
  // drum streaks (vertical, along paper feed) and a horizontal skip band
  float col = floor(P.x / 2.0);
  float st = step(1.0 - u_streaks * 0.004, hash12(vec2(col, sd)));
  float st2 = smoothstep(2.2, 2.8, gnoiseX(P.x / 2.0, sd + 7.0)) * 0.5 * smoothstep(0.3, 0.7, valueNoise(vec2(P.x / 2.0, P.y / 300.0 + sd)));
  ink = max(ink, (st * 0.85 + st2) * u_streaks * (0.6 + 0.4 * valueNoise(vec2(col, P.y / 80.0))));
  float band = smoothstep(0.75, 0.95, valueNoise(vec2(P.y / 140.0, sd))) * u_streaks;
  ink *= 1.0 - band * 0.35;
  // toner speckle: stray particles on white, dropouts in black
  float sp = hash12(floor(P / 1.3) + sd * 17.0);
  float cl = smoothstep(0.55, 0.9, valueNoise(P / 25.0 + sd));
  ink = max(ink, step(1.0 - u_speckle * (0.004 + 0.02 * cl), sp));
  float big = gnoise(P / 3.0 + sd * 3.0);
  ink = max(ink, u_speckle * smoothstep(2.6, 3.0, big));
  // lid shadow: dark uneven borders where the original didn't cover the glass
  vec2 e = min(P, full - P);
  float edgeN = gnoiseX(P.x / 60.0, sd) * 6.0 + gnoiseX(P.y / 60.0, sd + 1.0) * 6.0;
  float border = 1.0 - smoothstep(-1.5, 1.5, min(e.x, e.y) - max(10.0 + edgeN, 1.0));
  float grime = smoothstep(0.4, 1.0, hash12(floor(P / 2.0) + sd)) * (1.0 - smoothstep(0.0, 70.0, min(e.x, e.y)));
  ink = max(ink, u_edges * max(border, grime * 0.8));
  ink = clamp(ink, 0.0, 1.0);
  vec3 paper = u_paper.rgb * (1.0 + 0.02 * gnoise(P * 0.7 + sd));
  vec3 c = mix(paper, u_toner.rgb, ink * 0.97);
  fragColor = vec4(c, 1.0);
}`),
    },
  ],
});

// ---------------------------------------------------------------------------
// Fax
// ---------------------------------------------------------------------------
const faxGrid = (c: PassContext): [number, number] => {
  const dx = Math.max(0.5, num(c.params, 'dotWidth', 2)) * c.scale;
  const dy = Math.max(0.5, num(c.params, 'lineHeight', 4)) * c.scale;
  return [Math.max(1, Math.round(c.width / dx)), Math.max(1, Math.round(c.height / dy))];
};

const fax = defineNode({
  id: 'effects.fax',
  name: 'Fax',
  category: 'Print',
  color: C,
  description:
    'Group 3 fax transmission: 1-bit at low vertical resolution (standard mode ≈ half the horizontal), text-mode threshold or halftone-mode dither, ' +
    'slightly skewed scan, jittering and dropped/repeated scanlines, line noise, on faded thermal paper with a header line.',
  tags: ['fax', 'facsimile', '1-bit', 'thermal', 'office', '90s', 'scan', 'black and white'],
  inputs: img,
  params: {
    mode: { type: 'enum', default: 'Halftone', options: ['Text (threshold)', 'Halftone'], label: 'Mode' },
    dotWidth: { type: 'float', default: 2, min: 0.5, max: 16, step: 0.1, pixels: true, label: 'Dot width', description: 'Horizontal dot pitch in full-res px.' },
    lineHeight: { type: 'float', default: 4, min: 0.5, max: 32, step: 0.1, pixels: true, label: 'Line height', description: 'Scanline pitch in full-res px (standard mode = 2× the dot width).' },
    threshold: { type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Threshold' },
    contrast: { type: 'float', default: 1.4, min: 0, max: 4, step: 0.01, label: 'Contrast' },
    skew: { type: 'float', default: 0.6, min: -5, max: 5, step: 0.01, label: 'Skew (°)' },
    jitter: { type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, label: 'Line jitter' },
    noise: { type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, label: 'Line noise' },
    fade: { type: 'float', default: 0.25, min: 0, max: 1, step: 0.01, label: 'Thermal fade' },
    header: { type: 'string', default: 'NOV-06-1996 14:32  FROM: DARKROOM LAB  P.01', label: 'Header text' },
    paper: { type: 'color', default: [0.95, 0.94, 0.88, 1], label: 'Paper' },
    ink: { type: 'color', default: [0.1, 0.1, 0.12, 1], label: 'Print' },
    seed: { type: 'int', default: 3, min: 0, max: 9999, step: 1, label: 'Seed' },
  },
  cpu: ({ params }) => {
    const text = String(params.header ?? '');
    const w = 2048, h = 32;
    const cv: OffscreenCanvas | HTMLCanvasElement = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
    const g = cv.getContext('2d') as OffscreenCanvasRenderingContext2D;
    g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#fff'; g.font = 'bold 24px monospace'; g.textBaseline = 'middle';
    g.fillText(text, 8, h / 2 + 1);
    const m = g.measureText(text);
    return { header: cv, headerw: { width: 1, height: 1, data: new Float32Array([(m.width + 16) / w, 0, 0, 1]) } };
  },
  passes: [
    { // 0: scan at fax resolution (skewed, jittered)
      size: faxGrid, filter: 'nearest',
      frag: FE(`
void main() {
  vec2 cell = floor(v_uv * u_resolution);
  float sd = float(u_seed);
  float line = cell.y;
  // dropped line: repeat the previous one
  if (hash12(vec2(line, sd + 2.0)) < u_noise * 0.04) line -= 1.0;
  vec2 uv = (vec2(cell.x, line) + 0.5) / u_resolution;
  vec2 ip = (uv - 0.5) * u_image_size;
  ip = rot2(radians(u_skew)) * ip;
  uv = ip / u_image_size + 0.5;
  uv.x += (hash12(vec2(line, sd)) - 0.5) * u_jitter * 2.0 / u_resolution.x + gnoiseX(line / 30.0, sd) * u_jitter * 1.5 / u_resolution.x;
  vec2 t = 0.5 / u_resolution;
  vec3 c = (texClamp(u_image, uv).rgb * 2.0 + texClamp(u_image, uv + vec2(t.x, 0.0)).rgb + texClamp(u_image, uv - vec2(t.x, 0.0)).rgb
          + texClamp(u_image, uv + vec2(0.0, t.y)).rgb + texClamp(u_image, uv - vec2(0.0, t.y)).rgb) / 6.0;
  float y = luma(c);
  y = (y - 0.5) * u_contrast + 0.5 + (0.5 - u_threshold);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) y = 1.0;
  float th = u_mode == 0 ? 0.5 : bayer4(cell);
  float b = step(th, y); // 1 = white
  // line noise: random black runs
  float run = hash12(vec2(floor(cell.x / (4.0 + 30.0 * hash12(vec2(line, sd + 5.0)))), line + sd * 3.0));
  if (run < u_noise * 0.012) b = 0.0;
  if (hash12(vec2(line, sd + 8.0)) < u_noise * 0.006) b = mod(cell.x, 3.0) < 1.0 ? 0.0 : b; // dotted noise line
  fragColor = vec4(vec3(b), 1.0);
}`),
    },
    { // 1: print on thermal paper
      frag: FE(`
void main() {
  vec2 P = fullPx();
  vec2 full = u_resolution / u_scale;
  float sd = float(u_seed);
  float b = texture(u_pass0, v_uv).r;
  float ink = 1.0 - b;
  // header strip (printed by the sending machine, at fax resolution)
  float hh = max(full.y * 0.02, 12.0);
  vec2 dot = vec2(max(u_dotWidth, 0.5), max(u_lineHeight, 0.5) * 0.5);
  vec2 Q = (floor(P / dot) + 0.5) * dot;
  if (Q.y > hh * 0.4 && Q.y < hh * 1.7) {
    float hw = texture(u_headerw, vec2(0.5)).r;
    float k = hh * 1.3 / 32.0;
    vec2 huv = vec2((Q.x - hh) / (2048.0 * k), (Q.y - hh * 0.4) / (hh * 1.3));
    float h = (huv.x >= 0.0 && huv.x <= hw) ? texture(u_header, huv).r : 0.0;
    ink = step(0.45, h);
  }
  // thermal paper: fade towards grey-brown, uneven
  float fadeN = fbm(P / 300.0 + sd, 3);
  float f = u_fade * (0.5 + 0.7 * fadeN);
  vec3 printCol = mix(u_ink.rgb, vec3(0.45, 0.42, 0.38), clamp(f, 0.0, 0.85));
  vec3 paper = u_paper.rgb * (1.0 - 0.06 * u_fade * smoothstep(0.4, 0.9, fadeN)) * (1.0 + 0.015 * gnoise(P * 0.6 + sd));
  fragColor = vec4(mix(paper, printCol, ink), 1.0);
}`),
    },
  ],
});

export default [screenprint, photocopy, fax] satisfies NodeDef[];
