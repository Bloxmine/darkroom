/** Historic / alternative photographic processes. */
import { defineNode } from '../../core/registry';
import type { NodeDef } from '../../core/types';
import { FE } from './_shared';

const C = '#5b8fd9';
const img = { image: { type: 'image' as const } };

// ---------------------------------------------------------------------------
// Cyanotype
// ---------------------------------------------------------------------------
const cyanotype = defineNode({
  id: 'effects.cyanotype',
  name: 'Cyanotype',
  category: 'Process',
  color: C,
  description:
    'Iron-based "blueprint" contact print: Prussian-blue shadows on cream watercolour paper, a soft UV-weighted tonal response, ' +
    'uneven hand-brushed coating with ragged brush-stroke borders, and faint yellow-brown staining.',
  tags: ['cyanotype', 'blueprint', 'alternative process', 'prussian blue', 'contact print', 'sun print', 'herschel'],
  inputs: img,
  params: {
    exposure: { type: 'float', default: 0, min: -2, max: 2, step: 0.01, label: 'Exposure (stops)' },
    contrast: { type: 'float', default: 1.25, min: 0.2, max: 3, step: 0.01, label: 'Contrast' },
    blue: { type: 'color', default: [0.05, 0.2, 0.45, 1], label: 'Prussian blue' },
    paper: { type: 'color', default: [0.95, 0.93, 0.86, 1], label: 'Paper' },
    coating: { type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, label: 'Uneven coating' },
    brushEdges: { type: 'float', default: 0.7, min: 0, max: 1, step: 0.01, label: 'Brushed borders' },
    stain: { type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, label: 'Staining' },
    paperTexture: { type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, label: 'Paper texture' },
    seed: { type: 'int', default: 2, min: 0, max: 9999, step: 1, label: 'Seed' },
  },
  passes: [{
    frag: FE(`
void main() {
  vec2 P = fullPx();
  vec2 full = u_resolution / u_scale;
  float sd = float(u_seed);
  vec3 c = texture(u_image, v_uv).rgb;
  // UV / blue-weighted response; print density = how much light the negative passed
  float y = dot(srgbToLinear(c), vec3(0.15, 0.45, 0.40)) * exp2(u_exposure);
  y = linearToSrgb(vec3(y)).r;
  y = clamp((y - 0.5) * u_contrast + 0.5, 0.0, 1.0);
  float dens = 1.0 - y;                       // blue where the original was dark
  dens = 1.0 - pow(1.0 - dens, 1.35);          // soft shoulder like iron salts
  float pt = paperTex(P, sd);
  float coat = 1.0 + u_coating * 0.2 * (fbm(P / 160.0 + sd, 4) - 0.5) * 2.0;
  // Layout: the negative (crisp rectangle) sits inside a hand-brushed coated area; coated paper
  // beyond the negative was fully exposed (solid blue), bare paper beyond the brush strokes.
  float B = u_brushEdges;
  vec2 uv = P / full;
  float asp = full.x / full.y;
  float dxL = uv.x * asp, dxR = (1.0 - uv.x) * asp, dyT = uv.y, dyB = 1.0 - uv.y;
  float negInset = 0.075 * B;
  float negIn = min(min(dxL, dxR), min(dyT, dyB)) - negInset;
  float neg = smoothstep(-0.0008, 0.0008, negIn);
  // horizontal brush strokes: each stroke band ends at its own ragged x position
  float bandH = 0.045;
  float band = floor(uv.y / bandH + 0.3 * fbm(vec2(uv.x * 3.0, uv.y * 8.0) + sd, 3));
  float extL = 0.03 + 0.022 * (hash11(band + sd * 3.1) - 0.5) * 2.0 + 0.012 * (fbm(vec2(P.y / 20.0, sd), 3) - 0.5);
  float extR = 0.03 + 0.022 * (hash11(band + sd * 5.7) - 0.5) * 2.0 + 0.012 * (fbm(vec2(P.y / 20.0, sd + 9.0), 3) - 0.5);
  float wav = (fbm(vec2(P.x / 90.0, sd * 2.0), 4) - 0.5) * 0.03 + (fbm(vec2(P.x / 15.0, sd), 3) - 0.5) * 0.006;
  float inX = min(dxL - extL * B, dxR - extR * B);
  float inY = min(dyT, dyB) - (0.03 + wav) * B;
  float inside = min(inX, inY);
  float coated = smoothstep(-0.001, 0.001, inside);
  // dry-brush bristle streaks just beyond the coated edge (horizontal on the sides)
  float bristle = valueNoise(vec2(P.x / 120.0, P.y / 2.4) + sd) * 0.7 + valueNoise(vec2(P.x / 30.0, P.y / 1.3) + sd * 2.0) * 0.3;
  float dry = smoothstep(-0.035, 0.0, inside) * (1.0 - coated) * smoothstep(0.45, 0.75, bristle);
  float edgeDens = 0.96 * (0.85 + 0.15 * bristle);
  float d = mix(edgeDens, clamp(dens * coat, 0.0, 1.0), mix(1.0, neg, step(0.001, B)));
  d = d * max(coated, dry * 0.9);
  d *= 1.0 - u_paperTexture * 0.15 * smoothstep(0.1, 0.8, pt);
  vec3 paper = u_paper.rgb * (1.0 + u_paperTexture * 0.04 * pt);
  float stn = smoothstep(0.55, 0.85, fbm(P / 260.0 + sd * 5.0, 4)) * u_stain;
  paper = mix(paper, paper * vec3(1.0, 0.93, 0.78), stn);
  vec3 blue = u_blue.rgb * (1.0 - 0.3 * u_coating * smoothstep(0.6, 0.9, fbm(P / 70.0 + sd * 2.0, 3)));
  // mix perceptually (sRGB) so the midtones are a rich mid blue
  vec3 col = mix(paper, blue, d);
  fragColor = vec4(col, 1.0);
}`),
  }],
});

