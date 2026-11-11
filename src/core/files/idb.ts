/** IndexedDB for the web file browser: remembered directory handles, the thumbnail cache, and sidecars that couldn't be written to disk. */
const DB = 'darkroom-browser';
export type Store = 'roots' | 'thumbs' | 'sidecars';

let dbp: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IndexedDB unavailable'));
  dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      for (const s of ['roots', 'thumbs', 'sidecars']) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s);
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => {
      dbp = null;
      rej(r.error);
    };
  });
  return dbp;
}

const req = <T>(r: IDBRequest<T>) =>
  new Promise<T>((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });

export async function idbGet<T>(store: Store, key: string): Promise<T | undefined> {
  const d = await db();
  return req(d.transaction(store).objectStore(store).get(key)) as Promise<T | undefined>;
}
export async function idbPut(store: Store, key: string, value: unknown): Promise<void> {
  const d = await db();
  await req(d.transaction(store, 'readwrite').objectStore(store).put(value, key));
}
export async function idbDel(store: Store, key: string): Promise<void> {
  const d = await db();
  await req(d.transaction(store, 'readwrite').objectStore(store).delete(key));
}
export async function idbAll<T>(store: Store): Promise<{ key: string; value: T }[]> {
  const d = await db();
  const os = d.transaction(store).objectStore(store);
  const [keys, values] = await Promise.all([req(os.getAllKeys()), req(os.getAll())]);
  return keys.map((k, i) => ({ key: String(k), value: values[i] as T }));
}
/** Keep the thumbnail store bounded (drops the oldest half when over `max`). */
export async function idbTrimThumbs(max = 6000): Promise<void> {
  const d = await db();
  const os = d.transaction('thumbs', 'readwrite').objectStore('thumbs');
  const n = await req(os.count());
  if (n <= max) return;
  let drop = n - Math.floor(max / 2);
  await new Promise<void>((res) => {
    const c = os.openCursor();
    c.onsuccess = () => {
      const cur = c.result;
      if (!cur || drop-- <= 0) return res();
      cur.delete();
      cur.continue();
    };
    c.onerror = () => res();
  });
}
