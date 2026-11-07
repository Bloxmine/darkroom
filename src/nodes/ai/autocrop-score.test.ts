import { describe, expect, it } from 'vitest';
import { bestCrop, cropSize, targetAspect, type CropInput } from './autocrop-score';

/** Grid with a filled rectangle (normalised) of value 1. */
function grid(sw: number, sh: number, rects: [number, number, number, number][]): CropInput {
  const sal = new Float32Array(sw * sh);
  for (const [a, b, c, d] of rects) {
    for (let y = Math.floor(b * sh); y < Math.ceil(d * sh); y++) for (let x = Math.floor(a * sw); x < Math.ceil(c * sw); x++) sal[y * sw + x] = 1;
  }
  return { sal, sw, sh, faces: [] };
}

describe('aspect & size', () => {
  it('parses aspects', () => {
    expect(targetAspect('4:5', 100, 100)).toBeCloseTo(0.8);
    expect(targetAspect('16:9', 1, 1)).toBeCloseTo(16 / 9);
    expect(targetAspect('original', 1600, 1067)).toBeCloseTo(1600 / 1067);
    expect(targetAspect('custom', 1, 1, 7, 3)).toBeCloseTo(7 / 3);
  });
  it('largest rect of the ratio, shrunk by zoom', () => {
    expect(cropSize(1600, 1067, 1, 0)).toEqual([1067, 1067]);
    expect(cropSize(1600, 1067, 4 / 5, 0)).toEqual([854, 1067]);
    expect(cropSize(1200, 1500, 16 / 9, 0)).toEqual([1200, 675]);
    expect(cropSize(1000, 1000, 1, 1)).toEqual([400, 400]);
    expect(cropSize(1600, 1067, 1600 / 1067, 0)).toEqual([1600, 1067]);
  });
});

describe('best crop', () => {
  it('follows the subject and does not cut it', () => {
    const inp = grid(64, 40, [[0.72, 0.3, 0.85, 0.8]]);
    const r = bestCrop(inp, 0.4, 1, 'subject', 0.05);
    expect(r.x).toBeLessThanOrEqual(0.72 - 0.4 * 0.05 + 1e-6);
    expect(r.x + 0.4).toBeGreaterThanOrEqual(0.85);
  });

  it('is deterministic and centred without content', () => {
    const inp = grid(32, 32, []);
    const a = bestCrop(inp, 0.5, 0.5, 'subject', 0);
    const b = bestCrop(inp, 0.5, 0.5, 'subject', 0);
    expect(a).toEqual(b);
    expect(a.x).toBeCloseTo(0.25);
    expect(a.y).toBeCloseTo(0.25);
  });

  it('thirds mode puts the subject on a thirds point', () => {
    const inp = grid(90, 90, [[0.48, 0.48, 0.52, 0.52]]);
    const r = bestCrop(inp, 0.6, 0.6, 'thirds', 0);
    const cx = (0.5 - r.x) / 0.6, cy = (0.5 - r.y) / 0.6;
    const d = Math.min(...[1 / 3, 2 / 3].flatMap((a) => [1 / 3, 2 / 3].map((b) => Math.hypot(cx - a, cy - b))));
    expect(d).toBeLessThan(0.06);
  });

  it('faces mode keeps the face whole, with headroom, eyes near the upper third', () => {
    const inp = grid(60, 60, [[0.3, 0.2, 0.7, 1]]);
    inp.faces = [{ box: [0.42, 0.25, 0.58, 0.45], eyeY: 0.33 }];
    const r = bestCrop(inp, 0.5, 0.5, 'faces', 0);
    expect(r.x).toBeLessThanOrEqual(0.42);
    expect(r.x + 0.5).toBeGreaterThanOrEqual(0.58);
    const head = 0.25 - 0.2 * 0.35;
    expect(r.y).toBeLessThanOrEqual(head);
    expect(Math.abs((0.33 - r.y) / 0.5 - 1 / 3)).toBeLessThan(0.12);
  });

  it('never cuts through a face when it can avoid it', () => {
    const inp = grid(80, 40, [[0.1, 0.2, 0.9, 1]]);
    inp.faces = [
      { box: [0.2, 0.3, 0.3, 0.5], eyeY: 0.38 },
      { box: [0.45, 0.3, 0.55, 0.5], eyeY: 0.38 },
    ];
    const r = bestCrop(inp, 0.3, 1, 'faces', 0);
    for (const f of inp.faces) {
      const inside = f.box[0] >= r.x - 1e-6 && f.box[2] <= r.x + 0.3 + 1e-6;
      const outside = f.box[2] <= r.x + 1e-6 || f.box[0] >= r.x + 0.3 - 1e-6;
      expect(inside || outside).toBe(true);
    }
  });
});
