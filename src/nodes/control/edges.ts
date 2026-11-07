/**
 * Edge-type ControlNet preprocessors, all on the GPU:
 *  - control.canny: OpenCV Canny (3×3 Sobel per channel, L1 magnitude, non-maximum suppression, double
 *    threshold + iterative hysteresis), white edges on black, like sd-webui-controlnet "canny".
 *  - control.softEdge: a multi-scale gradient approximation of HED / PiDiNet soft edges (no permissively
 *    licensed ONNX export of ControlNetHED or PiDiNet exists, see docs/CONTROLNET.md), with "safe" quantising.
 *  - control.scribble: the soft edges → controlnet_aux `nms(x, 127, 3)` → blur σ 3 → `> 4` (thick, simplified strokes).
 */
import { defineNode } from '../../core/registry';
import type { NodeDef, ShaderPass } from '../../core/types';
import { AREA_DOWN_FRAG, CATEGORY, CONTROL_COLOR, detectSize, gaussPass, greyOut, resolutionParam, SAFE_STEP_GLSL } from './_shared';

// ---------------------------------------------------------------------------------------------- Canny
const canny = defineNode({
  id: 'control.canny',
  name: 'Canny (ControlNet)',
  category: CATEGORY,
  color: CONTROL_COLOR,
  description:
    'Canny edge map for the ControlNet canny models: white 1-px edges on black, computed at the detect resolution exactly like OpenCV Canny ' +
    '(per-channel 3×3 Sobel, L1 gradient, non-maximum suppression, low/high hysteresis thresholds in 0–255 units), then resized to the output.',
  tags: ['controlnet', 'canny', 'edges', 'edge detection', 'control map', 'stable diffusion', 'preprocessor'],
  inputs: { image: { type: 'image', label: 'Image' } },
  params: {
    resolution: resolutionParam(512),
    lowThreshold: { type: 'int', default: 100, min: 1, max: 255, step: 1, label: 'Low threshold', description: 'Weak edges above this are kept when connected to a strong edge.' },
    highThreshold: { type: 'int', default: 200, min: 1, max: 255, step: 1, label: 'High threshold', description: 'Gradients above this start an edge.' },
    hysteresis: { type: 'int', default: 96, min: 0, max: 256, step: 1, label: 'Hysteresis passes', description: 'How far (px at detect resolution) weak edges are followed from strong ones. 0 = strong edges only.' },
  },
  passes: [
    // 0: area downsample to the detect resolution
    { size: detectSize(), frag: AREA_DOWN_FRAG },
    // 1: Sobel per channel, the channel with the largest L1 magnitude wins (cv2.Canny on a 3-channel image)
    {
      size: detectSize(),
      frag: /* glsl */ `
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 s[9];
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) s[(j + 1) * 3 + i + 1] = texel(u_pass0, p + ivec2(i, j)).rgb * 255.0;
  // gl_FragCoord y grows upwards in the texture = towards v_uv 1 (image bottom); the sign is irrelevant for NMS/magnitude
  vec3 gx = (s[2] + 2.0 * s[5] + s[8]) - (s[0] + 2.0 * s[3] + s[6]);
  vec3 gy = (s[6] + 2.0 * s[7] + s[8]) - (s[0] + 2.0 * s[1] + s[2]);
  vec3 m = abs(gx) + abs(gy);
  int c = m.r >= m.g && m.r >= m.b ? 0 : (m.g >= m.b ? 1 : 2);
  fragColor = vec4(gx[c], gy[c], m[c], 1.0);
}`,
    },
    // 2: non-maximum suppression + double threshold (1 strong, 0.5 weak, 0 none)
    {
      size: detectSize(),
      filter: 'nearest',
      frag: /* glsl */ `
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 g = texel(u_pass1, p).xyz;
  float m = g.z;
  float lo = float(min(u_lowThreshold, u_highThreshold)), hi = float(max(u_lowThreshold, u_highThreshold));
  if (m <= lo) { fragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  float ax = abs(g.x), ay = abs(g.y);
  ivec2 d;
  if (ay <= ax * 0.41421356) d = ivec2(1, 0);          // gradient ~horizontal: compare left/right
  else if (ay > ax * 2.41421356) d = ivec2(0, 1);      // ~vertical: compare up/down
  else d = g.x * g.y < 0.0 ? ivec2(-1, 1) : ivec2(1, 1);
  float a = texel(u_pass1, p - d).z, b = texel(u_pass1, p + d).z;
  bool keep = m > a && m >= b;
  float v = !keep ? 0.0 : (m > hi ? 1.0 : 0.5);
  fragColor = vec4(v, 0.0, 0.0, 1.0);
}`,
    },
    // 3: hysteresis — weak pixels touching a strong one become strong (ping-pong)
    {
      size: detectSize(),
      filter: 'nearest',
      repeat: (c) => Math.max(0, Math.min(256, Number(c.params.hysteresis) || 0)),
      frag: /* glsl */ `
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float v = texel(u_prev, p).r;
  if (v > 0.25 && v < 0.75) {
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) if (texel(u_prev, p + ivec2(i, j)).r > 0.75) v = 1.0;
  }
  fragColor = vec4(v, 0.0, 0.0, 1.0);
}`,
    },
    // 4: keep the strong edges, bilinear-resized to the output
    {
      size: detectSize(),
      frag: `void main() { fragColor = vec4(texel(u_prev, ivec2(gl_FragCoord.xy)).r > 0.75 ? 1.0 : 0.0, 0.0, 0.0, 1.0); }`,
    },
    { frag: greyOut('u_prev') },
  ],
});

