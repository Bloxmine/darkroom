import { ALL_FORMATS, BlobSource, Input } from 'mediabunny';
import type { Asset, Project } from './types';

/**
 * Video assets. Video files can be large, so their bytes live in IndexedDB
 * ('darkroom-media' / 'videos', keyed by asset id) and the project references
 * them as `dataUrl: 'idb:video/<id>'` (cheap autosaves). When a project is saved
 * to a .darkroom file, videos up to VIDEO_EMBED_LIMIT are embedded as data URLs
 * (`embedVideoAssets`); bigger ones stay a reference and only open in this browser.
 */
export const VIDEO_EMBED_LIMIT = 50 * 1024 * 1024;
export const VIDEO_REF = 'idb:video/';

const DB = 'darkroom-media';
const STORE = 'videos';

export const isVideoMime = (mime: string) => mime.startsWith('video/');
export const isVideoFile = (f: { type?: string; name?: string }) =>
  isVideoMime(f.type ?? '') || /\.(mp4|m4v|mov|webm|mkv|ogv)$/i.test(f.name ?? '');

function guessVideoMime(name: string) {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return ({ mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', ogv: 'video/ogg' } as Record<string, string>)[ext] ?? 'video/mp4';
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

export async function putVideoBlob(id: string, blob: Blob): Promise<void> {
  const db = await openDb();
  await new Promise<void>((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(blob, id);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

export async function getVideoBlob(id: string): Promise<Blob | null> {
  const db = await openDb();
  return new Promise((res, rej) => {
    const r = db.transaction(STORE).objectStore(STORE).get(id);
    r.onsuccess = () => res((r.result as Blob) ?? null);
    r.onerror = () => rej(r.error);
  });
}

/** Read size, duration and frame rate. Throws if there is no decodable video track. */
export async function probeVideo(blob: Blob) {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('No video track found.');
    if (!(await track.canDecode())) throw new Error(`This browser cannot decode ${(await track.getCodec()) ?? 'this'} video.`);
    const stats = await track.computePacketStats(120).catch(() => null);
    const duration = await input.computeDuration();
    return {
      width: track.displayWidth,
      height: track.displayHeight,
      duration,
      fps: stats?.averagePacketRate ? Math.round(stats.averagePacketRate * 1000) / 1000 : 30,
      hasAudio: !!(await input.getPrimaryAudioTrack()),
    };
  } finally {
    input.dispose();
  }
}

const embedCache = new Map<string, string>();
const audioFlags = new Map<string, boolean>();

/** Does the (loaded) video asset have an audio track? */
export const videoHasAudio = (id: string) => audioFlags.get(id) ?? false;

const readAsDataUrl = (blob: Blob) =>
  new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });

/** Decode metadata, store the bytes in IndexedDB and build the Asset (dataUrl = idb reference). */
export async function loadVideoAsset(blob: Blob, name: string, id: string, store = true): Promise<Asset> {
  const mime = blob.type && isVideoMime(blob.type) ? blob.type : guessVideoMime(name);
  const meta = await probeVideo(blob);
  audioFlags.set(id, meta.hasAudio);
  if (store) await putVideoBlob(id, blob).catch((e) => console.warn('[darkroom] could not store video in IndexedDB', e));
  // prepare the embedded form for .darkroom files in the background
  if (blob.size <= VIDEO_EMBED_LIMIT && !embedCache.has(id)) void readAsDataUrl(new Blob([blob], { type: mime })).then((d) => embedCache.set(id, d));
  return { id, name, mime, dataUrl: VIDEO_REF + id, blob, width: meta.width, height: meta.height, duration: meta.duration, fps: meta.fps };
}

/** Restore a video asset from a project entry: an `idb:video/<id>` reference or an embedded data URL. */
export async function videoAssetFromSerial(s: { id: string; name: string; mime: string; dataUrl: string }): Promise<Asset> {
  if (s.dataUrl.startsWith(VIDEO_REF)) {
    const blob = await getVideoBlob(s.dataUrl.slice(VIDEO_REF.length));
    if (!blob) throw new Error(`Video "${s.name}" is not stored in this browser — re-import it.`);
    return loadVideoAsset(new Blob([blob], { type: s.mime }), s.name, s.id, false);
  }
  const blob = await (await fetch(s.dataUrl)).blob();
  embedCache.set(s.id, s.dataUrl);
  return loadVideoAsset(new Blob([blob], { type: s.mime }), s.name, s.id);
}

/** Replace video references with embedded data URLs where available (for saving .darkroom files). */
export function embedVideoAssets(p: Project): Project {
  let changed = false;
  const assets = { ...p.assets };
  for (const [k, a] of Object.entries(assets)) {
    if (!a.dataUrl.startsWith(VIDEO_REF)) continue;
    const d = embedCache.get(a.id);
    if (d) {
      assets[k] = { ...a, dataUrl: d };
      changed = true;
    } else console.warn(`[darkroom] video "${a.name}" is not embedded in the saved file (too large or still loading); it stays in this browser's storage.`);
  }
  return changed ? { ...p, assets } : p;
}

export const formatMB = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(bytes > 10 * 1024 * 1024 ? 0 : 1)} MB`;
