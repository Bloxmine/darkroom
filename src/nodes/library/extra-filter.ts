/**
 * Filter nodes: high pass, denoise, lens (bokeh) blur, surface blur,
 * min/max (morphology), soft glow, frequency separation.
 * (filter.unsharpMask and filter.motionBlur are intentionally omitted: they
 * would duplicate filter.sharpen and filter.directionalBlur.)
 */
import { defineNode } from '../../core/registry';
import type { NodeDef, PassContext } from '../../core/types';
import { GLSL_LINEAR, num } from './shared';
import { GLSL_BLUR_UV, blurPasses, blurUniforms } from './extra-shared';

const C = '#30a46c';
const img = { image: { type: 'image' as const } };
const sig = (key: string, def: number) => (ctx: PassContext) => Math.max(0, num(ctx.params, key, def)) * ctx.scale * 0.5;
const srgbSrc = `vec4 ex_src(ivec2 p) { vec4 c = texelFetch(u_image, p, 0); return vec4(c.rgb * c.a, c.a); }`;

const MORPH_OPS = ['dilate (max)', 'erode (min)', 'open', 'close'];
/** Morphology pass: `stage` 0/1 = first op H/V (or disc), 2/3 = second op. */
const morphFrag = (src: string, stage: number) => /* glsl */ `
uniform float u_R;
void main(){
  ivec2 p = ivec2(floor(v_uv * u_resolution));
  // op sequence: dilate → [max]; erode → [min]; open → [min, max]; close → [max, min]
  int op = ${stage < 2 ? '(u_operation == 0 || u_operation == 3) ? 1 : 0' : '(u_operation == 2) ? 1 : ((u_operation == 3) ? 0 : -1)'};
  vec4 c0 = texel(${src}, p);
  if (op < 0) { fragColor = c0; return; }
  bool disc = u_shape == 1;
  ${stage % 2 === 1 ? 'if (disc) { fragColor = c0; return; }' : ''}
  int R = int(u_R);
  float stepPx = max(1.0, float(R) / 12.0);
  int n = int(ceil(float(R) / stepPx));
  vec4 m = c0;
  if (disc) {
    for (int j = -12; j <= 12; j++) { if (abs(j) > n) continue;
      for (int i = -12; i <= 12; i++) { if (abs(i) > n) continue;
        vec2 f = vec2(float(i), float(j)) * stepPx;
        if (length(f) > float(R) + 0.5) continue;
        vec4 s = texel(${src}, p + ivec2(round(f)));
        m = op == 1 ? max(m, s) : min(m, s);
      }
    }
  } else {
    for (int i = -12; i <= 12; i++) { if (abs(i) > n) continue;
      int k = int(round(float(i) * stepPx));
      vec4 s = texel(${src}, p + ${stage % 2 === 0 ? 'ivec2(k, 0)' : 'ivec2(0, k)'});
      m = op == 1 ? max(m, s) : min(m, s);
    }
  }
  fragColor = m;
}`;

