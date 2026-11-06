/**
 * Finding / swapping the "input" image of a graph (pure): used by batch
 * processing (swap the asset in a cloned graph) and share-target imports
 * (rewire a new photo where the current one was).
 */
import { defaultParams, flattenGraph, IMAGE, OUTPUT } from '../graph';
import { RAW } from '../raw/formats';
import type { Graph, GraphNode } from '../types';

export const isSourceNode = (n: { type: string }) => n.type === IMAGE || n.type === RAW;

export interface SourceNode {
  /** Flat engine id ('g1/n2' inside groups). */
  id: string;
  node: GraphNode;
  /** Upstream of the output? */
  feedsOutput: boolean;
}

/** Image/RAW nodes of the (flattened) graph, those feeding `outputId` first, in BFS order from the output. */
export function sourceNodes(graph: Graph, outputId?: string): SourceNode[] {
  const flat = flattenGraph(graph);
  const byId = new Map(flat.nodes.map((n) => [n.id, n]));
  const out = outputId && byId.has(outputId) ? outputId : flat.nodes.find((n) => n.type === OUTPUT)?.id;
  const inc = new Map<string, string[]>();
  for (const e of flat.edges) inc.set(e.to.node, [...(inc.get(e.to.node) ?? []), e.from.node]);
  const upstream: string[] = [];
  const seen = new Set<string>();
  let frontier = out ? [out] : [];
  while (frontier.length) {
    const next: string[] = [];
    for (const id of frontier) {
      if (seen.has(id)) continue;
      seen.add(id);
      const n = byId.get(id);
      if (n && isSourceNode(n)) upstream.push(id);
      next.push(...(inc.get(id) ?? []));
    }
    frontier = next;
  }
  const up = new Set(upstream);
  const rest = flat.nodes.filter((n) => isSourceNode(n) && !up.has(n.id)).map((n) => n.id);
  return [...upstream, ...rest].map((id) => ({ id, node: byId.get(id)!, feedsOutput: up.has(id) }));
}

/** Default batch input: the first Image/RAW node feeding the output (else any). */
export const defaultSourceNode = (graph: Graph, outputId?: string) => sourceNodes(graph, outputId)[0]?.id;

/** Immutably update the node at a flat id (descending into group subgraphs). */
export function updateNodeAt(graph: Graph, flatId: string, fn: (n: GraphNode) => GraphNode): Graph {
  const [head, ...rest] = flatId.split('/');
  let hit = false;
  const nodes = graph.nodes.map((n) => {
    if (n.id !== head) return n;
    if (!rest.length) {
      hit = true;
      return fn(n);
    }
    if (!n.group) return n;
    const g = updateNodeAt(n.group.graph, rest.join('/'), fn);
    if (g === n.group.graph) return n;
    hit = true;
    return { ...n, group: { ...n.group, graph: g } };
  });
  return hit ? { ...graph, nodes } : graph;
}

/**
 * Point the source node at another asset, switching between core.image and
 * core.raw as needed (RAW develop params are kept when the node already was RAW).
 */
export function swapSourceAsset(graph: Graph, flatId: string, assetId: string, isRaw: boolean): Graph {
  return updateNodeAt(graph, flatId, (n) => {
    const type = isRaw ? RAW : IMAGE;
    const params = n.type === type ? { ...n.params, asset: assetId } : { ...defaultParams(type), asset: assetId };
    return { ...n, type, params };
  });
}
