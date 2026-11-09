/**
 * Catalog of in-browser AI models. URLs are pinned to an exact Hugging Face commit so a model
 * can never silently change under a project; files are cached in Cache Storage ('darkroom-models').
 * Licences/attribution: docs/AI.md.
 */

/** q4f16: 4-bit weights (MatMulNBits) with fp16 activations, used on WebGPU when there is no fp16 file. */
export type Precision = 'fp32' | 'fp16' | 'q8' | 'q4f16';

export interface ModelFile {
  precision: Precision;
  url: string;
  bytes: number;
}

export interface ModelInfo {
  id: string;
  name: string;
  task: 'depth' | 'matting' | 'saliency' | 'segmentation' | 'super-resolution' | 'inpainting' | 'colorization' | 'style-transfer' | 'low-light' | 'line-art' | 'denoising' | 'face' | 'pose' | 'face-restoration' | 'normals' | 'detection' | 'vision-language' | 'embedding';
  licence: string;
  /** Model card. */
  page: string;
  credit: string;
  files: ModelFile[];
  /** Run on WASM even when WebGPU is active (ops the WebGPU EP lacks). */
  wasmOnly?: boolean;
  /** Not run by ONNX Runtime (e.g. a MediaPipe .task): the AI Models panel only downloads/caches its first file. */
  external?: boolean;
  /** Turn the downloaded file into the ONNX bytes to load (e.g. free fixed input dims, or build a graph from raw weights). The download itself is cached as-is. */
  prepare?: (buf: ArrayBuffer) => ArrayBuffer | Promise<ArrayBuffer>;
}

const hf = (repo: string, sha: string, file: string) => `https://huggingface.co/${repo}/resolve/${sha}/${file}`;

const DA_REPO = 'onnx-community/depth-anything-v2-small';
const DA_SHA = '4472b7362082ad9968fee890ca0f1e5aca36b93d';
const MODNET_REPO = 'Xenova/modnet';
const MODNET_SHA = 'fa2fa546052fba4c08921230a26cc69a333fca12';
const U2_REPO = 'BritishWerewolf/U-2-Netp';
const U2_SHA = '7112208dbac3a3642496c8d54e2f0f9bb3dc1dc8';

export const MODELS: Record<string, ModelInfo> = {
  'depth-anything-v2-small': {
    id: 'depth-anything-v2-small',
    name: 'Depth Anything V2 Small',
    task: 'depth',
    licence: 'Apache-2.0',
    page: `https://huggingface.co/${DA_REPO}`,
    credit: 'Depth Anything V2 (Yang et al., 2024), ONNX export by onnx-community',
    files: [
      { precision: 'fp16', url: hf(DA_REPO, DA_SHA, 'onnx/model_fp16.onnx'), bytes: 49642442 },
      { precision: 'q8', url: hf(DA_REPO, DA_SHA, 'onnx/model_quantized.onnx'), bytes: 27258801 },
    ],
  },
  modnet: {
    id: 'modnet',
    name: 'MODNet (portrait matting)',
    task: 'matting',
    licence: 'Apache-2.0',
    page: `https://huggingface.co/${MODNET_REPO}`,
    credit: 'MODNet (Ke et al., AAAI 2022), ONNX export by Xenova',
    // fp32 only: the int8 export punches holes in bodies/clothing (tested), fp32 is clean at the same speed
    files: [{ precision: 'fp32', url: hf(MODNET_REPO, MODNET_SHA, 'onnx/model.onnx'), bytes: 25888640 }],
  },
  u2netp: {
    id: 'u2netp',
    name: 'U²-Net-p (salient object)',
    task: 'saliency',
    licence: 'Apache-2.0',
    page: `https://huggingface.co/${U2_REPO}`,
    credit: 'U²-Net (Qin et al., Pattern Recognition 2020), ONNX export from rembg, packaged by BritishWerewolf',
    files: [{ precision: 'fp32', url: hf(U2_REPO, U2_SHA, 'onnx/model.onnx'), bytes: 4574861 }],
    // WebGPU EP lacks MaxPool ceil_mode (ORT 1.31); a failed WebGPU run also breaks later WebGPU runs
    wasmOnly: true,
  },
};

/** Pick the file to download for a backend: fp16 on WebGPU with shader-f16, else the smallest int8/fp32. */
export function pickFile(model: ModelInfo, ep: 'webgpu' | 'wasm', shaderF16: boolean): ModelFile {
  if (ep === 'webgpu' && shaderF16) {
    const f = model.files.find((x) => x.precision === 'fp16') ?? model.files.find((x) => x.precision === 'q4f16');
    if (f) return f;
  }
  return model.files.find((x) => x.precision === 'q8') ?? model.files.find((x) => x.precision === 'fp32') ?? model.files.find((x) => x.precision !== 'q4f16') ?? model.files[0];
}

/** Add models to the catalog from another module (e.g. models-seg.ts). Additive; an existing id is replaced. */
export function registerModel(...models: ModelInfo[]) {
  for (const m of models) MODELS[m.id] = m;
}
