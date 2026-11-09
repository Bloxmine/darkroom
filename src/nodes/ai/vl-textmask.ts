/**
 * Text Mask (CLIPSeg): soft, region-level masks from words (“sky”, “water”, “skin”, “shadows on the wall”).
 * Several prompts are combined: “sky, water” = union, “trees, -sky” = trees minus sky. The 352² prediction is
 * upsampled edge-aware (joint bilateral) and then matted against the image with a guided filter (He et al. 2010).
 */
import '../../core/ai/models-vl';
import { maskTex } from '../../core/ai/image';
import { parsePrompts } from '../../core/ai/vl/boxes';
import { clipsegImage, clipsegMask, combineMasks, SEG_SIZE } from '../../core/ai/vl/clipseg';
import { defineNode } from '../../core/registry';
import type { NodeDef, ShaderPass } from '../../core/types';
import { AI_COLOR, GUIDE_FRAG, JBU_GLSL } from './_shared';
import { featherPass, RAMP_GLSL } from './segment-shared';
import { BLACK, vlStatus } from './vl-draw';

/** Box mean over a (2r+1) window, r = u_radius px (scale-aware), all four channels. */
function boxPass(vertical: boolean): ShaderPass {
  return {
    frag: /* glsl */ `
void main() {
  float r = max(1.0, u_radius * u_scale);
  int n = int(min(ceil(r), 32.0));
  float stp = r / float(n);
  vec2 dir = ${vertical ? 'vec2(0.0, 1.0)' : 'vec2(1.0, 0.0)'} / u_resolution;
  vec4 acc = vec4(0.0);
  for (int i = -32; i <= 32; i++) {
    if (i < -n || i > n) continue;
    acc += texClamp(u_prev, v_uv + dir * float(i) * stp);
  }
  fragColor = acc / float(2 * n + 1);
}`,
  };
}

const textMask = defineNode({
  id: 'ai.textMask',
  name: 'Text Mask (CLIPSeg)',
  category: 'AI',
  color: AI_COLOR,
  description:
    'A soft mask of whatever the words describe — stuff and regions rather than single objects: “sky”, “water”, “skin”, “shadows on the wall”. ' +
    'Commas combine prompts (union); a leading “-” subtracts one (“trees, -sky”). CLIPSeg (Apache-2.0, 139 MB, downloads once) predicts at 352×352, ' +
    'then the mask is snapped to the image edges (joint bilateral upsampling + guided-filter matting). The image is encoded once; each new prompt takes ≈0.1 s. ' +
    'For a crisp mask of one object, use Select by Text.',
  tags: ['text', 'prompt', 'clipseg', 'clip', 'region', 'mask', 'segment', 'semantic', 'sky', 'water', 'skin', 'select', 'ai', 'ml'],
  inputs: { image: { type: 'image', label: 'Image' } },
  outputs: { mask: { type: 'mask', label: 'Mask' } },
  params: {
    prompt: { type: 'string', default: 'sky', label: 'Prompt', description: 'What to mask. Commas = union; “-thing” subtracts it.' },
    normalize: { type: 'bool', default: true, label: 'Normalise', description: 'Stretch each prompt’s map to its own maximum (CLIPSeg is often unsure on photos).' },
    subtract: { type: 'float', default: 1, min: 0, max: 2, step: 0.01, label: 'Subtract strength', description: 'How strongly “-” prompts remove.' },
    threshold: { type: 'float', default: 0.4, min: 0.01, max: 0.99, step: 0.005, label: 'Threshold' },
    softness: { type: 'float', default: 0.4, min: 0, max: 1, step: 0.005, label: 'Softness' },
    edges: { type: 'float', default: 0.85, min: 0, max: 1, step: 0.01, label: 'Edge snap', description: 'Edge-aware upsampling of the 352² prediction.' },
    refine: { type: 'float', default: 0.8, min: 0, max: 1, step: 0.01, label: 'Refine (matting)', description: 'Guided-filter matting against the image luminance.' },
    radius: { type: 'float', default: 16, min: 1, max: 60, step: 0.5, pixels: true, label: 'Refine radius' },
    eps: { type: 'float', default: 0.002, min: 0.0001, max: 0.05, step: 0.0001, label: 'Refine edge tolerance' },
    feather: { type: 'float', default: 0, min: 0, max: 100, step: 0.5, pixels: true, label: 'Feather' },
    invert: { type: 'bool', default: false, label: 'Invert' },
  },
  cpuReadsInputs: true,
  cpu: async (ctx) => {
    const src = ctx.readInput('image');
    const parts = parsePrompts(String(ctx.params.prompt ?? ''));
    if (!src || !parts.some((p) => !p.negative)) return { lr: BLACK };
    const img = await clipsegImage(src, ctx.signal);
    const maps: Float32Array[] = [];
    for (const p of parts) maps.push(await clipsegMask(img, p.text));
    const n = SEG_SIZE * SEG_SIZE;
    const peaks = maps.map((m) => m.reduce((a, b) => Math.max(a, b), 0));
    const norm = maps.map((m, i) => (ctx.params.normalize && !parts[i].negative && peaks[i] > 0.02 ? m.map((v) => v / peaks[i]) : m));
    const out = combineMasks(
      norm.filter((_, i) => !parts[i].negative),
      norm.filter((_, i) => parts[i].negative),
      n,
      Number(ctx.params.subtract ?? 1),
    );
    vlStatus(`Text Mask: ${parts.map((p, i) => `${p.negative ? '−' : ''}${p.text} (peak ${(peaks[i] * 100).toFixed(0)}%)`).join(', ')}.`);
    return { lr: maskTex(out, SEG_SIZE, SEG_SIZE) };
  },
  passes: [
    { size: () => [SEG_SIZE, SEG_SIZE], frag: GUIDE_FRAG },
    {
      frag: /* glsl */ `
${JBU_GLSL}
${RAMP_GLSL}
void main() {
  float m = u_edges <= 0.0 ? texture(u_lr, v_uv).r : jbu(u_lr, u_lr_size, u_pass0, u_edges, 0.9);
  m = ramp(m, u_threshold, u_softness);
  float I = luma601(clamp(texture(u_image, v_uv).rgb, 0.0, 1.0));
  fragColor = vec4(I, m, I * m, I * I);
}`,
    },
    boxPass(false),
    boxPass(true),
    {
      frag: /* glsl */ `
void main() {
  vec4 m = texture(u_prev, v_uv);
  float varI = max(m.w - m.x * m.x, 0.0);
  float a = (m.z - m.x * m.y) / (varI + u_eps);
  fragColor = vec4(a, m.y - a * m.x, 0.0, 1.0);
}`,
    },
    boxPass(false),
    boxPass(true),
    {
      frag: /* glsl */ `
void main() {
  vec4 ab = texture(u_prev, v_uv);
  vec4 g = texture(u_pass1, v_uv);
  float q = clamp(ab.x * g.x + ab.y, 0.0, 1.0);
  fragColor = vec4(vec3(mix(g.y, q, u_refine)), 1.0);
}`,
    },
    { frag: featherPass(false) },
    { frag: featherPass(true) },
  ],
});

export default [textMask] satisfies NodeDef[];