export default [
  defineNode({
    id: 'filter.highPass',
    name: 'High Pass',
    category: 'Filter',
    description: 'Photoshop High Pass: 50% grey + (image − gaussian blur). Blend the result with Overlay/Soft Light for sharpening or local contrast; monochrome avoids colour fringes.',
    tags: ['high pass', 'detail', 'sharpen', 'texture', 'overlay sharpening', 'frequency'],
    color: C,
    inputs: img,
    params: {
      radius: { type: 'float', default: 10, min: 0.5, max: 300, step: 0.1, pixels: true, label: 'Radius' },
      strength: { type: 'float', default: 1, min: 0, max: 10, step: 0.01, label: 'Strength' },
      monochrome: { type: 'bool', default: false, label: 'Monochrome' },
    },
    passes: [
      ...blurPasses(0, sig('radius', 10), srgbSrc),
      {
        uniforms: (ctx) => blurUniforms(sig('radius', 10)(ctx)),
        frag: /* glsl */ `
uniform float u_bd;
${GLSL_BLUR_UV}
void main(){
  vec4 c = texture(u_image, v_uv);
  vec4 b = texture(u_pass2, ex_blurUV(v_uv, u_bd, u_pass2_size));
  vec3 bl = b.a > 1e-5 ? b.rgb / b.a : c.rgb;
  vec3 d = (c.rgb - bl) * u_strength;
  if (u_monochrome) d = vec3(luma(d));
  fragColor = vec4(0.5 + d, c.a);
}` },
    ],
  }),

  defineNode({
    id: 'filter.denoise',
    name: 'Denoise',
    category: 'Filter',
    description: 'Noise reduction in YCbCr. Luma: non-local-means-lite (neighbours weighted by similarity of their 3×3 neighbourhood mean and value). Chroma: a wider cross-bilateral guided by the denoised luma, which removes colour blotches without bleeding across edges. Detail restores some original luma texture.',
    tags: ['noise reduction', 'nlm', 'non local means', 'chroma noise', 'luminance noise', 'smooth', 'grain removal'],
    color: C,
    inputs: img,
    params: {
      luma: { type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, label: 'Luminance' },
      chroma: { type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, label: 'Colour' },
      radius: { type: 'float', default: 3, min: 1, max: 6, step: 0.5, pixels: true, label: 'Search radius' },
      detail: { type: 'float', default: 0.2, min: 0, max: 1, step: 0.01, label: 'Detail' },
    },
    passes: [
      { frag: /* glsl */ `
void main(){
  ivec2 p = ivec2(floor(v_uv * u_resolution));
  vec3 y = rgb2ycbcr(texel(u_image, p).rgb);
  float m = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) m += luma601(texel(u_image, p + ivec2(i, j)).rgb);
  fragColor = vec4(y, m / 9.0);
}` },
      {
        uniforms: (ctx) => ({ u_R: Math.min(6, Math.max(1, Math.round(num(ctx.params, 'radius', 3) * ctx.scale))) }),
        frag: /* glsl */ `
uniform float u_R;
void main(){
  ivec2 p = ivec2(floor(v_uv * u_resolution));
  vec4 c = texel(u_pass0, p);
  int R = int(u_R);
  float h = max(u_luma, 1e-3) * 0.06;
  float acc = 0.0, ws = 0.0;
  for (int j = -6; j <= 6; j++) { if (abs(j) > R) continue;
    for (int i = -6; i <= 6; i++) { if (abs(i) > R) continue;
      vec4 s = texel(u_pass0, p + ivec2(i, j));
      float dm = s.a - c.a, dv = s.x - c.x;
      float d2 = dm * dm * 4.0 + dv * dv;
      float sp = float(i * i + j * j) / (2.0 * float(R * R) + 1.0);
      float w = exp(-d2 / (h * h) - sp);
      acc += s.x * w; ws += w;
    }
  }
  float y = u_luma <= 0.0 ? c.x : acc / ws;
  fragColor = vec4(y, c.yz, c.a);
}` },
      {
        uniforms: (ctx) => ({ u_R: Math.max(1, num(ctx.params, 'radius', 3) * 2.5 * ctx.scale) }),
        frag: /* glsl */ `
uniform float u_R;
void main(){
  ivec2 p = ivec2(floor(v_uv * u_resolution));
  vec4 c = texel(u_pass1, p);
  float stepPx = max(1.0, u_R / 6.0);
  int n = int(min(6.0, ceil(u_R / stepPx)));
  float hc = max(u_chroma, 1e-3) * 0.08;
  vec2 acc = vec2(0.0); float ws = 0.0;
  for (int j = -6; j <= 6; j++) { if (abs(j) > n) continue;
    for (int i = -6; i <= 6; i++) { if (abs(i) > n) continue;
      vec4 s = texel(u_pass1, p + ivec2(round(vec2(float(i), float(j)) * stepPx)));
      float dy = (s.x - c.x) / 0.08;
      vec2 dc = (s.yz - c.yz) / hc;
      float w = exp(-dy * dy - dot(dc, dc) * 0.5 - float(i * i + j * j) / float(2 * n * n + 1));
      acc += s.yz * w; ws += w;
    }
  }
  vec2 cc = u_chroma <= 0.0 ? c.yz : acc / ws;
  float yo = rgb2ycbcr(texture(u_image, v_uv).rgb).x;
  float y = mix(c.x, yo, u_detail * 0.6);
  fragColor = vec4(ycbcr2rgb(vec3(y, cc)), texture(u_image, v_uv).a);
}` },
    ],
  }),

  defineNode({
    id: 'filter.lensBlur',
    name: 'Lens Blur (Bokeh)',
    category: 'Filter',
    description: 'Defocus blur with a disc or polygonal (aperture blades) kernel in linear light; bright highlights are weighted up so they bloom into bokeh balls (flat bright areas keep their level). Optional `amount` mask scales the blur per pixel — or, as a depth map, blur grows with distance from the focus depth.',
    tags: ['bokeh', 'defocus', 'depth of field', 'dof', 'aperture', 'lens blur', 'portrait mode'],
    color: C,
    inputs: {
      image: { type: 'image', label: 'Image' },
      amount: { type: 'mask', optional: true, fallback: 'white', label: 'Amount / depth' },
    },
    params: {
      radius: { type: 'float', default: 16, min: 0, max: 120, step: 0.5, pixels: true, label: 'Radius' },
      blades: { type: 'int', default: 0, min: 0, max: 9, step: 1, label: 'Blades (0 = round)' },
      rotation: { type: 'float', default: 0, min: 0, max: 180, step: 1, label: 'Blade rotation (°)' },
      boost: { type: 'float', default: 3, min: 0, max: 10, step: 0.1, label: 'Highlight boost' },
      threshold: { type: 'float', default: 0.75, min: 0, max: 1, step: 0.01, label: 'Highlight threshold' },
      maskMode: { type: 'enum', default: 'amount', options: ['amount', 'depth'], label: 'Mask is' },
      focus: { type: 'float', default: 0, min: 0, max: 1, step: 0.01, label: 'Focus depth' },
    },
    passes: [
      { frag: `${GLSL_LINEAR}\nvoid main(){ fragColor = lib_toLinPremul(texture(u_image, v_uv)); }` },
      { frag: /* glsl */ `
${GLSL_LINEAR}
void main(){
  // r: blur amount 0..1, g: highlight weight (bright samples dominate the average → bokeh balls)
  float m = texture(u_amount, v_uv).r;
  if (u_maskMode == 1) m = clamp(abs(m - u_focus) / max(max(u_focus, 1.0 - u_focus), 1e-3), 0.0, 1.0);
  vec4 c = texture(u_image, v_uv);
  float l = luma(c.rgb);
  float k = 1.0 + u_boost * 4.0 * pow(smoothstep(u_threshold, 1.0, l), 2.0);
  fragColor = vec4(m, k, 0.0, 1.0);
}` },
      {
        uniforms: (ctx) => {
          const R = Math.max(0, num(ctx.params, 'radius', 16)) * ctx.scale;
          return { u_N: Math.round(Math.min(320, Math.max(32, R * R * 0.8))), u_Rpx: R };
        },
        frag: /* glsl */ `
uniform float u_N, u_Rpx;
${GLSL_LINEAR}
float poly(float th) {
  if (u_blades < 3) return 1.0;
  float n = float(u_blades), seg = TAU / n;
  float a = mod(th - radians(u_rotation), seg) - seg * 0.5;
  return cos(PI / n) / cos(a);
}
void main(){
  float R = u_Rpx * texture(u_pass1, v_uv).r;
  vec4 center = texture(u_pass0, v_uv);
  if (R < 0.5) { fragColor = lib_fromLinPremul(center); return; }
  int N = int(u_N);
  vec4 acc = vec4(0.0); float ws = 0.0;
  for (int i = 0; i < 320; i++) {
    if (i >= N) break;
    float fi = float(i) + 0.5;
    float r = sqrt(fi / float(N));
    float th = fi * 2.39996323;
    vec2 o = vec2(cos(th), sin(th)) * r * poly(th) * R;
    vec2 uv = v_uv + o / u_resolution;
    // a neighbour only contributes if its own blur radius reaches us (limits sharp-over-blur bleeding)
    vec2 q = texClamp(u_pass1, uv).rg;
    float Rq = u_Rpx * q.r;
    float w = (clamp(Rq - length(o) + 1.0, 0.0, 1.0) * 0.9 + 0.1) * q.g;
    acc += texClamp(u_pass0, uv) * w; ws += w;
  }
  fragColor = lib_fromLinPremul(acc / ws);
}` },
    ],
  }),

  defineNode({
    id: 'filter.surfaceBlur',
    name: 'Surface Blur',
    category: 'Filter',
    description: 'Photoshop-style surface blur: averages neighbours within the radius, each channel weighted by 1 − |difference| / (2.5 × threshold), so flat areas smooth while edges stay crisp. Threshold is in levels (0–255).',
    tags: ['surface blur', 'edge preserving', 'skin', 'smooth', 'denoise', 'cartoon', 'flatten'],
    color: C,
    inputs: img,
    params: {
      radius: { type: 'float', default: 6, min: 1, max: 100, step: 0.5, pixels: true, label: 'Radius' },
      threshold: { type: 'float', default: 20, min: 1, max: 255, step: 1, label: 'Threshold (levels)' },
    },
    passes: [{
      frag: /* glsl */ `
void main(){
  vec4 c = texture(u_image, v_uv);
  float R = max(u_radius * u_scale, 0.5);
  float stepPx = max(1.0, R / 8.0);
  int n = int(min(8.0, ceil(R / stepPx)));
  float T = 2.5 * u_threshold / 255.0;
  vec3 acc = vec3(0.0), ws = vec3(0.0);
  for (int j = -8; j <= 8; j++) { if (abs(j) > n) continue;
    for (int i = -8; i <= 8; i++) { if (abs(i) > n) continue;
      vec2 o = vec2(float(i), float(j)) * stepPx;
      if (length(o) > R + 0.5) continue;
      vec3 s = texture(u_image, v_uv + o / u_resolution).rgb;
      vec3 w = max(1.0 - abs(s - c.rgb) / T, 0.0);
      acc += s * w; ws += w;
    }
  }
  fragColor = vec4(acc / max(ws, vec3(1e-5)), c.a);
}`,
    }],
  }),

  defineNode({
    id: 'filter.minMax',
    name: 'Minimum / Maximum',
    category: 'Filter',
    description: 'Morphology on images or masks: dilate (maximum: grows bright areas / masks), erode (minimum), open (erode → dilate: removes small bright specks) and close (dilate → erode: fills small holes). Square (separable) or disc structuring element.',
    tags: ['dilate', 'erode', 'morphology', 'maximum', 'minimum', 'grow', 'shrink', 'choke', 'spread', 'open', 'close'],
    color: C,
    inputs: img,
    params: {
      operation: { type: 'enum', default: 'dilate (max)', options: MORPH_OPS, label: 'Operation' },
      radius: { type: 'float', default: 4, min: 0, max: 100, step: 0.5, pixels: true, label: 'Radius' },
      shape: { type: 'enum', default: 'square', options: ['square', 'disc'], label: 'Shape' },
    },
    passes: [0, 1, 2, 3].map((stage) => ({
      uniforms: (ctx: PassContext) => ({ u_R: Math.round(Math.max(0, num(ctx.params, 'radius', 4)) * ctx.scale) }),
      frag: morphFrag(stage === 0 ? 'u_image' : `u_pass${stage - 1}`, stage),
    })),
  }),

  defineNode({
    id: 'filter.glow',
    name: 'Soft Glow',
    category: 'Filter',
    description: 'Orton-style soft glow: a wide gaussian copy of the image (optionally only above a threshold) is added or screened back in linear light, tinted. Unlike Bloom it glows the whole picture by default.',
    tags: ['glow', 'orton', 'dreamy', 'soft focus', 'diffusion', 'haze', 'romantic'],
    color: C,
    inputs: img,
    params: {
      radius: { type: 'float', default: 40, min: 1, max: 400, step: 1, pixels: true, label: 'Radius' },
      intensity: { type: 'float', default: 0.5, min: 0, max: 3, step: 0.01, label: 'Intensity' },
      threshold: { type: 'float', default: 0, min: 0, max: 1, step: 0.01, label: 'Threshold' },
      mode: { type: 'enum', default: 'screen', options: ['screen', 'add', 'soft light'], label: 'Blend' },
      tint: { type: 'color', default: [1, 1, 1, 1], label: 'Tint' },
      saturation: { type: 'float', default: 1, min: 0, max: 2, step: 0.01, label: 'Glow saturation' },
    },
    passes: [
      ...blurPasses(0, sig('radius', 40), /* glsl */ `
vec4 ex_src(ivec2 p) {
  vec4 c = texelFetch(u_image, p, 0);
  vec3 l = srgbToLinear(max(c.rgb, 0.0));
  float k = u_threshold > 0.0 ? smoothstep(u_threshold - 0.15, u_threshold + 0.15, luma(c.rgb)) : 1.0;
  return vec4(l * k * c.a, c.a);
}`),
      {
        uniforms: (ctx) => blurUniforms(sig('radius', 40)(ctx)),
        frag: /* glsl */ `
uniform float u_bd;
${GLSL_BLUR_UV}
void main(){
  vec4 c = texture(u_image, v_uv);
  vec3 g = texture(u_pass2, ex_blurUV(v_uv, u_bd, u_pass2_size)).rgb;
  g = mix(vec3(luma(g)), g, u_saturation) * srgbToLinear(u_tint.rgb) * u_intensity;
  vec3 l = srgbToLinear(max(c.rgb, 0.0));
  vec3 o;
  if (u_mode == 0) o = linearToSrgb(1.0 - (1.0 - min(l, 1.0)) * (1.0 - min(g, 1.0)));
  else if (u_mode == 1) o = linearToSrgb(l + g);
  else o = mix(c.rgb, blendSoftLight(c.rgb, linearToSrgb(g)), min(u_intensity, 1.0));
  fragColor = vec4(o, c.a);
}` },
    ],
  }),

  defineNode({
    id: 'filter.frequencySeparation',
    name: 'Frequency Separation',
    category: 'Filter',
    description: 'Splits the image into `low` (gaussian blur: colour & tone) and `high` (texture: (image − low) / 2 + 0.5). Retouch each, then recombine with Blend → Linear Light (high over low, 100%) for an exact reconstruction.',
    tags: ['frequency separation', 'retouch', 'skin', 'texture', 'beauty', 'high pass', 'split'],
    color: C,
    inputs: img,
    outputs: { low: { type: 'image', label: 'Low' }, high: { type: 'image', label: 'High' } },
    params: {
      radius: { type: 'float', default: 8, min: 0.5, max: 200, step: 0.1, pixels: true, label: 'Radius' },
    },
    passes: [
      ...blurPasses(0, sig('radius', 8), srgbSrc),
      {
        output: 'low',
        uniforms: (ctx) => blurUniforms(sig('radius', 8)(ctx)),
        frag: /* glsl */ `
uniform float u_bd;
${GLSL_BLUR_UV}
void main(){
  vec4 c = texture(u_image, v_uv);
  vec4 b = texture(u_pass2, ex_blurUV(v_uv, u_bd, u_pass2_size));
  fragColor = vec4(b.a > 1e-5 ? b.rgb / b.a : c.rgb, c.a);
}` },
      {
        output: 'high',
        frag: `void main(){ vec4 c = texture(u_image, v_uv); fragColor = vec4((c.rgb - texture(u_pass3, v_uv).rgb) * 0.5 + 0.5, c.a); }`,
      },
    ],
  }),
] satisfies NodeDef[];