// ---------------------------------------------------------------------------
// Wet plate (tintype / collodion)
// ---------------------------------------------------------------------------
const wetPlate = defineNode({
  id: 'effects.wetPlate',
  name: 'Wet Plate (Tintype)',
  category: 'Process',
  color: C,
  description:
    'Wet-collodion tintype / ambrotype. Collodion is only blue-sensitive, so reds and skin blemishes go dark and blue skies blow out to silver. ' +
    'Silvery, slightly warm highlights on a dark japanned iron plate, Petzval-style soft swirly edges, heavy vignette, irregular pour marks and ' +
    'reticulation at the borders, comet streaks, scratches and dust.',
  tags: ['tintype', 'collodion', 'wet plate', 'ambrotype', '19th century', 'victorian', 'antique', 'civil war', 'petzval'],
  inputs: img,
  params: {
    exposure: { type: 'float', default: -0.3, min: -2, max: 2, step: 0.01, label: 'Exposure (stops)' },
    contrast: { type: 'float', default: 1.45, min: 0.2, max: 3, step: 0.01, label: 'Contrast' },
    blueSensitivity: { type: 'float', default: 1, min: 0, max: 1, step: 0.01, label: 'Blue sensitivity', description: '1 = pure collodion (reds black), 0 = panchromatic.' },
    plate: { type: 'enum', default: 'Tintype', options: ['Tintype', 'Ambrotype', 'Silver (daguerreotype)'], label: 'Plate' },
    softness: { type: 'float', default: 6, min: 0, max: 40, step: 0.1, pixels: true, label: 'Lens softness', description: 'Petzval edge blur, full-res px at the corners.' },
    vignette: { type: 'float', default: 0.7, min: 0, max: 1, step: 0.01, label: 'Vignette' },
    pour: { type: 'float', default: 0.7, min: 0, max: 1, step: 0.01, label: 'Pour marks / edges' },
    scratches: { type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Scratches & dust' },
    seed: { type: 'int', default: 4, min: 0, max: 9999, step: 1, label: 'Seed' },
  },
  passes: [
    { // 0: blue-sensitive density
      frag: FE(`
void main() {
  vec3 lin = srgbToLinear(texture(u_image, v_uv).rgb);
  float blueOnly = dot(lin, vec3(0.0, 0.12, 0.88));
  float pan = dot(lin, vec3(0.2126, 0.7152, 0.0722));
  float y = mix(pan, blueOnly, u_blueSensitivity) * exp2(u_exposure);
  fragColor = vec4(vec3(y), 1.0);
}`),
    },
    { // 1: Petzval swirl blur (tangential smear growing with radius)
      frag: FE(`
void main() {
  vec2 asp = vec2(u_resolution.x / u_resolution.y, 1.0);
  vec2 d = (v_uv - 0.5) * asp;
  float r = length(d) / length(0.5 * asp);
  float rad = u_softness * u_scale * smoothstep(0.25, 1.0, r);
  vec2 tang = r > 1e-4 ? vec2(-d.y, d.x) / length(d) : vec2(0.0);
  vec2 radial = r > 1e-4 ? d / length(d) : vec2(0.0);
  float acc = 0.0, ws = 0.0;
  for (int i = 0; i < 24; i++) {
    float t = (float(i) + 0.5) / 24.0;
    float a = t * TAU;
    vec2 o = (tang * cos(a) * 1.0 + radial * sin(a) * 0.45) * rad * sqrt(fract(t * 7.31 + 0.5));
    acc += texClamp(u_prev, v_uv + o / u_resolution).r; ws += 1.0;
  }
  fragColor = vec4(vec3(acc / ws), 1.0);
}`),
    },
    { // 2: plate
      frag: FE(`
void main() {
  vec2 P = fullPx();
  vec2 full = u_resolution / u_scale;
  float sd = float(u_seed);
  float y = texture(u_prev, v_uv).r;
  // collodion: steep toe, highlights compress to silver
  float s = linearToSrgb(vec3(y)).r;
  s = clamp((s - 0.45) * u_contrast + 0.5, 0.0, 1.0);
  s = smoothstep(0.0, 1.0, s);
  // vignette
  vec2 asp = vec2(full.x / full.y, 1.0);
  vec2 q = (P / full - 0.5) * asp;
  float r = length(q) / length(0.5 * asp);
  s *= 1.0 - u_vignette * smoothstep(0.35, 1.05, r) * 0.85;
  // plate tones
  vec3 dark, mid, light;
  if (u_plate == 0) { dark = vec3(0.035, 0.032, 0.03); mid = vec3(0.29, 0.27, 0.23); light = vec3(0.84, 0.81, 0.73); }
  else if (u_plate == 1) { dark = vec3(0.03, 0.025, 0.025); mid = vec3(0.42, 0.36, 0.28); light = vec3(0.92, 0.86, 0.74); }
  else { dark = vec3(0.07, 0.075, 0.08); mid = vec3(0.45, 0.46, 0.46); light = vec3(0.9, 0.9, 0.88); }
  vec3 col = s < 0.5 ? mix(dark, mid, s * 2.0) : mix(mid, light, (s - 0.5) * 2.0);
  // silvery sheen: cool lift of the highlights
  col += vec3(-0.01, 0.0, 0.02) * smoothstep(0.6, 1.0, s);
  // collodion film thickness variations (flow lines from the pour, mostly near one corner)
  float flow = fbm(vec2(P.x / 220.0 + P.y / 400.0, P.y / 90.0) + sd, 5);
  col *= 1.0 + u_pour * 0.12 * (flow - 0.5);
  // pour edges: irregular boundary of the collodion; outside = bare black lacquer with silvery fog
  vec2 e2 = min(P, full - P) / full.y;
  float edgeNoise = fbm(P / 160.0 + sd * 2.0, 4) * 0.06 + fbm(P / 50.0 + sd, 2) * 0.008;
  float corner = smoothstep(0.35, 0.0, length(P / full - vec2(0.97, 0.04))) * 0.08; // drip at the corner it was poured from
  float inside = min(e2.x, e2.y) - (0.018 + edgeNoise + corner) * u_pour;
  float coll = smoothstep(0.0, 0.004, inside);
  float rim = smoothstep(0.03, 0.0, inside) * coll * u_pour;   // thick, milky rim along the edge
  col = mix(col, col * 0.7 + vec3(0.12, 0.11, 0.09), rim * 0.6 * smoothstep(0.3, 0.7, fbm(P / 8.0 + sd, 3)));
  vec3 bare = vec3(0.04, 0.035, 0.03) + vec3(0.1, 0.09, 0.08) * smoothstep(0.55, 0.8, fbm(P / 30.0 + sd * 3.0, 4));
  col = mix(bare, col, mix(1.0, coll, u_pour));
  // comets & pinholes (silver nitrate spots), dust, scratches
  float spot = hash12(floor(P / 3.0) + sd);
  col = mix(col, vec3(0.02), u_scratches * step(0.9994, spot));
  float comet = gnoise(P / 4.0 + sd * 7.0);
  col = mix(col, vec3(0.88, 0.85, 0.76), u_scratches * smoothstep(3.0, 3.4, comet) * 0.8);
  for (int i = 0; i < 9; i++) {
    float fi = float(i);
    vec2 a = hash22(vec2(fi, sd)) * full, b = a + (hash22(vec2(fi, sd + 3.0)) - 0.5) * full.y * vec2(0.6, 0.9);
    vec2 pa = P - a, ba = b - a;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    float dd = length(pa - ba * h);
    float w = 0.6 + hash11(fi + sd) * 0.8;
    float line = (1.0 - smoothstep(w * 0.5, w, dd)) * step(0.35, valueNoise(vec2(h * 30.0, fi)));
    col = mix(col, hash11(fi * 3.1 + sd) > 0.5 ? vec3(0.8, 0.77, 0.7) : vec3(0.02), line * u_scratches * 0.7);
  }
  col *= 1.0 + 0.03 * gnoise(P * 0.6 + sd);
  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`),
    },
  ],
});

// ---------------------------------------------------------------------------
// Infrared (Aerochrome)
// ---------------------------------------------------------------------------
const infrared = defineNode({
  id: 'effects.infrared',
  name: 'Infrared',
  category: 'Process',
  color: C,
  description:
    'Infrared photography. Aerochrome: Kodak colour-infrared false colour (IR→red, red→green, green→blue) with an estimated IR channel — chlorophyll reflects IR strongly, ' +
    'so foliage turns red/magenta while skies go deep blue. Also digital channel-swap IR and black & white IR (Wood effect: glowing white foliage, black skies).',
  tags: ['infrared', 'aerochrome', 'ir', 'false colour', 'foliage', 'wood effect', 'kodak', 'eir', 'psychedelic'],
  inputs: img,
  params: {
    mode: { type: 'enum', default: 'Aerochrome', options: ['Aerochrome', 'Digital IR (channel swap)', 'Black & white IR'], label: 'Mode' },
    foliage: { type: 'float', default: 1, min: 0, max: 2, step: 0.01, label: 'Foliage response', description: 'How strongly greens are detected as IR-bright vegetation.' },
    irLuma: { type: 'float', default: 0.9, min: 0, max: 1, step: 0.01, label: 'IR from brightness', description: 'Base IR reflectance taken from overall brightness.' },
    skyDarken: { type: 'float', default: 0.8, min: 0, max: 1, step: 0.01, label: 'Sky darkening' },
    hueShift: { type: 'float', default: 0, min: -0.2, max: 0.2, step: 0.005, label: 'Hue shift', description: 'Push foliage towards magenta (−) or orange-red (+).' },
    saturation: { type: 'float', default: 1.15, min: 0, max: 3, step: 0.01, label: 'Saturation' },
    contrast: { type: 'float', default: 1.1, min: 0.2, max: 3, step: 0.01, label: 'Contrast' },
    mix: { type: 'float', default: 1, min: 0, max: 1, step: 0.01, label: 'Mix' },
  },
  passes: [{
    frag: FE(`
void main() {
  vec4 src = texture(u_image, v_uv);
  vec3 c = clamp(src.rgb, 0.0, 1.0);
  vec3 hsv = rgb2hsv(c);
  // vegetation: green-yellow hues with some saturation
  float hueG = 1.0 - smoothstep(0.06, 0.13, abs(hsv.x - 0.27));
  float veg = clamp((c.g - max(c.r * 0.85, c.b)) * 4.0, 0.0, 1.0);
  veg = max(veg, hueG * smoothstep(0.08, 0.3, hsv.y));
  veg *= smoothstep(0.03, 0.2, hsv.z);
  float sky = smoothstep(0.5, 0.65, hsv.x) * (1.0 - smoothstep(0.7, 0.78, hsv.x)) * smoothstep(0.1, 0.35, hsv.y);
  float Y = luma(c);
  float ir = (0.55 * Y + 0.45 * c.r) * u_irLuma + veg * u_foliage * 0.75 * (0.55 + 0.6 * hsv.z);
  ir *= 1.0 - sky * u_skyDarken * 0.8;
  ir = clamp(ir, 0.0, 1.2);
  vec3 o;
  if (u_mode == 0) {
    o = vec3(ir, c.r, c.g);              // IR->R, R->G, G->B (yellow filter removes blue)
    o.b = mix(o.b, o.b * 1.1 + sky * 0.15, 0.6);
    o.b *= 1.0 - veg * 0.35;            // foliage leans red rather than magenta
    o.g = mix(o.g, o.b * 0.9, sky * 0.35); // skies towards cyan-blue
  } else if (u_mode == 1) {
    vec3 ircol = mix(c, vec3(ir), 0.6);   // what a 720nm-filtered sensor roughly records
    ircol.r = mix(ircol.r, ir * 1.1, 0.5);
    o = ircol.bgr;                         // classic red/blue swap: blue skies, cream foliage
  } else {
    o = vec3(ir * (1.0 - sky * u_skyDarken * 0.5));
  }
  vec3 h = rgb2hsv(clamp(o, 0.0, 1.0));
  h.x = fract(h.x + u_hueShift);
  h.y = clamp(h.y * u_saturation, 0.0, 1.0);
  o = hsv2rgb(h);
  o = clamp((o - 0.5) * u_contrast + 0.5, 0.0, 1.0);
  fragColor = vec4(mix(src.rgb, o, u_mix), src.a);
}`),
  }],
});

// ---------------------------------------------------------------------------
// Cross process
// ---------------------------------------------------------------------------
const crossProcess = defineNode({
  id: 'effects.crossProcess',
  name: 'Cross Process',
  category: 'Process',
  color: C,
  description:
    'Film developed in the wrong chemistry. E-6 slide film in C-41: punchy contrast, yellow-green highlights, cyan-blue shadows, blown saturation. ' +
    'C-41 negative in E-6: flat, pastel, magenta/teal with a lifted base.',
  tags: ['cross process', 'xpro', 'lomo', 'e6', 'c41', 'slide', '90s', 'film'],
  inputs: img,
  params: {
    mode: { type: 'enum', default: 'Slide in C-41', options: ['Slide in C-41', 'Negative in E-6'], label: 'Mode' },
    amount: { type: 'float', default: 1, min: 0, max: 1.5, step: 0.01, label: 'Amount' },
    contrast: { type: 'float', default: 1, min: 0, max: 2, step: 0.01, label: 'Contrast' },
    saturation: { type: 'float', default: 1.25, min: 0, max: 3, step: 0.01, label: 'Saturation' },
    tint: { type: 'float', default: 0, min: -1, max: 1, step: 0.01, label: 'Tint (green ↔ magenta)' },
  },
  passes: [{
    frag: FE(`
float sCurve(float x, float k) { return x + k * x * (1.0 - x) * (2.0 * x - 1.0) * 2.0; }
void main() {
  vec4 src = texture(u_image, v_uv);
  vec3 c = clamp(src.rgb, 0.0, 1.0);
  vec3 o;
  if (u_mode == 0) {
    o.r = sCurve(sCurve(c.r, 0.6), 0.4 * u_contrast);
    o.g = sCurve(c.g, 0.45 * u_contrast) * 1.04 + 0.02;
    o.b = c.b * 0.62 + 0.17;                // compressed blue: yellow highlights, blue shadows
    o.b = mix(o.b, sCurve(o.b, -0.3), 0.5);
    o = mix(o, o * vec3(1.0, 1.04, 0.92), smoothstep(0.5, 1.0, luma(c)));
  } else {
    o.r = c.r * 0.82 + 0.12;
    o.g = c.g * 0.78 + 0.1;
    o.b = c.b * 0.7 + 0.2;
    o = mix(o, vec3(o.r * 1.04, o.g * 0.95, o.b * 1.03), 0.7);
    o = mix(vec3(luma(o)), o, 0.85);
    o = (o - 0.5) * (0.85 + 0.15 * u_contrast) + 0.5;
  }
  o.g -= u_tint * 0.05;
  float L = luma(o);
  o = mix(vec3(L), o, u_saturation);
  fragColor = vec4(mix(c, clamp(o, 0.0, 1.0), u_amount), src.a);
}`),
  }],
});

// ---------------------------------------------------------------------------
// Toning (sepia / selenium / gold / split)
// ---------------------------------------------------------------------------
const TONES = ['Sepia', 'Selenium', 'Gold', 'Platinum / palladium', 'Iron blue', 'Split (custom)'];

const toning = defineNode({
  id: 'effects.toning',
  name: 'Toning (Sepia / Selenium / Gold)',
  category: 'Process',
  color: C,
  description:
    'Darkroom print toners on a black & white conversion. Sepia: warm brown, strongest in highlights and mids. Selenium: cool purple-brown blacks with deeper Dmax. ' +
    'Gold: blue-black, cool highlights. Platinum/palladium: soft warm greys. Iron blue. Split: custom shadow and highlight colours with balance.',
  tags: ['sepia', 'selenium', 'gold', 'split tone', 'toning', 'platinum', 'black and white', 'darkroom', 'antique'],
  inputs: img,
  params: {
    toner: { type: 'enum', default: 'Sepia', options: TONES, label: 'Toner' },
    amount: { type: 'float', default: 1, min: 0, max: 1.5, step: 0.01, label: 'Toning amount' },
    balance: { type: 'float', default: 0, min: -1, max: 1, step: 0.01, label: 'Balance', description: 'Shift the shadow/highlight split point.' },
    contrast: { type: 'float', default: 1.05, min: 0.2, max: 3, step: 0.01, label: 'Contrast' },
    fade: { type: 'float', default: 0.05, min: 0, max: 0.5, step: 0.01, label: 'Fade (lift blacks)' },
    keepColor: { type: 'float', default: 0, min: 0, max: 1, step: 0.01, label: 'Keep colour' },
    shadowColor: { type: 'color', default: [0.18, 0.25, 0.42, 1], label: 'Shadow colour (split)' },
    highlightColor: { type: 'color', default: [0.98, 0.84, 0.62, 1], label: 'Highlight colour (split)' },
  },
  passes: [{
    frag: FE(`
void main() {
  vec4 src = texture(u_image, v_uv);
  vec3 c = clamp(src.rgb, 0.0, 1.0);
  float y = luma(c);
  y = clamp((y - 0.5) * u_contrast + 0.5, 0.0, 1.0);
  float sp = clamp(0.5 + u_balance * 0.4, 0.05, 0.95);
  float hw = smoothstep(sp - 0.35, sp + 0.35, y); // highlight weight
  vec3 sh, hi; float dmax = 0.0;
  if (u_toner == 0) { sh = vec3(0.32, 0.22, 0.14); hi = vec3(1.0, 0.9, 0.74); }
  else if (u_toner == 1) { sh = vec3(0.26, 0.18, 0.24); hi = vec3(0.98, 0.96, 0.93); dmax = 0.15; }
  else if (u_toner == 2) { sh = vec3(0.13, 0.17, 0.27); hi = vec3(0.93, 0.95, 1.0); dmax = 0.05; }
  else if (u_toner == 3) { sh = vec3(0.3, 0.25, 0.2); hi = vec3(0.97, 0.93, 0.85); }
  else if (u_toner == 4) { sh = vec3(0.08, 0.2, 0.36); hi = vec3(0.86, 0.93, 0.97); }
  else { sh = u_shadowColor.rgb; hi = u_highlightColor.rgb; }
  // neutral print, then tone: the toner's colour shows in proportion to density
  float yt = mix(y, y * y * (3.0 - 2.0 * y), dmax * 3.0);
  vec3 neutral = vec3(yt);
  vec3 tone = mix(sh, hi, hw);
  // tone colour normalised to its luma so toning shifts hue, not brightness
  vec3 tn = tone / max(luma(tone), 1e-3);
  vec3 toned = yt * tn;
  if (u_toner == 3) toned = mix(toned, vec3(yt), 0.25) * 0.97 + 0.03;
  vec3 o = mix(neutral, toned, u_amount);
  o = mix(o, o * c / max(y, 1e-3), u_keepColor);
  o = u_fade + o * (1.0 - u_fade);
  fragColor = vec4(clamp(o, 0.0, 1.0), src.a);
}`),
  }],
});

export default [cyanotype, wetPlate, infrared, crossProcess, toning] satisfies NodeDef[];
