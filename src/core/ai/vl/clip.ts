/**
 * CLIP ViT-B/32 embeddings (image and text, L2-normalised, 512-d) for ranking pictures by a description — used by
 * the Preset Browser's “Describe a look…” search and “More like this”. Image embeddings are cached per key (the
 * caller passes preset id + thumbnail input key), text embeddings per text.
 */
import '../models-vl';
import { runModelMulti } from '../runtime';
import { clipTokenizer } from './text';

const SIZE = 224;
const MEAN = [0.48145466, 0.4578275, 0.40821073];
const STD = [0.26862954, 0.26130258, 0.27577711];

const imgCache = new Map<string, Promise<Float32Array>>();
const textCache = new Map<string, Promise<Float32Array>>();

function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  const k = 1 / (Math.sqrt(n) || 1);
  return v.map((x) => x * k);
}

export const cosine = (a: Float32Array, b: Float32Array) => {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d;
};

/** CLIP preprocessing on a canvas: shortest side → 224 (smooth), centre crop, CLIP mean / std, CHW. */
async function pixelsFromUrl(url: string): Promise<Float32Array> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.imageSmoothingQuality = 'high';
  const k = SIZE / Math.min(img.width, img.height);
  const w = img.width * k, h = img.height * k;
  g.drawImage(img, (SIZE - w) / 2, (SIZE - h) / 2, w, h);
  const d = g.getImageData(0, 0, SIZE, SIZE).data;
  const n = SIZE * SIZE;
  const px = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) for (let ch = 0; ch < 3; ch++) px[ch * n + i] = (d[i * 4 + ch] / 255 - MEAN[ch]) / STD[ch];
  return px;
}

/** Image embedding of a picture (data / blob / http URL), cached under `key`. */
export function clipImage(key: string, url: string): Promise<Float32Array> {
  let p = imgCache.get(key);
  if (!p) {
    p = (async () => {
      const r = await runModelMulti('clip-vision', { pixel_values: { data: await pixelsFromUrl(url), dims: [1, 3, SIZE, SIZE] } }, ['image_embeds']);
      if (!r.image_embeds) throw new Error('CLIP image model returned nothing');
      return normalize(r.image_embeds.data);
    })();
    p.catch(() => imgCache.delete(key));
    imgCache.set(key, p);
    if (imgCache.size > 2000) imgCache.delete(imgCache.keys().next().value!);
  }
  return p;
}

export const clipImageCached = (key: string) => imgCache.get(key);

/** Text embedding (the query is wrapped as “a <text> photo” — CLIP was trained on captions). */
export function clipText(text: string): Promise<Float32Array> {
  const q = text.trim();
  let p = textCache.get(q);
  if (!p) {
    p = (async () => {
      const tok = await clipTokenizer();
      const ids = tok.encode(`a ${q} photo`);
      const r = await runModelMulti('clip-text', { input_ids: { data: Float32Array.from(ids), dims: [1, ids.length], type: 'int64' } }, ['text_embeds']);
      if (!r.text_embeds) throw new Error('CLIP text model returned nothing');
      return normalize(r.text_embeds.data);
    })();
    p.catch(() => textCache.delete(q));
    textCache.set(q, p);
  }
  return p;
}
