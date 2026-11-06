import { defineNode } from '../../core/registry';
import type { NodeDef, Params } from '../../core/types';

const C = '#6e56cf';

/** Builds the fragment source for math.expression around the user's expression. */
export function expressionSource(params: Params): string {
  let expr = String(params.expr ?? 'a').trim() || 'a';
  // A body with explicit `return` statements is used as is; otherwise it is a single expression.
  const body = /\breturn\b/.test(expr) ? expr : `return lib_toVec4(${expr.replace(/;\s*$/, '')});`;
  return /* glsl */ `
vec4 lib_toVec4(vec4 v) { return v; }
vec4 lib_toVec4(vec3 v) { return vec4(v, 1.0); }
vec4 lib_toVec4(vec2 v) { return vec4(v, 0.0, 1.0); }
vec4 lib_toVec4(float v) { return vec4(vec3(v), 1.0); }
vec4 lib_toVec4(int v) { return vec4(vec3(float(v)), 1.0); }
vec4 lib_toVec4(bool v) { return vec4(vec3(v ? 1.0 : 0.0), 1.0); }
vec4 lib_userExpr(vec4 a, vec4 b, vec4 c, vec2 uv, vec2 px, vec2 res, float t) {
#line 1
${body}
}
void main(){
  fragColor = lib_userExpr(texture(u_a, v_uv), texture(u_b, v_uv), texture(u_c, v_uv), v_uv, pixelCoord(), u_resolution, u_time);
}`;
}

export default [
  defineNode({
    id: 'math.op',
    name: 'Math',
    category: 'Math',
    description: 'Per-channel arithmetic on RGB (alpha comes from a). When b is unconnected, Value is used instead.',
    tags: ['add', 'subtract', 'multiply', 'divide', 'min', 'max', 'pow', 'difference', 'arithmetic'],
    color: C,
    inputs: {
      a: { type: 'image', label: 'A' },
      b: { type: 'image', label: 'B', optional: true },
    },
    params: {
      op: { type: 'enum', default: 'add', options: ['add', 'subtract', 'multiply', 'divide', 'min', 'max', 'pow', 'difference', 'abs', 'oneMinus'], label: 'Operation' },
      value: { type: 'float', default: 1, min: -10, max: 10, step: 0.01, label: 'Value (b)' },
      clamp: { type: 'bool', default: false, label: 'Clamp 0..1' },
    },
    passes: [{
      uniforms: (ctx) => ({ u_hasB: ctx.inputSizes.b ? 1 : 0 }),
      frag: /* glsl */ `
uniform float u_hasB;
void main(){
  vec4 A = texture(u_a, v_uv);
  vec3 a = A.rgb;
  vec3 b = u_hasB > 0.5 ? texture(u_b, v_uv).rgb : vec3(u_value);
  vec3 o;
  if (u_op == 0) o = a + b;
  else if (u_op == 1) o = a - b;
  else if (u_op == 2) o = a * b;
  else if (u_op == 3) o = a / mix(b, vec3(1e-6), equal(b, vec3(0.0)));
  else if (u_op == 4) o = min(a, b);
  else if (u_op == 5) o = max(a, b);
  else if (u_op == 6) o = pow(max(a, 0.0), b);
  else if (u_op == 7) o = abs(a - b);
  else if (u_op == 8) o = abs(a);
  else o = 1.0 - a;
  if (u_clamp) o = clamp(o, 0.0, 1.0);
  fragColor = vec4(o, A.a);
}` }],
  }),

  defineNode({
    id: 'math.remap',
    name: 'Remap',
    category: 'Math',
    description: 'Linearly maps RGB from [inMin, inMax] to [outMin, outMax].',
    tags: ['range', 'map', 'normalize', 'rescale'],
    color: C,
    inputs: { image: { type: 'image' } },
    params: {
      inMin: { type: 'float', default: 0, min: -2, max: 2, step: 0.005, label: 'In min' },
      inMax: { type: 'float', default: 1, min: -2, max: 2, step: 0.005, label: 'In max' },
      outMin: { type: 'float', default: 0, min: -2, max: 2, step: 0.005, label: 'Out min' },
      outMax: { type: 'float', default: 1, min: -2, max: 2, step: 0.005, label: 'Out max' },
      clamp: { type: 'bool', default: true, label: 'Clamp' },
    },
    passes: [{
      frag: /* glsl */ `
void main(){
  vec4 c = texture(u_image, v_uv);
  float d = u_inMax - u_inMin;
  vec3 t = (c.rgb - u_inMin) / (abs(d) < 1e-6 ? 1e-6 : d);
  if (u_clamp) t = clamp(t, 0.0, 1.0);
  fragColor = vec4(mix(vec3(u_outMin), vec3(u_outMax), t), c.a);
}` }],
  }),

  defineNode({
    id: 'math.expression',
    name: 'Expression',
    category: 'Math',
    description: 'Custom GLSL expression evaluated per pixel. Available: vec4 a, b, c (inputs at uv), vec2 uv, px (pixel coord), res, float t (time) and the shader library (luma, rgb2hsv, hash12, fbm…). Result may be float/vec3/vec4. Multi-line bodies with `return` work too.',
    tags: ['glsl', 'code', 'formula', 'custom', 'shader'],
    color: C,
    inputs: {
      a: { type: 'image', label: 'a', optional: true },
      b: { type: 'image', label: 'b', optional: true },
      c: { type: 'image', label: 'c', optional: true },
    },
    params: {
      expr: { type: 'string', default: 'a', multiline: true, label: 'Expression' },
    },
    passes: [{ frag: expressionSource }],
  }),
] satisfies NodeDef[];
