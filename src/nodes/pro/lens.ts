/**
 * Lens corrections: distortion / vignetting / lateral CA (pro.lensCorrect), purple–green fringe removal
 * (pro.defringe) and horizon / vertical auto-straighten (pro.autoStraighten).
 */
import { setNodeInfo } from '../../core/nodeInfo';
import { defineNode } from '../../core/registry';
import type { NodeDef, PassContext } from '../../core/types';
import { num } from '../library/shared';
import { autoCropZoom, downsampleLuma, estimateTilt, type StraightenMode } from './lens-math';

const C = '#8a6fb0';

const distortion = (p: PassContext['params']) => ({ k1: num(p, 'k1', 0), k2: num(p, 'k2', 0), k3: num(p, 'k3', 0), p1: num(p, 'p1', 0), p2: num(p, 'p2', 0) });

const lensCorrect = defineNode({
  id: 'pro.lensCorrect',
  name: 'Lens Correction',
  category: 'Lens',
  color: C,
  description:
    'Manual lens profile: Brown–Conrady radial distortion (k1, k2, k3 — positive values straighten barrel distortion, negative pincushion) and tangential / decentering terms (p1, p2), ' +
    'all relative to the half-diagonal so they are resolution independent; vignetting correction (inverse polynomial gain in linear light: + brightens the corners); ' +
    'lateral chromatic aberration (scale red / blue relative to green); auto-crop to remove empty borders; and a grid overlay to judge straight lines.',
  tags: ['lens', 'distortion', 'barrel', 'pincushion', 'brown conrady', 'vignetting', 'chromatic aberration', 'lateral ca', 'profile', 'correction', 'grid'],
  inputs: { image: { type: 'image' } },
  params: {
    k1: { type: 'float', default: 0.06, min: -0.6, max: 0.6, step: 0.001, label: 'Distortion k1', description: '+ fixes barrel (wide-angle), − fixes pincushion (tele).' },
    k2: { type: 'float', default: 0, min: -0.6, max: 0.6, step: 0.001, label: 'k2 (moustache)' },
    k3: { type: 'float', default: 0, min: -0.6, max: 0.6, step: 0.001, label: 'k3' },
    p1: { type: 'float', default: 0, min: -0.05, max: 0.05, step: 0.0005, label: 'Tangential p1' },
    p2: { type: 'float', default: 0, min: -0.05, max: 0.05, step: 0.0005, label: 'Tangential p2' },
    vignette: { type: 'float', default: 0.35, min: -1, max: 1, step: 0.01, label: 'Vignetting', description: '+ brightens the corners (corrects lens falloff).' },
    vignette2: { type: 'float', default: 0, min: -1, max: 1, step: 0.01, label: 'Vignetting (r⁴)' },
    caRed: { type: 'float', default: 0, min: -1, max: 1, step: 0.005, label: 'CA red (%)', description: 'Scale of the red channel relative to green, in percent.' },
    caBlue: { type: 'float', default: 0, min: -1, max: 1, step: 0.005, label: 'CA blue (%)' },
    autoCrop: { type: 'bool', default: true, label: 'Auto-crop' },
    zoom: { type: 'float', default: 1, min: 0.5, max: 2, step: 0.001, label: 'Zoom', description: 'Extra zoom on top of auto-crop.' },
    showGrid: { type: 'bool', default: false, label: 'Show grid' },
  },
  passes: [{
    uniforms: (ctx: PassContext) => {
      const W = ctx.width, H = ctx.height, R = 0.5 * Math.hypot(W, H);
      const hw = W / 2 / R, hh = H / 2 / R;
      const ca = Math.max(Math.abs(num(ctx.params, 'caRed', 0)), Math.abs(num(ctx.params, 'caBlue', 0))) / 100;
      const z = ctx.params.autoCrop === false ? 1 : autoCropZoom(distortion(ctx.params), hw, hh, ca);
      return { u_z: z / Math.max(0.05, num(ctx.params, 'zoom', 1)), u_half: [hw, hh] };
    },
    frag: /* glsl */ `
uniform float u_z;
uniform vec2 u_half;
vec2 distortP(vec2 p) {
  float r2 = dot(p, p);
  float radial = 1.0 - u_k1 * r2 - u_k2 * r2 * r2 - u_k3 * r2 * r2 * r2;
  return p * radial + vec2(2.0 * u_p1 * p.x * p.y + u_p2 * (r2 + 2.0 * p.x * p.x), u_p1 * (r2 + 2.0 * p.y * p.y) + 2.0 * u_p2 * p.x * p.y);
}
vec2 toUv(vec2 p) { return p / (2.0 * u_half) + 0.5; }
void main() {
  // centred coordinates normalised to the half-diagonal (r = 1 at the corners)
  vec2 p = (v_uv - 0.5) * 2.0 * u_half * u_z;
  vec2 s = distortP(p);
  vec2 uvG = toUv(s), uvR = toUv(s * (1.0 + u_caRed / 100.0)), uvB = toUv(s * (1.0 + u_caBlue / 100.0));
  vec4 g = texture(u_image, uvG);
  vec3 c = vec3(texture(u_image, uvR).r, g.g, texture(u_image, uvB).b);
  float a = g.a;
  if (any(lessThan(uvG, vec2(0.0))) || any(greaterThan(uvG, vec2(1.0)))) a = 0.0;
  // vignetting: divide by the falloff 1 − v1 r² − v2 r⁴ in linear light (r of the source point)
  float r2 = dot(s, s);
  float fall = max(1.0 - u_vignette * 0.5 * r2 - u_vignette2 * 0.5 * r2 * r2, 0.2);
  c = linearToSrgb(srgbToLinear(max(c, 0.0)) / fall);
  if (u_showGrid) {
    vec2 px = v_uv * u_resolution;
    float cell = min(u_resolution.x, u_resolution.y) / 8.0;
    vec2 f = abs(fract(px / cell + 0.5) - 0.5) * cell;
    float line = 1.0 - smoothstep(0.5, 1.5, min(f.x, f.y));
    c = mix(c, vec3(1.0, 0.85, 0.2), line * 0.8);
  }
  fragColor = vec4(c, a);
}`,
  }],
});

