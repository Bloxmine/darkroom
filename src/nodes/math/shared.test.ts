import { describe, expect, it } from 'vitest';
import {
  CIE_CMF, MIX_BLEND_TYPES, RAMP_INTERP, WAVELENGTH_RGB, bakeRamp, blackbody, blackbodyRaw, evalRamp, hslToRgb, hsvToRgb,
  mixColorRef, rampFromParams, rgbToHsl, rgbToHsv, wavelength, type RGB, type Ramp,
} from './_shared';

const close = (got: number[], exp: number[], eps = 1e-5) => got.forEach((v, i) => expect(v).toBeCloseTo(exp[i], -Math.log10(eps)));

describe('Blender HSV / HSL', () => {
  it('round-trips', () => {
    for (const c of [[0.2, 0.5, 0.8], [1, 0, 0], [0.3, 0.3, 0.3], [0.9, 0.1, 0.6]] as RGB[]) {
      close(hsvToRgb(rgbToHsv(c)), c);
      close(hslToRgb(rgbToHsl(c)), c);
    }
    close(rgbToHsv([0, 0, 1]), [2 / 3, 1, 1]);
    close(rgbToHsl([1, 0, 0]), [0, 1, 0.5]);
  });
});

describe('mix.color reference (Blender ramp_blend formulas)', () => {
  // Hand-computed from Blender's definitions for A = (0.2, 0.5, 0.8), B = (0.9, 0.3, 0.1), fac = 0.5.
  const a: RGB = [0.2, 0.5, 0.8], b: RGB = [0.9, 0.3, 0.1];
  const expected: Record<string, RGB> = {
    Mix: [0.55, 0.4, 0.45],
    Darken: [0.2, 0.4, 0.45],
    Multiply: [0.19, 0.325, 0.44],
    'Color Burn': [1 - 0.8 / 0.95, 1 - 0.5 / 0.65, 1 - 0.2 / 0.55],
    Lighten: [0.55, 0.5, 0.8],
    Screen: [0.56, 0.575, 0.81],
    'Color Dodge': [0.2 / 0.55, 0.5 / 0.85, Math.min(1, 0.8 / 0.95)],
    Add: [0.65, 0.65, 0.85],
    Overlay: [0.28, 0.4, 0.72],
    'Soft Light': [0.264, 0.5 * 0.5 + 0.5 * (0.5 * 0.3 * 0.5 + 0.5 * 0.65), 0.5 * 0.8 + 0.5 * (0.2 * 0.1 * 0.8 + 0.8 * 0.82)],
    'Linear Light': [0.6, 0.3, 0.4],
    Difference: [0.45, 0.35, 0.75],
    Exclusion: [0.47, 0.5, 0.77],
    Subtract: [-0.25, 0.35, 0.75],
    Divide: [0.1 + 0.1 / 0.9, 0.25 + 0.25 / 0.3, 0.4 + 0.4 / 0.1],
    Value: [0.2125, 0.53125, 0.85],
  };
  for (const [type, exp] of Object.entries(expected)) {
    it(type, () => close(mixColorRef(type, 0.5, a, b), exp));
  }
  it('covers all 19 blend types', () => {
    expect(MIX_BLEND_TYPES).toHaveLength(19);
    for (const t of MIX_BLEND_TYPES) expect(mixColorRef(t, 0.5, a, b)).toHaveLength(3);
  });
  it('fac 0 returns A for every type', () => {
    for (const t of MIX_BLEND_TYPES) close(mixColorRef(t, 0, a, b), a);
  });
  it('Hue / Color are no-ops for a grey B; Saturation for a grey A', () => {
    const grey: RGB = [0.5, 0.5, 0.5];
    close(mixColorRef('Hue', 1, a, grey), a);
    close(mixColorRef('Color', 1, a, grey), a);
    close(mixColorRef('Saturation', 1, grey, b), grey);
  });
  it('Hue at fac 1 takes the hue of B, keeps S and V of A', () => {
    const o = rgbToHsv(mixColorRef('Hue', 1, a, b));
    close(o, [rgbToHsv(b)[0], rgbToHsv(a)[1], rgbToHsv(a)[2]]);
  });
  it('Divide leaves channels with B = 0 unchanged', () => {
    close(mixColorRef('Divide', 1, [0.4, 0.5, 0.6], [0, 0.5, 2]), [0.4, 1, 0.3]);
  });
});

