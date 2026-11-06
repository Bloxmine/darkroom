/** Optical / lens effects. */
import { defineNode } from '../../core/registry';
import type { NodeDef, PassContext } from '../../core/types';
import { FE } from './_shared';

const C = '#6fd3e0';
const img = { image: { type: 'image' as const } };
const half = (c: PassContext): [number, number] => [Math.max(1, Math.ceil(c.width / 2)), Math.max(1, Math.ceil(c.height / 2))];
const quarter = (c: PassContext): [number, number] => [Math.max(1, Math.ceil(c.width / 4)), Math.max(1, Math.ceil(c.height / 4))];

// ---------------------------------------------------------------------------
// Tilt-shift
// ---------------------------------------------------------------------------
const tiltShift = defineNode({
  id: 'effects.tiltShift',
  name: 'Tilt-Shift',
  category: 'Optical',
  color: C,
  description:
    'Fake miniature: a sharp focus band with lens blur (disc bokeh, bright highlights bloom into discs) growing smoothly away from it, ' +
    'plus the saturation/contrast boost that sells the toy-model look.',
  tags: ['tilt shift', 'miniature', 'toy', 'bokeh', 'blur', 'lens', 'diorama', 'depth of field'],
  inputs: { ...img, depth: { type: 'mask', optional: true, label: 'Depth (optional)' } },
  params: {
    center: { type: 'float', default: 0.6, min: 0, max: 1, step: 0.005, label: 'Focus position' },
    focusDepth: { type: 'float', default: 0.5, min: 0, max: 1, step: 0.005, label: 'Focus depth', description: 'With a depth map connected (near = white): the depth kept sharp; width/falloff then apply in depth.' },
    angle: { type: 'float', default: 0, min: -90, max: 90, step: 1, label: 'Band angle' },
    width: { type: 'float', default: 0.12, min: 0, max: 1, step: 0.005, label: 'Sharp band width' },
    falloff: { type: 'float', default: 0.35, min: 0.01, max: 1, step: 0.005, label: 'Falloff' },
    blur: { type: 'float', default: 18, min: 0, max: 100, step: 0.5, pixels: true, label: 'Max blur', description: 'Blur radius in full-res px at the far edges.' },
    bokeh: { type: 'float', default: 0.6, min: 0, max: 2, step: 0.01, label: 'Bokeh highlights' },
    saturation: { type: 'float', default: 1.35, min: 0, max: 3, step: 0.01, label: 'Saturation' },
    contrast: { type: 'float', default: 1.12, min: 0, max: 2, step: 0.01, label: 'Contrast' },
    showMask: { type: 'bool', default: false, label: 'Show focus mask' },
  },
  passes: [{
    frag: FE(`
float blurAmt(vec2 uv) {
  // depth input connected (an unconnected optional input is a 1x1 fallback)
  if (u_depth_size.x > 1.5) return smoothstep(u_width * 0.5, u_width * 0.5 + u_falloff, abs(texture(u_depth, uv).r - u_focusDepth));
  vec2 asp = vec2(u_resolution.x / u_resolution.y, 1.0);
  vec2 d = vec2(sin(radians(u_angle)), cos(radians(u_angle)));
  float dist = abs(dot((uv - vec2(0.5, u_center)) * asp, d));
  return smoothstep(u_width * 0.5, u_width * 0.5 + u_falloff, dist);
}
void main() {
  vec4 src = texture(u_image, v_uv);
  float k = blurAmt(v_uv);
  if (u_showMask) { fragColor = vec4(vec3(1.0 - k), 1.0); return; }
  float R = u_blur * u_scale * k;
  vec3 acc = vec3(0.0); float ws = 0.0;
  if (R < 0.5) { acc = srgbToLinear(src.rgb); ws = 1.0; }
  else {
    const int N = 72;
    float rot = ign(pixelCoord()) * TAU;
    for (int i = 0; i < N; i++) {
      float r = sqrt((float(i) + 0.5) / float(N));
      float a = float(i) * 2.39996323 + rot;
      vec2 o = vec2(cos(a), sin(a)) * r * R;
      vec2 uv = v_uv + o / u_resolution;
      // don't pull sharp foreground into blurred areas
      float kk = blurAmt(uv);
      vec3 c = srgbToLinear(texClamp(u_image, uv).rgb);
      float w = (1.0 + u_bokeh * 6.0 * pow(luma(c), 3.0)) * mix(0.15, 1.0, smoothstep(0.0, 0.3, kk));
      acc += c * w; ws += w;
    }
  }
  vec3 c = linearToSrgb(acc / ws);
  c = (c - 0.5) * u_contrast + 0.5;
  float L = luma(c);
  c = mix(vec3(L), c, u_saturation);
  fragColor = vec4(clamp(c, 0.0, 1.0), src.a);
}`),
  }],
});

