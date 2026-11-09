/**
 * CLIPSeg (rd64-refined): soft region masks from text at 352². The export is cut into an image part (CLIP ViT-B/16
 * activations of layers 3/6/9, already through the decoder's reduce layers), a text part (the FiLM conditioning) and
 * the small decoder (see models-vl.ts), so the image is encoded once and each prompt costs a text pass + a decode.
 */
import '../models-vl';
import { CLIPSEG_T, CLIPSEG_V } from '../models-vl';
import { fingerprint, InferenceMemo, resampleRGB } from '../image';
import { runModelMulti } from '../runtime';
import type { TensorData } from '../session';
import type { RawTex } from '../../types';
import { sigmoid } from './boxes';
import { clipTokenizer } from './text';

export const SEG_SIZE = 352;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

type Tensors = Record<string, TensorData>;
const memo = new InferenceMemo<Tensors>(4);
const textCache = new Map<string, Tensors>();
const decoded = new WeakMap<Tensors, Map<string, Promise<Float32Array>>>();

/** Encode the image (squashed to 352²), memoised by content. */
export function clipsegImage(src: RawTex, signal?: AbortSignal): Promise<Tensors> {
  const rgb = resampleRGB(src.data, src.width, src.height, SEG_SIZE, SEG_SIZE);
  return memo.get(
    'clipseg',
    fingerprint(rgb, SEG_SIZE, SEG_SIZE),
    Math.min(src.width, src.height),
    SEG_SIZE,
    async () => {
      const n = SEG_SIZE * SEG_SIZE;
      const px = new Float32Array(3 * n);
      for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) px[c * n + i] = (rgb[i * 3 + c] - MEAN[c]) / STD[c];
      const r = await runModelMulti('clipseg-vision', { pixel_values: { data: px, dims: [1, 3, SEG_SIZE, SEG_SIZE] } }, CLIPSEG_V);
      if (CLIPSEG_V.some((k) => !r[k])) throw new Error('CLIPSeg image encoder returned nothing');
      return r;
    },
    signal,
  );
}

async function textCond(text: string): Promise<Tensors> {
  const hit = textCache.get(text);
  if (hit) return hit;
  const tok = await clipTokenizer();
  const ids = tok.encode(text);
  const d = Float32Array.from(ids);
  // the third cut tensor is the batch size as an int64 shape value: always 1 here, so it is not read back
  const r = await runModelMulti('clipseg-text', { input_ids: { data: d, dims: [1, ids.length], type: 'int64' }, attention_mask: { data: new Float32Array(ids.length).fill(1), dims: [1, ids.length], type: 'int64' } }, CLIPSEG_T.slice(0, 2));
  if (!r[CLIPSEG_T[0]] || !r[CLIPSEG_T[1]]) throw new Error('CLIPSeg text encoder returned nothing');
  textCache.set(text, r);
  if (textCache.size > 128) textCache.delete(textCache.keys().next().value!);
  return r;
}

const copy = (t: TensorData): TensorData => ({ data: t.data.slice(), dims: t.dims, type: t.type });

/** Probability map (352², row-major) for one text prompt; memoised per image + text. */
export async function clipsegMask(img: Tensors, text: string): Promise<Float32Array> {
  let m = decoded.get(img);
  if (!m) decoded.set(img, (m = new Map()));
  let p = m.get(text);
  if (!p) {
    p = (async () => {
      const t = await textCond(text);
      const feeds: Tensors = {};
      for (const k of CLIPSEG_V) feeds[k] = copy(img[k]);
      feeds[CLIPSEG_T[0]] = copy(t[CLIPSEG_T[0]]);
      feeds[CLIPSEG_T[1]] = copy(t[CLIPSEG_T[1]]);
      feeds[CLIPSEG_T[2]] = { data: Float32Array.of(1), dims: [1], type: 'int64' };
      const r = await runModelMulti('clipseg-decoder', feeds, ['logits']);
      const lo = r.logits;
      if (!lo) throw new Error('CLIPSeg decoder returned nothing');
      return lo.data.map(sigmoid);
    })();
    p.catch(() => m!.delete(text));
    m.set(text, p);
    if (m.size > 32) m.delete(m.keys().next().value!);
  }
  return p;
}

/** Union of the positive prompts' probabilities, each negative prompt multiplied out: m · Π(1 − n). */
export function combineMasks(pos: Float32Array[], neg: Float32Array[], n: number, gain = 1): Float32Array {
  const out = new Float32Array(n);
  for (const m of pos) for (let i = 0; i < n; i++) out[i] = Math.max(out[i], m[i]);
  for (const m of neg) for (let i = 0; i < n; i++) out[i] *= 1 - Math.min(1, m[i] * gain);
  return out;
}
