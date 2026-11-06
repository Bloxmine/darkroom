/**
 * IndexedDB storage for extensions: installed plugins and the user's custom
 * node library. A separate database from the project autosave, so neither
 * needs to coordinate schema upgrades. Falls back to memory when IndexedDB is
 * unavailable (tests, private windows).
 */
const DB = 'darkroom-extensions';
export type StoreName = 'plugins' | 'nodes';

const memory: Record<StoreName, Map<string, unknown>> = { plugins: new Map(), nodes: new Map() };
let dbp: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (dbp) return dbp;
  dbp = new Promise((res) => {
    if (typeof indexedDB === 'undefined') return res(null);
    try {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore('plugins', { keyPath: 'id' });
        r.result.createObjectStore('nodes', { keyPath: 'id' });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => {
        console.warn('[darkroom] extension storage unavailable', r.error);
        res(null);
      };
    } catch (e) {
      console.warn('[darkroom] extension storage unavailable', e);
      res(null);
    }
  });
  return dbp;
}

export async function dbGetAll<T>(store: StoreName): Promise<T[]> {
  const db = await open();
  if (!db) return [...memory[store].values()] as T[];
  return new Promise((res, rej) => {
    const r = db.transaction(store).objectStore(store).getAll();
    r.onsuccess = () => res(r.result as T[]);
    r.onerror = () => rej(r.error);
  });
}

export async function dbPut<T extends { id: string }>(store: StoreName, value: T): Promise<void> {
  const db = await open();
  if (!db) {
    memory[store].set(value.id, structuredClone(value));
    return;
  }
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

export async function dbDelete(store: StoreName, id: string): Promise<void> {
  const db = await open();
  if (!db) {
    memory[store].delete(id);
    return;
  }
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(id);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
