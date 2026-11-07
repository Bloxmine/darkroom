/**
 * Node-graph editor actions beyond the basics in ./actions.ts: smart placement, tidy up,
 * align / distribute, insert-on-wire, rewiring, frames & sticky notes, collapse, colour tags,
 * upstream / downstream selection. Every document change goes through commitGraph (undoable).
 */
import { connect, getPorts, uid } from '../core/graph';
import {
  alignNodes,
  distributeNodes,
  findFreeSpot,
  frameAround,
  reachable,
  spliceIntoEdge,
  tidyLayout,
  type Pt,
  type Rect,
  type Size,
  type TidyNode,
} from '../core/graphLayout';
import type { Frame, Graph, GraphNode } from '../core/types';
import { commitGraph, currentGraph, setSelection, useDoc } from './doc';
import { sizeOf, useGraphUi } from './graphUi';
import { useSettings } from './settings';
import { status } from './ui';

const rows = (n: GraphNode) => {
  const p = getPorts(n);
  return Math.max(Object.keys(p.inputs).length, Object.keys(p.outputs).length);
};
export const nodeSize = (n: GraphNode): Size => sizeOf(n, rows(n));
export const nodeRect = (n: GraphNode): Rect => ({ ...n.position, ...nodeSize(n) });
const tidyNode = (n: GraphNode): TidyNode => ({ id: n.id, position: n.position, size: nodeSize(n) });

function selectedOrAll(g: Graph): GraphNode[] {
  const sel = new Set(useDoc.getState().selection);
  const s = g.nodes.filter((n) => sel.has(n.id));
  return s.length ? s : g.nodes;
}

const snap = (p: Pt): Pt => {
  const s = useSettings.getState();
  if (!s.snapToGrid) return { x: Math.round(p.x), y: Math.round(p.y) };
  const k = s.gridSize || 10;
  return { x: Math.round(p.x / k) * k, y: Math.round(p.y / k) * k };
};

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

/** Nearest spot to `want` where a box of `size` doesn't overlap existing nodes (current level). */
export function placeFree(want: Pt, size: Size, exclude: Set<string> = new Set(), g: Graph = currentGraph()): Pt {
  const rects = g.nodes.filter((n) => !exclude.has(n.id)).map(nodeRect);
  return snap(findFreeSpot(rects, want, size));
}

/** The single selected node that a new node would attach to (if auto-connect applies). */
export function autoConnectSource(): GraphNode | null {
  if (!useSettings.getState().autoConnect) return null;
  const s = useDoc.getState();
  if (s.selection.length !== 1) return null;
  const n = currentGraph(s).nodes.find((x) => x.id === s.selection[0]);
  return n && Object.keys(getPorts(n).outputs).length ? n : null;
}

/** Right of `n`, roughly level with it. */
export function rightOf(n: GraphNode): Pt {
  const r = nodeRect(n);
  return { x: r.x + r.width + 70, y: r.y };
}

// ---------------------------------------------------------------------------
// Moving, tidy, align
// ---------------------------------------------------------------------------

/** Move nodes and frames in one undo step. */
export function moveItems(nodes: Record<string, Pt>, frames: Record<string, Pt> = {}) {
  const nk = Object.keys(nodes);
  const fk = Object.keys(frames);
  if (!nk.length && !fk.length) return;
  commitGraph(
    (g) => ({
      ...g,
      nodes: g.nodes.map((n) => (nodes[n.id] ? { ...n, position: nodes[n.id] } : n)),
      ...(g.frames ? { frames: g.frames.map((f) => (frames[f.id] ? { ...f, position: frames[f.id] } : f)) } : {}),
    }),
    { coalesce: 'move:' + [...nk, ...fk].sort().join(',') },
  );
}

/** Lay out the selection (or the whole graph) left-to-right by dependency. Frames around moved nodes follow. */
export function tidyUp() {
  const g = currentGraph();
  const list = selectedOrAll(g);
  if (list.length < 2) return status('Tidy Up needs at least two nodes.');
  const pos = tidyLayout(list.map(tidyNode), g.edges, {}, portIndexFor(g));
  commitGraph((gr) => ({ ...gr, nodes: gr.nodes.map((n) => (pos[n.id] ? { ...n, position: pos[n.id] } : n)) }));
  status(`Tidied ${list.length} nodes.`);
}

