/**
 * Select by Text: open-vocabulary detection (OWLv2 / OWL-ViT) finds the objects a text prompt names, and SAM turns
 * each box into a mask. The image is encoded once per image (OWL and SAM both memoised by fingerprint); a new prompt
 * only runs OWL's text tower and SAM's prompt decoder.
 */
import '../../core/ai/models-vl';
import { maskTex } from '../../core/ai/image';
import { KEEP_MODES, parsePrompts, selectDetections, type Detection } from '../../core/ai/vl/boxes';
import { OWL_MODELS, owlDetect, owlImage } from '../../core/ai/vl/owl';
import { defineNode } from '../../core/registry';
import type { NodeDef } from '../../core/types';
import { AI_COLOR, GUIDE_FRAG, JBU_GLSL } from './_shared';
import { featherPass, RAMP_GLSL } from './segment-shared';
import { samLowRes } from './segment-sam';
import { BLACK, boxMask, CLEAR, OVERLAY_FRAG, regionOverlay, samForBox, vlStatus } from './vl-draw';

const MODEL_NAMES = Object.keys(OWL_MODELS);

/** Detection for the current params (exported for the Caption node's grounding + tests in the harness). */
export async function detectByText(src: Parameters<typeof owlImage>[1], prompt: string, p: { model: string; threshold: number; max: number }, signal?: AbortSignal) {
  const parts = parsePrompts(prompt);
  if (!parts.length) return { parts, dets: [] as Detection[] };
  const model = OWL_MODELS[p.model] ?? 'owlv2';
  const img = await owlImage(model, src, signal);
  const dets = await owlDetect(model, img, parts.map((x) => x.text), { threshold: p.threshold, max: Math.max(p.max * 3, 10) });
  return { parts, dets };
}