describe('Color Ramp (BKE_colorband_evaluate port)', () => {
  const grey = (v: number) => [v, v, v, 1] as [number, number, number, number];
  const ramp = (interpolation: string, stops: [number, number[]][], mode = 'RGB', hue = 'Near'): Ramp =>
    ({ stops: stops.map(([pos, c]) => ({ pos, color: (c.length === 4 ? c : [...c, 1]) as [number, number, number, number] })), interpolation, mode, hue });

  it('Linear', () => {
    close(evalRamp(ramp('Linear', [[0, grey(0)], [1, grey(1)]]), 0.25), grey(0.25));
    const r = ramp('Linear', [[0.2, [1, 0, 0]], [0.8, [0, 0, 1]]]);
    close(evalRamp(r, 0.1), [1, 0, 0, 1]);   // before first stop
    close(evalRamp(r, 0.9), [0, 0, 1, 1]);   // after last stop
    close(evalRamp(r, 0.5), [0.5, 0, 0.5, 1]);
  });
  it('Ease (smoothstep)', () => {
    close(evalRamp(ramp('Ease', [[0, grey(0)], [1, grey(1)]]), 0.25), grey(3 * 0.0625 - 2 * 0.015625));
  });
  it('Constant holds the left stop (inclusive of its position)', () => {
    const r = ramp('Constant', [[0, [1, 0, 0]], [0.5, [0, 1, 0]]]);
    close(evalRamp(r, 0.49), [1, 0, 0, 1]);
    close(evalRamp(r, 0.5), [0, 1, 0, 1]);
    close(evalRamp(r, 1), [0, 1, 0, 1]);
  });
  it('B-Spline smooths a peak to 2/3; Cardinal passes through the stop', () => {
    const stops: [number, number[]][] = [[0, grey(0)], [0.5, grey(1)], [1, grey(0)]];
    expect(evalRamp(ramp('B-Spline', stops), 0.5)[0]).toBeCloseTo(2 / 3, 5);
    expect(evalRamp(ramp('Cardinal', stops), 0.5)[0]).toBeCloseTo(1, 5);
    // both stay within 0..1 and are continuous
    for (const ip of ['B-Spline', 'Cardinal']) {
      const baked = bakeRamp(ramp(ip, stops), 256);
      for (let i = 1; i < 256; i++) expect(Math.abs(baked[i * 4] - baked[(i - 1) * 4])).toBeLessThan(0.05);
    }
  });
  it('HSV hue interpolation: Near / Far / Clockwise / Counter-Clockwise', () => {
    const stops: [number, number[]][] = [[0, [1, 0, 0]], [1, [0, 0, 1]]];   // red (h 0) → blue (h 2/3)
    const hueAt = (hue: string) => rgbToHsv(evalRamp(ramp('Linear', stops, 'HSV', hue), 0.5).slice(0, 3) as RGB)[0];
    expect(hueAt('Near')).toBeCloseTo(5 / 6, 5);   // through magenta
    expect(hueAt('Far')).toBeCloseTo(1 / 3, 5);    // through green
    expect(hueAt('Counter-Clockwise')).toBeCloseTo(5 / 6, 5);
    expect(hueAt('Clockwise')).toBeCloseTo(1 / 3, 5);
    // HSL keeps S/L interpolation
    const hsl = evalRamp(ramp('Linear', stops, 'HSL', 'Near'), 0.5);
    close(hsl, [1, 0, 1, 1]);
  });
  it('interpolates alpha', () => {
    close(evalRamp(ramp('Linear', [[0, [1, 1, 1, 0]], [1, [1, 1, 1, 1]]]), 0.3), [1, 1, 1, 0.3]);
  });
  it('bakes every interpolation from params', () => {
    for (const interpolation of RAMP_INTERP) {
      const r = rampFromParams({ interpolation, count: 3, pos0: 0, pos1: 0.5, pos2: 1, color0: [0, 0, 0, 1], color1: [1, 0.5, 0, 1], color2: [1, 1, 1, 1] });
      expect(r.stops).toHaveLength(3);
      const baked = bakeRamp(r, 256);
      expect(baked).toHaveLength(1024);
      // B-Spline approximates (does not pass through the end stops), as in Blender
      if (interpolation !== 'B-Spline') {
        close(Array.from(baked.slice(0, 4)), [0, 0, 0, 1]);
        close(Array.from(baked.slice(1020)), [1, 1, 1, 1]);
      } else expect(baked[0]).toBeCloseTo(1 / 6, 5);
      expect(Array.from(baked).every(Number.isFinite)).toBe(true);
    }
  });
  it('sorts unordered stops and clamps count', () => {
    const r = rampFromParams({ count: 99, pos0: 1, color0: [1, 1, 1, 1], pos1: 0, color1: [0, 0, 0, 1] });
    expect(r.stops).toHaveLength(8);
    const r2 = rampFromParams({ count: 2, pos0: 1, color0: [1, 1, 1, 1], pos1: 0, color1: [0, 0, 0, 1] });
    close(evalRamp(r2, 0.25), [0.25, 0.25, 0.25, 1]);
  });
});

