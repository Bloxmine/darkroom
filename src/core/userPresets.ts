/**
 * User presets ("My Presets"): groups saved from the graph editor, persisted in IndexedDB
 * (same pattern as pluginDb.ts / customNodes.ts, in a database of their own so neither needs a
 * schema upgrade) and registered with registerPreset so they show up in the Node Library and
 * the add-node search. Projects never reference them: an added preset is a plain group node.
 */
import { clone } from './graph';
import { getPreset, registerPreset, unregisterPreset } from './registry';
import type { GroupData, PresetDef } from './types';

export const USER_PRESET_PREFIX = 'user.preset.';
export const PRESET_FILE_EXT = '.drpreset.json';
const DB = 'darkroom-presets';
const STORE = 'presets';

export interface UserPreset {
  id: string;
  name: string;
  category: string;
  description?: string;
  tags?: string[];
  group: GroupData;
  /** PNG data URL captured from the group's output when it was saved. */
  thumb?: string;
  updatedAt: number;
}

export interface PresetFile {
  darkroom: 'preset';
  version: 1;
  preset: Omit<UserPreset, 'updatedAt'>;
}

const memory = new Map<string, UserPreset>();
let dbp: Promise<IDBDatabase | null> | null = null;
const presets = new Map<string, UserPreset>();
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());

export const isUserPreset = (id: string) => id.startsWith(USER_PRESET_PREFIX);
export const getUserPreset = (id: string) => presets.get(id);
export const listUserPresets = () => [...presets.values()].sort((a, b) => a.name.localeCompare(b.name));
export function subscribeUserPresets(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

function open(): Promise<IDBDatabase | null> {
  if (dbp) return dbp;
  dbp = new Promise((res) => {
    if (typeof indexedDB === 'undefined') return res(null);
    try {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
      r.onsuccess = () => res(r.result);
      r.onerror = () => {
        console.warn('[darkroom] preset storage unavailable', r.error);
        res(null);
      };
    } catch (e) {
      console.warn('[darkroom] preset storage unavailable', e);
      res(null);
    }
  });
  return dbp;
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest | void, mem: () => T): Promise<T> {
  const db = await open();
  if (!db) return mem();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, mode);
    const r = fn(t.objectStore(STORE));
    t.oncomplete = () => res((r ? r.result : undefined) as T);
    t.onerror = () => rej(t.error);
  });
}

const toDef = (p: UserPreset): PresetDef => ({ id: p.id, name: p.name, category: p.category, description: p.description, tags: p.tags, group: p.group });

function apply(p: UserPreset) {
  presets.set(p.id, p);
  registerPreset(toDef(p), { replace: true });
  changed();
}

/** Check the shape of a stored / imported preset. Throws with a readable message. */
export function validatePreset(x: unknown): Omit<UserPreset, 'updatedAt'> & { updatedAt?: number } {
  const p = x as UserPreset;
  if (!p || typeof p !== 'object') throw new Error('not a preset');
  if (typeof p.name !== 'string' || !p.name.trim()) throw new Error('the preset has no name');
  const g = p.group;
  if (!g || typeof g !== 'object' || !g.graph || !Array.isArray(g.graph.nodes) || !Array.isArray(g.graph.edges)) throw new Error('the preset has no node group');
  return {
    id: typeof p.id === 'string' && isUserPreset(p.id) ? p.id : newPresetId(p.name),
    name: p.name.trim().slice(0, 80),
    category: typeof p.category === 'string' && p.category.trim() ? p.category.trim().slice(0, 60) : 'My Presets',
    description: typeof p.description === 'string' ? p.description.slice(0, 500) : undefined,
    tags: Array.isArray(p.tags) ? p.tags.filter((t) => typeof t === 'string') : undefined,
    group: { name: typeof g.name === 'string' ? g.name : p.name, graph: g.graph, exposed: Array.isArray(g.exposed) ? g.exposed : [] },
    thumb: typeof p.thumb === 'string' && p.thumb.startsWith('data:image/') ? p.thumb : undefined,
    updatedAt: p.updatedAt,
  };
}

export function newPresetId(name: string) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'preset';
  let id = USER_PRESET_PREFIX + slug;
  for (let i = 2; presets.has(id) || getPreset(id); i++) id = `${USER_PRESET_PREFIX}${slug}-${i}`;
  return id;
}

/** Save (create or replace) a user preset and register it. */
export async function saveUserPreset(p: Omit<UserPreset, 'updatedAt'>): Promise<UserPreset> {
  const v = validatePreset(p);
  const stored: UserPreset = { ...v, group: clone({ ...v.group, name: v.name }), updatedAt: Date.now() };
  await tx(
    'readwrite',
    (s) => void s.put(stored),
    () => void memory.set(stored.id, clone(stored)),
  );
  apply(stored);
  return stored;
}

export async function renameUserPreset(id: string, name: string) {
  const p = presets.get(id);
  if (!p || !name.trim()) return;
  await saveUserPreset({ ...p, name: name.trim() });
}

export async function deleteUserPreset(id: string) {
  await tx(
    'readwrite',
    (s) => void s.delete(id),
    () => void memory.delete(id),
  );
  presets.delete(id);
  unregisterPreset(id);
  changed();
}

/** Load and register the saved presets (call once at startup). */
export async function loadUserPresets(): Promise<string[]> {
  const problems: string[] = [];
  let rows: UserPreset[] = [];
  try {
    rows = await tx<UserPreset[]>(
      'readonly',
      (s) => s.getAll(),
      () => [...memory.values()],
    );
  } catch (e) {
    return [`Could not read saved presets: ${(e as Error).message}`];
  }
  for (const r of rows ?? []) {
    try {
      const v = validatePreset(r);
      apply({ ...v, id: r.id, updatedAt: r.updatedAt ?? 0 });
    } catch (e) {
      problems.push(`Preset ${r?.id}: ${(e as Error).message}`);
    }
  }
  return problems;
}

export function presetToFile(id: string): string {
  const p = presets.get(id);
  if (!p) throw new Error(`No preset ${id}`);
  const { updatedAt: _u, ...rest } = p;
  void _u;
  const f: PresetFile = { darkroom: 'preset', version: 1, preset: rest };
  return JSON.stringify(f, null, 2);
}

/** Parse a `.drpreset.json` file. Imports never overwrite: a clashing id gets a fresh one. */
export function parsePresetFile(text: string): Omit<UserPreset, 'updatedAt'> {
  const j = JSON.parse(text) as PresetFile;
  if (j?.darkroom !== 'preset' || !j.preset) throw new Error('not a Darkroom preset file');
  const v = validatePreset(j.preset);
  if (presets.has(v.id)) v.id = newPresetId(v.name);
  return v;
}
