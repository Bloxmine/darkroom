/**
 * AUTOMATIC1111 / Forge / SD.Next web-API payload builder (pure, unit-tested):
 * POST /sdapi/v1/txt2img, or /sdapi/v1/img2img with an init image (and a mask for inpainting).
 * ControlNet units go in `alwayson_scripts.controlnet.args` (sd-webui-controlnet / Forge's built-in
 * ControlNet); maps are already preprocessed, so every unit uses module 'none'.
 */
import type { GenSpec } from './types';

export interface A1111Request {
  endpoint: '/sdapi/v1/txt2img' | '/sdapi/v1/img2img';
  body: Record<string, unknown>;
}

export function buildA1111Payload(spec: GenSpec<string>): A1111Request {
  const body: Record<string, unknown> = {
    prompt: spec.positive,
    negative_prompt: spec.negative,
    steps: spec.steps,
    cfg_scale: spec.cfg,
    seed: spec.seed,
    width: spec.width,
    height: spec.height,
    batch_size: 1,
    n_iter: 1,
    send_images: true,
    save_images: false,
  };
  if (spec.sampler) body.sampler_name = spec.sampler;
  if (spec.scheduler) body.scheduler = spec.scheduler;
  if (spec.checkpoint) {
    body.override_settings = { sd_model_checkpoint: spec.checkpoint };
    body.override_settings_restore_afterwards = false;
  }
  if (spec.controls.length) {
    body.alwayson_scripts = {
      controlnet: {
        args: spec.controls.map((c) => ({
          enabled: true,
          image: c.image,
          module: 'none',
          model: c.model,
          weight: c.weight,
          guidance_start: c.start,
          guidance_end: c.end,
          resize_mode: 'Just Resize',
          control_mode: 'Balanced',
          pixel_perfect: false,
          processor_res: 512,
        })),
      },
    };
  }
  if (!spec.init) return { endpoint: '/sdapi/v1/txt2img', body };
  body.init_images = [spec.init];
  body.denoising_strength = spec.denoise;
  body.resize_mode = 0;
  if (spec.mask) {
    body.mask = spec.mask;
    body.inpainting_fill = 1; // keep the original under the mask
    body.inpaint_full_res = false;
    body.mask_blur = 4;
    body.inpainting_mask_invert = 0;
  }
  return { endpoint: '/sdapi/v1/img2img', body };
}
