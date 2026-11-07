/**
 * Image-to-image models (upscale, inpaint, colorize, style transfer, low-light, line art), registered
 * into the shared catalog. Imported for its side effect by src/nodes/ai/{upscale,inpaint,colorize,
 * style,lowlight,lineart}.ts. URLs are pinned to a Hugging Face commit. Licences/attribution: docs/AI.md.
 */
import { registerModel, type ModelInfo } from './models';
import { buildZeroDce, freeImageDims } from './onnx-proto';

const hf = (repo: string, sha: string, file: string) => `https://huggingface.co/${repo}/resolve/${sha}/${file}`;
const page = (repo: string) => `https://huggingface.co/${repo}`;

const ESR = 'skillsafe-ai/realesr-general-x4v3';
const ESR_SHA = '042a40bc4c918349ad3e2e607a68ae509a4c27b5';
const ESR_DN = 'techycoder/realesrgan-general-x4v3';
const ESR_DN_SHA = 'ec6f6298b4a0c6d9afcc01dca1aee8c1873f0e07';
const ANIME = 'skillsafe-ai/realesrgan-x4plus-anime-6b';
const ANIME_SHA = 'c001be50fae1c7a2bae8b2b4dec5e6fcbdbcca96';
const LAMA_Q = 'opencv/inpainting_lama';
const LAMA_Q_SHA = 'aee6d22f0a13e5e35af1c9a1c3afd62841fc6f3f';
const LAMA = 'Carve/LaMa-ONNX';
const LAMA_SHA = 'c3c0c9e468934d62e79c329e35d82dd09ff8c444';
const DDC = 'edgetools/ddcolor';
const DDC_SHA = '4755ae9f1f7a35a9e7693b96c2a88f3432cb6ab0';
const DCE = 'keras-io/low-light-image-enhancement';
const DCE_SHA = 'eb992d12eca55d932541b1c59f1e735718f41179';
const ID = 'x-Liola-x/informative-drawings-onnx';
const ID_SHA = 'f6030b3ad1e84c5ebcf1e508a67b8d4ae697ccda';
const ID_SKETCH = 'backnotprop/informative-drawings-image-to-opensketch-onnx';
const ID_SKETCH_SHA = 'b18595c10a34b8aa5f9a699029a6016602a1be0e';

/** Fast neural style (ONNX Model Zoo, opset 9): style name → [repo, sha, file]. */
export const STYLE_MODELS: Record<string, [string, string, string]> = {
  Mosaic: ['onnxmodelzoo/mosaic-9', '9a267ba8540fba8fb12bc78f3770e0fd9c923c56', 'mosaic-9.onnx'],
  Candy: ['onnxmodelzoo/candy-9', 'f24fcf558bd4564360f41cf3b5321975a33f962f', 'candy-9.onnx'],
  'Rain Princess': ['onnxmodelzoo/rain-princess-9', '205625e4c00565b6c0946814de6165116b271e58', 'rain-princess-9.onnx'],
  Udnie: ['onnxmodelzoo/udnie-9', 'ab74109f694dc8117f5e39a8571ac53bf83618f6', 'udnie-9.onnx'],
  Pointillism: ['onnxmodelzoo/pointilism-9', 'd9c3c80c36d238db4155f3029f996ce62b3c101f', 'pointilism-9.onnx'],
};
export const styleModelId = (style: string) => 'fns-' + style.toLowerCase().replace(/\s+/g, '-');

const styles: ModelInfo[] = Object.entries(STYLE_MODELS).map(([name, [repo, sha, file]]) => ({
  id: styleModelId(name),
  name: `Fast Neural Style: ${name}`,
  task: 'style-transfer',
  licence: 'BSD-3-Clause',
  page: page(repo),
  credit: 'Fast neural style (Johnson et al., ECCV 2016), PyTorch examples; ONNX Model Zoo',
  files: [{ precision: 'fp32', url: hf(repo, sha, file), bytes: 6728029 }],
  // exported at a fixed 224×224; the network is fully convolutional
  prepare: freeImageDims,
}));

