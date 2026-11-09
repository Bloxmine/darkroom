import { describe, expect, it } from 'vitest';
import { apply, bradford, convertMatrix, decode, encode, IDENTITY, inv, mul, planckianXY, rgbToXyz, SPACES, spaceByLabel, TONEMAPS, tonemapGrey, WHITE, whiteBalanceMatrix, agxContrast, type Mat3 } from './color-math';

const close = (a: Mat3, b: Mat3, eps = 1e-4) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], -Math.log10(eps)));

describe('colour space matrices', () => {
  it('sRGB → XYZ matches IEC 61966-2-1', () => {
    close(rgbToXyz(spaceByLabel('sRGB')), [0.4124, 0.3576, 0.1805, 0.2126, 0.7152, 0.0722, 0.0193, 0.1192, 0.9505], 1e-3);
  });
  it('Display P3 / Rec.2020 / Adobe RGB / ACEScg luminance rows match the published values', () => {
    expect(rgbToXyz(spaceByLabel('p3')).slice(3, 6).map((v) => +v.toFixed(4))).toEqual([0.2290, 0.6917, 0.0793]);
    expect(rgbToXyz(spaceByLabel('rec2020')).slice(3, 6).map((v) => +v.toFixed(4))).toEqual([0.2627, 0.678, 0.0593]);
    [0.2974, 0.6273, 0.0753].forEach((v, i) => expect(rgbToXyz(spaceByLabel('adobe'))[3 + i]).toBeCloseTo(v, 3));
    // ACEScg (AP1) Y row per S-2014-004: 0.2722287168, 0.6740817658, 0.0536895174
    const ap1 = rgbToXyz(spaceByLabel('acescg'));
    [0.2722287168, 0.6740817658, 0.0536895174].forEach((v, i) => expect(ap1[3 + i]).toBeCloseTo(v, 4));
  });
  it('each primary maps to its chromaticity and white to Y = 1', () => {
    for (const s of SPACES) {
      const M = rgbToXyz(s);
      for (let c = 0; c < 3; c++) {
        const v: [number, number, number] = [0, 0, 0];
        v[c] = 1;
        const X = apply(M, v);
        const sum = X[0] + X[1] + X[2];
        expect(X[0] / sum).toBeCloseTo(s.primaries[c][0], 5);
        expect(X[1] / sum).toBeCloseTo(s.primaries[c][1], 5);
      }
      const W = apply(M, [1, 1, 1]);
      expect(W[1]).toBeCloseTo(1, 6);
      expect(W[0] / (W[0] + W[1] + W[2])).toBeCloseTo(s.white[0], 5);
    }
  });
  it('Bradford D65 → D50 matches Lindbloom', () => {
    close(bradford(WHITE.D65, WHITE.D50), [1.0478, 0.0229, -0.0501, 0.0295, 0.9905, -0.0171, -0.0092, 0.0151, 0.7519], 1e-3);
    close(mul(bradford(WHITE.D65, WHITE.D50), bradford(WHITE.D50, WHITE.D65)), IDENTITY, 1e-6);
  });
  it('conversions round-trip and keep white neutral', () => {
    for (const a of SPACES)
      for (const b of SPACES) {
        close(mul(convertMatrix(b, a), convertMatrix(a, b)), IDENTITY, 1e-6);
        const w = apply(convertMatrix(a, b), [1, 1, 1]);
        w.forEach((v) => expect(v).toBeCloseTo(1, 4)); // Bradford maps white to white
      }
  });
  it('sRGB → ProPhoto matches the commonly published matrix', () => {
    close(convertMatrix(spaceByLabel('linsrgb'), spaceByLabel('prophoto')), [0.5293, 0.3300, 0.1407, 0.0984, 0.8734, 0.0282, 0.0169, 0.1177, 0.8654], 2e-3);
  });
  it('transfer functions invert', () => {
    for (const t of ['srgb', 'linear', 'gamma22', 'adobe', 'prophoto', 'bt1886'] as const)
      for (const v of [0, 0.001, 0.02, 0.18, 0.5, 0.9, 1]) expect(decode(t, encode(t, v))).toBeCloseTo(v, 6);
  });
  it('inv works', () => close(mul(inv(rgbToXyz(SPACES[0])), rgbToXyz(SPACES[0])), IDENTITY, 1e-9));
});

describe('white balance', () => {
  it('Planckian locus hits known points', () => {
    const a = planckianXY(2856); // CIE A ≈ (0.4476, 0.4074)
    expect(a[0]).toBeCloseTo(0.4476, 2);
    expect(a[1]).toBeCloseTo(0.4074, 2);
  });
  it('identity at 6500 K, warmer source → bluer image', () => {
    close(whiteBalanceMatrix(6500, 0), IDENTITY, 1e-9);
    const v = apply(whiteBalanceMatrix(3200, 0), [0.5, 0.5, 0.5]);
    expect(v[2]).toBeGreaterThan(v[0]);
    const g = apply(whiteBalanceMatrix(6500, 0.5), [0.5, 0.5, 0.5]); // + tint = magenta
    expect(g[1]).toBeLessThan((g[0] + g[2]) / 2);
  });
});

describe('tone curves', () => {
  it('are monotonic, start near 0, map mid grey sensibly and stay ≤ ~1', () => {
    for (const op of TONEMAPS) {
      let prev = -Infinity;
      for (let i = 0; i <= 4000; i++) {
        const x = Math.pow(2, -14 + (i / 4000) * 22); // 2^-14 … 2^8
        const y = tonemapGrey(op, x);
        expect(y, `${op} at ${x}`).toBeGreaterThanOrEqual(prev - 1e-6);
        prev = y;
      }
      expect(tonemapGrey(op, 1e-5)).toBeLessThan(0.02);
      expect(prev).toBeLessThan(1.05);
      const mid = tonemapGrey(op, 0.18);
      expect(mid, op).toBeGreaterThan(0.1);
      expect(mid, op).toBeLessThan(0.6);
    }
  });
  it('AgX sigmoid spans 0..1', () => {
    expect(agxContrast(0)).toBeCloseTo(0, 2);
    expect(agxContrast(1)).toBeCloseTo(1, 1);
  });
});
