/**
 * Vision-language models (open-vocabulary detection, text masks, captioning / OCR, CLIP embeddings), registered
 * into the shared catalog. Imported for its side effect by src/core/ai/vl/*. Licences/attribution: docs/AI.md.
 *
 * OWL-ViT / OWLv2 and CLIPSeg ship as one ONNX graph that takes image and text together. Each is registered as
 * several catalog entries that share one download (same pinned URL, cached once) and cut it into an image part
 * and a text part (`prepare` → extractGraph), so a new prompt never re-encodes the image.
 */
import { registerModel, type ModelFile, type ModelInfo } from './models';
import { castInputs, DT, extractGraph } from './vl/onnx-split';

const hf = (repo: string, sha: string, file: string) => `https://huggingface.co/${repo}/resolve/${sha}/${file}`;

const OWL2_REPO = 'Xenova/owlv2-base-patch16-ensemble';
const OWL2_SHA = '3e255bc9bf304b3358a8c1945c0a9514eefe7f10';
const OWL1_REPO = 'Xenova/owlvit-base-patch32';
const OWL1_SHA = 'b75f4e52949639c3bb0b96546ea4149482f6e7ef';
const SEG_REPO = 'Xenova/clipseg-rd64-refined';
const SEG_SHA = '924dc94f85f58739f353f94258b33bc47eae4862';
const FLO_REPO = 'onnx-community/Florence-2-base-ft';
const FLO_SHA = 'e88a44eaf3791a35eae0c5a47b3dbcd36e67eb6f';
const CLIP_REPO = 'Xenova/clip-vit-base-patch32';
const CLIP_SHA = '6b7c523703ae26e39be4b03774966f8571c7f523';

/** Tokenizer files (Hugging Face tokenizer.json), fetched through the model cache by vl/text.ts. */
export const TOKENIZERS = {
  /** CLIP BPE: shared by CLIP, OWL-ViT, OWLv2 and CLIPSeg (identical vocab and merges). */
  clip: { label: 'CLIP tokenizer', url: hf(CLIP_REPO, CLIP_SHA, 'tokenizer.json'), bytes: 2224119 },
  florence: { label: 'Florence-2 tokenizer', url: hf(FLO_REPO, FLO_SHA, 'tokenizer.json'), bytes: 2297961 },
};

/** Cut points of the OWL graphs (found with an onnx frontier scan; identical in both exports). */
export const OWL_VISION_OUT = ['/class_head/Div_output_0', '/class_head/logit_shift/Add_output_0', '/class_head/Add_2_output_0', 'pred_boxes'];
/** pred_boxes is a float32 graph output in both files (kept as declared); the head tensors follow the activations. */
const owlVision = (f16: boolean) => [...typed(OWL_VISION_OUT.slice(0, 3), f16), 'pred_boxes'];
const owlText = (prefix: string) => [`/${prefix}/Div_output_0`];
/** CLIPSeg: vision activations (layers 3/6/9 after the decoder's reduce layers) and the FiLM conditioning. */
export const CLIPSEG_V = ['/decoder/Transpose_output_0', '/decoder/reduces.1/Add_output_0', '/decoder/reduces.2/Add_output_0'];
export const CLIPSEG_T = ['/decoder/film_mul/Gemm_output_0', '/decoder/film_add/Gemm_output_0', '/decoder/Unsqueeze_output_0'];
/** Element types of the CLIPSeg text-side cut tensors (the last one is a shape value). */
const CLIPSEG_T_TYPES = (f16: boolean) => [f16 ? DT.float16 : DT.float, f16 ? DT.float16 : DT.float, DT.int64];

const OWL2_CREDIT = 'OWLv2 (Minderer et al., NeurIPS 2023), google/owlv2-base-patch16-ensemble; ONNX export by Xenova';
const OWL1_CREDIT = 'OWL-ViT (Minderer et al., ECCV 2022), google/owlvit-base-patch32; ONNX export by Xenova';
const SEG_CREDIT = 'CLIPSeg (Lüddecke & Ecker, CVPR 2022), CIDAS/clipseg-rd64-refined; ONNX export by Xenova';
const FLO_CREDIT = 'Florence-2 (Xiao et al., CVPR 2024), microsoft/Florence-2-base-ft; ONNX export by onnx-community';
const CLIP_CREDIT = 'CLIP (Radford et al., ICML 2021), openai/clip-vit-base-patch32; ONNX export by Xenova';

// int8 (dynamic quantisation) for WASM; q4f16 for WebGPU: ORT 1.31's WebGPU EP computes the int8 graphs wrongly
// (MatMulInteger falls back to the CPU and the OWL boxes / scores come out garbage) and ≈16 s slow.
const owl2Files: ModelFile[] = [
  { precision: 'q8', url: hf(OWL2_REPO, OWL2_SHA, 'onnx/model_quantized.onnx'), bytes: 155312754 },
  { precision: 'q4f16', url: hf(OWL2_REPO, OWL2_SHA, 'onnx/model_q4f16.onnx'), bytes: 128434817 },
];
const owl1Files: ModelFile[] = [
  { precision: 'q8', url: hf(OWL1_REPO, OWL1_SHA, 'onnx/model_quantized.onnx'), bytes: 155431700 },
  { precision: 'q4f16', url: hf(OWL1_REPO, OWL1_SHA, 'onnx/model_q4f16.onnx'), bytes: 127312570 },
];
// CLIPSeg is small at 352² (≈1–3 s on one WASM thread): int8 on WASM only, one 139 MB download.
const segFiles: ModelFile[] = [{ precision: 'q8', url: hf(SEG_REPO, SEG_SHA, 'onnx/model_quantized.onnx'), bytes: 139115836 }];
/** The q4f16 graphs keep fp16 activations: cut tensors there are float16 (the session host converts them to float32). */
const isF16 = (buf: ArrayBuffer, files: ModelFile[]) => files.some((f) => f.precision === 'q4f16' && f.bytes === buf.byteLength);
const typed = (names: string[], f16: boolean, types?: number[]) => names.map((name, i) => ({ name, type: types?.[i] ?? (f16 ? DT.float16 : DT.float) }));

