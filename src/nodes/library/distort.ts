import { defineNode } from '../../core/registry';
import type { NodeDef, PassContext } from '../../core/types';
import { num } from './shared';

const C = '#8e4ec6';
const img = { image: { type: 'image' as const } };

/** Sample with an edge mode: 0 clamp, 1 transparent, 2 black, 3 repeat, 4 mirror. */
const GLSL_EDGE = /* glsl */ `
vec4 lib_sampleEdge(sampler2D t, vec2 uv, int mode) {
  bool outside = any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)));
  if (mode == 1 && outside) return vec4(0.0);
  if (mode == 2 && outside) return vec4(0.0, 0.0, 0.0, 1.0);
  if (mode == 3) uv = fract(uv);
  if (mode == 4) uv = 1.0 - abs(1.0 - mod(uv, 2.0));
  return texClamp(t, uv);
}
`;

export default [
  defineNode({
    id: 'distort.transform',
    name: 'Transform',
    category: 'Distort',
    description: 'Offset (fraction of the image size, + = right/down), uniform scale, rotation (+ = clockwise) about the centre, and flips. Wrap decides what fills the uncovered area.',
    tags: ['move', 'translate', 'rotate', 'scale', 'zoom', 'flip', 'mirror', 'tile'],
    color: C,
    inputs: img,
    params: {
      offset: { type: 'vec2', default: [0, 0], min: -1, max: 1, step: 0.001, label: 'Offset' },
      scale: { type: 'float', default: 1, min: 0.01, max: 20, step: 0.01, label: 'Scale' },
      rotate: { type: 'float', default: 0, min: -180, max: 180, step: 0.1, label: 'Rotate (°)' },
      flipX: { type: 'bool', default: false, label: 'Flip horizontal' },
      flipY: { type: 'bool', default: false, label: 'Flip vertical' },
      wrap: { type: 'enum', default: 'transparent', options: ['clamp', 'repeat', 'transparent'], label: 'Wrap' },
    },
    passes: [{
      uniforms: (ctx) => ({ u_tscale: Math.max(1e-3, num(ctx.params, 'scale', 1)) }),
      frag: /* glsl */ `
uniform float u_tscale;
${GLSL_EDGE}
void main(){
  vec2 res = u_resolution;
  vec2 q = (v_uv - 0.5 - u_offset) * res;
  float a = radians(u_rotate);
  q = mat2(cos(a), -sin(a), sin(a), cos(a)) * q; // inverse of a clockwise (y-down) rotation
  q /= u_tscale;
  vec2 uv = q / res + 0.5;
  if (u_flipX) uv.x = 1.0 - uv.x;
  if (u_flipY) uv.y = 1.0 - uv.y;
  int m = u_wrap == 0 ? 0 : (u_wrap == 1 ? 3 : 1);
  fragColor = lib_sampleEdge(u_image, uv, m);
}` }],
  }),

  defineNode({
    id: 'distort.lens',
    name: 'Lens Distortion',
    category: 'Distort',
    description: 'Radial (Brown) lens distortion: k1 > 0 barrel, k1 < 0 pincushion; k2 adds a 4th-order term. Radius is normalised to 1 at the corners.',
    tags: ['barrel', 'pincushion', 'fisheye', 'lens', 'distortion', 'warp'],
    color: C,
    inputs: img,
    params: {
      k1: { type: 'float', default: 0.1, min: -1, max: 1, step: 0.005, label: 'k1 (barrel/pincushion)' },
      k2: { type: 'float', default: 0, min: -1, max: 1, step: 0.005, label: 'k2' },
      zoom: { type: 'float', default: 1, min: 0.25, max: 4, step: 0.01, label: 'Zoom' },
      center: { type: 'vec2', default: [0.5, 0.5], min: 0, max: 1, step: 0.005, label: 'Center' },
      edge: { type: 'enum', default: 'clamp', options: ['clamp', 'transparent', 'black'], label: 'Edges' },
    },
    passes: [{
      frag: /* glsl */ `
${GLSL_EDGE}
void main(){
  vec2 res = u_resolution;
  vec2 p = (v_uv - u_center) * res;
  vec2 rn = p / (0.5 * length(res));
  float r2 = dot(rn, rn);
  float f = 1.0 + u_k1 * r2 + u_k2 * r2 * r2;
  vec2 uv = u_center + (p * f / max(u_zoom, 1e-3)) / res;
  fragColor = lib_sampleEdge(u_image, uv, u_edge);
}` }],
  }),

  defineNode({
    id: 'distort.chromaticAberration',
    name: 'Chromatic Aberration',
    category: 'Distort',
    description: 'Shifts red and blue in opposite directions — radially from the centre (amount reached at the corners, shaped by falloff) or along a fixed angle.',
    tags: ['ca', 'fringe', 'rgb split', 'lens', 'prism'],
    color: C,
    inputs: img,
    params: {
      amount: { type: 'float', default: 4, min: -100, max: 100, step: 0.1, pixels: true, label: 'Amount' },
      mode: { type: 'enum', default: 'radial', options: ['radial', 'linear'], label: 'Mode' },
      angle: { type: 'float', default: 0, min: -180, max: 180, step: 1, label: 'Angle (°)' },
      falloff: { type: 'float', default: 1, min: 0.1, max: 5, step: 0.05, label: 'Falloff' },
      center: { type: 'vec2', default: [0.5, 0.5], min: 0, max: 1, step: 0.005, label: 'Center' },
    },
    passes: [{
      frag: /* glsl */ `
void main(){
  vec2 res = u_resolution;
  vec2 d;
  if (u_mode == 0) {
    vec2 p = (v_uv - u_center) * res;
    float r = length(p) / (0.5 * length(res));
    d = (length(p) > 1e-4 ? normalize(p) : vec2(0.0)) * pow(r, u_falloff);
  } else {
    float a = radians(u_angle);
    d = vec2(cos(a), sin(a));
  }
  vec2 o = d * u_amount * u_scale / res;
  vec4 c = texClamp(u_image, v_uv);
  float r = texClamp(u_image, v_uv - o).r;
  float b = texClamp(u_image, v_uv + o).b;
  fragColor = vec4(r, c.g, b, c.a);
}` }],
  }),

  defineNode({
    id: 'distort.displace',
    name: 'Displace',
    category: 'Distort',
    description: 'Offsets pixels by a displacement map (stretched to fit). Luma: mid-grey = no shift, along Angle. RG: red → x, green → y (0.5 = no shift).',
    tags: ['displacement', 'warp', 'distort', 'refraction', 'glass'],
    color: C,
    inputs: {
      image: { type: 'image' },
      map: { type: 'image', label: 'Map' },
    },
    params: {
      amount: { type: 'float', default: 20, min: -500, max: 500, step: 0.5, pixels: true, label: 'Amount' },
      mode: { type: 'enum', default: 'luma', options: ['luma', 'rg'], label: 'Mode' },
      angle: { type: 'float', default: 0, min: -180, max: 180, step: 1, label: 'Angle (°)', description: 'Luma mode direction.' },
    },
    passes: [{
      frag: /* glsl */ `
void main(){
  vec4 m = texture(u_map, v_uv);
  vec2 d;
  if (u_mode == 0) { float a = radians(u_angle); d = (luma(m.rgb) - 0.5) * 2.0 * vec2(cos(a), sin(a)); }
  else d = (m.rg - 0.5) * 2.0;
  fragColor = texClamp(u_image, v_uv + d * u_amount * u_scale / u_resolution);
}` }],
  }),

  defineNode({
    id: 'distort.pixelate',
    name: 'Pixelate',
    category: 'Distort',
    description: 'Averages square blocks (size in pixels, grid anchored top-left). Output keeps the full size.',
    tags: ['mosaic', 'blocks', 'pixel art', 'censor', '8-bit'],
    color: C,
    inputs: img,
    params: {
      size: { type: 'float', default: 8, min: 1, max: 500, step: 1, pixels: true, label: 'Block size' },
    },
    passes: [{
      frag: /* glsl */ `
void main(){
  float b = max(u_size * u_scale, 1.0);
  vec2 cell = floor(pixelCoord() / b);
  vec2 lo = cell * b;
  vec2 hi = min(lo + b, u_resolution);
  int n = int(clamp(ceil(b / 2.0), 1.0, 8.0));
  vec4 acc = vec4(0.0);
  for (int y = 0; y < 8; y++) { if (y >= n) break;
    for (int x = 0; x < 8; x++) { if (x >= n) break;
      vec2 p = mix(lo, hi, (vec2(float(x), float(y)) + 0.5) / float(n));
      acc += texture(u_image, p / u_resolution);
    }
  }
  fragColor = acc / float(n * n);
}` }],
  }),

  defineNode({
    id: 'distort.downsample',
    name: 'Downsample',
    category: 'Distort',
    description: 'Renders the image at factor × (full) resolution, then scales it back up with the chosen filter (nearest = blocky, linear = soft, cubic = Catmull-Rom).',
    tags: ['resolution', 'lo-fi', 'resample', 'low res', 'upscale', 'scale'],
    color: C,
    inputs: img,
    params: {
      factor: { type: 'float', default: 0.5, min: 0.02, max: 1, step: 0.005, label: 'Factor' },
      downFilter: { type: 'enum', default: 'box', options: ['box', 'linear'], label: 'Down filter' },
      upFilter: { type: 'enum', default: 'linear', options: ['nearest', 'linear', 'cubic'], label: 'Up filter' },
    },
    passes: [
      {
        size: (ctx: PassContext) => {
          const f = Math.min(1, Math.max(0.02, num(ctx.params, 'factor', 0.5)));
          // factor is relative to FULL resolution, so preview (scale < 1) gets the same block size
          const k = Math.min(1, f / Math.max(ctx.scale, 1e-3));
          return [Math.max(1, Math.round(ctx.width * k)), Math.max(1, Math.round(ctx.height * k))];
        },
        frag: /* glsl */ `
void main(){
  if (u_downFilter == 1) { fragColor = texture(u_image, v_uv); return; }
  vec2 fp = u_image_size / u_resolution;  // source texels per output texel
  ivec2 n = ivec2(clamp(ceil(fp), 1.0, 24.0));
  vec2 lo = floor(v_uv * u_resolution) / u_resolution;
  vec2 cellUv = 1.0 / u_resolution;
  vec4 acc = vec4(0.0);
  for (int y = 0; y < 24; y++) { if (y >= n.y) break;
    for (int x = 0; x < 24; x++) { if (x >= n.x) break;
      acc += texture(u_image, lo + (vec2(float(x), float(y)) + 0.5) / vec2(n) * cellUv);
    }
  }
  fragColor = acc / float(n.x * n.y);
}` },
      {
        frag: /* glsl */ `
vec4 cr(vec4 a, vec4 b, vec4 c, vec4 d, float t) {
  return b + 0.5 * t * (c - a + t * (2.0 * a - 5.0 * b + 4.0 * c - d + t * (3.0 * (b - c) + d - a)));
}
void main(){
  vec2 sz = u_pass0_size;
  if (u_upFilter == 0) { fragColor = texel(u_pass0, ivec2(floor(v_uv * sz))); return; }
  if (u_upFilter == 1) { fragColor = texture(u_pass0, v_uv); return; }
  vec2 p = v_uv * sz - 0.5;
  ivec2 i = ivec2(floor(p));
  vec2 f = p - floor(p);
  vec4 rows[4];
  for (int y = 0; y < 4; y++) {
    ivec2 q = i + ivec2(-1, y - 1);
    rows[y] = cr(texel(u_pass0, q), texel(u_pass0, q + ivec2(1, 0)), texel(u_pass0, q + ivec2(2, 0)), texel(u_pass0, q + ivec2(3, 0)), f.x);
  }
  fragColor = cr(rows[0], rows[1], rows[2], rows[3], f.y);
}` },
    ],
  }),

  defineNode({
    id: 'distort.wave',
    name: 'Wave',
    category: 'Distort',
    description: 'Sine-wave displacement. Horizontal shifts rows sideways (wave travels down the image); vertical shifts columns up/down. Phase in cycles (1 = one period).',
    tags: ['ripple', 'sine', 'wobble', 'warp', 'tracking'],
    color: C,
    inputs: img,
    params: {
      amplitude: { type: 'float', default: 10, min: -500, max: 500, step: 0.5, pixels: true, label: 'Amplitude' },
      wavelength: { type: 'float', default: 100, min: 1, max: 5000, step: 1, pixels: true, label: 'Wavelength' },
      phase: { type: 'float', default: 0, min: -10, max: 10, step: 0.01, label: 'Phase (cycles)' },
      direction: { type: 'enum', default: 'horizontal', options: ['horizontal', 'vertical'], label: 'Direction' },
    },
    passes: [{
      frag: /* glsl */ `
void main(){
  vec2 pc = pixelCoord() / u_scale; // full-res pixel coordinate
  float along = u_direction == 0 ? pc.y : pc.x;
  float s = sin(TAU * (along / max(u_wavelength, 1e-3) + u_phase)) * u_amplitude * u_scale;
  vec2 o = u_direction == 0 ? vec2(s, 0.0) : vec2(0.0, s);
  fragColor = texClamp(u_image, v_uv + o / u_resolution);
}` }],
  }),

  defineNode({
    id: 'distort.mirror',
    name: 'Mirror',
    category: 'Distort',
    description: 'Reflects one half of the image onto the other (kaleidoscope-lite).',
    tags: ['symmetry', 'reflect', 'kaleidoscope'],
    color: C,
    inputs: img,
    params: {
      axis: { type: 'enum', default: 'vertical', options: ['vertical', 'horizontal', 'both'], label: 'Axis', description: 'vertical: left half mirrored onto the right.' },
      position: { type: 'float', default: 0.5, min: 0, max: 1, step: 0.005, label: 'Position' },
      flip: { type: 'bool', default: false, label: 'Keep other side' },
    },
    passes: [{
      frag: /* glsl */ `
void main(){
  vec2 uv = v_uv;
  float p = u_position;
  if (u_axis != 1) { if (!u_flip ? uv.x > p : uv.x < p) uv.x = 2.0 * p - uv.x; }
  if (u_axis != 0) { if (!u_flip ? uv.y > p : uv.y < p) uv.y = 2.0 * p - uv.y; }
  fragColor = texClamp(u_image, uv);
}` }],
  }),

  defineNode({
    id: 'distort.polar',
    name: 'Polar Coordinates',
    category: 'Distort',
    description: 'Rectangular → polar (wraps the image into a disc, "little planet") or polar → rectangular.',
    tags: ['polar', 'little planet', 'swirl', 'unwrap'],
    color: C,
    inputs: img,
    params: {
      mode: { type: 'enum', default: 'toPolar', options: ['toPolar', 'toRect'], label: 'Mode' },
    },
    passes: [{
      frag: /* glsl */ `
void main(){
  vec2 uv;
  if (u_mode == 0) {
    vec2 p = v_uv - 0.5;
    float r = length(p) * 2.0;
    float a = atan(p.x, -p.y) / TAU + 0.5;
    uv = vec2(a, 1.0 - r);
    if (r > 1.0) { fragColor = vec4(0.0); return; }
  } else {
    float a = (v_uv.x - 0.5) * TAU;
    float r = (1.0 - v_uv.y) * 0.5;
    uv = vec2(0.5) + r * vec2(sin(a), -cos(a));
  }
  fragColor = texClamp(u_image, uv);
}` }],
  }),
] satisfies NodeDef[];
