/**
 * Scene Segmentation: semantic classes (sky, people, vegetation, water, …) with DETR ResNet-50 panoptic
 * (COCO panoptic, Apache-2.0), in-browser. Inference runs once per image (memo by fingerprint);
 * switching the class only re-combines the cached query masks.
 *
 * Per pixel and class c: score_c = Σ_q p(c | q) · σ(mask_q); the class mask is the share of a friendly
 * group in the total (soft), then upsampled edge-aware against the image.
 */
import '../../core/ai/models-seg';
import { fingerprint, fitDims, InferenceMemo, resampleRGB, toCHW } from '../../core/ai/image';
import { runModelMulti } from '../../core/ai/runtime';
import { defineNode } from '../../core/registry';
import type { NodeDef, RawTex } from '../../core/types';
import { AI_COLOR, GUIDE_FRAG, JBU_GLSL } from './_shared';
import { featherPass, RAMP_GLSL } from './segment-shared';

/** COCO panoptic category ids (as used by facebook/detr-resnet-50-panoptic; logits index = id). */
const VEHICLES = [2, 3, 4, 5, 6, 7, 8, 9];
const ANIMALS = [16, 17, 18, 19, 20, 21, 22, 23, 24, 25];
const BUILDING = [197, 128, 151, 95, 171, 175, 176, 177, 199, 181, 180, 185, 166];
const ROAD = [149, 191, 147, 144];
const GROUND = [194, 154, 125, 159, 145];
const WATER = [148, 155, 178];

/** Friendly classes for the `class` param (may overlap). */
const CLASSES: [string, number[]][] = [
  ['Sky', [187]],
  ['Person', [1]],
  ['Vegetation (trees, grass, plants)', [184, 193, 119, 64]],
  ['Trees', [184]],
  ['Grass', [193]],
  ['Water (sea, river, lake)', WATER],
  ['Mountain & hills', [192]],
  ['Rock', [198]],
  ['Building & walls', BUILDING],
  ['Road & pavement', ROAD],
  ['Ground (dirt, sand, gravel, snow)', GROUND],
  ['Snow', [159]],
  ['Vehicles (car, bus, boat…)', VEHICLES],
  ['Animals', ANIMALS],
  ['Landscape (not sky)', []], // special: 1 − sky
];

/** Exclusive groups for the colour-coded label map. */
const LABELS: [string, number[], [number, number, number]][] = [
  ['Sky', [187], [0.45, 0.7, 1]],
  ['Person', [1], [1, 0.35, 0.35]],
  ['Trees', [184, 64], [0.1, 0.55, 0.2]],
  ['Grass & flowers', [193, 119], [0.55, 0.85, 0.3]],
  ['Water', WATER, [0.1, 0.3, 0.85]],
  ['Mountain', [192], [0.55, 0.45, 0.6]],
  ['Rock', [198], [0.6, 0.6, 0.55]],
  ['Building', BUILDING, [0.85, 0.6, 0.3]],
  ['Road', ROAD, [0.4, 0.4, 0.42]],
  ['Ground', GROUND, [0.8, 0.72, 0.5]],
  ['Vehicles', VEHICLES, [0.95, 0.85, 0.1]],
  ['Animals', ANIMALS, [0.9, 0.4, 0.85]],
];
const OTHER: [number, number, number] = [0.18, 0.18, 0.18];

interface Seg {
  /** Per query: class probabilities (softmax over 251, the last = no object). */
  probs: Float32Array;
  nq: number;
  nc: number;
  /** Per query: sigmoid mask, mw×mh. */
  masks: Float32Array;
  mw: number;
  mh: number;
  /** Per pixel: Σ_q (1 − p_noobj) σ(m_q). */
  total: Float32Array;
}

const memo = new InferenceMemo<Seg>(4);
const res = (v: unknown) => Number(v) || 512;

