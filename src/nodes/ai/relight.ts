/**
 * Relight: a virtual point light on a photo, using a depth map (ai.depth, near = white) for surface
 * normals (Sobel) and screen-space soft shadows (a short, bounded ray march through the depth field).
 */
import { defineNode } from '../../core/registry';
import type { NodeDef } from '../../core/types';
import { AI_COLOR } from './_shared';

const MODES = ['Add light', 'Multiply shade', 'Full relight'];

const relight = defineNode({
  id: 'ai.relight',
  name: 'Relight',
  category: 'AI',
  color: AI_COLOR,
  description:
    'Adds a virtual light to a photo. Connect a Depth Map (AI) to “depth”: surface normals come from the depth (Sobel), and soft shadows from a short ray march through it. ' +
    'Select the node and drag the light in the viewer. Add light brightens what faces the light; Multiply shade only darkens what faces away; Full relight darkens the scene to the ambient level and lights it again (with a little specular).',
  tags: ['relight', 'light', 'lighting', 'lamp', 'spotlight', 'shadow', 'normals', 'depth', '3d', 'ai', 'dramatic'],
  inputs: {
    image: { type: 'image', label: 'Image' },
    depth: { type: 'mask', label: 'Depth (near = white)', fallback: 'gray' },
  },
  params: {
    light: { type: 'vec2', default: [0.3, 0.25], min: -0.5, max: 1.5, step: 0.001, label: 'Light position', description: 'On the image, 0..1 from the top-left. Drag it in the viewer.' },
    height: { type: 'float', default: 0.35, min: 0, max: 2, step: 0.01, label: 'Light height', description: 'Distance of the light in front of the image plane (image height = 1).' },
    color: { type: 'color', default: [1, 0.9, 0.75, 1], label: 'Light colour' },
    intensity: { type: 'float', default: 1.2, min: 0, max: 8, step: 0.01, label: 'Intensity' },
    falloff: { type: 'float', default: 1, min: 0, max: 10, step: 0.01, label: 'Falloff', description: 'Inverse-square falloff strength (0 = none).' },
    ambient: { type: 'float', default: 0.55, min: 0, max: 1.5, step: 0.01, label: 'Ambient / rest', description: 'Brightness of what the light does not reach (1 = unchanged).' },
    mode: { type: 'enum', default: MODES[2], options: MODES, label: 'Blend' },
    strength: { type: 'float', default: 2.5, min: 0, max: 30, step: 0.1, label: 'Normal strength', description: 'How strongly depth slopes turn surfaces (Sobel gain).' },
    radius: { type: 'float', default: 6, min: 1, max: 30, step: 0.5, pixels: true, label: 'Normal smoothing', description: 'Sobel sample distance, px.' },
    depthScale: { type: 'float', default: 0.3, min: 0, max: 2, step: 0.01, label: 'Depth range', description: 'Scene depth (near − far) in image heights; for falloff and shadows.' },
    shadows: { type: 'bool', default: true, label: 'Shadows' },
    shadowSoftness: { type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Shadow softness' },
    shadowStrength: { type: 'float', default: 0.8, min: 0, max: 1, step: 0.01, label: 'Shadow strength' },
    specular: { type: 'float', default: 0.15, min: 0, max: 2, step: 0.01, label: 'Specular' },
    showLight: { type: 'bool', default: false, label: 'Show light only' },
  },
  viewerTool: { kind: 'points', single: true, vec2Param: 'light', label: 'Relight' },
  passes: [
    {
      frag: /* glsl */ `
float D(vec2 uv) { return texClamp(u_depth, uv).r; }
void main() {
  vec4 src = texture(u_image, v_uv);
  vec3 base = srgbToLinear(src.rgb);
  float aspect = u_resolution.x / u_resolution.y;
  // normals from depth (Sobel, at radius px)
  vec2 e = max(u_radius * u_scale, 1.0) / u_resolution;
  float tl = D(v_uv + vec2(-e.x, -e.y)), tc = D(v_uv + vec2(0.0, -e.y)), tr = D(v_uv + vec2(e.x, -e.y));
  float ml = D(v_uv + vec2(-e.x, 0.0)), mr = D(v_uv + vec2(e.x, 0.0));
  float bl = D(v_uv + vec2(-e.x, e.y)), bc = D(v_uv + vec2(0.0, e.y)), br = D(v_uv + vec2(e.x, e.y));
  float gx = (tr + 2.0 * mr + br - tl - 2.0 * ml - bl) / 8.0;
  float gy = (bl + 2.0 * bc + br - tl - 2.0 * tc - tr) / 8.0;
  // slope per image-height unit → normal (x right, y down, z towards the viewer)
  // (e.x * aspect == e.y: both steps are the same distance in image-height units)
  float k = u_strength * 0.02 / e.y;
  vec2 g = vec2(gx, gy) * k;
  // compress steep slopes: depth discontinuities (object outlines) would otherwise give dark/bright rims
  float gl = length(g);
  g *= 1.0 / (1.0 + max(gl - 0.6, 0.0) * 1.5);
  vec3 n = normalize(vec3(-g, 1.0));
  float d0 = D(v_uv);
  vec3 P = vec3(v_uv.x * aspect, v_uv.y, d0 * u_depthScale);
  vec3 L = vec3(u_light.x * aspect, u_light.y, u_height + u_depthScale);
  vec3 toL = L - P;
  float dist = length(toL);
  vec3 l = toL / max(dist, 1e-4);
  float diff = max(dot(n, l), 0.0);
  float att = 1.0 / (1.0 + u_falloff * dist * dist * 4.0);

  // screen-space shadow ray march (bounded): does the depth field rise above the ray towards the light?
  float sh = 1.0;
  if (u_shadows && u_shadowStrength > 0.0) {
    float jit = hash12(pixelCoord());
    float soft = mix(0.05, 0.8, u_shadowSoftness);
    // march at most 40% of the image height in screen space, starting a few pixels away (no self-shadowing)
    float len2d = length(toL.xy);
    float reach = min(1.0, 0.4 / max(len2d, 1e-4));
    float t0 = min(0.5, 3.0 / (u_resolution.y * max(len2d, 1e-4)));
    float bias = 0.012 * u_depthScale;
    for (int i = 0; i < 24; i++) {
      float t = mix(t0, reach, (float(i) + jit) / 24.0);
      vec3 Q = P + toL * t;
      vec2 uv = vec2(Q.x / aspect, Q.y);
      if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) break;
      float h = D(uv) * u_depthScale - Q.z - bias; // > 0: occluder above the ray
      if (h > 0.0) sh = min(sh, clamp(1.0 - h / (soft * len2d * t + 0.02 * u_depthScale), 0.0, 1.0));
    }
    sh = mix(1.0, sh, u_shadowStrength);
  }
  vec3 lc = srgbToLinear(u_color.rgb) * u_intensity;
  float lit = diff * att * sh;
  vec3 h = normalize(l + vec3(0.0, 0.0, 1.0));
  float spec = pow(max(dot(n, h), 0.0), 40.0) * u_specular * att * sh;
  if (u_showLight) { fragColor = vec4(linearToSrgb(vec3(lit) * lc), 1.0); return; }
  vec3 c;
  if (u_mode == 0) c = base * u_ambient + base * lc * lit + lc * spec * 0.5;
  else if (u_mode == 1) c = base * mix(vec3(u_ambient), vec3(1.0), clamp(lit * lc / max(u_intensity, 1e-3), 0.0, 1.0));
  else c = base * (u_ambient + lc * lit) + lc * spec;
  fragColor = vec4(linearToSrgb(max(c, 0.0)), src.a);
}`,
    },
  ],
});

export default [relight] satisfies NodeDef[];
