import { defineNode } from '../../core/registry';
import type { NodeDef, PassContext } from '../../core/types';
import { GLSL_CONV1D, GLSL_LINEAR, num } from './shared';

const C = '#30a46c';
const img = { image: { type: 'image' as const } };

// ---------------------------------------------------------------------------
// Gaussian plan: σ = radius / 2 (kernel reaches ~1.5 × radius). For large σ the
// image is box-downsampled by an integer factor d first (box variance is
// subtracted from σ), blurred at low res with ≤ ~8 texel σ, then bilinearly
// upsampled — O(1) cost per pixel regardless of radius.
// ---------------------------------------------------------------------------
function gaussPlan(ctx: PassContext) {
  const sigma = Math.max(0, num(ctx.params, 'radius', 8)) * ctx.scale * 0.5;
  const dir = String(ctx.params.direction ?? 'both');
  const d = sigma > 8 ? Math.min(32, Math.floor(sigma / 4)) : 1;
  const useX = dir !== 'vertical', useY = dir !== 'horizontal';
  const dx = useX ? d : 1, dy = useY ? d : 1;
  const rem = (dd: number) => Math.sqrt(Math.max(sigma * sigma - (dd * dd - 1) / 12, 0)) / dd;
  return { dx, dy, sx: useX ? rem(dx) : 0, sy: useY ? rem(dy) : 0 };
}

const GAUSS_W = /* glsl */ `
uniform vec2 u_d;
uniform vec2 u_sig;
float g_sig;
float lib_w(float i) { return g_sig < 0.01 ? (i == 0.0 ? 1.0 : 0.0) : exp(-i * i / (2.0 * g_sig * g_sig)); }
${GLSL_CONV1D}
`;

const BOX_W = /* glsl */ `
float g_r;
float lib_w(float i) { return clamp(g_r + 1.0 - abs(i), 0.0, 1.0); }
${GLSL_CONV1D}
`;

