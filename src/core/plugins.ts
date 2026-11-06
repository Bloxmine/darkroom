import { assetFromUrl } from './assets';
import { clearNodeOrigin, clearTypeHint, describeOrigin, getNodeOrigin, setNodeOrigin, setTypeHint } from './customNodes';
import { defaultParams, GraphBuilder, GROUP } from './graph';
import { GLSL_LIB } from './glsl';
import { parseParams } from './glslParams';
import { dbDelete, dbGetAll, dbPut } from './pluginDb';
import {
  defineNode,
  definePreset,
  getNodeDef,
  getPreset,
  registerNodes,
  registerPlugin,
  unregisterNode,
  unregisterPlugin,
  unregisterPreset,
} from './registry';
import { deserializeNodeDef, validateSerializedNodeDef } from './serialize';
import type { Asset, Graph, GroupData, NodeDef, PluginDef, PresetDef, SerializedNodeDef } from './types';

/**
 * Plugins, two tiers:
 *  - data plugins (`.drplugin.json`): JSON nodes (string GLSL) + presets. Safe, no prompt.
 *  - code plugins (`.js` ES module): `export default` a PluginDef or `(api) => PluginDef | Promise<PluginDef>`.
 *    Arbitrary JS — installed only after the user trusts the named source.
 * Installed plugins (source text, enabled/trusted flags, URL) live in IndexedDB and are re-loaded at startup.
 */

export const APP_VERSION = '0.5.0';
export const PLUGIN_API_VERSION = 1;
export const PLUGIN_FILE_FORMAT = 'darkroom-plugin';
export const PLUGIN_FILE_EXT = '.drplugin.json';

export type PluginTier = 'data' | 'code';

/** What is stored in IndexedDB for each installed plugin. */
export interface InstalledPlugin {
  id: string;
  name: string;
  version: string;
  author?: string;
  description?: string;
  tier: PluginTier;
  /** JSON text (data) or JS module source (code). */
  source: string;
  /** Where it was installed from (URL), if any. */
  url?: string;
  fileName?: string;
  enabled: boolean;
  /** Code plugins: the user accepted the trust prompt for this source. */
  trusted: boolean;
  installedAt: number;
  /** Ids provided at last successful load (for "missing plugin" messages while disabled). */
  nodeIds?: string[];
  presetIds?: string[];
}

export interface PluginState {
  record: InstalledPlugin;
  status: 'loaded' | 'disabled' | 'error';
  error?: string;
  /** Non-fatal problems, e.g. a node skipped because its id is taken. */
  warnings: string[];
  nodes: string[];
  presets: string[];
}

/** JSON format of a data plugin. */
export interface DataPluginFile {
  format?: typeof PLUGIN_FILE_FORMAT;
  id: string;
  name: string;
  version: string;
  author?: string;
  description?: string;
  nodes?: SerializedNodeDef[];
  presets?: PresetDef[];
}

/** Passed to a code plugin's default-export function. */
export interface PluginApi {
  /** Darkroom version, e.g. '0.5.0'. */
  version: string;
  /** Plugin API version (integer, bumped on breaking changes). */
  apiVersion: number;
  defineNode: typeof defineNode;
  definePreset: typeof definePreset;
  GraphBuilder: typeof GraphBuilder;
  GLSL_LIB: string;
  /** Build a NodeDef from the JSON form (string GLSL with @param annotations allowed). */
  nodeFromJSON: (s: SerializedNodeDef) => NodeDef;
  /** Parse `@param` annotations in GLSL into ParamDefs. */
  parseParams: (glsl: string) => NodeDef['params'];
  /** Fetch an image/text file (URL relative to the plugin's source URL) and register it with the engine. */
  loadAsset: (url: string, id?: string) => Promise<Asset>;
  /** URL the plugin was installed from, if any. */
  sourceUrl?: string;
}

export class PluginConflictError extends Error {
  constructor(
    public existing: InstalledPlugin,
    public incoming: { id: string; name: string; version: string },
  ) {
    const cmp = compareVersions(incoming.version, existing.version);
    const what = cmp > 0 ? `Upgrade ${existing.version} → ${incoming.version}?` : cmp < 0 ? `This is an OLDER version (${incoming.version} < ${existing.version}). Downgrade?` : `Version ${existing.version} is already installed. Reinstall?`;
    super(`Plugin “${existing.name}” (${existing.id}) is already installed. ${what}`);
  }
}

