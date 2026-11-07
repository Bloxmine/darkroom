/**
 * Pure graph-editor geometry and topology helpers (no DOM, no stores):
 * tidy-up layout with crossing minimisation, free-spot search, align/distribute,
 * frame membership, insert-on-wire splicing, upstream/downstream selection and
 * fuzzy matching for the add-node search. Covered by graphLayout.test.ts.
 */
import type { Edge, Frame, Graph, PortDef } from './types';
import { wouldCycle } from './graph';

export interface Pt {
  x: number;
  y: number;
}
export interface Size {
  width: number;
  height: number;
}
export interface Rect extends Pt, Size {}

export const DEFAULT_NODE_SIZE: Size = { width: 160, height: 80 };

// ---------------------------------------------------------------------------
// Tidy up: layered layout, barycenter ordering, aligned columns
// ---------------------------------------------------------------------------

export interface TidyNode {
  id: string;
  position: Pt;
  size?: Size;
}

export interface TidyOptions {
  /** Horizontal gap between columns. */
  gapX?: number;
  /** Vertical gap between nodes in a column. */
  gapY?: number;
  /** Barycenter sweeps (each = one down + one up pass). */
  sweeps?: number;
}

/** Edge endpoint order within a layer: node index plus a fraction for the port index. */
type PortIndex = (nodeId: string, port: string, side: 'in' | 'out') => number;

/** Assign layers by longest path from sources, then pull pure sources right next to their first consumer. */
export function assignLayers(ids: string[], edges: Edge[]): Map<string, number> {
  const set = new Set(ids);
  const es = edges.filter((e) => set.has(e.from.node) && set.has(e.to.node) && e.from.node !== e.to.node);
  const preds = new Map<string, string[]>();
  const succs = new Map<string, string[]>();
  for (const e of es) {
    preds.set(e.to.node, [...(preds.get(e.to.node) ?? []), e.from.node]);
    succs.set(e.from.node, [...(succs.get(e.from.node) ?? []), e.to.node]);
  }
  const layer = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (id: string): number => {
    const known = layer.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0; // cycle guard (graphs are DAGs, but be safe)
    visiting.add(id);
    const l = Math.max(-1, ...(preds.get(id) ?? []).map(visit)) + 1;
    visiting.delete(id);
    layer.set(id, l);
    return l;
  };
  ids.forEach(visit);
  // tighten: a node with consumers but no producers sits one column left of its nearest consumer
  const order = [...ids].sort((a, b) => layer.get(b)! - layer.get(a)!);
  for (const id of order) {
    if ((preds.get(id) ?? []).length) continue;
    const s = succs.get(id) ?? [];
    if (!s.length) continue;
    const want = Math.min(...s.map((x) => layer.get(x)!)) - 1;
    if (want > layer.get(id)!) layer.set(id, want);
  }
  return layer;
}

/** Number of edge crossings between consecutive layers for the given ordering. */
export function countCrossings(layers: string[][], edges: Edge[], portIndex?: PortIndex): number {
  const pos = new Map<string, { l: number; i: number }>();
  layers.forEach((L, l) => L.forEach((id, i) => pos.set(id, { l, i })));
  const pi = portIndex ?? (() => 0);
  const byLayer = new Map<number, [number, number][]>();
  for (const e of edges) {
    const a = pos.get(e.from.node);
    const b = pos.get(e.to.node);
    if (!a || !b || b.l !== a.l + 1) continue;
    const list = byLayer.get(a.l) ?? [];
    list.push([a.i + pi(e.from.node, e.from.port, 'out'), b.i + pi(e.to.node, e.to.port, 'in')]);
    byLayer.set(a.l, list);
  }
  let n = 0;
  for (const list of byLayer.values())
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) if ((list[i][0] - list[j][0]) * (list[i][1] - list[j][1]) < 0) n++;
  return n;
}

/**
 * Order the nodes of each layer to reduce crossings: long edges get virtual (dummy) nodes so
 * every edge spans one layer, then alternate down/up barycenter sweeps, keeping the best ordering.
 * The initial order is the nodes' current y, so a tidy graph stays as the user arranged it.
 */