/** Fractional port offset so crossing counts see which socket a wire uses. */
function portIndexFor(g: Graph) {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  return (id: string, port: string, side: 'in' | 'out') => {
    const n = byId.get(id);
    if (!n) return 0;
    const p = getPorts(n);
    const keys = Object.keys(side === 'in' ? p.inputs : p.outputs);
    const i = keys.indexOf(port);
    return i < 0 ? 0 : (i + 1) / (keys.length + 1) - 0.5;
  };
}

export function alignSelection(edge: 'left' | 'top') {
  const g = currentGraph();
  const sel = new Set(useDoc.getState().selection);
  const list = g.nodes.filter((n) => sel.has(n.id));
  if (list.length < 2) return status('Select two or more nodes to align.');
  moveItems(alignNodes(list.map(tidyNode), edge));
}

export function distributeSelection(axis: 'x' | 'y') {
  const g = currentGraph();
  const sel = new Set(useDoc.getState().selection);
  const list = g.nodes.filter((n) => sel.has(n.id));
  if (list.length < 3) return status('Select three or more nodes to distribute.');
  moveItems(distributeNodes(list.map(tidyNode), axis));
}

// ---------------------------------------------------------------------------
// Wires
// ---------------------------------------------------------------------------

/** Splice `nodeId` into `edgeId` (optionally moving it to `pos` in the same undo step). */
export function insertOnEdge(nodeId: string, edgeId: string, pos?: Pt): boolean {
  const g = currentGraph();
  const moved = pos ? { ...g, nodes: g.nodes.map((n) => (n.id === nodeId ? { ...n, position: pos } : n)) } : g;
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const ng = spliceIntoEdge(moved, edgeId, nodeId, (id) => (byId.get(id) ? getPorts(byId.get(id)!) : undefined), () => uid('e'));
  if (!ng) return false;
  commitGraph(() => autoOffset(ng, nodeId, edgeId, g));
  return true;
}

/**
 * Make room for a node just spliced into A → B: keep it right of A, and push B and everything
 * downstream of it right by as much as the node now overlaps them (Blender's "auto-offset").
 */
function autoOffset(g: Graph, nodeId: string, edgeId: string, before: Graph): Graph {
  const e = before.edges.find((x) => x.id === edgeId);
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const n = byId.get(nodeId);
  const a = e && byId.get(e.from.node);
  const b = e && byId.get(e.to.node);
  if (!n || !a || !b) return g;
  const gap = 50;
  const ra = nodeRect(a);
  const rn = nodeRect(n);
  const x = Math.max(rn.x, ra.x + ra.width + gap);
  const dx = Math.max(0, x + rn.width + gap - b.position.x);
  const push = new Set(dx ? reachable(g, [b.id], 'down') : []);
  push.delete(nodeId);
  if (x === rn.x && !push.size) return g;
  return {
    ...g,
    nodes: g.nodes.map((m) =>
      m.id === nodeId ? { ...m, position: snap({ x, y: m.position.y }) } : push.has(m.id) ? { ...m, position: { x: m.position.x + dx, y: m.position.y } } : m,
    ),
  };
}

export function canInsertOnEdge(nodeId: string, edgeId: string): boolean {
  const g = currentGraph();
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  return !!spliceIntoEdge(g, edgeId, nodeId, (id) => (byId.get(id) ? getPorts(byId.get(id)!) : undefined), () => 'x');
}

/** Replace edge `oldId` by a new connection (or just drop it when `to` is null) in one undo step. */
export function rewire(oldId: string, from: { node: string; port: string } | null, to: { node: string; port: string } | null) {
  const g = currentGraph();
  const without = { ...g, edges: g.edges.filter((e) => e.id !== oldId) };
  if (!from || !to) return commitGraph(() => without);
  const ng = connect(without, from, to);
  if (ng === without) {
    status('Cannot connect: that would create a cycle.', 'error');
    return;
  }
  commitGraph(() => ng);
}

