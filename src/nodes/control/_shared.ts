/**
 * Shared bits for the ControlNet preprocessor nodes (category 'ControlNet', ids `control.*`).
 * Exports an empty NodeDef[] so the auto-registration glob is satisfied.
 *
 * Conventions follow sd-webui-controlnet / controlnet_aux: maps are computed at a "detect resolution"
 * (the short side, both sides rounded to multiples of 64, as `resize_image` in controlnet_aux/util.py),
 * then resized (bilinear) to the output size. See docs/CONTROLNET.md.
 */
import type { NodeDef, ParamDef, PassContext } from '../../core/types';

export default [] as NodeDef[];

export const CONTROL_COLOR = '#e0a040';
export const CATEGORY = 'ControlNet';

/** controlnet_aux `resize_image`: short side → `res`, both sides rounded to a multiple of 64 (min 64). */
export function detectDims(w: number, h: number, res: number): [number, number] {
  const k = res / Math.max(1, Math.min(w, h));
  const r = (v: number) => Math.max(64, Math.round((v * k) / 64) * 64);
  return [r(w), r(h)];
}

/** The A1111 "Preprocessor resolution" param. */
export const resolutionParam = (def = 512): ParamDef => ({
  type: 'int',
  default: def,
  min: 64,
  max: 2048,
  step: 64,
  label: 'Detect resolution',
  description: 'Short side the map is computed at (rounded to multiples of 64, like the A1111 / ComfyUI preprocessors), then resized to the output.',
});

/** Pass size callback: the detect resolution of this node's output aspect. */
export const detectSize = (key = 'resolution') => (c: PassContext): [number, number] => detectDims(c.width, c.height, Number(c.params[key]) || 512);

/** Pass body: the input area-averaged (4×4 taps per output texel) to this pass's size, as RGB 0..1. */
export const AREA_DOWN_FRAG = /* glsl */ `
void main() {
  vec2 r = u_image_size / u_resolution;
  vec3 acc = vec3(0.0);
  if (r.x <= 1.0 && r.y <= 1.0) acc = texture(u_image, v_uv).rgb * 16.0;
  else for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) {
    vec2 o = (vec2(float(i), float(j)) + 0.5) / 4.0 - 0.5;
    acc += texture(u_image, v_uv + o / u_resolution).rgb;
  }
  fragColor = vec4(clamp(acc / 16.0, 0.0, 1.0), 1.0);
}`;

/** Final pass: grey map from the r channel of `src` (bilinear resize to the output size, like cv2.INTER_LINEAR). */
export const greyOut = (src: string) => /* glsl */ `
void main() { fragColor = vec4(vec3(clamp(texture(${src}, v_uv).r, 0.0, 1.0)), 1.0); }`;

/** controlnet_aux `safe_step(x, step=2)`: quantise a soft map to 3 levels (HED/PiDiNet "safe"). */
export const SAFE_STEP_GLSL = /* glsl */ `
float safeStep(float x) { return min(floor(clamp(x, 0.0, 1.0) * 3.0) / 2.0, 1.0); }`;

/** Separable gaussian blur pass of `u_prev` (r channel), sigma `sigmaExpr` in texels of this pass. */
export const gaussPass = (vertical: boolean, sigmaExpr: string) => /* glsl */ `
void main() {
  float sig = max(${sigmaExpr}, 0.0);
  if (sig < 0.3) { fragColor = texture(u_prev, v_uv); return; }
  int n = int(min(ceil(sig * 3.0), 32.0));
  vec2 dir = ${vertical ? 'vec2(0.0, 1.0)' : 'vec2(1.0, 0.0)'} / u_resolution;
  vec4 acc = vec4(0.0); float ws = 0.0;
  for (int i = -32; i <= 32; i++) {
    if (i < -n || i > n) continue;
    float x = float(i);
    float w = exp(-x * x / (2.0 * sig * sig));
    acc += texClamp(u_prev, v_uv + dir * x) * w; ws += w;
  }
  fragColor = acc / ws;
}`;