export function orderLayers(
  ids: string[],
  edges: Edge[],
  layer: Map<string, number>,
  initialY: (id: string) => number,
  sweeps = 6,
  portIndex?: PortIndex,
): { layers: string[][]; edges: Edge[] } {
  const set = new Set(ids);
  const nL = Math.max(0, ...ids.map((id) => layer.get(id) ?? 0)) + 1;
  const layers: string[][] = Array.from({ length: nL }, () => []);
  for (const id of [...ids].sort((a, b) => initialY(a) - initialY(b))) layers[layer.get(id) ?? 0].push(id);
  // split long edges with dummies
  const segs: Edge[] = [];
  let d = 0;
  for (const e of edges) {
    if (!set.has(e.from.node) || !set.has(e.to.node)) continue;
    const la = layer.get(e.from.node)!;
    const lb = layer.get(e.to.node)!;
    if (lb <= la) continue;
    let prev = e.from;
    for (let l = la + 1; l < lb; l++) {
      const id = `\u0000d${d++}`;
      // dummies start next to their source's y
      layers[l].push(id);
      segs.push({ id: e.id + ':' + l, from: prev, to: { node: id, port: 'in' } });
      prev = { node: id, port: 'out' };
    }
    segs.push({ id: e.id, from: prev, to: e.to });
  }
  const pi = portIndex ?? (() => 0);
  const ins = new Map<string, Edge[]>();
  const outs = new Map<string, Edge[]>();
  for (const e of segs) {
    ins.set(e.to.node, [...(ins.get(e.to.node) ?? []), e]);
    outs.set(e.from.node, [...(outs.get(e.from.node) ?? []), e]);
  }
  const indexOf = (L: string[]) => new Map(L.map((id, i) => [id, i]));
  const sweep = (l: number, ref: Map<string, number>, down: boolean) => {
    const L = layers[l];
    const bary = new Map<string, number>();
    L.forEach((id, i) => {
      const nb = down
        ? (ins.get(id) ?? []).map((e) => (ref.get(e.from.node) ?? 0) + pi(e.from.node, e.from.port, 'out'))
        : (outs.get(id) ?? []).map((e) => (ref.get(e.to.node) ?? 0) + pi(e.to.node, e.to.port, 'in'));
      bary.set(id, nb.length ? nb.reduce((a, b) => a + b, 0) / nb.length : i); // unconnected nodes keep their slot
    });
    // stable sort by barycenter (ties keep the current order)
    const cur = indexOf(L);
    layers[l] = [...L].sort((a, b) => bary.get(a)! - bary.get(b)! || cur.get(a)! - cur.get(b)!);
  };
  let best = layers.map((L) => [...L]);
  let bestC = countCrossings(layers, segs, portIndex);
  for (let s = 0; s < sweeps && bestC > 0; s++) {
    for (let l = 1; l < nL; l++) sweep(l, indexOf(layers[l - 1]), true);
    for (let l = nL - 2; l >= 0; l--) sweep(l, indexOf(layers[l + 1]), false);
    const c = countCrossings(layers, segs, portIndex);
    if (c < bestC) {
      bestC = c;
      best = layers.map((L) => [...L]);
    }
  }
  return { layers: best, edges: segs };
}

/**
 * Tidy (auto-layout) `nodes` left-to-right by dependency. Only edges between the given nodes count.
 * Returns new top-left positions; the layout keeps the top-left corner of the nodes' current bounding
 * box, columns are left-aligned, and each node is pulled level with the nodes feeding it (straight
 * chains) without overlapping. Node sizes are respected but never changed.
 */
