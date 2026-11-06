import { defineNode } from '../../core/registry';
import type { NodeDef, PassContext } from '../../core/types';
import { F, glowPasses, num } from './_shared';

const C = '#c98bff';
const img = { image: { type: 'image' as const } };

// ---------------------------------------------------------------------------
// JPEG
// ---------------------------------------------------------------------------
const JPEG_TABLES = /* glsl */ `
const float QL[64] = float[64](
  16.,11.,10.,16.,24.,40.,51.,61.,  12.,12.,14.,19.,26.,58.,60.,55.,
  14.,13.,16.,24.,40.,57.,69.,56.,  14.,17.,22.,29.,51.,87.,80.,62.,
  18.,22.,37.,56.,68.,109.,103.,77., 24.,35.,55.,64.,81.,104.,113.,92.,
  49.,64.,78.,87.,103.,121.,120.,101., 72.,92.,95.,98.,112.,100.,103.,99.);
const float QC[64] = float[64](
  17.,18.,24.,47.,99.,99.,99.,99.,  18.,21.,26.,66.,99.,99.,99.,99.,
  24.,26.,56.,99.,99.,99.,99.,99.,  47.,66.,99.,99.,99.,99.,99.,99.,
  99.,99.,99.,99.,99.,99.,99.,99.,  99.,99.,99.,99.,99.,99.,99.,99.,
  99.,99.,99.,99.,99.,99.,99.,99.,  99.,99.,99.,99.,99.,99.,99.,99.);
float qscale(float base) {
  float q = clamp(u_quality, 1.0, 100.0);
  float S = q < 50.0 ? 5000.0 / q : 200.0 - 2.0 * q;
  return clamp(floor((base * S + 50.0) / 100.0), 1.0, 255.0);
}
float dctC(int u, int x) {
  return (u == 0 ? 0.35355339 : 0.5) * cos(float((2 * x + 1) * u) * 3.14159265 / 16.0);
}
// chroma sample spacing for the subsampling mode: 4:2:0, 4:2:2, 4:4:4
ivec2 csub() { return u_subsampling == 0 ? ivec2(2, 2) : u_subsampling == 1 ? ivec2(2, 1) : ivec2(1, 1); }
ivec2 ipix() { return ivec2(floor(v_uv * u_resolution)); }
`;

/** Internal (block-grid) size: the node's full-res size scaled by 8/blockSize. */
const jpegInternal = (c: PassContext): [number, number] => {
  const bs = Math.max(1, num(c.params, 'blockSize', 8));
  let w = (c.width / c.scale) * (8 / bs), h = (c.height / c.scale) * (8 / bs);
  const m = Math.max(w, h);
  if (m > 6144) { w *= 6144 / m; h *= 6144 / m; }
  return [Math.max(8, Math.round(w)), Math.max(8, Math.round(h))];
};

