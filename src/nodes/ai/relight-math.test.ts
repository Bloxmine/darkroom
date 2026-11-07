import { describe, expect, it } from 'vitest';
import {
  blinnExponent, cvToGl, decodeNormal, dot3, encodeNormal, geometryTextures, lightVector, normalize3, RIGS, rigParams, solve4, spotCone, wrapDiffuse, type Vec3,
} from './relight-math';

const close3 = (a: Vec3, b: Vec3, digits = 6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));

describe('normal-map encoding', () => {
  it('a surface facing the camera is the usual lilac-blue and decodes to +z', () => {
    close3(encodeNormal([0, 0, 1]), [0.5, 0.5, 1]);
    close3(decodeNormal([0.5, 0.5, 1]), [0, 0, 1]);
  });

  it('green = up in the map, which is −y in the (y-down) shading frame', () => {
    const up = decodeNormal(encodeNormal([0, 1, 0.0001]));
    expect(up[1]).toBeLessThan(-0.99);
    const right = decodeNormal(encodeNormal([1, 0, 0.0001]));
    expect(right[0]).toBeGreaterThan(0.99);
  });

  it('round-trips a tilted normal (y flipped into the shading frame)', () => {
    const n = normalize3([0.3, -0.4, 0.8]);
    close3(decodeNormal(encodeNormal(n)), [n[0], -n[1], n[2]], 5);
  });

  it('gain flattens or exaggerates the relief', () => {
    const rgb = encodeNormal(normalize3([0.5, 0, 0.8]));
    close3(decodeNormal(rgb, 0), [0, 0, 1]);
    expect(decodeNormal(rgb, 2)[0]).toBeGreaterThan(decodeNormal(rgb, 1)[0]);
  });

  it('folds back-facing values to face the viewer', () => {
    expect(decodeNormal([0.5, 0.5, 0.2])[2]).toBeGreaterThan(0);
  });

  it('MoGe / OpenCV camera space → OpenGL map frame', () => {
    close3(cvToGl([0, 0, -1]), [0, 0, 1]); // faces the camera
    close3(cvToGl([0, -1, 0]), [0, 1, 0]); // a floor (OpenCV y is down, so "up" is −y)
    close3(cvToGl([1, 0, 0]), [1, 0, 0]);
  });
});

describe('light vectors', () => {
  const aspect = 1.5, ds = 0.3;
  const P: Vec3 = [0.75, 0.5, 0.2]; // image centre, depth 0.2

  it('point light up-left in front of the image points up-left and towards the viewer', () => {
    const { l, dist } = lightVector(0, [0.2, 0.1], 0.4, P, aspect, ds);
    expect(l[0]).toBeLessThan(0);
    expect(l[1]).toBeLessThan(0); // y down: up = negative
    expect(l[2]).toBeGreaterThan(0);
    expect(Math.hypot(...l)).toBeCloseTo(1, 9);
    const L: Vec3 = [0.2 * aspect, 0.1, 0.4 + ds];
    expect(dist).toBeCloseTo(Math.hypot(L[0] - P[0], L[1] - P[1], L[2] - P[2]), 9);
  });

  it('a light directly in front lights a camera-facing surface fully', () => {
    const { l } = lightVector(0, [0.5, 0.5], 0.5, P, aspect, ds);
    close3(l, [0, 0, 1]);
    expect(dot3(l, [0, 0, 1])).toBeCloseTo(1, 9);
  });

  it('negative height puts the light behind the subject (rim light)', () => {
    const { l } = lightVector(0, [0.9, 0.5], -0.25, P, aspect, ds);
    expect(l[2]).toBeLessThan(0);
    // a silhouette edge facing right is lit, the camera-facing front is not
    expect(dot3(l, [1, 0, 0])).toBeGreaterThan(0);
    expect(dot3(l, [0, 0, 1])).toBeLessThan(0);
  });

  it('directional light depends only on the handle offset from the centre and the elevation', () => {
    const a = lightVector(2, [0.9, 0.5], 0.3, P, aspect, ds);
    const b = lightVector(2, [0.9, 0.5], 0.3, [0.1, 0.9, 0], aspect, ds);
    close3(a.l, b.l);
    expect(a.dist).toBe(Infinity);
    close3(a.l, normalize3([0.4 * aspect, 0, 0.3]));
    // higher elevation → closer to the view axis
    expect(lightVector(2, [0.9, 0.5], 2, P, aspect, ds).l[2]).toBeGreaterThan(a.l[2]);
  });
});