export class TrustRequiredError extends Error {
  constructor(public sourceName: string) {
    super(`Code plugin from ${sourceName} must be trusted before it can run.`);
  }
}

// ---------------------------------------------------------------------------
// state + change notifications (for the Plugin Manager UI)
// ---------------------------------------------------------------------------

const states = new Map<string, PluginState>();
const presetOwner = new Map<string, string>();
const listeners = new Set<() => void>();
let ver = 0;
const notify = () => {
  ver++;
  listeners.forEach((l) => l());
};
export const subscribePlugins = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};
export const pluginsVersion = () => ver;
export const listInstalledPlugins = () => [...states.values()].sort((a, b) => a.record.name.localeCompare(b.record.name));
export const getPluginState = (id: string) => states.get(id);

let assetSink: (a: Asset) => void = () => {};
/** The app routes plugin assets into the engine. */
export function setPluginAssetSink(fn: (a: Asset) => void) {
  assetSink = fn;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? +x : x));
  const pb = b.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? +x : x));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const PLUGIN_ID = /^[A-Za-z][\w-]*(\.[\w-]+)*$/;

function checkMeta(x: Record<string, unknown>) {
  if (typeof x.id !== 'string' || !PLUGIN_ID.test(x.id)) throw new Error(`invalid plugin id ${JSON.stringify(x.id)}`);
  if (typeof x.name !== 'string' || !x.name.trim()) throw new Error('plugin name is required');
  if (typeof x.version !== 'string' || !x.version.trim()) throw new Error('plugin version is required (e.g. "1.0.0")');
}

function validateGraph(g: unknown, where: string): Graph {
  if (!isObj(g) || !Array.isArray(g.nodes) || !Array.isArray(g.edges)) throw new Error(`${where}: graph needs nodes[] and edges[]`);
  for (const n of g.nodes) {
    if (!isObj(n) || typeof n.id !== 'string' || typeof n.type !== 'string') throw new Error(`${where}: every node needs id and type`);
    if (!isObj(n.params)) n.params = {};
    if (!isObj(n.position)) n.position = { x: 0, y: 0 };
    if (n.type === GROUP) validateGroup(n.group, `${where}/${n.id}`);
  }
  for (const e of g.edges) {
    if (!isObj(e) || !isObj(e.from) || !isObj(e.to)) throw new Error(`${where}: malformed edge`);
  }
  return g as unknown as Graph;
}

function validateGroup(x: unknown, where: string): GroupData {
  if (!isObj(x)) throw new Error(`${where}: group is required`);
  validateGraph(x.graph, where);
  if (!Array.isArray(x.exposed)) x.exposed = [];
  if (typeof x.name !== 'string') x.name = 'Group';
  return x as unknown as GroupData;
}

export function validatePresetDef(x: unknown): PresetDef {
  if (!isObj(x)) throw new Error('preset must be an object');
  if (typeof x.id !== 'string' || !x.id.includes('.')) throw new Error(`invalid preset id ${JSON.stringify(x.id)}`);
  if (typeof x.name !== 'string' || typeof x.category !== 'string') throw new Error(`${x.id}: name and category are required`);
  validateGroup(x.group, x.id);
  return x as unknown as PresetDef;
}

function validateRuntimeNode(x: unknown): NodeDef {
  if (!isObj(x)) throw new Error('node must be an object');
  const id = x.id;
  if (typeof id !== 'string' || !/^[A-Za-z][\w-]*(\.[\w-]+)+$/.test(id)) throw new Error(`invalid node id ${JSON.stringify(id)}`);
  if (typeof x.name !== 'string' || typeof x.category !== 'string') throw new Error(`${id}: name and category are required`);
  if (!isObj(x.inputs) || !isObj(x.params)) throw new Error(`${id}: inputs and params must be objects`);
  if (!Array.isArray(x.passes) && typeof x.cpu !== 'function') throw new Error(`${id}: needs passes[] or cpu()`);
  if (Array.isArray(x.passes)) x.passes.forEach((p, i) => {
    if (!isObj(p) || (typeof p.frag !== 'string' && typeof p.frag !== 'function')) throw new Error(`${id}: pass ${i} needs a frag`);
  });
  return x as unknown as NodeDef;
}