const jpeg = defineNode({
  id: 'stylize.jpeg',
  name: 'JPEG Artefacts',
  category: 'Stylize',
  color: C,
  description:
    'Real baseline-JPEG round trip: YCbCr, chroma subsampling, 8×8 block DCT, quantisation with the standard IJG tables scaled by Quality, inverse DCT. ' +
    'Blocks are always computed on the full-resolution grid (preview renders internally at full res and downsamples), so preview matches export.',
  tags: ['compression', 'blocks', 'dct', 'artifacts', 'digicam', 'ccd', 'mosquito'],
  inputs: img,
  params: {
    quality: { type: 'float', default: 60, min: 1, max: 100, step: 1, label: 'Quality', description: 'IJG quality 1–100 (lower = more artefacts).' },
    subsampling: { type: 'enum', default: '4:2:0', options: ['4:2:0', '4:2:2', '4:4:4'], label: 'Chroma subsampling' },
    blockSize: { type: 'float', default: 8, min: 2, max: 64, step: 1, pixels: true, label: 'Block size', description: 'Size of a DCT block in full-res pixels (8 = real JPEG; larger = chunkier, as if a smaller image was compressed and enlarged).' },
  },
  passes: [
    { // 0: to YCbCr (centred, 0..255 domain) on the block grid; chroma pre-averaged per subsampling cell
      size: jpegInternal,
      frag: JPEG_TABLES + `
vec3 ycc(vec2 p) { return rgb2ycbcr(clamp(texture(u_image, p / u_resolution).rgb, 0.0, 1.0)) * 255.0 - 128.0; }
void main() {
  vec2 ip = floor(v_uv * u_resolution);
  vec3 c = ycc(ip + 0.5);
  ivec2 s = csub();
  if (s.x * s.y > 1) {
    vec2 base = floor(ip / vec2(s)) * vec2(s);
    vec3 a = vec3(0.0);
    for (int j = 0; j < 2; j++) for (int i = 0; i < 2; i++) {
      if (i >= s.x || j >= s.y) continue;
      a += ycc(base + vec2(i, j) + 0.5);
    }
    c.yz = a.yz / float(s.x * s.y);
  }
  fragColor = vec4(c, 1.0);
}` },
    { // 1: forward DCT along x
      size: jpegInternal, filter: 'nearest',
      frag: JPEG_TABLES + `
void main() {
  ivec2 p = ipix(); ivec2 s = csub();
  int u = p.x % 8, bx = p.x - u;
  int cx = p.x / s.x, cu = cx % 8, cbx = cx - cu;
  vec3 r = vec3(0.0);
  for (int k = 0; k < 8; k++) {
    r.x += texel(u_prev, ivec2(bx + k, p.y)).x * dctC(u, k);
    r.yz += texel(u_prev, ivec2((cbx + k) * s.x, p.y)).yz * dctC(cu, k);
  }
  fragColor = vec4(r, 1.0);
}` },
    { // 2: forward DCT along y + quantise/dequantise
      size: jpegInternal, filter: 'nearest',
      frag: JPEG_TABLES + `
void main() {
  ivec2 p = ipix(); ivec2 s = csub();
  int v = p.y % 8, by = p.y - v;
  int cy = p.y / s.y, cv = cy % 8, cby = cy - cv;
  vec3 F = vec3(0.0);
  for (int k = 0; k < 8; k++) {
    F.x += texel(u_prev, ivec2(p.x, by + k)).x * dctC(v, k);
    F.yz += texel(u_prev, ivec2(p.x, (cby + k) * s.y)).yz * dctC(cv, k);
  }
  int u = p.x % 8, cu = (p.x / s.x) % 8;
  float ql = qscale(QL[v * 8 + u]), qc = qscale(QC[cv * 8 + cu]);
  F.x = floor(F.x / ql + 0.5) * ql;
  F.yz = floor(F.yz / qc + 0.5) * qc;
  fragColor = vec4(F, 1.0);
}` },
    { // 3: inverse DCT along y
      size: jpegInternal, filter: 'nearest',
      frag: JPEG_TABLES + `
void main() {
  ivec2 p = ipix(); ivec2 s = csub();
  int y = p.y % 8, by = p.y - y;
  int cy = p.y / s.y, cyy = cy % 8, cby = cy - cyy;
  vec3 g = vec3(0.0);
  for (int k = 0; k < 8; k++) {
    g.x += texel(u_prev, ivec2(p.x, by + k)).x * dctC(k, y);
    g.yz += texel(u_prev, ivec2(p.x, (cby + k) * s.y)).yz * dctC(k, cyy);
  }
  fragColor = vec4(g, 1.0);
}` },
    { // 4: inverse DCT along x -> YCbCr 0..1 (chroma constant per subsampling cell)
      size: jpegInternal, filter: 'nearest',
      frag: JPEG_TABLES + `
void main() {
  ivec2 p = ipix(); ivec2 s = csub();
  int x = p.x % 8, bx = p.x - x;
  int cx = p.x / s.x, cxx = cx % 8, cbx = cx - cxx;
  vec3 f = vec3(0.0);
  for (int k = 0; k < 8; k++) {
    f.x += texel(u_prev, ivec2(bx + k, p.y)).x * dctC(k, x);
    f.yz += texel(u_prev, ivec2((cbx + k) * s.x, p.y)).yz * dctC(k, cxx);
  }
  fragColor = vec4(clamp(floor(f + 128.0 + 0.5), 0.0, 255.0) / 255.0, 1.0);
}` },
    { // 5: decode — "fancy" (bilinear) chroma upsampling, YCbCr->RGB, resample to output size
      frag: JPEG_TABLES + `
vec3 dec(vec2 P) {
  ivec2 s = csub();
  ivec2 sz = ivec2(u_pass4_size);
  float Y = texel(u_pass4, ivec2(P)).x;
  vec2 cp = P / vec2(s) - 0.5;
  vec2 i0 = floor(cp), f = cp - i0;
  vec2 c00 = texel(u_pass4, ivec2(i0) * s).yz, c10 = texel(u_pass4, ivec2(i0 + vec2(1, 0)) * s).yz;
  vec2 c01 = texel(u_pass4, ivec2(i0 + vec2(0, 1)) * s).yz, c11 = texel(u_pass4, ivec2(i0 + vec2(1, 1)) * s).yz;
  vec2 cc = mix(mix(c00, c10, f.x), mix(c01, c11, f.x), f.y);
  return clamp(ycbcr2rgb(vec3(Y, cc)), 0.0, 1.0);
}
void main() {
  vec2 ratio = u_pass4_size / u_resolution;
  vec2 P = v_uv * u_pass4_size;
  vec3 c;
  if (ratio.x > 1.25) {
    vec2 d = ratio * 0.25;
    c = (dec(P + vec2(-d.x, -d.y)) + dec(P + vec2(d.x, -d.y)) + dec(P + vec2(-d.x, d.y)) + dec(P + vec2(d.x, d.y))) * 0.25;
  } else c = dec(P);
  fragColor = vec4(c, texture(u_image, v_uv).a);
}` },
  ],
});

