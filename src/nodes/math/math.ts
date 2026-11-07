/**
 * Blender-style Math, Vector Math, Map Range, Clamp and Compare nodes.
 *
 * Every socket is an image: a "float" is an image whose channels hold the value, a
 * "vector" is an image whose RGB holds XYZ. Ops follow Blender's GPU/SVM definitions,
 * including its "safe" semantics (division by zero → 0, log of non-positive → 0, …).
 * The selected op is compiled inline (`frag(params)`), so each op is its own small program.
 */
import { defineNode } from '../../core/registry';
import type { NodeDef, Params } from '../../core/types';
import { C_MATH, C_VECTOR, GLSL_BASE, hasDecl, hasInputs } from './_shared';

/** Scalar helpers shared by Math and Vector Math (Blender's gpu_shader_material_math_util). */
const GLSL_MATH_UTIL = /* glsl */ `
float bl_compatible_pow(float x, float y) {
  if (y == 0.0) return 1.0;
  if (x < 0.0) { if (mod(-y, 2.0) == 0.0) return pow(-x, y); return -pow(-x, y); }
  if (x == 0.0) return 0.0;
  return pow(x, y);
}
float bl_power(float a, float b) {
  if (a >= 0.0) return bl_compatible_pow(a, b);
  float fraction = mod(abs(b), 1.0);
  if (fraction > 0.999 || fraction < 0.001) return bl_compatible_pow(a, floor(b + 0.5));
  return 0.0;
}
float bl_fmod(float a, float b) { if (b != 0.0) { int N = int(a / b); return a - float(N) * b; } return 0.0; }
float bl_floored_mod(float a, float b) { return b != 0.0 ? a - floor(a / b) * b : 0.0; }
float bl_wrap(float a, float b, float c) { float range = b - c; return range != 0.0 ? a - range * floor((a - c) / range) : c; }
float bl_pingpong(float a, float b) { return b != 0.0 ? abs(fract((a - b) / (b * 2.0)) * b * 2.0 - b) : 0.0; }
float bl_smin(float a, float b, float c) {
  if (c != 0.0) { float h = max(c - abs(a - b), 0.0) / c; return min(a, b) - h * h * h * c * (1.0 / 6.0); }
  return min(a, b);
}
float bl_snap(float a, float b) { return floor(bl_safe_div(a, b)) * b; }
`;

/** Blender Math ops → GLSL float expression of a, b, c. Order = Blender's menu. */
export const MATH_OPS: [string, string][] = [
  ['Add', 'a + b'],
  ['Subtract', 'a - b'],
  ['Multiply', 'a * b'],
  ['Divide', 'bl_safe_div(a, b)'],
  ['Multiply Add', 'a * b + c'],
  ['Power', 'bl_power(a, b)'],
  ['Logarithm', '(a > 0.0 && b > 0.0) ? log2(a) / log2(b) : 0.0'],
  ['Square Root', 'a > 0.0 ? sqrt(a) : 0.0'],
  ['Inverse Square Root', 'a > 0.0 ? inversesqrt(a) : 0.0'],
  ['Absolute', 'abs(a)'],
  ['Exponent', 'exp(a)'],
  ['Minimum', 'min(a, b)'],
  ['Maximum', 'max(a, b)'],
  ['Less Than', 'a < b ? 1.0 : 0.0'],
  ['Greater Than', 'a > b ? 1.0 : 0.0'],
  ['Sign', 'sign(a)'],
  ['Compare', 'abs(a - b) <= max(c, 1e-5) ? 1.0 : 0.0'],
  ['Smooth Minimum', 'bl_smin(a, b, c)'],
  ['Smooth Maximum', '-bl_smin(-a, -b, c)'],
  ['Round', 'floor(a + 0.5)'],
  ['Floor', 'floor(a)'],
  ['Ceil', 'ceil(a)'],
  ['Truncate', 'trunc(a)'],
  ['Fraction', 'a - floor(a)'],
  ['Truncated Modulo', 'bl_fmod(a, b)'],
  ['Floored Modulo', 'bl_floored_mod(a, b)'],
  ['Wrap', 'bl_wrap(a, b, c)'],
  ['Snap', 'bl_snap(a, b)'],
  ['Ping-Pong', 'bl_pingpong(a, b)'],
  ['Sine', 'sin(a)'],
  ['Cosine', 'cos(a)'],
  ['Tangent', 'tan(a)'],
  ['Arcsine', '(a <= 1.0 && a >= -1.0) ? asin(a) : 0.0'],
  ['Arccosine', '(a <= 1.0 && a >= -1.0) ? acos(a) : 0.0'],
  ['Arctangent', 'atan(a)'],
  ['Arctan2', 'atan(a, b)'],
  ['Hyperbolic Sine', 'sinh(a)'],
  ['Hyperbolic Cosine', 'cosh(a)'],
  ['Hyperbolic Tangent', 'tanh(a)'],
  ['To Radians', 'radians(a)'],
  ['To Degrees', 'degrees(a)'],
];
const MATH_OP_NAMES = MATH_OPS.map(([n]) => n);

