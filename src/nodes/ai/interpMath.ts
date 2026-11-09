/**
 * Pure helpers for RIFE frame interpolation (unit-tested in interpMath.test.ts): timestep handling,
 * padding to the network's multiple of 64, and the slow-motion frame schedule used by the Smooth Slow
 * Motion video source and the "smooth slow motion" export.
 * Exports an empty NodeDef[] for the auto-registration glob.
 */
import type { NodeDef } from '../../core/types';

export default [] as NodeDef[];

/** RIFE 4.x needs H and W to be multiples of 64. */
export const RIFE_MULT = 64;

/** Below this distance from a source frame, the source frame itself is used (no inference). */
export const SNAP_EPS = 1e-3;

/**
 * What to produce for a timestep `t` between frame A (t = 0) and frame B (t = 1): A or B themselves
 * when `t` is (within SNAP_EPS of) an end, else an interpolation at `t` clamped to (0, 1). NaN → A.
 */
export function rifeTimestep(t: number): { kind: 'a' | 'b' | 'mid'; t: number } {
  if (!Number.isFinite(t) || t <= SNAP_EPS) return { kind: 'a', t: 0 };
  if (t >= 1 - SNAP_EPS) return { kind: 'b', t: 1 };
  return { kind: 'mid', t };
}

/**
 * Timestep of source time `s` between the decoded frame starting at `ts0` (seconds) with duration
 * `dur` and the next one: (s − ts0) / dur, clamped to 0..1. A missing/zero duration falls back to 1/fps.
 */
export function timestepBetween(s: number, ts0: number, dur: number, fps = 30): number {
  const d = dur > 1e-6 ? dur : 1 / Math.max(1, fps);
  return Math.min(1, Math.max(0, (s - ts0) / d));
}

/** Inference size: the image scaled so its short side is ≤ `maxShort` (0 = full size), rounded to ints. */
export function inferenceDims(w: number, h: number, maxShort: number): [number, number] {
  const s = maxShort > 0 ? Math.min(1, maxShort / Math.min(w, h)) : 1;
  return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
}

/** Round up to a multiple of `m`. */
export const padUp = (v: number, m = RIFE_MULT) => Math.max(m, Math.ceil(v / m) * m);

/** RGB HWC (w×h) → NCHW [1,3,ph,pw], edge-replicated into the padding (as the reference `F.pad(..., 'replicate')`). */
export function padToCHW(rgb: Float32Array, w: number, h: number, pw: number, ph: number): Float32Array {
  const n = pw * ph;
  const out = new Float32Array(3 * n);
  for (let y = 0; y < ph; y++) {
    const sy = Math.min(h - 1, y);
    for (let x = 0; x < pw; x++) {
      const s = (sy * w + Math.min(w - 1, x)) * 3;
      const o = y * pw + x;
      out[o] = rgb[s];
      out[n + o] = rgb[s + 1];
      out[2 * n + o] = rgb[s + 2];
    }
  }
  return out;
}

/** NCHW [1,3,ph,pw] → top-left w×h crop as RGBA8 (clamped). */
export function cropToRGBA8(chw: Float32Array, pw: number, ph: number, w: number, h: number): Uint8Array {
  const n = pw * ph;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = y * pw + x;
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) out[o + c] = Math.round(Math.min(1, Math.max(0, chw[c * n + s])) * 255);
      out[o + 3] = 255;
    }
  }
  return out;
}

/**
 * Slow-motion schedule: output frame `i` of a ×`factor` slow motion lies between source frames
 * `src` and `src + 1`, at timestep `t` (0 = exactly source frame `src`).
 */
export function slowMoFrame(i: number, factor: number): { src: number; t: number } {
  const k = Math.max(1, Math.round(factor));
  return { src: Math.floor(i / k), t: (i % k) / k };
}

/** Output frames of a ×`factor` slow motion of `seconds` of timeline at `fps`. */
export const slowMoFrameCount = (seconds: number, fps: number, factor: number) => Math.max(1, Math.round(seconds * fps * Math.max(1, Math.round(factor))));
