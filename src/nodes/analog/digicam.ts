import { defineNode } from '../../core/registry';
import type { NodeDef } from '../../core/types';
import { blurPass, F, num } from './_shared';
import { ANIMATE_PARAM, animSeed } from '../../core/motion';

const C = '#5ad1ff';
const img = { image: { type: 'image' as const } };

// ---------------------------------------------------------------------------
// Resample (sensor resolution)
// ---------------------------------------------------------------------------
const resample = defineNode({
  id: 'analog.resample',
  name: 'Sensor Resolution',
  category: 'Analog',
  color: C,
  description:
    'Changes the actual working resolution: shrink to a camera’s pixel count (e.g. 1280 px wide or 1.3 MP), or — with Reference connected — scale back up ' +
    'to the reference’s size. Following nodes then work on the low-res pixels, just like the real camera did.',
  tags: ['resize', 'downsample', 'megapixel', 'resolution', 'upscale', 'low-res'],
  inputs: { image: { type: 'image' }, reference: { type: 'image', optional: true, label: 'Reference (match size)' } },
  params: {
    mode: { type: 'enum', default: 'width', options: ['width', 'megapixels', 'factor', 'reference'], label: 'Mode' },
    width: { type: 'int', default: 1280, min: 16, max: 8192, step: 1, label: 'Width (px)' },
    megapixels: { type: 'float', default: 1.3, min: 0.01, max: 50, step: 0.01, label: 'Megapixels' },
    factor: { type: 'float', default: 0.5, min: 0.01, max: 4, step: 0.01, label: 'Factor' },
    filter: { type: 'enum', default: 'smooth', options: ['smooth', 'nearest', 'bicubic'], label: 'Filter', description: 'smooth = area average down / bilinear up.' },
    allowEnlarge: { type: 'bool', default: false, label: 'Allow enlarging', description: 'Only for width/megapixels/factor modes.' },
  },
  size: ({ params, inputSizes }) => {
    const s = inputSizes.image ?? { width: 1024, height: 768 };
    const mode = String(params.mode ?? 'width');
    if (mode === 'reference' && inputSizes.reference) return [inputSizes.reference.width, inputSizes.reference.height];
    let f = 1;
    if (mode === 'width') f = num(params, 'width', 1280) / s.width;
    else if (mode === 'megapixels') f = Math.sqrt((num(params, 'megapixels', 1.3) * 1e6) / (s.width * s.height));
    else if (mode === 'factor') f = num(params, 'factor', 0.5);
    if (!params.allowEnlarge) f = Math.min(f, 1);
    return [Math.max(1, Math.round(s.width * f)), Math.max(1, Math.round(s.height * f))];
  },
  passes: [{
    frag: F(`
float cr(float x) { x = abs(x); return x < 1.0 ? 1.5 * x * x * x - 2.5 * x * x + 1.0 : x < 2.0 ? -0.5 * x * x * x + 2.5 * x * x - 4.0 * x + 2.0 : 0.0; }
void main() {
  vec2 ratio = u_image_size / u_resolution;
  if (u_filter == 1) { fragColor = texelFetch(u_image, ivec2(floor(v_uv * u_image_size)), 0); return; }
  if (ratio.x > 1.01 || ratio.y > 1.01) { // area average
    vec2 n = clamp(ceil(ratio), 1.0, 8.0);
    vec2 cell = 1.0 / u_resolution;
    vec4 a = vec4(0.0);
    for (int j = 0; j < 8; j++) for (int i = 0; i < 8; i++) {
      if (float(i) >= n.x || float(j) >= n.y) continue;
      a += texture(u_image, v_uv - cell * 0.5 + cell * (vec2(i, j) + 0.5) / n);
    }
    fragColor = a / (n.x * n.y);
    return;
  }
  if (u_filter == 2) { // Catmull-Rom
    vec2 p = v_uv * u_image_size - 0.5;
    vec2 i0 = floor(p), f = p - i0;
    vec4 a = vec4(0.0); float ws = 0.0;
    for (int j = -1; j <= 2; j++) for (int i = -1; i <= 2; i++) {
      float w = cr(float(i) - f.x) * cr(float(j) - f.y);
      a += texel(u_image, ivec2(i0) + ivec2(i, j)) * w; ws += w;
    }
    fragColor = a / ws;
    return;
  }
  fragColor = texture(u_image, v_uv);
}`),
  }],
});