export default [
  defineNode({
    id: 'filter.gaussianBlur',
    name: 'Gaussian Blur',
    category: 'Filter',
    description: 'Separable gaussian blur in linear light (σ = radius / 2). Large radii are blurred at reduced resolution, so cost stays constant.',
    tags: ['blur', 'soften', 'smooth', 'defocus'],
    color: C,
    inputs: img,
    params: {
      radius: { type: 'float', default: 8, min: 0, max: 500, step: 0.1, pixels: true, label: 'Radius' },
      direction: { type: 'enum', default: 'both', options: ['both', 'horizontal', 'vertical'], label: 'Direction' },
    },
    passes: [
      {
        // 0: linearise + premultiply + box-downsample by u_d
        size: (ctx) => { const p = gaussPlan(ctx); return [Math.ceil(ctx.width / p.dx), Math.ceil(ctx.height / p.dy)]; },
        uniforms: (ctx) => { const p = gaussPlan(ctx); return { u_d: [p.dx, p.dy], u_sig: [p.sx, p.sy] }; },
        frag: /* glsl */ `
uniform vec2 u_d;
${GLSL_LINEAR}
void main(){
  ivec2 d = ivec2(u_d);
  ivec2 base = ivec2(floor(v_uv * u_resolution)) * d;
  ivec2 isz = ivec2(u_image_size);
  vec4 acc = vec4(0.0);
  float n = 0.0;
  for (int y = 0; y < 32; y++) { if (y >= d.y) break;
    for (int x = 0; x < 32; x++) { if (x >= d.x) break;
      ivec2 p = base + ivec2(x, y);
      if (p.x >= isz.x || p.y >= isz.y) continue;
      acc += lib_toLinPremul(texelFetch(u_image, p, 0));
      n += 1.0;
    }
  }
  fragColor = acc / max(n, 1.0);
}` },
      {
        size: (ctx) => [ctx.passSizes[0].width, ctx.passSizes[0].height],
        uniforms: (ctx) => { const p = gaussPlan(ctx); return { u_d: [p.dx, p.dy], u_sig: [p.sx, p.sy] }; },
        frag: /* glsl */ `${GAUSS_W}
void main(){
  g_sig = u_sig.x;
  int R = int(ceil(3.0 * g_sig));
  fragColor = lib_conv1d(u_pass0, v_uv, vec2(1.0 / u_pass0_size.x, 0.0), R);
}` },
      {
        size: (ctx) => [ctx.passSizes[0].width, ctx.passSizes[0].height],
        uniforms: (ctx) => { const p = gaussPlan(ctx); return { u_d: [p.dx, p.dy], u_sig: [p.sx, p.sy] }; },
        frag: /* glsl */ `${GAUSS_W}
void main(){
  g_sig = u_sig.y;
  int R = int(ceil(3.0 * g_sig));
  fragColor = lib_conv1d(u_pass1, v_uv, vec2(0.0, 1.0 / u_pass1_size.y), R);
}` },
      {
        uniforms: (ctx) => { const p = gaussPlan(ctx); return { u_d: [p.dx, p.dy] }; },
        frag: /* glsl */ `
uniform vec2 u_d;
${GLSL_LINEAR}
void main(){
  vec2 uv = (v_uv * u_resolution) / (u_d * u_pass2_size);
  fragColor = lib_fromLinPremul(texture(u_pass2, uv));
}` },
    ],
  }),

  defineNode({
    id: 'filter.boxBlur',
    name: 'Box Blur',
    category: 'Filter',
    description: 'Separable box (mean) blur in linear light with independent X/Y radii.',
    tags: ['blur', 'mean', 'average', 'smooth'],
    color: C,
    inputs: img,
    params: {
      radiusX: { type: 'float', default: 4, min: 0, max: 250, step: 0.5, pixels: true, label: 'Radius X' },
      radiusY: { type: 'float', default: 4, min: 0, max: 250, step: 0.5, pixels: true, label: 'Radius Y' },
    },
    passes: [
      { frag: `${GLSL_LINEAR}\nvoid main(){ fragColor = lib_toLinPremul(texture(u_image, v_uv)); }` },
      { frag: /* glsl */ `${BOX_W}
void main(){
  g_r = u_radiusX * u_scale;
  fragColor = lib_conv1d(u_pass0, v_uv, vec2(1.0 / u_pass0_size.x, 0.0), int(ceil(g_r)));
}` },
      { frag: /* glsl */ `${BOX_W}
${GLSL_LINEAR}
void main(){
  g_r = u_radiusY * u_scale;
  fragColor = lib_fromLinPremul(lib_conv1d(u_pass1, v_uv, vec2(0.0, 1.0 / u_pass1_size.y), int(ceil(g_r))));
}` },
    ],
  }),

  defineNode({
    id: 'filter.directionalBlur',
    name: 'Directional Blur',
    category: 'Filter',
    description: 'Motion blur along an angle (0° = horizontal, 90° = vertical), length in pixels, centred on each pixel. Linear light.',
    tags: ['motion blur', 'streak', 'linear blur', 'shake'],
    color: C,
    inputs: img,
    params: {
      angle: { type: 'float', default: 0, min: -180, max: 180, step: 1, label: 'Angle (°)' },
      length: { type: 'float', default: 20, min: 0, max: 500, step: 0.5, pixels: true, label: 'Length' },
    },
    passes: [{
      frag: /* glsl */ `
${GLSL_LINEAR}
void main(){
  float L = u_length * u_scale;
  if (L < 0.5) { fragColor = texture(u_image, v_uv); return; }
  float a = radians(u_angle);
  vec2 dir = vec2(cos(a), sin(a)) * L / u_resolution;
  int n = int(clamp(ceil(L), 2.0, 160.0));
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 160; i++) {
    if (i >= n) break;
    float t = (float(i) + 0.5) / float(n) - 0.5;
    acc += lib_toLinPremul(texClamp(u_image, v_uv + dir * t));
  }
  fragColor = lib_fromLinPremul(acc / float(n));
}` }],
  }),

  defineNode({
    id: 'filter.sharpen',
    name: 'Sharpen',
    category: 'Filter',
    description: 'Unsharp mask: adds amount × (image − gaussian blur of σ = radius). Threshold skips low-contrast detail. High amounts give visible halos (digicam look).',
    tags: ['unsharp mask', 'detail', 'crisp', 'halo', 'usm'],
    color: C,
    inputs: img,
    params: {
      amount: { type: 'float', default: 1, min: 0, max: 10, step: 0.01, label: 'Amount' },
      radius: { type: 'float', default: 1.5, min: 0.1, max: 50, step: 0.1, pixels: true, label: 'Radius' },
      threshold: { type: 'float', default: 0, min: 0, max: 0.5, step: 0.005, label: 'Threshold' },
    },
    passes: [
      { frag: /* glsl */ `
float g_sig;
float lib_w(float i) { return exp(-i * i / (2.0 * g_sig * g_sig)); }
${GLSL_CONV1D}
void main(){
  g_sig = max(u_radius * u_scale, 0.05);
  fragColor = lib_conv1d(u_image, v_uv, vec2(1.0 / u_image_size.x, 0.0), int(ceil(3.0 * g_sig)));
}` },
      { frag: /* glsl */ `
float g_sig;
float lib_w(float i) { return exp(-i * i / (2.0 * g_sig * g_sig)); }
${GLSL_CONV1D}
void main(){
  g_sig = max(u_radius * u_scale, 0.05);
  fragColor = lib_conv1d(u_pass0, v_uv, vec2(0.0, 1.0 / u_pass0_size.y), int(ceil(3.0 * g_sig)));
}` },
      { frag: /* glsl */ `
void main(){
  vec4 c = texture(u_image, v_uv);
  vec3 diff = c.rgb - texture(u_pass1, v_uv).rgb;
  float m = u_threshold <= 0.0 ? 1.0 : smoothstep(u_threshold * 0.5, u_threshold, abs(luma(diff)));
  fragColor = vec4(max(c.rgb + u_amount * diff * m, 0.0), c.a);
}` },
    ],
  }),

  defineNode({
    id: 'filter.edgeDetect',
    name: 'Edge Detect',
    category: 'Filter',
    description: 'Sobel gradient magnitude or Laplacian of the luminance, as white edges on black.',
    tags: ['edges', 'outline', 'sobel', 'laplacian', 'sketch'],
    color: C,
    inputs: img,
    params: {
      strength: { type: 'float', default: 1, min: 0, max: 10, step: 0.01, label: 'Strength' },
      mode: { type: 'enum', default: 'sobel', options: ['sobel', 'laplacian'], label: 'Mode' },
      radius: { type: 'float', default: 1, min: 0.5, max: 20, step: 0.1, pixels: true, label: 'Sample distance' },
      color: { type: 'bool', default: false, label: 'Per channel (colour)' },
    },
    passes: [{
      frag: /* glsl */ `
vec3 S(vec2 o) { vec3 c = texture(u_image, v_uv + o).rgb; return u_color ? c : vec3(luma(c)); }
void main(){
  vec2 t = u_radius * u_scale / u_image_size;
  vec3 e;
  if (u_mode == 0) {
    vec3 tl = S(vec2(-t.x, -t.y)), tc = S(vec2(0.0, -t.y)), tr = S(vec2(t.x, -t.y));
    vec3 ml = S(vec2(-t.x, 0.0)), mr = S(vec2(t.x, 0.0));
    vec3 bl = S(vec2(-t.x, t.y)), bc = S(vec2(0.0, t.y)), br = S(vec2(t.x, t.y));
    vec3 gx = (tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl);
    vec3 gy = (bl + 2.0 * bc + br) - (tl + 2.0 * tc + tr);
    e = sqrt(gx * gx + gy * gy) * 0.5;
  } else {
    e = abs(4.0 * S(vec2(0.0)) - S(vec2(t.x, 0.0)) - S(vec2(-t.x, 0.0)) - S(vec2(0.0, t.y)) - S(vec2(0.0, -t.y)));
  }
  fragColor = vec4(e * u_strength, texture(u_image, v_uv).a);
}` }],
  }),

  defineNode({
    id: 'filter.median',
    name: 'Median',
    category: 'Filter',
    description: 'Per-channel median of a 3×3 (radius 1) or 5×5 (radius 2) neighbourhood — removes speckle noise while keeping edges.',
    tags: ['denoise', 'despeckle', 'noise reduction', 'smooth'],
    color: C,
    inputs: img,
    params: {
      radius: { type: 'int', default: 1, min: 1, max: 2, step: 1, label: 'Radius' },
    },
    passes: [{
      frag: /* glsl */ `
void main(){
  int r = clamp(u_radius, 1, 2);
  int n = (2 * r + 1) * (2 * r + 1);
  vec2 t = max(u_scale, 0.0) / u_image_size;
  vec3 v[25];
  int k = 0;
  for (int y = -2; y <= 2; y++) for (int x = -2; x <= 2; x++) {
    if (abs(x) > r || abs(y) > r) continue;
    v[k] = texture(u_image, v_uv + vec2(float(x), float(y)) * t).rgb;
    k++;
  }
  int half_ = n / 2;
  // partial selection sort (component-wise → independent per channel)
  for (int i = 0; i < 13; i++) {
    if (i > half_) break;
    for (int j = i + 1; j < 25; j++) {
      if (j >= n) break;
      vec3 a = v[i], b = v[j];
      v[i] = min(a, b);
      v[j] = max(a, b);
    }
  }
  fragColor = vec4(v[half_], texture(u_image, v_uv).a);
}` }],
  }),

  defineNode({
    id: 'filter.bilateral',
    name: 'Bilateral (Smart Blur)',
    category: 'Filter',
    description: 'Edge-preserving blur: neighbours are weighted by spatial distance and colour similarity. Good for skin smoothing / denoise.',
    tags: ['denoise', 'smooth', 'skin', 'edge preserving', 'surface blur'],
    color: C,
    inputs: img,
    params: {
      radius: { type: 'float', default: 5, min: 0, max: 30, step: 0.5, pixels: true, label: 'Radius' },
      tolerance: { type: 'float', default: 0.1, min: 0.005, max: 1, step: 0.005, label: 'Tolerance' },
    },
    passes: [{
      frag: /* glsl */ `
void main(){
  vec4 c = texture(u_image, v_uv);
  float R = u_radius * u_scale;
  if (R < 0.5) { fragColor = c; return; }
  // at most 13x13 taps; spread them over the radius
  float stepPx = max(1.0, R / 6.0);
  int n = int(min(6.0, ceil(R / stepPx)));
  float sigS = R / 2.0;
  vec3 acc = vec3(0.0); float ws = 0.0;
  for (int y = -6; y <= 6; y++) { if (abs(y) > n) continue;
    for (int x = -6; x <= 6; x++) { if (abs(x) > n) continue;
      vec2 o = vec2(float(x), float(y)) * stepPx;
      vec3 s = texture(u_image, v_uv + o / u_image_size).rgb;
      vec3 d = s - c.rgb;
      float w = exp(-dot(o, o) / (2.0 * sigS * sigS) - dot(d, d) / (2.0 * u_tolerance * u_tolerance));
      acc += s * w; ws += w;
    }
  }
  fragColor = vec4(acc / ws, c.a);
}` }],
  }),
] satisfies NodeDef[];
