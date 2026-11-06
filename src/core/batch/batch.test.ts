import { describe, expect, it } from 'vitest';
import { defaultSourceNode, sourceNodes, swapSourceAsset, updateNodeAt } from './graphInput';
import { expandPattern, fitLongEdge, formatEta, sanitizeFileName, uniqueNames } from './naming';
import type { Graph, GraphNode } from '../types';

describe('batch file names', () => {
  const date = new Date(2026, 10, 6);
  it('expands tokens', () => {
    expect(expandPattern('{name}_{preset}', { name: 'IMG_0001.CR3', preset: 'VHS Camcorder' })).toBe('IMG_0001_VHS Camcorder');
    expect(expandPattern('{n:3}-{name}', { name: 'a.jpg', index: 7 })).toBe('007-a');
    expect(expandPattern('{date}_{n}', { name: 'a.jpg', index: 12, date })).toBe('2026-11-06_12');
    expect(expandPattern('{name}.{ext}_{w}x{h}', { name: 'x.NEF', width: 1200, height: 800 })).toBe('x.nef_1200x800');
    expect(expandPattern('{unknown}', { name: 'a.jpg' })).toBe('{unknown}');
  });
  it('drops separators left by empty tokens and falls back to the source name', () => {
    expect(expandPattern('{name}_{preset}', { name: 'photo.jpg', preset: '' })).toBe('photo');
    expect(expandPattern('', { name: 'photo.jpg', preset: 'P' })).toBe('photo_P');
    expect(expandPattern('{preset}', { name: 'photo.jpg', preset: '' })).toBe('photo');
  });
  it('sanitises file names', () => {
    expect(sanitizeFileName('a/b\\c:d*e?"f<g>h|i')).toBe('a_b_c_d_e_f_g_h_i');
    expect(sanitizeFileName('..hidden. ')).toBe('hidden');
    expect(expandPattern('{name}', { name: 'we/ird:name.jpg' })).toBe('we_ird_name');
  });
  it('makes names unique', () => {
    expect(uniqueNames(['a.jpg', 'A.jpg', 'a.jpg', 'b.jpg'])).toEqual(['a.jpg', 'A (2).jpg', 'a (3).jpg', 'b.jpg']);
  });
  it('fits the long edge without upscaling', () => {
    expect(fitLongEdge(4000, 3000, 2000)).toEqual({ width: 2000, height: 1500, scale: 0.5 });
    expect(fitLongEdge(3000, 4000, 1000)).toMatchObject({ width: 750, height: 1000 });
    expect(fitLongEdge(800, 600, 2000)).toEqual({ width: 800, height: 600, scale: 1 });
    expect(fitLongEdge(800, 600, 0).scale).toBe(1);
  });
  it('formats ETAs', () => {
    expect(formatEta(5.4)).toBe('5s');
    expect(formatEta(65)).toBe('1m 05s');
    expect(formatEta(NaN)).toBe('—');
  });
});

const node = (id: string, type: string, params = {}): GraphNode => ({ id, type, params, position: { x: 0, y: 0 } });

describe('batch input node', () => {
  // a → fx → out, with a stray image b and a raw r feeding fx's second input
  const g: Graph = {
    nodes: [node('b', 'core.image'), node('a', 'core.image', { asset: 'x' }), node('fx', 'test.fx'), node('r', 'core.raw'), node('out', 'core.output')],
    edges: [
      { id: 'e1', from: { node: 'a', port: 'out' }, to: { node: 'fx', port: 'image' } },
      { id: 'e2', from: { node: 'r', port: 'out' }, to: { node: 'fx', port: 'b' } },
      { id: 'e3', from: { node: 'fx', port: 'out' }, to: { node: 'out', port: 'image' } },
    ],
  };
  it('lists sources feeding the output first', () => {
    const s = sourceNodes(g, 'out');
    expect(s.map((x) => [x.id, x.feedsOutput])).toEqual([
      ['a', true],
      ['r', true],
      ['b', false],
    ]);
    expect(defaultSourceNode(g)).toBe('a');
    expect(defaultSourceNode({ nodes: [node('o', 'core.output')], edges: [] })).toBeUndefined();
  });
  it('swaps the asset, switching node type for RAW files, without mutating the input', () => {
    const g2 = swapSourceAsset(g, 'a', 'new', true);
    expect(g2.nodes.find((n) => n.id === 'a')).toMatchObject({ type: 'core.raw', params: { asset: 'new' } });
    expect(g.nodes.find((n) => n.id === 'a')).toMatchObject({ type: 'core.image', params: { asset: 'x' } });
    const g3 = swapSourceAsset(swapSourceAsset(g, 'r', 'y', true), 'r', 'z', true);
    expect(g3.nodes.find((n) => n.id === 'r')?.params.asset).toBe('z');
  });
  it('updates nodes inside groups by flat id', () => {
    const inner: Graph = { nodes: [node('i', 'core.image')], edges: [] };
    const grp: GraphNode = { ...node('g', 'core.group'), group: { name: 'G', graph: inner, exposed: [] } };
    const root: Graph = { nodes: [grp], edges: [] };
    const r = updateNodeAt(root, 'g/i', (n) => ({ ...n, params: { asset: 'q' } }));
    expect(r.nodes[0].group!.graph.nodes[0].params.asset).toBe('q');
    expect(inner.nodes[0].params.asset).toBeUndefined();
    expect(updateNodeAt(root, 'nope', (n) => n)).toBe(root);
  });
});