// ---------------------------------------------------------------------------
// CCD sensor
// ---------------------------------------------------------------------------
const ccdSensor = defineNode({
  id: 'analog.ccdSensor',
  name: 'CCD Sensor',
  category: 'Analog',
  color: C,
  description:
    'Early-2000s compact-camera sensor: small dynamic range (crushed shadows, hard per-channel highlight clipping with the hue shift that brings — cyan skies, yellow skin), ' +
    'blotchy chroma noise in the shadows and faint fixed-pattern column noise.',
  tags: ['digicam', 'ccd', 'noise', 'clipping', 'y2k', 'compact camera'],
  inputs: img,
  params: {
    exposure: { type: 'float', default: 0.25, min: -3, max: 3, step: 0.01, label: 'Exposure (stops)' },
    clipShift: { type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, label: 'Clipping hue shift', description: 'Channels saturate at different levels (blue first, then green).' },
    contrast: { type: 'float', default: 0.45, min: 0, max: 1, step: 0.01, label: 'Contrast' },
    blackCrush: { type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, label: 'Black crush' },
    chromaNoise: { type: 'float', default: 0.5, min: 0, max: 2, step: 0.01, label: 'Chroma noise' },
    lumaNoise: { type: 'float', default: 0.3, min: 0, max: 2, step: 0.01, label: 'Luma noise' },
    noiseSize: { type: 'float', default: 2, min: 0.5, max: 10, step: 0.1, pixels: true, label: 'Noise blotch size' },
    fixedPattern: { type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, label: 'Fixed-pattern noise' },
    seed: { type: 'int', default: 5, min: 0, max: 9999, step: 1, label: 'Seed' },
    animate: ANIMATE_PARAM,
  },
  passes: [{
    uniforms: (c) => animSeed(c, 5), // fresh sensor noise every frame in motion
    frag: F(`
void main() {
  vec4 src = texture(u_image, v_uv);
  vec3 lin = toLin(src.rgb) * exp2(u_exposure);
  // per-channel full-well: blue clips first, then green
  vec3 well = 1.0 - u_clipShift * vec3(0.0, 0.06, 0.16);
  lin = min(lin, well) / well.r;
  // near-clipping regions bleach slightly towards the clipped channels
  float mx = max(lin.r, max(lin.g, lin.b));
  lin = mix(lin, vec3(mx), smoothstep(0.92, 1.0, mx) * 0.4);
  vec3 c = toSrgb(lin);
  // limited DR tone curve: crushed toe, steep mids
  float bc = u_blackCrush * 0.08;
  c = max(c - bc, 0.0) / (1.0 - bc);
  c = mix(c, c * c * (3.0 - 2.0 * c), u_contrast);
  float l = luma(c);
  // noise (scale-aware)
  float s = max(u_noiseSize * u_scale, 0.3);
  vec2 sd = vec2(float(u_seed) * 13.1, float(u_seed) * 5.7);
  vec2 p = pixelCoord() / s + sd;
  vec3 n = vec3(gnoise(p), gnoise(p + 37.7), gnoise(p + 91.3));
  float nl = dot(n, vec3(0.299, 0.587, 0.114));
  vec3 chroma = n - nl;
  float fine = gaussRand(pixelCoord() + sd * 3.0) * min(1.0, u_scale);
  float shadow = 1.0 - smoothstep(0.02, 0.55, l);
  float att = min(1.0, s);
  c += chroma * u_chromaNoise * 0.16 * (0.15 + shadow) * att * smoothstep(0.0, 0.06, l + 0.02);
  c += (nl * 0.5 + fine * 0.5) * u_lumaNoise * 0.05 * (0.3 + shadow);
  // fixed pattern: column offsets (full-res columns) with a slight green/magenta bias
  float col = floor(pixelCoord().x / u_scale);
  float fp = (hash11(col * 0.731 + float(u_seed)) - 0.5) * u_fixedPattern * 0.035 * shadow;
  c += fp * vec3(1.0, 0.7, 1.1);
  fragColor = vec4(clamp(c, 0.0, 1.0), src.a);
}`),
  }],
});

