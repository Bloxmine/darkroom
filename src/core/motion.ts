import type { ParamDef, PassContext, UniformValue } from './types';

/**
 * Helpers that make seeded noise nodes move during playback / video export
 * WITHOUT touching their shader code: `uniforms()` overrides the node's own
 * `u_seed` (or another param uniform) per frame. At frame 0 / time 0 nothing is
 * overridden, so stills and still exports stay bit-identical. See docs/VIDEO.md.
 */
export const ANIMATE_PARAM: ParamDef = {
  type: 'bool',
  default: true,
  label: 'Animate',
  description: 'Move / re-seed the noise every frame during playback and video export (frame 0 is the still look).',
};

const animating = (c: PassContext) => c.params.animate !== false && c.params.animate !== 0;

/**
 * A fresh integer seed every `hold` frames: `u_<key>` = seed + k·(1 + n mod 509) for n = ⌊frame / hold⌋ > 0.
 * Small offsets keep noise coordinates (seed × constant) well inside float precision.
 */
export function animSeed(c: PassContext, def: number, key = 'seed', hold = 1): Record<string, UniformValue> {
  const n = Math.floor((c.frame ?? 0) / hold);
  if (!n || !animating(c)) return {};
  const v = c.params[key];
  const seed = typeof v === 'number' ? v : def;
  return { ['u_' + key]: Math.round(seed) + 7 * (1 + (n % 509)) };
}

/** Smooth 1D value noise in [-1, 1] that is exactly 0 at t = 0. */
export function drift(t: number, k = 0) {
  const h = (i: number) => {
    const x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
    return x - Math.floor(x);
  };
  const n = (x: number) => {
    const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
    return h(i) * (1 - u) + h(i + 1) * u;
  };
  return (n(t) - n(0)) * 2;
}

/** Override float param uniforms with time-dependent values (nothing at time 0 or with Animate off). */
export function animFloat(c: PassContext, values: (t: number) => Record<string, number>): Record<string, UniformValue> {
  const t = c.time ?? 0;
  if (!t || !animating(c)) return {};
  return values(t);
}

/** Current numeric param value with fallback. */
export const pnum = (c: PassContext, key: string, def: number) => {
  const v = c.params[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : def;
};