function mathSource(params: Params): string {
  const op = MATH_OPS.find(([n]) => n === params.operation) ?? MATH_OPS[0];
  return /* glsl */ `
${hasDecl(['a', 'b', 'c'])}
${GLSL_BASE}
${GLSL_MATH_UTIL}
float bl_op(float a, float b, float c) { return ${op[1]}; }
vec4 bl_op(vec4 a, vec4 b, vec4 c) { return vec4(bl_op(a.x, b.x, c.x), bl_op(a.y, b.y, c.y), bl_op(a.z, b.z, c.z), bl_op(a.w, b.w, c.w)); }
void main(){
  vec4 A = u_hasA > 0.5 ? texture(u_a, v_uv) : vec4(u_value1);
  vec4 B = u_hasB > 0.5 ? texture(u_b, v_uv) : vec4(u_value2);
  vec4 C = u_hasC > 0.5 ? texture(u_c, v_uv) : vec4(u_value3);
  float alpha = u_hasA > 0.5 ? A.a : 1.0;
  vec4 o;
  if (u_channels == 2) {           // Luminance
    float r = bl_op(bl_float(A), bl_float(B), bl_float(C));
    o = vec4(vec3(r), alpha);
  } else {
    o = bl_op(A, B, C);
    if (u_channels == 0) o.a = alpha;   // RGB
  }
  if (u_clamp) o = clamp(o, 0.0, 1.0);
  fragColor = o;
}`;
}

/** Vector Math ops → GLSL statement setting `vec3 r` (vector result) or `float s` (scalar result). */
export const VECTOR_OPS: [string, string][] = [
  ['Add', 'r = a + b;'],
  ['Subtract', 'r = a - b;'],
  ['Multiply', 'r = a * b;'],
  ['Divide', 'r = bl_safe_div(a, b);'],
  ['Multiply Add', 'r = a * b + c;'],
  ['Cross Product', 'r = cross(a, b);'],
  ['Project', 'float l2 = dot(b, b); r = l2 != 0.0 ? (dot(a, b) / l2) * b : vec3(0.0);'],
  ['Reflect', 'r = reflect(a, bl_safe_normalize(b));'],
  ['Refract', 'r = refract(a, bl_safe_normalize(b), k);'],
  ['Faceforward', 'r = faceforward(a, b, c);'],
  ['Dot Product', 's = dot(a, b);'],
  ['Distance', 's = distance(a, b);'],
  ['Length', 's = length(a);'],
  ['Scale', 'r = a * k;'],
  ['Normalize', 'r = bl_safe_normalize(a);'],
  ['Absolute', 'r = abs(a);'],
  ['Power', 'r = vec3(bl_power(a.x, b.x), bl_power(a.y, b.y), bl_power(a.z, b.z));'],
  ['Sign', 'r = sign(a);'],
  ['Minimum', 'r = min(a, b);'],
  ['Maximum', 'r = max(a, b);'],
  ['Floor', 'r = floor(a);'],
  ['Ceil', 'r = ceil(a);'],
  ['Fraction', 'r = a - floor(a);'],
  ['Modulo', 'r = vec3(bl_fmod(a.x, b.x), bl_fmod(a.y, b.y), bl_fmod(a.z, b.z));'],
  ['Wrap', 'r = vec3(bl_wrap(a.x, b.x, c.x), bl_wrap(a.y, b.y, c.y), bl_wrap(a.z, b.z, c.z));'],
  ['Snap', 'r = vec3(bl_snap(a.x, b.x), bl_snap(a.y, b.y), bl_snap(a.z, b.z));'],
  ['Sine', 'r = sin(a);'],
  ['Cosine', 'r = cos(a);'],
  ['Tangent', 'r = tan(a);'],
];
const VECTOR_OP_NAMES = VECTOR_OPS.map(([n]) => n);

