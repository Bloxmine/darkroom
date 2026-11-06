import { GROUP } from '../core/graph';
import type { Graph, GraphNode } from '../core/types';

/** The graph at a group path (list of nested group node ids). */
export function graphAt(root: Graph, path: string[]): Graph | null {
  let g: Graph = root;
  for (const id of path) {
    const n = g.nodes.find((x) => x.id === id);
    if (!n || n.type !== GROUP || !n.group) return null;
    g = n.group.graph;
  }
  return g;
}

/** Immutably replace the graph at `path`. */
export function updateGraphAt(root: Graph, path: string[], fn: (g: Graph) => Graph): Graph {
  if (!path.length) return fn(root);
  const [head, ...rest] = path;
  return {
    ...root,
    nodes: root.nodes.map((n) =>
      n.id === head && n.group ? { ...n, group: { ...n.group, graph: updateGraphAt(n.group.graph, rest, fn) } } : n,
    ),
  };
}

/** The group node owning the graph at `path` (i.e. the last element), within its parent. */
export function groupNodeAt(root: Graph, path: string[]): GraphNode | null {
  if (!path.length) return null;
  const parent = graphAt(root, path.slice(0, -1));
  return parent?.nodes.find((n) => n.id === path[path.length - 1]) ?? null;
}

/** Longest valid prefix of `path` in `root`. */
export function validPath(root: Graph, path: string[]): string[] {
  const out: string[] = [];
  for (const id of path) {
    if (!graphAt(root, [...out, id])) break;
    out.push(id);
  }
  return out;
}

export const flatId = (path: string[], id: string) => [...path, id].join('/');

/** Map a flat engine id (e.g. 'g1/g2/n3') to the node id at `path` level it belongs to, if any. */
export function localIdForFlat(path: string[], flat: string): string | null {
  const prefix = path.length ? path.join('/') + '/' : '';
  if (!flat.startsWith(prefix)) return null;
  const rest = flat.slice(prefix.length);
  return rest.split('/')[0] || null;
}
