/**
 * Motion / style / matting models (optical flow, frame interpolation, arbitrary style transfer,
 * high-quality matting), registered into the shared catalog. Imported for its side effect by
 * src/nodes/ai/{flow,interp,styleImage,matting}.ts. URLs are pinned to a Hugging Face commit; every
 * URL serves `access-control-allow-origin: *`. Licences / attribution / alternatives: docs/AI.md.
 */
import { buildAdainDecoder, buildAdainEncoder, ADAIN_DEC_BYTES, ADAIN_VGG_BYTES } from '../../nodes/ai/styleImageOnnx';
import { registerModel, type ModelInfo } from './models';

const hf = (repo: string, sha: string, file: string) => `https://huggingface.co/${repo}/resolve/${sha}/${file}`;
const page = (repo: string) => `https://huggingface.co/${repo}`;
// task kinds not in the shared union yet (documentation only; nothing switches on them)
const task = (t: string) => t as ModelInfo['task'];

const RAFT = 'opencv/optical_flow_estimation_raft';
const RAFT_SHA = '06ce4aec9b40dd3121e3d856211f14493d5f9931';
const NEUFLOW = 'bukuroo/NeuFlowV2-ONNX';
const NEUFLOW_SHA = '6b92f2df04f98b1f5c5e010982ada9af60b052fc';
const RIFE = 't9749/rife-4.25-lite-onnx';
const RIFE_SHA = '8d1488a82e19fd2f2ca5b3ee1d1bfacd6787b9df';
const ADAIN = 'BhupatiNadar/adain-style-transfer-models';
const ADAIN_SHA = '52de1b15f1040a342e74edd41c75fd6369b4002d';
const BIREF = 'studioludens/birefnet-lite-512';
const BIREF_SHA = '962e67969ec6acec9c19fab76acee4f5e22e990c';

/** Fixed network input sizes (W, H) of the flow models: inputs are resampled to these, flow is scaled back. */
export const FLOW_MODELS = {
  'raft-sintel': { w: 480, h: 360, inputs: ['0', '1'], output: '12006', range: 255 },
  'neuflow-v2-mixed': { w: 768, h: 432, inputs: ['input1', 'input2'], output: 'output', range: 1 },
} as const;
export type FlowModelId = keyof typeof FLOW_MODELS;

/** BiRefNet input size (fixed in the export). The 1024² exports run out of memory in ORT-web (see docs/AI.md). */
export const BIREFNET_SIZE = 512;

registerModel(
  {
    id: 'raft-sintel',
    name: 'RAFT optical flow (Sintel, 480×360)',
    task: task('optical-flow'),
    licence: 'BSD-3-Clause (RAFT) / MIT (ONNX conversion)',
    page: page(RAFT),
    credit: 'RAFT (Teed & Deng, ECCV 2020), Sintel weights; ONNX by PINTO0309, OpenCV model zoo',
    files: [{ precision: 'fp32', url: hf(RAFT, RAFT_SHA, 'optical_flow_estimation_raft_2023aug.onnx'), bytes: 64119337 }],
    // ORT 1.31 WebGPU runs it without an error but returns wrong flow (already the 1/8-res iterations: max diff 14 px
    // vs WASM on the test pair), so it would silently produce garbage
    wasmOnly: true,
  },
  {
    id: 'neuflow-v2-mixed',
    name: 'NeuFlow v2 optical flow (768×432)',
    task: task('optical-flow'),
    licence: 'Apache-2.0 (NeuFlow v2) / MIT (ONNX export)',
    page: page(NEUFLOW),
    credit: 'NeuFlow v2 (Zhang et al., 2024), mixed-dataset weights; ONNX export by ikeboo (ezonnx)',
    files: [{ precision: 'fp32', url: hf(NEUFLOW, NEUFLOW_SHA, 'neuflow_mixed.onnx'), bytes: 42202229 }],
  },
  {
    id: 'rife-4.25-lite',
    name: 'RIFE 4.25 lite (frame interpolation)',
    task: task('frame-interpolation'),
    licence: 'MIT',
    page: page(RIFE),
    credit: 'RIFE (Huang et al., ECCV 2022), Practical-RIFE 4.25 lite weights by hzwer; ONNX export by t9749',
    files: [{ precision: 'fp32', url: hf(RIFE, RIFE_SHA, 'rife_v425lite.onnx'), bytes: 22677513 }],
  },
  {
    id: 'adain-vgg-encoder',
    name: 'AdaIN VGG-19 encoder (relu4_1)',
    task: 'style-transfer',
    licence: 'MIT',
    page: page(ADAIN),
    credit: 'AdaIN (Huang & Belongie, ICCV 2017), normalised VGG-19 from naoto0804/pytorch-AdaIN; graph built in the browser',
    files: [{ precision: 'fp32', url: hf(ADAIN, ADAIN_SHA, 'vgg_normalized.pth'), bytes: ADAIN_VGG_BYTES }],
    prepare: buildAdainEncoder,
  },
  {
    id: 'adain-decoder',
    name: 'AdaIN decoder',
    task: 'style-transfer',
    licence: 'MIT',
    page: page(ADAIN),
    credit: 'AdaIN (Huang & Belongie, ICCV 2017) decoder (pytorch-AdaIN architecture), weights by BhupatiNadar; graph built in the browser',
    files: [{ precision: 'fp32', url: hf(ADAIN, ADAIN_SHA, 'decoder_final.pth'), bytes: ADAIN_DEC_BYTES }],
    prepare: buildAdainDecoder,
  },
  {
    id: 'birefnet-lite',
    name: 'BiRefNet lite (matting, 512²)',
    task: 'matting',
    licence: 'MIT',
    page: page(BIREF),
    credit: 'BiRefNet (Zheng et al., CAAI AIR 2024), BiRefNet_lite (Swin-T) general weights; 512² ONNX re-export by Studio Ludens',
    // fp16 weights with fp32 I/O (logits out), on every backend; fp32 would be 192 MB. The onnx-community 1024² exports
    // need ≈7 GB at run time and die with std::bad_alloc in the WASM heap; WebGPU fails to compile a kernel.
    files: [{ precision: 'fp16', url: hf(BIREF, BIREF_SHA, 'onnx/model_fp16.onnx'), bytes: 98484532 }],
    // ORT 1.31 WebGPU: a kernel fails WGSL validation ("no matching constructor for i32(vec4<u32>)") and the run
    // returns a near-black matte without an error; WASM matches the Python reference
    wasmOnly: true,
  },
);
