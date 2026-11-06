import { getNodeDef } from './registry';
import type { Edge, ExposedParam, Graph, GraphNode, GroupData, ParamDef, Params, PortDef } from './types';

export const GROUP = 'core.group';
export const GROUP_INPUT = 'core.groupInput';
export const GROUP_OUTPUT = 'core.groupOutput';
export const OUTPUT = 'core.output';
export const IMAGE = 'core.image';

let counter = 0;
export function uid(prefix = 'n') {
  counter = (counter + 1) % 1e6;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

export const clone = <T>(x: T): T => structuredClone(x);

export function defaultParams(type: string): Params {
  const def = getNodeDef(type);
  const p: Params = {};
  if (def) for (const [k, d] of Object.entries(def.params)) p[k] = clone(d.default);
  return p;
}

export function createNode(type: string, position = { x: 0, y: 0 }, params: Params = {}): GraphNode {
  return { id: uid(), type, position, params: { ...defaultParams(type), ...params } };
}

/** Wrap a GroupData in a group node. Params default from the inner nodes' current values. */
export function createGroupNode(group: GroupData, position = { x: 0, y: 0 }): GraphNode {
  const g = clone(group);
  const params: Params = {};
  for (const e of g.exposed) {
    const inner = g.graph.nodes.find((n) => n.id === e.node);
    params[e.key] = clone(inner?.params[e.param] ?? getNodeDef(inner?.type ?? '')?.params[e.param]?.default ?? 0);
  }
  return { id: uid(), type: GROUP, position, params, group: g, label: g.name };
}

// ---------------------------------------------------------------------------
// Ports & params (handles groups, whose ports are derived from their contents)
// ---------------------------------------------------------------------------

export interface NodePorts {
  inputs: Record<string, PortDef>;
  outputs: Record<string, PortDef>;
}

const DEFAULT_OUT: Record<string, PortDef> = { out: { type: 'image' } };

export function getPorts(node: GraphNode): NodePorts {
  if (node.type === GROUP && node.group) {
    const inputs: Record<string, PortDef> = {};
    const outputs: Record<string, PortDef> = {};
    for (const n of sortByY(node.group.graph.nodes)) {
      if (n.type === GROUP_INPUT) inputs[String(n.params.name ?? 'image')] = { type: (n.params.type as 'image' | 'mask') ?? 'image', optional: true };
      if (n.type === GROUP_OUTPUT) outputs[String(n.params.name ?? 'out')] = { type: 'image' };
    }
    return { inputs, outputs };
  }
  const def = getNodeDef(node.type);
  return { inputs: def?.inputs ?? {}, outputs: def?.outputs ?? DEFAULT_OUT };
}

const sortByY = (ns: GraphNode[]) => [...ns].sort((a, b) => a.position.y - b.position.y);

/** Param definitions for a node (exposed params for groups). */
export function getParamDefs(node: GraphNode): Record<string, ParamDef> {
  if (node.type === GROUP && node.group) {
    const out: Record<string, ParamDef> = {};
    for (const e of node.group.exposed) {
      const inner = node.group.graph.nodes.find((n) => n.id === e.node);
      const base = inner ? getParamDefs(inner)[e.param] : undefined;
      if (!base) continue;
      out[e.key] = { ...base, ...e.def, label: e.label ?? e.def?.label ?? base.label ?? e.key };
    }
    return out;
  }
  return getNodeDef(node.type)?.params ?? {};
}

// ---------------------------------------------------------------------------
// Flattening: inline all groups so the engine sees a flat graph.
// Inner node ids become `${groupId}/${innerId}` (UI maps errors to the first segment).
// ---------------------------------------------------------------------------

export function flattenGraph(graph: Graph): Graph {
  if (!graph.nodes.some((n) => n.type === GROUP)) return graph;
  let nodes: GraphNode[] = [];
  let edges: Edge[] = graph.edges.map((e) => ({ ...e, from: { ...e.from }, to: { ...e.to } }));

  for (const node of graph.nodes) {
    if (node.type !== GROUP || !node.group) {
      nodes.push(node);
      continue;
    }
    const inner = flattenGraph(applyExposed(node));
    const pre = node.id + '/';
    const innerNodes = inner.nodes.map((n) => ({ ...n, id: pre + n.id }));
    let innerEdges = inner.edges.map((e) => ({
      id: pre + e.id,
      from: { node: pre + e.from.node, port: e.from.port },
      to: { node: pre + e.to.node, port: e.to.port },
    }));
    const byId = new Map(innerNodes.map((n) => [n.id, n]));

    if (node.bypass) {
      // pass first input → first output
      const ports = getPorts(node);
      const firstIn = Object.keys(ports.inputs)[0];
      const firstOut = Object.keys(ports.outputs)[0];
      const src = edges.find((e) => e.to.node === node.id && e.to.port === firstIn)?.from;
      edges = edges.filter((e) => e.to.node !== node.id);
      edges = edges.flatMap((e) => (e.from.node === node.id ? (src && e.from.port === firstOut ? [{ ...e, from: src }] : []) : [e]));
      continue;
    }

    // external sources feeding each group input
    const extIn = new Map<string, { node: string; port: string }>();
    for (const e of edges) if (e.to.node === node.id) extIn.set(e.to.port, e.from);
    // rewire inner edges that start at groupInput nodes
    innerEdges = innerEdges.flatMap((e) => {
      const src = byId.get(e.from.node);
      if (src?.type !== GROUP_INPUT) return [e];
      const ext = extIn.get(String(src.params.name ?? 'image'));
      return ext ? [{ ...e, from: ext }] : [];
    });
    // map group outputs to the inner source feeding each groupOutput
    const outSrc = new Map<string, { node: string; port: string }>();
    for (const e of innerEdges) {
      const dst = byId.get(e.to.node);
      if (dst?.type === GROUP_OUTPUT) outSrc.set(String(dst.params.name ?? 'out'), e.from);
    }
    innerEdges = innerEdges.filter((e) => byId.get(e.to.node)?.type !== GROUP_OUTPUT);
    edges = edges.filter((e) => e.to.node !== node.id);
    edges = edges.flatMap((e) => {
      if (e.from.node !== node.id) return [e];
      const s = outSrc.get(e.from.port);
      return s ? [{ ...e, from: s }] : [];
    });
    nodes.push(...innerNodes.filter((n) => n.type !== GROUP_INPUT && n.type !== GROUP_OUTPUT));
    edges.push(...innerEdges);
  }
  return { nodes, edges };
}

/** Copy of the group's inner graph with exposed param values applied. */
function applyExposed(node: GraphNode): Graph {
  const g = node.group!;
  const graph = clone(g.graph);
  for (const e of g.exposed) {
    if (!(e.key in node.params)) continue;
    const inner = graph.nodes.find((n) => n.id === e.node);
    if (inner) inner.params = { ...inner.params, [e.param]: clone(node.params[e.key]) };
  }
  return graph;
}

// ---------------------------------------------------------------------------
// Grouping / ungrouping a selection (used by the editor)
// ---------------------------------------------------------------------------

/** Collapse `ids` into a new group node. Returns the new graph and the group node id. */
export function groupNodes(graph: Graph, ids: string[], name = 'Group'): { graph: Graph; groupId: string } {
  const sel = new Set(ids);
  const inside = graph.nodes.filter((n) => sel.has(n.id));
  if (!inside.length) return { graph, groupId: '' };
  const cx = inside.reduce((s, n) => s + n.position.x, 0) / inside.length;
  const cy = inside.reduce((s, n) => s + n.position.y, 0) / inside.length;
  const minX = Math.min(...inside.map((n) => n.position.x));
  const maxX = Math.max(...inside.map((n) => n.position.x));

  const innerNodes = clone(inside);
  const innerEdges: Edge[] = [];
  const outerEdges: Edge[] = [];
  const groupId = uid('g');
  const inputsBySource = new Map<string, string>(); // "node:port" → group input name
  const outputsBySource = new Map<string, string>();
  let yIn = 0;
  let yOut = 0;

  for (const e of graph.edges) {
    const a = sel.has(e.from.node);
    const b = sel.has(e.to.node);
    if (a && b) innerEdges.push(clone(e));
    else if (!a && b) {
      const key = `${e.from.node}:${e.from.port}`;
      let name = inputsBySource.get(key);
      if (!name) {
        name = inputsBySource.size === 0 ? 'image' : `in${inputsBySource.size + 1}`;
        inputsBySource.set(key, name);
        const gi: GraphNode = { id: uid(), type: GROUP_INPUT, params: { name, type: 'image' }, position: { x: minX - 250, y: cy + yIn } };
        yIn += 120;
        innerNodes.push(gi);
        outerEdges.push({ id: uid('e'), from: e.from, to: { node: groupId, port: name } });
      }
      const gi = innerNodes.find((n) => n.type === GROUP_INPUT && n.params.name === name)!;
      innerEdges.push({ id: uid('e'), from: { node: gi.id, port: 'out' }, to: e.to });
    } else if (a && !b) {
      const key = `${e.from.node}:${e.from.port}`;
      let name = outputsBySource.get(key);
      if (!name) {
        name = outputsBySource.size === 0 ? 'out' : `out${outputsBySource.size + 1}`;
        outputsBySource.set(key, name);
        const go: GraphNode = { id: uid(), type: GROUP_OUTPUT, params: { name }, position: { x: maxX + 250, y: cy + yOut } };
        yOut += 120;
        innerNodes.push(go);
        innerEdges.push({ id: uid('e'), from: e.from, to: { node: go.id, port: 'in' } });
      }
      outerEdges.push({ id: uid('e'), from: { node: groupId, port: name }, to: e.to });
    } else outerEdges.push(e);
  }
  const groupNode: GraphNode = {
    id: groupId,
    type: GROUP,
    label: name,
    position: { x: cx, y: cy },
    params: {},
    group: { name, graph: { nodes: innerNodes, edges: innerEdges }, exposed: [] },
  };
  return {
    graph: { nodes: [...graph.nodes.filter((n) => !sel.has(n.id)), groupNode], edges: outerEdges },
    groupId,
  };
}

/** Inline a group node's contents back into the parent graph. */
export function ungroupNode(graph: Graph, groupId: string): Graph {
  const node = graph.nodes.find((n) => n.id === groupId);
  if (!node || node.type !== GROUP || !node.group) return graph;
  const inner = applyExposed(node);
  // re-id inner nodes to avoid collisions
  const idMap = new Map(inner.nodes.map((n) => [n.id, uid()]));
  const cx = inner.nodes.reduce((s, n) => s + n.position.x, 0) / Math.max(1, inner.nodes.length);
  const cy = inner.nodes.reduce((s, n) => s + n.position.y, 0) / Math.max(1, inner.nodes.length);
  const innerNodes = inner.nodes.map((n) => ({
    ...n,
    id: idMap.get(n.id)!,
    position: { x: n.position.x - cx + node.position.x, y: n.position.y - cy + node.position.y },
  }));
  const tmp: Graph = {
    nodes: [...graph.nodes.filter((n) => n.id !== groupId), ...innerNodes],
    edges: [...graph.edges],
  };
  const byId = new Map(innerNodes.map((n) => [n.id, n]));
  let innerEdges = inner.edges.map((e) => ({ id: uid('e'), from: { node: idMap.get(e.from.node)!, port: e.from.port }, to: { node: idMap.get(e.to.node)!, port: e.to.port } }));
  const extIn = new Map<string, { node: string; port: string }>();
  for (const e of tmp.edges) if (e.to.node === groupId) extIn.set(e.to.port, e.from);
  innerEdges = innerEdges.flatMap((e) => {
    const s = byId.get(e.from.node);
    if (s?.type !== GROUP_INPUT) return [e];
    const ext = extIn.get(String(s.params.name));
    return ext ? [{ ...e, from: ext }] : [];
  });
  const outSrc = new Map<string, { node: string; port: string }>();
  for (const e of innerEdges) {
    const d = byId.get(e.to.node);
    if (d?.type === GROUP_OUTPUT) outSrc.set(String(d.params.name), e.from);
  }
  innerEdges = innerEdges.filter((e) => byId.get(e.to.node)?.type !== GROUP_OUTPUT);
  const edges = tmp.edges
    .filter((e) => e.to.node !== groupId)
    .flatMap((e) => (e.from.node !== groupId ? [e] : outSrc.get(e.from.port) ? [{ ...e, from: outSrc.get(e.from.port)! }] : []));
  return {
    nodes: tmp.nodes.filter((n) => n.type !== GROUP_INPUT && n.type !== GROUP_OUTPUT),
    edges: [...edges, ...innerEdges],
  };
}

/** True if adding edge from→to would create a cycle. */
export function wouldCycle(graph: Graph, from: string, to: string): boolean {
  if (from === to) return true;
  const out = new Map<string, string[]>();
  for (const e of graph.edges) out.set(e.from.node, [...(out.get(e.from.node) ?? []), e.to.node]);
  const stack = [to];
  const seen = new Set<string>();
  while (stack.length) {
    const n = stack.pop()!;
    if (n === from) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    stack.push(...(out.get(n) ?? []));
  }
  return false;
}

/** Add an edge, replacing any existing edge into the same input port. */
export function connect(graph: Graph, from: { node: string; port: string }, to: { node: string; port: string }): Graph {
  if (wouldCycle(graph, from.node, to.node)) return graph;
  return {
    ...graph,
    edges: [...graph.edges.filter((e) => !(e.to.node === to.node && e.to.port === to.port)), { id: uid('e'), from, to }],
  };
}

// ---------------------------------------------------------------------------
// GraphBuilder — convenient programmatic construction (used by presets & tests)
// ---------------------------------------------------------------------------

type Ref = string | { node: string; port: string };

export class GraphBuilder {
  nodes: GraphNode[] = [];
  edges: Edge[] = [];
  exposed: ExposedParam[] = [];
  private n = 0;

  /** Add a node. `inputs` maps input port → source node id (port 'out') or {node,port}. */
  node(type: string, params: Params = {}, inputs: Record<string, Ref> = {}, id?: string): string {
    const nid = id ?? `${type.split('.').pop()}${++this.n}`;
    this.nodes.push({ id: nid, type, params: { ...defaultParams(type), ...params }, position: { x: 0, y: 0 } });
    for (const [port, ref] of Object.entries(inputs)) this.link(ref, nid, port);
    return nid;
  }

  link(from: Ref, toNode: string, toPort: string) {
    const f = typeof from === 'string' ? { node: from, port: 'out' } : from;
    this.edges.push({ id: `e${++this.n}`, from: f, to: { node: toNode, port: toPort } });
  }

  /** Group input socket (inside a group). */
  input(name = 'image', type: 'image' | 'mask' = 'image'): string {
    return this.node(GROUP_INPUT, { name, type }, {}, `in_${name}`);
  }

  /** Group output socket (inside a group). */
  output(name: string, from: Ref): string {
    return this.node(GROUP_OUTPUT, { name }, { in: from }, `out_${name}`);
  }

  /** Expose an inner param on the group node. */
  expose(key: string, node: string, param: string, label?: string, def?: Partial<ParamDef>) {
    this.exposed.push({ key, node, param, label, def });
    return this;
  }

  toGraph(): Graph {
    layout(this.nodes, this.edges);
    return { nodes: this.nodes, edges: this.edges };
  }

  toGroup(name: string): GroupData {
    return { name, graph: this.toGraph(), exposed: this.exposed };
  }
}

/** Simple layered left-to-right auto-layout. */
export function layout(nodes: GraphNode[], edges: Edge[], dx = 260, dy = 150) {
  const depth = new Map<string, number>();
  const incoming = new Map<string, string[]>();
  for (const e of edges) incoming.set(e.to.node, [...(incoming.get(e.to.node) ?? []), e.from.node]);
  const visit = (id: string, stack = new Set<string>()): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (stack.has(id)) return 0;
    stack.add(id);
    const d = Math.max(-1, ...(incoming.get(id) ?? []).map((s) => visit(s, stack))) + 1;
    depth.set(id, d);
    return d;
  };
  nodes.forEach((n) => visit(n.id));
  const rows = new Map<number, number>();
  for (const n of nodes) {
    const d = depth.get(n.id) ?? 0;
    const r = rows.get(d) ?? 0;
    rows.set(d, r + 1);
    n.position = { x: d * dx, y: r * dy };
  }
}
