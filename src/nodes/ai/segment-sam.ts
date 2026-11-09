/**
 * Click Select (SAM): interactive object selection with SlimSAM-77 (Segment Anything, pruned), in-browser.
 * The image embedding is computed once per input image (memo by fingerprint); clicks only re-run the
 * small prompt decoder. Low-res mask probabilities are upsampled edge-aware against the image.
 */
import '../../core/ai/models-seg';
import { fingerprint, InferenceMemo, maskTex, resampleRGB } from '../../core/ai/image';
import { runModelMulti } from '../../core/ai/runtime';
import { defineNode } from '../../core/registry';
import type { NodeDef, Params, RawTex } from '../../core/types';
import { parseBox, parsePoints } from '../../ui/viewerTools/data';
import { AI_COLOR, GUIDE_FRAG, JBU_GLSL } from './_shared';
import { featherPass, RAMP_GLSL } from './segment-shared';

const SIZE = 1024;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
const MASKS = ['Auto (best score)', 'Mask 1', 'Mask 2', 'Mask 3'];

export interface Embedding {
  emb: Float32Array;
  embDims: number[];
  pos: Float32Array;
  posDims: number[];
  /** Resized image size inside the 1024² frame. */
  w: number;
  h: number;
}

const memo = new InferenceMemo<Embedding>(4);
const decoded = new WeakMap<Embedding, Map<string, Promise<RawTex>>>();

/** Resized (longest side 1024) dims. */
function frame(w: number, h: number): [number, number] {
  const k = SIZE / Math.max(w, h);
  return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
}
/** Low-res mask dims (the 256² decoder output cropped to the image). */
function lowRes(w: number, h: number): [number, number] {
  const [fw, fh] = frame(w, h);
  return [Math.max(1, Math.round(fw / 4)), Math.max(1, Math.round(fh / 4))];
}

/**
 * SAM image embedding of `src` from the shared memo (the same entry Click Select uses), for other nodes that feed
 * SAM their own prompts (e.g. ai.textSelect's detected boxes). `w`/`h` of the result = the image inside the 1024² frame.
 */
export function samEmbedding(src: RawTex, signal?: AbortSignal): Promise<Embedding> {
  const [w, h] = frame(src.width, src.height);
  const rgb = resampleRGB(src.data, src.width, src.height, w, h);
  return memo.get('slimsam', fingerprint(rgb, w, h), Math.max(src.width, src.height), SIZE, () => encode(rgb, w, h), signal);
}

/**
 * Run the prompt decoder on several prompts at once (SAM's point batch). Points are 0..1 of the image, label 1 = include,
 * 0 = exclude. Returns per prompt the three IoU predictions and the three 256² mask logits (covering the 1024² frame).
 */
export async function samDecodeBatch(E: Embedding, prompts: { x: number; y: number; l: number }[][]): Promise<{ scores: Float32Array; masks: Float32Array; size: number }> {
  const n = Math.max(1, ...prompts.map((p) => p.length));
  const coords = new Float32Array(prompts.length * n * 2);
  const labels = new Float32Array(prompts.length * n).fill(-10); // -10 = padding point (ignored)
  prompts.forEach((pp, i) =>
    pp.forEach((p, j) => {
      coords[(i * n + j) * 2] = p.x * E.w;
      coords[(i * n + j) * 2 + 1] = p.y * E.h;
      labels[i * n + j] = p.l;
    }),
  );
  const r = await runModelMulti(
    'slimsam-decoder',
    {
      input_points: { data: coords, dims: [1, prompts.length, n, 2] },
      input_labels: { data: labels, dims: [1, prompts.length, n], type: 'int64' },
      image_embeddings: { data: E.emb.slice(), dims: E.embDims },
      image_positional_embeddings: { data: E.pos.slice(), dims: E.posDims },
    },
    ['iou_scores', 'pred_masks'],
  );
  if (!r.iou_scores || !r.pred_masks) throw new Error('SAM decoder returned no masks');
  return { scores: r.iou_scores.data, masks: r.pred_masks.data, size: r.pred_masks.dims[r.pred_masks.dims.length - 1] };
}

