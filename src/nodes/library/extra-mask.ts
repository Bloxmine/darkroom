/**
 * Mask nodes: all produce a `mask` output (value in .r, also written to g/b, alpha 1).
 * Generators take an optional `image` input only as a size reference.
 * Geometry is in an aspect-correct space where the image's short side = 1, so
 * masks look identical at any render scale.
 */
import { defineNode } from '../../core/registry';
import type { NodeDef, PassContext } from '../../core/types';
import { num } from './shared';
import { GLSL_BLUR_UV, GLSL_OKLAB, blurPasses, blurUniforms } from './extra-shared';

const C = '#12a594';
const maskOut = { out: { type: 'mask' as const, label: 'Mask' } };
const sizeRef = { image: { type: 'image' as const, optional: true, label: 'Size ref' } };
const maskIn = { mask: { type: 'mask' as const, label: 'Mask' } };
const invertP = { type: 'bool' as const, default: false, label: 'Invert' };

/** Aspect-correct coordinates (short side = 1) relative to a uv point. */
const GLSL_ASPECT = /* glsl */ `
vec2 ex_aspect(vec2 uv) { return uv * u_resolution / min(u_resolution.x, u_resolution.y); }
vec2 ex_rot(vec2 p, float deg) { float a = radians(deg), c = cos(a), s = sin(a); return mat2(c, s, -s, c) * p; }
void ex_out(float m) { m = clamp(u_invert ? 1.0 - m : m, 0.0, 1.0); fragColor = vec4(m, m, m, 1.0); }
`;

const sigmaOf = (key: string, def: number) => (ctx: PassContext) => Math.max(0, num(ctx.params, key, def)) * ctx.scale * 0.5;

