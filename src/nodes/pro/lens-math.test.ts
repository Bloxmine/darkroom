import { describe, expect, it } from 'vitest';
import { autoCropZoom, distortPoint, estimateTilt, rotateCropZoom } from './lens-math';

/** w×h luma image of parallel stripes whose lines run at `deg` (y down, + = clockwise), plus noise. */
function stripes(w: number, h: number, deg: number, period = 14, noise = 0.05, seed = 1) {
  const a = (deg * Math.PI) / 180;
  const nx = -Math.sin(a), ny = Math.cos(a); // normal to the lines
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const lum = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) lum[y * w + x] = 0.5 + 0.35 * Math.tanh(2.5 * Math.sin(((x * nx + y * ny) * 2 * Math.PI) / period)) + noise * (rnd() - 0.5);
  return lum;
}

describe('tilt estimation', () => {
  for (const deg of [-7.5, -3, -0.8, 0, 1.25, 4, 8.6]) {
    it(`finds horizontal lines at ${deg}°`, () => {
      const e = estimateTilt(stripes(320, 220, deg), 320, 220, 'level', 10);
      expect(Math.abs(e.angle - deg)).toBeLessThan(0.15);
      expect(e.confidence).toBeGreaterThan(0.3);
    });
  }
  it('finds vertical lines in vertical and auto modes', () => {
    const lum = stripes(300, 300, 90 + 2.5, 12, 0.1);
    expect(estimateTilt(lum, 300, 300, 'vertical').angle).toBeCloseTo(2.5, 0);
    expect(estimateTilt(lum, 300, 300, 'auto').angle).toBeCloseTo(2.5, 0);
  });
  it('picks the dominant orientation with clutter', () => {
    const a = stripes(320, 240, 3, 16, 0.2), b = stripes(320, 240, -20, 7, 0, 7);
    const mix = a.map((v, i) => (i % 320 < 240 ? v : b[i]));
    expect(Math.abs(estimateTilt(mix, 320, 240, 'level', 10).angle - 3)).toBeLessThan(0.3);
  });
});

describe('lens geometry', () => {
  it('positive k1 pulls edge samples inward (barrel correction), centre is fixed', () => {
    const d = { k1: 0.1, k2: 0, k3: 0, p1: 0, p2: 0 };
    expect(distortPoint(0, 0, d)).toEqual([0, 0]);
    expect(distortPoint(0.8, 0, d)[0]).toBeLessThan(0.8);
  });
  it('auto-crop: barrel correction can zoom out, pincushion correction crops in, identity = 1', () => {
    const hw = 0.8, hh = 0.6;
    expect(autoCropZoom({ k1: 0, k2: 0, k3: 0, p1: 0, p2: 0 }, hw, hh)).toBeCloseTo(1, 3);
    expect(autoCropZoom({ k1: 0.1, k2: 0, k3: 0, p1: 0, p2: 0 }, hw, hh)).toBeGreaterThan(1);
    const z = autoCropZoom({ k1: -0.1, k2: 0, k3: 0, p1: 0, p2: 0 }, hw, hh);
    expect(z).toBeLessThan(1);
    const [sx, sy] = distortPoint(hw * z, hh * z, { k1: -0.1, k2: 0, k3: 0, p1: 0, p2: 0 });
    expect(Math.abs(sx)).toBeLessThanOrEqual(hw * 1.001);
    expect(Math.abs(sy)).toBeLessThanOrEqual(hh * 1.001);
  });
  it('rotate-crop zoom', () => {
    expect(rotateCropZoom(0, 300, 200)).toBe(1);
    const z = rotateCropZoom(5, 300, 200);
    // the rotated, zoomed frame's corner stays inside the original
    const a = (5 * Math.PI) / 180, cx = 150 / z, cy = 100 / z;
    expect(Math.abs(cx * Math.cos(a) + cy * Math.sin(a))).toBeLessThanOrEqual(150.001);
    expect(Math.abs(cx * Math.sin(a) + cy * Math.cos(a))).toBeLessThanOrEqual(100.001);
  });
});
