import { beforeAll, describe, expect, it } from 'vitest';
import {
  alignNodes,
  assignLayers,
  countCrossings,
  distributeNodes,
  findFreeSpot,
  frameMembers,
  fuzzyScore,
  matchSearchable,
  orderLayers,
  overlaps,
  reachable,
  spliceIntoEdge,
  tidyLayout,
  type PortsOf,
  type Rect,
} from './graphLayout';
import { registerNodes } from './registry';
import core from '../nodes/core';
import type { Edge, Frame, Graph } from './types';

beforeAll(() => registerNodes(core));

const E = (id: string, a: string, b: string, port = 'image'): Edge => ({ id, from: { node: a, port: 'out' }, to: { node: b, port } });
const N = (id: string, x: number, y: number) => ({ id, position: { x, y }, size: { width: 100, height: 50 } });

describe('tidy layout', () => {
  it('assigns layers by dependency and pulls sources next to their consumer', () => {
    // a → b → c → d, and x → d (x should sit in d's previous column, not column 0)
    const l = assignLayers(['a', 'b', 'c', 'd', 'x'], [E('1', 'a', 'b'), E('2', 'b', 'c'), E('3', 'c', 'd'), E('4', 'x', 'd', 'mask')]);
    expect([l.get('a'), l.get('b'), l.get('c'), l.get('d')]).toEqual([0, 1, 2, 3]);
    expect(l.get('x')).toBe(2);
  });

  it('reduces crossings with barycenter ordering', () => {
    // two chains drawn swapped: a1 → b2, a2 → b1 (with a1 above a2 and b1 above b2): one crossing,
    // plus a 3-wide bipartite mess
    const ids = ['a1', 'a2', 'a3', 'b1', 'b2', 'b3'];
    const edges = [E('1', 'a1', 'b3'), E('2', 'a2', 'b2'), E('3', 'a3', 'b1')];
    const y: Record<string, number> = { a1: 0, a2: 100, a3: 200, b1: 0, b2: 100, b3: 200 };
    const layer = assignLayers(ids, edges);
    const initial = [
      ['a1', 'a2', 'a3'],
      ['b1', 'b2', 'b3'],
    ];
    expect(countCrossings(initial, edges)).toBe(3);
    const { layers } = orderLayers(ids, edges, layer, (id) => y[id]);
    expect(countCrossings(layers, edges)).toBe(0);
  });

  it('handles long edges with dummy nodes and never increases crossings', () => {
    const ids = ['s', 'a', 'b', 'c', 't', 'u'];
    const edges = [E('1', 's', 'a'), E('2', 'a', 'b'), E('3', 'b', 'c'), E('4', 's', 'c', 'mask'), E('5', 't', 'u'), E('6', 'u', 'b', 'mask')];
    const y: Record<string, number> = { s: 300, a: 0, b: 200, c: 0, t: 0, u: 400 };
    const layer = assignLayers(ids, edges);
    const naive = Array.from({ length: 4 }, (_, l) => ids.filter((id) => layer.get(id) === l).sort((p, q) => y[p] - y[q]));
    const { layers, edges: segs } = orderLayers(ids, edges, layer, (id) => y[id]);
    expect(countCrossings(layers, segs)).toBeLessThanOrEqual(countCrossings(naive, edges));
  });

  it('positions columns left-aligned, without overlap, keeping the top-left corner', () => {
    const nodes = [N('img', 500, 300), N('blur', 120, 40), N('grade', 900, 10), N('mask', 50, 500), N('out', 0, 0)];
    const edges = [E('1', 'img', 'blur'), E('2', 'blur', 'grade'), E('3', 'mask', 'grade', 'mask'), E('4', 'grade', 'out')];
    const p = tidyLayout(nodes, edges);
    expect(p.img.x).toBeLessThan(p.blur.x);
    expect(p.blur.x).toBeLessThan(p.grade.x);
    expect(p.grade.x).toBeLessThan(p.out.x);
    expect(p.blur.x).toBe(p.mask.x); // same column → same x
    expect(Math.min(...Object.values(p).map((q) => q.x))).toBe(0);
    expect(Math.min(...Object.values(p).map((q) => q.y))).toBe(0);
    const rects = nodes.map((n) => ({ ...p[n.id], ...n.size }));
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) expect(overlaps(rects[i], rects[j])).toBe(false);
    // a straight chain stays level
    expect(p.img.y).toBe(p.blur.y);
  });
});

describe('align / distribute', () => {
  it('aligns left / top and distributes with equal gaps', () => {
    const ns = [N('a', 10, 0), N('b', 50, 300), N('c', 30, 100)];
    expect(Object.values(alignNodes(ns, 'left')).map((p) => p.x)).toEqual([10, 10, 10]);
    expect(Object.values(alignNodes(ns, 'top')).map((p) => p.y)).toEqual([0, 0, 0]);
    const d = distributeNodes(ns, 'y');
    expect(d.a.y).toBe(0);
    expect(d.b.y).toBe(300);
    expect(d.c.y).toBe(150); // gap: (350 - 150) / 2 = 100 → 0, 150, 300
  });
});

describe('free spot', () => {
  const rects: Rect[] = [
    { x: 0, y: 0, width: 160, height: 80 },
    { x: 200, y: 0, width: 160, height: 80 },
    { x: 0, y: 120, width: 160, height: 80 },
  ];
  it('keeps a free position as is', () => {
    expect(findFreeSpot(rects, { x: 600, y: 600 }, { width: 160, height: 80 })).toEqual({ x: 600, y: 600 });
  });
  it('moves an overlapping box to the nearest spot that overlaps nothing', () => {
    const want = { x: 10, y: 10 };
    const p = findFreeSpot(rects, want, { width: 160, height: 80 });
    expect(rects.some((r) => overlaps({ ...p, width: 160, height: 80 }, r, 20))).toBe(false);
    expect(Math.hypot(p.x - want.x, p.y - want.y)).toBeLessThan(400);
  });
});