// ---------------------------------------------------------------------------
// CCD smear
// ---------------------------------------------------------------------------
const ccdSmear = defineNode({
  id: 'analog.ccdSmear',
  name: 'CCD Smear',
  category: 'Analog',
  color: C,
  description:
    'Interline-CCD smear: very bright highlights (sun, lamps, specular glints) leak charge into their whole column during read-out, ' +
    'drawing vertical bright streaks through the frame, plus blooming that spreads up/down from the overexposed spot.',
  tags: ['ccd', 'digicam', 'streak', 'vertical', 'highlights', 'sun'],
  inputs: img,
  params: {
    threshold: { type: 'float', default: 0.97, min: 0.5, max: 1, step: 0.005, label: 'Threshold' },
    smear: { type: 'float', default: 0.6, min: 0, max: 3, step: 0.01, label: 'Smear' },
    bloom: { type: 'float', default: 0.5, min: 0, max: 3, step: 0.01, label: 'Blooming' },
    bloomLength: { type: 'float', default: 120, min: 2, max: 1000, step: 1, pixels: true, label: 'Blooming length' },
    tint: { type: 'color', default: [1, 0.86, 1, 1], label: 'Tint' },
  },
  passes: [
    { // 0: per-column energy of clipped highlights, with local (spot) emphasis
      size: (c) => [c.width, 1],
      frag: F(`
void main() {
  float e = 0.0;
  for (int i = 0; i < 384; i++) {
    float y = (float(i) + 0.5) / 384.0;
    // fully clipped (white) and not a tiny glint: the minimum over a small cross must be clipped too
    vec2 r = vec2(0.004, 0.004 * u_image_size.x / u_image_size.y);
    vec3 c = min(min(texture(u_image, vec2(v_uv.x, y)).rgb, min(texture(u_image, vec2(v_uv.x - r.x, y)).rgb, texture(u_image, vec2(v_uv.x + r.x, y)).rgb)),
                 min(texture(u_image, vec2(v_uv.x, y - r.y)).rgb, texture(u_image, vec2(v_uv.x, y + r.y)).rgb));
    float l = min(c.r, min(c.g, c.b));
    float m = smoothstep(u_threshold, 1.0, l);
    if (m > 0.0) { // only compact sources: the surroundings must be darker
      // compact sources only: at least ~3 of the 4 directions (left/right/up/down) must be clearly darker
      float asp = u_image_size.x / u_image_size.y;
      vec4 br = vec4(0.0);
      for (int k = 1; k <= 2; k++) {
        float dx = float(k) * 0.02, dy = dx * asp;
        br = max(br, vec4(luma(texture(u_image, vec2(v_uv.x - dx, y)).rgb), luma(texture(u_image, vec2(v_uv.x + dx, y)).rgb),
                          luma(texture(u_image, vec2(v_uv.x, y - dy)).rgb), luma(texture(u_image, vec2(v_uv.x, y + dy)).rgb)));
      }
      vec4 dk = 1.0 - smoothstep(vec4(0.6), vec4(0.85), br);
      m *= smoothstep(2.2, 3.0, dk.x + dk.y + dk.z + dk.w);
    }
    e += m;
  }
  fragColor = vec4(vec3(e / 384.0), 1.0);
}`),
    },
    { // 1: column energy minus its wide neighbourhood -> streaks rather than haze
      size: (c) => [c.width, 1],
      frag: F(`
void main() {
  float e = texture(u_prev, v_uv).r;
  float wide = 0.0;
  for (int i = -16; i <= 16; i++) wide += texture(u_prev, v_uv + vec2(float(i) * 0.006, 0.0)).r;
  wide /= 33.0;
  float k = max(e - 0.5 * wide, 0.0);
  // point sources give streaks; when everything around is clipped too (sky) there is no visible streak
  k *= 1.0 - smoothstep(0.05, 0.3, wide);
  fragColor = vec4(vec3(1.0 - exp(-k * 40.0)), 1.0);
}`),
    },
    { // 2: blooming — vertical exponential spread of the overexposed spots
      frag: F(`
void main() {
  float L = max(u_bloomLength * u_scale, 1.0);
  float acc = 0.0, ws = 0.0;
  for (int i = -40; i <= 40; i++) {
    float t = float(i) / 40.0;
    float y = t * L * 1.5;
    vec3 c = texture(u_image, v_uv + vec2(0.0, y / u_resolution.y)).rgb;
    float m = smoothstep(u_threshold, 1.0, min(c.r, min(c.g, c.b)));
    float w = exp(-abs(y) / L * 3.0);
    acc += m * w; ws += w;
  }
  vec3 c0 = texture(u_image, v_uv).rgb;
  float here = smoothstep(u_threshold, 1.0, min(c0.r, min(c0.g, c0.b)));
  // charge spills only into neighbours of a small clipped spot
  fragColor = vec4(vec3(max(acc / ws - here, 0.0) * (1.0 - smoothstep(0.3, 0.7, acc / ws))), 1.0);
}`),
    },
    {
      frag: F(`
void main() {
  vec4 src = texture(u_image, v_uv);
  vec2 t = vec2(0.75 / u_resolution.x, 0.0);
  float sm = (texture(u_pass1, v_uv).r * 2.0 + texture(u_pass1, v_uv - t).r + texture(u_pass1, v_uv + t).r) * 0.25;
  float bl = texture(u_pass2, v_uv).r;
  vec3 lin = toLin(src.rgb);
  lin += toLin(u_tint.rgb) * (sm * u_smear * 0.8 + bl * u_bloom);
  fragColor = vec4(toSrgb(lin), src.a);
}`),
    },
  ],
});

