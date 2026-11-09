import { describe, expect, it } from 'vitest';
import { findHealSource, ringWeights } from './local-heal-math';

function image(W: number, H: number, f: (x: number, y: number) => number) {
  const data = new Float32Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const v = f(x, y); data.set([v, v, v, 1], (y * W + x) * 4); }
  return { width: W, height: H, data };
}
function disc(W: number, H: number, cx: number, cy: number, r: number) {
  const m = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) m[y * W + x] = 1;
  return m;
}

describe('heal helpers', () => {
  it('ring surrounds the mask only', () => {
    const m = disc(40, 40, 20, 20, 5);
    const r = ringWeights(m, 40, 40, 2);
    expect(r[20 * 40 + 20]).toBe(0); // inside
    expect(r[20 * 40 + 26]).toBe(1); // just outside
    expect(r[20 * 40 + 30]).toBe(0); // far
  });
  it('picks a source that does not overlap the blemish and matches the texture phase', () => {
    // vertical stripes of period 8 with a dark blemish: the best source keeps the stripe phase (dx ≡ 0 mod 8)
    const W = 200, H = 120;
    const img = image(W, H, (x, y) => ((x % 8) < 4 ? 0.7 : 0.3) + 0.001 * y);
    const m = disc(W, H, 100, 60, 6);
    for (let i = 0; i < W * H; i++) if (m[i]) img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = 0.05;
    const off = findHealSource(img, m, true)!;
    expect(off).not.toBeNull();
    const dx = Math.round(off[0] * W), dy = Math.round(off[1] * H);
    expect(Math.max(Math.abs(dx), Math.abs(dy))).toBeGreaterThan(12);
    expect(((dx % 8) + 8) % 8).toBe(0);
  });
  it('returns null for an empty mask', () => {
    expect(findHealSource(image(10, 10, () => 0.5), new Float32Array(100), true)).toBeNull();
  });
});
