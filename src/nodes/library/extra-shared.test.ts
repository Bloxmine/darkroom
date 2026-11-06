import { describe, expect, it } from 'vitest';
import {
  applyH, aspectRatio, blurPlan, canvasLayout, colorStats, computeHistograms, cropRect, equalizeLut, histPercentile, invert3,
  resizeSize, squareToQuad, srgbToLab, straightenFactor, straightenSize,
} from './extra-shared';
import { autoLevelsPoints } from './extra-tone';
import { perspectiveMatrix } from './extra-transform';
import { infoText } from './extra-composite';

/** Build an RGBA float image from a per-pixel function. */
function image(w: number, h: number, f: (x: number, y: number) => [number, number, number, number?]) {
  const d = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b, a = 1] = f(x, y);
    d.set([r, g, b, a], (y * w + x) * 4);
  }
  return d;
}

describe('aspect & crop', () => {
  it('parses aspect presets', () => {
    expect(aspectRatio('16:9', 1, 1)).toBeCloseTo(16 / 9);
    expect(aspectRatio('2.39:1', 1, 1)).toBeCloseTo(2.39);
    expect(aspectRatio('original', 1600, 1067)).toBeCloseTo(1600 / 1067);
    expect(aspectRatio('free', 10, 10)).toBeNull();
  });
  it('relative crop', () => {
    expect(cropRect({}, 1600, 1067)).toEqual({ x: 160, y: 107, w: 1280, h: 854 });
    expect(cropRect({ x: 0, y: 0, width: 1, height: 1 }, 1600, 1067)).toEqual({ x: 0, y: 0, w: 1600, h: 1067 });
  });
  it('pixel crop is clamped inside the image', () => {
    expect(cropRect({ units: 'pixels', pxX: 100, pxY: 50, pxWidth: 300, pxHeight: 200 }, 1600, 1067)).toEqual({ x: 100, y: 50, w: 300, h: 200 });
    expect(cropRect({ units: 'pixels', pxX: 1500, pxY: 1000, pxWidth: 999, pxHeight: 999 }, 1600, 1067)).toEqual({ x: 1500, y: 1000, w: 100, h: 67 });
    expect(cropRect({ units: 'pixels', pxX: -20, pxY: 0, pxWidth: 0, pxHeight: 10 }, 100, 100)).toEqual({ x: 0, y: 0, w: 1, h: 10 });
  });
  it('aspect preset fits the largest centred rect', () => {
    const r = cropRect({ x: 0, y: 0, width: 1, height: 1, aspect: '1:1' }, 1600, 1000);
    expect(r).toEqual({ x: 300, y: 0, w: 1000, h: 1000 });
    const p = cropRect({ aspect: '16:9' }, 1200, 1500);
    expect(p.w / p.h).toBeCloseTo(16 / 9, 2);
    expect(p).toEqual({ x: 120, y: 480, w: 960, h: 540 });
  });
});

describe('resize size', () => {
  it('modes keep aspect', () => {
    expect(resizeSize({}, 1600, 1067)).toEqual([800, 534]);
    expect(resizeSize({ mode: 'width', width: 800 }, 1600, 1000)).toEqual([800, 500]);
    expect(resizeSize({ mode: 'height', height: 250 }, 1600, 1000)).toEqual([400, 250]);
    expect(resizeSize({ mode: 'longEdge', edge: 400 }, 1200, 1500)).toEqual([320, 400]);
    expect(resizeSize({ mode: 'shortEdge', edge: 600 }, 1200, 1500)).toEqual([600, 750]);
    expect(resizeSize({ mode: 'fit', width: 500, height: 500 }, 1600, 1000)).toEqual([500, 313]);
    expect(resizeSize({ mode: 'exact', width: 64, height: 32 }, 1600, 1000)).toEqual([64, 32]);
  });
  it('never returns zero', () => {
    expect(resizeSize({ percent: 0.0001 }, 100, 100)).toEqual([1, 1]);
  });
});

