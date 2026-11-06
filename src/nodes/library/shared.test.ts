import { describe, expect, it } from 'vitest';
import { cubeToAtlas, normalizeCurve, parseCube, sampleCurve } from './shared';
import { expressionSource } from './math';

describe('curves', () => {
  it('identity curve samples to identity', () => {
    const s = sampleCurve([[0, 0], [1, 1]]);
    expect(s.length).toBe(256);
    for (let i = 0; i < 256; i += 17) expect(s[i]).toBeCloseTo(i / 255, 5);
  });
  it('passes through control points and is monotone for monotone data', () => {
    const pts = [[0, 0], [0.25, 0.1], [0.5, 0.5], [0.75, 0.9], [1, 1]];
    const s = sampleCurve(pts, 257);
    expect(s[64]).toBeCloseTo(0.1, 4);
    expect(s[128]).toBeCloseTo(0.5, 4);
    expect(s[192]).toBeCloseTo(0.9, 4);
    for (let i = 1; i < s.length; i++) expect(s[i]).toBeGreaterThanOrEqual(s[i - 1] - 1e-6);
  });
  it('sorts points, clamps, and holds flat outside the range', () => {
    expect(normalizeCurve([[1, 1], [0.5, 2], [0, 0]])).toEqual([[0, 0], [0.5, 1], [1, 1]]);
    const s = sampleCurve([[0.2, 0.3], [0.8, 0.6]]);
    expect(s[0]).toBeCloseTo(0.3);
    expect(s[255]).toBeCloseTo(0.6);
  });
  it('falls back to identity on garbage', () => {
    expect(normalizeCurve(null)).toEqual([[0, 0], [1, 1]]);
    expect(normalizeCurve([['x', 1]])).toEqual([[0, 0], [1, 1]]);
  });
});

function identityCube(n: number, extra = '') {
  const rows = [`TITLE "id"`, `# comment`, `LUT_3D_SIZE ${n}`, extra];
  for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) rows.push(`${r / (n - 1)} ${g / (n - 1)} ${b / (n - 1)}`);
  return rows.join('\r\n');
}

describe('.cube parser', () => {
  it('parses a 3D LUT with red varying fastest', () => {
    const lut = parseCube(identityCube(3));
    expect(lut.size).toBe(3);
    expect(lut.data.length).toBe(27 * 3);
    expect([...lut.data.slice(3, 6)]).toEqual([0.5, 0, 0]);
    expect([...lut.data.slice(9, 12)]).toEqual([0, 0.5, 0]);
    expect(lut.domainMin).toEqual([0, 0, 0]);
  });
  it('reads DOMAIN_MIN/MAX', () => {
    const lut = parseCube(identityCube(2, 'DOMAIN_MIN 0 0 0\nDOMAIN_MAX 2 2 2'));
    expect(lut.domainMax).toEqual([2, 2, 2]);
  });
  it('expands 1D LUTs to 3D', () => {
    const lut = parseCube('LUT_1D_SIZE 2\n0 0 0\n1 0.5 0.25\n');
    expect(lut.size).toBe(33);
    const last = (32 + 32 * 33 + 32 * 33 * 33) * 3;
    expect(lut.data[last]).toBeCloseTo(1);
    expect(lut.data[last + 1]).toBeCloseTo(0.5);
    expect(lut.data[last + 2]).toBeCloseTo(0.25);
  });
  it('rejects malformed files', () => {
    expect(() => parseCube('0 0 0')).toThrow();
    expect(() => parseCube('LUT_3D_SIZE 4\n0 0 0')).toThrow();
  });
  it('lays out the atlas as x = r + b*N, y = g', () => {
    const N = 3;
    const t = cubeToAtlas(parseCube(identityCube(N)));
    expect(t.width).toBe(9);
    expect(t.height).toBe(3);
    // r=2, g=1, b=2 → x = 2 + 6 = 8, y = 1
    const i = (1 * 9 + 8) * 4;
    expect([...t.data.slice(i, i + 4)]).toEqual([1, 0.5, 1, 1]);
  });
});

describe('expression source', () => {
  it('wraps single expressions and passes through bodies with return', () => {
    expect(expressionSource({ expr: 'a * 2.0' })).toContain('return lib_toVec4(a * 2.0);');
    expect(expressionSource({ expr: 'float l = luma(a.rgb);\nreturn vec4(l);' })).toContain('return vec4(l);');
    expect(expressionSource({ expr: '' })).toContain('return lib_toVec4(a);');
  });
});
