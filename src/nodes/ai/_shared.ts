/**
 * Shared GLSL for the AI nodes: a low-res guide image (box-downsampled input at the inference
 * resolution) and joint bilateral upsampling (Kopf et al. 2007) of a low-res model output against the
 * full-res image, so depth/matte edges snap to image edges.
 * Exports an empty NodeDef[] so the auto-registration glob is satisfied.
 */
import type { NodeDef } from '../../core/types';

export default [] as NodeDef[];

export const AI_COLOR = '#c58bff';

/** Pass body: output = input box-averaged to this pass's (low) resolution. */
export const GUIDE_FRAG = /* glsl */ `
void main() {
  vec3 acc = vec3(0.0);
  for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) {
    vec2 o = (vec2(float(i), float(j)) + 0.5) / 4.0 - 0.5;
    acc += texture(u_image, v_uv + o / u_resolution).rgb;
  }
  fragColor = vec4(acc / 16.0, 1.0);
}`;

/**
 * jbu(lr, guideLr, edges, smoothK): low-res value (r channel of `lr`) upsampled to this pixel.
 * edges 0..1: 0 = plain gaussian upsample, 1 = edges follow the image strongly.
 * smoothK 0..1: spatial sigma in low-res texels (0.5..1.7).
 */
export const JBU_GLSL = /* glsl */ `
float jbu(sampler2D lr, vec2 lrSize, sampler2D guideLr, float edges, float smoothK) {
  vec2 p = v_uv * lrSize - 0.5;
  vec2 b = floor(p);
  vec3 g = texture(u_image, v_uv).rgb;
  float sigS = 0.5 + smoothK * 1.2;
  float sigR = mix(0.6, 0.035, clamp(edges, 0.0, 1.0));
  float acc = 0.0, ws = 0.0, accS = 0.0, wsS = 0.0;
  for (int j = -2; j <= 3; j++) for (int i = -2; i <= 3; i++) {
    vec2 q = clamp(b + vec2(float(i), float(j)), vec2(0.0), lrSize - 1.0);
    vec2 uvq = (q + 0.5) / lrSize;
    float v = texture(lr, uvq).r;
    vec3 gq = texture(guideLr, uvq).rgb;
    vec2 d = p - q;
    float wS = exp(-dot(d, d) / (2.0 * sigS * sigS));
    vec3 dg = g - gq;
    float wR = exp(-dot(dg, dg) / (2.0 * sigR * sigR));
    acc += v * wS * wR; ws += wS * wR;
    accS += v * wS; wsS += wS;
  }
  float spatial = accS / max(wsS, 1e-6);
  // where no low-res neighbour resembles this pixel, fall back to the spatial estimate
  return ws > 1e-4 ? mix(spatial, acc / ws, clamp(ws * 50.0, 0.0, 1.0)) : spatial;
}`;

/** jbu4(lr, guideLr, edges, smoothK): like jbu() for all four channels of `lr` (normals + mask, colour…). */
export const JBU4_GLSL = /* glsl */ `
vec4 jbu4(sampler2D lr, vec2 lrSize, sampler2D guideLr, float edges, float smoothK) {
  vec2 p = v_uv * lrSize - 0.5;
  vec2 b = floor(p);
  vec3 g = texture(u_image, v_uv).rgb;
  float sigS = 0.5 + smoothK * 1.2;
  float sigR = mix(0.6, 0.035, clamp(edges, 0.0, 1.0));
  vec4 acc = vec4(0.0), accS = vec4(0.0);
  float ws = 0.0, wsS = 0.0;
  for (int j = -2; j <= 3; j++) for (int i = -2; i <= 3; i++) {
    vec2 q = clamp(b + vec2(float(i), float(j)), vec2(0.0), lrSize - 1.0);
    vec2 uvq = (q + 0.5) / lrSize;
    vec4 v = texture(lr, uvq);
    vec3 gq = texture(guideLr, uvq).rgb;
    vec2 d = p - q;
    float wS = exp(-dot(d, d) / (2.0 * sigS * sigS));
    vec3 dg = g - gq;
    float wR = exp(-dot(dg, dg) / (2.0 * sigR * sigR));
    acc += v * wS * wR; ws += wS * wR;
    accS += v * wS; wsS += wS;
  }
  vec4 spatial = accS / max(wsS, 1e-6);
  return ws > 1e-4 ? mix(spatial, acc / ws, clamp(ws * 50.0, 0.0, 1.0)) : spatial;
}`;
