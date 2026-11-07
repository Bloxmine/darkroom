/** Black & white → colour with DDColor: chroma (Lab ab) predicted at 512², luminance kept at full resolution. */
import { fingerprint, InferenceMemo, resampleRGB } from '../../core/ai/image';
import { runModel } from '../../core/ai/runtime';
import { defineNode } from '../../core/registry';
import type { NodeDef, RawTex } from '../../core/types';
import { isFlat, planesTex } from './_img';
import { AI_COLOR } from './_shared';

const S = 512; // the export's fixed input size
const memo = new InferenceMemo<RawTex>(6);

const lin2srgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const srgb2lin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/** CIE Lab (D65, OpenCV's float convention, as DDColor was trained) in GLSL. */
export const LAB_GLSL = /* glsl */ `
float labF(float t) { return t > 0.008856 ? pow(t, 1.0 / 3.0) : 7.787 * t + 16.0 / 116.0; }
float labFi(float t) { return t > 0.206893 ? t * t * t : (t - 16.0 / 116.0) / 7.787; }
float labL(vec3 srgb) {
  vec3 l = srgbToLinear(clamp(srgb, 0.0, 1.0));
  float y = dot(l, vec3(0.212671, 0.715160, 0.072169));
  return y > 0.008856 ? 116.0 * pow(y, 1.0 / 3.0) - 16.0 : 903.3 * y;
}
vec3 lab2srgb(vec3 lab) {
  float fy = (lab.x + 16.0) / 116.0;
  float fx = fy + lab.y / 500.0, fz = fy - lab.z / 200.0;
  vec3 xyz = vec3(labFi(fx) * 0.950456, labFi(fy), labFi(fz) * 1.088754);
  vec3 l = vec3(
    dot(xyz, vec3(3.240479, -1.537150, -0.498535)),
    dot(xyz, vec3(-0.969256, 1.875992, 0.041556)),
    dot(xyz, vec3(0.055648, -0.204043, 1.057311)));
  return linearToSrgb(clamp(l, 0.0, 1.0));
}`;

const colorize = defineNode({
  id: 'ai.colorize',
  name: 'Colorize B&W',
  category: 'AI',
  color: AI_COLOR,
  description:
    'Turns a black & white photo into colour with DDColor (ICCV 2023, tiny model, ~135 MB, runs locally and downloads once). ' +
    'The network predicts only the chroma (Lab a/b) at 512×512; it is upsampled edge-aware and combined with the full-resolution luminance, so no detail is lost. ' +
    'Works on colour input too (it uses only the luminance). Cached per image: saturation/blend changes are instant.',
  tags: ['colorize', 'colourise', 'colorization', 'black and white', 'b&w', 'old photo', 'restore', 'ddcolor', 'ai', 'ml', 'vintage', 'monochrome'],
  inputs: { image: { type: 'image', label: 'Image' } },
  params: {
    saturation: { type: 'float', default: 1, min: 0, max: 2.5, step: 0.01, label: 'Saturation', description: 'Scales the predicted colour (Lab a/b).' },
    amount: { type: 'float', default: 1, min: 0, max: 1, step: 0.01, label: 'Amount', description: 'Blend with the input.' },
    warmth: { type: 'float', default: 0, min: -20, max: 20, step: 0.1, label: 'Warmth', description: 'Shift of the predicted colours toward yellow (+) or blue (−), in Lab b units.' },
    edges: { type: 'float', default: 0.7, min: 0, max: 1, step: 0.01, label: 'Edge refine', description: 'Edge-aware upsampling of the colour against the luminance.' },
  },
  cpuReadsInputs: true,
  cpu: async (ctx) => {
    const src = ctx.readInput('image');
    if (!src) return { ab: { width: 1, height: 1, data: new Float32Array(4) } };
    const rgb = resampleRGB(src.data, src.width, src.height, S, S);
    // model input: grey RGB rebuilt from L (a = b = 0) = sRGB of the linear luminance
    const grey = new Float32Array(3 * S * S);
    const n = S * S;
    for (let i = 0; i < n; i++) {
      const y = 0.212671 * srgb2lin(rgb[i * 3]) + 0.71516 * srgb2lin(rgb[i * 3 + 1]) + 0.072169 * srgb2lin(rgb[i * 3 + 2]);
      grey[i] = grey[n + i] = grey[2 * n + i] = lin2srgb(Math.min(1, Math.max(0, y)));
    }
    const fp = fingerprint(rgb, S, S);
    if (isFlat(fp)) return { ab: { width: 1, height: 1, data: new Float32Array(4) } };
    const ab = await memo.get('ddcolor', fp, Math.min(src.width, src.height), S, async () => {
      const r = await runModel('ddcolor-tiny', { data: grey, dims: [1, 3, S, S] });
      const [h, w] = r.dims.slice(-2);
      return planesTex(r.data, 2, w, h);
    });
    return { ab };
  },
  passes: [
    {
      // luminance guide at the chroma resolution
      size: () => [S, S],
      frag: /* glsl */ `
void main() {
  float acc = 0.0;
  for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) {
    vec2 o = (vec2(float(i), float(j)) + 0.5) / 4.0 - 0.5;
    acc += luma(texture(u_image, v_uv + o / u_resolution).rgb);
  }
  fragColor = vec4(vec3(acc / 16.0), 1.0);
}`,
    },
    {
      frag: /* glsl */ `
${LAB_GLSL}
// joint bilateral upsampling of the 2-channel chroma against the luminance
vec2 jbuAb(float edges) {
  vec2 p = v_uv * u_ab_size - 0.5;
  vec2 b = floor(p);
  float g = luma(texture(u_image, v_uv).rgb);
  float sigR = mix(0.5, 0.04, clamp(edges, 0.0, 1.0));
  vec2 acc = vec2(0.0), accS = vec2(0.0);
  float ws = 0.0, wsS = 0.0;
  for (int j = -2; j <= 3; j++) for (int i = -2; i <= 3; i++) {
    vec2 q = clamp(b + vec2(float(i), float(j)), vec2(0.0), u_ab_size - 1.0);
    vec2 uvq = (q + 0.5) / u_ab_size;
    vec2 v = texture(u_ab, uvq).rg;
    float gq = texture(u_pass0, uvq).r;
    vec2 d = p - q;
    float wS = exp(-dot(d, d) / 1.28);
    float dg = g - gq;
    float wR = exp(-dg * dg / (2.0 * sigR * sigR));
    acc += v * wS * wR; ws += wS * wR;
    accS += v * wS; wsS += wS;
  }
  vec2 spatial = accS / max(wsS, 1e-6);
  return ws > 1e-4 ? mix(spatial, acc / ws, clamp(ws * 50.0, 0.0, 1.0)) : spatial;
}
void main() {
  vec4 src = texture(u_image, v_uv);
  if (u_ab_size.x < 2.0) { fragColor = src; return; }
  vec2 ab = u_edges > 0.0 ? jbuAb(u_edges) : texture(u_ab, v_uv).rg;
  ab = ab * u_saturation + vec2(0.0, u_warmth);
  vec3 c = lab2srgb(vec3(labL(src.rgb), ab));
  fragColor = vec4(mix(src.rgb, c, u_amount), src.a);
}`,
    },
  ],
});

export default [colorize] satisfies NodeDef[];
