import { GROUP } from './graph';
import { dbDelete, dbGetAll, dbPut } from './pluginDb';
import { getNodeDef, registerNode, setMissingNodeHint, unregisterNode } from './registry';
import { deserializeNodeDef, isSerializable, sameSerialized, serializeNodeDef, validateSerializedNodeDef } from './serialize';
import type { Graph, NodeDef, Project, ProjectPluginRef, SerializedNodeDef } from './types';

/**
 * Custom node types: the user's library (Node Builder), node origins
 * (built-in / user / plugin / project) and embedding into project files.
 */

export type NodeOrigin =
  | { kind: 'user' }
  | { kind: 'project' }
  | { kind: 'plugin'; id: string; name: string; version: string; url?: string };

const origins = new Map<string, NodeOrigin>();
/** Undefined for built-in nodes (and for unregistered ids). */
export const getNodeOrigin = (id: string) => origins.get(id);
export const setNodeOrigin = (id: string, o: NodeOrigin) => origins.set(id, o);
export const clearNodeOrigin = (id: string) => origins.delete(id);
export const isBuiltinNode = (id: string) => !!getNodeDef(id) && !origins.has(id);

export function describeOrigin(id: string): string {
  const o = origins.get(id);
  if (!o) return getNodeDef(id) ? 'built-in' : 'unknown';
  if (o.kind === 'user') return 'custom node (your library)';
  if (o.kind === 'project') return 'custom node (embedded in this project)';
  return `plugin “${o.name}” (${o.id} ${o.version})`;
}

// ---------------------------------------------------------------------------
// Missing-type hints (shown in node error badges and the properties panel)
// ---------------------------------------------------------------------------

const hints = new Map<string, string>();
const projectHints = new Map<string, string>();
export const setTypeHint = (type: string, hint: string) => hints.set(type, hint);
export const clearTypeHint = (type: string) => hints.delete(type);
setMissingNodeHint((type) => hints.get(type) ?? projectHints.get(type));

// ---------------------------------------------------------------------------
// User library
// ---------------------------------------------------------------------------

interface StoredNode {
  id: string;
  def: SerializedNodeDef;
  updatedAt: number;
}

const library = new Map<string, SerializedNodeDef>();
export const listUserNodes = () => [...library.values()].sort((a, b) => a.name.localeCompare(b.name));
export const getUserNode = (id: string) => library.get(id);

/** Throws if `id` belongs to a built-in node or a plugin. */
export function assertCanDefine(id: string) {
  const existing = getNodeDef(id);
  if (!existing) return;
  const o = origins.get(id);
  if (!o) throw new Error(`"${id}" is a built-in node type; choose another id (e.g. user.${id.split('.').pop()})`);
  if (o.kind === 'plugin') throw new Error(`"${id}" belongs to plugin “${o.name}”; choose another id`);
}

/** Register (replacing) a user node type without saving it. Returns the runtime def. */
export function applyUserNode(s: SerializedNodeDef): NodeDef {
  const valid = validateSerializedNodeDef(s);
  assertCanDefine(valid.id);
  const def = deserializeNodeDef(valid);
  origins.set(def.id, { kind: 'user' });
  hints.delete(def.id);
  registerNode(def, { replace: true });
  return def;
}

/** Register and persist in the user library. */
export async function saveUserNode(s: SerializedNodeDef): Promise<NodeDef> {
  const def = applyUserNode(s);
  const stored = serializeNodeDef(def);
  library.set(def.id, stored);
  await dbPut<StoredNode>('nodes', { id: def.id, def: stored, updatedAt: Date.now() });
  return def;
}

export async function deleteUserNode(id: string) {
  library.delete(id);
  await dbDelete('nodes', id);
  if (origins.get(id)?.kind === 'user') {
    origins.delete(id);
    hints.set(id, 'this custom node type was deleted from your library');
    unregisterNode(id);
  }
}

/** Load the library at startup (after built-ins). Returns problems for the status bar. */
export async function loadUserLibrary(): Promise<string[]> {
  const problems: string[] = [];
  let rows: StoredNode[] = [];
  try {
    rows = await dbGetAll<StoredNode>('nodes');
  } catch (e) {
    return [`Could not read custom node library: ${(e as Error).message}`];
  }
  for (const r of rows) {
    try {
      const def = applyUserNode(r.def);
      library.set(def.id, serializeNodeDef(def));
    } catch (e) {
      problems.push(`Custom node ${r.id}: ${(e as Error).message}`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Project embedding
// ---------------------------------------------------------------------------

/** All node types used in a graph, including inside groups. */
export function collectTypes(g: Graph, out = new Set<string>()): Set<string> {
  for (const n of g.nodes) {
    if (n.type === GROUP && n.group) collectTypes(n.group.graph, out);
    else out.add(n.type);
  }
  return out;
}

/** Copy of `p` with `customNodes` / `plugins` describing the non-built-in types it uses. */
export function embedCustomNodes(p: Project): Project {
  const customNodes: SerializedNodeDef[] = [];
  const refs = new Map<string, ProjectPluginRef>();
  for (const t of collectTypes(p.graph)) {
    const o = origins.get(t);
    const def = getNodeDef(t);
    if (!o || !def) {
      // keep embedded defs of types that are currently missing, so a round trip doesn't lose them
      const prev = p.customNodes?.find((c) => c.id === t);
      if (!def && prev) customNodes.push(prev);
      const ref = p.plugins?.find((r) => r.nodes.includes(t));
      if (!def && ref) refs.set(ref.id, { ...ref, nodes: [...new Set([...(refs.get(ref.id)?.nodes ?? []), t])] });
      continue;
    }
    if (isSerializable(def)) customNodes.push(serializeNodeDef(def));
    if (o.kind === 'plugin') {
      const r = refs.get(o.id) ?? { id: o.id, name: o.name, version: o.version, nodes: [] };
      if (o.url) r.url = o.url;
      r.nodes.push(t);
      refs.set(o.id, r);
    }
  }
  const out: Project = { ...p };
  delete out.customNodes;
  delete out.plugins;
  if (customNodes.length) out.customNodes = customNodes;
  if (refs.size) out.plugins = [...refs.values()];
  return out;
}

/**
 * Register node types embedded in a project that aren't installed here.
 * Installed types win (a project never silently replaces your library or a plugin).
 */
export function registerProjectNodes(p: Project): { registered: string[]; differing: string[]; problems: string[] } {
  const registered: string[] = [];
  const differing: string[] = [];
  const problems: string[] = [];
  projectHints.clear();
  for (const raw of p.customNodes ?? []) {
    try {
      const s = validateSerializedNodeDef(raw);
      const existing = getNodeDef(s.id);
      if (existing) {
        if (isSerializable(existing) && !sameSerialized(serializeNodeDef(existing), s)) differing.push(s.id);
        continue;
      }
      const def = deserializeNodeDef(s);
      origins.set(def.id, { kind: 'project' });
      registerNode(def);
      registered.push(def.id);
    } catch (e) {
      problems.push((e as Error).message);
    }
  }
  for (const ref of p.plugins ?? []) {
    for (const t of ref.nodes ?? []) {
      projectHints.set(
        t,
        `provided by plugin “${ref.name ?? ref.id}” (${ref.id}${ref.version ? ' ' + ref.version : ''}), which is not installed${ref.url ? ` — install it from ${ref.url}` : ''} via Edit › Plugins…`,
      );
    }
  }
  return { registered, differing, problems };
}
