import { describe, expect, it } from 'vitest';
import { alignImage, fft, hatWeight, mergeRadiance, phaseCorrelate } from './photo-math';

const enc = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

describe('HDR weighting', () => {
  it('hat weight is 0 at the clip points, 1 at mid, symmetric and monotonic per side', () => {
    expect(hatWeight(0)).toBe(0);
    expect(hatWeight(1)).toBe(0);
    expect(hatWeight(0.99)).toBe(0);
    expect(hatWeight(0.5)).toBeCloseTo(1, 9);
    expect(hatWeight(0.3)).toBeCloseTo(hatWeight(0.7), 9);
    for (let z = 0.02; z < 0.5; z += 0.01) expect(hatWeight(z + 0.01)).toBeGreaterThanOrEqual(hatWeight(z));
  });
  it('recovers scene radiance from a clipped synthetic bracket', () => {
    const evs = [-2, 0, 2];
    for (const E of [0.001, 0.01, 0.18, 0.9, 3.5]) {
      const z = evs.map((ev) => Math.min(1, Math.round(enc(Math.min(1, E * Math.pow(2, ev))) * 255) / 255));
      const r = mergeRadiance(z, evs);
      expect(Math.abs(Math.log2(r / E)), `E=${E}`).toBeLessThan(E < 0.005 ? 0.25 : 0.06);
    }
  });
  it('falls back to the darkest frame when everything is clipped', () => {
    expect(mergeRadiance([1, 1, 1], [-2, 0, 2])).toBeCloseTo(4, 6);
  });
});

describe('phase correlation', () => {
  it('fft round-trips', () => {
    const re = Float64Array.from({ length: 16 }, (_, i) => Math.sin(i) + i * 0.1), im = new Float64Array(16);
    const orig = re.slice();
    fft(re, im);
    fft(re, im, true);
    re.forEach((v, i) => expect(v / 16).toBeCloseTo(orig[i], 9));
  });
  it('finds a known shift between two differently exposed frames', () => {
    const W = 400, H = 300;
    const scene = (x: number, y: number) => 0.05 + 0.4 * (0.5 + 0.5 * Math.sin(x * 0.07) * Math.cos(y * 0.05)) + (((x / 37) | 0) % 2 ? 0.2 : 0) + ((x - 200) ** 2 + (y - 150) ** 2 < 2500 ? 0.3 : 0);
    const make = (sx: number, sy: number, ev: number) => {
      const data = new Float32Array(W * H * 4);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const v = enc(Math.min(1, scene(x - sx, y - sy) * Math.pow(2, ev))); data.set([v, v, v, 1], (y * W + x) * 4); }
      return { width: W, height: H, data };
    };
    const a = alignImage(make(0, 0, 0), 0, 256), b = alignImage(make(9, -6, 1), 1, 256);
    const r = phaseCorrelate(a.img, b.img, 256);
    expect(r.dx * a.sx).toBeCloseTo(9, 0);
    expect(r.dy * a.sy).toBeCloseTo(-6, 0);
  });
});
