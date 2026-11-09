/**
 * Lightroom-style graduated (linear) and radial filters with on-image handles (viewer tool `handles`),
 * plus a `mask` output that the viewer tints while the node is selected ("Show mask").
 */
import { defineNode } from '../../core/registry';
import type { NodeDef, ShaderPass } from '../../core/types';
import { adjParams, blurPasses, GLSL_ADJUST } from './local-shared';

const C = '#c08a3e';

function passesFor(weightGlsl: string): ShaderPass[] {
  return [
    ...blurPasses(),
    {
      output: 'out',
      frag: /* glsl */ `
${GLSL_ADJUST}
${weightGlsl}
void main() {
  vec4 c = texture(u_image, v_uv);
  float w = weight(v_uv * u_resolution);
  fragColor = vec4(localAdjust(c.rgb, texture(u_pass1, v_uv).rgb, w), c.a);
}`,
    },
    {
      output: 'mask',
      frag: /* glsl */ `
${weightGlsl}
void main() { float w = weight(v_uv * u_resolution); fragColor = vec4(w, w, w, 1.0); }`,
    },
  ];
}

const grad = defineNode({
  id: 'pro.gradFilter',
  name: 'Graduated Filter',
  category: 'Local',
  color: C,
  description:
    'Lightroom-style linear gradient: drag the Start and End handles in the viewer. The adjustments apply fully on the Start side and fade out smoothly to nothing at End. ' +
    'Exposure, white balance, contrast, highlights/shadows, saturation and clarity. Classic use: darken and saturate a bright sky (the default). The mask output (tinted in the viewer while selected) can drive other nodes.',
  tags: ['graduated', 'gradient', 'nd filter', 'grad nd', 'linear gradient', 'sky', 'local adjustment', 'lightroom', 'mask'],
  inputs: { image: { type: 'image' } },
  outputs: { out: { type: 'image' }, mask: { type: 'mask', label: 'Mask' } },
  params: {
    start: { type: 'vec2', default: [0.5, 0.12], min: 0, max: 1, step: 0.001, label: 'Start (full effect)' },
    end: { type: 'vec2', default: [0.5, 0.5], min: 0, max: 1, step: 0.001, label: 'End (no effect)' },
    ...adjParams({ exposure: -0.9, saturation: 0.15, highlights: -0.3 }),
    invert: { type: 'bool', default: false, label: 'Invert' },
  },
  viewerTool: { kind: 'points', handles: [{ param: 'start', label: 'Start' }, { param: 'end', label: 'End' }], previewPort: 'mask', label: 'Graduated Filter' },
  passes: passesFor(/* glsl */ `
float weight(vec2 p) {
  vec2 s = u_start * u_resolution, e = u_end * u_resolution;
  vec2 d = e - s;
  float t = dot(p - s, d) / max(dot(d, d), 1e-6);
  float w = 1.0 - smoothstep(0.0, 1.0, t);
  return u_invert ? 1.0 - w : w;
}`),
});

const radial = defineNode({
  id: 'pro.radialFilter',
  name: 'Radial Filter',
  category: 'Local',
  color: C,
  description:
    'Lightroom-style elliptical filter: drag Centre and Edge in the viewer (Edge sets the horizontal radius and the rotation; Roundness sets the other radius). ' +
    'Feather softens the border; apply the adjustments inside (spotlight a subject, the default) or outside (custom vignette). Mask output included.',
  tags: ['radial', 'ellipse', 'spotlight', 'vignette', 'local adjustment', 'lightroom', 'mask', 'oval'],
  inputs: { image: { type: 'image' } },
  outputs: { out: { type: 'image' }, mask: { type: 'mask', label: 'Mask' } },
  params: {
    center: { type: 'vec2', default: [0.5, 0.48], min: 0, max: 1, step: 0.001, label: 'Centre' },
    edge: { type: 'vec2', default: [0.78, 0.48], min: 0, max: 1, step: 0.001, label: 'Edge (radius / rotation)' },
    roundness: { type: 'float', default: 1.25, min: 0.05, max: 4, step: 0.01, label: 'Roundness', description: 'Second radius as a multiple of the Centre→Edge radius.' },
    feather: { type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, label: 'Feather' },
    placement: { type: 'enum', default: 'inside', options: ['inside', 'outside'], label: 'Apply' },
    ...adjParams({ exposure: 0.6, clarity: 0.2, saturation: 0.1 }),
  },
  viewerTool: { kind: 'points', handles: [{ param: 'center', label: 'Centre' }, { param: 'edge', label: 'Edge' }], previewPort: 'mask', label: 'Radial Filter' },
  passes: passesFor(/* glsl */ `
float weight(vec2 p) {
  vec2 c = u_center * u_resolution, e = u_edge * u_resolution;
  vec2 ax = e - c;
  float rx = max(length(ax), 1.0);
  vec2 u = ax / rx, v = vec2(-u.y, u.x);
  float ry = max(rx * u_roundness, 1.0);
  vec2 q = p - c;
  float d = length(vec2(dot(q, u) / rx, dot(q, v) / ry));
  float f = max(u_feather, 0.001);
  float w = 1.0 - smoothstep(1.0 - f, 1.0, d);
  return u_placement == 1 ? 1.0 - w : w;
}`),
});

export default [grad, radial] satisfies NodeDef[];