// ---------------------------------------------------------------------------
// Purple fringing
// ---------------------------------------------------------------------------
const purpleFringe = defineNode({
  id: 'analog.purpleFringe',
  name: 'Purple Fringing',
  category: 'Analog',
  color: C,
  description: 'Purple/blue fringes on the dark side of high-contrast edges next to bright highlights (branches against the sky) — the signature of cheap small-sensor lenses.',
  tags: ['fringe', 'chromatic', 'aberration', 'digicam', 'ccd', 'edges'],
  inputs: img,
  params: {
    amount: { type: 'float', default: 0.8, min: 0, max: 2, step: 0.01, label: 'Amount' },
    threshold: { type: 'float', default: 0.8, min: 0.3, max: 1, step: 0.01, label: 'Highlight threshold' },
    radius: { type: 'float', default: 4, min: 0.5, max: 40, step: 0.1, pixels: true, label: 'Width' },
    color: { type: 'color', default: [0.55, 0.2, 1, 1], label: 'Fringe colour' },
  },
  passes: [
    { frag: F(`void main(){ vec3 c = texture(u_image, v_uv).rgb; fragColor = vec4(vec3(smoothstep(u_threshold, min(u_threshold + 0.15, 1.0), luma(c))), 1.0); }`) },
    blurPass('x', 'u_radius * u_scale'),
    blurPass('y', 'u_radius * u_scale'),
    {
      frag: F(`
void main() {
  vec4 src = texture(u_image, v_uv);
  float m = texture(u_pass2, v_uv).r;
  float here = texture(u_pass0, v_uv).r;
  float l = luma(src.rgb);
  float edge = clamp(m * 2.2, 0.0, 1.0) * (1.0 - here) * (1.0 - smoothstep(0.35, 0.85, l));
  float f = clamp(edge * u_amount, 0.0, 1.0);
  vec3 fc = u_color.rgb * (0.35 + 0.65 * m);
  vec3 c = mix(src.rgb, max(src.rgb, fc) * 0.6 + fc * 0.4, f);
  fragColor = vec4(c, src.a);
}`),
    },
  ],
});

// ---------------------------------------------------------------------------
// Camera sharpening (halo-y)
// ---------------------------------------------------------------------------
const edgeEnhance = defineNode({
  id: 'analog.edgeEnhance',
  name: 'In-camera Sharpening',
  category: 'Analog',
  color: C,
  description: 'Aggressive consumer-camera unsharp mask on luminance: crunchy detail with bright/dark halos around edges (the “over-sharpened digicam / camcorder” look).',
  tags: ['sharpen', 'halo', 'digicam', 'unsharp', 'oversharpened'],
  inputs: img,
  params: {
    amount: { type: 'float', default: 1.2, min: 0, max: 5, step: 0.01, label: 'Amount' },
    radius: { type: 'float', default: 1.5, min: 0.3, max: 20, step: 0.1, pixels: true, label: 'Radius' },
    threshold: { type: 'float', default: 0.01, min: 0, max: 0.2, step: 0.001, label: 'Threshold' },
    halo: { type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, label: 'Halo clipping', description: 'How far halos may overshoot (1 = hard white/black halos).' },
  },
  passes: [
    { frag: F(`void main(){ fragColor = vec4(vec3(luma(texture(u_image, v_uv).rgb)), 1.0); }`) },
    blurPass('x', 'u_radius * u_scale'),
    blurPass('y', 'u_radius * u_scale'),
    {
      frag: F(`
void main() {
  vec4 src = texture(u_image, v_uv);
  float y = texture(u_pass0, v_uv).r;
  float b = texture(u_pass2, v_uv).r;
  float d = y - b;
  d = sign(d) * max(abs(d) - u_threshold, 0.0);
  float boost = d * u_amount;
  float lim = mix(0.08, 0.6, u_halo);
  boost = clamp(boost, -lim, lim);
  fragColor = vec4(src.rgb + boost, src.a);
}`),
    },
  ],
});

