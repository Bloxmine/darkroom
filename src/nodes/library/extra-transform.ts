/**
 * Transform / canvas nodes: crop, resize, rotate 90°, flip, canvas size,
 * straighten, perspective (keystone), tile. Size-changing nodes implement
 * `size()` from the pure helpers in extra-shared.ts (unit-tested).
 */
import { defineNode } from '../../core/registry';
import type { NodeDef, Params, PassContext } from '../../core/types';
import { num } from './shared';
import {
  ANCHORS, ASPECTS, FIXED_ASPECTS, GLSL_CUBIC, RESIZE_MODES, STRAIGHTEN_MODES, canvasLayout, cropRect, invert3,
  resizeSize, squareToQuad, straightenFactor, straightenSize, toGlMat3, type Mat3,
} from './extra-shared';

const C = '#0090ff';
const img = { image: { type: 'image' as const } };

type Sizes = Record<string, { width: number; height: number }>;
const inSize = (inputSizes: Sizes, projectSize: { width: number; height: number }) => inputSizes.image ?? projectSize;
/** Full-resolution size of the `image` input, recovered from the render-scale size. */
const fullIn = (ctx: PassContext): [number, number] => {
  const s = ctx.inputSizes.image ?? { width: ctx.width, height: ctx.height };
  return [Math.max(1, Math.round(s.width / ctx.scale)), Math.max(1, Math.round(s.height / ctx.scale))];
};
const vec2p = (p: Params, k: string, d: [number, number]): [number, number] => {
  const v = p[k];
  return Array.isArray(v) && v.length >= 2 && typeof v[0] === 'number' ? [v[0], v[1] as number] : d;
};

const FILL = ['transparent', 'color', 'edge'];
const GLSL_FILL = /* glsl */ `
vec4 ex_fill(sampler2D t, vec2 uv, vec2 pxPerUv, float aa) {
  vec4 c = ex_cubic(t, clamp(uv, vec2(0.0), vec2(1.0)));
  if (u_fill == 2) return c;
  float cov = ex_cover(uv, pxPerUv, aa);
  vec4 bg = u_fill == 1 ? u_fillColor : vec4(0.0);
  // source-over of the (covered) image onto the fill
  float as = c.a * cov, ab = bg.a, ao = as + ab * (1.0 - as);
  return vec4(ao > 1e-5 ? (c.rgb * as + bg.rgb * ab * (1.0 - as)) / ao : vec3(0.0), ao);
}
`;

// ---------------------------------------------------------------------------
// Resize kernels (separable; kernel widened by the downscale factor = prefilter)
// ---------------------------------------------------------------------------
const RESIZE_FILTERS = ['nearest', 'bilinear', 'bicubic', 'lanczos3', 'area'];
const resizeFrag = (src: string, axis: 0 | 1, first: boolean, last: boolean) => /* glsl */ `
float K(float x) {
  x = abs(x);
  if (u_filter == 1) return max(1.0 - x, 0.0);
  if (u_filter == 2) return x < 1.0 ? 1.5 * x * x * x - 2.5 * x * x + 1.0 : (x < 2.0 ? -0.5 * x * x * x + 2.5 * x * x - 4.0 * x + 2.0 : 0.0);
  if (u_filter == 3) {
    if (x < 1e-5) return 1.0;
    if (x >= 3.0) return 0.0;
    float px = PI * x;
    return 3.0 * sin(px) * sin(px / 3.0) / (px * px);
  }
  return x <= 0.5 ? 1.0 : 0.0;
}
float support() { return u_filter == 1 ? 1.0 : (u_filter == 2 ? 2.0 : (u_filter == 3 ? 3.0 : 0.5)); }
vec4 load(int i, int j) {
  vec4 c = texel(${src}, ${axis === 0 ? 'ivec2(i, j)' : 'ivec2(j, i)'});
  ${first ? 'if (u_linear) c.rgb = srgbToLinear(max(c.rgb, 0.0)); c.rgb *= c.a;' : ''}
  return c;
}
vec4 finish(vec4 c) {
  ${last ? 'c = max(c, 0.0); c.a = min(c.a, 1.0); c.rgb = c.a > 1e-5 ? c.rgb / c.a : vec3(0.0); if (u_linear) c.rgb = linearToSrgb(c.rgb);' : ''}
  return c;
}
void main(){
  ivec2 o = ivec2(floor(v_uv * u_resolution));
  vec2 ssz = ${src}_size;
  float inN = ${axis === 0 ? 'ssz.x' : 'ssz.y'};
  float outN = ${axis === 0 ? 'u_resolution.x' : 'u_resolution.y'};
  int oc = ${axis === 0 ? 'o.x' : 'o.y'};
  int other = ${axis === 0 ? 'o.y' : 'o.x'};
  float ratio = inN / outN;
  float c = (float(oc) + 0.5) * ratio;
  if (u_filter == 0) { fragColor = finish(load(int(floor(c)), other)); return; }
  float f = max(1.0, ratio);
  float S = support() * f;
  int i0 = int(floor(c - S)), i1 = int(ceil(c + S));
  vec4 acc = vec4(0.0); float ws = 0.0;
  for (int k = 0; k < 600; k++) {
    int i = i0 + k;
    if (i > i1) break;
    float w = K((float(i) + 0.5 - c) / f);
    if (w == 0.0) continue;
    acc += load(clamp(i, 0, int(inN) - 1), other) * w;
    ws += w;
  }
  fragColor = finish(acc / max(ws, 1e-6));
}`;

