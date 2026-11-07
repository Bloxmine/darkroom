/**
 * ComfyUI API-format workflow builder (pure, unit-tested). The graph:
 *
 *   CheckpointLoaderSimple ─┬─ model ───────────────────────────────────────────────┐
 *                           ├─ clip → CLIPTextEncode (+) ─┐                          │
 *                           │       → CLIPTextEncode (−) ─┤                          │
 *                           │   ControlNetLoader + LoadImage → ControlNetApplyAdvanced ×N (chained)
 *                           │                                   positive / negative ─┤
 *                           └─ vae ─┬─ (img2img) LoadImage → VAEEncode [→ SetLatentNoiseMask ← ImageToMask ← LoadImage]
 *                                   │  (txt2img) EmptyLatentImage ───────── latent ─→ KSampler
 *                                   └──────────────────────── VAEDecode ← samples ──┘ → SaveImage
 *
 * Node ids are stable strings so results are easy to find in /history.
 */
import type { GenSpec } from './types';

export type ComfyLink = [string, number];
export interface ComfyNode {
  class_type: string;
  inputs: Record<string, string | number | boolean | ComfyLink>;
  _meta?: { title: string };
}
export type ComfyWorkflow = Record<string, ComfyNode>;

/** Id of the SaveImage node whose output holds the result. */
export const COMFY_OUTPUT_NODE = 'save';

export function buildComfyWorkflow(spec: GenSpec<string>, filenamePrefix = 'Darkroom'): ComfyWorkflow {
  const wf: ComfyWorkflow = {};
  const add = (id: string, class_type: string, inputs: ComfyNode['inputs'], title?: string) => {
    wf[id] = { class_type, inputs, ...(title ? { _meta: { title } } : {}) };
    return id;
  };
  const ckpt = add('ckpt', 'CheckpointLoaderSimple', { ckpt_name: spec.checkpoint });
  let pos: ComfyLink = [add('pos', 'CLIPTextEncode', { text: spec.positive, clip: [ckpt, 1] }, 'Positive'), 0];
  let neg: ComfyLink = [add('neg', 'CLIPTextEncode', { text: spec.negative, clip: [ckpt, 1] }, 'Negative'), 0];

  spec.controls.forEach((c, i) => {
    const k = i + 1;
    const loader = add(`cn${k}_model`, 'ControlNetLoader', { control_net_name: c.model });
    const img = add(`cn${k}_image`, 'LoadImage', { image: c.image }, `Control map ${k}`);
    const apply = add(`cn${k}_apply`, 'ControlNetApplyAdvanced', {
      positive: pos,
      negative: neg,
      control_net: [loader, 0],
      image: [img, 0],
      strength: c.weight,
      start_percent: c.start,
      end_percent: c.end,
    });
    pos = [apply, 0];
    neg = [apply, 1];
  });

  let latent: ComfyLink;
  let denoise = 1;
  if (spec.init) {
    const init = add('init_image', 'LoadImage', { image: spec.init }, 'Init image');
    latent = [add('init_latent', 'VAEEncode', { pixels: [init, 0], vae: [ckpt, 2] }), 0];
    if (spec.mask) {
      const mimg = add('mask_image', 'LoadImage', { image: spec.mask }, 'Inpaint mask');
      const mask = add('mask', 'ImageToMask', { image: [mimg, 0], channel: 'red' });
      latent = [add('masked_latent', 'SetLatentNoiseMask', { samples: latent, mask: [mask, 0] }), 0];
    }
    denoise = spec.denoise;
  } else {
    latent = [add('latent', 'EmptyLatentImage', { width: spec.width, height: spec.height, batch_size: 1 }), 0];
  }

  const ks = add('sampler', 'KSampler', {
    model: [ckpt, 0],
    seed: spec.seed,
    steps: spec.steps,
    cfg: spec.cfg,
    sampler_name: spec.sampler || 'euler',
    scheduler: spec.scheduler || 'normal',
    positive: pos,
    negative: neg,
    latent_image: latent,
    denoise,
  });
  const dec = add('decode', 'VAEDecode', { samples: [ks, 0], vae: [ckpt, 2] });
  add(COMFY_OUTPUT_NODE, 'SaveImage', { images: [dec, 0], filename_prefix: filenamePrefix });
  return wf;
}
