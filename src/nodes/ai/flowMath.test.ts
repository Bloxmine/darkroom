import { describe, expect, it } from 'vitest';
import { blockFlow, encodeFlow, flowColor, hashPixels, makeColorWheel, robustMaxMagnitude, sampleBilinear, warpByFlow, WHEEL_SIZE } from './flowMath';

describe('Middlebury colour wheel', () => {
  it('has the 55 canonical entries', () => {
    const w = makeColorWheel();
    expect(WHEEL_SIZE).toBe(55);
    expect([...w.subarray(0, 3)]).toEqual([255, 0, 0]); // RY starts red
    expect([...w.subarray(15 * 3, 15 * 3 + 3)]).toEqual([255, 255, 0]); // YG starts yellow
    expect([...w.subarray(54 * 3, 54 * 3 + 3)]).toEqual([255, 0, 43]); // last MR entry
  });

  it('matches the reference implementation (Baker et al. / OpenCV zoo demo)', () => {
    // values from the Python reference (scratch wheelref.py), (u, v) already normalised
    const ref: [number, number, [number, number, number]][] = [
      [0, 0, [1, 1, 1]],
      [1, 0, [1, 0, 0.1686]],
      [0, 1, [1, 0.9, 0]],
      [-1, 0, [0, 0.8196, 1]],
      [0, -1, [0.3451, 0, 1]],
      [0.5, 0.5, [1, 0.6111, 0.2929]],
      [-0.3, 0.7, [0.7487, 1, 0.2384]],
      [2, 0, [0.75, 0, 0.1265]], // beyond the max: dimmed
      [0.6, -0.8, [0.7709, 0, 1]],
    ];
    for (const [u, v, rgb] of ref) {
      const c = flowColor(u, v);
      for (let k = 0; k < 3; k++) expect(c[k]).toBeCloseTo(rgb[k], 3);
    }
  });

  it('is white for no motion and saturates with speed', () => {
    expect(flowColor(0, 0)).toEqual([1, 1, 1]);
    const slow = flowColor(0.2, 0), fast = flowColor(0.9, 0);
    expect(Math.min(...slow)).toBeGreaterThan(Math.min(...fast));
  });
});

describe('flow encoding', () => {
  it('negates the network flow (B→A) into motion A→B in image units', () => {
    // 2×1 network output: channel 0 = dx, channel 1 = dy (B pixel found at x + raw in A)
    const raw = Float32Array.from([-4, 2, /* dy */ 1, 0]);
    const f = encodeFlow(raw, 2, 1);
    expect(f[0]).toBeCloseTo(4 / 2); // moved right by 4 px of a 2 px wide image
    expect(f[1]).toBeCloseTo(-1 / 1);
    expect(f[4]).toBeCloseTo(-2 / 2);
    expect(f[3]).toBe(1);
  });

  it('robust max magnitude ignores a few outliers', () => {
    const n = 1000;
    const f = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) f[i * 4] = 2 / 100; // 2 px on a 100 px wide image
    f[0] = 5; // one 500 px outlier
    expect(robustMaxMagnitude(f, 100, 100)).toBeCloseTo(2, 4);
  });
});

/** w×h RGBA image whose red channel is x and green is y (pixel centres). */
function ramp(w: number, h: number) {
  const d = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    d[o] = x;
    d[o + 1] = y;
    d[o + 3] = 1;
  }
  return d;
}

describe('flow warp sampling', () => {
  it('samples pixel centres exactly and interpolates between them, clamped at the edges', () => {
    const img = ramp(4, 3);
    const o = new Float32Array(4);
    sampleBilinear(img, 4, 3, 2.5 / 4, 1.5 / 3, o, 0);
    expect([o[0], o[1]]).toEqual([2, 1]);
    sampleBilinear(img, 4, 3, 2 / 4, 1.5 / 3, o, 0); // between x = 1 and 2
    expect(o[0]).toBeCloseTo(1.5);
    sampleBilinear(img, 4, 3, -1, 2, o, 0); // clamp to edge
    expect([o[0], o[1]]).toEqual([0, 2]);
  });

  it('a constant flow of +1 px shifts the image right by one pixel (backward warp)', () => {
    const w = 8, h = 4;
    const img = ramp(w, h);
    const flow = Float32Array.from([1 / w, 0, 0, 1]); // 1×1 flow field: everything moved 1 px right
    const out = warpByFlow(img, w, h, flow, 1, 1, 1);
    for (let x = 1; x < w; x++) expect(out[(2 * w + x) * 4]).toBeCloseTo(x - 1); // out(x) = A(x − 1)
    expect(out[(2 * w) * 4]).toBeCloseTo(0); // clamped at the left edge
    // amount 0.5 lands half-way, −1 moves the other way
    const half = warpByFlow(img, w, h, flow, 1, 1, 0.5);
    expect(half[(1 * w + 4) * 4]).toBeCloseTo(3.5);
    const back = warpByFlow(img, w, h, flow, 1, 1, -1);
    expect(back[(1 * w + 4) * 4]).toBeCloseTo(5);
  });

  it('macroblocks hold one vector per block', () => {
    const w = 8, h = 8;
    // flow field 8×8 with dx = x (in px units of 8)
    const f = new Float32Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) f[(y * w + x) * 4] = x / 8;
    const b = blockFlow(f, w, h, w, h, 4);
    expect(b[0]).toBeCloseTo(b[(3 * w + 3) * 4]);
    expect(b[4 * 4]).toBeGreaterThan(b[3 * 4]);
    expect(b[(5 * w + 6) * 4]).toBeCloseTo(b[(7 * w + 4) * 4]);
  });

  it('hashes content exactly', () => {
    const a = Float32Array.from([0.1, 0.2, 0.3]);
    expect(hashPixels(a)).toBe(hashPixels(Float32Array.from([0.1, 0.2, 0.3])));
    expect(hashPixels(a)).not.toBe(hashPixels(Float32Array.from([0.1, 0.2, 0.31])));
  });
});