describe('Blackbody', () => {
  it('fit is continuous across its segment boundaries (table transcribed correctly)', () => {
    for (const th of [1167, 1449, 1902, 3315, 6365]) {
      const lo = blackbodyRaw(th - 0.01), hi = blackbodyRaw(th + 0.01);
      for (let i = 0; i < 3; i++) expect(Math.abs(lo[i] - hi[i])).toBeLessThan(0.005);
    }
  });
  it('is normalised to luminance 1, ~white at 6500 K, warm low / cool high', () => {
    for (const t of [1000, 1500, 3000, 6500, 10000, 20000]) {
      const c = blackbody(t);
      expect(0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]).toBeCloseTo(1, 5);
    }
    const w = blackbody(6500);
    for (const v of w) expect(Math.abs(v - 1)).toBeLessThan(0.06);
    const warm = blackbody(1500), cool = blackbody(10000);
    expect(warm[0]).toBeGreaterThan(warm[1]);
    expect(warm[1]).toBeGreaterThan(warm[2]);
    expect(cool[2]).toBeGreaterThan(cool[0]);
  });
});

describe('Wavelength', () => {
  it('uses the 81-entry CIE 1931 table (380..780 nm / 5 nm), Y peaking at 555 nm', () => {
    expect(CIE_CMF).toHaveLength(81);
    expect(WAVELENGTH_RGB).toHaveLength(81);
    const peak = CIE_CMF.reduce((best, c, i) => (c[1] > CIE_CMF[best][1] ? i : best), 0);
    expect(380 + peak * 5).toBe(555);
  });
  it('maps to the expected hues and is black outside the visible range', () => {
    const dom = (nm: number) => { const c = wavelength(nm); return c.indexOf(Math.max(...c)); };
    expect(dom(450)).toBe(2);
    expect(dom(530)).toBe(1);
    expect(dom(620)).toBe(0);
    expect(wavelength(300)).toEqual([0, 0, 0]);
    expect(wavelength(800)).toEqual([0, 0, 0]);
    for (let nm = 380; nm < 780; nm += 7) for (const v of wavelength(nm)) expect(v).toBeGreaterThanOrEqual(0);
  });
  it('interpolates linearly between table entries', () => {
    const a = wavelength(500), b = wavelength(505), m = wavelength(502.5);
    for (let i = 0; i < 3; i++) if (a[i] > 0 && b[i] > 0) expect(m[i]).toBeCloseTo((a[i] + b[i]) / 2, 6);
  });
});
