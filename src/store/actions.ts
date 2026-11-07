import {
  clone,
  connect,
  createGroupNode,
  createNode,
  getParamDefs,
  getPorts,
  GROUP,
  GROUP_INPUT,
  GROUP_OUTPUT,
  groupNodes,
  OUTPUT,
  uid,
  ungroupNode,
} from '../core/graph';
import { getNodeDef, getPreset } from '../core/registry';
import type { Edge, ExposedParam, Graph, GraphNode, ParamValue } from '../core/types';
import { commitGraph, commitProject, currentGraph, setPath, setSelection, setViewed, useDoc } from './doc';
import { flatId, groupNodeAt, updateGraphAt } from './graphPath';
import { status } from './ui';
import { autoConnectSource, placeFree, rightOf } from './graphEdit';
import { estimateSize, nodeSizes, useGraphUi } from './graphUi';
import { spliceIntoEdge } from '../core/graphLayout';

export type AddSpec = { kind: 'node'; type: string } | { kind: 'preset'; id: string };

export function nodeName(n: GraphNode): string {
  if (n.label) return n.label;
  if (n.type === GROUP) return n.group?.name ?? 'Group';
  return getNodeDef(n.type)?.name ?? n.type;
}

/** Build (but don't insert) a node from an add spec. */
export function buildNode(spec: AddSpec, pos: { x: number; y: number }): GraphNode | null {
  if (spec.kind === 'preset') {
    const p = getPreset(spec.id);
    if (!p) return null;
    const n = createGroupNode(p.group, pos);
    n.label = p.name;
    // remember the preset's own values as the exposed params' defaults (Reset / modified marker)
    n.group!.exposed = n.group!.exposed.map((e) => (e.def && 'default' in e.def ? e : { ...e, def: { ...e.def, default: clone(n.params[e.key]) } }));
    return n;
  }
  if (!getNodeDef(spec.type)) return null;
  const n = createNode(spec.type, pos);
  if (spec.type === GROUP_INPUT || spec.type === GROUP_OUTPUT) {
    // give sockets unique names
    const g = currentGraph();
    const base = spec.type === GROUP_INPUT ? 'image' : 'out';
    const taken = new Set(g.nodes.filter((x) => x.type === spec.type).map((x) => String(x.params.name)));
    let name = base;
    for (let i = 2; taken.has(name); i++) name = base + i;
    n.params.name = name;
  }
  return n;
}

export interface AddOpts {
  /** Auto-connect (Preferences): with one node selected, place the new node right of it and wire it up. */
  auto?: boolean;
  /** Splice the new node into this edge. */
  edge?: string;
  /** Use `pos` as is (don't search for a free spot). */
  exact?: boolean;
}

/** First port of `ports` whose type matches `type` (else the first one). */
function pickPort(ports: Record<string, { type: string }>, type?: string): string | undefined {
  const e = Object.entries(ports);
  return (e.find(([, d]) => d.type === type) ?? e[0])?.[0];
}

/**
 * Add a node at the current level. If `from` is given, connect the new node's
 * first compatible port to it. New nodes never land on top of existing ones.
 */