/** Low-res mask size (the part of SAM's 256² output covering the image) for an image of w×h. */
export const samLowRes = (w: number, h: number) => lowRes(w, h);

async function encode(rgb: Float32Array, w: number, h: number): Promise<Embedding> {
  const n = SIZE * SIZE;
  const px = new Float32Array(3 * n); // padded with 0 after normalisation (SamProcessor)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 3, d = y * SIZE + x;
      for (let c = 0; c < 3; c++) px[c * n + d] = (rgb[s + c] - MEAN[c]) / STD[c];
    }
  const r = await runModelMulti('slimsam-encoder', { pixel_values: { data: px, dims: [1, 3, SIZE, SIZE] } }, ['image_embeddings', 'image_positional_embeddings']);
  const e = r.image_embeddings, p = r.image_positional_embeddings;
  if (!e || !p) throw new Error('SAM encoder returned no embeddings');
  return { emb: e.data, embDims: e.dims, pos: p.data, posDims: p.dims, w, h };
}

async function decode(E: Embedding, params: Params): Promise<RawTex> {
  const pts = parsePoints(params.points);
  const box = parseBox(params.box);
  const prompt = pts.map((p) => ({ x: p.x, y: p.y, l: p.label }));
  // this SAM export has no box prompt (labels 2/3 behave like background): a box seeds its centre and clips
  if (box && !prompt.some((p) => p.l === 1)) prompt.push({ x: (box[0] + box[2]) / 2, y: (box[1] + box[3]) / 2, l: 1 });
  const [lw, lh] = lowRes(E.w, E.h);
  if (!prompt.length) return maskTex([0], 1, 1);
  const coords = new Float32Array(prompt.length * 2);
  prompt.forEach((p, i) => {
    coords[i * 2] = p.x * E.w;
    coords[i * 2 + 1] = p.y * E.h;
  });
  const r = await runModelMulti(
    'slimsam-decoder',
    {
      input_points: { data: coords, dims: [1, 1, prompt.length, 2] },
      input_labels: { data: Float32Array.from(prompt, (p) => p.l), dims: [1, 1, prompt.length], type: 'int64' },
      image_embeddings: { data: E.emb.slice(), dims: E.embDims },
      image_positional_embeddings: { data: E.pos.slice(), dims: E.posDims },
    },
    ['iou_scores', 'pred_masks'],
  );
  const scores = r.iou_scores?.data, masks = r.pred_masks;
  if (!scores || !masks) throw new Error('SAM decoder returned no masks');
  const [mh, mw] = masks.dims.slice(-2);
  const nm = masks.dims[masks.dims.length - 3] ?? 1;
  let idx = MASKS.indexOf(String(params.maskIndex)) - 1;
  if (idx < 0 || idx >= nm) {
    idx = 0;
    for (let i = 1; i < nm; i++) if (scores[i] > scores[idx]) idx = i;
  }
  const off = idx * mw * mh;
  const out = new Float32Array(lw * lh);
  // 256² covers the 1024² frame: crop to the image, logits → probability
  for (let y = 0; y < lh; y++)
    for (let x = 0; x < lw; x++) {
      const v = masks.data[off + Math.min(mh - 1, y) * mw + Math.min(mw - 1, x)];
      out[y * lw + x] = 1 / (1 + Math.exp(-v));
    }
  return maskTex(out, lw, lh);
}

const boxUniform = (p: Params) => {
  const b = parseBox(p.box);
  return b ? [b[0], b[1], b[2], b[3]] : [-1, -1, 2, 2];
};

