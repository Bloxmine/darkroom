/**
 * Segmentation models (click-select and scene segmentation), registered into the shared catalog.
 * Imported for its side effect by src/nodes/ai/segment*.ts. Licences/attribution: docs/AI.md.
 */
import { registerModel } from './models';

const hf = (repo: string, sha: string, file: string) => `https://huggingface.co/${repo}/resolve/${sha}/${file}`;

const SAM_REPO = 'Xenova/slimsam-77-uniform';
const SAM_SHA = '5850ab45f587c112167512ffef949107115e26a0';
const DETR_REPO = 'Xenova/detr-resnet-50-panoptic';
const DETR_SHA = 'ea24b2d4e0bfae31f0a1299ba3fb892a2df064de';

registerModel(
  {
    id: 'slimsam-encoder',
    name: 'SlimSAM-77 image encoder',
    task: 'segmentation',
    licence: 'Apache-2.0',
    page: `https://huggingface.co/${SAM_REPO}`,
    credit: 'SlimSAM (Chen et al., NeurIPS 2024), pruned from Segment Anything (Kirillov et al., 2023); ONNX export by Xenova',
    files: [
      { precision: 'fp16', url: hf(SAM_REPO, SAM_SHA, 'onnx/vision_encoder_fp16.onnx'), bytes: 12170657 },
      { precision: 'q8', url: hf(SAM_REPO, SAM_SHA, 'onnx/vision_encoder_quantized.onnx'), bytes: 8882165 },
    ],
  },
  {
    id: 'slimsam-decoder',
    name: 'SlimSAM-77 prompt decoder',
    task: 'segmentation',
    licence: 'Apache-2.0',
    page: `https://huggingface.co/${SAM_REPO}`,
    credit: 'SlimSAM / Segment Anything prompt encoder + mask decoder; ONNX export by Xenova',
    files: [
      { precision: 'fp16', url: hf(SAM_REPO, SAM_SHA, 'onnx/prompt_encoder_mask_decoder_fp16.onnx'), bytes: 8550118 },
      { precision: 'q8', url: hf(SAM_REPO, SAM_SHA, 'onnx/prompt_encoder_mask_decoder_quantized.onnx'), bytes: 4903810 },
    ],
  },
  {
    id: 'detr-panoptic',
    name: 'DETR ResNet-50 panoptic (scene segmentation)',
    task: 'segmentation',
    licence: 'Apache-2.0',
    page: `https://huggingface.co/${DETR_REPO}`,
    credit: 'DETR (Carion et al., ECCV 2020), COCO panoptic; ONNX export by Xenova',
    // fp16 weights with fp32 I/O: runs on both WebGPU and WASM, identical to fp32 (tested).
    // The int8 export is broken (mask head garbage), fp32 is 172 MB.
    files: [{ precision: 'fp16', url: hf(DETR_REPO, DETR_SHA, 'onnx/model_fp16.onnx'), bytes: 86559030 }],
  },
);
