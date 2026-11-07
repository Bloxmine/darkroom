import { describe, expect, it } from 'vitest';
import {
  averageRgba,
  canvasToImagePx,
  clippedFractions,
  hex6,
  histogram,
  histogramPeak,
  imageToTexel,
  luma709,
  rgbToHsl,
  rgbToYCbCr709,
  sampleBlock,
  splitFromPointer,
  splitHit,
  splitSide,
  vectorAngle,
  vectorscope,
  vectorscopeXY,
  vectorTargets,
  waveform,
} from './scopes';

const solid = (w: number, h: number, c: [number, number, number, number]) => {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < px.length; i += 4) px.set(c, i);
  return px;
};

describe('histogram binning', () => {
  it('a solid colour gives a single spike per channel', () => {
    const h = histogram(solid(16, 8, [200, 100, 30, 255]));
    expect(h.count).toBe(128);
    expect(h.r[200]).toBe(128);
    expect(h.g[100]).toBe(128);
    expect(h.b[30]).toBe(128);
    for (const ch of [h.r, h.g, h.b, h.y]) expect([...ch].filter((x) => x > 0).length).toBe(1);
    expect(h.y[Math.round(luma709(200, 100, 30))]).toBe(128);
  });
  it('bins the extremes into 0 and 255 and skips transparent pixels', () => {
    const px = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255, 9, 9, 9, 0]);
    const h = histogram(px);
    expect(h.count).toBe(2);
    expect(h.r[0]).toBe(1);
    expect(h.r[255]).toBe(1);
    expect(h.r[9]).toBe(0);
  });
  it('peak ignores clipped end bins unless they are all there is', () => {
    const a = new Uint32Array(256);
    a[0] = 1000;
    a[128] = 10;
    expect(histogramPeak(a)).toBe(10);
    const b = new Uint32Array(256);
    b[255] = 7;
    expect(histogramPeak(b)).toBe(7);
  });
  it('clipping fractions', () => {
    const px = new Uint8ClampedArray([0, 0, 0, 255, 255, 10, 10, 255, 128, 128, 128, 255, 1, 1, 1, 255]);
    const c = clippedFractions(px, 1, 255);
    expect(c.shadows).toBe(0.5);
    expect(c.highlights).toBe(0.25);
  });
});

describe('waveform', () => {
  it('a horizontal ramp is a diagonal line', () => {
    const w = 256, h = 4;
    const px = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.set([x, x, x, 255], (y * w + x) * 4);
    const wf = waveform(px, w, h, 'y', 256);
    for (const x of [0, 50, 128, 255]) expect(wf[x * 256 + x]).toBe(h);
  });
  it('downsamples columns', () => {
    const wf = waveform(solid(8, 2, [10, 20, 30, 255]), 8, 2, 'r', 4);
    expect(wf[10 * 4 + 0]).toBe(4);
    expect(wf[10 * 4 + 3]).toBe(4);
  });
});

describe('vectorscope YUV mapping', () => {
  it('neutral greys sit at the centre', () => {
    for (const v of [0, 0.18, 0.5, 1]) {
      const { cb, cr } = rgbToYCbCr709(v, v, v);
      expect(Math.abs(cb)).toBeLessThan(1e-9);
      expect(Math.abs(cr)).toBeLessThan(1e-9);
      const [x, y] = vectorscopeXY(v, v, v, 200);
      expect(x).toBeCloseTo(100);
      expect(y).toBeCloseTo(100);
    }
  });
  it('100% primaries reach the ±0.5 Cb / Cr extremes', () => {
    expect(rgbToYCbCr709(0, 0, 1).cb).toBeCloseTo(0.5);
    expect(rgbToYCbCr709(1, 0, 0).cr).toBeCloseTo(0.5);
    expect(rgbToYCbCr709(1, 1, 0).cb).toBeCloseTo(-0.5);
    expect(rgbToYCbCr709(0, 1, 1).cr).toBeCloseTo(-0.5);
  });
  it('red is up-left, blue right, green down-left (y down on screen)', () => {
    const [rx, ry] = vectorscopeXY(1, 0, 0, 100);
    expect(rx).toBeLessThan(50);
    expect(ry).toBeLessThan(50);
    const [bx] = vectorscopeXY(0, 0, 1, 100);
    expect(bx).toBeGreaterThan(95);
    const [gx, gy] = vectorscopeXY(0, 1, 0, 100);
    expect(gx).toBeLessThan(50);
    expect(gy).toBeGreaterThan(50);
  });
  it('angles of the 75% bar targets are in the standard order', () => {
    const t = vectorTargets(0.75);
    const deg = Object.fromEntries(t.map((x) => [x.label, vectorAngle(...x.rgb).deg]));
    // counter-clockwise from +Cb: B (~-10°/350), Mg, R, Yl, G, Cy
    expect(deg.Mg).toBeGreaterThan(0);
    expect(deg.R).toBeGreaterThan(deg.Mg);
    expect(deg.Yl).toBeGreaterThan(deg.R);
    expect(deg.G).toBeGreaterThan(deg.Yl);
    expect(deg.Cy).toBeGreaterThan(deg.G);
    expect(deg.B).toBeGreaterThan(deg.Cy);
    // 75% targets are at 3/4 of the 100% magnitude
    const r100 = vectorAngle(1, 0, 0).mag;
    expect(vectorAngle(0.75, 0, 0).mag).toBeCloseTo(r100 * 0.75);
  });
  it('a typical skin tone sits near the skin-tone line', () => {
    const { deg } = vectorAngle(0.85, 0.64, 0.52);
    expect(deg).toBeGreaterThan(105);
    expect(deg).toBeLessThan(140);
  });
  it('density grid has one hot cell for a solid colour', () => {
    const v = vectorscope(solid(10, 10, [180, 60, 60, 255]), 64);
    expect([...v].filter((x) => x > 0)).toEqual([100]);
  });
});