// ---------------------------------------------------------------------------
// Zoom blur & spin blur (two-pass sampling: N×N effective taps)
// ---------------------------------------------------------------------------
const radialFrag = (kind: 'zoom' | 'spin', second: boolean) => FE(`
const int N = 24;
void main() {
  vec2 asp = vec2(u_resolution.x / u_resolution.y, 1.0);
  vec2 c = u_center;
  vec2 d = (v_uv - c) * asp;
  float r = length(d);
  float mask = smoothstep(u_clear, u_clear + 0.25, r);
  float total = ${kind === 'zoom' ? 'u_amount' : 'radians(u_angle)'} * mask;
  float span = ${second ? 'total / float(N)' : 'total'};
  float jit = ${second ? '0.5' : 'ign(pixelCoord())'};
  vec3 acc = vec3(0.0); float ws = 0.0;
  for (int i = 0; i < N; i++) {
    float t = (float(i) + jit) / float(N);
    ${kind === 'zoom'
      ? `float s = 1.0 - span * t;
    vec2 uv = c + d * s / asp;`
      : `float a = span * (t - 0.5);
    vec2 uv = c + (mat2(cos(a), sin(a), -sin(a), cos(a)) * d) / asp;`}
    vec3 col = ${second ? 'texClamp(u_prev, uv).rgb' : 'srgbToLinear(texClamp(u_image, uv).rgb)'};
    float w = 1.0 ${second ? '' : '+ u_highlights * 4.0 * pow(luma(col), 3.0)'};
    acc += col * w; ws += w;
  }
  vec3 o = acc / ws;
  ${second ? 'fragColor = vec4(linearToSrgb(o), texture(u_image, v_uv).a);' : 'fragColor = vec4(o, 1.0);'}
}`);

const zoomBlur = defineNode({
  id: 'effects.zoomBlur',
  name: 'Zoom Blur',
  category: 'Optical',
  color: C,
  description: 'Radial "zoom burst" blur toward a centre point, as if zooming the lens during the exposure. Two-pass sampling for smooth streaks, highlights streak brighter.',
  tags: ['zoom', 'radial', 'burst', 'motion', 'speed', 'blur', 'warp'],
  inputs: img,
  params: {
    center: { type: 'vec2', default: [0.5, 0.5], min: 0, max: 1, step: 0.005, label: 'Centre' },
    amount: { type: 'float', default: 0.18, min: 0, max: 0.9, step: 0.005, label: 'Amount', description: 'Fraction of the distance to the centre that is smeared.' },
    clear: { type: 'float', default: 0.05, min: 0, max: 1, step: 0.01, label: 'Clear centre' },
    highlights: { type: 'float', default: 0.5, min: 0, max: 2, step: 0.01, label: 'Highlight streaks' },
  },
  passes: [{ frag: radialFrag('zoom', false) }, { frag: radialFrag('zoom', true) }],
});

const radialBlur = defineNode({
  id: 'effects.radialBlur',
  name: 'Spin Blur',
  category: 'Optical',
  color: C,
  description: 'Rotational (spin) blur around a centre point, like a camera rotated during the exposure or a spinning wheel.',
  tags: ['spin', 'radial', 'rotate', 'swirl', 'motion', 'blur', 'wheel'],
  inputs: img,
  params: {
    center: { type: 'vec2', default: [0.5, 0.5], min: 0, max: 1, step: 0.005, label: 'Centre' },
    angle: { type: 'float', default: 12, min: 0, max: 180, step: 0.1, label: 'Angle (°)' },
    clear: { type: 'float', default: 0.0, min: 0, max: 1, step: 0.01, label: 'Clear centre' },
    highlights: { type: 'float', default: 0.5, min: 0, max: 2, step: 0.01, label: 'Highlight streaks' },
  },
  passes: [{ frag: radialFrag('spin', false) }, { frag: radialFrag('spin', true) }],
});

