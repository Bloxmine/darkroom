/**
 * Caption & OCR (Florence-2 base, MIT): describes the image, reads its text, detects objects, or grounds a phrase.
 * The text result is published to the Properties panel (src/core/nodeInfo.ts, with Copy / “Use as project name”);
 * regions are drawn on the `overlay` output, and detection / grounding boxes can become a SAM mask (`mask`).
 */
import '../../core/ai/models-vl';
import { maskTex } from '../../core/ai/image';
import { setAiTask } from '../../core/ai/runtime';
import { florenceImage, florenceRun } from '../../core/ai/vl/florence';
import { FLORENCE_TASKS, nameFromCaption, type FlorenceTask } from '../../core/ai/vl/florence-post';
import { setNodeInfo } from '../../core/nodeInfo';
import { defineNode } from '../../core/registry';
import type { NodeDef } from '../../core/types';
import { AI_COLOR, GUIDE_FRAG, JBU_GLSL } from './_shared';
import { samLowRes } from './segment-sam';
import { featherPass, RAMP_GLSL } from './segment-shared';
import { BLACK, boxMask, CLEAR, OVERLAY_FRAG, regionOverlay, samForBox, vlStatus } from './vl-draw';

let jobs = 0;

const caption = defineNode({
  id: 'ai.caption',
  name: 'Caption & OCR',
  category: 'AI',
  color: AI_COLOR,
  description:
    'Florence-2 (Microsoft, MIT, ≈275 MB, downloads once, runs locally) looks at the image and writes: a caption, a detailed description, the text in the image (OCR, optionally with regions), ' +
    'the objects it sees (with boxes), or where a phrase is (phrase grounding). The text appears below the parameters, with Copy and “Use as project name”. ' +
    'Outputs: the image unchanged (out), the image with the regions drawn (overlay), and a mask of the found boxes, traced with SAM (mask). ' +
    'Takes ≈2–10 s per answer on WebGPU machines (the decoder runs on the CPU); long OCR answers take longer.',
  tags: ['caption', 'describe', 'ocr', 'text recognition', 'read text', 'florence', 'vision language', 'vlm', 'detect', 'grounding', 'alt text', 'ai', 'ml'],
  inputs: { image: { type: 'image', label: 'Image' } },
  outputs: { out: { type: 'image', label: 'Image' }, overlay: { type: 'image', label: 'Overlay' }, mask: { type: 'mask', label: 'Mask' } },
  params: {
    task: { type: 'enum', default: FLORENCE_TASKS[0], options: [...FLORENCE_TASKS], label: 'Task' },
    phrase: { type: 'string', default: '', label: 'Phrase', description: 'Phrase grounding: what to find (“the paddle”, “a woman in an orange life jacket”).' },
    samMask: { type: 'bool', default: true, label: 'Mask with SAM', description: 'Detection / grounding: trace each box with Segment Anything for the mask output (off = filled boxes).' },
    threshold2: { type: 'float', default: 0.5, min: 0.01, max: 0.99, step: 0.005, label: 'Mask threshold' },
    softness: { type: 'float', default: 0.15, min: 0, max: 1, step: 0.005, label: 'Edge softness' },
    edges: { type: 'float', default: 0.8, min: 0, max: 1, step: 0.01, label: 'Edge refine' },
    feather: { type: 'float', default: 0, min: 0, max: 100, step: 0.5, pixels: true, label: 'Feather' },
    invert: { type: 'bool', default: false, label: 'Invert mask' },
    tint: { type: 'color', default: [0.25, 0.85, 1, 0.3], label: 'Overlay tint' },
  },
  cpuReadsInputs: true,
  cpu: async (ctx) => {
    const src = ctx.readInput('image');
    if (!src) {
      setNodeInfo(ctx.nodeId, null);
      return { lr: BLACK, ov: CLEAR };
    }
    const task = String(ctx.params.task) as FlorenceTask;
    const phrase = String(ctx.params.phrase ?? '');
    const id = `vl${++jobs}`;
    setAiTask(id, { label: `Florence-2: ${task}…`, done: 0, total: 1 });
    try {
      const feat = await florenceImage(src, ctx.signal);
      const r = await florenceRun(feat, task, phrase, ctx.signal, (n) => setAiTask(id, { label: `Florence-2: ${task} (${n} tokens)`, done: 0, total: 1 }));
      const isCaption = task === 'Caption';
      setNodeInfo(ctx.nodeId, {
        title: task === 'Phrase grounding' ? `Phrase grounding: “${phrase || 'the main subject'}”` : task,
        text: r.text || (r.regions.length ? '' : '(nothing)'),
        detail: `${r.regions.length ? `${r.regions.length} region${r.regions.length === 1 ? '' : 's'} · ` : ''}${r.tokens} tokens · ${(r.ms / 1000).toFixed(1)} s`,
        suggestName: isCaption ? nameFromCaption(r.text) || undefined : undefined,
      });
      vlStatus(`Caption & OCR (${task}): ${r.text.slice(0, 120).replace(/\n/g, ' · ') || '(no text)'}`);
      const boxes = r.regions.filter((x) => x.box).map((x) => x.box!);
      let lr = BLACK;
      if (boxes.length) {
        const ms = ctx.params.samMask ? await Promise.all(boxes.slice(0, 16).map((b) => samForBox(src, b, ctx.signal))) : [boxMask(src, boxes)];
        const u = new Float32Array(ms[0].w * ms[0].h);
        for (const m of ms) for (let i = 0; i < u.length; i++) u[i] = Math.max(u[i], m.data[i]);
        lr = maskTex(u, ms[0].w, ms[0].h);
      }
      const labels = [...new Set(r.regions.map((x) => x.label))];
      return { lr, ov: regionOverlay(src.width, src.height, r.regions.map((x) => ({ ...x, group: labels.indexOf(x.label) }))) };
    } finally {
      setAiTask(id, null);
    }
  },
  passes: [
    { output: 'out', frag: `void main() { fragColor = texture(u_image, v_uv); }` },
    { size: (c) => samLowRes(c.width, c.height), frag: GUIDE_FRAG },
    {
      frag: /* glsl */ `
${JBU_GLSL}
${RAMP_GLSL}
void main() {
  float m = u_edges <= 0.0 ? texture(u_lr, v_uv).r : jbu(u_lr, u_lr_size, u_pass1, u_edges, 0.15);
  fragColor = vec4(vec3(ramp(m, u_threshold2, u_softness)), 1.0);
}`,
    },
    { frag: featherPass(false) },
    { frag: featherPass(true), output: 'mask' },
    {
      output: 'overlay',
      // the selection tint only for phrase grounding (detection boxes often cover the whole frame)
      frag: 'uniform float u_tintOn;\n' + OVERLAY_FRAG.replace('m * u_tint.a', 'm * u_tint.a * u_tintOn'),
      uniforms: (c) => ({ u_tintOn: c.params.task === 'Phrase grounding' ? 1 : 0 }),
    },
  ],
});

export default [caption] satisfies NodeDef[];
