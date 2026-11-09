/**
 * Node info: read-only results a node's cpu() wants to show in the Properties panel (e.g. a caption or OCR text),
 * keyed by the engine's (flat) node id (`CpuContext.nodeId`). Generic and UI-free: the panel renders `text` with a
 * Copy button (see NodeInfoBlock in src/ui/Properties.tsx).
 */

export interface NodeInfo {
  title?: string;
  /** Main result text (shown read-only, copyable). */
  text: string;
  /** Extra one-line detail under the text (timings, counts…). */
  detail?: string;
  /** If set, the panel offers “Use as project name”. */
  suggestName?: string;
}

const infos = new Map<string, NodeInfo>();
const listeners = new Set<() => void>();
let version = 0;

export function setNodeInfo(id: string | undefined, info: NodeInfo | null) {
  if (!id) return;
  const old = infos.get(id);
  if (info ? old && JSON.stringify(old) === JSON.stringify(info) : !old) return;
  if (info) infos.set(id, info);
  else infos.delete(id);
  version++;
  listeners.forEach((l) => l());
}

export const getNodeInfo = (id: string) => infos.get(id);
export const nodeInfoVersion = () => version;
export function subscribeNodeInfo(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** Info of a node, or (for a group) of the nodes inside it. */
export function nodeInfosFor(flatId: string): NodeInfo[] {
  const own = infos.get(flatId);
  if (own) return [own];
  const out: NodeInfo[] = [];
  for (const [k, v] of infos) if (k.startsWith(flatId + '/')) out.push(v);
  return out;
}

/** Every published info (debugging / automation). */
export const allNodeInfo = () => [...infos];