const part = (base: Omit<ModelInfo, 'id' | 'name' | 'prepare'>, id: string, name: string, prepare: ModelInfo['prepare']): ModelInfo => ({ ...base, id, name, prepare });

const owl2: Omit<ModelInfo, 'id' | 'name' | 'prepare'> = { task: 'detection', licence: 'Apache-2.0', page: `https://huggingface.co/${OWL2_REPO}`, credit: OWL2_CREDIT, files: owl2Files };
const owl1: Omit<ModelInfo, 'id' | 'name' | 'prepare'> = { task: 'detection', licence: 'Apache-2.0', page: `https://huggingface.co/${OWL1_REPO}`, credit: OWL1_CREDIT, files: owl1Files };
const seg: Omit<ModelInfo, 'id' | 'name' | 'prepare'> = { task: 'segmentation', licence: 'Apache-2.0', page: `https://huggingface.co/${SEG_REPO}`, credit: SEG_CREDIT, files: segFiles, wasmOnly: true };
const flo = (file: string, bytes: number) => ({
  task: 'vision-language' as const,
  licence: 'MIT',
  page: `https://huggingface.co/${FLO_REPO}`,
  credit: FLO_CREDIT,
  wasmOnly: true,
  files: [{ precision: 'q8' as const, url: hf(FLO_REPO, FLO_SHA, `onnx/${file}`), bytes }],
});
const clip = (file: string, bytes: number) => ({
  task: 'embedding' as const,
  licence: 'MIT',
  page: `https://huggingface.co/${CLIP_REPO}`,
  credit: CLIP_CREDIT,
  wasmOnly: true,
  files: [{ precision: 'q8' as const, url: hf(CLIP_REPO, CLIP_SHA, `onnx/${file}`), bytes }],
});

registerModel(
  part(owl2, 'owlv2-vision', 'OWLv2 B/16 (image part)', (b) => extractGraph(b, owlVision(isF16(b, owl2Files)))),
  { ...part(owl2, 'owlv2-text', 'OWLv2 B/16 (text part)', (b) => extractGraph(b, owlText('owlv2'))), files: owl2Files.slice(0, 1), wasmOnly: true },
  part(owl1, 'owlvit-vision', 'OWL-ViT B/32 (image part)', (b) => extractGraph(b, owlVision(isF16(b, owl1Files)))),
  { ...part(owl1, 'owlvit-text', 'OWL-ViT B/32 (text part)', (b) => extractGraph(b, owlText('owlvit'))), files: owl1Files.slice(0, 1), wasmOnly: true },
  part(seg, 'clipseg-vision', 'CLIPSeg rd64 (image part)', (b) => extractGraph(b, typed(CLIPSEG_V, isF16(b, segFiles)))),
  part(seg, 'clipseg-text', 'CLIPSeg rd64 (text part)', (b) => extractGraph(b, typed(CLIPSEG_T, isF16(b, segFiles), CLIPSEG_T_TYPES(isF16(b, segFiles))))),
  part(seg, 'clipseg-decoder', 'CLIPSeg rd64 (decoder)', (b) => {
    const f16 = isF16(b, segFiles);
    return extractGraph(b, ['logits'], [...typed(CLIPSEG_V, f16), ...typed(CLIPSEG_T, f16, CLIPSEG_T_TYPES(f16))]);
  }),
  {
    id: 'florence2-vision',
    name: 'Florence-2 base (vision encoder)',
    ...flo('vision_encoder_quantized.onnx', 93746540),
    wasmOnly: false,
    files: [
      { precision: 'q8', url: hf(FLO_REPO, FLO_SHA, 'onnx/vision_encoder_quantized.onnx'), bytes: 93746540 },
      { precision: 'fp16', url: hf(FLO_REPO, FLO_SHA, 'onnx/vision_encoder_fp16.onnx'), bytes: 183930536 },
    ],
  },
  { id: 'florence2-embed', name: 'Florence-2 base (token embeddings)', ...flo('embed_tokens_quantized.onnx', 39390433) },
  { id: 'florence2-encoder', name: 'Florence-2 base (text encoder)', ...flo('encoder_model_quantized.onnx', 43651493) },
  {
    id: 'florence2-decoder',
    name: 'Florence-2 base (decoder)',
    ...flo('decoder_model_merged_quantized.onnx', 98177697),
    // the merged decoder's bool `use_cache_branch` becomes a float input (the session host sends float32 / int64)
    prepare: (b: ArrayBuffer) => castInputs(b, [{ name: 'use_cache_branch', from: DT.float, to: DT.bool }]),
  },
  { id: 'clip-vision', name: 'CLIP ViT-B/32 (image)', ...clip('vision_model_quantized.onnx', 89117001) },
  { id: 'clip-text', name: 'CLIP ViT-B/32 (text)', ...clip('text_model_quantized.onnx', 64504507) },
);
