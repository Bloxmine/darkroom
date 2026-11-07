/**
 * Shared bits for the selection nodes (segment-sam, segment-scene, paint): a separable gaussian
 * feather pass (pixel radius `u_feather`, scale-aware) that applies `u_invert` on its vertical half.
 * Exports an empty NodeDef[] for the auto-registration glob.
 */
import type { NodeDef } from '../../core/types';

export default [] as NodeDef[];

export function featherPass(vertical: boolean, invert = true) {
  return /* glsl */ `
void main() {
  float r = u_feather * u_scale;
  float m;
  if (r < 0.5) m = texture(u_prev, v_uv).r;
  else {
    int n = int(min(ceil(r), 48.0));
    float stp = r / float(n), sig = r * 0.5;
    vec2 dir = ${vertical ? 'vec2(0.0, 1.0)' : 'vec2(1.0, 0.0)'} / u_resolution;
    float acc = 0.0, ws = 0.0;
    for (int i = -48; i <= 48; i++) {
      if (i < -n || i > n) continue;
      float x = float(i) * stp;
      float w = exp(-x * x / (2.0 * sig * sig));
      acc += texClamp(u_prev, v_uv + dir * x).r * w; ws += w;
    }
    m = acc / ws;
  }
  ${vertical && invert ? 'if (u_invert) m = 1.0 - m;' : ''}
  fragColor = vec4(vec3(m), 1.0);
}`;
}

/** Soft threshold: 0..1 ramp of width `soft` centred on `t`. */
export const RAMP_GLSL = /* glsl */ `
float ramp(float m, float t, float soft) {
  float lo = t - soft * 0.5, hi = t + soft * 0.5;
  return clamp((m - lo) / max(hi - lo, 1e-3), 0.0, 1.0);
}`;
