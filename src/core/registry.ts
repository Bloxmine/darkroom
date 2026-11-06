import type { NodeDef, PluginDef, PresetDef } from './types';

const nodes = new Map<string, NodeDef>();
const presets = new Map<string, PresetDef>();
const plugins = new Map<string, PluginDef>();
const listeners = new Set<() => void>();
let version = 0;

function changed() {
  version++;
  listeners.forEach((l) => l());
}

/** Identity helper giving type inference for node definitions. */
export function defineNode(def: NodeDef): NodeDef {
  return def;
}

export function definePreset(def: PresetDef): PresetDef {
  return def;
}

export function registerNode(def: NodeDef, opts: { replace?: boolean } = {}) {
  if (nodes.has(def.id) && !opts.replace) {
    console.warn(`[darkroom] node "${def.id}" already registered; skipping`);
    return;
  }
  nodes.set(def.id, def);
  changed();
}

export function registerNodes(defs: NodeDef[], opts?: { replace?: boolean }) {
  defs.forEach((d) => registerNode(d, opts));
}

export function unregisterNode(id: string) {
  if (nodes.delete(id)) changed();
}

export function unregisterPreset(id: string) {
  if (presets.delete(id)) changed();
}

export function unregisterPlugin(id: string) {
  if (plugins.delete(id)) changed();
}

/** Optional hint provider (set by core/customNodes) naming the plugin a missing node type came from. */
let missingHint: (type: string) => string | undefined = () => undefined;
export function setMissingNodeHint(fn: (type: string) => string | undefined) {
  missingHint = fn;
}
/** Human-readable error for a node whose type is not registered. */
export function missingNodeMessage(type: string): string {
  const hint = missingHint(type);
  return hint ? `Unknown node type "${type}" — ${hint}` : `Unknown node type "${type}" (missing plugin?)`;
}

export function registerPreset(def: PresetDef, opts: { replace?: boolean } = {}) {
  if (presets.has(def.id) && !opts.replace) {
    console.warn(`[darkroom] preset "${def.id}" already registered; skipping`);
    return;
  }
  presets.set(def.id, def);
  changed();
}

export function registerPlugin(plugin: PluginDef) {
  plugins.set(plugin.id, plugin);
  plugin.nodes?.forEach((n) => registerNode(n, { replace: true }));
  plugin.presets?.forEach((p) => registerPreset(p, { replace: true }));
  changed();
}

export const getNodeDef = (id: string) => nodes.get(id);
export const listNodeDefs = () => [...nodes.values()];
export const getPreset = (id: string) => presets.get(id);
export const listPresets = () => [...presets.values()];
export const listPlugins = () => [...plugins.values()];
export const registryVersion = () => version;

export function subscribeRegistry(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
