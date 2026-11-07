/**
 * Face models (YuNet detector for ai.faces, restoration for ai.faceRestore), registered into the shared catalog. Imported for its side
 * effect by src/nodes/ai/face-analysis.ts and faceRestore.ts. URLs are pinned to a Hugging Face commit. Licences: docs/AI.md.
 *
 * RestoreFormer++ (Apache-2.0) instead of GFPGAN v1.4: the only browser-ready GFPGAN ONNX exports are
 * 340 MB fp32, while this RestoreFormer++ export stores int8 per-channel weights with fp32 compute (74 MB,
 * mean difference 0.7/255 vs the original) and runs on both WebGPU and WASM. CodeFormer is non-commercial
 * (S-Lab licence) and GPEN's repository has no licence, so neither is offered.
 */
import { registerModel } from './models';
import { freeImageDims } from './onnx-proto';

const hf = (repo: string, sha: string, file: string) => `https://huggingface.co/${repo}/resolve/${sha}/${file}`;

const RF_REPO = 'Saimon8420/restoreformer-pp-web';
const RF_SHA = '9e5912e04026135bc1a7c8557a2da66f521a7b8e';
const YN_REPO = 'opencv/face_detection_yunet';
const YN_SHA = '3cc26e7f1014a5ee5d74a42acee58bafc9d0a310';
const GFP_REPO = 'neurobytemind/GFPGANv1.4.onnx';
const GFP_SHA = 'e3fd467e3a83420614abb9bf0b1c2c3addd359bc';

registerModel(
  {
    id: 'yunet',
    name: 'YuNet (face detector)',
    task: 'face',
    licence: 'MIT',
    page: `https://huggingface.co/${YN_REPO}`,
    credit: 'YuNet (Wu, Peng, Yu, Machine Intelligence Research 2023), OpenCV Zoo 2023mar: finds faces down to ~10 px',
    files: [{ precision: 'fp32', url: hf(YN_REPO, YN_SHA, 'face_detection_yunet_2023mar.onnx'), bytes: 232589 }],
    // the export is fixed at 640×640; it is fully convolutional, so free the spatial dims and feed the photo's aspect
    prepare: freeImageDims,
    // tiny: WASM is as fast as WebGPU and avoids a shader compile per input size
    wasmOnly: true,
  },
  {
    id: 'restoreformer-pp',
    name: 'RestoreFormer++ (face restoration)',
    task: 'face-restoration',
    licence: 'Apache-2.0',
    page: `https://huggingface.co/${RF_REPO}`,
    credit: 'RestoreFormer++ (Wang et al., TPAMI 2023); browser ONNX export with int8 weights by Saimon8420',
    // int8 weights + fp32 compute: same speed as the fp16-weight file on WebGPU, half the download
    files: [{ precision: 'q8', url: hf(RF_REPO, RF_SHA, 'restoreformer_pp_int8w.onnx'), bytes: 74375477 }],
  },
  {
    id: 'gfpgan-v1.4',
    name: 'GFPGAN v1.4 (face restoration)',
    task: 'face-restoration',
    licence: 'Apache-2.0',
    page: `https://huggingface.co/${GFP_REPO}`,
    credit: 'GFPGAN v1.4 (Wang et al., CVPR 2021, TencentARC); ONNX export (fp32)',
    files: [{ precision: 'fp32', url: hf(GFP_REPO, GFP_SHA, 'GFPGANv1.4.onnx'), bytes: 340256686 }],
  },
);
