/**
 * Generation bridge types: a server-independent description of one Stable Diffusion job, turned into a
 * ComfyUI API workflow (comfy.ts) or an AUTOMATIC1111 / Forge / SD.Next API payload (a1111.ts).
 */

/** 'coreml' = the built-in Core ML engine of the Mac app (no URL; src/core/sd/coreml.ts). */
export type ServerKind = 'comfyui' | 'a1111' | 'coreml';

export interface ControlUnitSpec<I> {
  /** Control map (already the final ControlNet input; no server-side preprocessor is run). */
  image: I;
  /** ControlNet model file / name as the server lists it. */
  model: string;
  weight: number;
  /** 0..1 fraction of the sampling steps. */
  start: number;
  end: number;
}

/**
 * One generation. `I` is how images are referenced: ComfyUI = uploaded file names,
 * A1111 = base64 PNG strings (no data: prefix).
 */
export interface GenSpec<I> {
  checkpoint: string;
  positive: string;
  negative: string;
  steps: number;
  cfg: number;
  /** '' = the server's default (ComfyUI 'euler', A1111 'Euler a'). */
  sampler: string;
  /** '' = the server's default (ComfyUI 'normal', A1111 automatic). */
  scheduler: string;
  /** ≥ 0 (pick a random one before building the request). */
  seed: number;
  width: number;
  height: number;
  /** img2img init image; with it, `denoise` applies. */
  init?: I;
  denoise: number;
  /** Inpainting mask (white = regenerate); only used together with `init`. */
  mask?: I;
  controls: ControlUnitSpec<I>[];
}

export interface ServerLists {
  checkpoints: string[];
  controlnets: string[];
  samplers: string[];
  schedulers: string[];
  /** Display names for list values that are opaque ids (Core ML). */
  labels?: Record<string, string>;
}
