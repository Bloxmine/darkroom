import { describe, expect, it } from 'vitest';
import {
  affineScale, applyAffine, convexHull, decodeYunet, FFHQ_512, fivePoints, invertAffine, iou, mergeFaces, nms, similarity, type FaceLm, type Pt,
} from './face-geom';

const close = (a: Pt, b: Pt, d = 1e-6) => {
  expect(a[0]).toBeCloseTo(b[0], -Math.log10(d));
  expect(a[1]).toBeCloseTo(b[1], -Math.log10(d));
};

describe('similarity transform', () => {
  it('recovers an exact rotation + scale + translation', () => {
    const th = 0.3, s = 1.7, tx = 40, ty = -12;
    const f = (p: Pt): Pt => [s * (Math.cos(th) * p[0] - Math.sin(th) * p[1]) + tx, s * (Math.sin(th) * p[0] + Math.cos(th) * p[1]) + ty];
    const src: Pt[] = [[10, 20], [60, 22], [35, 50], [15, 70], [55, 72]];
    const M = similarity(src, src.map(f));
    for (const p of src) close(applyAffine(M, p), f(p), 1e-6);
    expect(affineScale(M)).toBeCloseTo(s, 9);
  });

  it('is the least-squares fit for noisy points and inverts exactly', () => {
    const src: Pt[] = FFHQ_512.map(([x, y]) => [x / 4 + 100, y / 4 + 50]);
    const M = similarity(src, FFHQ_512);
    expect(affineScale(M)).toBeCloseTo(4, 6);
    close(applyAffine(M, src[2]), FFHQ_512[2], 1e-4);
    const inv = invertAffine(M);
    for (const p of FFHQ_512) close(applyAffine(M, applyAffine(inv, p)), p, 1e-6);
    // perturbing one point moves the fit less than the perturbation
    const noisy = src.map((p, i): Pt => (i === 0 ? [p[0] + 4, p[1]] : p));
    const N = similarity(noisy, FFHQ_512);
    const err = Math.hypot(...(applyAffine(N, noisy[0]).map((v, k) => v - FFHQ_512[0][k]) as [number, number]));
    expect(err).toBeLessThan(16);
  });

  it('handles degenerate input', () => {
    const M = similarity([[5, 5], [5, 5]], [[1, 2], [1, 2]]);
    close(applyAffine(M, [5, 5]), [1, 2]);
  });
});

describe('five points', () => {
  it('orders eyes and mouth corners by image x', () => {
    const pts = new Float32Array(478 * 3);
    const set = (i: number, x: number, y: number) => ((pts[i * 3] = x), (pts[i * 3 + 1] = y));
    set(468, 0.6, 0.4); // subject's right iris, mirrored to the image right
    set(473, 0.4, 0.4);
    set(1, 0.5, 0.5);
    set(61, 0.58, 0.6);
    set(291, 0.42, 0.6);
    const f: FaceLm = { pts, box: [0.3, 0.3, 0.7, 0.7] };
    const [le, re, nose, lm, rm] = fivePoints(f, 100, 200);
    expect(le[0]).toBeLessThan(re[0]);
    expect(lm[0]).toBeLessThan(rm[0]);
    expect(nose).toEqual([50, 100]);
  });
});

describe('boxes', () => {
  it('iou / nms / merge', () => {
    expect(iou([0, 0, 1, 1], [0, 0, 1, 1])).toBe(1);
    expect(iou([0, 0, 1, 1], [2, 2, 3, 3])).toBe(0);
    expect(iou([0, 0, 2, 1], [1, 0, 3, 1])).toBeCloseTo(1 / 3);
    const k = nms([
      { box: [0, 0, 1, 1], score: 0.6, kps: [] },
      { box: [0.05, 0, 1.05, 1], score: 0.9, kps: [] },
      { box: [3, 3, 4, 4], score: 0.5, kps: [] },
    ]);
    expect(k.map((b) => b.score)).toEqual([0.9, 0.5]);
    const face = (b: FaceLm['box']): FaceLm => ({ pts: new Float32Array(3), box: b });
    const m = mergeFaces([
      { face: face([0.1, 0.1, 0.2, 0.2]), quality: 1 },
      { face: face([0.11, 0.1, 0.21, 0.2]), quality: 2 },
      { face: face([0.5, 0.5, 0.8, 0.8]), quality: 0.1 },
    ]);
    expect(m.length).toBe(2);
    expect(m[0].box).toEqual([0.5, 0.5, 0.8, 0.8]); // largest first
    expect(m[1].box[0]).toBe(0.11); // the higher-quality duplicate wins
  });

  it('convex hull drops interior points', () => {
    const h = convexHull([[0, 0], [2, 0], [2, 2], [0, 2], [1, 1], [1, 0.5]]);
    expect(h.length).toBe(4);
  });
});

describe('YuNet decoding', () => {
  it('decodes one anchor-free box with keypoints', () => {
    const pw = 64, ph = 32;
    const out: Record<string, { data: Float32Array }> = {};
    for (const s of [8, 16, 32]) {
      const n = (pw / s) * (ph / s);
      out[`cls_${s}`] = { data: new Float32Array(n) };
      out[`obj_${s}`] = { data: new Float32Array(n) };
      out[`bbox_${s}`] = { data: new Float32Array(n * 4) };
      out[`kps_${s}`] = { data: new Float32Array(n * 10) };
    }
    // stride 16 → 4×2 grid; cell (r=1, c=2) = index 6
    const i = 1 * 4 + 2;
    out.cls_16.data[i] = 0.81;
    out.obj_16.data[i] = 1;
    out.bbox_16.data.set([0.5, 0.25, Math.log(2), Math.log(1)], i * 4);
    out.kps_16.data.set([0, 0, 1, 0, 0.5, 0.5, 0, 1, 1, 1], i * 10);
    const r = decodeYunet(out, pw, ph, 64, 32, 0.5);
    expect(r.length).toBe(1);
    expect(r[0].score).toBeCloseTo(0.9);
    // centre (2.5·16, 1.25·16) = (40, 20), size 32×16
    expect(r[0].box.map((v, k) => Math.round(v * (k % 2 ? 32 : 64) * 1e4) / 1e4)).toEqual([24, 12, 56, 28]);
    expect(r[0].kps[0]).toEqual([32 / 64, 16 / 32]);
  });
});