async function infer(rgb: Float32Array, w: number, h: number): Promise<Seg> {
  const r = await runModelMulti(
    'detr-panoptic',
    {
      pixel_values: { data: toCHW(rgb, w, h, [0.485, 0.456, 0.406], [0.229, 0.224, 0.225]), dims: [1, 3, h, w] },
      // the export declares a fixed 64×64 pixel_mask; it is resized to the feature map inside, all ones = no padding
      pixel_mask: { data: new Float32Array(64 * 64).fill(1), dims: [1, 64, 64], type: 'int64' },
    },
    ['logits', 'pred_masks'],
  );
  const lg = r.logits!, pm = r.pred_masks!;
  const [nq, nc] = lg.dims.slice(-2);
  const [mh, mw] = pm.dims.slice(-2);
  const probs = new Float32Array(nq * nc);
  for (let q = 0; q < nq; q++) {
    let mx = -Infinity;
    for (let c = 0; c < nc; c++) mx = Math.max(mx, lg.data[q * nc + c]);
    let s = 0;
    for (let c = 0; c < nc; c++) s += probs[q * nc + c] = Math.exp(lg.data[q * nc + c] - mx);
    for (let c = 0; c < nc; c++) probs[q * nc + c] /= s;
  }
  const n = mw * mh;
  const masks = pm.data;
  for (let i = 0; i < masks.length; i++) masks[i] = 1 / (1 + Math.exp(-masks[i]));
  const total = new Float32Array(n);
  for (let q = 0; q < nq; q++) {
    const wq = 1 - probs[q * nc + nc - 1];
    if (wq < 1e-3) continue;
    for (let i = 0; i < n; i++) total[i] += wq * masks[q * n + i];
  }
  return { probs, nq, nc, masks, mw, mh, total };
}

/** Σ_q P_q(group) σ(m_q), per pixel. */
function groupScore(S: Seg, ids: number[]): Float32Array {
  const n = S.mw * S.mh;
  const out = new Float32Array(n);
  for (let q = 0; q < S.nq; q++) {
    let p = 0;
    for (const c of ids) if (c < S.nc - 1) p += S.probs[q * S.nc + c];
    if (p < 1e-3) continue;
    for (let i = 0; i < n; i++) out[i] += p * S.masks[q * n + i];
  }
  return out;
}

function classMask(S: Seg, cls: string): RawTex {
  const entry = CLASSES.find((c) => c[0] === cls) ?? CLASSES[0];
  const inv = entry[1].length === 0;
  const sc = groupScore(S, inv ? [187] : entry[1]);
  const n = S.mw * S.mh;
  const data = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    let v = Math.min(1, sc[i] / Math.max(S.total[i], 1e-4));
    if (inv) v = 1 - v;
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v;
    data[i * 4 + 3] = 1;
  }
  return { width: S.mw, height: S.mh, data };
}

const labelCache = new WeakMap<Seg, RawTex>();
function labelMap(S: Seg): RawTex {
  let t = labelCache.get(S);
  if (t) return t;
  const n = S.mw * S.mh;
  const scores = LABELS.map((l) => groupScore(S, l[1]));
  const data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    let best = -1, bv = 0.25 * S.total[i]; // below a quarter of the coverage → "other"
    for (let k = 0; k < scores.length; k++) if (scores[k][i] > bv) {
        bv = scores[k][i];
        best = k;
      }
    const c = best >= 0 ? LABELS[best][2] : OTHER;
    data[i * 4] = c[0] * 255;
    data[i * 4 + 1] = c[1] * 255;
    data[i * 4 + 2] = c[2] * 255;
    data[i * 4 + 3] = 255;
  }
  t = { width: S.mw, height: S.mh, data, filter: 'nearest' };
  labelCache.set(S, t);
  return t;
}

/** Mask dims (1/4 of the inference size). */
const maskDims = (w: number, h: number, short: number): [number, number] => {
  const [iw, ih] = fitDims(w, h, short, 32);
  return [Math.ceil(iw / 4), Math.ceil(ih / 4)];
};