registerModel(
  {
    id: 'realesr-general-x4v3',
    name: 'Real-ESRGAN general x4v3',
    task: 'super-resolution',
    licence: 'BSD-3-Clause',
    page: page(ESR),
    credit: 'Real-ESRGAN (Wang et al., ICCVW 2021), SRVGGNetCompact; ONNX export by SkillSafe',
    files: [
      { precision: 'fp16', url: hf(ESR, ESR_SHA, 'model_fp16.onnx'), bytes: 2445496 },
      { precision: 'fp32', url: hf(ESR, ESR_SHA, 'model.onnx'), bytes: 4866428 },
    ],
  },
  {
    id: 'realesr-general-x4v3-dn50',
    name: 'Real-ESRGAN general x4v3 (denoise 0.5)',
    task: 'super-resolution',
    licence: 'BSD-3-Clause',
    page: page(ESR_DN),
    credit: 'Real-ESRGAN x4v3 / wdn-x4v3 blended 50/50 (official --denoise_strength 0.5); ONNX export by techycoder',
    files: [{ precision: 'fp32', url: hf(ESR_DN, ESR_DN_SHA, 'realesr-general-x4v3-dn50.onnx'), bytes: 4858936 }],
  },
  {
    id: 'realesrgan-x4plus-anime',
    name: 'Real-ESRGAN x4plus anime 6B',
    task: 'super-resolution',
    licence: 'BSD-3-Clause',
    page: page(ANIME),
    credit: 'Real-ESRGAN (Wang et al., ICCVW 2021), RRDBNet 6 blocks for anime/illustration; ONNX export by SkillSafe',
    files: [
      { precision: 'fp16', url: hf(ANIME, ANIME_SHA, 'model_fp16.onnx'), bytes: 9031567 },
      { precision: 'fp32', url: hf(ANIME, ANIME_SHA, 'model.onnx'), bytes: 17939975 },
    ],
  },
  {
    id: 'lama',
    name: 'LaMa (big-lama) inpainting',
    task: 'inpainting',
    licence: 'Apache-2.0',
    page: page(LAMA_Q),
    credit: 'LaMa (Suvorov et al., WACV 2022), ONNX port by Carve; int8-weight copy from the OpenCV model zoo',
    files: [
      // int8 weights (DequantizeLinear), same output as fp32 in our tests at less than half the download
      { precision: 'q8', url: hf(LAMA_Q, LAMA_Q_SHA, 'inpainting_lama_2025jan.onnx'), bytes: 92591623 },
      { precision: 'fp32', url: hf(LAMA, LAMA_SHA, 'lama_fp32.onnx'), bytes: 208044816 },
    ],
    // ORT 1.31 WebGPU: the FFC "convg2g/Add" fails (broadcast); a failed WebGPU run would move every model to WASM
    wasmOnly: true,
  },
  {
    id: 'ddcolor-tiny',
    name: 'DDColor tiny (colorization)',
    task: 'colorization',
    licence: 'Apache-2.0',
    page: page(DDC),
    credit: 'DDColor (Kang et al., ICCV 2023), paper_tiny weights; fp16 ONNX export (fp32 I/O, 512×512) by Edge Tools',
    files: [{ precision: 'fp16', url: hf(DDC, DDC_SHA, 'ddcolor-tiny-fp16.onnx'), bytes: 135444402 }],
    // ORT 1.31 WebGPU: "/decoder/layers.0/shuf/conv/MatMul" fails (shared dimension does not match)
    wasmOnly: true,
  },
  ...styles,
  {
    id: 'zero-dce',
    name: 'Zero-DCE (low-light curves)',
    task: 'low-light',
    licence: 'Apache-2.0',
    page: page(DCE),
    credit: 'Zero-DCE (Guo et al., CVPR 2020), Keras example by S. Rakshit (keras-io); graph built in the browser from its weights',
    // the Keras checkpoint's raw float32 weights (325 KB); prepare() wraps them into an ONNX graph
    files: [{ precision: 'fp32', url: hf(DCE, DCE_SHA, 'variables/variables.data-00000-of-00001'), bytes: 325270 }],
    prepare: buildZeroDce,
  },
  {
    id: 'informative-drawings-anime',
    name: 'Informative Drawings: anime style',
    task: 'line-art',
    licence: 'MIT',
    page: page(ID),
    credit: 'Informative Drawings (Chan et al., CVPR 2022), anime_style generator; ONNX export by x-Liola-x',
    files: [{ precision: 'fp32', url: hf(ID, ID_SHA, 'informative-drawings_anime_512x512.onnx'), bytes: 17217788 }],
    prepare: freeImageDims,
  },
  {
    id: 'informative-drawings-contour',
    name: 'Informative Drawings: contour style',
    task: 'line-art',
    licence: 'MIT',
    page: page(ID),
    credit: 'Informative Drawings (Chan et al., CVPR 2022), contour_style generator; ONNX export by x-Liola-x',
    files: [{ precision: 'fp32', url: hf(ID, ID_SHA, 'informative-drawings_contour_512x512.onnx'), bytes: 17217788 }],
    prepare: freeImageDims,
  },
  {
    id: 'informative-drawings-opensketch',
    name: 'Informative Drawings: OpenSketch style',
    task: 'line-art',
    licence: 'MIT',
    page: page(ID_SKETCH),
    credit: 'Informative Drawings (Chan et al., CVPR 2022), opensketch_style generator; ONNX export by backnotprop',
    files: [{ precision: 'fp32', url: hf(ID_SKETCH, ID_SKETCH_SHA, 'model.onnx'), bytes: 17198443 }],
  },
);
