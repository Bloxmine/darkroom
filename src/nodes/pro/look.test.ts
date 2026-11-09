import { describe, expect, it } from 'vitest';
import { haldToCube, identityHald, LOOK_NAMES } from './look';

describe('Hald CLUT', () => {
  it('identity Hald (level 4: 64×64, 16³) decodes to an identity cube, red fastest', () => {
    const h = identityHald(4);
    expect([h.width, h.height]).toEqual([64, 64]);
    const cube = haldToCube(h.data as Uint8Array as unknown as Uint8ClampedArray, 64);
    expect(cube.size).toBe(16);
    const at = (r: number, g: number, b: number) => Array.from(cube.data.slice((r + g * 16 + b * 256) * 3, (r + g * 16 + b * 256) * 3 + 3));
    expect(at(15, 0, 0)).toEqual([1, 0, 0]);
    expect(at(0, 15, 0)).toEqual([0, 1, 0]);
    expect(at(0, 0, 15)).toEqual([0, 0, 1]);
    at(5, 9, 2).forEach((v, i) => expect(v).toBeCloseTo([5, 9, 2][i] / 15, 2));
  });
  it('rejects non-Hald sizes', () => expect(() => haldToCube(new Uint8ClampedArray(100 * 100 * 4), 100)).toThrow());
  it('ships the requested looks', () => {
    for (const l of ['Teal & Orange', 'Bleach Bypass', 'Kodachrome-ish', 'Cross Cool', 'Faded Matte', 'Day for Night']) expect(LOOK_NAMES).toContain(l);
  });
});