// ------------------------------------------------------------------------------------- Soft edges
/** 2× box downsample of u_prev (4 bilinear taps = a 4×4 box). */
const HALF_FRAG = /* glsl */ `
void main() {
  vec2 t = 0.5 / u_prev_size;
  vec3 c = texture(u_prev, v_uv + vec2(-t.x, -t.y)).rgb + texture(u_prev, v_uv + vec2(t.x, -t.y)).rgb
         + texture(u_prev, v_uv + vec2(-t.x, t.y)).rgb + texture(u_prev, v_uv + vec2(t.x, t.y)).rgb;
  fragColor = vec4(c * 0.25, 1.0);
}`;
const half = (k: number) => (c: Parameters<NonNullable<ShaderPass['size']>>[0]): [number, number] => {
  const [w, h] = detectSize()(c);
  return [Math.max(1, Math.round(w / k)), Math.max(1, Math.round(h / k))];
};

const SOFT_MODES = ['HED (approximation)', 'PiDiNet (approximation)'];

/**
 * Passes 0–5: detect-res RGB, a 4-level pyramid, then the soft edge strength (r) at detect resolution.
 * Per level: colour Sobel magnitude in that level's texels (≈ scale-normalised, so a step edge answers at
 * every level and fine texture fades at the coarse ones). HED-like: object outlines are the edges that
 * persist across scales → weighted mean that favours the coarse levels; PiDiNet-like: finer and thinner.
 */
const softEdgePasses = (): ShaderPass[] => [
  { size: detectSize(), frag: AREA_DOWN_FRAG },
  { size: half(2), frag: HALF_FRAG },
  { size: half(4), frag: HALF_FRAG },
  { size: half(8), frag: HALF_FRAG },
  { size: half(16), frag: HALF_FRAG },
  {
    size: detectSize(),
    frag: /* glsl */ `
float gradAt(sampler2D t, vec2 ts) {
  vec2 e = 1.0 / ts;
  vec3 tl = texture(t, v_uv + vec2(-e.x, -e.y)).rgb, tc = texture(t, v_uv + vec2(0.0, -e.y)).rgb, tr = texture(t, v_uv + vec2(e.x, -e.y)).rgb;
  vec3 ml = texture(t, v_uv + vec2(-e.x, 0.0)).rgb, mr = texture(t, v_uv + vec2(e.x, 0.0)).rgb;
  vec3 bl = texture(t, v_uv + vec2(-e.x, e.y)).rgb, bc = texture(t, v_uv + vec2(0.0, e.y)).rgb, br = texture(t, v_uv + vec2(e.x, e.y)).rgb;
  vec3 gx = (tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl);
  vec3 gy = (bl + 2.0 * bc + br) - (tl + 2.0 * tc + tr);
  // perceptual-ish colour gradient: luma counts most, chroma still separates iso-luminant regions
  vec3 w = vec3(0.45, 0.8, 0.35);
  return sqrt(dot(gx * gx + gy * gy, w * w)) * 0.25;
}
void main() {
  float e0 = gradAt(u_pass0, u_pass0_size), e1 = gradAt(u_pass1, u_pass1_size), e2 = gradAt(u_pass2, u_pass2_size);
  float e3 = gradAt(u_pass3, u_pass3_size), e4 = gradAt(u_pass4, u_pass4_size);
  float k = clamp(u_detail, 0.0, 1.0);
  float E;
  if (u_mode == 0) {
    // HED: soft outlines a few px wide; edges must persist at the coarse scales (texture is suppressed)
    float loc = (e0 + 2.0 * e1 + e2) * 0.25;
    float gate = smoothstep(0.015, 0.09 - 0.05 * k, max(e2, e3));
    E = loc * gate;
  } else {
    // PiDiNet: thinner and crisper; fine scales gated by the mid scales
    float gate = smoothstep(0.015, 0.08 - 0.045 * k, max(e1, e2));
    E = (e0 * 0.7 + e1 * 0.3) * gate;
  }
  float tau = mix(0.06, 0.012, k);
  float v = 1.0 - exp(-max(E - tau, 0.0) * u_strength * 10.0);
  fragColor = vec4(v, 0.0, 0.0, 1.0);
}`,
  },
];