const scene = defineNode({
  id: 'ai.sceneSegment',
  name: 'Scene Segmentation',
  category: 'AI',
  color: AI_COLOR,
  description:
    'Finds what is where in a photo: sky, people, trees, grass, water, mountains, buildings, roads, ground, vehicles, animals. ' +
    'DETR ResNet-50 panoptic (COCO, Apache-2.0, ~87 MB, downloads once) runs locally in your browser; the result is cached per image, so switching the class is instant. ' +
    'Output “mask” = the chosen class (white), refined edge-aware against the image; “labels” = a colour-coded map of all classes.',
  tags: ['segmentation', 'semantic', 'sky', 'sky replacement', 'sky mask', 'person', 'tree', 'vegetation', 'water', 'building', 'road', 'scene', 'parse', 'ai', 'ml', 'mask', 'detr'],
  inputs: { image: { type: 'image', label: 'Image' } },
  outputs: { mask: { type: 'mask', label: 'Mask' }, labels: { type: 'image', label: 'Labels' } },
  params: {
    class: { type: 'enum', default: CLASSES[0][0], options: CLASSES.map((c) => c[0]), label: 'Class' },
    resolution: { type: 'enum', default: '512', options: ['384', '512', '640', '800'], label: 'Inference size', description: 'Short side fed to the model (800 = training size, most detail; 384 = fastest).' },
    threshold: { type: 'float', default: 0.5, min: 0.01, max: 0.99, step: 0.005, label: 'Threshold' },
    softness: { type: 'float', default: 0.5, min: 0, max: 1, step: 0.005, label: 'Softness', description: '1 = keep the soft class probability, 0 = hard cut.' },
    refine: { type: 'float', default: 0.9, min: 0, max: 1, step: 0.01, label: 'Edge refine', description: 'Edge-aware upsampling against the image (keeps tree branches out of the sky).' },
    feather: { type: 'float', default: 0, min: 0, max: 100, step: 0.5, pixels: true, label: 'Feather' },
    invert: { type: 'bool', default: false, label: 'Invert' },
  },
  cpuReadsInputs: true,
  cpu: async (ctx) => {
    const src = ctx.readInput('image');
    if (!src) return { cls: { width: 1, height: 1, data: new Float32Array([0, 0, 0, 1]) }, lab: { width: 1, height: 1, data: new Uint8Array([40, 40, 40, 255]) } };
    const short = res(ctx.params.resolution);
    const [w, h] = fitDims(src.width, src.height, short, 32);
    const rgb = resampleRGB(src.data, src.width, src.height, w, h);
    const S = await memo.get(`detr:${short}`, fingerprint(rgb, w, h), Math.min(src.width, src.height), short, () => infer(rgb, w, h));
    return { cls: classMask(S, String(ctx.params.class)), lab: labelMap(S) };
  },
  passes: [
    { size: (c) => maskDims(c.width, c.height, res(c.params.resolution)), frag: GUIDE_FRAG },
    {
      frag: /* glsl */ `
${JBU_GLSL}
${RAMP_GLSL}
void main() {
  float m = u_refine <= 0.0 ? texture(u_cls, v_uv).r : jbu(u_cls, u_cls_size, u_pass0, u_refine, 0.1);
  fragColor = vec4(vec3(ramp(m, u_threshold, u_softness)), 1.0);
}`,
    },
    { frag: featherPass(false) },
    { frag: featherPass(true), output: 'mask' },
    {
      output: 'labels',
      frag: /* glsl */ `
void main() {
  vec3 l = texture(u_lab, v_uv).rgb;
  vec3 img = texture(u_image, v_uv).rgb;
  fragColor = vec4(mix(l, l * (0.55 + 0.6 * luma(img)), 0.6), 1.0);
}`,
    },
  ],
});

export default [scene] satisfies NodeDef[];
