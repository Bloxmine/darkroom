import type { RawMeta } from '../types';

/**
 * IndexedDB store for original RAW file bytes, keyed by asset id. RAW files are
 * 20–60 MB, so the project (and its autosave) only holds an `idb:raw/<id>`
 * reference; `.darkroom` files embed the bytes as a data URL on save.
 * A separate database keeps this independent of the autosave DB's schema.
 */
const DB = 'darkroom-raw';
const STORE = 'files';

export interface RawRecord {
  id: string;
  name: string;
  mime: string;
  bytes: Uint8Array;
  meta?: RawMeta;
  savedAt: number;
}

let dbp: Promise<IDBDatabase> | null = null;
function openDb(): Promise<IDBDatabase> {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => {
      dbp = null;
      rej(r.error);
    };
  });
  return dbp;
}

const req = <T>(r: IDBRequest<T>) => new Promise<T>((res, rej) => ((r.onsuccess = () => res(r.result)), (r.onerror = () => rej(r.error))));

export async function putRawRecord(rec: RawRecord): Promise<void> {
  const db = await openDb();
  await new Promise<void>((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(rec);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error ?? new Error('IndexedDB write aborted (storage full?)'));
  });
}

export async function getRawRecord(id: string): Promise<RawRecord | undefined> {
  const db = await openDb();
  return req(db.transaction(STORE).objectStore(STORE).get(id) as IDBRequest<RawRecord | undefined>);
}

/** Delete stored RAWs not in `keep` (and older than `minAgeMs`, so a just-imported file is never dropped). */
export async function gcRawRecords(keep: Set<string>, minAgeMs = 60_000): Promise<number> {
  const db = await openDb();
  const keys = (await req(db.transaction(STORE).objectStore(STORE).getAllKeys())) as string[];
  let n = 0;
  for (const k of keys) {
    if (keep.has(k)) continue;
    const rec = await getRawRecord(k);
    if (rec && Date.now() - rec.savedAt < minAgeMs) continue;
    await new Promise<void>((res) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(k);
      tx.oncomplete = () => res();
      tx.onerror = () => res();
    });
    n++;
  }
  return n;
}