const softParams = {
  resolution: resolutionParam(512),
  mode: { type: 'enum' as const, default: SOFT_MODES[0], options: SOFT_MODES, label: 'Style', description: 'HED = thick soft outlines, PiDiNet = thinner, crisper edges. Both are GPU approximations of the neural annotators.' },
  strength: { type: 'float' as const, default: 1, min: 0.1, max: 4, step: 0.01, label: 'Strength' },
  detail: { type: 'float' as const, default: 0.5, min: 0, max: 1, step: 0.01, label: 'Detail', description: 'How much fine texture (vs. only object outlines) shows up.' },
};

const softEdge = defineNode({
  id: 'control.softEdge',
  name: 'Soft Edge (ControlNet)',
  category: CATEGORY,
  color: CONTROL_COLOR,
  description:
    'Soft edge map for the ControlNet softedge models (HED / PiDiNet style): white soft outlines on black. ' +
    'A multi-scale colour-gradient approximation that runs on the GPU (no permissively licensed ONNX export of ControlNetHED or PiDiNet exists). ' +
    '“Safe” quantises the map to three levels like the hed_safe / pidinet_safe preprocessors, which hides the remaining texture.',
  tags: ['controlnet', 'softedge', 'soft edge', 'hed', 'pidinet', 'edges', 'control map', 'stable diffusion', 'preprocessor'],
  inputs: { image: { type: 'image', label: 'Image' } },
  params: { ...softParams, safe: { type: 'bool', default: false, label: 'Safe (quantised)' } },
  passes: [
    ...softEdgePasses(),
    {
      size: detectSize(),
      frag: /* glsl */ `
${SAFE_STEP_GLSL}
void main() { float v = texture(u_prev, v_uv).r; fragColor = vec4(u_safe ? safeStep(v) : v, 0.0, 0.0, 1.0); }`,
    },
    { frag: greyOut('u_prev') },
  ],
});

// ------------------------------------------------------------------------------------------ Scribble
const scribble = defineNode({
  id: 'control.scribble',
  name: 'Scribble (ControlNet)',
  category: CATEGORY,
  color: CONTROL_COLOR,
  description:
    'Scribble map for the ControlNet scribble models: thick, simplified white strokes on black. ' +
    'Soft edges → non-maximum suppression (controlnet_aux nms, σ 3) → threshold → gaussian dilation (σ 3, > 4/255), as the scribble_hed / scribble_pidinet preprocessors.',
  tags: ['controlnet', 'scribble', 'sketch', 'doodle', 'edges', 'control map', 'stable diffusion', 'preprocessor'],
  inputs: { image: { type: 'image', label: 'Image' } },
  params: {
    ...softParams,
    threshold: { type: 'float', default: 0.5, min: 0.05, max: 0.95, step: 0.01, label: 'Threshold', description: 'Soft-edge level a stroke must exceed (127/255 in controlnet_aux).' },
    thickness: { type: 'float', default: 3, min: 0.5, max: 12, step: 0.1, label: 'Thickness', description: 'Gaussian σ of the stroke dilation, px at detect resolution (3 = standard).' },
  },
  passes: [
    ...softEdgePasses(),
    // 6, 7: blur σ 3 (nms() blurs before the line-max test)
    { size: detectSize(), frag: gaussPass(false, '3.0') },
    { size: detectSize(), frag: gaussPass(true, '3.0') },
    // 8: local max along any of the 4 line directions, above the threshold
    {
      size: detectSize(),
      frag: /* glsl */ `
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float x = texel(u_prev, p).r;
  bool keep = false;
  ivec2 D[4] = ivec2[4](ivec2(1, 0), ivec2(0, 1), ivec2(1, 1), ivec2(1, -1));
  for (int k = 0; k < 4; k++) {
    if (x >= texel(u_prev, p + D[k]).r && x >= texel(u_prev, p - D[k]).r) keep = true;
  }
  fragColor = vec4(keep && x > u_threshold ? 1.0 : 0.0, 0.0, 0.0, 1.0);
}`,
    },
    // 9, 10: gaussian dilation
    { size: detectSize(), frag: gaussPass(false, 'u_thickness') },
    { size: detectSize(), frag: gaussPass(true, 'u_thickness') },
    { size: detectSize(), frag: `void main() { fragColor = vec4(texture(u_prev, v_uv).r > 4.0 / 255.0 ? 1.0 : 0.0, 0.0, 0.0, 1.0); }` },
    { frag: greyOut('u_prev') },
  ],
});

export default [canny, softEdge, scribble] satisfies NodeDef[];