export default [
  defineNode({
    id: 'transform.crop',
    name: 'Crop',
    category: 'Transform',
    description: 'Crops to a rectangle given relative to the image (0..1) or in full-resolution pixels. An aspect preset fits the largest rect of that ratio, centred, inside the given one. The output size changes.',
    tags: ['crop', 'trim', 'cut', 'aspect', 'frame', 'reframe'],
    color: C,
    inputs: img,
    params: {
      units: { type: 'enum', default: 'relative', options: ['relative', 'pixels'], label: 'Units' },
      x: { type: 'float', default: 0.1, min: 0, max: 1, step: 0.001, label: 'Left' },
      y: { type: 'float', default: 0.1, min: 0, max: 1, step: 0.001, label: 'Top' },
      width: { type: 'float', default: 0.8, min: 0, max: 1, step: 0.001, label: 'Width' },
      height: { type: 'float', default: 0.8, min: 0, max: 1, step: 0.001, label: 'Height' },
      pxX: { type: 'int', default: 0, min: 0, max: 16384, step: 1, label: 'Left (px)' },
      pxY: { type: 'int', default: 0, min: 0, max: 16384, step: 1, label: 'Top (px)' },
      pxWidth: { type: 'int', default: 1000, min: 1, max: 16384, step: 1, label: 'Width (px)' },
      pxHeight: { type: 'int', default: 1000, min: 1, max: 16384, step: 1, label: 'Height (px)' },
      aspect: { type: 'enum', default: 'free', options: ASPECTS, label: 'Aspect' },
    },
    size: ({ params, inputSizes, projectSize }) => {
      const s = inSize(inputSizes, projectSize);
      const r = cropRect(params, s.width, s.height);
      return [r.w, r.h];
    },
    passes: [{
      uniforms: (ctx) => {
        const [W, H] = fullIn(ctx);
        const r = cropRect(ctx.params, W, H);
        return { u_rect: [r.x / W, r.y / H, r.w / W, r.h / H] };
      },
      frag: /* glsl */ `
uniform vec4 u_rect;
void main(){ fragColor = texture(u_image, u_rect.xy + v_uv * u_rect.zw); }`,
    }],
  }),

  defineNode({
    id: 'transform.resize',
    name: 'Resize',
    category: 'Transform',
    description: 'Resamples to a new size: percent, width or height (aspect kept), long/short edge, fit inside a box, or exact (stretch). Downscaling widens the kernel (proper prefilter); premultiplied, optionally in linear light.',
    tags: ['scale', 'resample', 'downscale', 'upscale', 'lanczos', 'bicubic', 'image size'],
    color: C,
    inputs: img,
    params: {
      mode: { type: 'enum', default: 'percent', options: RESIZE_MODES, label: 'Mode' },
      percent: { type: 'float', default: 50, min: 1, max: 400, step: 0.5, label: 'Percent' },
      width: { type: 'int', default: 1920, min: 1, max: 16384, step: 1, label: 'Width (px)' },
      height: { type: 'int', default: 1080, min: 1, max: 16384, step: 1, label: 'Height (px)' },
      edge: { type: 'int', default: 1024, min: 1, max: 16384, step: 1, label: 'Edge (px)', description: 'Target for long edge / short edge modes.' },
      filter: { type: 'enum', default: 'lanczos3', options: RESIZE_FILTERS, label: 'Filter' },
      linear: { type: 'bool', default: true, label: 'Linear light', description: 'Resample in linear light (gamma-correct; keeps fine bright detail from darkening).' },
    },
    size: ({ params, inputSizes, projectSize }) => {
      const s = inSize(inputSizes, projectSize);
      return resizeSize(params, s.width, s.height);
    },
    passes: [
      { size: (ctx) => [ctx.width, ctx.inputSizes.image?.height ?? ctx.height], frag: resizeFrag('u_image', 0, true, false) },
      { frag: resizeFrag('u_pass0', 1, false, true) },
    ],
  }),

  defineNode({
    id: 'transform.rotate90',
    name: 'Rotate 90°',
    category: 'Transform',
    description: 'Lossless rotation by 90° clockwise, 180° or 90° counter-clockwise. Width and height swap for 90°.',
    tags: ['rotate', 'orientation', 'portrait', 'landscape', 'turn'],
    color: C,
    inputs: img,
    params: {
      angle: { type: 'enum', default: '90 CW', options: ['90 CW', '180', '90 CCW'], label: 'Rotation' },
    },
    size: ({ params, inputSizes, projectSize }) => {
      const s = inSize(inputSizes, projectSize);
      return params.angle === '180' ? [s.width, s.height] : [s.height, s.width];
    },
    passes: [{
      frag: /* glsl */ `
void main(){
  vec2 uv = u_angle == 0 ? vec2(v_uv.y, 1.0 - v_uv.x) : (u_angle == 1 ? 1.0 - v_uv : vec2(1.0 - v_uv.y, v_uv.x));
  fragColor = texture(u_image, uv);
}`,
    }],
  }),

  defineNode({
    id: 'transform.flip',
    name: 'Flip',
    category: 'Transform',
    description: 'Mirrors the image horizontally and/or vertically (pixel exact).',
    tags: ['mirror', 'flip', 'reverse'],
    color: C,
    inputs: img,
    params: {
      horizontal: { type: 'bool', default: true, label: 'Horizontal' },
      vertical: { type: 'bool', default: false, label: 'Vertical' },
    },
    passes: [{
      frag: /* glsl */ `
void main(){
  vec2 uv = v_uv;
  if (u_horizontal) uv.x = 1.0 - uv.x;
  if (u_vertical) uv.y = 1.0 - uv.y;
  fragColor = texture(u_image, uv);
}`,
    }],
  }),

  defineNode({
    id: 'transform.canvasSize',
    name: 'Canvas Size',
    category: 'Transform',
    description: 'Extends (or crops) the canvas around the image: add pixels, absolute size, percent, or pad to an aspect ratio. The anchor places the image; new area is filled with a colour (shows through transparent pixels too).',
    tags: ['pad', 'extend', 'border', 'letterbox', 'square', 'canvas', 'matte'],
    color: C,
    inputs: img,
    params: {
      mode: { type: 'enum', default: 'add', options: ['add', 'absolute', 'percent', 'aspect'], label: 'Mode' },
      width: { type: 'int', default: 100, min: -16384, max: 16384, step: 1, label: 'Width (px)', description: 'Pixels added in total (add) or new width (absolute).' },
      height: { type: 'int', default: 100, min: -16384, max: 16384, step: 1, label: 'Height (px)' },
      percent: { type: 'float', default: 110, min: 10, max: 400, step: 0.5, label: 'Percent' },
      aspect: { type: 'enum', default: '1:1', options: FIXED_ASPECTS, label: 'Pad to aspect' },
      anchor: { type: 'enum', default: 'center', options: ANCHORS, label: 'Anchor' },
      color: { type: 'color', default: [1, 1, 1, 1], label: 'Fill colour' },
    },
    size: ({ params, inputSizes, projectSize }) => {
      const s = inSize(inputSizes, projectSize);
      const l = canvasLayout(params, s.width, s.height);
      return [l.w, l.h];
    },
    passes: [{
      uniforms: (ctx) => {
        const [W, H] = fullIn(ctx);
        const l = canvasLayout(ctx.params, W, H);
        return { u_off: [l.ox, l.oy], u_inFull: [W, H], u_outFull: [l.w, l.h] };
      },
      frag: /* glsl */ `
uniform vec2 u_off, u_inFull, u_outFull;
void main(){
  vec2 uv = (v_uv * u_outFull - u_off) / u_inFull;
  vec4 bg = u_color;
  bool inside = all(greaterThanEqual(uv, vec2(0.0))) && all(lessThanEqual(uv, vec2(1.0)));
  vec4 c = inside ? texture(u_image, uv) : vec4(0.0);
  float ao = c.a + bg.a * (1.0 - c.a);
  fragColor = vec4(ao > 1e-5 ? (c.rgb * c.a + bg.rgb * bg.a * (1.0 - c.a)) / ao : vec3(0.0), ao);
}`,
    }],
  }),

  defineNode({
    id: 'transform.straighten',
    name: 'Straighten',
    category: 'Transform',
    description: 'Rotates by a small angle (+ = clockwise) and auto-crops the empty corners: "zoom to fill" keeps the size, "crop" outputs the largest clean rect (smaller), "none" leaves the corners, "expand" grows the canvas to fit everything. Bicubic sampling.',
    tags: ['level', 'horizon', 'rotate', 'tilt', 'auto crop', 'align'],
    color: C,
    inputs: img,
    params: {
      angle: { type: 'float', default: 3, min: -45, max: 45, step: 0.05, label: 'Angle (°)' },
      crop: { type: 'enum', default: 'zoom to fill', options: STRAIGHTEN_MODES, label: 'Crop' },
      fill: { type: 'enum', default: 'transparent', options: FILL, label: 'Corner fill' },
      fillColor: { type: 'color', default: [0, 0, 0, 1], label: 'Fill colour' },
    },
    size: ({ params, inputSizes, projectSize }) => {
      const s = inSize(inputSizes, projectSize);
      return straightenSize(params, s.width, s.height);
    },
    passes: [{
      uniforms: (ctx) => {
        const [W, H] = fullIn(ctx);
        const deg = num(ctx.params, 'angle', 3);
        const [ow, oh] = straightenSize(ctx.params, W, H);
        const zoom = String(ctx.params.crop ?? 'zoom to fill') === 'zoom to fill' ? straightenFactor(W, H, deg) : 1;
        return { u_inFull: [W, H], u_outFull: [ow, oh], u_zoom: zoom, u_ang: (deg * Math.PI) / 180 };
      },
      frag: /* glsl */ `
uniform vec2 u_inFull, u_outFull;
uniform float u_zoom, u_ang;
${GLSL_CUBIC}
${GLSL_FILL}
void main(){
  vec2 q = (v_uv - 0.5) * u_outFull * u_zoom;
  float c = cos(u_ang), s = sin(u_ang);
  q = mat2(c, -s, s, c) * q;  // inverse of a clockwise (y-down) rotation
  vec2 uv = q / u_inFull + 0.5;
  fragColor = ex_fill(u_image, uv, u_image_size, u_zoom);
}`,
    }],
  }),

  defineNode({
    id: 'transform.perspective',
    name: 'Perspective',
    category: 'Transform',
    description: '4-corner perspective (keystone). "correct": the quad given by the corners (in source 0..1 coords) is stretched to fill the frame — pull the top corners in to fix converging verticals. "distort": the whole image is placed into the quad. Vertical/horizontal sliders inset the corners for quick keystone fixes.',
    tags: ['keystone', 'perspective', 'converging verticals', 'architecture', 'homography', 'warp', 'corner pin'],
    color: C,
    inputs: img,
    params: {
      mode: { type: 'enum', default: 'correct', options: ['correct', 'distort'], label: 'Mode' },
      vertical: { type: 'float', default: 0.2, min: -1, max: 1, step: 0.005, label: 'Vertical keystone', description: '+ stretches the top (fix buildings leaning in), − the bottom.' },
      horizontal: { type: 'float', default: 0, min: -1, max: 1, step: 0.005, label: 'Horizontal keystone', description: '+ stretches the left side, − the right.' },
      topLeft: { type: 'vec2', default: [0, 0], min: -0.5, max: 1.5, step: 0.001, label: 'Top left' },
      topRight: { type: 'vec2', default: [1, 0], min: -0.5, max: 1.5, step: 0.001, label: 'Top right' },
      bottomRight: { type: 'vec2', default: [1, 1], min: -0.5, max: 1.5, step: 0.001, label: 'Bottom right' },
      bottomLeft: { type: 'vec2', default: [0, 1], min: -0.5, max: 1.5, step: 0.001, label: 'Bottom left' },
      fill: { type: 'enum', default: 'transparent', options: FILL, label: 'Outside fill' },
      fillColor: { type: 'color', default: [0, 0, 0, 1], label: 'Fill colour' },
    },
    passes: [{
      uniforms: (ctx) => ({ u_H: toGlMat3(perspectiveMatrix(ctx.params)) }),
      frag: /* glsl */ `
uniform mat3 u_H;
${GLSL_CUBIC}
${GLSL_FILL}
void main(){
  vec3 h = u_H * vec3(v_uv, 1.0);
  vec2 uv = h.xy / h.z;
  if (h.z <= 0.0) { fragColor = u_fill == 1 ? u_fillColor : vec4(0.0); return; }
  vec2 px = uv * u_image_size;
  float aa = max(length(dFdx(px)), length(dFdy(px)));
  fragColor = ex_fill(u_image, uv, u_image_size, aa);
}`,
    }],
  }),

  defineNode({
    id: 'transform.tile',
    name: 'Tile',
    category: 'Transform',
    description: 'Repeats the image N × M times, optionally mirrored (seamless) and brick-offset. Either fits the grid in the original size or multiplies the output size.',
    tags: ['repeat', 'pattern', 'grid', 'mirror', 'seamless', 'kaleidoscope', 'wallpaper'],
    color: C,
    inputs: img,
    params: {
      countX: { type: 'int', default: 3, min: 1, max: 32, step: 1, label: 'Columns' },
      countY: { type: 'int', default: 3, min: 1, max: 32, step: 1, label: 'Rows' },
      mirror: { type: 'bool', default: false, label: 'Mirror alternate tiles' },
      offset: { type: 'float', default: 0, min: 0, max: 1, step: 0.01, label: 'Row offset (brick)' },
      output: { type: 'enum', default: 'same size', options: ['same size', 'multiply size'], label: 'Output size' },
    },
    size: ({ params, inputSizes, projectSize }) => {
      const s = inSize(inputSizes, projectSize);
      if (params.output !== 'multiply size') return [s.width, s.height];
      return [Math.min(16384, s.width * Math.max(1, num(params, 'countX', 3))), Math.min(16384, s.height * Math.max(1, num(params, 'countY', 3)))];
    },
    passes: [{
      frag: /* glsl */ `
vec4 tileAt(vec2 uv) {
  vec2 n = vec2(max(u_countX, 1), max(u_countY, 1));
  vec2 g = uv * n;
  float row = floor(g.y);
  g.x += u_offset * mod(row, 2.0);
  vec2 cell = floor(g), f = fract(g);
  if (u_mirror) {
    if (mod(cell.x, 2.0) > 0.5) f.x = 1.0 - f.x;
    if (mod(cell.y, 2.0) > 0.5) f.y = 1.0 - f.y;
  }
  return texture(u_image, f);
}
void main(){
  // supersample when tiles are minified (≈ box prefilter)
  float m = clamp(ceil(max(float(u_countX) * u_image_size.x / u_resolution.x, float(u_countY) * u_image_size.y / u_resolution.y)), 1.0, 4.0);
  int k = int(m);
  vec4 acc = vec4(0.0);
  for (int y = 0; y < 4; y++) { if (y >= k) break;
    for (int x = 0; x < 4; x++) { if (x >= k) break;
      vec2 o = (vec2(float(x), float(y)) + 0.5) / m - 0.5;
      vec4 c = tileAt(v_uv + o / u_resolution);
      acc += vec4(c.rgb * c.a, c.a);
    }
  }
  acc /= m * m;
  fragColor = vec4(acc.a > 1e-5 ? acc.rgb / acc.a : vec3(0.0), acc.a);
}`,
    }],
  }),
] satisfies NodeDef[];

/** Output-uv → source-uv homography for transform.perspective. */
export function perspectiveMatrix(p: Params): Mat3 {
  const v = num(p, 'vertical', 0.2), h = num(p, 'horizontal', 0);
  const k = 0.5;
  const vt = Math.max(v, 0) * k, vb = Math.max(-v, 0) * k, hl = Math.max(h, 0) * k, hr = Math.max(-h, 0) * k;
  const tl = vec2p(p, 'topLeft', [0, 0]), tr = vec2p(p, 'topRight', [1, 0]);
  const br = vec2p(p, 'bottomRight', [1, 1]), bl = vec2p(p, 'bottomLeft', [0, 1]);
  const quad: [number, number][] = [
    [tl[0] + vt, tl[1] + hl], [tr[0] - vt, tr[1] + hr], [br[0] - vb, br[1] - hr], [bl[0] + vb, bl[1] - hl],
  ];
  const M = squareToQuad(quad);
  return p.mode === 'distort' ? invert3(M) : M;
}
