import type { Engine, RenderOptions, RenderResult } from '../engine';
import { flattenGraph, OUTPUT } from '../graph';
import type { Graph } from '../types';

/** Flat ids of `target` and everything upstream of it. */
function upstreamOf(graph: Graph, target?: string): Set<string> {
  const flat = flattenGraph(graph);
  const t = target ?? flat.nodes.find((n) => n.type === OUTPUT)?.id;
  const inc = new Map<string, string[]>();
  for (const e of flat.edges) inc.set(e.to.node, [...(inc.get(e.to.node) ?? []), e.from.node]);
  const seen = new Set<string>();
  // a group id is not in the flat graph: start from its inner nodes
  const stack = t ? (flat.nodes.some((n) => n.id === t) ? [t] : flat.nodes.filter((n) => n.id.startsWith(t + '/')).map((n) => n.id)) : [];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(inc.get(id) ?? []));
  }
  return seen;
}

/**
 * Render until no node feeding the target is waiting on an async cpu() step
 * (RAW decodes, fonts…), then return the final result. Async nodes produce
 * nothing while pending, so an export started too early would be empty.
 */
export async function renderReady(engine: Engine, graph: Graph, opts: RenderOptions, o: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<RenderResult> {
  const t0 = performance.now();
  const timeout = o.timeoutMs ?? 300_000;
  const ids = upstreamOf(graph, opts.nodeId);
  for (;;) {
    const r = engine.render(graph, opts);
    const pending = [...engine.errors].some(([id, v]) => v.startsWith('[pending]') && ids.has(id));
    if (!pending) return r;
    if (o.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    if (performance.now() - t0 > timeout) throw new Error('Timed out waiting for the image to decode.');
    await new Promise((res) => setTimeout(res, 40));
  }
}