// ---------------------------------------------------------------------------
// Lens flare
// ---------------------------------------------------------------------------
const lensFlare = defineNode({
  id: 'effects.lensFlare',
  name: 'Lens Flare',
  category: 'Optical',
  color: C,
  description:
    'Procedural lens flare from a light position: glow, starburst from the aperture blades, anamorphic streak, halo ring, and a chain of tinted aperture-shaped ghosts ' +
    'mirrored through the image centre with chromatic fringes. Optionally adds image-based ghosts from the picture\'s own highlights.',
  tags: ['flare', 'lens', 'sun', 'ghost', 'anamorphic', 'streak', 'abrams', 'light'],
  inputs: img,
  params: {
    position: { type: 'vec2', default: [0.72, 0.22], min: -0.5, max: 1.5, step: 0.005, label: 'Light position' },
    intensity: { type: 'float', default: 1, min: 0, max: 4, step: 0.01, label: 'Intensity' },
    glow: { type: 'float', default: 0.6, min: 0, max: 2, step: 0.01, label: 'Glow' },
    starburst: { type: 'float', default: 0.6, min: 0, max: 2, step: 0.01, label: 'Starburst' },
    blades: { type: 'int', default: 6, min: 3, max: 12, step: 1, label: 'Aperture blades' },
    streak: { type: 'float', default: 0.4, min: 0, max: 2, step: 0.01, label: 'Anamorphic streak' },
    halo: { type: 'float', default: 0.35, min: 0, max: 2, step: 0.01, label: 'Halo ring' },
    ghosts: { type: 'float', default: 0.6, min: 0, max: 2, step: 0.01, label: 'Ghosts' },
    imageGhosts: { type: 'float', default: 0, min: 0, max: 2, step: 0.01, label: 'Ghosts from highlights' },
    tint: { type: 'color', default: [1, 0.85, 0.65, 1], label: 'Light colour' },
    seed: { type: 'int', default: 3, min: 0, max: 9999, step: 1, label: 'Seed' },
  },
  passes: [
    { // 0: bright pass at quarter res
      size: quarter,
      frag: FE(`
void main() {
  vec2 t = 1.0 / u_resolution;
  vec3 c = vec3(0.0);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) c += srgbToLinear(texClamp(u_image, v_uv + vec2(i, j) * t).rgb);
  c /= 9.0;
  float L = luma(c);
  fragColor = vec4(c * smoothstep(0.55, 0.95, L), 1.0);
}`),
    },
    {
      frag: FE(`
float polyDist(vec2 p, float n, float rot) { // regular polygon "radius" (aperture shape)
  float a = atan(p.y, p.x) + rot;
  float seg = TAU / n;
  float b = mod(a + seg * 0.5, seg) - seg * 0.5;
  return length(p) * cos(b) / cos(seg * 0.5);
}
void main() {
  vec4 src = texture(u_image, v_uv);
  vec2 asp = vec2(u_resolution.x / u_resolution.y, 1.0);
  vec2 p = (v_uv - 0.5) * asp;
  vec2 L = (u_position - 0.5) * asp;
  vec2 d = p - L;
  float r = length(d);
  float sd = float(u_seed);
  vec3 tint = u_tint.rgb;
  vec3 f = vec3(0.0);
  // core glow
  f += tint * (exp(-r * 28.0) * 1.5 + exp(-r * 6.0) * 0.25) * u_glow;
  // starburst: thin rays at multiples of the blade count, with random lengths
  float a = atan(d.y, d.x);
  float n = float(u_blades) * 2.0;
  float ray = pow(abs(cos(a * n * 0.5)), 60.0);
  float fine = pow(abs(cos(a * 37.0 + sd)), 30.0) * 0.35 + valueNoise(vec2(a * 20.0, sd)) * 0.15;
  f += tint * (ray + fine) * (exp(-r * 9.0) * 0.8 + exp(-r * 3.0) * 0.08) * u_starburst;
  // anamorphic streak (horizontal)
  f += mix(tint, vec3(0.5, 0.7, 1.0), 0.6) * exp(-abs(d.y) * 220.0) * exp(-abs(d.x) * 1.4) * 0.7 * u_streak;
  // halo ring around the image centre-mirrored axis
  float ring = exp(-pow((r - 0.42) * 18.0, 2.0));
  vec3 rainbow = 0.5 + 0.5 * cos(TAU * (r * 2.2 + vec3(0.0, 0.33, 0.67)));
  f += rainbow * ring * 0.12 * u_halo;
  // ghosts along the line through the centre
  for (int i = 0; i < 7; i++) {
    float fi = float(i);
    float t = mix(-1.3, 0.85, hash11(fi * 3.7 + sd)) ;
    vec2 gp = L * t;                                   // position on the axis (mirror for t < 0)
    float sz = 0.02 + 0.09 * hash11(fi * 5.1 + sd + 1.0);
    vec3 gc = 0.5 + 0.5 * cos(TAU * (hash11(fi + sd * 2.0) + vec3(0.0, 0.25, 0.5)));
    for (int ch = 0; ch < 3; ch++) {
      float ca = 1.0 + (float(ch) - 1.0) * 0.03;      // chromatic size split
      float pd = polyDist(p - gp, float(u_blades), 0.3 + sd) / (sz * ca);
      float disc = smoothstep(1.0, 0.9, pd) * (0.35 + 0.65 * smoothstep(0.2, 1.0, pd));
      f[ch] += disc * gc[ch] * 0.22 * u_ghosts * (0.4 + hash11(fi * 9.1 + sd));
    }
  }
  // image-based ghosts from the picture's highlights (mirrored, scaled)
  if (u_imageGhosts > 0.0) {
    vec2 uv = 1.0 - v_uv;
    vec2 dir = (vec2(0.5) - uv) * 0.45;
    vec3 g = vec3(0.0);
    for (int i = 0; i < 5; i++) {
      vec2 q = fract(uv + dir * float(i));
      float w = pow(1.0 - length(vec2(0.5) - q) / 0.707, 6.0);
      g.r += texture(u_pass0, q + dir * 0.02).r * w;
      g.g += texture(u_pass0, q).g * w;
      g.b += texture(u_pass0, q - dir * 0.02).b * w;
    }
    f += g * 0.6 * u_imageGhosts;
  }
  vec3 lin = srgbToLinear(src.rgb) + f * u_intensity;
  fragColor = vec4(linearToSrgb(lin), src.a);
}`),
    },
  ],
});

