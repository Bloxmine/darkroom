/**
 * control.seg: semantic segmentation map coloured with the ADE20K palette the ControlNet seg model expects.
 * Uses the DETR ResNet-50 panoptic model of ai.sceneSegment (COCO panoptic, Apache-2.0; same download), with
 * each COCO category mapped to its closest ADE20K class (_palettes.ts). Per pixel the winning query is the
 * one with the highest P(mapped class) · σ(mask), panoptic style, so the map has hard class regions.
 */
import '../../core/ai/models-seg';
import { fingerprint, fitDims, InferenceMemo, resampleRGB, toCHW } from '../../core/ai/image';
import { runModelMulti } from '../../core/ai/runtime';
import { defineNode } from '../../core/registry';
import type { NodeDef, RawTex } from '../../core/types';
import { CATEGORY, CONTROL_COLOR, detectDims, resolutionParam } from './_shared';
import { adeIndexOfCoco, ADE20K_PALETTE } from './_palettes';

interface Det {
  /** Per query: [ADE index, probability of that ADE class]. */
  cls: Int16Array;
  p: Float32Array;
  /** Sigmoid masks nq × mh × mw. */
  masks: Float32Array;
  nq: number;
  mw: number;
  mh: number;
}

const memo = new InferenceMemo<Det>(4);
/** COCO id → ADE index, for all 250 logits (−1 = unmapped). */
const MAP = Array.from({ length: 251 }, (_, i) => adeIndexOfCoco(i));

async function detect(rgb: Float32Array, w: number, h: number): Promise<Det> {
  const r = await runModelMulti(
    'detr-panoptic',
    {
      pixel_values: { data: toCHW(rgb, w, h, [0.485, 0.456, 0.406], [0.229, 0.224, 0.225]), dims: [1, 3, h, w] },
      pixel_mask: { data: new Float32Array(64 * 64).fill(1), dims: [1, 64, 64], type: 'int64' },
    },
    ['logits', 'pred_masks'],
  );
  const lg = r.logits!, pm = r.pred_masks!;
  const [nq, nc] = lg.dims.slice(-2);
  const [mh, mw] = pm.dims.slice(-2);
  const cls = new Int16Array(nq), p = new Float32Array(nq);
  const acc = new Float32Array(150);
  for (let q = 0; q < nq; q++) {
    let mx = -Infinity;
    for (let c = 0; c < nc; c++) mx = Math.max(mx, lg.data[q * nc + c]);
    let s = 0;
    for (let c = 0; c < nc; c++) s += Math.exp(lg.data[q * nc + c] - mx);
    acc.fill(0);
    for (let c = 0; c < nc - 1; c++) {
      const a = MAP[c];
      if (a >= 0) acc[a] += Math.exp(lg.data[q * nc + c] - mx) / s;
    }
    let best = 0;
    for (let a = 1; a < 150; a++) if (acc[a] > acc[best]) best = a;
    cls[q] = best;
    p[q] = acc[best];
  }
  const masks = pm.data;
  for (let i = 0; i < masks.length; i++) masks[i] = 1 / (1 + Math.exp(-masks[i]));
  return { cls, p, masks, nq, mw, mh };
}

/** ADE-coloured label map at W×H (RGBA8, nearest). */
function render(D: Det, W: number, H: number, minP: number): RawTex {
  const qs: number[] = [];
  for (let q = 0; q < D.nq; q++) if (D.p[q] > minP) qs.push(q);
  const out = new Uint8Array(W * H * 4);
  const n = D.mw * D.mh;
  for (let y = 0; y < H; y++) {
    const fy = Math.min(D.mh - 1, Math.max(0, ((y + 0.5) / H) * D.mh - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(D.mh - 1, y0 + 1), b = fy - y0;
    for (let x = 0; x < W; x++) {
      const fx = Math.min(D.mw - 1, Math.max(0, ((x + 0.5) / W) * D.mw - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(D.mw - 1, x0 + 1), a = fx - x0;
      let best = -1, bv = -1;
      for (const q of qs) {
        const o = q * n;
        const m = (D.masks[o + y0 * D.mw + x0] * (1 - a) + D.masks[o + y0 * D.mw + x1] * a) * (1 - b) + (D.masks[o + y1 * D.mw + x0] * (1 - a) + D.masks[o + y1 * D.mw + x1] * a) * b;
        const v = m * D.p[q];
        if (v > bv) {
          bv = v;
          best = q;
        }
      }
      const c = best >= 0 ? ADE20K_PALETTE[D.cls[best]] : [0, 0, 0];
      const i = (y * W + x) * 4;
      out[i] = c[0];
      out[i + 1] = c[1];
      out[i + 2] = c[2];
      out[i + 3] = 255;
    }
  }
  return { width: W, height: H, data: out, filter: 'nearest' };
}

const seg = defineNode({
  id: 'control.seg',
  name: 'Segmentation (ControlNet)',
  category: CATEGORY,
  color: CONTROL_COLOR,
  heavy: true,
  description:
    'Semantic segmentation map for the ControlNet seg model, coloured with the ADE20K palette it was trained on (e.g. sky = cyan 6,230,230, tree = green 4,200,3, person = 150,5,61). ' +
    'Runs DETR panoptic (COCO, Apache-2.0, the Scene Segmentation model) locally; COCO categories are mapped to the nearest ADE20K class, so it covers about 70 of the 150 ADE20K classes.',
  tags: ['controlnet', 'seg', 'segmentation', 'ade20k', 'semantic', 'oneformer', 'uniformer', 'control map', 'stable diffusion', 'preprocessor'],
  inputs: { image: { type: 'image', label: 'Image' } },
  params: {
    resolution: resolutionParam(512),
    inference: { type: 'enum', default: '512', options: ['384', '512', '640', '800'], label: 'Inference size', description: 'Short side fed to DETR (800 = training size).' },
    minConfidence: { type: 'float', default: 0.2, min: 0.01, max: 0.9, step: 0.01, label: 'Min class confidence', description: 'Queries less sure than this about their class are ignored.' },
  },
  cpuReadsInputs: true,
  cpu: async (ctx) => {
    const src = ctx.readInput('image');
    if (!src) return { m: { width: 1, height: 1, data: new Uint8Array([0, 0, 0, 255]) } };
    const short = Number(ctx.params.inference) || 512;
    const [w, h] = fitDims(src.width, src.height, short, 32);
    const rgb = resampleRGB(src.data, src.width, src.height, w, h);
    const D = await memo.get(`detr-ade:${short}`, fingerprint(rgb, w, h), Math.min(src.width, src.height), short, () => detect(rgb, w, h));
    const [W, H] = detectDims(src.width, src.height, Number(ctx.params.resolution) || 512);
    return { m: render(D, W, H, Number(ctx.params.minConfidence ?? 0.2)) };
  },
  passes: [{ frag: `void main() { fragColor = vec4(texture(u_m, v_uv).rgb, 1.0); }` }],
});

export default [seg] satisfies NodeDef[];