// ---------------------------------------------------------------------------
// Flash
// ---------------------------------------------------------------------------
const flash = defineNode({
  id: 'analog.flash',
  name: 'Direct Flash',
  category: 'Analog',
  color: C,
  description:
    'On-camera direct flash: a hotspot that falls off fast towards dark corners (inverse-square-ish), bright near subjects blowing out, ' +
    'underexposed warm ambient background, and harsh contrast.',
  tags: ['flash', 'party', 'disposable', 'point and shoot', 'night', 'hotspot'],
  inputs: img,
  params: {
    strength: { type: 'float', default: 0.75, min: 0, max: 2, step: 0.01, label: 'Flash strength' },
    falloff: { type: 'float', default: 0.55, min: 0.05, max: 1.5, step: 0.01, label: 'Falloff radius' },
    center: { type: 'vec2', default: [0.5, 0.45], min: 0, max: 1, step: 0.01, label: 'Centre' },
    ambient: { type: 'float', default: 0.45, min: 0, max: 1, step: 0.01, label: 'Ambient level', description: 'How much of the existing light remains outside the flash.' },
    ambientWarmth: { type: 'float', default: 0.3, min: -1, max: 1, step: 0.01, label: 'Ambient warmth' },
    subjectBoost: { type: 'float', default: 0.6, min: 0, max: 2, step: 0.01, label: 'Near-subject overexposure', description: 'Bright, central areas are treated as close to the flash and blow out.' },
    contrast: { type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, label: 'Harshness' },
    color: { type: 'color', default: [1, 0.98, 0.96, 1], label: 'Flash colour' },
  },
  passes: [
    { size: (c) => [Math.max(1, Math.ceil(c.width / 8)), Math.max(1, Math.ceil(c.height / 8))], frag: F(`
void main(){ vec2 t = 2.0 / u_image_size; vec3 a = vec3(0.0);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) a += texture(u_image, v_uv + t * vec2(i, j)).rgb;
  fragColor = vec4(a / 9.0, 1.0); }`) },
    blurPass('x', '6.0', (c) => [Math.max(1, Math.ceil(c.width / 8)), Math.max(1, Math.ceil(c.height / 8))]),
    blurPass('y', '6.0', (c) => [Math.max(1, Math.ceil(c.width / 8)), Math.max(1, Math.ceil(c.height / 8))]),
    {
      frag: F(`
void main() {
  vec4 src = texture(u_image, v_uv);
  float aspect = u_resolution.x / u_resolution.y;
  vec2 q = (v_uv - u_center) * vec2(aspect, 1.0);
  float d = length(q) / u_falloff;
  float fl = 1.0 / (1.0 + d * d * 2.5);          // inverse-square-ish
  fl *= 1.0 - smoothstep(0.9, 2.2, d) * 0.6;
  // "nearness" proxy: smooth local brightness, more so towards the centre
  float near = smoothstep(0.25, 0.85, luma(texture(u_pass2, v_uv).rgb)) * fl;
  vec3 lin = toLin(src.rgb);
  vec3 warm = mix(vec3(1.0), vec3(1.15, 0.97, 0.75), max(u_ambientWarmth, 0.0));
  warm = mix(warm, vec3(0.85, 0.95, 1.15), max(-u_ambientWarmth, 0.0));
  float gain = u_ambient + u_strength * 2.2 * fl * (1.0 + u_subjectBoost * near * 1.5);
  vec3 lit = lin * mix(warm, u_color.rgb, clamp(u_strength * fl * 1.5, 0.0, 1.0)) * gain;
  vec3 c = toSrgb(lit);
  // harsh contrast: S-curve + dark toe
  vec3 sc = c * c * (3.0 - 2.0 * c);
  c = mix(c, clamp(sc, 0.0, 1.0), u_contrast) - u_contrast * 0.03;
  // highlight roll into white for blown areas
  float mx = max(c.r, max(c.g, c.b));
  c = mix(c, vec3(1.0), smoothstep(1.0, 1.4, mx) * 0.6);
  fragColor = vec4(clamp(c, 0.0, 1.0), src.a);
}`),
    },
  ],
});