describe('frames', () => {
  const frame: Frame = { id: 'f', title: 'F', position: { x: 0, y: 0 }, size: { width: 400, height: 300 } };
  it('contains the nodes whose centre lies inside, and smaller frames fully inside', () => {
    const nodes = [N('in', 20, 40), N('edge', 350, 270) /* centre 400,295 → inside */, N('out', 380, 290) /* centre 430 → outside */, N('far', 900, 900)];
    const inner: Frame = { id: 'g', title: 'G', position: { x: 10, y: 10 }, size: { width: 100, height: 100 } };
    const big: Frame = { id: 'h', title: 'H', position: { x: -10, y: -10 }, size: { width: 1000, height: 1000 } };
    const m = frameMembers(frame, nodes, [frame, inner, big]);
    expect(m.nodes.sort()).toEqual(['edge', 'in']);
    expect(m.frames).toEqual(['g']);
  });
});

describe('insert on wire', () => {
  const ports: Record<string, PortsOf> = {
    a: { inputs: {}, outputs: { out: { type: 'image' } } },
    b: { inputs: { image: { type: 'image' } }, outputs: {} },
    n: { inputs: { mask: { type: 'mask' }, image: { type: 'image' } }, outputs: { out: { type: 'image' } } },
    src: { inputs: {}, outputs: { out: { type: 'image' } } },
  };
  let k = 0;
  const id = () => 'new' + ++k;
  const g: Graph = {
    nodes: ['a', 'b', 'n', 'src'].map((x) => ({ id: x, type: 't', params: {}, position: { x: 0, y: 0 } })),
    edges: [E('ab', 'a', 'b')],
  };
  it('splices A → node → B using the first type-compatible ports', () => {
    const r = spliceIntoEdge(g, 'ab', 'n', (x) => ports[x], id)!;
    expect(r).not.toBeNull();
    expect(r.edges.find((e) => e.id === 'ab')).toBeUndefined();
    expect(r.edges.map((e) => `${e.from.node}.${e.from.port}>${e.to.node}.${e.to.port}`).sort()).toEqual(['a.out>n.image', 'n.out>b.image']);
  });
  it('refuses when the node has no free input or the splice would create a cycle', () => {
    const busy: Graph = { ...g, edges: [...g.edges, E('s1', 'src', 'n', 'mask'), E('s2', 'src', 'n', 'image')] };
    expect(spliceIntoEdge(busy, 'ab', 'n', (x) => ports[x], id)).toBeNull();
    const loop: Graph = { ...g, edges: [...g.edges, E('bn', 'b', 'n', 'image')] }; // n is downstream of b
    expect(spliceIntoEdge(loop, 'ab', 'n', (x) => ports[x], id)).toBeNull();
    expect(spliceIntoEdge(g, 'ab', 'a', (x) => ports[x], id)).toBeNull(); // already on the wire
  });
  it('preserves frames and other graph fields', () => {
    const withFrames: Graph = { ...g, frames: [{ id: 'f', title: 'F', position: { x: 0, y: 0 }, size: { width: 1, height: 1 } }] };
    expect(spliceIntoEdge(withFrames, 'ab', 'n', (x) => ports[x], id)!.frames).toHaveLength(1);
  });
});

describe('selection helpers', () => {
  it('finds upstream and downstream nodes', () => {
    const g: Graph = { nodes: [], edges: [E('1', 'a', 'b'), E('2', 'b', 'c'), E('3', 'x', 'c'), E('4', 'c', 'd')] };
    expect(reachable(g, ['c'], 'up').sort()).toEqual(['a', 'b', 'c', 'x']);
    expect(reachable(g, ['b'], 'down').sort()).toEqual(['b', 'c', 'd']);
  });
});

describe('fuzzy search', () => {
  it('ranks prefix > word > substring > initials > subsequence', () => {
    expect(fuzzyScore('gau', 'Gaussian Blur')).toBeGreaterThan(fuzzyScore('blu', 'Gaussian Blur'));
    expect(fuzzyScore('blu', 'Gaussian Blur')).toBeGreaterThan(fuzzyScore('ssi', 'Gaussian Blur'));
    expect(fuzzyScore('gb', 'Gaussian Blur')).toBeGreaterThan(0);
    expect(fuzzyScore('gsblr', 'Gaussian Blur')).toBeGreaterThan(0);
    expect(fuzzyScore('zz', 'Gaussian Blur')).toBe(-1);
  });
  it('matches tags and descriptions; every word must match', () => {
    const e = { name: 'Levels', category: 'Color', tags: ['contrast', 'gamma'], description: 'Input/output black and white points' };
    expect(matchSearchable(e, 'gamma')).toBeGreaterThan(0);
    expect(matchSearchable(e, 'white points')).toBeGreaterThan(0);
    expect(matchSearchable(e, 'levels nope')).toBe(-1);
    expect(matchSearchable(e, 'lvls')).toBeGreaterThan(0);
  });
});

describe('fuzzy search precision', () => {
  it('does not match scattered letters in tags or descriptions', () => {
    expect(matchSearchable({ name: '2005 Webcam', category: 'Camera', tags: ['webcam', 'vga', 'low light', 'shadows'], description: 'A VGA webcam' }, 'washed')).toBe(-1);
  });
});