const defringe = defineNode({
  id: 'pro.defringe',
  name: 'Defringe',
  category: 'Lens',
  color: C,
  description:
    'Removes purple and green colour fringes (longitudinal chromatic aberration) along high-contrast edges, like Lightroom\'s Defringe: pixels whose hue falls in the purple or green range ' +
    'AND that lie near a strong luminance edge are neutralised. Colours away from edges (purple flowers, green leaves) are left alone. "Show mask" displays what gets corrected.',
  tags: ['defringe', 'fringe', 'purple fringing', 'green fringing', 'chromatic aberration', 'loca', 'lens', 'correction'],
  inputs: { image: { type: 'image' } },
  params: {
    purpleAmount: { type: 'float', default: 0.8, min: 0, max: 1, step: 0.01, label: 'Purple amount' },
    purpleHue: { type: 'float', default: 285, min: 220, max: 340, step: 1, label: 'Purple hue (°)' },
    purpleRange: { type: 'float', default: 60, min: 10, max: 120, step: 1, label: 'Purple hue range (°)' },
    greenAmount: { type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, label: 'Green amount' },
    greenHue: { type: 'float', default: 115, min: 60, max: 170, step: 1, label: 'Green hue (°)' },
    greenRange: { type: 'float', default: 40, min: 10, max: 120, step: 1, label: 'Green hue range (°)' },
    radius: { type: 'float', default: 4, min: 1, max: 20, step: 0.5, pixels: true, label: 'Edge radius', description: 'How far from an edge a fringe may extend (full-res px).' },
    edgeContrast: { type: 'float', default: 0.25, min: 0.05, max: 0.8, step: 0.01, label: 'Edge contrast', description: 'Luminance difference that counts as a high-contrast edge.' },
    showMask: { type: 'bool', default: false, label: 'Show mask' },
  },
  passes: [{
    frag: /* glsl */ `
float hueDistDeg(float h, float c) { float d = abs(h * 360.0 - c); return min(d, 360.0 - d); }
void main() {
  vec4 src = texture(u_image, v_uv);
  vec3 c = src.rgb;
  vec2 px = 1.0 / u_resolution;
  float r = max(u_radius * u_scale, 1.0);
  // local luminance range on two rings (edge proximity)
  float mn = luma(c), mx = mn;
  vec3 neutralSum = vec3(0.0); float nw = 0.0;
  for (int i = 0; i < 12; i++) {
    float a = float(i) * TAU / 12.0;
    for (int k = 1; k <= 2; k++) {
      vec2 o = vec2(cos(a), sin(a)) * r * float(k) * 0.5;
      vec3 s = texture(u_image, v_uv + o * px).rgb;
      float l = luma(s);
      mn = min(mn, l); mx = max(mx, l);
      // least saturated neighbours tell the "true" local colour
      vec3 hsv = rgb2hsv(clamp(s, 0.0, 1.0));
      float w = 1.0 - smoothstep(0.1, 0.35, hsv.y);
      neutralSum += s * w; nw += w;
    }
  }
  float edge = smoothstep(u_edgeContrast * 0.6, u_edgeContrast, mx - mn);
  vec3 hsv = rgb2hsv(clamp(c, 0.0, 1.0));
  float satOk = smoothstep(0.06, 0.2, hsv.y);
  float pm = (1.0 - smoothstep(u_purpleRange * 0.35, u_purpleRange * 0.5, hueDistDeg(hsv.x, u_purpleHue))) * u_purpleAmount;
  float gm = (1.0 - smoothstep(u_greenRange * 0.35, u_greenRange * 0.5, hueDistDeg(hsv.x, u_greenHue))) * u_greenAmount;
  float m = clamp(max(pm, gm) * satOk * edge, 0.0, 1.0);
  if (u_showMask) { fragColor = vec4(vec3(m), 1.0); return; }
  // neutralise: keep the luminance, take the chroma of the local neutral (or grey)
  float L = luma(c);
  vec3 ref = nw > 0.5 ? neutralSum / nw : vec3(L);
  vec3 target = vec3(L) + (ref - vec3(luma(ref))) * 0.5;
  fragColor = vec4(mix(c, target, m), src.a);
}`,
  }],
});

