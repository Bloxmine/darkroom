/** Pure helpers of the generation bridge (unit-tested). */
import type { Params } from '../types';

/** Generation size: explicit width/height (multiples of 8), else the input aspect with the short side = base size (multiples of 64). */
export function genSize(p: Params, aspect: number): [number, number] {
  const r8 = (v: number) => Math.max(64, Math.round(v / 8) * 8);
  const r64 = (v: number) => Math.max(64, Math.round(v / 64) * 64);
  const W = Number(p.width) || 0, H = Number(p.height) || 0;
  const base = Number(p.baseSize) || 512;
  if (W && H) return [r8(W), r8(H)];
  if (W) return [r8(W), r8(W / aspect)];
  if (H) return [r8(H * aspect), r8(H)];
  return aspect >= 1 ? [r64(base * aspect), r64(base)] : [r64(base), r64(base / aspect)];
}
