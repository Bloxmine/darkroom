import type { Project } from '../core/types';
import { useDoc } from './doc';

/** Debounced autosave of the project to IndexedDB, restored on startup. */
const DB = 'darkroom';
const STORE = 'autosave';
const KEY = 'current';

function openDb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

interface Saved {
  project: Project;
  viewed: string | null;
  dirty: boolean;
  savedAt: number;
}

export async function loadAutosave(): Promise<Saved | null> {
  try {
    const db = await openDb();
    return await new Promise((res, rej) => {
      const r = db.transaction(STORE).objectStore(STORE).get(KEY);
      r.onsuccess = () => res((r.result as Saved) ?? null);
      r.onerror = () => rej(r.error);
    });
  } catch (e) {
    console.warn('[darkroom] autosave unavailable', e);
    return null;
  }
}

export async function writeAutosave(): Promise<void> {
  const s = useDoc.getState();
  const data: Saved = { project: s.project, viewed: s.viewed, dirty: s.dirty, savedAt: Date.now() };
  const db = await openDb();
  await new Promise<void>((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(data, KEY);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

export async function clearAutosave() {
  const db = await openDb();
  await new Promise<void>((res) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(KEY);
    tx.oncomplete = () => res();
    tx.onerror = () => res();
  });
}

let timer = 0;
let enabled = false;
export function startAutosave() {
  if (enabled) return;
  enabled = true;
  useDoc.subscribe((s, p) => {
    if (s.project === p.project && s.viewed === p.viewed) return;
    clearTimeout(timer);
    timer = window.setTimeout(() => void writeAutosave().catch((e) => console.warn('[darkroom] autosave failed', e)), 800);
  });
}