// ---------------------------------------------------------------------------
// God rays
// ---------------------------------------------------------------------------
const godRays = defineNode({
  id: 'effects.godRays',
  name: 'God Rays',
  category: 'Optical',
  color: C,
  description:
    'Volumetric light shafts (crepuscular rays): bright parts of the image are smeared radially away from a light position with exponential decay, ' +
    'so gaps between leaves, clouds or windows cast visible beams. Two-pass sampling for smooth shafts.',
  tags: ['god rays', 'light shafts', 'crepuscular', 'volumetric', 'sun', 'beams', 'fog'],
  inputs: img,
  params: {
    position: { type: 'vec2', default: [0.5, 0.15], min: -0.5, max: 1.5, step: 0.005, label: 'Light position' },
    threshold: { type: 'float', default: 0.7, min: 0, max: 1, step: 0.01, label: 'Threshold', description: 'Brightness above which pixels emit light.' },
    length: { type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, label: 'Ray length' },
    decay: { type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, label: 'Falloff' },
    intensity: { type: 'float', default: 1, min: 0, max: 4, step: 0.01, label: 'Intensity' },
    tint: { type: 'color', default: [1, 0.9, 0.72, 1], label: 'Light colour' },
  },
  passes: [
    { // 0: emitters at half res
      size: half,
      frag: FE(`
void main() {
  vec3 c = srgbToLinear(texture(u_image, v_uv).rgb);
  float L = luma(c);
  float t = srgbToLinear(vec3(u_threshold)).r;
  fragColor = vec4(c * smoothstep(t, t + 0.25, L), 1.0);
}`),
    },
    { // 1: radial accumulation toward the light
      size: half,
      frag: FE(`
void main() {
  const int N = 40;
  vec2 dir = (v_uv - u_position) * u_length;
  float j = ign(pixelCoord());
  vec3 acc = vec3(0.0); float ws = 0.0;
  for (int i = 0; i < N; i++) {
    float t = (float(i) + j) / float(N);
    vec2 uv = v_uv - dir * t;
    float w = exp(-t * mix(0.5, 6.0, u_decay));
    vec3 s = (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) ? vec3(0.0) : texture(u_prev, uv).rgb;
    acc += s * w; ws += 1.0;
  }
  fragColor = vec4(acc / ws, 1.0);
}`),
    },
    { // 2: second pass fills the gaps between taps
      size: half,
      frag: FE(`
void main() {
  const int N = 8;
  vec2 dir = (v_uv - u_position) * u_length / 40.0;
  vec3 acc = vec3(0.0);
  for (int i = 0; i < N; i++) acc += texClamp(u_prev, v_uv - dir * (float(i) / float(N))).rgb;
  fragColor = vec4(acc / float(N), 1.0);
}`),
    },
    {
      frag: FE(`
void main() {
  vec4 src = texture(u_image, v_uv);
  vec3 rays = texture(u_prev, v_uv).rgb;
  vec3 lin = srgbToLinear(src.rgb);
  vec3 add = rays * u_tint.rgb * u_intensity * 3.0;
  lin = 1.0 - (1.0 - lin) * exp(-add);  // soft screen-like add
  fragColor = vec4(linearToSrgb(lin), src.a);
}`),
    },
  ],
});