const autoStraighten = defineNode({
  id: 'pro.autoStraighten',
  name: 'Auto Straighten',
  category: 'Lens',
  color: C,
  description:
    'Like Lightroom\'s Upright Level: finds the tilt of the dominant horizontal lines (horizon, waterline — "level"), vertical lines (buildings, poles — "vertical") or both ("auto") ' +
    'from a structure-tensor orientation histogram, then rotates the photo straight and crops the empty corners. The estimated angle is shown under the properties; Adjust adds a manual offset.',
  tags: ['straighten', 'level', 'horizon', 'upright', 'rotate', 'tilt', 'auto', 'crop', 'verticals'],
  inputs: { image: { type: 'image' } },
  params: {
    mode: { type: 'enum', default: 'level', options: ['level', 'vertical', 'auto'], label: 'Mode' },
    maxAngle: { type: 'float', default: 10, min: 1, max: 25, step: 0.5, label: 'Max correction (°)' },
    adjust: { type: 'float', default: 0, min: -10, max: 10, step: 0.05, label: 'Adjust (°)', description: 'Added to the estimated angle.' },
    crop: { type: 'bool', default: true, label: 'Crop corners' },
  },
  cpuReadsInputs: true,
  // CPU (one readback per input change, on a fixed ≤ 384 px copy so preview and export agree) rather than a
  // GPU histogram: the angle has to reach JS anyway for the node info and the crop zoom, and an orientation
  // histogram needs a scatter (reduction) that WebGL2 fragment shaders can't do in one pass.
  cpu: (ctx) => {
    const t = ctx.readInput('image');
    let angle = 0, confidence = 0;
    if (t && t.width > 8) {
      const d = downsampleLuma(t, 384);
      const e = estimateTilt(d.lum, d.w, d.h, ((ctx.params.mode as StraightenMode | undefined) ?? 'level'), num(ctx.params, 'maxAngle', 10));
      angle = e.angle; confidence = e.confidence;
    }
    const total = angle + num(ctx.params, 'adjust', 0);
    setNodeInfo(ctx.nodeId, {
      title: 'Auto Straighten',
      text: `estimated tilt ${angle.toFixed(2)}° → rotating ${(-total).toFixed(2)}°`,
      detail: `confidence ${(confidence * 100).toFixed(0)}%${confidence < 0.15 ? ' (weak: few straight lines — check visually)' : ''}`,
    });
    return { tilt: { width: 1, height: 1, data: new Float32Array([total, confidence, 0, 1]), filter: 'nearest' } };
  },
  passes: [{
    frag: /* glsl */ `
void main() {
  float deg = texelFetch(u_tilt, ivec2(0), 0).r;
  float a = radians(deg);
  vec2 S = u_resolution;
  float z = 1.0;
  if (u_crop) { // rotateCropZoom() in lens-math.ts
    float ar = max(S.x, S.y) / min(S.x, S.y); z = cos(abs(a)) + ar * sin(abs(a)); }
  // output pixel p (centred, px) samples the source at R(angle)·p / z: lines at +angle become level
  vec2 p = (v_uv - 0.5) * S / z;
  vec2 q = vec2(cos(a) * p.x - sin(a) * p.y, sin(a) * p.x + cos(a) * p.y);
  vec2 uv = q / S + 0.5;
  vec4 c = texture(u_image, uv);
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) c = vec4(0.0);
  fragColor = c;
}`,
  }],
});

export default [lensCorrect, defringe, autoStraighten] satisfies NodeDef[];
