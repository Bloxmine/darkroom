/**
 * Low-light enhancement with Zero-DCE: the tiny DCE-Net predicts 8 per-pixel RGB curve parameters at a
 * low resolution (Zero-DCE++ style); the curves are upsampled and applied to the full-res image in a shader.
 */
import { fingerprint, fitDims, InferenceMemo, resampleRGB, toCHW } from '../../core/ai/image';
import { runModel } from '../../core/ai/runtime';
import { defineNode } from '../../core/registry';
import type { NodeDef, Params, RawTex } from '../../core/types';
import { planesTex } from './_img';
import { AI_COLOR } from './_shared';

const memo = new InferenceMemo<RawTex[]>(6);
const dimsOf = (p: Params, w: number, h: number) => fitDims(w, h, Number(p.resolution) || 384, 1);
const KEYS = ['c0', 'c1', 'c2', 'c3', 'c4', 'c5'];

const lowLight = defineNode({
  id: 'ai.lowLight',
  name: 'Low-Light Enhance',
  category: 'AI',
  color: AI_COLOR,
  description:
    'Brightens dark and underexposed photos with Zero-DCE (Zero-Reference Deep Curve Estimation): a tiny network (~0.3 MB) estimates a per-pixel tone curve, ' +
    'applied 8 times like a curves adjustment, so shadows lift strongly while highlights stay unclipped. ' +
    'Curves are estimated at a low resolution and applied at full resolution (Zero-DCE++ style). Pair with Denoise for night shots.',
  tags: ['low light', 'night', 'dark', 'underexposed', 'brighten', 'shadows', 'exposure', 'zero-dce', 'curve', 'ai', 'ml', 'enhance'],
  inputs: { image: { type: 'image', label: 'Image' } },
  params: {
    strength: { type: 'float', default: 1, min: 0, max: 2, step: 0.01, label: 'Strength', description: 'Scales the estimated curves (1 = as predicted).' },
    exposure: { type: 'float', default: 0, min: -3, max: 3, step: 0.01, label: 'Exposure (EV)', description: 'Exposure correction after the curves.' },
    saturation: { type: 'float', default: 1, min: 0, max: 2, step: 0.01, label: 'Saturation', description: 'Zero-DCE tends to over-saturate; pull back here.' },
    iterations: { type: 'int', default: 8, min: 1, max: 8, step: 1, label: 'Iterations', description: 'How many of the 8 curve passes to apply.' },
    resolution: {
      type: 'enum',
      default: '384',
      options: ['192', '256', '384', '512', '768'],
      label: 'Inference size',
      description: 'Short side for the curve estimation. Smaller = smoother, more global curves.',
    },
  },
  cpuReadsInputs: true,
  cpu: async (ctx) => {
    const src = ctx.readInput('image');
    const zero = { width: 1, height: 1, data: new Float32Array(4) };
    if (!src) return Object.fromEntries(KEYS.map((k) => [k, zero]));
    const [w, h] = dimsOf(ctx.params, src.width, src.height);
    const rgb = resampleRGB(src.data, src.width, src.height, w, h);
    const maps = await memo.get(`zdce:${w}x${h}`, fingerprint(rgb, w, h), Math.min(src.width, src.height), Math.min(w, h), async () => {
      const r = await runModel('zero-dce', { data: toCHW(rgb, w, h, [0, 0, 0], [1, 1, 1]), dims: [1, 3, h, w] });
      const [oh, ow] = r.dims.slice(-2);
      return KEYS.map((_, k) => planesTex(r.data, 4, ow, oh, k * 4));
    });
    return Object.fromEntries(KEYS.map((k, i) => [k, maps[i]]));
  },
  passes: [
    {
      frag: /* glsl */ `
void main() {
  vec4 src = texture(u_image, v_uv);
  if (u_c0_size.x < 2.0) { fragColor = src; return; }
  vec4 t[6] = vec4[6](texture(u_c0, v_uv), texture(u_c1, v_uv), texture(u_c2, v_uv), texture(u_c3, v_uv), texture(u_c4, v_uv), texture(u_c5, v_uv));
  float a[24];
  for (int i = 0; i < 6; i++) { a[i * 4] = t[i].x; a[i * 4 + 1] = t[i].y; a[i * 4 + 2] = t[i].z; a[i * 4 + 3] = t[i].w; }
  vec3 x = clamp(src.rgb, 0.0, 1.0);
  for (int i = 0; i < 8; i++) {
    if (i >= u_iterations) break;
    vec3 r = vec3(a[i * 3], a[i * 3 + 1], a[i * 3 + 2]) * u_strength;
    x = x + r * (x * x - x);
  }
  x = clamp(x, 0.0, 1.0);
  if (u_exposure != 0.0) x = linearToSrgb(srgbToLinear(x) * exp2(u_exposure));
  x = mix(vec3(luma(x)), x, u_saturation);
  fragColor = vec4(clamp(x, 0.0, 1.0), src.a);
}`,
    },
  ],
});

export default [lowLight] satisfies NodeDef[];