describe('material terms', () => {
  it('wrap 0 is Lambert; wrap lights past the terminator', () => {
    expect(wrapDiffuse(0.6, 0)).toBeCloseTo(0.6, 9);
    expect(wrapDiffuse(-0.3, 0)).toBe(0);
    expect(wrapDiffuse(-0.3, 0.5)).toBeGreaterThan(0);
    expect(wrapDiffuse(1, 0.5)).toBeCloseTo(1, 9);
  });

  it('rougher surfaces have broader (smaller-exponent) highlights', () => {
    expect(blinnExponent(0.1)).toBeGreaterThan(blinnExponent(0.4));
    expect(blinnExponent(0.4)).toBeGreaterThan(blinnExponent(0.9));
    expect(blinnExponent(1)).toBeGreaterThanOrEqual(2);
    expect(blinnExponent(0)).toBeLessThanOrEqual(2048);
  });

  it('spot cone: full on axis, dark outside the angle', () => {
    expect(spotCone(1, 30, 0.5)).toBeCloseTo(1, 9);
    expect(spotCone(Math.cos((40 * Math.PI) / 180), 30, 0.5)).toBe(0);
    const mid = spotCone(Math.cos((25 * Math.PI) / 180), 30, 0.5);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });
});

describe('existing-shading fit', () => {
  it('solve4 recovers Y = c0 + c·n from least-squares normal equations', () => {
    const c = [0.4, 0.2, -0.1, 0.3];
    const M = [0, 1, 2, 3].map(() => [0, 0, 0, 0]);
    const r = [0, 0, 0, 0];
    for (let i = 0; i < 200; i++) {
      const n = normalize3([Math.sin(i * 1.3), Math.cos(i * 0.7), 0.5 + 0.5 * Math.abs(Math.sin(i * 0.37))]);
      const b = [1, ...n];
      const Y = c[0] + c[1] * n[0] + c[2] * n[1] + c[3] * n[2];
      for (let a = 0; a < 4; a++) {
        r[a] += Y * b[a];
        for (let k = 0; k < 4; k++) M[a][k] += b[a] * b[k];
      }
    }
    solve4(M, r)!.forEach((v, i) => expect(v).toBeCloseTo(c[i], 6));
  });

  it('solve4 reports a singular system', () => {
    expect(solve4([[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 0, 0], [0, 0, 0, 1]], [1, 1, 1, 1])).toBeNull();
  });
});

describe('MoGe post-processing', () => {
  it('encodes normals, puts near at white and the sky (mask 0) at 0', () => {
    const w = 3, h = 1;
    // pixel 0: near (z = 1), facing the camera; pixel 1: far (z = 4); pixel 2: sky (mask 0)
    const points = new Float32Array([0, 0, 1, 0, 0, 4, 0, 0, 100]);
    const normal = new Float32Array([0, 0, -1, 0, -1, 0, 0, 0, -1]);
    const mask = new Float32Array([1, 1, 0]);
    const g = geometryTextures(points, normal, mask, w, h);
    const n = g.normals.data;
    close3([n[0], n[1], n[2]], [0.5, 0.5, 1]);
    close3([n[4], n[5], n[6]], [0.5, 1, 0.5]); // floor: green = up
    expect(n[11]).toBe(0); // mask in alpha
    const d = g.depth.data;
    expect(d[0]).toBeCloseTo(1, 6);
    expect(d[4]).toBeCloseTo(0, 6);
    expect(d[8]).toBe(0);
  });
});

describe('light rigs', () => {
  it('every rig maps to relight params for all three lights', () => {
    for (const rig of Object.values(RIGS)) {
      const p = rigParams(rig);
      for (const s of ['', '2', '3']) {
        expect(Array.isArray(p['light' + s])).toBe(true);
        expect(typeof p['intensity' + s]).toBe('number');
        expect(['Point', 'Spot', 'Directional']).toContain(p['type' + s]);
      }
      expect(typeof p.on2).toBe('boolean');
      expect((p.color as number[]).length).toBe(4);
    }
  });
});