export default [
  defineNode({
    id: 'mask.colorRange',
    name: 'Color Range',
    category: 'Mask',
    description: 'Selects pixels near a key colour (chroma key / colour range). Distance is measured perceptually in Oklab (luminance weighted by "Lightness weight"), by hue only, or in RGB. Tolerance is the fully-selected radius, softness the falloff beyond it.',
    tags: ['chroma key', 'green screen', 'select colour', 'color range', 'key', 'matte', 'sky'],
    color: C,
    inputs: { image: { type: 'image' } },
    outputs: maskOut,
    params: {
      color: { type: 'color', default: [0.25, 0.6, 0.7, 1], label: 'Key colour' },
      space: { type: 'enum', default: 'oklab', options: ['oklab', 'hue', 'rgb'], label: 'Distance' },
      tolerance: { type: 'float', default: 0.15, min: 0, max: 1, step: 0.005, label: 'Tolerance' },
      softness: { type: 'float', default: 0.1, min: 0, max: 1, step: 0.005, label: 'Softness' },
      lumaWeight: { type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Lightness weight', description: 'Oklab only: 0 ignores brightness (keys shadows and highlights of the colour alike).' },
      invert: invertP,
    },
    passes: [{
      frag: /* glsl */ `
${GLSL_OKLAB}
${GLSL_ASPECT}
void main(){
  vec4 c = texture(u_image, v_uv);
  float d;
  if (u_space == 0) {
    vec3 a = ex_srgb2oklab(c.rgb), b = ex_srgb2oklab(u_color.rgb);
    vec3 diff = a - b; diff.x *= u_lumaWeight;
    d = length(diff) * 2.0;
  } else if (u_space == 1) {
    vec3 a = rgb2hsv(max(c.rgb, 0.0)), b = rgb2hsv(max(u_color.rgb, 0.0));
    float dh = abs(a.x - b.x); dh = min(dh, 1.0 - dh) * 2.0;
    // grey pixels have no meaningful hue: push them out of range
    d = dh + (1.0 - smoothstep(0.03, 0.15, a.y));
  } else {
    d = length(c.rgb - u_color.rgb) / sqrt(3.0);
  }
  float m = 1.0 - smoothstep(u_tolerance, u_tolerance + max(u_softness, 1e-4), d);
  ex_out(m * step(0.5, c.a));
}`,
    }],
  }),

  defineNode({
    id: 'mask.lumaRange',
    name: 'Luminance Range',
    category: 'Mask',
    description: 'Luminosity mask: shadows (< ⅓), midtones, highlights (> ⅔) or a custom low..high band, with feathered edges. Luma is Rec.709 of the sRGB values.',
    tags: ['luminosity mask', 'shadows', 'highlights', 'midtones', 'tonal range', 'select'],
    color: C,
    inputs: { image: { type: 'image' } },
    outputs: maskOut,
    params: {
      range: { type: 'enum', default: 'highlights', options: ['shadows', 'midtones', 'highlights', 'custom'], label: 'Range' },
      low: { type: 'float', default: 0.4, min: 0, max: 1, step: 0.005, label: 'Low (custom)' },
      high: { type: 'float', default: 0.8, min: 0, max: 1, step: 0.005, label: 'High (custom)' },
      feather: { type: 'float', default: 0.12, min: 0, max: 0.5, step: 0.005, label: 'Feather' },
      invert: invertP,
    },
    passes: [{
      frag: /* glsl */ `
${GLSL_ASPECT}
void main(){
  float l = luma(texture(u_image, v_uv).rgb);
  float lo = u_low, hi = u_high;
  if (u_range == 0) { lo = -1.0; hi = 1.0 / 3.0; }
  else if (u_range == 1) { lo = 1.0 / 3.0; hi = 2.0 / 3.0; }
  else if (u_range == 2) { lo = 2.0 / 3.0; hi = 2.0; }
  float f = max(u_feather, 1e-4);
  float m = smoothstep(lo - f, lo + f, l) * (1.0 - smoothstep(hi - f, hi + f, l));
  ex_out(m);
}`,
    }],
  }),

  defineNode({
    id: 'mask.shape',
    name: 'Shape Mask',
    category: 'Mask',
    description: 'Rectangle, ellipse or rounded rectangle. Centre and size are fractions of the image; corner radius and feather are fractions of the short side (scale independent). Optional image input only sets the size.',
    tags: ['rectangle', 'ellipse', 'circle', 'rounded', 'vignette', 'matte', 'spot'],
    color: C,
    inputs: sizeRef,
    outputs: maskOut,
    params: {
      shape: { type: 'enum', default: 'ellipse', options: ['rectangle', 'ellipse', 'rounded rectangle'], label: 'Shape' },
      center: { type: 'vec2', default: [0.5, 0.5], min: 0, max: 1, step: 0.001, label: 'Centre' },
      size: { type: 'vec2', default: [0.6, 0.7], min: 0, max: 2, step: 0.001, label: 'Size' },
      rotation: { type: 'float', default: 0, min: -180, max: 180, step: 0.5, label: 'Rotation (°)' },
      roundness: { type: 'float', default: 0.1, min: 0, max: 1, step: 0.005, label: 'Corner radius' },
      feather: { type: 'float', default: 0.1, min: 0, max: 1, step: 0.005, label: 'Feather' },
      invert: invertP,
    },
    passes: [{
      frag: /* glsl */ `
${GLSL_ASPECT}
void main(){
  vec2 p = ex_rot(ex_aspect(v_uv) - ex_aspect(u_center), u_rotation);
  vec2 he = max(ex_aspect(u_size) * 0.5, vec2(1e-4));
  float d;
  if (u_shape == 1) {
    // ellipse: first-order distance estimate
    float k = length(p / he);
    vec2 g = p / (he * he);
    d = (k - 1.0) * k / max(length(g), 1e-6);
  } else {
    float r = u_shape == 2 ? min(u_roundness, min(he.x, he.y)) : 0.0;
    vec2 q = abs(p) - he + r;
    d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
  }
  float px = 1.0 / min(u_resolution.x, u_resolution.y);
  float f = max(u_feather, px);
  ex_out(1.0 - smoothstep(-0.5 * f, 0.5 * f, d));
}`,
    }],
  }),

  defineNode({
    id: 'mask.linearGradient',
    name: 'Linear Gradient Mask',
    category: 'Mask',
    description: 'Graduated mask: 1 at `start`, fading to 0 at `end` (points in 0..1 image coords) — a graduated filter for skies or foregrounds.',
    tags: ['graduated filter', 'gradient', 'ramp', 'sky', 'nd grad', 'fade'],
    color: C,
    inputs: sizeRef,
    outputs: maskOut,
    params: {
      start: { type: 'vec2', default: [0.5, 0.15], min: -1, max: 2, step: 0.001, label: 'Start (1)' },
      end: { type: 'vec2', default: [0.5, 0.6], min: -1, max: 2, step: 0.001, label: 'End (0)' },
      curve: { type: 'enum', default: 'smooth', options: ['linear', 'smooth'], label: 'Curve' },
      invert: invertP,
    },
    passes: [{
      frag: /* glsl */ `
${GLSL_ASPECT}
void main(){
  vec2 a = ex_aspect(u_start), b = ex_aspect(u_end), p = ex_aspect(v_uv);
  vec2 ab = b - a;
  float t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-8), 0.0, 1.0);
  if (u_curve == 1) t = smoothstep(0.0, 1.0, t);
  ex_out(1.0 - t);
}`,
    }],
  }),

  defineNode({
    id: 'mask.radialGradient',
    name: 'Radial Gradient Mask',
    category: 'Mask',
    description: 'Elliptical radial mask (Lightroom radial filter): 1 inside, feathering to 0 at the edge. Size is a fraction of the image width/height; feather is the fraction of the radius that fades.',
    tags: ['radial filter', 'vignette', 'spotlight', 'ellipse', 'gradient', 'falloff'],
    color: C,
    inputs: sizeRef,
    outputs: maskOut,
    params: {
      center: { type: 'vec2', default: [0.5, 0.5], min: -1, max: 2, step: 0.001, label: 'Centre' },
      size: { type: 'vec2', default: [0.8, 0.8], min: 0, max: 3, step: 0.001, label: 'Size' },
      rotation: { type: 'float', default: 0, min: -180, max: 180, step: 0.5, label: 'Rotation (°)' },
      feather: { type: 'float', default: 0.6, min: 0, max: 1, step: 0.005, label: 'Feather' },
      invert: invertP,
    },
    passes: [{
      frag: /* glsl */ `
${GLSL_ASPECT}
void main(){
  vec2 p = ex_rot(ex_aspect(v_uv) - ex_aspect(u_center), u_rotation);
  vec2 r = max(ex_aspect(u_size) * 0.5, vec2(1e-4));
  float e = length(p / r);
  float f = clamp(u_feather, 0.0, 1.0);
  float m = 1.0 - smoothstep(1.0 - f - 1e-3, 1.0, e);
  ex_out(m);
}`,
    }],
  }),

  defineNode({
    id: 'mask.edges',
    name: 'Edge Mask',
    category: 'Mask',
    description: 'Mask of edges/detail: Sobel gradient of the gaussian-smoothed luma, mapped through low..high. Use it to sharpen only edges, or invert it to protect them (e.g. denoise flat areas only).',
    tags: ['edge mask', 'detail', 'sharpening mask', 'sobel', 'outline'],
    color: C,
    inputs: { image: { type: 'image' } },
    outputs: maskOut,
    params: {
      radius: { type: 'float', default: 2, min: 0, max: 50, step: 0.1, pixels: true, label: 'Smoothing' },
      low: { type: 'float', default: 0.01, min: 0, max: 0.5, step: 0.001, label: 'Low' },
      high: { type: 'float', default: 0.06, min: 0, max: 0.5, step: 0.001, label: 'High' },
      invert: invertP,
    },
    passes: [
      ...blurPasses(0, sigmaOf('radius', 2), `vec4 ex_src(ivec2 p) { return vec4(luma(texelFetch(u_image, p, 0).rgb)); }`),
      {
        uniforms: (ctx) => blurUniforms(sigmaOf('radius', 2)(ctx)),
        frag: /* glsl */ `
uniform float u_bd;
${GLSL_BLUR_UV}
${GLSL_ASPECT}
float S(vec2 o) { return texture(u_pass2, ex_blurUV(v_uv + o / u_resolution, u_bd, u_pass2_size)).r; }
void main(){
  float tl = S(vec2(-1, -1)), tc = S(vec2(0, -1)), tr = S(vec2(1, -1));
  float ml = S(vec2(-1, 0)), mr = S(vec2(1, 0));
  float bl = S(vec2(-1, 1)), bc = S(vec2(0, 1)), br = S(vec2(1, 1));
  float gx = ((tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl)) / 8.0;
  float gy = ((bl + 2.0 * bc + br) - (tl + 2.0 * tc + tr)) / 8.0;
  float g = length(vec2(gx, gy)) * u_scale; // gradient per full-res pixel
  ex_out(smoothstep(u_low, max(u_high, u_low + 1e-4), g));
}` },
    ],
  }),

  defineNode({
    id: 'mask.blur',
    name: 'Feather Mask',
    category: 'Mask',
    description: 'Gaussian-feathers a mask (σ = radius / 2, constant cost at any radius). Choke/spread then shifts the soft edge in (−) or out (+).',
    tags: ['feather', 'soften', 'blur mask', 'refine edge', 'choke', 'spread'],
    color: C,
    inputs: maskIn,
    outputs: maskOut,
    params: {
      radius: { type: 'float', default: 20, min: 0, max: 500, step: 0.5, pixels: true, label: 'Radius' },
      shift: { type: 'float', default: 0, min: -1, max: 1, step: 0.01, label: 'Choke / spread' },
      invert: invertP,
    },
    passes: [
      ...blurPasses(0, sigmaOf('radius', 20), `vec4 ex_src(ivec2 p) { return vec4(texelFetch(u_mask, min(p, textureSize(u_mask, 0) - 1), 0).r); }`),
      {
        uniforms: (ctx) => blurUniforms(sigmaOf('radius', 20)(ctx)),
        frag: /* glsl */ `
uniform float u_bd;
${GLSL_BLUR_UV}
${GLSL_ASPECT}
void main(){
  float m = texture(u_pass2, ex_blurUV(v_uv, u_bd, u_pass2_size)).r;
  // shift the 0.5 iso-line: spread lifts, choke lowers
  float s = clamp(u_shift, -0.99, 0.99);
  m = s >= 0.0 ? clamp(m / (1.0 - s), 0.0, 1.0) : clamp((m + s) / (1.0 + s), 0.0, 1.0);
  ex_out(m);
}` },
    ],
  }),

  defineNode({
    id: 'mask.combine',
    name: 'Combine Masks',
    category: 'Mask',
    description: 'Boolean-style mask maths: union (max), add, subtract (a − b), intersect (min), multiply, difference |a − b|, exclusion (xor-like). Opacity scales b.',
    tags: ['add', 'subtract', 'intersect', 'union', 'boolean', 'mask math'],
    color: C,
    inputs: {
      a: { type: 'mask', label: 'A' },
      b: { type: 'mask', label: 'B' },
    },
    outputs: maskOut,
    params: {
      mode: { type: 'enum', default: 'union', options: ['union', 'add', 'subtract', 'intersect', 'multiply', 'difference', 'exclusion'], label: 'Mode' },
      opacity: { type: 'float', default: 1, min: 0, max: 1, step: 0.01, label: 'B opacity' },
      invert: invertP,
    },
    passes: [{
      frag: /* glsl */ `
${GLSL_ASPECT}
void main(){
  float a = clamp(texture(u_a, v_uv).r, 0.0, 1.0), b = clamp(texture(u_b, v_uv).r, 0.0, 1.0) * u_opacity;
  float m;
  switch (u_mode) {
    case 0: m = max(a, b); break;
    case 1: m = a + b; break;
    case 2: m = a - b; break;
    case 3: m = min(a, b); break;
    case 4: m = a * b; break;
    case 5: m = abs(a - b); break;
    default: m = a + b - 2.0 * a * b;
  }
  ex_out(m);
}`,
    }],
  }),

  defineNode({
    id: 'mask.invert',
    name: 'Invert Mask',
    category: 'Mask',
    description: '1 − mask.',
    tags: ['invert', 'negate', 'flip selection'],
    color: C,
    inputs: maskIn,
    outputs: maskOut,
    params: {},
    passes: [{ frag: `void main(){ float m = 1.0 - clamp(texture(u_mask, v_uv).r, 0.0, 1.0); fragColor = vec4(m, m, m, 1.0); }` }],
  }),

  defineNode({
    id: 'mask.levels',
    name: 'Mask Levels',
    category: 'Mask',
    description: 'Contrast/levels for masks: maps low..high to 0..1 with a gamma (> 1 grows the mask), then to the output range. Tighten soft keys or fade a mask.',
    tags: ['levels', 'contrast', 'tighten', 'clip', 'remap', 'gamma'],
    color: C,
    inputs: maskIn,
    outputs: maskOut,
    params: {
      low: { type: 'float', default: 0.2, min: 0, max: 1, step: 0.005, label: 'Low' },
      high: { type: 'float', default: 0.8, min: 0, max: 1, step: 0.005, label: 'High' },
      gamma: { type: 'float', default: 1, min: 0.1, max: 10, step: 0.01, label: 'Gamma' },
      outLow: { type: 'float', default: 0, min: 0, max: 1, step: 0.005, label: 'Output low' },
      outHigh: { type: 'float', default: 1, min: 0, max: 1, step: 0.005, label: 'Output high' },
      invert: invertP,
    },
    passes: [{
      frag: /* glsl */ `
${GLSL_ASPECT}
void main(){
  float m = texture(u_mask, v_uv).r;
  m = clamp((m - u_low) / max(u_high - u_low, 1e-4), 0.0, 1.0);
  m = pow(m, 1.0 / max(u_gamma, 1e-3));
  ex_out(mix(u_outLow, u_outHigh, m));
}`,
    }],
  }),

  defineNode({
    id: 'mask.view',
    name: 'View Mask',
    category: 'Mask',
    description: 'Debug view: tints the selected (or unselected, "rubylith") area of the image with a colour, or shows the mask alone; optional contour at the 50% line.',
    tags: ['debug', 'overlay', 'quick mask', 'rubylith', 'preview', 'visualise'],
    color: C,
    inputs: {
      image: { type: 'image', label: 'Image' },
      mask: { type: 'mask', label: 'Mask' },
    },
    params: {
      mode: { type: 'enum', default: 'tint selected', options: ['tint selected', 'tint unselected', 'mask only', 'image × mask'], label: 'Mode' },
      color: { type: 'color', default: [1, 0.1, 0.1, 1], label: 'Overlay colour' },
      opacity: { type: 'float', default: 0.55, min: 0, max: 1, step: 0.01, label: 'Opacity' },
      outline: { type: 'bool', default: false, label: '50% contour' },
    },
    passes: [{
      frag: /* glsl */ `
void main(){
  vec4 c = texture(u_image, v_uv);
  float m = clamp(texture(u_mask, v_uv).r, 0.0, 1.0);
  vec3 o;
  if (u_mode == 2) o = vec3(m);
  else if (u_mode == 3) o = c.rgb * m;
  else {
    float w = u_mode == 0 ? m : 1.0 - m;
    vec3 grey = vec3(luma(c.rgb));
    o = mix(c.rgb, mix(grey, u_color.rgb, 0.75), w * u_opacity);
  }
  if (u_outline) {
    float fw = max(fwidth(m), 1e-4);
    float line = 1.0 - smoothstep(0.0, 1.5 * fw, abs(m - 0.5));
    o = mix(o, vec3(1.0, 1.0, 0.2), line * 0.9);
  }
  fragColor = vec4(o, u_mode == 2 ? 1.0 : c.a);
}`,
    }],
  }),
] satisfies NodeDef[];