// ---------------------------------------------------------------------------
// Anaglyph
// ---------------------------------------------------------------------------
const anaglyph = defineNode({
  id: 'effects.anaglyph',
  name: 'Anaglyph 3D',
  category: 'Optical',
  color: C,
  description:
    'Red/cyan 3D glasses image. Stereo views are synthesised by shifting pixels horizontally by a depth guess (lower in frame and brighter/more ' +
    'saturated = nearer, blended with a smooth luminance-based depth), by a connected depth map (e.g. AI → Depth Map), or by a flat offset. Colour, half-colour, grey or Dubois-optimised encoding.',
  tags: ['anaglyph', '3d', 'stereo', 'red cyan', 'glasses', 'stereoscopic', '50s'],
  inputs: { ...img, depth: { type: 'mask', optional: true, label: 'Depth (optional, near = white)' } },
  params: {
    depthMode: { type: 'enum', default: 'Depth guess', options: ['Depth guess', 'Flat offset'], label: 'Depth' },
    separation: { type: 'float', default: 24, min: 0, max: 80, step: 0.5, pixels: true, label: 'Separation', description: 'Maximum horizontal disparity in full-res px.' },
    focus: { type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Screen plane depth', description: 'Depth that has zero disparity (sits on the screen).' },
    verticalCue: { type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, label: 'Ground-plane cue', description: 'How much "lower in the frame = nearer" drives depth.' },
    encoding: { type: 'enum', default: 'Colour', options: ['Dubois', 'Colour', 'Half colour', 'Grey'], label: 'Encoding' },
    showDepth: { type: 'bool', default: false, label: 'Show depth map' },
  },
  passes: [
    { // 0: low-res depth guess
      size: (c) => [Math.max(1, Math.ceil(c.width / 8)), Math.max(1, Math.ceil(c.height / 8))],
      frag: FE(`
void main() {
  vec2 t = 1.0 / u_resolution;
  vec3 c = vec3(0.0);
  for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) c += texClamp(u_image, v_uv + vec2(i, j) * t * 0.6).rgb;
  c /= 25.0;
  float sat = rgb2hsv(c).y;
  float near = mix(0.5 * luma(c) + 0.5 * sat, v_uv.y, u_verticalCue);
  fragColor = vec4(vec3(near), 1.0);
}`),
    },
    { // 1: blur depth
      size: (c) => [Math.max(1, Math.ceil(c.width / 8)), Math.max(1, Math.ceil(c.height / 8))],
      frag: FE(`
void main() {
  vec2 t = 1.0 / u_resolution;
  float s = 0.0, w = 0.0;
  for (int j = -3; j <= 3; j++) for (int i = -3; i <= 3; i++) { float k = exp(-float(i * i + j * j) / 6.0); s += texClamp(u_prev, v_uv + vec2(i, j) * t).r * k; w += k; }
  fragColor = vec4(vec3(s / w), 1.0);
}`),
    },
    {
      frag: FE(`
// a connected depth map (e.g. AI Depth Map) overrides the guess; unconnected = 1x1 fallback
float depthAt(vec2 uv) { return u_depthMode == 1 ? 1.0 : u_depth_size.x > 1.5 ? texture(u_depth, uv).r : texture(u_pass1, uv).r; }
vec3 view(float eye) { // eye = -1 left, +1 right
  vec2 uv = v_uv;
  // two fixed-point iterations so the shift uses the depth at the source pixel
  for (int i = 0; i < 2; i++) {
    float disp = (depthAt(uv) - u_focus) * u_separation * u_scale;
    uv = v_uv + vec2(eye * disp / u_resolution.x, 0.0);
  }
  return srgbToLinear(texClamp(u_image, uv).rgb);
}
void main() {
  vec4 src = texture(u_image, v_uv);
  if (u_showDepth) { fragColor = vec4(vec3(depthAt(v_uv)), 1.0); return; }
  vec3 l = view(-1.0), r = view(1.0);
  vec3 o;
  if (u_encoding == 0) {
    mat3 ML = mat3(0.456, -0.040, -0.015, 0.500, -0.038, -0.021, 0.176, -0.016, -0.005);
    mat3 MR = mat3(-0.043, 0.378, -0.072, -0.088, 0.734, -0.113, -0.002, -0.018, 1.226);
    o = clamp(ML * l + MR * r, 0.0, 1.0);
  } else if (u_encoding == 1) o = vec3(l.r, r.g, r.b);
  else if (u_encoding == 2) o = vec3(luma(l), r.g, r.b);
  else o = vec3(luma(l), luma(r), luma(r));
  fragColor = vec4(linearToSrgb(o), src.a);
}`),
    },
  ],
});

// ---------------------------------------------------------------------------
// Kaleidoscope
// ---------------------------------------------------------------------------
const kaleidoscope = defineNode({
  id: 'effects.kaleidoscope',
  name: 'Kaleidoscope',
  category: 'Optical',
  color: C,
  description: 'Mirror-symmetric kaleidoscope: the image is folded into N mirrored wedges around a centre, with rotation, zoom and source offset.',
  tags: ['kaleidoscope', 'mirror', 'symmetry', 'mandala', 'psychedelic', 'wedge'],
  inputs: img,
  params: {
    segments: { type: 'int', default: 8, min: 2, max: 48, step: 1, label: 'Segments' },
    rotation: { type: 'float', default: 0, min: -180, max: 180, step: 0.5, label: 'Rotation' },
    zoom: { type: 'float', default: 1.6, min: 0.1, max: 8, step: 0.01, label: 'Zoom' },
    center: { type: 'vec2', default: [0.5, 0.5], min: 0, max: 1, step: 0.005, label: 'Centre' },
    offset: { type: 'vec2', default: [0.5, 0.5], min: 0, max: 1, step: 0.005, label: 'Source point', description: 'Where in the source the wedge is taken from.' },
    sourceAngle: { type: 'float', default: 0, min: -180, max: 180, step: 0.5, label: 'Source angle' },
    seams: { type: 'float', default: 0, min: 0, max: 1, step: 0.01, label: 'Mirror seams' },
  },
  passes: [{
    frag: FE(`
void main() {
  vec2 asp = vec2(u_resolution.x / u_resolution.y, 1.0);
  vec2 p = (v_uv - u_center) * asp;
  float r = length(p) / u_zoom;
  float a = atan(p.y, p.x) - radians(u_rotation);
  float seg = TAU / float(max(u_segments, 2));
  float m = mod(a, seg);
  float k = floor(a / seg);
  if (mod(k, 2.0) >= 1.0) m = seg - m;
  float edge = min(m, seg - m) * r;
  a = m + radians(u_sourceAngle);
  vec2 q = vec2(cos(a), sin(a)) * r / asp + u_offset;
  q = 1.0 - abs(1.0 - mod(q, 2.0)); // mirror-repeat
  vec4 c = texture(u_image, q);
  c.rgb *= 1.0 - u_seams * 0.6 * (1.0 - smoothstep(0.0, 0.004, edge));
  fragColor = c;
}`),
  }],
});

export default [tiltShift, zoomBlur, radialBlur, lensFlare, godRays, anaglyph, kaleidoscope] satisfies NodeDef[];
