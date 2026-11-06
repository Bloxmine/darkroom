/**
 * RAW assets: import (bytes → IndexedDB + metadata), restore from the
 * `idb:raw/<id>` reference, and embedding as data URLs for .darkroom files.
 */
import type { Asset, Project, RawMeta } from '../types';
import { readRawMeta } from './decoder';
import { orientedSize } from './develop';
import { RAW_IDB_PREFIX, isRawStoreRef, rawMimeFor } from './formats';
import { gcRawRecords, getRawRecord, putRawRecord } from './rawStore';

function rawAsset(id: string, name: string, mime: string, bytes: Uint8Array, meta: RawMeta, dataUrl: string): Asset {
  const [width, height] = orientedSize(meta.width, meta.height, meta.flip);
  return { id, name, mime, dataUrl, width, height, raw: { bytes, meta } };
}

/** Load a RAW File/Blob: reads metadata (throws a friendly error for unsupported files) and stores the bytes in IndexedDB. */
export async function loadRawAsset(file: Blob, name: string, id: string): Promise<Asset> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const meta = await readRawMeta(bytes);
  const mime = rawMimeFor(name, file.type);
  let dataUrl = RAW_IDB_PREFIX + id;
  try {
    await putRawRecord({ id, name, mime, bytes, meta, savedAt: Date.now() });
  } catch (e) {
    // no IndexedDB (private mode / quota): fall back to an embedded data URL
    console.warn('[darkroom] could not store RAW in IndexedDB, embedding it instead', e);
    dataUrl = await blobToDataUrl(new Blob([bytes as BlobPart], { type: mime }));
  }
  return rawAsset(id, name, mime, bytes, meta, dataUrl);
}

/** Restore a RAW asset from its `idb:raw/<id>` reference. */
export async function rawAssetFromStore(s: { id: string; name: string; mime: string; dataUrl: string }): Promise<Asset> {
  const rec = await getRawRecord(s.id);
  if (!rec) throw new Error(`The RAW file “${s.name}” is no longer in this browser’s storage — re-import it.`);
  const meta = rec.meta ?? (await readRawMeta(rec.bytes));
  return rawAsset(s.id, rec.name || s.name, rec.mime || s.mime, rec.bytes, meta, s.dataUrl);
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}

/** Synchronous base64 data URL (chunked, so 50 MB files don't blow the call stack). */
export function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH) as unknown as number[]);
  return `data:${mime};base64,${btoa(bin)}`;
}

/**
 * Replace `idb:raw/` references with embedded data URLs (for writing a .darkroom file).
 * `lookup` returns the in-memory asset (engine.assets). Returns the project and the embedded byte count.
 */
export function embedRawAssets(p: Project, lookup: (id: string) => Asset | undefined): { project: Project; rawBytes: number; missing: string[] } {
  let rawBytes = 0;
  const missing: string[] = [];
  let assets = p.assets;
  for (const [id, s] of Object.entries(p.assets ?? {})) {
    if (!isRawStoreRef(s.dataUrl)) continue;
    const a = lookup(id);
    if (!a?.raw) {
      missing.push(s.name);
      continue;
    }
    if (assets === p.assets) assets = { ...p.assets };
    assets[id] = { ...s, dataUrl: bytesToDataUrl(a.raw.bytes, s.mime) };
    rawBytes += a.raw.bytes.byteLength;
  }
  return { project: assets === p.assets ? p : { ...p, assets }, rawBytes, missing };
}

let gcTimer = 0;
/** Drop IndexedDB RAW files no longer referenced by the open project (shortly after a project load). */
export function scheduleRawGc(currentIds: () => string[], delay = 5000) {
  if (typeof indexedDB === 'undefined') return;
  clearTimeout(gcTimer);
  gcTimer = setTimeout(() => {
    void gcRawRecords(new Set(currentIds()))
      .then((n) => n && console.info(`[darkroom] removed ${n} unused RAW file(s) from browser storage`))
      .catch(() => {});
  }, delay) as unknown as number;
}

/** A RAW asset held in memory only (batch processing): no IndexedDB write. */
export async function loadRawAssetEphemeral(file: Blob, name: string, id: string): Promise<Asset> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const meta = await readRawMeta(bytes);
  return rawAsset(id, name, rawMimeFor(name, file.type), bytes, meta, RAW_IDB_PREFIX + id);
}