// ---------------------------------------------------------------------------
// Lens softness
// ---------------------------------------------------------------------------
const lensSoftness = defineNode({
  id: 'analog.lensSoftness',
  name: 'Cheap Lens',
  category: 'Analog',
  color: C,
  description:
    'Plastic/fixed-focus lens: sharp-ish centre, corners smeared with astigmatic (tangential) blur, optional barrel distortion and lateral chromatic aberration growing towards the edges.',
  tags: ['lens', 'soft', 'corners', 'toy camera', 'disposable', 'lomo', 'holga', 'blur'],
  inputs: img,
  params: {
    softness: { type: 'float', default: 6, min: 0, max: 60, step: 0.1, pixels: true, label: 'Corner blur' },
    centerBlur: { type: 'float', default: 0.6, min: 0, max: 20, step: 0.1, pixels: true, label: 'Centre blur' },
    sharpArea: { type: 'float', default: 0.35, min: 0, max: 1.4, step: 0.01, label: 'Sharp area' },
    smear: { type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, label: 'Astigmatic smear' },
    distortion: { type: 'float', default: 0, min: -0.5, max: 0.5, step: 0.005, label: 'Barrel distortion' },
    chromatic: { type: 'float', default: 0, min: 0, max: 30, step: 0.1, pixels: true, label: 'Chromatic aberration' },
  },
  passes: [{
    frag: F(`
vec3 tap(vec2 uv, vec2 rd, float ca) {
  vec2 o = rd * ca / u_resolution;
  return vec3(texClamp(u_image, uv + o).r, texClamp(u_image, uv).g, texClamp(u_image, uv - o).b);
}
void main() {
  float aspect = u_resolution.x / u_resolution.y;
  vec2 cc = v_uv - 0.5;
  vec2 ca_ = cc * vec2(aspect, 1.0);
  float r = length(ca_) / (0.5 * length(vec2(aspect, 1.0))); // 0 centre .. 1 corner
  float r2 = r * r;
  vec2 suv = 0.5 + cc * (1.0 + u_distortion * (r2 - 1.0));
  vec2 rd = length(ca_) > 1e-5 ? normalize(ca_) : vec2(1.0, 0.0);
  vec2 rdPix = rd; // radial dir in pixel space
  vec2 td = vec2(-rdPix.y, rdPix.x);
  float k = smoothstep(u_sharpArea, 1.05, r);
  float R = (u_centerBlur + (u_softness - u_centerBlur) * k * k) * u_scale;
  float ca = u_chromatic * u_scale * r2;
  vec3 acc = vec3(0.0); float ws = 0.0;
  if (R < 0.4) { acc = toLin(tap(suv, rdPix, ca)); ws = 1.0; }
  else {
    for (int i = 0; i < 32; i++) {
      float fi = float(i) + 0.5;
      float rr = sqrt(fi / 32.0);
      float th = fi * 2.39996323;
      vec2 o = vec2(cos(th), sin(th)) * rr;
      vec2 off = rdPix * dot(o, rdPix) * (1.0 - u_smear * 0.75) + td * dot(o, td) * (1.0 + u_smear * 0.6);
      off *= R;
      acc += toLin(tap(suv + off / u_resolution, rdPix, ca));
      ws += 1.0;
    }
  }
  vec4 src = texture(u_image, v_uv);
  fragColor = vec4(toSrgb(acc / ws), src.a);
}`),
  }],
});

export default [resample, ccdSensor, ccdSmear, purpleFringe, edgeEnhance, flash, lensSoftness] satisfies NodeDef[];
