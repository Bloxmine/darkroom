import { describe, expect, it } from 'vitest';
import { cropToRGBA8, inferenceDims, padToCHW, padUp, rifeTimestep, slowMoFrame, slowMoFrameCount, SNAP_EPS, timestepBetween } from './interpMath';

describe('RIFE timestep handling', () => {
  it('snaps the ends to the source frames and keeps the middle', () => {
    expect(rifeTimestep(0)).toEqual({ kind: 'a', t: 0 });
    expect(rifeTimestep(SNAP_EPS / 2)).toEqual({ kind: 'a', t: 0 });
    expect(rifeTimestep(1)).toEqual({ kind: 'b', t: 1 });
    expect(rifeTimestep(1 - SNAP_EPS / 2).kind).toBe('b');
    expect(rifeTimestep(0.25)).toEqual({ kind: 'mid', t: 0.25 });
    expect(rifeTimestep(-3).kind).toBe('a');
    expect(rifeTimestep(7).kind).toBe('b');
    expect(rifeTimestep(NaN).kind).toBe('a');
  });

  it('places a source time between two decoded frames', () => {
    // frame at 1.0 s lasting 1/30 s
    expect(timestepBetween(1.0, 1.0, 1 / 30)).toBe(0);
    expect(timestepBetween(1 + 1 / 60, 1.0, 1 / 30)).toBeCloseTo(0.5);
    expect(timestepBetween(1 + 1 / 120, 1.0, 1 / 30)).toBeCloseTo(0.25);
    expect(timestepBetween(2, 1.0, 1 / 30)).toBe(1);
    expect(timestepBetween(0.5, 1.0, 1 / 30)).toBe(0);
    // missing duration: 1/fps
    expect(timestepBetween(1 + 1 / 48, 1.0, 0, 24)).toBeCloseTo(0.5);
  });

  it('schedules ×2 and ×4 slow motion', () => {
    expect([0, 1, 2, 3].map((i) => slowMoFrame(i, 2))).toEqual([
      { src: 0, t: 0 },
      { src: 0, t: 0.5 },
      { src: 1, t: 0 },
      { src: 1, t: 0.5 },
    ]);
    expect([4, 5, 6, 7].map((i) => slowMoFrame(i, 4).t)).toEqual([0, 0.25, 0.5, 0.75]);
    expect(slowMoFrame(9, 4).src).toBe(2);
    expect(slowMoFrameCount(3, 30, 2)).toBe(180);
    expect(slowMoFrameCount(3, 30, 4)).toBe(360);
    // the slow-motion source sees source time = timeline time × speed (speed = 1 / factor): output frame i
    // of a ×4 export lands on source frame floor(i / 4) at timestep (i mod 4) / 4
    const fps = 30, factor = 4;
    for (let i = 0; i < 12; i++) {
      const s = (i / fps) / factor;
      const k = Math.floor(s * fps + 1e-9);
      expect(timestepBetween(s, k / fps, 1 / fps)).toBeCloseTo(slowMoFrame(i, factor).t);
      expect(k).toBe(slowMoFrame(i, factor).src);
    }
  });
});

describe('RIFE padding', () => {
  it('pads to multiples of 64 and computes inference sizes', () => {
    expect(padUp(540)).toBe(576);
    expect(padUp(64)).toBe(64);
    expect(padUp(1)).toBe(64);
    expect(inferenceDims(1920, 1080, 0)).toEqual([1920, 1080]);
    expect(inferenceDims(1920, 1080, 720)).toEqual([1280, 720]);
    expect(inferenceDims(640, 360, 720)).toEqual([640, 360]); // never upscales
  });

  it('edge-replicates into the padding and crops back losslessly', () => {
    const w = 3, h = 2, pw = 4, ph = 3;
    const rgb = new Float32Array(w * h * 3);
    for (let i = 0; i < rgb.length; i++) rgb[i] = (i % 7) / 7;
    const chw = padToCHW(rgb, w, h, pw, ph);
    const n = pw * ph;
    // padded column 3 repeats column 2, padded row 2 repeats row 1
    expect(chw[0 * pw + 3]).toBe(chw[0 * pw + 2]);
    expect(chw[n + 2 * pw + 1]).toBe(chw[n + 1 * pw + 1]);
    const back = cropToRGBA8(chw, pw, ph, w, h);
    for (let i = 0; i < w * h; i++) {
      for (let c = 0; c < 3; c++) expect(back[i * 4 + c]).toBe(Math.round(rgb[i * 3 + c] * 255));
      expect(back[i * 4 + 3]).toBe(255);
    }
  });
});
