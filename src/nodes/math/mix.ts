/**
 * Blender-style Mix nodes: Mix Color (all 19 blend types), Mix Float, Mix Vector,
 * Mix Shader and Add Shader.
 *
 * Mix Color follows Blender's definitions exactly (blenkernel `ramp_blend`,
 * GPU `gpu_shader_material_mix_color.glsl`); see GLSL_MIX in _shared.ts. Like Blender,
 * the result keeps the alpha of A.
 */
import { defineNode } from '../../core/registry';
import type { NodeDef } from '../../core/types';
import { C_MIX, GLSL_BASE, GLSL_MIX, MIX_BLEND_TYPES, hasDecl, hasInputs } from './_shared';

const factorParam = { type: 'float' as const, default: 0.5, min: 0, max: 1, step: 0.01, label: 'Factor', description: 'Used when the Factor input is unconnected.' };
const clampFactor = { type: 'bool' as const, default: true, label: 'Clamp factor' };

export default [
  defineNode({
    id: 'mix.color',
    name: 'Mix Color',
    category: 'Mix',
    description: "Blender's Mix node (Color): blends B onto A with one of 19 blend types, by Factor. Formulas follow Blender's definitions exactly (applied to the display-encoded values flowing through the graph). Alpha is taken from A, as in Blender. Unconnected A/B use the colour params.",
    tags: ['blend', 'mix rgb', 'blender', 'multiply', 'screen', 'overlay', 'soft light', 'linear light', 'dodge', 'burn', 'hue', 'saturation', 'value', 'difference', 'exclusion', 'divide'],
    color: C_MIX,
    inputs: {
      fac: { type: 'mask', label: 'Factor', optional: true },
      a: { type: 'image', label: 'A', optional: true },
      b: { type: 'image', label: 'B', optional: true },
    },
    params: {
      blendType: { type: 'enum', default: 'Mix', options: MIX_BLEND_TYPES, label: 'Blend type' },
      factor: factorParam,
      clampFactor,
      clampResult: { type: 'bool', default: false, label: 'Clamp result' },
      colorA: { type: 'color', default: [0.5, 0.5, 0.5, 1], label: 'A (unconnected)' },
      colorB: { type: 'color', default: [0.5, 0.5, 0.5, 1], label: 'B (unconnected)' },
    },
    passes: [{
      uniforms: hasInputs(['fac', 'a', 'b']),
      frag: /* glsl */ `
${hasDecl(['fac', 'a', 'b'])}
${GLSL_BASE}
${GLSL_MIX}
void main(){
  float f = u_hasFac > 0.5 ? bl_float(texture(u_fac, v_uv)) : u_factor;
  if (u_clampFactor) f = clamp(f, 0.0, 1.0);
  vec4 A = u_hasA > 0.5 ? texture(u_a, v_uv) : u_colorA;
  vec4 B = u_hasB > 0.5 ? texture(u_b, v_uv) : u_colorB;
  vec3 o = bl_mixColor(u_blendType, f, A.rgb, B.rgb);
  if (u_clampResult) o = clamp(o, 0.0, 1.0);
  fragColor = vec4(o, A.a);
}` }],
  }),

  defineNode({
    id: 'mix.float',
    name: 'Mix Float',
    category: 'Mix',
    description: "Blender's Mix node (Float): linear interpolation A + (B − A)·Factor on every channel (RGBA). Unconnected A/B use the value params.",
    tags: ['lerp', 'interpolate', 'blender', 'mix'],
    color: C_MIX,
    inputs: {
      fac: { type: 'mask', label: 'Factor', optional: true },
      a: { type: 'image', label: 'A', optional: true },
      b: { type: 'image', label: 'B', optional: true },
    },
    params: {
      factor: factorParam,
      clampFactor,
      valueA: { type: 'float', default: 0, min: -10, max: 10, step: 0.01, label: 'A (unconnected)' },
      valueB: { type: 'float', default: 1, min: -10, max: 10, step: 0.01, label: 'B (unconnected)' },
    },
    passes: [{
      uniforms: hasInputs(['fac', 'a', 'b']),
      frag: /* glsl */ `
${hasDecl(['fac', 'a', 'b'])}
${GLSL_BASE}
void main(){
  float f = u_hasFac > 0.5 ? bl_float(texture(u_fac, v_uv)) : u_factor;
  if (u_clampFactor) f = clamp(f, 0.0, 1.0);
  vec4 A = u_hasA > 0.5 ? texture(u_a, v_uv) : vec4(vec3(u_valueA), 1.0);
  vec4 B = u_hasB > 0.5 ? texture(u_b, v_uv) : vec4(vec3(u_valueB), 1.0);
  fragColor = mix(A, B, f);
}` }],
  }),

  defineNode({
    id: 'mix.vector',
    name: 'Mix Vector',
    category: 'Mix',
    description: "Blender's Mix node (Vector): interpolates the RGB (XYZ) of A and B. Uniform uses one factor (luminance of the Factor input); Non-Uniform uses the Factor input's RGB per component. Alpha comes from A.",
    tags: ['lerp', 'interpolate', 'blender', 'vector', 'coordinates'],
    color: C_MIX,
    inputs: {
      fac: { type: 'image', label: 'Factor', optional: true },
      a: { type: 'image', label: 'A', optional: true },
      b: { type: 'image', label: 'B', optional: true },
    },
    params: {
      factorMode: { type: 'enum', default: 'Uniform', options: ['Uniform', 'Non-Uniform'], label: 'Factor mode' },
      factor: factorParam,
      clampFactor,
    },
    passes: [{
      uniforms: hasInputs(['fac', 'a', 'b']),
      frag: /* glsl */ `
${hasDecl(['fac', 'a', 'b'])}
${GLSL_BASE}
void main(){
  vec4 F = texture(u_fac, v_uv);
  vec3 f = u_hasFac < 0.5 ? vec3(u_factor) : (u_factorMode == 1 ? F.rgb : vec3(bl_float(F)));
  if (u_clampFactor) f = clamp(f, 0.0, 1.0);
  vec4 A = u_hasA > 0.5 ? texture(u_a, v_uv) : vec4(0.0, 0.0, 0.0, 1.0);
  vec4 B = u_hasB > 0.5 ? texture(u_b, v_uv) : vec4(0.0, 0.0, 0.0, 1.0);
  fragColor = vec4(mix(A.rgb, B.rgb, f), A.a);
}` }],
  }),

  defineNode({
    id: 'mix.shader',
    name: 'Mix Shader',
    category: 'Mix',
    description: "Analogue of Blender's Mix Shader: mixes two whole images including alpha, in premultiplied space (transparent pixels don't bleed their colour). Factor 0 = A, 1 = B.",
    tags: ['crossfade', 'dissolve', 'blend', 'premultiplied', 'alpha', 'blender'],
    color: C_MIX,
    inputs: {
      fac: { type: 'mask', label: 'Factor', optional: true },
      a: { type: 'image', label: 'A' },
      b: { type: 'image', label: 'B' },
    },
    params: { factor: factorParam },
    passes: [{
      uniforms: hasInputs(['fac']),
      frag: /* glsl */ `
${hasDecl(['fac'])}
${GLSL_BASE}
void main(){
  float f = clamp(u_hasFac > 0.5 ? bl_float(texture(u_fac, v_uv)) : u_factor, 0.0, 1.0);
  vec4 A = texture(u_a, v_uv), B = texture(u_b, v_uv);
  vec4 pa = vec4(A.rgb * A.a, A.a), pb = vec4(B.rgb * B.a, B.a);
  vec4 p = mix(pa, pb, f);
  fragColor = p.a > 1e-6 ? vec4(p.rgb / p.a, p.a) : vec4(mix(A.rgb, B.rgb, f), 0.0);
}` }],
  }),

  defineNode({
    id: 'mix.addShader',
    name: 'Add Shader',
    category: 'Mix',
    description: "Analogue of Blender's Add Shader: adds the (premultiplied) colours of A and B; alpha is their union a + b − a·b. Opaque inputs simply give A + B.",
    tags: ['add', 'sum', 'light', 'combine', 'blender'],
    color: C_MIX,
    inputs: {
      a: { type: 'image', label: 'A' },
      b: { type: 'image', label: 'B' },
    },
    params: {},
    passes: [{
      frag: /* glsl */ `
void main(){
  vec4 A = texture(u_a, v_uv), B = texture(u_b, v_uv);
  float aa = clamp(A.a, 0.0, 1.0), ab = clamp(B.a, 0.0, 1.0);
  vec3 sum = A.rgb * aa + B.rgb * ab;
  float ao = aa + ab - aa * ab;
  fragColor = ao > 1e-6 ? vec4(sum / ao, ao) : vec4(0.0);
}` }],
  }),
] satisfies NodeDef[];