describe('pixel readout maths', () => {
  it('HSL', () => {
    expect(rgbToHsl(1, 0, 0)).toEqual([0, 1, 0.5]);
    const [h, s, l] = rgbToHsl(0, 0.5, 1);
    expect(h).toBeCloseTo(210);
    expect(s).toBeCloseTo(1);
    expect(l).toBeCloseTo(0.5);
    expect(rgbToHsl(0.3, 0.3, 0.3)).toEqual([0, 0, 0.3]);
  });
  it('hex', () => {
    expect(hex6(1, 0.5, 0)).toBe('#FF8000');
    expect(hex6(2, -1, 0)).toBe('#FF0000');
  });
  it('canvas → image px and texel mapping', () => {
    const r = { x: 100, y: 50, w: 400, h: 200, fullW: 800, fullH: 400 };
    expect(canvasToImagePx(99, 60, r)).toBeNull();
    expect(canvasToImagePx(100, 50, r)).toEqual({ x: 0, y: 0 });
    expect(canvasToImagePx(499.9, 249.9, r)).toEqual({ x: 799, y: 399 });
    expect(canvasToImagePx(300, 150, r)).toEqual({ x: 400, y: 200 });
    // a half-resolution preview texture
    expect(imageToTexel(400, 200, 800, 400, 400, 200)).toEqual({ x: 200, y: 100 });
    expect(imageToTexel(799, 399, 800, 400, 400, 200)).toEqual({ x: 399, y: 199 });
  });
  it('sample blocks clamp at the edges', () => {
    expect(sampleBlock(10, 10, 5, 100, 100)).toEqual([8, 8, 5, 5]);
    expect(sampleBlock(0, 0, 3, 100, 100)).toEqual([0, 0, 2, 2]);
    expect(sampleBlock(5, 5, 1, 100, 100)).toEqual([5, 5, 1, 1]);
  });
  it('averages', () => {
    expect(averageRgba([0, 0, 0, 1, 1, 0.5, 0, 1])).toEqual([0.5, 0.25, 0, 1]);
  });
});

describe('compare split hit-testing', () => {
  it('left/right split: line within tolerance, knob radius', () => {
    expect(splitHit(400, 10, 'h', 0.5, 800, 600)).toBe(true);
    expect(splitHit(409, 590, 'h', 0.5, 800, 600)).toBe(true);
    expect(splitHit(415, 10, 'h', 0.5, 800, 600)).toBe(false);
    expect(splitHit(415, 300, 'h', 0.5, 800, 600)).toBe(true); // knob
    expect(splitHit(400, 300, 'toggle', 0.5, 800, 600)).toBe(false);
  });
  it('top/bottom split', () => {
    expect(splitHit(10, 150, 'v', 0.25, 800, 600)).toBe(true);
    expect(splitHit(10, 170, 'v', 0.25, 800, 600)).toBe(false);
    expect(splitHit(400, 165, 'v', 0.25, 800, 600)).toBe(true);
  });
  it('pointer → split fraction is clamped', () => {
    expect(splitFromPointer(200, 0, 'h', 800, 600)).toBe(0.25);
    expect(splitFromPointer(-5, 0, 'h', 800, 600)).toBe(0);
    expect(splitFromPointer(0, 900, 'v', 800, 600)).toBe(1);
  });
  it('sides, swap and hold', () => {
    expect(splitSide(100, 0, 'h', 0.5, 800, 600)).toBe('ref');
    expect(splitSide(500, 0, 'h', 0.5, 800, 600)).toBe('main');
    expect(splitSide(100, 0, 'h', 0.5, 800, 600, true)).toBe('main');
    expect(splitSide(0, 100, 'v', 0.5, 800, 600)).toBe('ref');
    expect(splitSide(0, 100, 'toggle', 0.5, 800, 600)).toBe('main');
    expect(splitSide(700, 100, 'h', 0.5, 800, 600, false, true)).toBe('ref');
  });
});
