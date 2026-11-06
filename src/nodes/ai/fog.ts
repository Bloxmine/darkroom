/** Depth-driven atmosphere: haze/fog that thickens with distance (wire ai.depth into `depth`). */
import { defineNode } from '../../core/registry';
import type { NodeDef } from '../../core/types';
import { AI_COLOR } from './_shared';

const depthFog = defineNode({
  id: 'ai.depthFog',
  name: 'Depth Fog',
  category: 'AI',
  color: AI_COLOR,
  description:
    'Atmospheric haze driven by a depth map (connect Depth Map; near = white): fog density grows exponentially with distance, ' +
    'far areas soften, lose saturation and take on the fog colour, like aerial perspective or morning mist.',
  tags: ['fog', 'haze', 'mist', 'atmosphere', 'aerial perspective', 'depth', 'ai', 'morning'],
  inputs: {
    image: { type: 'image', label: 'Image' },
    depth: { type: 'mask', label: 'Depth (near = white)', fallback: 'white' },
  },
  params: {
    density: { type: 'float', default: 0.6, min: 0, max: 5, step: 0.01, label: 'Density' },
    start: { type: 'float', default: 0.1, min: 0, max: 0.95, step: 0.005, label: 'Fog start', description: 'Distance (0 = nearest, 1 = farthest) where fog begins.' },
    curve: { type: 'float', default: 1.4, min: 0.25, max: 4, step: 0.01, label: 'Falloff curve', description: '>1 keeps the mid-ground clearer.' },
    color: { type: 'color', default: [0.82, 0.85, 0.88, 1], label: 'Fog colour' },
    soften: { type: 'float', default: 6, min: 0, max: 40, step: 0.5, pixels: true, label: 'Soften far', description: 'Blur radius (px) at full fog.' },
    desaturate: { type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Desaturate far' },
    showFog: { type: 'bool', default: false, label: 'Show fog amount' },
  },
  passes: [
    {
      frag: /* glsl */ `
float fogAt(vec2 uv) {
  float dist = 1.0 - texture(u_depth, uv).r;
  float x = max(dist - u_start, 0.0) / max(1.0 - u_start, 1e-3);
  return (1.0 - exp(-u_density * 2.0 * pow(x, u_curve))) * u_color.a;
}
void main() {
  vec4 src = texture(u_image, v_uv);
  float f = fogAt(v_uv);
  if (u_showFog) { fragColor = vec4(vec3(f), 1.0); return; }
  vec3 c = srgbToLinear(src.rgb);
  float R = u_soften * u_scale * f;
  if (R >= 0.5) {
    vec3 acc = c; float ws = 1.0;
    float rot = hash12(pixelCoord()) * TAU;
    for (int i = 0; i < 16; i++) {
      float r = sqrt((float(i) + 0.5) / 16.0) * R;
      float a = float(i) * 2.39996323 + rot;
      vec2 uv = v_uv + vec2(cos(a), sin(a)) * r / u_resolution;
      float w = fogAt(uv);  // don't pull near (sharp) pixels into the haze
      acc += srgbToLinear(texClamp(u_image, uv).rgb) * w; ws += w;
    }
    c = acc / ws;
  }
  c = mix(c, vec3(luma(c)), u_desaturate * f);
  c = mix(c, srgbToLinear(u_color.rgb), f);
  fragColor = vec4(linearToSrgb(c), src.a);
}`,
    },
  ],
});

export default [depthFog] satisfies NodeDef[];
