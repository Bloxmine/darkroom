/**
 * M-LSD line decoding (port of controlnet_aux `mlsd/utils.py` `pred_lines` /
 * `deccode_output_score_and_ptss`, NAVER, Apache-2.0). Pure functions, unit-tested.
 * Exports an empty NodeDef[] so the auto-registration glob is satisfied.
 */
import type { NodeDef } from '../../core/types';

export default [] as NodeDef[];

/**
 * Decode the M-LSD head `tp` ([C ≥ 5, h, w], ch0 = centre logits, ch1–4 = start/end displacement in grid px)
 * into segments [x0, y0, x1, y1, score, length] in *input* pixel units (length in grid px) (the grid is half the input size, as upstream:
 * `lines = 2 * segments`). 3×3 max-pool NMS, top-k, then `score > scoreThr && length > distThr`.
 */
export function decodeMlsd(tp: Float32Array, w: number, h: number, scoreThr = 0.1, distThr = 0.1, topk = 200, ksize = 3): number[][] {
  const n = w * h;
  const heat = new Float32Array(n);
  for (let i = 0; i < n; i++) heat[i] = 1 / (1 + Math.exp(-tp[i]));
  const r = (ksize - 1) >> 1;
  const cand: [number, number][] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = heat[y * w + x];
      let mx = v;
      for (let j = -r; j <= r; j++) {
        const yy = y + j;
        if (yy < 0 || yy >= h) continue;
        for (let i = -r; i <= r; i++) {
          const xx = x + i;
          if (xx < 0 || xx >= w) continue;
          if (heat[yy * w + xx] > mx) mx = heat[yy * w + xx];
        }
      }
      if (mx === v) cand.push([v, y * w + x]);
    }
  }
  cand.sort((a, b) => b[0] - a[0]);
  const out: number[][] = [];
  for (const [score, idx] of cand.slice(0, topk)) {
    const y = Math.floor(idx / w), x = idx % w;
    const d = (c: number) => tp[c * n + idx];
    const dxs = d(1), dys = d(2), dxe = d(3), dye = d(4);
    const dist = Math.hypot(dxs - dxe, dys - dye);
    if (score > scoreThr && dist > distThr) out.push([2 * (x + dxs), 2 * (y + dys), 2 * (x + dxe), 2 * (y + dye), score, dist]);
  }
  return out;
}

/** Pack an RGB HWC (0..1) image into the M-LSD input: [1, 4, h, w], RGB + a ones channel, all x·255/127.5 − 1. */
export function mlsdInput(rgb: Float32Array, w: number, h: number): Float32Array {
  const n = w * h;
  const out = new Float32Array(4 * n);
  for (let i = 0; i < n; i++) {
    out[i] = rgb[i * 3] * 2 - 1;
    out[n + i] = rgb[i * 3 + 1] * 2 - 1;
    out[2 * n + i] = rgb[i * 3 + 2] * 2 - 1;
    out[3 * n + i] = 1 / 127.5 - 1;
  }
  return out;
}
