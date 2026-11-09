import { describe, expect, it } from 'vitest';
import { boxFitScore, boxPrompts, iou, maskBox, nms, owlDetections, owlLogits, parsePrompts, selectDetections, sigmoid, type Box, type Detection } from './boxes';

const logit = (p: number) => Math.log(p / (1 - p));

describe('OWL class head', () => {
  it('computes (⟨c, t/‖t‖⟩ + shift) · scale', () => {
    // 2 patches, dim 2, 2 queries
    const cls = Float32Array.from([1, 0, 0.6, 0.8]);
    const shift = Float32Array.from([-1, 0.5]);
    const scale = Float32Array.from([2, 3]);
    const text = [Float32Array.from([3, 4]), Float32Array.from([0, 2])];
    const l = owlLogits(cls, shift, scale, text, 2);
    expect(l[0]).toBeCloseTo((0.6 - 1) * 2, 5); // p0 q0: ⟨(1,0),(0.6,0.8)⟩ = 0.6
    expect(l[1]).toBeCloseTo((0 - 1) * 2, 5); // p0 q1: ⟨(1,0),(0,1)⟩ = 0
    expect(l[2]).toBeCloseTo((1 + 0.5) * 3, 5); // p1 q0: 0.36 + 0.64
    expect(l[3]).toBeCloseTo((0.8 + 0.5) * 3, 5);
  });
});

describe('OWL detections', () => {
  // 3 patches × 2 queries; boxes cx cy w h
  const logits = Float32Array.from([logit(0.9), logit(0.1), logit(0.2), logit(0.6), logit(0.05), logit(0.02)]);
  const boxes = Float32Array.from([0.5, 0.5, 0.2, 0.4, 0.25, 0.25, 0.1, 0.1, 0.9, 0.9, 0.1, 0.1]);
  it('takes the best query per patch, thresholds and converts boxes', () => {
    const d = owlDetections(logits, boxes, 2, { threshold: 0.3, max: 10, texts: ['paddle', 'canoe'] });
    expect(d.length).toBe(2);
    expect(d[0].label).toBe(0);
    expect(d[0].text).toBe('paddle');
    expect(d[0].score).toBeCloseTo(0.9, 5);
    expect(d[0].box.map((v) => +v.toFixed(5))).toEqual([0.4, 0.3, 0.6, 0.7]);
    expect(d[1].label).toBe(1);
    expect(d[1].score).toBeCloseTo(0.6, 5);
  });
  it('rescales OWLv2 boxes from the padded square to the image', () => {
    // a 3:2 landscape padded to a square: the image is the top 2/3 → y × 1.5
    const d = owlDetections(logits, boxes, 2, { threshold: 0.5, max: 10, frameW: 1, frameH: 1.5 });
    expect(d[0].box.map((v) => +v.toFixed(5))).toEqual([0.4, 0.45, 0.6, 1]); // clipped to 1
  });
  it('drops boxes centred in the OWLv2 padding', () => {
    const b2 = Float32Array.from([0.5, 0.5, 0.2, 0.2, 0.5, 0.9, 0.1, 0.1, 0.9, 0.2, 0.1, 0.1]);
    const l2 = Float32Array.from([logit(0.9), logit(0.1), logit(0.99), logit(0.1), logit(0.8), logit(0.1)]);
    const d = owlDetections(l2, b2, 2, { threshold: 0.5, max: 10, frameW: 1, frameH: 1.5 });
    expect(d.map((x) => +x.score.toFixed(2))).toEqual([0.9, 0.8]); // the patch at y = 0.9 · 1.5 > 1 is padding
  });
  it('limits the count', () => expect(owlDetections(logits, boxes, 2, { threshold: 0.01, max: 1 }).length).toBe(1));
});

describe('NMS and selection', () => {
  const det = (box: Box, score: number, label = 0): Detection => ({ box, score, label, text: '' });
  it('iou', () => {
    expect(iou([0, 0, 1, 1], [0, 0, 1, 1])).toBe(1);
    expect(iou([0, 0, 0.5, 1], [0.5, 0, 1, 1])).toBe(0);
    expect(iou([0, 0, 0.5, 0.5], [0.25, 0.25, 0.75, 0.75])).toBeCloseTo(1 / 7, 6);
  });
  it('suppresses overlapping boxes of the same label only', () => {
    const k = nms([det([0, 0, 0.5, 0.5], 0.5), det([0.02, 0, 0.5, 0.5], 0.9), det([0.02, 0, 0.5, 0.5], 0.4, 1)], 0.3);
    expect(k.map((d) => d.score)).toEqual([0.9, 0.4]);
  });
  it('keeps all / best / nth', () => {
    const ds = [det([0, 0, 0.1, 0.1], 0.3), det([0.5, 0.5, 0.6, 0.6], 0.8), det([0.2, 0.2, 0.3, 0.3], 0.5)];
    expect(selectDetections(ds, 'All matches').map((d) => d.score)).toEqual([0.8, 0.5, 0.3]);
    expect(selectDetections(ds, 'Best match').map((d) => d.score)).toEqual([0.8]);
    expect(selectDetections(ds, 'Nth match', 2).map((d) => d.score)).toEqual([0.5]);
    expect(selectDetections(ds, 'Nth match', 7)).toEqual([]);
  });
});

describe('prompts', () => {
  it('splits on commas and marks subtractions', () => {
    expect(parsePrompts(' sky, water ,-shadows on the wall,, ')).toEqual([
      { text: 'sky', negative: false },
      { text: 'water', negative: false },
      { text: 'shadows on the wall', negative: true },
    ]);
  });
});

describe('SAM proposal vs box', () => {
  it('finds the mask bounding box', () => {
    const m = new Float32Array(16).fill(-1);
    m[5] = m[6] = m[10] = 1; // (1,1) (2,1) (2,2)
    expect(maskBox(m, 4, 4)).toEqual([0.25, 0.25, 0.75, 0.75]);
    expect(maskBox(new Float32Array(4).fill(-1), 2, 2)).toBeNull();
  });
  it('prefers the proposal that fills the box', () => {
    const w = 10, h = 10;
    const part = new Float32Array(100).fill(-1);
    const whole = new Float32Array(100).fill(-1);
    const spill = new Float32Array(100).fill(1);
    for (let y = 2; y < 8; y++) for (let x = 2; x < 8; x++) whole[y * w + x] = 1;
    for (let y = 2; y < 4; y++) for (let x = 2; x < 4; x++) part[y * w + x] = 1;
    const box: Box = [0.2, 0.2, 0.8, 0.8];
    const s = [part, whole, spill].map((m) => boxFitScore(m, w, h, w, 0, box, 0.9));
    expect(s[1]).toBeGreaterThan(s[0]);
    expect(s[1]).toBeGreaterThan(s[2]);
  });
  it('offers prompts inside the box', () => {
    for (const [p] of boxPrompts([0.2, 0.4, 0.6, 0.8])) {
      expect(p.x).toBeGreaterThan(0.2);
      expect(p.x).toBeLessThan(0.6);
      expect(p.y).toBeGreaterThan(0.4);
      expect(p.l).toBe(1);
    }
    expect(sigmoid(0)).toBe(0.5);
  });
});