describe('canvas size', () => {
  it('adds pixels around a centred image', () => {
    expect(canvasLayout({}, 1600, 1067)).toEqual({ w: 1700, h: 1167, ox: 50, oy: 50 });
  });
  it('anchors', () => {
    expect(canvasLayout({ mode: 'absolute', width: 2000, height: 1000, anchor: 'bottom-right' }, 1600, 800)).toEqual({ w: 2000, h: 1000, ox: 400, oy: 200 });
    expect(canvasLayout({ mode: 'absolute', width: 1000, height: 800, anchor: 'top-left' }, 1600, 800)).toEqual({ w: 1000, h: 800, ox: 0, oy: 0 });
  });
  it('pads to an aspect', () => {
    expect(canvasLayout({ mode: 'aspect', aspect: '1:1' }, 1200, 1500)).toEqual({ w: 1500, h: 1500, ox: 150, oy: 0 });
    expect(canvasLayout({ mode: 'aspect', aspect: '4:5' }, 1600, 1000)).toEqual({ w: 1600, h: 2000, ox: 0, oy: 500 });
  });
});

describe('straighten', () => {
  it('factor is 1 at 0° and shrinks with angle', () => {
    expect(straightenFactor(1600, 1000, 0)).toBeCloseTo(1);
    const k = straightenFactor(1600, 1000, 8);
    expect(k).toBeLessThan(1);
    // the corners of the k-scaled rect, rotated, lie inside the image
    const a = (8 * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    const hw = (1600 * k) / 2, hh = (1000 * k) / 2;
    for (const [x, y] of [[hw, hh], [-hw, hh]]) {
      expect(Math.abs(x * c - y * s)).toBeLessThanOrEqual(800 + 1e-6);
      expect(Math.abs(x * s + y * c)).toBeLessThanOrEqual(500 + 1e-6);
    }
  });
  it('sizes per mode', () => {
    expect(straightenSize({ angle: 8 }, 1600, 1067)).toEqual([1600, 1067]);
    const [w, h] = straightenSize({ angle: 8, crop: 'crop' }, 1600, 1067);
    expect(w / h).toBeCloseTo(1600 / 1067, 2);
    expect(straightenSize({ angle: 90, crop: 'expand' }, 1600, 1000)).toEqual([1000, 1600]);
  });
});

describe('homography', () => {
  it('maps the unit square onto the quad and inverts', () => {
    const q: [number, number][] = [[0.1, 0.05], [0.9, 0.1], [1, 1], [0, 0.95]];
    const H = squareToQuad(q);
    [[0, 0], [1, 0], [1, 1], [0, 1]].forEach(([u, v], i) => {
      const [x, y] = applyH(H, u, v);
      expect(x).toBeCloseTo(q[i][0], 9);
      expect(y).toBeCloseTo(q[i][1], 9);
    });
    const Hi = invert3(H);
    const [x, y] = applyH(H, 0.3, 0.7);
    const [u, v] = applyH(Hi, x, y);
    expect(u).toBeCloseTo(0.3, 9);
    expect(v).toBeCloseTo(0.7, 9);
  });
  it('identity corners give identity', () => {
    const H = perspectiveMatrix({ vertical: 0 });
    expect(applyH(H, 0.25, 0.75)).toEqual([0.25, 0.75]);
  });
  it('vertical keystone narrows the source top', () => {
    const H = perspectiveMatrix({ vertical: 0.4 });
    expect(applyH(H, 0, 0)[0]).toBeCloseTo(0.2);
    expect(applyH(H, 1, 0)[0]).toBeCloseTo(0.8);
    expect(applyH(H, 0, 1)[0]).toBeCloseTo(0);
  });
});

describe('histograms', () => {
  it('counts RGB and luma, skipping transparent pixels', () => {
    const d = image(4, 1, (x) => (x === 3 ? [1, 1, 1, 0] : [x / 3, 0, 1, 1]));
    const h = computeHistograms(d, 4, 1, 4);
    expect(h.total).toBe(3);
    expect([...h.r]).toEqual([1, 1, 1, 0]);
    expect([...h.b]).toEqual([0, 0, 0, 3]);
  });
  it('percentiles from either end', () => {
    const hist = new Float64Array(100);
    hist.fill(1);
    expect(histPercentile(hist, 0)).toBeCloseTo(0);
    expect(histPercentile(hist, 0.1)).toBeCloseTo(0.1);
    expect(histPercentile(hist, 0.1, true)).toBeCloseTo(0.9);
    expect(histPercentile(hist, 0, true)).toBeCloseTo(1);
    expect(histPercentile(new Float64Array(10), 0.5)).toBe(0);
  });
  it('equalisation LUT is monotone, spans 0..1 and flattens a ramp', () => {
    const hist = new Float64Array(256);
    for (let i = 64; i < 128; i++) hist[i] = 10; // narrow, low-contrast image
    const lut = equalizeLut(hist);
    expect(lut[0]).toBe(0);
    expect(lut[63]).toBe(0);
    expect(lut[127]).toBeCloseTo(1);
    expect(lut[255]).toBeCloseTo(1);
    for (let i = 1; i < 256; i++) expect(lut[i]).toBeGreaterThanOrEqual(lut[i - 1]);
    expect(lut[96]).toBeCloseTo(0.5, 1);
  });
  it('equalisation of an empty / single-level histogram is the identity', () => {
    const one = new Float64Array(8); one[3] = 5;
    expect([...equalizeLut(one)].map((v) => +v.toFixed(3))).toEqual([0, 0.143, 0.286, 0.429, 0.571, 0.714, 0.857, 1]);
  });
  it('auto levels finds the occupied range', () => {
    const d = image(100, 1, (x) => [0.2 + 0.5 * (x / 99), 0.3, 0.6 + 0.1 * (x / 99), 1]);
    const h = computeHistograms(d, 100, 1);
    const p = autoLevelsPoints(h, { clipBlack: 0, clipWhite: 0 });
    expect(p.black[0]).toBeCloseTo(0.2, 1);
    expect(p.white[0]).toBeCloseTo(0.7, 1);
    expect(p.white[1] - p.black[1]).toBeGreaterThanOrEqual(0.02); // flat channel is guarded
    const l = autoLevelsPoints(h, { mode: 'luma', clipBlack: 0, clipWhite: 0 });
    expect(l.black[0]).toBe(l.black[2]);
    expect(p.gamma).toBe(1);
  });
});

describe('colour stats', () => {
  it('Lab of white/black/grey', () => {
    expect(srgbToLab(1, 1, 1)[0]).toBeCloseTo(100, 1);
    expect(srgbToLab(1, 1, 1)[1]).toBeCloseTo(0, 1);
    expect(srgbToLab(0, 0, 0)[0]).toBeCloseTo(0, 3);
    expect(srgbToLab(0.5, 0.5, 0.5)[0]).toBeCloseTo(53.39, 1);
  });
  it('mean and std', () => {
    const d = image(2, 1, (x) => (x ? [1, 1, 1, 1] : [0, 0, 0, 1]));
    const s = colorStats(d, 2, 1, 'ycbcr');
    expect(s.mean[0]).toBeCloseTo(0.5);
    expect(s.std[0]).toBeCloseTo(0.5);
    expect(s.mean[1]).toBeCloseTo(0.5);
  });
});

describe('misc', () => {
  it('blur plan keeps total variance', () => {
    for (const sigma of [0, 2, 7, 30, 120]) {
      const { d, s } = blurPlan(sigma);
      expect(Math.sqrt((s * d) ** 2 + (d * d - 1) / 12)).toBeCloseTo(sigma, 5);
    }
  });
  it('info text reports full-res size and mean', () => {
    const d = image(800, 534, () => [0.5, 0.25, 1, 1]);
    const t = infoText({ width: 800, height: 534, data: d }, 0.5, { width: 1600, height: 1067 });
    expect(t.lines[0]).toContain('1600 × 1067');
    expect(t.lines[1]).toContain('#8040ff');
  });
});
