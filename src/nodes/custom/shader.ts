import { defineNode } from '../../core/registry';
import type { NodeDef } from '../../core/types';

/** Default code of the GLSL Shader node: tint input `a` by `color1`, amount `p1`. */
export const SHADER_NODE_EXAMPLE = `// GLSL Shader — edit me! Compile errors show on the node's red badge.
// Inputs:  u_a, u_b, u_c   (sampler2D; unconnected = black)
// Knobs:   u_p1 .. u_p4   (float 0..1), u_color1 (vec4 RGBA)
// Also:    v_uv (0,0 = top-left), u_resolution, u_scale, u_time,
//          and the library (luma, rgb2hsv, blendOverlay, fbm, ...).
void main() {
  vec4 src = texture(u_a, v_uv);
  vec3 tinted = luma(src.rgb) * u_color1.rgb * 1.6;
  fragColor = vec4(mix(src.rgb, tinted, u_p1), src.a);
}
`;

export default [
  defineNode({
    id: 'core.shader',
    name: 'GLSL Shader',
    category: 'Utility',
    description: 'Write a fragment shader inline. Inputs a/b/c, knobs p1–p4 and color1. For reusable nodes use Node › New Custom Node…',
    tags: ['glsl', 'code', 'custom', 'expression', 'fragment', 'program'],
    color: '#7a5fb0',
    inputs: {
      a: { type: 'image', optional: true },
      b: { type: 'image', optional: true },
      c: { type: 'image', optional: true },
    },
    params: {
      code: { type: 'string', multiline: true, default: SHADER_NODE_EXAMPLE, label: 'Code', description: 'GLSL ES 3.00 body: define void main() and write fragColor.' },
      p1: { type: 'float', default: 0.5, min: 0, max: 1, label: 'p1' },
      p2: { type: 'float', default: 0.5, min: 0, max: 1, label: 'p2' },
      p3: { type: 'float', default: 0.5, min: 0, max: 1, label: 'p3' },
      p4: { type: 'float', default: 0.5, min: 0, max: 1, label: 'p4' },
      color1: { type: 'color', default: [1, 0.62, 0.3, 1], label: 'color1' },
    },
    passes: [{ frag: (params) => String(params.code ?? '') }],
  }),
] satisfies NodeDef[];