/** Fill inner nodes' missing params with defaults (presets built before their nodes were registered). */
function fillDefaults(g: Graph) {
  for (const n of g.nodes) {
    if (n.type === GROUP && n.group) fillDefaults(n.group.graph);
    else n.params = { ...defaultParams(n.type), ...n.params };
  }
}

/** Is this text a data plugin (JSON) rather than a JS module? */
export function detectTier(text: string): PluginTier {
  return /^\s*[{[]/.test(text) ? 'data' : 'code';
}

/** Parse and validate a data plugin file. */
export function parseDataPlugin(text: string): { meta: DataPluginFile; nodes: NodeDef[]; presets: PresetDef[] } {
  let x: unknown;
  try {
    x = JSON.parse(text);
  } catch (e) {
    throw new Error(`not valid JSON (${(e as Error).message})`);
  }
  if (!isObj(x)) throw new Error('plugin file must be a JSON object');
  if (x.format !== undefined && x.format !== PLUGIN_FILE_FORMAT) throw new Error(`unknown format "${String(x.format)}"`);
  checkMeta(x);
  if (x.nodes !== undefined && !Array.isArray(x.nodes)) throw new Error('nodes must be an array');
  if (x.presets !== undefined && !Array.isArray(x.presets)) throw new Error('presets must be an array');
  const nodes = ((x.nodes as unknown[]) ?? []).map((n) => deserializeNodeDef(validateSerializedNodeDef(n)));
  const presets = ((x.presets as unknown[]) ?? []).map(validatePresetDef);
  return { meta: x as unknown as DataPluginFile, nodes, presets };
}

export function makeApi(sourceUrl?: string): PluginApi {
  return {
    version: APP_VERSION,
    apiVersion: PLUGIN_API_VERSION,
    defineNode,
    definePreset,
    GraphBuilder,
    GLSL_LIB,
    nodeFromJSON: (s) => deserializeNodeDef(s),
    parseParams: (glsl) => parseParams([glsl]).params,
    sourceUrl,
    loadAsset: async (url, id) => {
      const base = sourceUrl && /^(https?|blob):/.test(sourceUrl) ? sourceUrl : location.href;
      const a = await assetFromUrl(new URL(url, base).href, id);
      assetSink(a);
      return a;
    },
  };
}

/** Execute a code plugin's source and return its (validated) PluginDef. */
export async function evaluateCodePlugin(source: string, sourceUrl?: string): Promise<PluginDef & { presets?: PresetDef[] | (() => PresetDef[]) }> {
  const blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  let mod: { default?: unknown };
  try {
    mod = await import(/* @vite-ignore */ blobUrl);
  } catch (e) {
    throw new Error(`module failed to load: ${(e as Error).message}`);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
  let def = mod.default;
  if (typeof def === 'function') def = await (def as (api: PluginApi) => unknown)(makeApi(sourceUrl));
  if (!isObj(def)) throw new Error('the module must `export default` a PluginDef or a function returning one');
  checkMeta(def);
  if (def.nodes !== undefined && !Array.isArray(def.nodes)) throw new Error('nodes must be an array');
  if (def.presets !== undefined && !Array.isArray(def.presets) && typeof def.presets !== 'function') throw new Error('presets must be an array or a function returning one');
  return def as unknown as PluginDef;
}

// ---------------------------------------------------------------------------
// activation
// ---------------------------------------------------------------------------

type Loaded = { meta: { id: string; name: string; version: string; author?: string; description?: string }; nodes: NodeDef[]; presets: PresetDef[] | (() => PresetDef[]) };

async function loadRecord(r: InstalledPlugin): Promise<Loaded> {
  if (r.tier === 'data') {
    const d = parseDataPlugin(r.source);
    return { meta: d.meta, nodes: d.nodes, presets: d.presets };
  }
  if (!r.trusted) throw new TrustRequiredError(r.url ?? r.fileName ?? r.id);
  const def = await evaluateCodePlugin(r.source, r.url);
  return { meta: def, nodes: def.nodes ?? [], presets: (def.presets as PresetDef[] | (() => PresetDef[])) ?? [] };
}

function register(r: InstalledPlugin, l: Loaded): PluginState {
  if (l.meta.id !== r.id) throw new Error(`plugin id changed from ${r.id} to ${l.meta.id}`);
  const warnings: string[] = [];
  const okNodes: NodeDef[] = [];
  for (const raw of l.nodes) {
    let n: NodeDef;
    try {
      n = validateRuntimeNode(raw);
    } catch (e) {
      warnings.push(`node skipped: ${(e as Error).message}`);
      continue;
    }
    const o = getNodeOrigin(n.id);
    const mine = o?.kind === 'plugin' && o.id === r.id;
    if (getNodeDef(n.id) && !mine && o?.kind !== 'project') {
      warnings.push(`node ${n.id} skipped: id already used by ${describeOrigin(n.id)}`);
      continue;
    }
    setNodeOrigin(n.id, { kind: 'plugin', id: r.id, name: r.name, version: r.version, url: r.url });
    clearTypeHint(n.id);
    okNodes.push(n);
  }
  // register nodes first so presets can read their defaults
  registerNodes(okNodes, { replace: true });
  let presetList: PresetDef[] = [];
  try {
    presetList = typeof l.presets === 'function' ? l.presets() : l.presets;
    if (!Array.isArray(presetList)) throw new Error('presets() must return an array');
  } catch (e) {
    warnings.push(`presets failed: ${(e as Error).message}`);
    presetList = [];
  }
  const okPresets: PresetDef[] = [];
  for (const raw of presetList) {
    try {
      const p = validatePresetDef(raw);
      if (getPreset(p.id) && presetOwner.get(p.id) !== r.id) {
        warnings.push(`preset ${p.id} skipped: id already used`);
        continue;
      }
      fillDefaults(p.group.graph);
      presetOwner.set(p.id, r.id);
      okPresets.push(p);
    } catch (e) {
      warnings.push(`preset skipped: ${(e as Error).message}`);
    }
  }
  registerPlugin({ id: r.id, name: r.name, version: r.version, author: r.author, description: r.description, nodes: okNodes, presets: okPresets });
  const st: PluginState = { record: r, status: 'loaded', warnings, nodes: okNodes.map((n) => n.id), presets: okPresets.map((p) => p.id) };
  r.nodeIds = st.nodes;
  r.presetIds = st.presets;
  return st;
}

function hintFor(r: InstalledPlugin, why: string) {
  for (const id of r.nodeIds ?? []) if (!getNodeDef(id)) setTypeHint(id, `provided by plugin “${r.name}” (${r.id}), which is ${why} — see Edit › Plugins…`);
}

function deactivate(id: string, why = 'disabled') {
  const st = states.get(id);
  if (!st) return;
  for (const n of st.nodes) {
    const o = getNodeOrigin(n);
    if (o?.kind === 'plugin' && o.id === id) {
      clearNodeOrigin(n);
      unregisterNode(n);
    }
  }
  for (const p of st.presets) {
    if (presetOwner.get(p) === id) {
      presetOwner.delete(p);
      unregisterPreset(p);
    }
  }
  unregisterPlugin(id);
  hintFor(st.record, why);
  st.nodes = [];
  st.presets = [];
}

async function activate(r: InstalledPlugin, preloaded?: Loaded): Promise<PluginState> {
  let st: PluginState;
  try {
    st = register(r, preloaded ?? (await loadRecord(r)));
  } catch (e) {
    st = { record: r, status: 'error', error: (e as Error).message, warnings: [], nodes: [], presets: [] };
    hintFor(r, 'failing to load');
    console.warn(`[darkroom] plugin ${r.id} failed:`, e);
  }
  states.set(r.id, st);
  notify();
  return st;
}

const persist = (r: InstalledPlugin) => dbPut('plugins', r).catch((e) => console.warn('[darkroom] could not save plugin', e));

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/** Re-load installed plugins at startup (enabled ones are activated). Never throws. */
export async function loadInstalledPlugins(): Promise<string[]> {
  let rows: InstalledPlugin[] = [];
  try {
    rows = await dbGetAll<InstalledPlugin>('plugins');
  } catch (e) {
    return [`Could not read installed plugins: ${(e as Error).message}`];
  }
  const problems: string[] = [];
  for (const r of rows) {
    if (!r.enabled) {
      states.set(r.id, { record: r, status: 'disabled', warnings: [], nodes: [], presets: [] });
      hintFor(r, 'disabled');
      continue;
    }
    const st = await activate(r);
    if (st.status === 'error') problems.push(`Plugin ${r.name}: ${st.error}`);
  }
  notify();
  return problems;
}

/** Host policy (set from Preferences › Plugins & AI by src/ui/prefs/runtime.ts). */
export const pluginPolicy = { allowCode: () => true };

export interface InstallOptions {
  source: string;
  url?: string;
  fileName?: string;
  /** Required for code plugins: the user accepted the trust prompt. */
  trusted?: boolean;
  /** Replace an installed plugin with the same id (after a conflict prompt). */
  replace?: boolean;
}

/** Install (or with `replace`, upgrade) a plugin. Throws TrustRequiredError / PluginConflictError / Error. */
export async function installPlugin(o: InstallOptions): Promise<PluginState> {
  const tier = detectTier(o.source);
  const sourceName = o.url ?? o.fileName ?? 'pasted source';
  let loaded: Loaded;
  if (tier === 'data') {
    const d = parseDataPlugin(o.source);
    loaded = { meta: d.meta, nodes: d.nodes, presets: d.presets };
  } else {
    if (!pluginPolicy.allowCode()) throw new Error('Code plugins are turned off. Enable “Allow code plugins” in Preferences › Plugins & AI to install JavaScript plugins.');
    if (!o.trusted) throw new TrustRequiredError(sourceName);
    const def = await evaluateCodePlugin(o.source, o.url);
    loaded = { meta: def, nodes: def.nodes ?? [], presets: (def.presets as PresetDef[] | (() => PresetDef[])) ?? [] };
  }
  const { id, name, version, author, description } = loaded.meta;
  const existing = states.get(id);
  if (existing && !o.replace) throw new PluginConflictError(existing.record, { id, name, version });
  if (existing) deactivate(id, 'being replaced');
  const r: InstalledPlugin = {
    id,
    name,
    version,
    author,
    description,
    tier,
    source: o.source,
    url: o.url,
    fileName: o.fileName,
    enabled: true,
    trusted: tier === 'code',
    installedAt: Date.now(),
  };
  const st = await activate(r, loaded);
  await persist(r);
  return st;
}

/** Fetch plugin source text from a URL (relative URLs resolve against the app). */
export async function fetchPluginSource(url: string): Promise<{ source: string; url: string }> {
  const abs = new URL(url, location.href).href;
  const res = await fetch(abs);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${abs}`);
  return { source: await res.text(), url: abs };
}

export async function setPluginEnabled(id: string, enabled: boolean): Promise<PluginState | undefined> {
  const st = states.get(id);
  if (!st) return;
  const r = { ...st.record, enabled };
  if (!enabled) {
    deactivate(id, 'disabled');
    states.set(id, { record: r, status: 'disabled', warnings: [], nodes: [], presets: [] });
    notify();
  } else {
    await activate(r);
  }
  await persist(r);
  return states.get(id);
}

export async function uninstallPlugin(id: string) {
  const st = states.get(id);
  if (!st) return;
  deactivate(id, 'not installed');
  for (const n of st.record.nodeIds ?? []) setTypeHint(n, `provided by plugin “${st.record.name}” (${id}), which was uninstalled`);
  states.delete(id);
  notify();
  await dbDelete('plugins', id).catch((e) => console.warn('[darkroom] could not remove plugin', e));
}

/** A plugin source that has been fetched/read but not yet trusted (for the trust prompt). */
export interface PendingInstall {
  source: string;
  url?: string;
  fileName?: string;
  tier: PluginTier;
  /** Peeked metadata of data plugins. */
  name?: string;
}
