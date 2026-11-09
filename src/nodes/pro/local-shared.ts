/**
 * Shared pieces of the local-adjustment nodes (graduated / radial filter, dodge & burn):
 * the Lightroom-style adjustment set (exposure, temperature, tint, contrast, highlights, shadows,
 * saturation, clarity) applied with a per-pixel weight, and the quarter-resolution blur passes that
 * clarity uses (radius relative to the image height, so preview and export match).
 */
import type { NodeDef, ParamDef, PassContext, ShaderPass } from '../../core/types';

export default [] as NodeDef[];

export const ADJ_PARAMS: Record<string, ParamDef> = {
  exposure: { type: 'float', default: 0, min: -4, max: 4, step: 0.01, label: 'Exposure (EV)' },
  temperature: { type: 'float', default: 0, min: -1, max: 1, step: 0.01, label: 'Temperature', description: '− cooler / + warmer.' },
  tint: { type: 'float', default: 0, min: -1, max: 1, step: 0.01, label: 'Tint', description: '− green / + magenta.' },
  contrast: { type: 'float', default: 0, min: -1, max: 1, step: 0.01, label: 'Contrast' },
  highlights: { type: 'float', default: 0, min: -1, max: 1, step: 0.01, label: 'Highlights' },
  shadows: { type: 'float', default: 0, min: -1, max: 1, step: 0.01, label: 'Shadows' },
  saturation: { type: 'float', default: 0, min: -1, max: 1, step: 0.01, label: 'Saturation' },
  clarity: { type: 'float', default: 0, min: -1, max: 1, step: 0.01, label: 'Clarity', description: 'Local midtone contrast (− softens).' },
};

/** Adjustment params with other defaults (keeps the shared ranges/labels). */
export function adjParams(defaults: Partial<Record<keyof typeof ADJ_PARAMS, number>>): Record<string, ParamDef> {
  const o: Record<string, ParamDef> = {};
  for (const [k, p] of Object.entries(ADJ_PARAMS)) o[k] = { ...p, default: defaults[k] ?? p.default };
  return o;
}

/** Separable gaussian (σ ≈ 1.2 % of the image height) at quarter resolution: two passes. */
export function blurPasses(src = 'u_image'): ShaderPass[] {
  const size = (c: PassContext): [number, number] => [Math.max(1, Math.round(c.width / 4)), Math.max(1, Math.round(c.height / 4))];
  const pass = (dir: string, tex: string): ShaderPass => ({
    size,
    frag: /* glsl */ `
void main() {
  // sigma in output texels: 1.2 % of the height at quarter resolution (scale independent)
  float sigma = max(0.012 * u_resolution.y, 0.6);
  vec2 d = ${dir} / u_resolution;
  vec3 acc = vec3(0.0); float ws = 0.0;
  for (int i = -12; i <= 12; i++) {
    float x = float(i) * sigma / 4.0;
    float w = exp(-0.5 * x * x / (sigma * sigma));
    acc += texture(${tex}, v_uv + d * x).rgb * w; ws += w;
  }
  fragColor = vec4(acc / ws, 1.0);
}`,
  });
  return [pass('vec2(1.0, 0.0)', src), pass('vec2(0.0, 1.0)', 'u_prev')];
}

/**
 * `vec3 localAdjust(vec3 c, vec3 blur, float w)`: sRGB in/out; w = effect weight 0..1.
 * Needs the ADJ_PARAMS uniforms.
 */
export const GLSL_ADJUST = /* glsl */ `
vec3 localAdjust(vec3 c, vec3 blur, float w) {
  if (w <= 0.0) return c;
  vec3 lin = srgbToLinear(max(c, 0.0));
  // exposure + white balance in linear light (temperature: blue↔amber, tint: green↔magenta)
  vec3 wb = vec3(1.0 + 0.25 * u_temperature, 1.0, 1.0 - 0.25 * u_temperature) * vec3(1.0 + 0.12 * u_tint, 1.0 - 0.18 * u_tint, 1.0 + 0.12 * u_tint);
  wb /= dot(wb, vec3(0.2126, 0.7152, 0.0722));
  lin *= exp2(u_exposure * w) * mix(vec3(1.0), wb, w);
  vec3 s = linearToSrgb(lin);
  float L = luma(clamp(s, 0.0, 1.0));
  // highlights / shadows: tonal masks
  float hi = smoothstep(0.45, 1.0, L), sh = 1.0 - smoothstep(0.0, 0.55, L);
  s += w * (u_highlights * 0.35 * hi * (u_highlights < 0.0 ? L : 1.0 - L) + u_shadows * 0.35 * sh * (u_shadows > 0.0 ? (1.0 - L) : L));
  // contrast: S-curve around mid grey
  float k = u_contrast * w;
  if (k > 0.0) s += k * 1.6 * (s - 0.5) * (1.0 - abs(2.0 * clamp(s, 0.0, 1.0) - 1.0));
  else if (k < 0.0) s = mix(s, vec3(0.5), -k * 0.5);
  // clarity: midtone-weighted local contrast against the blurred image
  vec3 bl = linearToSrgb(srgbToLinear(max(blur, 0.0)) * exp2(u_exposure * w));
  float mid = 1.0 - pow(abs(2.0 * L - 1.0), 2.0);
  s += (s - bl) * u_clarity * w * 0.9 * mid;
  // saturation
  float Y = luma(s);
  s = mix(vec3(Y), s, 1.0 + u_saturation * w);
  return s;
}`;