export function tidyLayout(nodes: TidyNode[], edges: Edge[], opts: TidyOptions = {}, portIndex?: PortIndex): Record<string, Pt> {
  const gapX = opts.gapX ?? 70;
  const gapY = opts.gapY ?? 30;
  if (!nodes.length) return {};
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const size = (id: string) => byId.get(id)?.size ?? DEFAULT_NODE_SIZE;
  const ids = nodes.map((n) => n.id);
  const layer = assignLayers(ids, edges);
  const { layers } = orderLayers(ids, edges, layer, (id) => byId.get(id)!.position.y, opts.sweeps ?? 6, portIndex);
  const real = layers.map((L) => L.filter((id) => byId.has(id)));
  const x0 = Math.min(...nodes.map((n) => n.position.x));
  const y0 = Math.min(...nodes.map((n) => n.position.y));
  const out: Record<string, Pt> = {};
  // column x: aligned left edges, each column as wide as its widest node
  let x = x0;
  const colX: number[] = [];
  for (const L of real) {
    colX.push(x);
    if (L.length) x += Math.max(...L.map((id) => size(id).width)) + gapX;
  }
  const set = new Set(ids);
  const preds = new Map<string, string[]>();
  for (const e of edges) if (set.has(e.from.node) && set.has(e.to.node)) preds.set(e.to.node, [...(preds.get(e.to.node) ?? []), e.from.node]);
  const centerY = (id: string) => out[id].y + size(id).height / 2;
  real.forEach((L, l) => {
    let bottom = -Infinity;
    for (const id of L) {
      const h = size(id).height;
      const ps = (preds.get(id) ?? []).filter((p) => out[p]);
      const want = ps.length ? ps.reduce((a, p) => a + centerY(p), 0) / ps.length - h / 2 : bottom === -Infinity ? y0 : bottom + gapY;
      const y = Math.max(want, bottom === -Infinity ? -Infinity : bottom + gapY);
      out[id] = { x: colX[l], y };
      bottom = y + h;
    }
  });
  // keep the original top-left corner and snap to whole pixels
  const minY = Math.min(...Object.values(out).map((p) => p.y));
  for (const id of ids) out[id] = { x: Math.round(out[id].x), y: Math.round(out[id].y - minY + y0) };
  return out;
}

// ---------------------------------------------------------------------------
// Align / distribute
// ---------------------------------------------------------------------------

export function alignNodes(nodes: TidyNode[], edge: 'left' | 'top' | 'right' | 'bottom' | 'centerX' | 'centerY'): Record<string, Pt> {
  if (!nodes.length) return {};
  const sz = (n: TidyNode) => n.size ?? DEFAULT_NODE_SIZE;
  const out: Record<string, Pt> = {};
  const minX = Math.min(...nodes.map((n) => n.position.x));
  const minY = Math.min(...nodes.map((n) => n.position.y));
  const maxR = Math.max(...nodes.map((n) => n.position.x + sz(n).width));
  const maxB = Math.max(...nodes.map((n) => n.position.y + sz(n).height));
  const cx = nodes.reduce((a, n) => a + n.position.x + sz(n).width / 2, 0) / nodes.length;
  const cy = nodes.reduce((a, n) => a + n.position.y + sz(n).height / 2, 0) / nodes.length;
  for (const n of nodes) {
    const p = { ...n.position };
    if (edge === 'left') p.x = minX;
    if (edge === 'top') p.y = minY;
    if (edge === 'right') p.x = maxR - sz(n).width;
    if (edge === 'bottom') p.y = maxB - sz(n).height;
    if (edge === 'centerX') p.x = Math.round(cx - sz(n).width / 2);
    if (edge === 'centerY') p.y = Math.round(cy - sz(n).height / 2);
    out[n.id] = p;
  }
  return out;
}