// ---------------------------------------------------------------------------
// Frames & sticky notes
// ---------------------------------------------------------------------------

export const FRAME_COLORS = ['grey', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink'] as const;

const mapFrames = (g: Graph, fn: (f: Frame[]) => Frame[]): Graph => {
  const frames = fn(g.frames ?? []);
  const out: Graph = { ...g, frames };
  if (!frames.length) delete out.frames;
  return out;
};

/** Put a frame around the selected nodes, or an empty one at `at`. Returns its id. */
export function addFrame(at?: Pt, kind: 'frame' | 'note' = 'frame'): string {
  const g = currentGraph();
  const sel = new Set(useDoc.getState().selection);
  const inside = kind === 'frame' ? g.nodes.filter((n) => sel.has(n.id)) : [];
  const box = inside.length
    ? frameAround(inside.map(nodeRect))
    : { position: snap(at ?? { x: 0, y: 0 }), size: kind === 'note' ? { width: 200, height: 120 } : { width: 400, height: 260 } };
  const f: Frame = {
    id: uid('f'),
    kind,
    title: kind === 'note' ? 'Note' : 'Frame',
    color: kind === 'note' ? 'yellow' : 'blue',
    ...box,
    ...(kind === 'note' ? { note: '' } : {}),
  };
  commitGraph((gr) => mapFrames(gr, (fs) => [...fs, f]));
  useGraphUi.setState({ frameSelection: [f.id], renaming: kind === 'note' ? 'note:' + f.id : 'frame:' + f.id });
  return f.id;
}

export function updateFrame(id: string, patch: Partial<Omit<Frame, 'id'>>, coalesce?: string) {
  commitGraph((g) => mapFrames(g, (fs) => fs.map((f) => (f.id === id ? { ...f, ...patch } : f))), coalesce ? { coalesce } : {});
}

export function deleteFrames(ids: string[]) {
  if (!ids.length) return;
  const set = new Set(ids);
  commitGraph((g) => mapFrames(g, (fs) => fs.filter((f) => !set.has(f.id))));
  useGraphUi.setState({ frameSelection: [] });
}

// ---------------------------------------------------------------------------
// Node conveniences
// ---------------------------------------------------------------------------

const selIds = (ids?: string[]) => ids ?? useDoc.getState().selection;

export function setCollapsed(ids: string[] | undefined, collapsed?: boolean) {
  const set = new Set(selIds(ids));
  if (!set.size) return;
  const g = currentGraph();
  const target = collapsed ?? !g.nodes.some((n) => set.has(n.id) && n.collapsed);
  commitGraph((gr) => ({ ...gr, nodes: gr.nodes.map((n) => (set.has(n.id) ? { ...n, collapsed: target || undefined } : n)) }));
}

export function setNodeColor(ids: string[] | undefined, color: string | undefined) {
  const set = new Set(selIds(ids));
  if (!set.size) return;
  commitGraph((gr) => ({ ...gr, nodes: gr.nodes.map((n) => (set.has(n.id) ? { ...n, color: color || undefined } : n)) }));
}

export function selectConnected(dir: 'up' | 'down', ids?: string[]) {
  const s = useDoc.getState();
  const start = selIds(ids);
  if (!start.length) return;
  const all = reachable(currentGraph(s), start, dir);
  setSelection([...all].sort());
  status(`Selected ${all.length} node${all.length === 1 ? '' : 's'} (${dir === 'up' ? 'upstream' : 'downstream'}).`);
}

/** Delete the selected nodes, edges and frames — asking first when more than the configured number of nodes go. */
export function requestDelete(run: () => void) {
  const n = useDoc.getState().selection.length;
  const max = useSettings.getState().confirmDeleteOver;
  if (max > 0 && n > max) useGraphUi.setState({ dialog: { kind: 'confirmDelete', count: n, run } });
  else run();
}