// ---------------------------------------------------------------------------
// Grain
// ---------------------------------------------------------------------------
const grain = defineNode({
  id: 'stylize.grain',
  name: 'Film Grain',
  category: 'Stylize',
  color: C,
  description: 'Organic film grain: multi-octave smoothed gaussian noise, strongest in the midtones, optionally coloured (dye clouds).',
  tags: ['noise', 'film', 'texture', 'analog'],
  inputs: img,
  params: {
    amount: { type: 'float', default: 0.35, min: 0, max: 1.5, step: 0.01, label: 'Amount' },
    size: { type: 'float', default: 1.6, min: 0.5, max: 10, step: 0.1, pixels: true, label: 'Grain size', description: 'Grain size in full-res pixels.' },
    roughness: { type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Roughness', description: '0 = soft clumpy grain, 1 = crisp, gritty.' },
    chroma: { type: 'float', default: 0.25, min: 0, max: 1, step: 0.01, label: 'Colour', description: '0 = monochrome grain, 1 = independent per-channel grain.' },
    response: { type: 'float', default: 0.8, min: 0, max: 1, step: 0.01, label: 'Midtone response', description: 'How much grain is concentrated in the midtones (0 = even everywhere).' },
    seed: { type: 'int', default: 1, min: 0, max: 9999, step: 1, label: 'Seed' },
  },
  passes: [{
    frag: F(`
float field(vec2 p, float r) {
  float a = gnoise(p), b = gnoise(p * 0.5 + 31.7), c = gnoise(p * 2.0 + 71.3);
  float wa = 0.75, wb = 0.45 * (1.0 - 0.6 * r), wc = 0.6 * r;
  return (a * wa + b * wb + c * wc) / sqrt(wa * wa + wb * wb + wc * wc);
}
void main() {
  vec4 src = texture(u_image, v_uv);
  float s = max(u_size * u_scale, 0.05);
  vec2 p = pixelCoord() / s + vec2(float(u_seed) * 17.31, float(u_seed) * 7.77);
  float m = field(p, u_roughness);
  vec3 n = vec3(m);
  if (u_chroma > 0.0) n = mix(n, vec3(field(p + 113.1, u_roughness), field(p + 271.9, u_roughness), field(p + 419.3, u_roughness)), u_chroma);
  float att = min(1.0, s); // sub-pixel grain averages out
  float l = clamp(luma(src.rgb), 0.0, 1.0);
  float lp = pow(l, 0.8);
  float bell = 4.0 * lp * (1.0 - lp);
  float w = mix(1.0, 0.15 + 0.85 * bell, u_response);
  fragColor = vec4(src.rgb + n * u_amount * 0.12 * w * att, src.a);
}`),
  }],
});

// ---------------------------------------------------------------------------
// Vignette
// ---------------------------------------------------------------------------
const vignette = defineNode({
  id: 'stylize.vignette',
  name: 'Vignette',
  category: 'Stylize',
  color: C,
  description: 'Darkens (or tints) the frame edges, computed in linear light like real lens fall-off.',
  tags: ['edges', 'corners', 'falloff', 'lens'],
  inputs: img,
  params: {
    amount: { type: 'float', default: 0.4, min: -1, max: 1, step: 0.01, label: 'Amount', description: 'Negative values brighten the edges.' },
    radius: { type: 'float', default: 0.75, min: 0, max: 1.5, step: 0.01, label: 'Radius' },
    softness: { type: 'float', default: 0.6, min: 0.01, max: 1.5, step: 0.01, label: 'Softness' },
    roundness: { type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, label: 'Roundness', description: '1 = circular, 0 = follows the frame shape.' },
    center: { type: 'vec2', default: [0.5, 0.5], min: 0, max: 1, step: 0.01, label: 'Centre' },
    color: { type: 'color', default: [0, 0, 0, 1], label: 'Colour' },
  },
  passes: [{
    frag: F(`
void main() {
  vec4 src = texture(u_image, v_uv);
  float aspect = u_resolution.x / u_resolution.y;
  float ax = mix(1.0, aspect, u_roundness);
  vec2 q = (v_uv - u_center) * 2.0 * vec2(ax, 1.0);
  float d = length(q) / length(vec2(ax, 1.0)) * 1.41421;
  float v = smoothstep(u_radius, u_radius + u_softness, d);
  vec3 lin = toLin(src.rgb);
  if (u_amount >= 0.0) lin = mix(lin, toLin(u_color.rgb), v * u_amount);
  else lin *= 1.0 + v * -u_amount;
  fragColor = vec4(toSrgb(lin), src.a);
}`),
  }],
});

// ---------------------------------------------------------------------------
// Bloom & halation
// ---------------------------------------------------------------------------
const bloom = defineNode({
  id: 'stylize.bloom',
  name: 'Bloom',
  category: 'Stylize',
  color: C,
  description: 'Multi-scale glow around bright areas, computed in linear light.',
  tags: ['glow', 'diffusion', 'highlights', 'dreamy'],
  inputs: img,
  params: {
    threshold: { type: 'float', default: 0.7, min: 0, max: 1, step: 0.01, label: 'Threshold' },
    knee: { type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, label: 'Knee', description: 'Softness of the threshold.' },
    intensity: { type: 'float', default: 0.6, min: 0, max: 4, step: 0.01, label: 'Intensity' },
    radius: { type: 'float', default: 60, min: 1, max: 400, step: 1, pixels: true, label: 'Radius' },
    tint: { type: 'color', default: [1, 1, 1, 1], label: 'Tint' },
  },
  passes: glowPasses(`
void main() {
  vec2 t = 0.5 / u_resolution;
  vec3 c = (toLin(texture(u_image, v_uv + vec2(-t.x, -t.y)).rgb) + toLin(texture(u_image, v_uv + vec2(t.x, -t.y)).rgb)
          + toLin(texture(u_image, v_uv + vec2(-t.x, t.y)).rgb) + toLin(texture(u_image, v_uv + vec2(t.x, t.y)).rgb)) * 0.25;
  float thr = srgbToLinear(vec3(u_threshold)).x;
  float br = max(c.r, max(c.g, c.b));
  float k = max(thr * u_knee, 1e-4);
  float soft = clamp(br - thr + k, 0.0, 2.0 * k); soft = soft * soft / (4.0 * k);
  float contrib = max(soft, br - thr) / max(br, 1e-4);
  fragColor = vec4(c * contrib, 1.0);
}`, `
void main() {
  vec4 src = texture(u_image, v_uv);
  vec3 lin = toLin(src.rgb) + glow(v_uv) * u_intensity * toLin(u_tint.rgb) * 2.0;
  fragColor = vec4(toSrgb(lin), src.a);
}`),
});

const halation = defineNode({
  id: 'stylize.halation',
  name: 'Halation',
  category: 'Stylize',
  color: C,
  description: 'Film halation: light bouncing off the film base re-exposes the red layer, giving a red/orange glow hugging bright highlights.',
  tags: ['film', 'glow', 'red', 'cinestill', 'highlights'],
  inputs: img,
  params: {
    threshold: { type: 'float', default: 0.72, min: 0, max: 1, step: 0.01, label: 'Threshold' },
    amount: { type: 'float', default: 0.6, min: 0, max: 3, step: 0.01, label: 'Amount' },
    radius: { type: 'float', default: 14, min: 1, max: 200, step: 0.5, pixels: true, label: 'Radius' },
    tint: { type: 'color', default: [1, 0.32, 0.12, 1], label: 'Colour' },
  },
  passes: glowPasses(`
void main() {
  vec3 c = toLin(texture(u_image, v_uv).rgb);
  float l = luma(linearToSrgb(c));
  float m = smoothstep(u_threshold, min(u_threshold + 0.25, 1.05), l);
  fragColor = vec4(c * m, 1.0);
}`, `
void main() {
  vec4 src = texture(u_image, v_uv);
  vec3 lin = toLin(src.rgb);
  float g = luma(glow(v_uv));
  // the glow shows around (not on top of) highlights: subtract the local bright-pass
  float here = luma(lin) * smoothstep(u_threshold, min(u_threshold + 0.25, 1.05), luma(src.rgb));
  float h = max(g - 0.85 * here, 0.0) + 0.15 * g;
  lin += h * u_amount * 2.5 * toLin(u_tint.rgb);
  fragColor = vec4(toSrgb(lin), src.a);
}`),
});

// ---------------------------------------------------------------------------
// Light leak
// ---------------------------------------------------------------------------
const lightLeak = defineNode({
  id: 'stylize.lightLeak',
  name: 'Light Leak',
  category: 'Stylize',
  color: C,
  description: 'Procedural light leak / film burn entering from an edge of the frame: hot yellow core fading into red-orange, with organic streaks.',
  tags: ['film', 'burn', 'leak', 'lomo', 'warm'],
  inputs: img,
  params: {
    edge: { type: 'enum', default: 'right', options: ['left', 'right', 'top', 'bottom'], label: 'Edge' },
    position: { type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, label: 'Position along edge' },
    size: { type: 'float', default: 0.35, min: 0.02, max: 1.5, step: 0.01, label: 'Size' },
    intensity: { type: 'float', default: 0.8, min: 0, max: 3, step: 0.01, label: 'Intensity' },
    streaks: { type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Streaks' },
    color: { type: 'color', default: [1, 0.25, 0.04, 1], label: 'Colour' },
    hotColor: { type: 'color', default: [1, 0.78, 0.35, 1], label: 'Core colour' },
    seed: { type: 'int', default: 3, min: 0, max: 9999, step: 1, label: 'Seed' },
  },
  passes: [{
    frag: F(`
void main() {
  vec4 src = texture(u_image, v_uv);
  vec2 uv = v_uv;
  float aspect = u_resolution.x / u_resolution.y;
  float t, d;
  if (u_edge == 0) { t = uv.y; d = uv.x * aspect; }
  else if (u_edge == 1) { t = uv.y; d = (1.0 - uv.x) * aspect; }
  else if (u_edge == 2) { t = uv.x * aspect; d = uv.y; }
  else { t = uv.x * aspect; d = 1.0 - uv.y; }
  float pos = (u_edge >= 2) ? u_position * aspect : u_position;
  vec2 sd = vec2(float(u_seed) * 3.17, float(u_seed) * 1.73);
  float n1 = fbm(vec2(t * 2.5, d * 1.5) + sd, 4);
  float n2 = fbm(vec2(t * 9.0, d * 0.6) + sd * 2.1, 3);
  float along = exp(-pow((t - pos) / (u_size * (0.9 + 0.8 * n1)), 2.0));
  float across = exp(-d / (u_size * 0.55 * (0.5 + n1)));
  float L = along * across * (1.0 + u_streaks * (n2 - 0.5) * 2.0);
  L = max(L, 0.0);
  // secondary faint wash further in
  L += 0.25 * exp(-d / (u_size * 1.6)) * exp(-pow((t - pos) / (u_size * 2.2), 2.0)) * n1;
  vec3 col = mix(toLin(u_color.rgb), toLin(u_hotColor.rgb), smoothstep(0.35, 0.9, L));
  vec3 leak = col * L * u_intensity * 1.5;
  vec3 lin = toLin(src.rgb);
  lin = lin + leak * (1.0 - 0.5 * clamp(lin, 0.0, 1.0));
  fragColor = vec4(toSrgb(lin), src.a);
}`),
  }],
});

// ---------------------------------------------------------------------------
// Posterize
// ---------------------------------------------------------------------------
const posterize = defineNode({
  id: 'stylize.posterize',
  name: 'Posterize',
  category: 'Stylize',
  color: C,
  description: 'Reduces each channel (or luminance only) to a number of levels, optionally with ordered dither.',
  tags: ['levels', 'quantize', 'banding', 'retro'],
  inputs: img,
  params: {
    levels: { type: 'int', default: 6, min: 2, max: 64, step: 1, label: 'Levels' },
    mode: { type: 'enum', default: 'rgb', options: ['rgb', 'luma'], label: 'Mode', description: 'rgb: per channel; luma: quantise brightness only, keep colour.' },
    dither: { type: 'float', default: 0, min: 0, max: 1, step: 0.01, label: 'Dither' },
  },
  passes: [{
    frag: F(`
void main() {
  vec4 src = texture(u_image, v_uv);
  float n = float(max(u_levels, 2)) - 1.0;
  float t = (bayer8(pixelCoord()) - 0.5) * u_dither;
  vec3 c = clamp(src.rgb, 0.0, 1.0);
  if (u_mode == 0) c = floor(c * n + 0.5 + t) / n;
  else {
    vec3 y = rgb2ycbcr(c);
    y.x = floor(y.x * n + 0.5 + t) / n;
    c = ycbcr2rgb(y);
  }
  fragColor = vec4(clamp(c, 0.0, 1.0), src.a);
}`),
  }],
});

// ---------------------------------------------------------------------------
// Dither
// ---------------------------------------------------------------------------
const cellPx = (c: PassContext) => {
  const cells = num(c.params, 'cells', 0);
  return cells > 0 ? c.width / cells : Math.max(1, num(c.params, 'pixelSize', 2) * c.scale);
};

const dither = defineNode({
  id: 'stylize.dither',
  name: 'Dither',
  category: 'Stylize',
  color: C,
  description:
    'Retro palette reduction with ordered (Bayer) or blue-noise-like dithering. Pixel size enlarges the dither cells (nearest-neighbour), ' +
    'or set Cells to fix the horizontal resolution (e.g. 128 for a Game Boy Camera).',
  tags: ['1-bit', 'bayer', 'gameboy', 'cga', 'pixel', 'retro', '8-bit'],
  inputs: img,
  params: {
    palette: { type: 'enum', default: '1-bit', options: ['1-bit', 'grey4', 'gameboy', 'cga', 'custom2', 'rgb1bit', 'dmg'], label: 'Palette' },
    method: { type: 'enum', default: 'bayer4', options: ['bayer2', 'bayer4', 'bayer8', 'blueNoise', 'none'], label: 'Method' },
    pixelSize: { type: 'float', default: 2, min: 1, max: 64, step: 1, pixels: true, label: 'Pixel size' },
    cells: { type: 'int', default: 0, min: 0, max: 2048, step: 1, label: 'Cells across', description: 'If > 0, fixes the number of pixels across the width (overrides Pixel size).' },
    spread: { type: 'float', default: 1, min: 0, max: 1.5, step: 0.01, label: 'Dither strength' },
    brightness: { type: 'float', default: 0, min: -1, max: 1, step: 0.01, label: 'Brightness' },
    contrast: { type: 'float', default: 1, min: 0, max: 4, step: 0.01, label: 'Contrast' },
    sharpen: { type: 'float', default: 0, min: 0, max: 3, step: 0.01, label: 'Edge enhance', description: 'Sharpening at cell resolution before dithering (the Game Boy Camera did this in hardware).' },
    colorA: { type: 'color', default: [0.07, 0.06, 0.12, 1], label: 'Dark colour (custom)' },
    colorB: { type: 'color', default: [0.95, 0.9, 0.78, 1], label: 'Light colour (custom)' },
  },
  passes: [
    {
      filter: 'nearest',
      size: (c) => { const p = cellPx(c); return [Math.max(1, Math.ceil(c.width / p)), Math.max(1, Math.ceil(c.height / p))]; },
      frag: F(`
void main() {
  vec2 cell = 1.0 / u_resolution;
  vec2 o = v_uv - cell * 0.5;
  vec4 a = vec4(0.0);
  for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) a += texClamp(u_image, o + cell * (vec2(i, j) + 0.5) / 4.0);
  fragColor = a / 16.0;
}`),
    },
    {
      frag: F(`
const vec3 GB[4] = vec3[4](vec3(0.031, 0.094, 0.125), vec3(0.204, 0.408, 0.337), vec3(0.533, 0.753, 0.439), vec3(0.878, 0.973, 0.816));
const vec3 DMG[4] = vec3[4](vec3(0.059, 0.220, 0.059), vec3(0.188, 0.384, 0.188), vec3(0.545, 0.675, 0.059), vec3(0.608, 0.737, 0.059));
const vec3 CGA[4] = vec3[4](vec3(0.0), vec3(0.333, 1.0, 1.0), vec3(1.0, 0.333, 1.0), vec3(1.0));
void main() {
  vec2 cell = floor(v_uv * u_pass0_size);
  vec4 s = texelFetch(u_pass0, ivec2(cell), 0);
  vec3 nb = (texel(u_pass0, ivec2(cell) + ivec2(1, 0)).rgb + texel(u_pass0, ivec2(cell) - ivec2(1, 0)).rgb
           + texel(u_pass0, ivec2(cell) + ivec2(0, 1)).rgb + texel(u_pass0, ivec2(cell) - ivec2(0, 1)).rgb) * 0.25;
  vec3 c = s.rgb + u_sharpen * (s.rgb - nb);
  c = (c - 0.5) * u_contrast + 0.5 + u_brightness;
  float t;
  if (u_method == 0) t = bayer2(cell);
  else if (u_method == 1) t = bayer4(cell);
  else if (u_method == 2) t = bayer8(cell);
  else if (u_method == 3) t = ign(cell);
  else t = 0.5;
  t = mix(0.5, t, u_spread);
  float y = clamp(luma(c), 0.0, 1.0);
  vec3 o;
  if (u_palette == 0 || u_palette == 4) {
    float q = step(1.0 - t, y);
    o = u_palette == 0 ? vec3(q) : mix(u_colorA.rgb, u_colorB.rgb, q);
  } else if (u_palette == 1 || u_palette == 2) {
    int q = int(clamp(floor(y * 3.0 + t), 0.0, 3.0));
    o = u_palette == 1 ? vec3(float(q) / 3.0) : GB[q];
  } else if (u_palette == 3) {
    vec3 cc = clamp(c, 0.0, 1.0) + (t - 0.5) * 0.6;
    float best = 1e9; o = CGA[0];
    for (int i = 0; i < 4; i++) { vec3 d = (cc - CGA[i]) * vec3(0.3, 0.59, 0.11); float e = dot(d, d) + 0.15 * dot(cc - CGA[i], cc - CGA[i]); if (e < best) { best = e; o = CGA[i]; } }
  } else if (u_palette == 5) {
    o = step(1.0 - t, clamp(c, 0.0, 1.0));
  } else {
    o = DMG[int(clamp(floor(y * 3.0 + t), 0.0, 3.0))];
  }
  fragColor = vec4(o, s.a);
}`),
    },
  ],
});

// ---------------------------------------------------------------------------
// Halftone
// ---------------------------------------------------------------------------
const halftone = defineNode({
  id: 'stylize.halftone',
  name: 'Halftone',
  category: 'Stylize',
  color: C,
  description: 'Print halftone screen: CMYK rosette (C 15°, M 75°, Y 0°, K 45°, offset by Angle) or a single-ink mono screen.',
  tags: ['print', 'dots', 'newspaper', 'comic', 'cmyk'],
  inputs: img,
  params: {
    mode: { type: 'enum', default: 'cmyk', options: ['cmyk', 'mono'], label: 'Mode' },
    cellSize: { type: 'float', default: 8, min: 2, max: 80, step: 0.5, pixels: true, label: 'Cell size' },
    angle: { type: 'float', default: 0, min: -90, max: 90, step: 1, label: 'Angle' },
    softness: { type: 'float', default: 0.2, min: 0, max: 1, step: 0.01, label: 'Dot softness' },
    gcr: { type: 'float', default: 0.8, min: 0, max: 1, step: 0.01, label: 'Black generation' },
    paper: { type: 'color', default: [0.96, 0.94, 0.88, 1], label: 'Paper' },
    ink: { type: 'color', default: [0.1, 0.1, 0.12, 1], label: 'Ink (mono)' },
  },
  passes: [{
    frag: F(`
float cs() { return max(u_cellSize * u_scale, 1.5); }
vec2 cellCenterUV(vec2 px, float ang, out vec2 local) {
  float c = cs();
  vec2 q = rot2(ang) * px / c;
  vec2 cc = floor(q) + 0.5;
  local = (q - cc) * c;
  return (rot2(-ang) * (cc * c)) / u_resolution;
}
vec4 cmyk(vec3 rgb) {
  vec3 cmy = 1.0 - clamp(rgb, 0.0, 1.0);
  float k = min(cmy.x, min(cmy.y, cmy.z)) * u_gcr;
  return vec4((cmy - k) / max(1.0 - k, 1e-3), k);
}
float dotInk(float v, vec2 local) {
  float c = cs();
  v = clamp(v, 0.0, 1.0);
  float r = c * sqrt(v / PI) * mix(1.0, 1.2533, smoothstep(0.6, 1.0, v));
  float aa = max(0.75, u_softness * c * 0.3);
  return 1.0 - smoothstep(r - aa, r + aa, length(local));
}
vec3 smp(vec2 uv) { // slightly blurred sample of the cell area
  vec2 o = vec2(cs() * 0.25) / u_resolution;
  return (texClamp(u_image, uv + o * vec2(1, 1)).rgb + texClamp(u_image, uv + o * vec2(-1, 1)).rgb + texClamp(u_image, uv + o * vec2(1, -1)).rgb + texClamp(u_image, uv - o).rgb) * 0.25;
}
void main() {
  vec2 px = pixelCoord();
  float a0 = radians(u_angle);
  vec2 local;
  vec3 paper = u_paper.rgb;
  vec4 src = texture(u_image, v_uv);
  if (u_mode == 1) {
    vec2 uv = cellCenterUV(px, a0 + radians(45.0), local);
    float v = 1.0 - luma(smp(uv));
    fragColor = vec4(mix(paper, u_ink.rgb, dotInk(v, local)), src.a);
    return;
  }
  vec3 col = paper;
  float angs[4] = float[4](15.0, 75.0, 0.0, 45.0);
  vec3 inks[4] = vec3[4](vec3(0.0, 0.62, 0.92), vec3(0.92, 0.1, 0.55), vec3(1.0, 0.93, 0.0), vec3(0.12, 0.12, 0.14));
  for (int i = 0; i < 4; i++) {
    vec2 uv = cellCenterUV(px, a0 + radians(angs[i]), local);
    vec4 k = cmyk(smp(uv));
    float cov = dotInk(k[i], local);
    col *= mix(vec3(1.0), inks[i], cov);
  }
  fragColor = vec4(col, src.a);
}`),
  }],
});

// ---------------------------------------------------------------------------
// Scanlines
// ---------------------------------------------------------------------------
const scanlines = defineNode({
  id: 'stylize.scanlines',
  name: 'Scanlines',
  category: 'Stylize',
  color: C,
  description: 'Dark gaps between raster lines; brighter content gets fatter lines (beam bloom). Fades to its average brightness when lines get too fine to display.',
  tags: ['crt', 'tv', 'video', 'lines', 'retro'],
  inputs: img,
  params: {
    period: { type: 'float', default: 3, min: 1, max: 40, step: 0.1, pixels: true, label: 'Line period' },
    intensity: { type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, label: 'Intensity' },
    thickness: { type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Gap thickness' },
    beam: { type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Beam bloom' },
    phase: { type: 'float', default: 0, min: 0, max: 1, step: 0.01, label: 'Phase' },
    direction: { type: 'enum', default: 'horizontal', options: ['horizontal', 'vertical'], label: 'Direction' },
  },
  passes: [{
    frag: F(`
float prof(float f, float sig) { return exp(-0.5 * f * f / (sig * sig)); }
void main() {
  vec4 src = texture(u_image, v_uv);
  float per = max(u_period * u_scale, 0.1);
  float coord = (u_direction == 0 ? pixelCoord().y : pixelCoord().x) / per + u_phase;
  float f = fract(coord) - 0.5;
  float l = clamp(luma(src.rgb), 0.0, 1.0);
  float sig = mix(0.42, 0.13, u_thickness) * (1.0 + u_beam * l * 0.8);
  float m = prof(f, sig);
  float mean = 0.0;
  for (int i = 0; i < 8; i++) mean += prof((float(i) + 0.5) / 8.0 - 0.5, sig);
  mean /= 8.0;
  float fade = smoothstep(1.6, 2.8, per);
  float k = mix(mean, m, fade);
  fragColor = vec4(src.rgb * mix(1.0, k, u_intensity), src.a);
}`),
  }],
});

// ---------------------------------------------------------------------------
// CRT
// ---------------------------------------------------------------------------
const crt = defineNode({
  id: 'stylize.crt',
  name: 'CRT Monitor',
  category: 'Stylize',
  color: C,
  description: 'Curved CRT tube: barrel curvature, gaussian beam scanlines (brightness-dependent), phosphor mask (aperture grille / slot / dot), glow, vignette and rounded bezel corners.',
  tags: ['tv', 'monitor', 'retro', 'arcade', 'scanlines', 'phosphor'],
  inputs: img,
  params: {
    curvature: { type: 'float', default: 0.12, min: 0, max: 0.5, step: 0.005, label: 'Curvature' },
    lines: { type: 'float', default: 320, min: 60, max: 1200, step: 1, label: 'Scanlines', description: 'Number of raster lines over the picture height.' },
    scanlineStrength: { type: 'float', default: 0.75, min: 0, max: 1, step: 0.01, label: 'Scanline strength' },
    mask: { type: 'enum', default: 'aperture', options: ['aperture', 'slot', 'dots', 'none'], label: 'Phosphor mask' },
    maskSize: { type: 'float', default: 4, min: 1.5, max: 20, step: 0.1, pixels: true, label: 'Mask pitch' },
    maskStrength: { type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Mask strength' },
    glow: { type: 'float', default: 0.25, min: 0, max: 2, step: 0.01, label: 'Glow' },
    brightness: { type: 'float', default: 1.2, min: 0.5, max: 3, step: 0.01, label: 'Brightness' },
    vignette: { type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, label: 'Vignette' },
    corner: { type: 'float', default: 0.04, min: 0, max: 0.2, step: 0.005, label: 'Corner radius' },
  },
  passes: [
    { size: (c) => [Math.max(1, Math.ceil(c.width / 4)), Math.max(1, Math.ceil(c.height / 4))], frag: F(`
void main() {
  vec2 t = 1.0 / u_image_size;
  vec3 a = vec3(0.0);
  for (int j = -1; j <= 2; j++) for (int i = -1; i <= 2; i++) a += toLin(texture(u_image, v_uv + t * vec2(float(i) * 1.5 - 0.75, float(j) * 1.5 - 0.75)).rgb);
  fragColor = vec4(a / 16.0, 1.0);
}`) },
    { size: (c) => [Math.max(1, Math.ceil(c.width / 4)), Math.max(1, Math.ceil(c.height / 4))], frag: F(`
void main() {
  vec3 a = vec3(0.0); float ws = 0.0;
  for (int i = -8; i <= 8; i++) { float w = exp(-float(i * i) / 18.0); a += texture(u_prev, v_uv + vec2(float(i) / u_resolution.x, 0.0)).rgb * w; ws += w; }
  fragColor = vec4(a / ws, 1.0);
}`) },
    { size: (c) => [Math.max(1, Math.ceil(c.width / 4)), Math.max(1, Math.ceil(c.height / 4))], frag: F(`
void main() {
  vec3 a = vec3(0.0); float ws = 0.0;
  for (int i = -8; i <= 8; i++) { float w = exp(-float(i * i) / 18.0); a += texture(u_prev, v_uv + vec2(0.0, float(i) / u_resolution.y)).rgb * w; ws += w; }
  fragColor = vec4(a / ws, 1.0);
}`) },
    { frag: F(`
vec3 lineSample(float line, float x) {
  float y = (line + 0.5) / u_lines;
  float dx = 0.6 / u_resolution.x;
  vec3 c = toLin(texClamp(u_image, vec2(x, y)).rgb) * 0.5 + (toLin(texClamp(u_image, vec2(x - dx, y)).rgb) + toLin(texClamp(u_image, vec2(x + dx, y)).rgb)) * 0.25;
  return c;
}
vec3 beam(vec3 c, float d) {
  vec3 sig = mix(vec3(0.24), vec3(0.42), sqrt(clamp(c, 0.0, 1.0)));
  return c * exp(-0.5 * d * d / (sig * sig));
}
void main() {
  float aspect = u_resolution.x / u_resolution.y;
  vec2 cc = v_uv * 2.0 - 1.0;
  vec2 ca = cc * vec2(aspect, 1.0) / length(vec2(aspect, 1.0)) * 1.4142;
  float r2 = dot(ca, ca);
  vec2 uv = cc * (1.0 + u_curvature * r2 * 0.5) / (1.0 + u_curvature * 0.25);
  uv = uv * 0.5 + 0.5;
  // rounded-rect bezel
  vec2 q = abs(uv - 0.5) * 2.0;
  vec2 rr = vec2(u_corner / aspect, u_corner) * 2.0;
  vec2 dq = max(q - (1.0 - rr), 0.0) / max(rr, 1e-4);
  float inside = (q.x <= 1.0 && q.y <= 1.0) ? 1.0 - smoothstep(0.85, 1.0, length(dq)) : 0.0;
  float edgeAA = smoothstep(0.0, 1.5 / u_resolution.y, min(1.0 - q.x, 1.0 - q.y) * 0.5);
  inside *= edgeAA;

  float ly = uv.y * u_lines - 0.5;
  float l0 = floor(ly), f = ly - l0;
  vec3 a = lineSample(l0, uv.x), b = lineSample(l0 + 1.0, uv.x);
  vec3 scan = beam(a, f) + beam(b, 1.0 - f);
  vec3 flat_ = toLin(texClamp(u_image, uv).rgb);
  // scanlines too fine for the output fade to flat
  float linePx = u_resolution.y / u_lines;
  float sAmt = u_scanlineStrength * smoothstep(1.4, 2.6, linePx);
  vec3 col = mix(flat_ * 0.82, scan, sAmt);

  // phosphor mask (output pixel space)
  float pitch = u_maskSize * u_scale;
  vec2 px = pixelCoord();
  vec3 m = vec3(1.0);
  if (u_mask != 3) {
    float x = px.x / pitch;
    vec3 lobes = 0.5 + 0.5 * cos(TAU * (x - vec3(0.0, 1.0 / 3.0, 2.0 / 3.0)));
    lobes = pow(lobes, vec3(1.5));
    if (u_mask == 1) { // slot mask: staggered horizontal gaps
      float col_ = floor(x);
      float yy = px.y / (pitch * 1.5) + 0.5 * mod(col_, 2.0);
      lobes *= mix(0.35, 1.0, smoothstep(0.0, 0.18, abs(fract(yy) - 0.5) * -1.0 + 0.5));
    } else if (u_mask == 2) { // dot triads
      float yy = px.y / pitch * 1.732 + 0.5 * mod(floor(x), 2.0);
      lobes *= 0.55 + 0.45 * cos(TAU * yy);
    }
    float fade = smoothstep(2.2, 3.5, pitch);
    vec3 mean = vec3(u_mask == 0 ? 0.37 : 0.28);
    m = mix(vec3(1.0), mix(mean, lobes, fade) / mean * 0.75 + 0.25, u_maskStrength);
  }
  col *= m;
  col += texture(u_pass2, uv).rgb * u_glow;
  col *= u_brightness;
  // vignette
  float vg = 1.0 - u_vignette * smoothstep(0.4, 1.6, r2);
  col *= vg;
  fragColor = vec4(toSrgb(col * inside), 1.0);
}`) },
  ],
});

export default [grain, vignette, bloom, halation, lightLeak, posterize, dither, halftone, scanlines, jpeg, crt] satisfies NodeDef[];