export function addNode(
  spec: AddSpec,
  pos: { x: number; y: number },
  from?: { node: string; port: string; kind: 'source' | 'target' },
  opts: AddOpts = {},
): string | null {
  const n = buildNode(spec, pos);
  if (!n) return null;
  const g0 = currentGraph();
  const ports = getPorts(n);
  const src = !from && !opts.edge && opts.auto ? autoConnectSource() : null;
  const auto = src && Object.keys(ports.inputs).length ? src : null;
  if (auto) n.position = rightOf(auto);
  if (!opts.exact) n.position = placeFree(n.position, estimateSize(n, Math.max(Object.keys(ports.inputs).length, Object.keys(ports.outputs).length)), new Set(), g0);
  const portsOf = (id: string) => {
    const x = id === n.id ? n : g0.nodes.find((m) => m.id === id);
    return x ? getPorts(x) : undefined;
  };
  commitGraph((g) => {
    let ng: Graph = { ...g, nodes: [...g.nodes, n] };
    if (from) {
      if (from.kind === 'source') {
        const inName = pickPort(ports.inputs, portsOf(from.node)?.outputs[from.port]?.type);
        if (inName) ng = connect(ng, { node: from.node, port: from.port }, { node: n.id, port: inName });
      } else {
        const outName = pickPort(ports.outputs, portsOf(from.node)?.inputs[from.port]?.type);
        if (outName) ng = connect(ng, { node: n.id, port: outName }, { node: from.node, port: from.port });
      }
    } else if (auto) {
      const out = Object.keys(getPorts(auto).outputs)[0];
      const inName = pickPort(ports.inputs, getPorts(auto).outputs[out]?.type);
      if (out && inName) ng = connect(ng, { node: auto.id, port: out }, { node: n.id, port: inName });
    } else if (opts.edge) {
      ng = spliceIntoEdge(ng, opts.edge, n.id, portsOf, () => uid('e')) ?? ng;
    }
    return ng;
  });
  setSelection([n.id]);
  return n.id;
}

/** Insert a node into an existing edge (used when exactly one node is selected? kept simple). */
export function connectPorts(from: { node: string; port: string }, to: { node: string; port: string }) {
  const g = currentGraph();
  const ng = connect(g, from, to);
  if (ng === g) {
    status('Cannot connect: that would create a cycle.', 'error');
    return;
  }
  commitGraph(() => ng);
}

export function removeEdges(ids: string[]) {
  if (!ids.length) return;
  const set = new Set(ids);
  commitGraph((g) => ({ ...g, edges: g.edges.filter((e) => !set.has(e.id)) }));
}

export function deleteSelection() {
  const { selection, edgeSelection } = useDoc.getState();
  if (!selection.length && !edgeSelection.length && !useGraphUi.getState().frameSelection.length) return;
  const sel = new Set(selection);
  const es = new Set(edgeSelection);
  const fs = new Set(useGraphUi.getState().frameSelection);
  commitGraph((g) => {
    const out: Graph = {
      ...g,
      nodes: g.nodes.filter((n) => !sel.has(n.id)),
      edges: g.edges.filter((e) => !es.has(e.id) && !sel.has(e.from.node) && !sel.has(e.to.node)),
    };
    if (fs.size && g.frames) out.frames = g.frames.filter((f) => !fs.has(f.id));
    if (out.frames && !out.frames.length) delete out.frames;
    return out;
  });
  setSelection([]);
  if (fs.size) useGraphUi.setState({ frameSelection: [] });
}

export function moveNodes(pos: Record<string, { x: number; y: number }>) {
  commitGraph(
    (g) => ({ ...g, nodes: g.nodes.map((n) => (pos[n.id] ? { ...n, position: pos[n.id] } : n)) }),
    { coalesce: 'move:' + Object.keys(pos).sort().join(',') },
  );
}

export function selectAll() {
  setSelection(currentGraph().nodes.map((n) => n.id));
}

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------

interface ClipData {
  darkroom: 'nodes';
  nodes: GraphNode[];
  edges: Edge[];
}
let clipboard: ClipData | null = null;

export function copySelection(): boolean {
  const s = useDoc.getState();
  const g = currentGraph(s);
  const sel = new Set(s.selection);
  const nodes = g.nodes.filter((n) => sel.has(n.id));
  if (!nodes.length) return false;
  clipboard = { darkroom: 'nodes', nodes: clone(nodes), edges: clone(g.edges.filter((e) => sel.has(e.from.node) && sel.has(e.to.node))) };
  try {
    void navigator.clipboard?.writeText(JSON.stringify(clipboard)).catch(() => {});
  } catch {
    /* ignore */
  }
  status(`Copied ${nodes.length} node${nodes.length > 1 ? 's' : ''}.`);
  return true;
}