const textSelect = defineNode({
  id: 'ai.textSelect',
  name: 'Select by Text',
  category: 'AI',
  color: AI_COLOR,
  description:
    'Type what to select (“red jacket, paddle”): OWLv2 finds the objects the words name, SAM traces each one. ' +
    'Separate several things with commas; a leading “-” removes that object from the selection. ' +
    'The image is analysed once (≈1–2 s on WebGPU); a new prompt then takes a fraction of a second. ' +
    'Outputs: mask (selected = white) and overlay (the image with the found boxes, labels and scores; dashed = found but not kept). ' +
    'First use downloads OWLv2 (155 MB) and SlimSAM (≈14–21 MB).',
  tags: ['text', 'prompt', 'open vocabulary', 'detect', 'detection', 'owl', 'owlv2', 'grounding', 'select', 'selection', 'mask', 'sam', 'segment', 'find', 'ai', 'ml'],
  inputs: { image: { type: 'image', label: 'Image' } },
  outputs: { mask: { type: 'mask', label: 'Mask' }, overlay: { type: 'image', label: 'Overlay' } },
  params: {
    prompt: { type: 'string', default: 'person', label: 'Prompt', description: 'What to select. Commas separate objects; “-thing” subtracts it.' },
    threshold: { type: 'float', default: 0.1, min: 0.01, max: 0.9, step: 0.01, label: 'Box threshold', description: 'Minimum detection confidence. Lower finds more (and more false hits).' },
    maxObjects: { type: 'int', default: 6, min: 1, max: 24, step: 1, label: 'Max objects' },
    keep: { type: 'enum', default: KEEP_MODES[0], options: KEEP_MODES, label: 'Keep', description: 'All matches, only the most confident one, or the nth most confident.' },
    nth: { type: 'int', default: 1, min: 1, max: 24, step: 1, label: 'N', description: 'Which match “Nth match” keeps (1 = best).' },
    refine: { type: 'bool', default: true, label: 'Refine with SAM', description: 'Trace each box with Segment Anything. Off = the boxes themselves.' },
    threshold2: { type: 'float', default: 0.5, min: 0.01, max: 0.99, step: 0.005, label: 'Mask threshold' },
    softness: { type: 'float', default: 0.15, min: 0, max: 1, step: 0.005, label: 'Edge softness' },
    edges: { type: 'float', default: 0.8, min: 0, max: 1, step: 0.01, label: 'Edge refine', description: 'Edge-aware upsampling against the image.' },
    feather: { type: 'float', default: 0, min: 0, max: 100, step: 0.5, pixels: true, label: 'Feather' },
    invert: { type: 'bool', default: false, label: 'Invert (select the rest)' },
    model: { type: 'enum', default: MODEL_NAMES[0], options: MODEL_NAMES, label: 'Detector', description: 'OWLv2 B/16 (960², better recall) or OWL-ViT B/32 (768², ~8× less compute, misses thin / small things).' },
    tint: { type: 'color', default: [1, 0.3, 0.55, 0.4], label: 'Overlay tint', description: 'Colour of the selection in the overlay (alpha = strength).' },
  },
  cpuReadsInputs: true,
  cpu: async (ctx) => {
    const src = ctx.readInput('image');
    const prompt = String(ctx.params.prompt ?? '');
    if (!src || !parsePrompts(prompt).length) return { lr: BLACK, ov: CLEAR };
    const p = ctx.params;
    const max = Math.max(1, Number(p.maxObjects) || 6);
    const { parts, dets } = await detectByText(src, prompt, { model: String(p.model), threshold: Number(p.threshold), max }, ctx.signal);
    const pos = dets.filter((d) => !parts[d.label].negative);
    const neg = dets.filter((d) => parts[d.label].negative).slice(0, max);
    const kept = selectDetections(pos, String(p.keep), Number(p.nth)).slice(0, max);
    const masks = async (list: Detection[]) => {
      if (!p.refine) return [boxMask(src, list.map((d) => d.box))];
      const out = [];
      for (const d of list) out.push(await samForBox(src, d.box, ctx.signal));
      return out;
    };
    const [mp, mn] = await Promise.all([masks(kept), masks(neg)]);
    let lr = BLACK;
    if (mp.length) {
      const { w, h } = mp[0];
      const u = new Float32Array(w * h);
      for (const m of mp) for (let i = 0; i < u.length; i++) u[i] = Math.max(u[i], m.data[i]);
      for (const m of mn) for (let i = 0; i < u.length; i++) u[i] *= 1 - m.data[i];
      lr = maskTex(u, w, h);
    }
    const shown = new Set(kept);
    const regions = [...pos.slice(0, Math.max(max, kept.length)), ...neg].map((d) => ({
      box: d.box,
      label: (parts[d.label].negative ? '−' : '') + d.text,
      score: d.score,
      selected: shown.has(d) || neg.includes(d),
      group: d.label,
    }));
    vlStatus(
      kept.length
        ? `Select by Text: ${kept.length} of ${pos.length} match${pos.length === 1 ? '' : 'es'} for “${prompt}” (best ${(kept[0].score * 100).toFixed(0)}%).`
        : `Select by Text: nothing found for “${prompt}” above ${Number(p.threshold).toFixed(2)}. Try a lower box threshold or other words.`,
    );
    return { lr, ov: regionOverlay(src.width, src.height, regions) };
  },
  passes: [
    { size: (c) => samLowRes(c.width, c.height), frag: GUIDE_FRAG },
    {
      frag: /* glsl */ `
${JBU_GLSL}
${RAMP_GLSL}
uniform float u_edge;
void main() {
  float m = u_edge <= 0.0 ? texture(u_lr, v_uv).r : jbu(u_lr, u_lr_size, u_pass0, u_edge, 0.15);
  fragColor = vec4(vec3(ramp(m, u_threshold2, u_softness)), 1.0);
}`,
      uniforms: (c) => ({ u_edge: c.params.refine ? Number(c.params.edges) : 0 }),
    },
    { frag: featherPass(false) },
    { frag: featherPass(true), output: 'mask' },
    { output: 'overlay', frag: OVERLAY_FRAG },
  ],
});

export default [textSelect] satisfies NodeDef[];
