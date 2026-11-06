import { beforeAll, describe, expect, it } from 'vitest';
import { connect, flattenGraph, GraphBuilder, groupNodes, ungroupNode, wouldCycle, createGroupNode } from './graph';
import { registerNodes } from './registry';
import core from '../nodes/core';

beforeAll(() => {
  registerNodes(core);
  registerNodes([
    { id: 't.fx', name: 'fx', category: 't', inputs: { image: { type: 'image' } }, params: { k: { type: 'float', default: 1 } }, passes: [{ frag: '' }] },
  ]);
});

describe('graph', () => {
  it('flattens a group, wiring inputs/outputs and applying exposed params', () => {
    const inner = new GraphBuilder();
    const i = inner.input('image');
    const a = inner.node('t.fx', { k: 2 }, { image: i }, 'a');
    const b = inner.node('t.fx', {}, { image: a }, 'b');
    inner.output('out', b);
    inner.expose('strength', 'a', 'k');
    const g = createGroupNode(inner.toGroup('G'));
    g.id = 'G';
    g.params.strength = 7;
    const graph = {
      nodes: [{ id: 'src', type: 'core.image', params: {}, position: { x: 0, y: 0 } }, g, { id: 'o', type: 'core.output', params: {}, position: { x: 0, y: 0 } }],
      edges: [
        { id: 'e1', from: { node: 'src', port: 'out' }, to: { node: 'G', port: 'image' } },
        { id: 'e2', from: { node: 'G', port: 'out' }, to: { node: 'o', port: 'image' } },
      ],
    };
    const flat = flattenGraph(graph);
    expect(flat.nodes.map((n) => n.id).sort()).toEqual(['G/a', 'G/b', 'o', 'src']);
    expect(flat.nodes.find((n) => n.id === 'G/a')!.params.k).toBe(7);
    const edges = flat.edges.map((e) => `${e.from.node}->${e.to.node}`).sort();
    expect(edges).toEqual(['G/a->G/b', 'G/b->o', 'src->G/a']);
  });

  it('flattens nested groups', () => {
    const innerMost = new GraphBuilder();
    innerMost.output('out', innerMost.node('t.fx', {}, { image: innerMost.input('image') }, 'x'));
    const mid = new GraphBuilder();
    const ng = createGroupNode(innerMost.toGroup('inner'));
    ng.id = 'N';
    mid.nodes.push(ng);
    mid.link(mid.input('image'), 'N', 'image');
    mid.output('out', 'N');
    const outer = createGroupNode(mid.toGroup('mid'));
    outer.id = 'M';
    const flat = flattenGraph({
      nodes: [{ id: 's', type: 'core.image', params: {}, position: { x: 0, y: 0 } }, outer, { id: 'o', type: 'core.output', params: {}, position: { x: 0, y: 0 } }],
      edges: [
        { id: '1', from: { node: 's', port: 'out' }, to: { node: 'M', port: 'image' } },
        { id: '2', from: { node: 'M', port: 'out' }, to: { node: 'o', port: 'image' } },
      ],
    });
    expect(flat.edges.map((e) => `${e.from.node}->${e.to.node}`).sort()).toEqual(['M/N/x->o', 's->M/N/x']);
  });

  it('group then ungroup round-trips connectivity', () => {
    const b = new GraphBuilder();
    const s = b.node('core.image', {}, {}, 's');
    const a = b.node('t.fx', {}, { image: s }, 'a');
    const c = b.node('t.fx', {}, { image: a }, 'c');
    b.node('core.output', {}, { image: c }, 'o');
    const g0 = b.toGraph();
    const { graph: g1, groupId } = groupNodes(g0, ['a', 'c']);
    expect(g1.nodes.length).toBe(3);
    const flat = flattenGraph(g1);
    expect(flat.edges.length).toBe(3);
    const g2 = ungroupNode(g1, groupId);
    expect(g2.nodes.length).toBe(4);
    expect(g2.edges.length).toBe(3);
  });

  it('prevents cycles', () => {
    const b = new GraphBuilder();
    const x = b.node('t.fx', {}, {}, 'x');
    b.node('t.fx', {}, { image: x }, 'y');
    const g = b.toGraph();
    expect(wouldCycle(g, 'y', 'x')).toBe(true);
    expect(connect(g, { node: 'y', port: 'out' }, { node: 'x', port: 'image' })).toBe(g);
  });
});