function vectorSource(params: Params): string {
  const op = VECTOR_OPS.find(([n]) => n === params.operation) ?? VECTOR_OPS[0];
  const scalar = op[1].startsWith('s =');
  return /* glsl */ `
${hasDecl(['a', 'b', 'c', 'k'])}
${GLSL_BASE}
${GLSL_MATH_UTIL}
void main(){
  vec4 A = u_hasA > 0.5 ? texture(u_a, v_uv) : vec4(u_ax, u_ay, u_az, 1.0);
  vec3 a = A.xyz;
  vec3 b = u_hasB > 0.5 ? texture(u_b, v_uv).xyz : vec3(u_bx, u_by, u_bz);
  vec3 c = u_hasC > 0.5 ? texture(u_c, v_uv).xyz : vec3(u_cx, u_cy, u_cz);
  float k = u_hasK > 0.5 ? bl_float(texture(u_k, v_uv)) : u_scaleValue;
  vec3 r = vec3(0.0); float s = 0.0;
  ${op[1]}
  ${scalar ? 'r = vec3(s);' : ''}
  float alpha = u_hasA > 0.5 ? A.a : 1.0;
  fragColor = vec4(r, alpha);
}`;
}

const vecParam = (label: string, def = 0) => ({ type: 'float' as const, default: def, min: -10, max: 10, step: 0.01, label });

