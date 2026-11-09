/**
 * Box / score post-processing for the vision-language nodes (pure functions, unit-tested in boxes.test.ts):
 * OWL class-head logits, OWL detections (per-patch best query, sigmoid, threshold, cxcywh → xyxy, OWLv2 square-pad
 * rescale, class-wise NMS), the keep-all / best / nth selection, prompt parsing, and choosing the SAM mask that fits a
 * detected box best.
 */

/** Axis-aligned box, normalised 0..1 of the image (top-left origin): [x0, y0, x1, y1]. */
export type Box = [number, number, number, number];

export interface Detection {
  box: Box;
  score: number;
  /** Index of the query (prompt part) that matched. */
  label: number;
  text: string;
}

export const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

export function iou(a: Box, b: Box): number {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return ua > 0 ? inter / ua : 0;
}

/**
 * OWL class head in JS (the part of the graph that mixes image and text):
 * logits[p, q] = (⟨ĉ_p, t̂_q⟩ + shift_p) · scale_p, with ĉ the (already normalised) image class embeddings and
 * t̂ the text embeddings normalised by ‖t‖ + 1e-6 (as in transformers' OwlViTClassPredictionHead).
 */
export function owlLogits(cls: Float32Array, shift: Float32Array, scale: Float32Array, text: Float32Array[], dim: number): Float32Array {
  const P = shift.length, Q = text.length;
  const tn = text.map((t) => {
    let n = 0;
    for (let i = 0; i < dim; i++) n += t[i] * t[i];
    const k = 1 / (Math.sqrt(n) + 1e-6);
    return t.map((v) => v * k);
  });
  const out = new Float32Array(P * Q);
  for (let p = 0; p < P; p++) {
    const o = p * dim;
    for (let q = 0; q < Q; q++) {
      const t = tn[q];
      let d = 0;
      for (let i = 0; i < dim; i++) d += cls[o + i] * t[i];
      out[p * Q + q] = (d + shift[p]) * scale[p];
    }
  }
  return out;
}

export interface DetectOpts {
  threshold: number;
  /** Max detections returned (after NMS). */
  max: number;
  /** IoU above which a lower-scored box of the same label is dropped. */
  nms?: number;
  /** The model's box frame relative to the image: OWLv2 pads to a square, so boxes are in units of the long side. */
  frameW?: number;
  frameH?: number;
  /** Query texts (for Detection.text). */
  texts?: string[];
}

/** OWL logits (P×Q) + boxes (P×4, cx cy w h in 0..1 of the model frame) → detections sorted by score. */
export function owlDetections(logits: Float32Array, boxes: Float32Array, Q: number, o: DetectOpts): Detection[] {
  const P = boxes.length / 4;
  const fw = o.frameW ?? 1, fh = o.frameH ?? 1;
  const cand: Detection[] = [];
  for (let p = 0; p < P; p++) {
    let best = 0;
    for (let q = 1; q < Q; q++) if (logits[p * Q + q] > logits[p * Q + best]) best = q;
    const s = sigmoid(logits[p * Q + best]);
    if (s < o.threshold) continue;
    const [cx, cy, w, h] = [boxes[p * 4], boxes[p * 4 + 1], boxes[p * 4 + 2], boxes[p * 4 + 3]];
    // OWLv2: patches over the grey padding produce boxes outside the image, and a few border patches of the q4f16
    // export come out degenerate (identical features, centre pinned to the frame edge, ~100 %): skip both
    if (cx * fw > 1 || cy * fh > 1 || cx <= 0.002 || cy <= 0.002 || cx >= 0.998 || cy >= 0.998) continue;
    const b: Box = [(cx - w / 2) * fw, (cy - h / 2) * fh, (cx + w / 2) * fw, (cy + h / 2) * fh].map((v) => Math.min(1, Math.max(0, v))) as Box;
    if (b[2] - b[0] <= 1e-4 || b[3] - b[1] <= 1e-4) continue;
    cand.push({ box: b, score: s, label: best, text: o.texts?.[best] ?? '' });
  }
  return nms(cand, o.nms ?? 0.3).slice(0, Math.max(0, o.max));
}

/** Greedy class-wise non-maximum suppression; returns the kept detections by descending score. */
export function nms(dets: Detection[], thr: number): Detection[] {
  const sorted = [...dets].sort((a, b) => b.score - a.score);
  const keep: Detection[] = [];
  for (const d of sorted) if (!keep.some((k) => k.label === d.label && iou(k.box, d.box) > thr)) keep.push(d);
  return keep;
}

export const KEEP_MODES = ['All matches', 'Best match', 'Nth match'];

/** Which detections to keep: all, the best one, or the nth best (1-based; sorted by score). */
export function selectDetections(dets: Detection[], mode: string, nth = 1): Detection[] {
  const s = [...dets].sort((a, b) => b.score - a.score);
  if (mode === KEEP_MODES[1]) return s.slice(0, 1);
  if (mode === KEEP_MODES[2]) {
    const d = s[Math.max(1, Math.round(nth)) - 1];
    return d ? [d] : [];
  }
  return s;
}

/** "red jacket, paddle" → ["red jacket", "paddle"]; a leading "-" marks a part to subtract (CLIPSeg). */
export function parsePrompts(s: string): { text: string; negative: boolean }[] {
  return String(s ?? '')
    .split(/[,;\n]/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => (t.startsWith('-') ? { text: t.slice(1).trim(), negative: true } : { text: t, negative: false }))
    .filter((t) => t.text);
}

/** Bounding box (normalised to w×h) of the cells where `m` > thr, or null if empty. */
export function maskBox(m: ArrayLike<number>, w: number, h: number, thr = 0, stride = w, off = 0): Box | null {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (m[off + y * stride + x] > thr) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  return x1 < 0 ? null : [x0 / w, y0 / h, (x1 + 1) / w, (y1 + 1) / h];
}

/**
 * How well a SAM proposal fits a detected box: IoU of the mask's bounding box with the box, minus the share of the
 * mask outside the (slightly grown) box, plus a little of SAM's own IoU prediction.
 * `m` = logits of one proposal (row stride `stride`, the w×h image part used).
 */
export function boxFitScore(m: ArrayLike<number>, w: number, h: number, stride: number, off: number, box: Box, predIou: number): number {
  const mb = maskBox(m, w, h, 0, stride, off);
  if (!mb) return -1;
  const gx = (box[2] - box[0]) * 0.08, gy = (box[3] - box[1]) * 0.08;
  const bx0 = (box[0] - gx) * w, bx1 = (box[2] + gx) * w, by0 = (box[1] - gy) * h, by1 = (box[3] + gy) * h;
  let inside = 0, total = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (m[off + y * stride + x] > 0) {
        total++;
        if (x + 0.5 >= bx0 && x + 0.5 <= bx1 && y + 0.5 >= by0 && y + 0.5 <= by1) inside++;
      }
  const outside = total ? 1 - inside / total : 1;
  return iou(mb, box) - outside + 0.15 * predIou;
}

/** Candidate SAM point prompts for a box: its centre and points on both diagonals and the two mid-lines. */
export function boxPrompts(b: Box): { x: number; y: number; l: number }[][] {
  const at = (u: number, v: number) => [{ x: b[0] + (b[2] - b[0]) * u, y: b[1] + (b[3] - b[1]) * v, l: 1 }];
  return [at(0.5, 0.5), at(0.3, 0.3), at(0.7, 0.7), at(0.3, 0.7), at(0.7, 0.3), at(0.5, 0.3), at(0.5, 0.7), at(0.3, 0.5), at(0.7, 0.5)];
}
