import { defineNode } from '../../core/registry';
import type { NodeDef } from '../../core/types';
import { F } from './_shared';

const C = '#7cf29c';

/**
 * Motion-only analog artefacts. Frame 0 is always the identity, so stills
 * (and still exports) are unchanged; see docs/VIDEO.md.
 */
const gateWeave = defineNode({
  id: 'analog.gateWeave',
  name: 'Gate Weave',
  category: 'Analog',
  color: C,
  description:
    'Film running through a projector gate: the frame drifts and jumps a little every frame, with a slight rotation and exposure flicker. ' +
    'Only visible in motion (playback / video export); frame 0 is untouched.',
  tags: ['film', 'super 8', '8mm', 'projector', 'jitter', 'flicker', 'weave', 'motion'],
  inputs: { image: { type: 'image' } },
  params: {
    amount: { type: 'float', default: 3, min: 0, max: 30, step: 0.1, pixels: true, label: 'Weave', description: 'Drift in full-res pixels.' },
    jitter: { type: 'float', default: 0.5, min: 0, max: 2, step: 0.01, label: 'Frame jitter', description: 'Per-frame jumps on top of the slow drift.' },
    rotation: { type: 'float', default: 0.15, min: 0, max: 2, step: 0.01, label: 'Rotation (°)' },
    flicker: { type: 'float', default: 0.06, min: 0, max: 0.5, step: 0.005, label: 'Exposure flicker' },
    animate: { type: 'bool', default: true, label: 'Animate', description: 'Move every frame during playback and video export.' },
  },
  passes: [{
    frag: F(`
float dn(float f, float k) { return valueNoise(vec2(f * 0.35, k)) - valueNoise(vec2(0.0, k)); }
void main() {
  float f = u_animate ? float(u_frame) : 0.0;
  float on = step(0.5, f);
  vec2 drift = vec2(dn(f, 3.1), dn(f, 9.7)) * 2.0;
  vec2 jump = (hash22(vec2(mod(f, 997.0), 17.0)) - 0.5) * u_jitter * on;
  vec2 off = (drift + jump) * u_amount * u_scale;
  float rot = dn(f, 5.3) * 2.0 * radians(u_rotation);
  vec2 c = u_resolution * 0.5;
  vec2 p = rot2(rot) * (pixelCoord() - c) - off + c;
  vec4 s = texClamp(u_image, p / u_resolution);
  float fl = 1.0 + u_flicker * (hash11(mod(f, 997.0) * 1.37 + 0.5) - 0.5) * 2.0 * on;
  fragColor = vec4(s.rgb * fl, s.a);
}`),
  }],
});

export default [gateWeave] satisfies NodeDef[];
