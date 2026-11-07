import { describe, expect, it } from 'vitest';
import { buildA1111Payload } from './a1111';
import { buildComfyWorkflow, COMFY_OUTPUT_NODE } from './comfy';
import type { GenSpec } from './types';

const base: GenSpec<string> = {
  checkpoint: 'sd15/realisticVision.safetensors',
  positive: 'a castle',
  negative: 'blurry',
  steps: 25,
  cfg: 6.5,
  sampler: '',
  scheduler: '',
  seed: 1234,
  width: 768,
  height: 512,
  denoise: 0.6,
  controls: [],
};
const twoUnits: GenSpec<string>['controls'] = [
  { image: 'depth.png', model: 'control_v11f1p_sd15_depth.pth', weight: 0.8, start: 0, end: 1 },
  { image: 'canny.png', model: 'control_v11p_sd15_canny.pth', weight: 0.5, start: 0.1, end: 0.8 },
];

describe('ComfyUI workflow builder', () => {
  it('txt2img with two chained ControlNets', () => {
    const wf = buildComfyWorkflow({ ...base, controls: twoUnits });
    expect(wf).toMatchSnapshot();
    // structure checks independent of the snapshot
    expect(wf.ckpt.class_type).toBe('CheckpointLoaderSimple');
    expect(wf.cn1_apply.inputs.positive).toEqual(['pos', 0]);
    expect(wf.cn2_apply.inputs.positive).toEqual(['cn1_apply', 0]);
    expect(wf.cn2_apply.inputs.negative).toEqual(['cn1_apply', 1]);
    expect(wf.sampler.inputs.positive).toEqual(['cn2_apply', 0]);
    expect(wf.sampler.inputs.negative).toEqual(['cn2_apply', 1]);
    expect(wf.sampler.inputs.latent_image).toEqual(['latent', 0]);
    expect(wf.sampler.inputs.sampler_name).toBe('euler');
    expect(wf.sampler.inputs.scheduler).toBe('normal');
    expect(wf.sampler.inputs.denoise).toBe(1);
    expect(wf.latent.inputs).toEqual({ width: 768, height: 512, batch_size: 1 });
    expect(wf[COMFY_OUTPUT_NODE].class_type).toBe('SaveImage');
    // every link points at an existing node
    for (const n of Object.values(wf))
      for (const v of Object.values(n.inputs)) if (Array.isArray(v)) expect(wf[v[0] as string], `link to ${v[0]}`).toBeDefined();
  });

  it('img2img + inpaint mask, no ControlNet', () => {
    const wf = buildComfyWorkflow({ ...base, init: 'init.png', mask: 'mask.png', sampler: 'dpmpp_2m', scheduler: 'karras' });
    expect(wf).toMatchSnapshot();
    expect(wf.sampler.inputs.positive).toEqual(['pos', 0]);
    expect(wf.sampler.inputs.latent_image).toEqual(['masked_latent', 0]);
    expect(wf.sampler.inputs.denoise).toBe(0.6);
    expect(wf.mask.inputs).toEqual({ image: ['mask_image', 0], channel: 'red' });
    expect(wf.latent).toBeUndefined();
  });
});

describe('A1111 payload builder', () => {
  it('txt2img with ControlNet units', () => {
    const r = buildA1111Payload({ ...base, controls: twoUnits });
    expect(r.endpoint).toBe('/sdapi/v1/txt2img');
    expect(r).toMatchSnapshot();
    const args = (r.body.alwayson_scripts as { controlnet: { args: Record<string, unknown>[] } }).controlnet.args;
    expect(args).toHaveLength(2);
    expect(args[1]).toMatchObject({ enabled: true, image: 'canny.png', module: 'none', model: 'control_v11p_sd15_canny.pth', weight: 0.5, guidance_start: 0.1, guidance_end: 0.8 });
    expect(r.body.override_settings).toEqual({ sd_model_checkpoint: 'sd15/realisticVision.safetensors' });
    expect(r.body).not.toHaveProperty('sampler_name');
    expect(r.body).not.toHaveProperty('init_images');
  });

  it('img2img inpaint', () => {
    const r = buildA1111Payload({ ...base, checkpoint: '', sampler: 'DPM++ 2M', init: 'AAAA', mask: 'BBBB' });
    expect(r.endpoint).toBe('/sdapi/v1/img2img');
    expect(r.body).toMatchObject({ init_images: ['AAAA'], mask: 'BBBB', denoising_strength: 0.6, sampler_name: 'DPM++ 2M', inpainting_fill: 1 });
    expect(r.body).not.toHaveProperty('alwayson_scripts');
    expect(r.body).not.toHaveProperty('override_settings');
  });
});
