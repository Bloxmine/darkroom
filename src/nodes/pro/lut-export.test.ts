import { beforeAll, describe, expect, it } from 'vitest';
import { registerNodes } from '../../core/registry';
import core from '../core';
import { parseCube } from '../library/shared';
import lut, { buildLutGraph, latticeData, writeCube } from './lut-export';
import colorNodes from './color-nodes';
import type { Graph } from '../../core/types';

beforeAll(() => {
  registerNodes(core);
  registerNodes(lut);
  registerNodes(colorNodes);
  registerNodes([{ id: 't.blur', name: 'Blur', category: 't', inputs: { image: { type: 'image' } }, params: {}, passes: [{ frag: '' }] }]);
});

describe('.cube export', () => {
  it('identity lattice → .cube → parseCube round-trips exactly (red fastest)', () => {
    const N = 5;
    const cube = parseCube(writeCube(latticeData(N), N));
    expect(cube.size).toBe(N);
    for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++) {
      const o = (r + g * N + b * N * N) * 3;
      expect(cube.data[o]).toBeCloseTo(r / (N - 1), 6);
      expect(cube.data[o + 1]).toBeCloseTo(g / (N - 1), 6);
      expect(cube.data[o + 2]).toBeCloseTo(b / (N - 1), 6);
    }
  });
  it('a transformed lattice keeps its values through the writer/reader', () => {
    const N = 9;
    const px = latticeData(N);
    for (let i = 0; i < px.length; i += 4) { const [r, g, b] = [px[i], px[i + 1], px[i + 2]]; px[i] = g * 0.8; px[i + 1] = Math.sqrt(b); px[i + 2] = 1 - r; }
    const back = parseCube(writeCube(px, N, 'swap "test"'));
    let maxErr = 0;
    for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++) {
      const o = (r + g * N + b * N * N) * 3;
      const R = r / (N - 1), G = g / (N - 1), B = b / (N - 1);
      maxErr = Math.max(maxErr, Math.abs(back.data[o] - G * 0.8), Math.abs(back.data[o + 1] - Math.sqrt(B)), Math.abs(back.data[o + 2] - (1 - R)));
    }
    expect(maxErr).toBeLessThan(1e-6);
  });
  it('substitutes sources upstream of the target and lists spatial nodes', () => {
    const g: Graph = {
      nodes: [
        { id: 'img', type: 'core.image', params: { asset: 'a' }, position: { x: 0, y: 0 } },
        { id: 'tm', type: 'pro.tonemap', params: {}, position: { x: 0, y: 0 } },
        { id: 'bl', type: 't.blur', params: {}, position: { x: 0, y: 0 } },
        { id: 'out', type: 'core.output', params: {}, position: { x: 0, y: 0 } },
      ],
      edges: [
        { id: 'e1', from: { node: 'img', port: 'out' }, to: { node: 'tm', port: 'image' } },
        { id: 'e2', from: { node: 'tm', port: 'out' }, to: { node: 'bl', port: 'image' } },
        { id: 'e3', from: { node: 'bl', port: 'out' }, to: { node: 'out', port: 'image' } },
      ],
    };
    const r = buildLutGraph(g, 'out', 17);
    expect(r.sources).toBe(1);
    expect(r.graph.nodes.find((n) => n.id === 'img')!.type).toBe('pro.lutLattice');
    expect(r.graph.nodes.find((n) => n.id === 'img')!.params.size).toBe(17);
    expect(r.spatial).toEqual(['Blur']);
    expect(r.graph.nodes.find((n) => n.id === 'bl')!.bypass).toBe(true);
    expect(buildLutGraph(g, 'tm', 17).spatial).toEqual([]);
  });
});
