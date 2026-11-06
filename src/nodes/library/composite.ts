import { defineNode } from '../../core/registry';
import type { NodeDef } from '../../core/types';

const C = '#e54d2e';

export const BLEND_MODES = ['normal', 'multiply', 'screen', 'overlay', 'softLight', 'hardLight', 'add', 'subtract', 'difference', 'darken', 'lighten', 'colorDodge', 'colorBurn', 'linearLight', 'hue', 'saturation', 'color', 'luminosity'];

export default [
  defineNode({
    id: 'composite.blend',
    name: 'Blend',
    category: 'Composite',
    description: 'Layers `blend` over `base` with a Photoshop-style blend mode. Coverage = blend alpha × opacity × mask; result alpha is the union (source-over). A differently sized blend layer is stretched to fit.',
    tags: ['layer', 'composite', 'overlay', 'multiply', 'screen', 'blend mode', 'merge'],
    color: C,
    inputs: {
      base: { type: 'image', label: 'Base' },
      blend: { type: 'image', label: 'Blend' },
      mask: { type: 'mask', optional: true, fallback: 'white', label: 'Mask' },
    },
    params: {
      mode: { type: 'enum', default: 'normal', options: BLEND_MODES, label: 'Mode' },
      opacity: { type: 'float', default: 1, min: 0, max: 1, step: 0.01, label: 'Opacity' },
    },
    passes: [{
      frag: /* glsl */ `
float bl_lum(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }
vec3 bl_clip(vec3 c) {
  float l = bl_lum(c), n = min(min(c.r, c.g), c.b), x = max(max(c.r, c.g), c.b);
  if (n < 0.0) c = l + (c - l) * l / max(l - n, 1e-5);
  if (x > 1.0) c = l + (c - l) * (1.0 - l) / max(x - l, 1e-5);
  return c;
}
vec3 bl_setLum(vec3 c, float l) { return bl_clip(c + (l - bl_lum(c))); }
float bl_sat(vec3 c) { return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b); }
vec3 bl_setSat(vec3 c, float s) {
  float mx = max(max(c.r, c.g), c.b), mn = min(min(c.r, c.g), c.b);
  return mx > mn ? (c - mn) * s / (mx - mn) : vec3(0.0);
}
vec3 blendFn(vec3 b, vec3 s) {
  switch (u_mode) {
    case 0: return s;
    case 1: return blendMultiply(b, s);
    case 2: return blendScreen(b, s);
    case 3: return blendOverlay(b, s);
    case 4: return blendSoftLight(b, s);
    case 5: return blendHardLight(b, s);
    case 6: return b + s;
    case 7: return b - s;
    case 8: return abs(b - s);
    case 9: return min(b, s);
    case 10: return max(b, s);
    case 11: return blendColorDodge(b, s);
    case 12: return blendColorBurn(b, s);
    case 13: return blendLinearLight(b, s);
    case 14: return bl_setLum(bl_setSat(s, bl_sat(b)), bl_lum(b));
    case 15: return bl_setLum(bl_setSat(b, bl_sat(s)), bl_lum(b));
    case 16: return bl_setLum(s, bl_lum(b));
    default: return bl_setLum(b, bl_lum(s));
  }
}
void main(){
  vec4 B = texture(u_base, v_uv);
  vec4 S = texture(u_blend, v_uv);
  float as = clamp(S.a * u_opacity * texture(u_mask, v_uv).r, 0.0, 1.0);
  float ab = clamp(B.a, 0.0, 1.0);
  vec3 mixed = mix(S.rgb, blendFn(B.rgb, S.rgb), ab);   // W3C: (1-ab)·Cs + ab·B(Cb,Cs)
  float ao = as + ab * (1.0 - as);
  vec3 co = ao > 1e-5 ? (as * mixed + ab * (1.0 - as) * B.rgb) / ao : B.rgb;
  fragColor = vec4(co, ao);
}` }],
  }),

  defineNode({
    id: 'composite.mix',
    name: 'Mix',
    category: 'Composite',
    description: 'Linear mix of a and b (including alpha): mix(a, b, factor × mask).',
    tags: ['lerp', 'crossfade', 'blend', 'dissolve'],
    color: C,
    inputs: {
      a: { type: 'image', label: 'A' },
      b: { type: 'image', label: 'B' },
      mask: { type: 'mask', optional: true, fallback: 'white', label: 'Mask' },
    },
    params: {
      factor: { type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Factor' },
    },
    passes: [{
      frag: /* glsl */ `
void main(){
  fragColor = mix(texture(u_a, v_uv), texture(u_b, v_uv), u_factor * texture(u_mask, v_uv).r);
}` }],
  }),

  defineNode({
    id: 'composite.maskFromLuma',
    name: 'Mask from Luma',
    category: 'Composite',
    description: 'Creates a mask from luminance with a smooth ramp between low and high.',
    tags: ['luminosity mask', 'key', 'matte', 'select', 'highlights', 'shadows'],
    color: C,
    inputs: { image: { type: 'image' } },
    outputs: { out: { type: 'mask' } },
    params: {
      low: { type: 'float', default: 0, min: 0, max: 1, step: 0.005, label: 'Low' },
      high: { type: 'float', default: 1, min: 0, max: 1, step: 0.005, label: 'High' },
      invert: { type: 'bool', default: false, label: 'Invert' },
    },
    passes: [{
      frag: /* glsl */ `
void main(){
  float l = luma(texture(u_image, v_uv).rgb);
  float m = u_high > u_low ? smoothstep(u_low, u_high, l) : step(u_low, l);
  if (u_invert) m = 1.0 - m;
  fragColor = vec4(m, m, m, 1.0);
}` }],
  }),

  defineNode({
    id: 'composite.alphaOver',
    name: 'Alpha Over',
    category: 'Composite',
    description: 'Places `over` on top of `under` using its alpha (stretched to fit), e.g. text or a logo on a photo.',
    tags: ['over', 'layer', 'composite', 'alpha', 'stack'],
    color: C,
    inputs: {
      under: { type: 'image', label: 'Under' },
      over: { type: 'image', label: 'Over' },
    },
    params: {
      opacity: { type: 'float', default: 1, min: 0, max: 1, step: 0.01, label: 'Opacity' },
    },
    passes: [{
      frag: /* glsl */ `
void main(){
  vec4 B = texture(u_under, v_uv);
  vec4 S = texture(u_over, v_uv);
  float as = clamp(S.a * u_opacity, 0.0, 1.0), ab = clamp(B.a, 0.0, 1.0);
  float ao = as + ab * (1.0 - as);
  vec3 co = ao > 1e-5 ? (S.rgb * as + B.rgb * ab * (1.0 - as)) / ao : B.rgb;
  fragColor = vec4(co, ao);
}` }],
  }),
] satisfies NodeDef[];