function pasteData(data: ClipData, offset: { x: number; y: number }) {
  // keep the pasted block clear of existing nodes: place its bounding box at the nearest free spot
  const sz = (n: GraphNode) => nodeSizes.measured(n.id) ?? estimateSize(n, Math.max(Object.keys(getPorts(n).inputs).length, Object.keys(getPorts(n).outputs).length));
  const minX = Math.min(...data.nodes.map((n) => n.position.x));
  const minY = Math.min(...data.nodes.map((n) => n.position.y));
  const box = {
    width: Math.max(...data.nodes.map((n) => n.position.x + sz(n).width)) - minX,
    height: Math.max(...data.nodes.map((n) => n.position.y + sz(n).height)) - minY,
  };
  const at = placeFree({ x: minX + offset.x, y: minY + offset.y }, box);
  offset = { x: at.x - minX, y: at.y - minY };
  const idMap = new Map(data.nodes.map((n) => [n.id, n.type === GROUP ? uid('g') : uid()]));
  const nodes = data.nodes.map((n) => ({ ...clone(n), id: idMap.get(n.id)!, position: { x: n.position.x + offset.x, y: n.position.y + offset.y } }));
  const edges = data.edges.map((e) => ({
    id: uid('e'),
    from: { node: idMap.get(e.from.node)!, port: e.from.port },
    to: { node: idMap.get(e.to.node)!, port: e.to.port },
  }));
  commitGraph((g) => ({ ...g, nodes: [...g.nodes, ...nodes], edges: [...g.edges, ...edges] }));
  setSelection(nodes.map((n) => n.id));
}

export function pasteClipboard(at?: { x: number; y: number }) {
  if (!clipboard) return false;
  const minX = Math.min(...clipboard.nodes.map((n) => n.position.x));
  const minY = Math.min(...clipboard.nodes.map((n) => n.position.y));
  pasteData(clipboard, at ? { x: at.x - minX, y: at.y - minY } : { x: 40, y: 40 });
  return true;
}

/** Try to parse a text clipboard payload as copied nodes. */
export function pasteText(text: string, at?: { x: number; y: number }) {
  try {
    const d = JSON.parse(text) as ClipData;
    if (d?.darkroom !== 'nodes' || !Array.isArray(d.nodes)) return false;
    clipboard = d;
    return pasteClipboard(at);
  } catch {
    return false;
  }
}

