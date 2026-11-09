/**
 * Open-vocabulary detection with OWLv2 / OWL-ViT. The ONNX export is cut into an image part and a text part (see
 * models-vl.ts), and the small class head that mixes them runs here in JS (boxes.ts owlLogits), so:
 *  - the image is encoded once per image (InferenceMemo by fingerprint);
 *  - each prompt only runs the text tower (≈10–30 ms), cached per text;
 *  - changing threshold / count / selection is pure post-processing.
 */
import '../models-vl';
import { fingerprint, InferenceMemo, resampleRGB } from '../image';
import { runModelMulti } from '../runtime';
import type { RawTex } from '../../types';
import { owlDetections, owlLogits, type Detection } from './boxes';
import { clipTokenizer } from './text';

export type OwlModel = 'owlv2' | 'owlvit';
export const OWL_MODELS: Record<string, OwlModel> = { 'OWLv2 B/16 (accurate)': 'owlv2', 'OWL-ViT B/32 (fast)': 'owlvit' };

const CFG = {
  owlv2: { size: 960, pad: true, vision: 'owlv2-vision', text: 'owlv2-text', textOut: '/owlv2/Div_output_0' },
  owlvit: { size: 768, pad: false, vision: 'owlvit-vision', text: 'owlvit-text', textOut: '/owlvit/Div_output_0' },
};
const MEAN = [0.48145466, 0.4578275, 0.40821073];
const STD = [0.26862954, 0.26130258, 0.27577711];
const DIM = 512;
/** OWL's text position embeddings stop at 16 tokens. */
const MAX_TOKENS = 16;

export interface OwlImage {
  cls: Float32Array;
  shift: Float32Array;
  scale: Float32Array;
  boxes: Float32Array;
  /** Box frame relative to the image (OWLv2 pads to a square). */
  fw: number;
  fh: number;
}

const memo = new InferenceMemo<OwlImage>(4);
const textCache = new Map<string, Float32Array>();

/** Image → model input: OWLv2 = long side to 960 + grey padding (bottom / right); OWL-ViT = squashed to 768². */
function preprocess(src: RawTex, model: OwlModel) {
  const { size, pad } = CFG[model];
  const k = size / Math.max(src.width, src.height);
  const dw = pad ? Math.max(1, Math.round(src.width * k)) : size;
  const dh = pad ? Math.max(1, Math.round(src.height * k)) : size;
  const rgb = resampleRGB(src.data, src.width, src.height, dw, dh);
  const n = size * size;
  const px = new Float32Array(3 * n);
  for (let c = 0; c < 3; c++) px.fill((0.5 - MEAN[c]) / STD[c], c * n, (c + 1) * n);
  for (let y = 0; y < dh; y++)
    for (let x = 0; x < dw; x++) {
      const s = (y * dw + x) * 3, d = y * size + x;
      for (let c = 0; c < 3; c++) px[c * n + d] = (rgb[s + c] - MEAN[c]) / STD[c];
    }
  return { px, rgb, dw, dh, fw: pad ? size / dw : 1, fh: pad ? size / dh : 1 };
}

/** Encode the image once (memoised by content); shared by every prompt. */
export function owlImage(model: OwlModel, src: RawTex, signal?: AbortSignal): Promise<OwlImage> {
  const cfg = CFG[model];
  const pre = preprocess(src, model);
  return memo.get(
    model,
    fingerprint(pre.rgb, pre.dw, pre.dh),
    Math.max(src.width, src.height),
    cfg.size,
    async () => {
      const [a, b, c, d] = ['/class_head/Div_output_0', '/class_head/logit_shift/Add_output_0', '/class_head/Add_2_output_0', 'pred_boxes'];
      const r = await runModelMulti(cfg.vision, { pixel_values: { data: pre.px, dims: [1, 3, cfg.size, cfg.size] } }, [a, b, c, d]);
      if (!r[a] || !r[b] || !r[c] || !r[d]) throw new Error('OWL image encoder returned no features');
      return { cls: r[a].data, shift: r[b].data, scale: r[c].data, boxes: r[d].data, fw: pre.fw, fh: pre.fh };
    },
    signal,
  );
}

/** Text embeddings (one per query), cached per model + text. */
export async function owlText(model: OwlModel, texts: string[]): Promise<Float32Array[]> {
  const key = (t: string) => `${model}\u0000${t}`;
  const todo = [...new Set(texts.filter((t) => !textCache.has(key(t))))];
  if (todo.length) {
    const tok = await clipTokenizer();
    const { ids, mask, len } = tok.encodeBatch(todo, { maxLen: MAX_TOKENS, padTo: MAX_TOKENS, padId: 0 });
    const cfg = CFG[model];
    const r = await runModelMulti(cfg.text, { input_ids: { data: ids, dims: [todo.length, len], type: 'int64' }, attention_mask: { data: mask, dims: [todo.length, len], type: 'int64' } }, [cfg.textOut]);
    const e = r[cfg.textOut];
    if (!e) throw new Error('OWL text encoder returned nothing');
    todo.forEach((t, i) => textCache.set(key(t), e.data.slice(i * DIM, (i + 1) * DIM)));
    if (textCache.size > 256) textCache.delete(textCache.keys().next().value!);
  }
  return texts.map((t) => textCache.get(key(t))!);
}

/** Detect `texts` in an encoded image. */
export async function owlDetect(model: OwlModel, img: OwlImage, texts: string[], opts: { threshold: number; max: number; nms?: number }): Promise<Detection[]> {
  if (!texts.length) return [];
  const emb = await owlText(model, texts);
  const logits = owlLogits(img.cls, img.shift, img.scale, emb, DIM);
  return owlDetections(logits, img.boxes, texts.length, { ...opts, frameW: img.fw, frameH: img.fh, texts });
}
