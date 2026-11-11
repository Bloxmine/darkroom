import { describe, expect, it } from 'vitest';
import * as L from './layout';

/** A compact picture of a tree: row(a|col(b,c)) etc. */
function sig(n: L.LayoutNode | null): string {
  if (!n) return '∅';
  if (n.type === 'stack') return n.tabs.map((t) => (t === n.active ? t.toUpperCase() : t)).join(',') + (n.minimized ? '_' : '');
  return `${n.dir}(${n.children.map(sig).join(' | ')})`;
}
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

function essentials() {
  return L.row([L.stack(['lib'], { id: 'S_lib' }), L.col([L.stack(['view'], { id: 'S_view' }), L.stack(['graph'], { id: 'S_graph' })], [0.6, 0.4], 'C'), L.stack(['props'], { id: 'S_props' })], [0.2, 0.6, 0.2], 'R');
}

describe('layout tree', () => {
  it('queries panels and stacks', () => {
    const r = essentials();
    expect(L.panelIds(r)).toEqual(['lib', 'view', 'graph', 'props']);
    expect(L.findStackOf(r, 'graph')?.id).toBe('S_graph');
    expect(L.parentOf(r, 'S_graph')?.id).toBe('C');
    expect(L.parentOf(r, 'R')).toBeNull();
  });

  it('docks into a tab stack (center)', () => {
    const r = L.dockPanel(essentials(), 'props', 'S_lib', 'center');
    expect(sig(r)).toBe('row(lib,PROPS | col(VIEW | GRAPH))');
    const s = (r as L.SplitNode).sizes;
    expect(sum(s)).toBeCloseTo(1);
    // the removed column's share went to the others proportionally
    expect(s[0] / s[1]).toBeCloseTo(0.2 / 0.6);
  });

  it('docks left / right in a row parent by splitting the target', () => {
    const r = L.dockPanel(essentials(), 'props', 'S_lib', 'right') as L.SplitNode;
    expect(sig(r)).toBe('row(LIB | PROPS | col(VIEW | GRAPH))');
    expect(sum(r.sizes)).toBeCloseTo(1);
    expect(r.sizes[0]).toBeCloseTo(r.sizes[1]);
    const l = L.dockPanel(essentials(), 'graph', 'S_props', 'left');
    expect(sig(l)).toBe('row(LIB | VIEW | GRAPH | PROPS)');
  });

  it('docks top / bottom by wrapping the target in a column', () => {
    const r = L.dockPanel(essentials(), 'lib', 'S_props', 'bottom');
    expect(sig(r)).toBe('row(col(VIEW | GRAPH) | col(PROPS | LIB))');
    const t = L.dockPanel(essentials(), 'props', 'S_view', 'top');
    expect(sig(t)).toBe('row(LIB | col(PROPS | VIEW | GRAPH))');
    const c = (t as L.SplitNode).children[1] as L.SplitNode;
    expect(sum(c.sizes)).toBeCloseTo(1);
    expect(c.sizes[0]).toBeCloseTo(0.3);
  });

  it('dropping a lone tab on its own stack is a no-op', () => {
    const r = essentials();
    expect(L.dockPanel(r, 'lib', 'S_lib', 'left')).toBe(r);
    expect(sig(L.dockPanel(r, 'lib', 'S_lib', 'center'))).toBe(sig(r));
  });

  it('removes panels and collapses splits', () => {
    let r: L.LayoutNode | null = essentials();
    r = L.removePanel(r, 'graph');
    expect(sig(r)).toBe('row(LIB | VIEW | PROPS)');
    r = L.removePanel(r, 'lib');
    r = L.removePanel(r, 'props');
    expect(sig(r)).toBe('VIEW');
    expect(L.removePanel(r, 'view')).toBeNull();
    expect(L.removePanel(r, 'nope')).toBe(r);
  });

  it('keeps a sensible active tab when removing', () => {
    const r = L.stack(['a', 'b', 'c'], { active: 'b' });
    expect(sig(L.removePanel(r, 'b'))).toBe('a,C');
    expect(sig(L.removePanel(r, 'a'))).toBe('B,c');
  });

  it('docks along window edges', () => {
    const r = L.dockEdge(essentials(), 'graph', 'bottom', 0.25) as L.SplitNode;
    expect(sig(r)).toBe('col(row(LIB | VIEW | PROPS) | GRAPH)');
    expect(r.sizes).toEqual([0.75, 0.25]);
    const l = L.dockEdge(essentials(), 'props', 'left') as L.SplitNode;
    expect(sig(l)).toBe('row(PROPS | LIB | col(VIEW | GRAPH))');
    expect(sum(l.sizes)).toBeCloseTo(1);
    expect(sig(L.dockEdge(null, 'x', 'top'))).toBe('X');
  });

  it('adds panels near another or at an edge', () => {
    expect(sig(L.addPanel(essentials(), 'scopes', { near: 'props' }))).toBe('row(LIB | col(VIEW | GRAPH) | props,SCOPES)');
    expect(sig(L.addPanel(essentials(), 'scopes', { edge: 'right' }))).toBe('row(LIB | col(VIEW | GRAPH) | PROPS | SCOPES)');
    const r = L.dockPanel(essentials(), 'props', 'S_lib', 'center');
    expect(sig(L.addPanel(r, 'lib'))).toBe('row(LIB,props | col(VIEW | GRAPH))');
  });

  it('resizes neighbours, clamped to a minimum', () => {
    const r = L.resize(essentials(), 'R', 0, 0.1) as L.SplitNode;
    expect(r.sizes[0]).toBeCloseTo(0.3);
    expect(r.sizes[1]).toBeCloseTo(0.5);
    expect(r.sizes[2]).toBeCloseTo(0.2);
    const c = L.resize(essentials(), 'R', 1, 0.5, 0.05) as L.SplitNode;
    expect(c.sizes[2]).toBeCloseTo(0.05);
    expect(sum(c.sizes)).toBeCloseTo(1);
    expect(L.resize(essentials(), 'R', 5, 0.1)).toEqual(essentials());
    const s = L.setSizes(essentials(), 'C', [3, 1]) as L.SplitNode;
    expect((s.children[1] as L.SplitNode).sizes).toEqual([0.75, 0.25]);
  });

  it('activates, reorders and minimises tabs', () => {
    let r: L.LayoutNode | null = L.stack(['a', 'b', 'c'], { id: 'S' });
    r = L.setActive(r, 'S', 'c');
    expect(sig(r)).toBe('a,b,C');
    r = L.moveTab(r, 'S', 'c', 0);
    expect(sig(r)).toBe('C,a,b');
    r = L.setMinimized(r, 'S', true);
    expect(sig(r)).toBe('C,a,b_');
    expect(L.visiblePanelIds(r)).toEqual([]);
    expect(sig(L.dockPanel(r, 'a', 'S', 'center'))).toBe('c,A,b'); // bringing a tab forward expands the group
  });

  it('normalises nested same-direction splits and bad sizes', () => {
    const n = L.normalize(L.row([L.stack(['a']), L.row([L.stack(['b']), L.stack(['c'])], [0.5, 0.5])], [0.5, 0.5]));
    expect(sig(n)).toBe('row(A | B | C)');
    expect((n as L.SplitNode).sizes).toEqual([0.5, 0.25, 0.25]);
    const bad = L.normalize(L.row([L.stack(['a']), L.stack(['b'])], [NaN, -1])) as L.SplitNode;
    expect(bad.sizes).toEqual([0.5, 0.5]);
  });

  it('serialises and deserialises', () => {
    const r = L.setMinimized(L.dockPanel(essentials(), 'props', 'S_view', 'center'), 'S_graph', true);
    const json = L.serialize({ root: r });
    const back = L.deserialize(json);
    expect(back?.root).toEqual(r);
    expect(L.deserialize(JSON.parse(json))?.root).toEqual(r);
    expect(L.deserialize('{"root":null}')).toEqual({ root: null });
  });

  it('rejects or repairs invalid serialised layouts', () => {
    expect(L.deserialize('nope')).toBeNull();
    expect(L.deserialize({})).toBeNull();
    expect(L.deserialize({ root: { type: 'stack', tabs: [] } })).toBeNull();
    const fixed = L.deserialize({
      root: { type: 'split', dir: 'row', sizes: [1, 'x'], children: [{ type: 'stack', id: 'a', tabs: ['x', 'y'], active: 'zz' }, { type: 'stack', id: 'a', tabs: ['x'] }, { type: 'bogus' }] },
    });
    // duplicate panel 'x' dropped from the second stack, which then disappears; bogus child dropped
    expect(sig(fixed!.root)).toBe('X,y');
  });

  it('clones with fresh ids', () => {
    const r = essentials();
    const c = L.cloneLayout({ root: r });
    expect(sig(c.root)).toBe(sig(r));
    expect(L.stacks(c.root).map((s) => s.id)).not.toContain('S_lib');
  });
});
