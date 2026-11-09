/**
 * Shared bits for the vision-language nodes (vl-*.ts): the region overlay (boxes / quads with labels and scores,
 * drawn on a transparent canvas and composited over the image in a pass), status messages, and SAM refinement of
 * detected boxes (reusing Click Select's cached SAM image embedding).
 * Exports an empty NodeDef[] so the auto-registration glob is satisfied.
 */
import type { Box } from '../../core/ai/vl/boxes';
import { boxFitScore, boxPrompts, sigmoid } from '../../core/ai/vl/boxes';
import { maskTex } from '../../core/ai/image';
import type { NodeDef, RawTex } from '../../core/types';
import { makeCanvas, rasterSize } from './face-draw';
import { samDecodeBatch, samEmbedding, samLowRes, type Embedding } from './segment-sam';

export default [] as NodeDef[];

export function vlStatus(msg: string, kind: 'info' | 'error' = 'info') {
  const ui = (globalThis as { __darkroom?: { ui?: { setState(p: object): void } } }).__darkroom?.ui;
  ui?.setState({ message: msg, messageKind: kind });
}

export interface Region {
  /** Axis-aligned box (0..1) or a quad [x,y]×4 (0..1, OCR regions). */
  box?: Box;
  quad?: number[];
  label: string;
  score?: number;
  /** Drawn solid when selected, thin + dashed otherwise. */
  selected?: boolean;
  /** Colour index (e.g. the prompt part); default: the region's index. */
  group?: number;
}

const PALETTE = ['#ffd23f', '#3fd2ff', '#ff6b9d', '#7dff6b', '#c58bff', '#ff9f43', '#4dffd2', '#ff5e5e'];

/** Transparent overlay canvas (≤ 2048 px long side) with every region outlined and labelled. */
export function regionOverlay(w: number, h: number, regions: Region[], colorBy: (r: Region, i: number) => number = (r, i) => r.group ?? i) {
  const [rw, rh] = rasterSize(w, h);
  const { canvas, g } = makeCanvas(rw, rh);
  const font = Math.max(11, Math.round(Math.min(rw, rh) * 0.024));
  const lw = Math.max(1.5, Math.min(rw, rh) / 320);
  g.font = `600 ${font}px system-ui, -apple-system, Helvetica, Arial, sans-serif`;
  g.textBaseline = 'top';
  regions.forEach((r, i) => {
    const col = PALETTE[colorBy(r, i) % PALETTE.length];
    g.strokeStyle = col;
    g.lineWidth = r.selected === false ? lw * 0.6 : lw;
    g.setLineDash(r.selected === false ? [lw * 4, lw * 3] : []);
    let lx = 0, ly = 0;
    g.beginPath();
    if (r.quad && r.quad.length >= 8) {
      for (let k = 0; k < 4; k++) (k ? g.lineTo : g.moveTo).call(g, r.quad[k * 2] * rw, r.quad[k * 2 + 1] * rh);
      g.closePath();
      lx = Math.min(r.quad[0], r.quad[6]) * rw;
      ly = Math.min(r.quad[1], r.quad[3]) * rh;
    } else if (r.box) {
      g.rect(r.box[0] * rw, r.box[1] * rh, (r.box[2] - r.box[0]) * rw, (r.box[3] - r.box[1]) * rh);
      lx = r.box[0] * rw;
      ly = r.box[1] * rh;
    }
    g.stroke();
    g.setLineDash([]);
    const text = r.score !== undefined ? `${r.label} ${(r.score * 100).toFixed(0)}%` : r.label;
    if (!text) return;
    const tw = g.measureText(text).width + font * 0.6;
    const th = font * 1.35;
    const ty = ly - th >= 0 ? ly - th : ly;
    const tx = Math.min(Math.max(0, lx - lw / 2), rw - tw);
    g.globalAlpha = r.selected === false ? 0.6 : 0.88;
    g.fillStyle = col;
    g.fillRect(tx, ty, tw, th);
    g.globalAlpha = 1;
    g.fillStyle = '#111';
    g.fillText(text, tx + font * 0.3, ty + font * 0.18);
  });
  return canvas;
}

export const CLEAR: RawTex = { width: 1, height: 1, data: new Float32Array([0, 0, 0, 0]) };
export const BLACK = maskTex([0], 1, 1);

/** Overlay pass: the image, the mask tinted in `tint` (alpha = strength), then the canvas on top. */
export const OVERLAY_FRAG = /* glsl */ `
void main() {
  vec4 c = texture(u_image, v_uv);
  float m = texture(u_prev, v_uv).r;
  vec3 rgb = mix(c.rgb, u_tint.rgb, m * u_tint.a);
  vec4 o = texture(u_ov, v_uv);
  fragColor = vec4(mix(rgb, o.rgb, o.a), c.a);
}`;

const samMemo = new WeakMap<Embedding, Map<string, Promise<Float32Array>>>();

/**
 * SAM mask probability (low-res, samLowRes(srcW, srcH)) for a detected box: nine point prompts inside the box are
 * decoded in one batch, and of the 27 proposals the one whose bounding box fits the detection best wins (this SAM
 * export has no box prompt). The result is clipped to the box grown by 8 %. Memoised per image embedding + box.
 */
export async function samForBox(src: RawTex, box: Box, signal?: AbortSignal): Promise<{ data: Float32Array; w: number; h: number }> {
  const E = await samEmbedding(src, signal);
  const [lw, lh] = samLowRes(src.width, src.height);
  let m = samMemo.get(E);
  if (!m) samMemo.set(E, (m = new Map()));
  const key = box.map((v) => v.toFixed(4)).join(',');
  let p = m.get(key);
  if (!p) {
    p = (async () => {
      const prompts = boxPrompts(box);
      const r = await samDecodeBatch(E, prompts);
      const S = r.size, per = S * S;
      let best = 0, bestScore = -Infinity;
      for (let i = 0; i < prompts.length * 3; i++) {
        const s = boxFitScore(r.masks, lw, lh, S, i * per, box, r.scores[i]);
        if (s > bestScore) {
          bestScore = s;
          best = i;
        }
      }
      const gx = (box[2] - box[0]) * 0.08 + 1 / lw, gy = (box[3] - box[1]) * 0.08 + 1 / lh;
      const out = new Float32Array(lw * lh);
      for (let y = 0; y < lh; y++) {
        const v = (y + 0.5) / lh;
        if (v < box[1] - gy || v > box[3] + gy) continue;
        for (let x = 0; x < lw; x++) {
          const u = (x + 0.5) / lw;
          if (u < box[0] - gx || u > box[2] + gx) continue;
          out[y * lw + x] = sigmoid(r.masks[best * per + Math.min(S - 1, y) * S + Math.min(S - 1, x)]);
        }
      }
      return out;
    })();
    p.catch(() => m!.delete(key));
    m.set(key, p);
    if (m.size > 64) m.delete(m.keys().next().value!);
  }
  return { data: await p, w: lw, h: lh };
}

/** Low-res mask of filled boxes (when SAM refinement is off), at samLowRes size so both modes share the passes. */
export function boxMask(src: RawTex, boxes: Box[]): { data: Float32Array; w: number; h: number } {
  const [lw, lh] = samLowRes(src.width, src.height);
  const out = new Float32Array(lw * lh);
  for (const b of boxes)
    for (let y = Math.floor(b[1] * lh); y < Math.ceil(b[3] * lh); y++)
      for (let x = Math.floor(b[0] * lw); x < Math.ceil(b[2] * lw); x++) if (x >= 0 && y >= 0 && x < lw && y < lh) out[y * lw + x] = 1;
  return { data: out, w: lw, h: lh };
}