const sam = defineNode({
  id: 'ai.segmentAnything',
  name: 'Click Select (SAM)',
  category: 'AI',
  color: AI_COLOR,
  description:
    'Select any object by clicking it in the viewer: SlimSAM (a pruned Segment Anything, ~14–21 MB) runs locally in your browser. ' +
    'Select this node, then click the object (green +); Alt-click or “Exclude” adds red − points to remove parts; drag on an empty area for a box. ' +
    'The image is encoded once (≈1–2 s on the CPU); every click after that takes a fraction of a second. ' +
    'Output: mask, selected = white, upsampled edge-aware against the image.',
  tags: ['segment anything', 'sam', 'click', 'select', 'selection', 'object', 'cutout', 'mask', 'magic wand', 'ai', 'ml'],
  inputs: { image: { type: 'image', label: 'Image' } },
  outputs: { mask: { type: 'mask', label: 'Mask' } },
  params: {
    points: { type: 'string', default: '', hidden: true, label: 'Points', description: 'JSON [{x,y,label}] in 0..1 (top-left origin); label 1 = include, 0 = exclude. Edit in the viewer.' },
    box: { type: 'string', default: '', hidden: true, label: 'Box', description: 'JSON [x0,y0,x1,y1] in 0..1, or empty.' },
    maskIndex: { type: 'enum', default: MASKS[0], options: MASKS, label: 'Mask', description: 'SAM proposes three masks at different granularities (e.g. a part vs the whole object); Auto takes the one with the best predicted IoU.' },
    threshold: { type: 'float', default: 0.5, min: 0.01, max: 0.99, step: 0.005, label: 'Threshold' },
    softness: { type: 'float', default: 0.15, min: 0, max: 1, step: 0.005, label: 'Edge softness' },
    refine: { type: 'float', default: 0.8, min: 0, max: 1, step: 0.01, label: 'Edge refine', description: 'Edge-aware upsampling against the image.' },
    feather: { type: 'float', default: 0, min: 0, max: 100, step: 0.5, pixels: true, label: 'Feather' },
    invert: { type: 'bool', default: false, label: 'Invert (select the rest)' },
  },
  viewerTool: { kind: 'points', param: 'points', boxParam: 'box', previewPort: 'mask' },
  cpuReadsInputs: true,
  cpu: async (ctx) => {
    const src = ctx.readInput('image');
    const pts = parsePoints(ctx.params.points);
    if (!src || (!pts.length && !parseBox(ctx.params.box))) return { lr: maskTex([0], 1, 1) };
    const [w, h] = frame(src.width, src.height);
    const rgb = resampleRGB(src.data, src.width, src.height, w, h);
    const E = await memo.get('slimsam', fingerprint(rgb, w, h), Math.max(src.width, src.height), SIZE, () => encode(rgb, w, h));
    let m = decoded.get(E);
    if (!m) decoded.set(E, (m = new Map()));
    const key = JSON.stringify([ctx.params.points, ctx.params.box, ctx.params.maskIndex]);
    let p = m.get(key);
    if (!p) {
      p = decode(E, ctx.params);
      p.catch(() => m!.delete(key));
      m.set(key, p);
      if (m.size > 24) m.delete(m.keys().next().value!);
    }
    return { lr: await p };
  },
  passes: [
    { size: (c) => lowRes(c.width, c.height), frag: GUIDE_FRAG },
    {
      frag: /* glsl */ `
${JBU_GLSL}
${RAMP_GLSL}
uniform vec4 u_boxR;
void main() {
  float m = u_refine <= 0.0 ? texture(u_lr, v_uv).r : jbu(u_lr, u_lr_size, u_pass0, u_refine, 0.15);
  m = ramp(m, u_threshold, u_softness);
  vec2 px = 1.5 / u_resolution;
  if (v_uv.x < u_boxR.x - px.x || v_uv.y < u_boxR.y - px.y || v_uv.x > u_boxR.z + px.x || v_uv.y > u_boxR.w + px.y) m = 0.0;
  fragColor = vec4(vec3(m), 1.0);
}`,
      uniforms: (c) => ({ u_boxR: boxUniform(c.params) }),
    },
    { frag: featherPass(false) },
    { frag: featherPass(true) },
  ],
});

export default [sam] satisfies NodeDef[];