export default [
  defineNode({
    id: 'math.math',
    name: 'Math',
    category: 'Math',
    description: "Blender's Math node, applied per pixel and per channel. Inputs are optional; unconnected ones use Value 1/2/3. Channels: RGB (alpha from A), RGBA, or Luminance (operates on the grey value of each input and outputs grey). Blender's safe semantics: divide by 0 → 0, log/sqrt of non-positive → 0.",
    tags: ['add', 'subtract', 'multiply', 'divide', 'power', 'log', 'sqrt', 'modulo', 'wrap', 'snap', 'ping-pong', 'sine', 'cosine', 'arctan2', 'smooth min', 'compare', 'floor', 'fraction', 'blender', 'arithmetic'],
    color: C_MATH,
    inputs: {
      a: { type: 'image', label: 'A', optional: true },
      b: { type: 'image', label: 'B', optional: true },
      c: { type: 'image', label: 'C', optional: true },
    },
    params: {
      operation: { type: 'enum', default: 'Add', options: MATH_OP_NAMES, label: 'Operation' },
      value1: { type: 'float', default: 0.5, min: -10, max: 10, step: 0.01, label: 'Value 1 (A)' },
      value2: { type: 'float', default: 0.5, min: -10, max: 10, step: 0.01, label: 'Value 2 (B)' },
      value3: { type: 'float', default: 0, min: -10, max: 10, step: 0.01, label: 'Value 3 (C)', description: 'Used by Multiply Add, Compare (epsilon), Smooth Min/Max (distance), Wrap (min).' },
      channels: { type: 'enum', default: 'RGB', options: ['RGB', 'RGBA', 'Luminance'], label: 'Channels' },
      clamp: { type: 'bool', default: false, label: 'Clamp 0..1' },
    },
    passes: [{ uniforms: hasInputs(['a', 'b', 'c']), frag: mathSource }],
  }),

  defineNode({
    id: 'vector.math',
    name: 'Vector Math',
    category: 'Vector',
    description: "Blender's Vector Math node: treats RGB as an XYZ vector. Scalar results (Dot Product, Distance, Length) are written to all channels. Unconnected vectors use the X/Y/Z params; Scale (also the IOR for Refract) can come from the optional Scale input.",
    tags: ['vector', 'cross product', 'dot product', 'normalize', 'reflect', 'refract', 'project', 'length', 'distance', 'blender', 'xyz'],
    color: C_VECTOR,
    inputs: {
      a: { type: 'image', label: 'A', optional: true },
      b: { type: 'image', label: 'B', optional: true },
      c: { type: 'image', label: 'C', optional: true },
      k: { type: 'mask', label: 'Scale', optional: true },
    },
    params: {
      operation: { type: 'enum', default: 'Add', options: VECTOR_OP_NAMES, label: 'Operation' },
      scaleValue: { type: 'float', default: 1, min: -10, max: 10, step: 0.01, label: 'Scale', description: 'Scale op factor / Refract IOR.' },
      ax: vecParam('A x'), ay: vecParam('A y'), az: vecParam('A z'),
      bx: vecParam('B x'), by: vecParam('B y'), bz: vecParam('B z'),
      cx: vecParam('C x'), cy: vecParam('C y'), cz: vecParam('C z'),
    },
    passes: [{ uniforms: hasInputs(['a', 'b', 'c', 'k']), frag: vectorSource }],
  }),

  defineNode({
    id: 'math.mapRange',
    name: 'Map Range',
    category: 'Math',
    description: "Blender's Map Range node, per channel (RGB; alpha kept). Linear, Stepped Linear, Smooth Step or Smoother Step from [From Min, From Max] to [To Min, To Max]. Clamp applies to Linear and Stepped, as in Blender. Range ends can also come from optional inputs.",
    tags: ['remap', 'range', 'fit', 'normalize', 'rescale', 'smoothstep', 'steps', 'blender'],
    color: C_MATH,
    inputs: {
      value: { type: 'image', label: 'Value' },
      fromMin: { type: 'image', label: 'From Min', optional: true },
      fromMax: { type: 'image', label: 'From Max', optional: true },
      toMin: { type: 'image', label: 'To Min', optional: true },
      toMax: { type: 'image', label: 'To Max', optional: true },
    },
    params: {
      interpolation: { type: 'enum', default: 'Linear', options: ['Linear', 'Stepped Linear', 'Smooth Step', 'Smoother Step'], label: 'Interpolation' },
      fromMinValue: { type: 'float', default: 0, min: -10, max: 10, step: 0.01, label: 'From Min' },
      fromMaxValue: { type: 'float', default: 1, min: -10, max: 10, step: 0.01, label: 'From Max' },
      toMinValue: { type: 'float', default: 0, min: -10, max: 10, step: 0.01, label: 'To Min' },
      toMaxValue: { type: 'float', default: 1, min: -10, max: 10, step: 0.01, label: 'To Max' },
      steps: { type: 'float', default: 4, min: 0, max: 64, step: 1, label: 'Steps', description: 'Stepped Linear only.' },
      clamp: { type: 'bool', default: true, label: 'Clamp' },
    },
    passes: [{
      uniforms: hasInputs(['fromMin', 'fromMax', 'toMin', 'toMax']),
      frag: /* glsl */ `
${hasDecl(['fromMin', 'fromMax', 'toMin', 'toMax'])}
${GLSL_BASE}
float bl_smootherstep(float e0, float e1, float x) { x = clamp(bl_safe_div(x - e0, e1 - e0), 0.0, 1.0); return x * x * x * (x * (x * 6.0 - 15.0) + 10.0); }
float mapRange(float v, float fmin, float fmax, float tmin, float tmax) {
  float r;
  if (u_interpolation == 0) {
    r = fmax != fmin ? tmin + ((v - fmin) / (fmax - fmin)) * (tmax - tmin) : 0.0;
  } else if (u_interpolation == 1) {
    float f = fmax != fmin ? (v - fmin) / (fmax - fmin) : 0.0;
    f = u_steps > 0.0 ? floor(f * (u_steps + 1.0)) / u_steps : 0.0;
    r = tmin + f * (tmax - tmin);
  } else if (u_interpolation == 2) {
    float f = fmin > fmax ? 1.0 - smoothstep(fmax, fmin, v) : smoothstep(fmin, fmax, v);
    return tmin + f * (tmax - tmin);
  } else {
    float f = fmin > fmax ? 1.0 - bl_smootherstep(fmax, fmin, v) : bl_smootherstep(fmin, fmax, v);
    return tmin + f * (tmax - tmin);
  }
  if (u_clamp) r = tmin > tmax ? clamp(r, tmax, tmin) : clamp(r, tmin, tmax);
  return r;
}
void main(){
  vec4 V = texture(u_value, v_uv);
  vec3 fmin = u_hasFromMin > 0.5 ? texture(u_fromMin, v_uv).rgb : vec3(u_fromMinValue);
  vec3 fmax = u_hasFromMax > 0.5 ? texture(u_fromMax, v_uv).rgb : vec3(u_fromMaxValue);
  vec3 tmin = u_hasToMin > 0.5 ? texture(u_toMin, v_uv).rgb : vec3(u_toMinValue);
  vec3 tmax = u_hasToMax > 0.5 ? texture(u_toMax, v_uv).rgb : vec3(u_toMaxValue);
  vec3 o;
  for (int i = 0; i < 3; i++) o[i] = mapRange(V[i], fmin[i], fmax[i], tmin[i], tmax[i]);
  fragColor = vec4(o, V.a);
}` }],
  }),

  defineNode({
    id: 'math.clamp',
    name: 'Clamp',
    category: 'Math',
    description: "Blender's Clamp node, per channel (RGB; alpha kept). Min Max clamps to [Min, Max]; Range also works when Min > Max (swaps them). Min/Max can come from optional inputs.",
    tags: ['limit', 'min', 'max', 'range', 'blender'],
    color: C_MATH,
    inputs: {
      value: { type: 'image', label: 'Value' },
      min: { type: 'image', label: 'Min', optional: true },
      max: { type: 'image', label: 'Max', optional: true },
    },
    params: {
      clampType: { type: 'enum', default: 'Min Max', options: ['Min Max', 'Range'], label: 'Clamp type' },
      minValue: { type: 'float', default: 0, min: -10, max: 10, step: 0.01, label: 'Min' },
      maxValue: { type: 'float', default: 1, min: -10, max: 10, step: 0.01, label: 'Max' },
    },
    passes: [{
      uniforms: hasInputs(['min', 'max']),
      frag: /* glsl */ `
${hasDecl(['min', 'max'])}
void main(){
  vec4 V = texture(u_value, v_uv);
  vec3 lo = u_hasMin > 0.5 ? texture(u_min, v_uv).rgb : vec3(u_minValue);
  vec3 hi = u_hasMax > 0.5 ? texture(u_max, v_uv).rgb : vec3(u_maxValue);
  if (u_clampType == 1) { vec3 l2 = min(lo, hi); hi = max(lo, hi); lo = l2; }
  fragColor = vec4(min(max(V.rgb, lo), hi), V.a);
}` }],
  }),

  defineNode({
    id: 'math.compare',
    name: 'Compare',
    category: 'Math',
    description: "Blender's Compare node. Element-wise compares each RGB channel (out = per-channel 0/1, Result = all channels true); Length / Average / Dot Product / Direction compare the vectors as a whole (Dot Product compares a·b with C, Direction compares the angle with C radians). Equal / Not Equal use Epsilon. Brighter / Darker compare luminance.",
    tags: ['equal', 'not equal', 'less than', 'greater than', 'threshold', 'boolean', 'blender'],
    color: C_MATH,
    inputs: {
      a: { type: 'image', label: 'A', optional: true },
      b: { type: 'image', label: 'B', optional: true },
    },
    outputs: { out: { type: 'image' }, result: { type: 'mask', label: 'Result' } },
    params: {
      operation: { type: 'enum', default: 'Greater Than', options: ['Less Than', 'Less Than or Equal', 'Greater Than', 'Greater Than or Equal', 'Equal', 'Not Equal', 'Brighter', 'Darker'], label: 'Operation' },
      mode: { type: 'enum', default: 'Element-Wise', options: ['Element-Wise', 'Length', 'Average', 'Dot Product', 'Direction'], label: 'Mode' },
      valueA: { type: 'float', default: 0, min: -10, max: 10, step: 0.01, label: 'A (unconnected)' },
      valueB: { type: 'float', default: 0.5, min: -10, max: 10, step: 0.01, label: 'B (unconnected)' },
      valueC: { type: 'float', default: 0.9, min: -10, max: 10, step: 0.01, label: 'C', description: 'Dot Product / Direction modes.' },
      epsilon: { type: 'float', default: 0.001, min: 0, max: 1, step: 0.001, label: 'Epsilon' },
    },
    passes: [
      {
        uniforms: hasInputs(['a', 'b']),
        frag: /* glsl */ `
${hasDecl(['a', 'b'])}
${GLSL_BASE}
float cmp(float a, float b) {
  float e = u_epsilon;
  if (u_operation == 0) return a < b ? 1.0 : 0.0;
  if (u_operation == 1) return a <= b ? 1.0 : 0.0;
  if (u_operation == 2) return a > b ? 1.0 : 0.0;
  if (u_operation == 3) return a >= b ? 1.0 : 0.0;
  if (u_operation == 4) return abs(a - b) <= e ? 1.0 : 0.0;
  if (u_operation == 5) return abs(a - b) > e ? 1.0 : 0.0;
  if (u_operation == 6) return a > b ? 1.0 : 0.0;
  return a < b ? 1.0 : 0.0;
}
void main(){
  vec4 A = u_hasA > 0.5 ? texture(u_a, v_uv) : vec4(vec3(u_valueA), 1.0);
  vec4 B = u_hasB > 0.5 ? texture(u_b, v_uv) : vec4(vec3(u_valueB), 1.0);
  vec3 o;
  if (u_operation >= 6) o = vec3(cmp(bl_float(A), bl_float(B)));
  else if (u_mode == 0) o = vec3(cmp(A.r, B.r), cmp(A.g, B.g), cmp(A.b, B.b));
  else if (u_mode == 1) o = vec3(cmp(length(A.rgb), length(B.rgb)));
  else if (u_mode == 2) o = vec3(cmp(dot(A.rgb, vec3(1.0 / 3.0)), dot(B.rgb, vec3(1.0 / 3.0))));
  else if (u_mode == 3) o = vec3(cmp(dot(A.rgb, B.rgb), u_valueC));
  else o = vec3(cmp(acos(clamp(dot(bl_safe_normalize(A.rgb), bl_safe_normalize(B.rgb)), -1.0, 1.0)), u_valueC));
  float all3 = min(o.r, min(o.g, o.b));
  fragColor = vec4(o, all3);   // packed: per-channel + all
}` },
      { output: 'out', frag: `void main(){ fragColor = vec4(texture(u_pass0, v_uv).rgb, 1.0); }` },
      { output: 'result', frag: `void main(){ float r = texture(u_pass0, v_uv).a; fragColor = vec4(r, r, r, 1.0); }` },
    ],
  }),
] satisfies NodeDef[];