/** Spread nodes evenly (equal gaps) between the first and last along an axis. */
export function distributeNodes(nodes: TidyNode[], axis: 'x' | 'y'): Record<string, Pt> {
  const out: Record<string, Pt> = {};
  if (nodes.length < 3) return Object.fromEntries(nodes.map((n) => [n.id, { ...n.position }]));
  const dim = axis === 'x' ? 'width' : 'height';
  const sz = (n: TidyNode) => (n.size ?? DEFAULT_NODE_SIZE)[dim];
  const sorted = [...nodes].sort((a, b) => a.position[axis] - b.position[axis]);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const span = last.position[axis] + sz(last) - first.position[axis];
  const total = sorted.reduce((a, n) => a + sz(n), 0);
  const gap = (span - total) / (sorted.length - 1);
  let at = first.position[axis];
  for (const n of sorted) {
    out[n.id] = { ...n.position, [axis]: Math.round(at) };
    at += sz(n) + gap;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Free-spot placement
// ---------------------------------------------------------------------------

export const overlaps = (a: Rect, b: Rect, pad = 0) =>
  a.x < b.x + b.width + pad && a.x + a.width + pad > b.x && a.y < b.y + b.height + pad && a.y + a.height + pad > b.y;

/**
 * The position nearest `want` (top-left) where a box of `size` doesn't overlap any of `rects`
 * (with `pad` spacing). Searches rings around `want`, preferring downward and rightward moves.
 */
export function findFreeSpot(rects: Rect[], want: Pt, size: Size, pad = 20, step = 20): Pt {
  const fits = (p: Pt) => !rects.some((r) => overlaps({ ...p, ...size }, r, pad));
  if (fits(want)) return { ...want };
  for (let ring = 1; ring <= 120; ring++) {
    const cands: Pt[] = [];
    for (let i = -ring; i <= ring; i++) {
      cands.push({ x: want.x + i * step, y: want.y + ring * step });
      cands.push({ x: want.x + i * step, y: want.y - ring * step });
      if (Math.abs(i) !== ring) {
        cands.push({ x: want.x + ring * step, y: want.y + i * step });
        cands.push({ x: want.x - ring * step, y: want.y + i * step });
      }
    }
    // cheapest move first: below and right are preferred over above and left
    const cost = (p: Pt) => Math.hypot(p.x - want.x, p.y - want.y) + (p.y < want.y ? step * 0.5 : 0) + (p.x < want.x ? step * 0.75 : 0);
    cands.sort((a, b) => cost(a) - cost(b));
    const hit = cands.find(fits);
    if (hit) return hit;
  }
  return { ...want };
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

export const frameRect = (f: Frame): Rect => ({ ...f.position, ...f.size });
export const contains = (outer: Rect, p: Pt) => p.x >= outer.x && p.x <= outer.x + outer.width && p.y >= outer.y && p.y <= outer.y + outer.height;

/** Ids of the nodes (centre inside the frame) and frames (fully inside, smaller) that move with `frame`. */
export function frameMembers(frame: Frame, nodes: TidyNode[], frames: Frame[] = []): { nodes: string[]; frames: string[] } {
  const r = frameRect(frame);
  const ns = nodes.filter((n) => {
    const s = n.size ?? DEFAULT_NODE_SIZE;
    return contains(r, { x: n.position.x + s.width / 2, y: n.position.y + s.height / 2 });
  });
  const fs = frames.filter((f) => {
    if (f.id === frame.id) return false;
    const o = frameRect(f);
    return o.width * o.height < r.width * r.height && contains(r, o) && contains(r, { x: o.x + o.width, y: o.y + o.height });
  });
  return { nodes: ns.map((n) => n.id), frames: fs.map((f) => f.id) };
}

/** Bounding frame (with a title-bar margin) around node rects. */
export function frameAround(rects: Rect[], pad = 24, title = 28): { position: Pt; size: Size } {
  const minX = Math.min(...rects.map((r) => r.x)) - pad;
  const minY = Math.min(...rects.map((r) => r.y)) - pad - title;
  const maxX = Math.max(...rects.map((r) => r.x + r.width)) + pad;
  const maxY = Math.max(...rects.map((r) => r.y + r.height)) + pad;
  return { position: { x: Math.round(minX), y: Math.round(minY) }, size: { width: Math.round(maxX - minX), height: Math.round(maxY - minY) } };
}

// ---------------------------------------------------------------------------
// Insert a node on a wire
// ---------------------------------------------------------------------------

export interface PortsOf {
  inputs: Record<string, PortDef>;
  outputs: Record<string, PortDef>;
}

/**
 * Splice node `nodeId` into edge `edgeId` (A → B becomes A → node → B), using the node's first
 * input whose type matches A's output (else its first free input) and its first output whose type
 * matches B's input (else its first output). Returns null when the node can't take the wire:
 * no free input / no output, already on that wire, or the splice would create a cycle.
 */
export function spliceIntoEdge(graph: Graph, edgeId: string, nodeId: string, ports: (id: string) => PortsOf | undefined, newId: () => string): Graph | null {
  const e = graph.edges.find((x) => x.id === edgeId);
  if (!e || e.from.node === nodeId || e.to.node === nodeId) return null;
  const p = ports(nodeId);
  if (!p) return null;
  const srcType = ports(e.from.node)?.outputs[e.from.port]?.type;
  const dstType = ports(e.to.node)?.inputs[e.to.port]?.type;
  const taken = new Set(graph.edges.filter((x) => x.to.node === nodeId).map((x) => x.to.port));
  const freeIns = Object.entries(p.inputs).filter(([k]) => !taken.has(k));
  const inp = (freeIns.find(([, d]) => d.type === srcType) ?? freeIns[0])?.[0];
  const outs = Object.entries(p.outputs);
  const out = (outs.find(([, d]) => d.type === dstType) ?? outs[0])?.[0];
  if (!inp || !out) return null;
  const rest = graph.edges.filter((x) => x.id !== edgeId);
  const base = { ...graph, edges: rest };
  // A → node must not close a loop (node already upstream of A), nor node → B (B already upstream of node)
  if (wouldCycle(base, e.from.node, nodeId) || wouldCycle(base, nodeId, e.to.node)) return null;
  return {
    ...graph,
    edges: [...rest, { id: newId(), from: e.from, to: { node: nodeId, port: inp } }, { id: newId(), from: { node: nodeId, port: out }, to: e.to }],
  };
}

// ---------------------------------------------------------------------------
// Upstream / downstream
// ---------------------------------------------------------------------------

export function reachable(graph: Graph, ids: string[], dir: 'up' | 'down'): string[] {
  const adj = new Map<string, string[]>();
  for (const e of graph.edges) {
    const [a, b] = dir === 'up' ? [e.to.node, e.from.node] : [e.from.node, e.to.node];
    adj.set(a, [...(adj.get(a) ?? []), b]);
  }
  const seen = new Set(ids);
  const stack = [...ids];
  while (stack.length) {
    for (const n of adj.get(stack.pop()!) ?? []) {
      if (seen.has(n)) continue;
      seen.add(n);
      stack.push(n);
    }
  }
  return [...seen];
}

// ---------------------------------------------------------------------------
// Fuzzy matching (add-node search)
// ---------------------------------------------------------------------------

/**
 * Score how well `q` matches `text` (higher is better, -1 = no match): prefix > word prefix >
 * substring > word initials ("gb" → "Gaussian Blur") > in-order subsequence with few gaps.
 */
export function fuzzyScore(q: string, text: string): number {
  q = q.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  if (t === q) return 1000;
  if (t.startsWith(q)) return 900 - t.length;
  const words = t.split(/[^a-z0-9]+/).filter(Boolean);
  if (words.some((w) => w.startsWith(q))) return 800 - t.length;
  const at = t.indexOf(q);
  if (at >= 0) return 700 - at;
  const initials = words.map((w) => w[0]).join('');
  if (initials.startsWith(q)) return 600;
  // subsequence: every char in order; penalise gaps
  let ti = 0;
  let gaps = 0;
  let last = -1;
  for (const c of q) {
    const i = t.indexOf(c, ti);
    if (i < 0) return -1;
    if (last >= 0 && i > last + 1) gaps++;
    last = i;
    ti = i + 1;
  }
  if (gaps > Math.max(1, Math.ceil(q.length / 2))) return -1; // too scattered to be what was meant
  return Math.max(1, 400 - gaps * 40 - (t.length - q.length));
}

export interface Searchable {
  name: string;
  category?: string;
  tags?: string[];
  description?: string;
}

/** Match a (multi-word) query against an entry: each word must hit the name, a tag, the category or the description. */
export function matchSearchable(e: Searchable, query: string): number {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return 0;
  const whole = fuzzyScore(words.join(' '), e.name);
  let total = 0;
  for (const w of words) {
    const name = fuzzyScore(w, e.name);
    // tags / category: prefix, word or substring hits only (no scattered subsequences)
    const strong = (x: number) => (x >= 600 ? x : -1);
    const tag = Math.max(-1, ...(e.tags ?? []).map((t) => strong(fuzzyScore(w, t))));
    const cat = e.category ? strong(fuzzyScore(w, e.category)) : -1;
    const desc = e.description && w.length >= 3 && e.description.toLowerCase().includes(w) ? 150 : -1;
    const best = Math.max(name, tag >= 0 ? tag * 0.6 : -1, cat >= 0 ? cat * 0.4 : -1, desc);
    if (best < 0) return -1;
    total += best;
  }
  return Math.max(total / words.length, whole >= 0 ? whole + 100 : -1);
}