export function duplicateSelection() {
  const s = useDoc.getState();
  const g = currentGraph(s);
  const sel = new Set(s.selection);
  const nodes = g.nodes.filter((n) => sel.has(n.id));
  if (!nodes.length) return;
  pasteData({ darkroom: 'nodes', nodes, edges: g.edges.filter((e) => sel.has(e.from.node) && sel.has(e.to.node)) }, { x: 30, y: 30 });
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

export function groupSelection() {
  const s = useDoc.getState();
  const ids = s.selection.filter((id) => currentGraph(s).nodes.find((n) => n.id === id)?.type !== OUTPUT);
  if (!ids.length) {
    status('Select nodes to group.', 'error');
    return;
  }
  let gid = '';
  commitGraph((g) => {
    const r = groupNodes(g, ids, 'Group');
    gid = r.groupId;
    return r.graph;
  });
  setSelection(gid ? [gid] : []);
  status(`Grouped ${ids.length} node${ids.length > 1 ? 's' : ''}.`);
}

export function ungroupSelection() {
  const s = useDoc.getState();
  const g0 = currentGraph(s);
  const groups = s.selection.filter((id) => g0.nodes.find((n) => n.id === id)?.type === GROUP);
  if (!groups.length) {
    status('Select a group to ungroup.', 'error');
    return;
  }
  const before = new Set(g0.nodes.map((n) => n.id));
  commitGraph((g) => groups.reduce((acc, id) => ungroupNode(acc, id), g));
  setSelection(currentGraph().nodes.filter((n) => !before.has(n.id)).map((n) => n.id));
}

export function enterGroup(id?: string) {
  const s = useDoc.getState();
  const gid = id ?? s.selection[0];
  const n = currentGraph(s).nodes.find((x) => x.id === gid);
  if (!n || n.type !== GROUP) return;
  setPath([...s.path, gid]);
}

export function exitGroup(depth?: number) {
  const s = useDoc.getState();
  if (!s.path.length) return;
  const d = depth ?? s.path.length - 1;
  const left = s.path[d];
  setPath(s.path.slice(0, d));
  if (left) setSelection([left]);
}

// ---------------------------------------------------------------------------
// Node properties
// ---------------------------------------------------------------------------

function mapNode(g: Graph, id: string, fn: (n: GraphNode) => GraphNode): Graph {
  return { ...g, nodes: g.nodes.map((n) => (n.id === id ? fn(n) : n)) };
}

/**
 * Set a param on a node at the current level. Keeps exposed params in sync in
 * both directions (group node param ↔ inner node param).
 */
export function setParam(nodeId: string, key: string, value: ParamValue, coalesce = true) {
  const s = useDoc.getState();
  const path = s.path;
  commitProject(
    (p) => {
      let root = updateGraphAt(p.graph, path, (g) =>
        mapNode(g, nodeId, (n) => {
          let nn: GraphNode = { ...n, params: { ...n.params, [key]: value } };
          // group node: push into the inner node too
          if (n.type === GROUP && n.group) {
            const ex = n.group.exposed.find((e) => e.key === key);
            if (ex)
              nn = {
                ...nn,
                group: { ...n.group, graph: mapNode(n.group.graph, ex.node, (inner) => ({ ...inner, params: { ...inner.params, [ex.param]: clone(value) } })) },
              };
          }
          return nn;
        }),
      );
      // inner node of an enclosing group with this param exposed: update the group node param
      if (path.length) {
        const gnode = groupNodeAt(root, path);
        const ex = gnode?.group?.exposed.filter((e) => e.node === nodeId && e.param === key) ?? [];
        if (gnode && ex.length) {
          root = updateGraphAt(root, path.slice(0, -1), (g) =>
            mapNode(g, gnode.id, (gn) => ({ ...gn, params: { ...gn.params, ...Object.fromEntries(ex.map((e) => [e.key, clone(value)])) } })),
          );
        }
      }
      return { ...p, graph: root };
    },
    { coalesce: coalesce ? `param:${path.join('/')}:${nodeId}:${key}` : undefined },
  );
}

export function resetParam(nodeId: string, key: string) {
  const n = currentGraph().nodes.find((x) => x.id === nodeId);
  if (!n) return;
  const def = getParamDefs(n)[key];
  if (!def) return;
  setParam(nodeId, key, clone(def.default), false);
}

export function setLabel(nodeId: string, label: string) {
  commitGraph((g) =>
    mapNode(g, nodeId, (n) => {
      const nn = { ...n, label: label || undefined };
      if (n.type === GROUP && n.group && label) nn.group = { ...n.group, name: label };
      return nn;
    }),
  );
}

export function toggleBypass(ids?: string[]) {
  const s = useDoc.getState();
  const sel = new Set(ids ?? s.selection);
  if (!sel.size) return;
  const g = currentGraph(s);
  const any = g.nodes.some((n) => sel.has(n.id) && !n.bypass);
  commitGraph((gr) => ({ ...gr, nodes: gr.nodes.map((n) => (sel.has(n.id) ? { ...n, bypass: any || undefined } : n)) }));
}

/** Show the selected node (or `id`) in the viewer. */
export function viewNode(id?: string) {
  const s = useDoc.getState();
  const nid = id ?? s.selection[0];
  if (!nid) return;
  const n = currentGraph(s).nodes.find((x) => x.id === nid);
  if (!n || n.type === GROUP_OUTPUT) return;
  setViewed(flatId(s.path, nid));
}

export function setOutputNode(id: string) {
  commitProject((p) => ({ ...p, outputNode: id }));
}

// ---------------------------------------------------------------------------
// Exposed params
// ---------------------------------------------------------------------------

/** Expose an inner node's param on the enclosing group (only valid inside a group). */
export function exposeParam(nodeId: string, param: string) {
  const s = useDoc.getState();
  if (!s.path.length) return;
  const gnode = groupNodeAt(s.project.graph, s.path);
  const inner = currentGraph(s).nodes.find((n) => n.id === nodeId);
  if (!gnode?.group || !inner) return;
  if (gnode.group.exposed.some((e) => e.node === nodeId && e.param === param)) {
    status('That parameter is already exposed.');
    return;
  }
  const def = getParamDefs(inner)[param];
  const taken = new Set(gnode.group.exposed.map((e) => e.key));
  let key = param;
  for (let i = 2; taken.has(key); i++) key = `${param}${i}`;
  const ex: ExposedParam = { key, node: nodeId, param, label: def?.label ?? param, def: { default: clone(inner.params[param] ?? def?.default ?? 0) } };
  const parentPath = s.path.slice(0, -1);
  commitProject((p) => ({
    ...p,
    graph: updateGraphAt(p.graph, parentPath, (g) =>
      mapNode(g, gnode.id, (gn) => ({
        ...gn,
        params: { ...gn.params, [key]: clone(inner.params[param] ?? def?.default ?? 0) },
        group: { ...gn.group!, exposed: [...gn.group!.exposed, ex] },
      })),
    ),
  }));
  status(`Exposed “${ex.label}” on ${nodeName(gnode)}.`);
}

export function renameExposed(groupId: string, key: string, label: string) {
  commitGraph((g) => mapNode(g, groupId, (gn) => ({ ...gn, group: { ...gn.group!, exposed: gn.group!.exposed.map((e) => (e.key === key ? { ...e, label } : e)) } })));
}

export function removeExposed(groupId: string, key: string) {
  commitGraph((g) =>
    mapNode(g, groupId, (gn) => {
      const params = { ...gn.params };
      delete params[key];
      return { ...gn, params, group: { ...gn.group!, exposed: gn.group!.exposed.filter((e) => e.key !== key) } };
    }),
  );
}

export function moveExposed(groupId: string, key: string, dir: -1 | 1) {
  commitGraph((g) =>
    mapNode(g, groupId, (gn) => {
      const list = [...gn.group!.exposed];
      const i = list.findIndex((e) => e.key === key);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= list.length) return gn;
      [list[i], list[j]] = [list[j], list[i]];
      return { ...gn, group: { ...gn.group!, exposed: list } };
    }),
  );
}

/** Exposures of (nodeId,param) on the enclosing group, if editing inside one. */
export function exposedAs(nodeId: string, param: string): ExposedParam | undefined {
  const s = useDoc.getState();
  const g = groupNodeAt(s.project.graph, s.path);
  return g?.group?.exposed.find((e) => e.node === nodeId && e.param === param);
}

/**
 * Default spot for new nodes when no position is known: right of the selected node, else below
 * the graph's left column. addNode() then nudges it to the nearest spot that overlaps nothing.
 */
export function freeSpot(): { x: number; y: number } {
  const g = currentGraph();
  if (!g.nodes.length) return { x: 0, y: 0 };
  const sel = useDoc.getState().selection;
  const ref = g.nodes.find((n) => n.id === sel[0]);
  if (ref) return rightOf(ref);
  return { x: Math.min(...g.nodes.map((n) => n.position.x)), y: Math.max(...g.nodes.map((n) => n.position.y)) + 140 };
}

