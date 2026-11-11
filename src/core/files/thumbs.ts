/**
 * Thumbnails for the file browser, generated in the background with a concurrency limit and
 * only for cells that are on screen (callers pass an AbortSignal and abort when a cell scrolls
 * away; queued work for it is dropped).
 *
 * Sources, in order:
 *   1. the backend's native thumbnail — QuickLook in the Mac app (JPEG/PNG/HEIC/TIFF, most RAWs,
 *      video poster frames), cached on disk by main in ~/Library/Caches/darkroom-thumbs;
 *   2. in the renderer: browser-decodable images are decoded at reduced size; RAW / HEIC / TIFF use
 *      their embedded JPEG preview (largest embedded JPEG, or exifr's IFD1 thumbnail); videos a
 *      frame at 10 %; .darkroom projects the `preview` image saved in the project.
 * Renderer-made thumbnails are cached in IndexedDB (web build) keyed by path + mtime + size.
 */
import type { FsBackend } from './backend';
import { largestEmbeddedJpeg, sniffDimensions } from './dims';
import { idbGet, idbPut, idbTrimThumbs } from './idb';
import { kindOf, WEB_DECODABLE, extOfName } from './kinds';
import type { FsEntry } from './types';

export interface Thumb {
  url: string;
  width: number;
  height: number;
}

/** Size buckets so a slider drag doesn't regenerate everything. */
export const thumbBucket = (px: number) => (px <= 160 ? 160 : px <= 320 ? 320 : px <= 640 ? 640 : 1600);

const mem = new Map<string, Thumb | null>();
const MEM_MAX = 2500;
function remember(key: string, t: Thumb | null) {
  mem.delete(key);
  mem.set(key, t);
  while (mem.size > MEM_MAX) {
    const [k, v] = mem.entries().next().value as [string, Thumb | null];
    mem.delete(k);
    if (v) URL.revokeObjectURL(v.url);
  }
}

const keyOf = (e: FsEntry, size: number) => `${e.path}|${e.mtime}|${e.size}|${size}`;

/** Cached thumbnail, if any (synchronous, for first paint). undefined = not generated yet, null = none possible. */
export const cachedThumb = (e: FsEntry, px: number): Thumb | null | undefined => mem.get(keyOf(e, thumbBucket(px)));

// --- queue ---------------------------------------------------------------------
interface Job {
  run: () => Promise<void>;
  signal?: AbortSignal;
}
const queue: Job[] = [];
let active = 0;
let limit = 4;
export const setThumbConcurrency = (n: number) => (limit = n);

function pump() {
  while (active < limit && queue.length) {
    const j = queue.pop()!; // newest first: what was just scrolled into view
    if (j.signal?.aborted) continue;
    active++;
    void j.run().finally(() => {
      active--;
      pump();
    });
  }
}

const inflight = new Map<string, Promise<Thumb | null>>();

/** Thumbnail of `e` at about `px` pixels (long edge). Resolves null when no thumbnail can be made. */
export function requestThumb(fs: FsBackend, e: FsEntry, px: number, signal?: AbortSignal): Promise<Thumb | null> {
  const size = thumbBucket(px);
  const key = keyOf(e, size);
  if (mem.has(key)) return Promise.resolve(mem.get(key)!);
  const running = inflight.get(key);
  if (running) return running;
  const p = new Promise<Thumb | null>((resolve, reject) => {
    const job: Job = {
      signal,
      run: async () => {
        if (signal?.aborted) return reject(new DOMException('aborted', 'AbortError'));
        try {
          const t = await generate(fs, e, size, key);
          remember(key, t);
          resolve(t);
        } catch (err) {
          console.warn('[darkroom files] thumbnail failed', e.name, (err as Error).message);
          remember(key, null);
          resolve(null);
        }
      },
    };
    queue.push(job);
    signal?.addEventListener('abort', () => {
      const i = queue.indexOf(job);
      if (i >= 0) {
        queue.splice(i, 1);
        reject(new DOMException('aborted', 'AbortError'));
      }
    });
    pump();
  });
  inflight.set(key, p);
  void p.finally(() => inflight.delete(key)).catch(() => {});
  return p;
}

const toThumb = (blob: Blob, w: number, h: number): Thumb => ({ url: URL.createObjectURL(blob), width: w, height: h });

async function generate(fs: FsBackend, e: FsEntry, size: number, key: string): Promise<Thumb | null> {
  const kind = kindOf(e.name);
  if (kind === 'other') return null;
  // 1. native (QuickLook)
  if (fs.thumb && kind !== 'project') {
    const t = await fs.thumb(e.path, size).catch(() => null);
    if (t) return toThumb(new Blob([t.data as Uint8Array<ArrayBuffer>], { type: t.mime }), t.width, t.height);
  }
  // 2. renderer-side, IndexedDB-cached in the web build
  const persist = fs.kind !== 'electron';
  if (persist) {
    const hit = await idbGet<{ blob: Blob; w: number; h: number }>('thumbs', key).catch(() => undefined);
    if (hit?.blob) return toThumb(hit.blob, hit.w, hit.h);
  }
  const made = await render(fs, e, size);
  if (!made) return null;
  if (persist) {
    void idbPut('thumbs', key, { blob: made.blob, w: made.w, h: made.h })
      .then(() => (Math.random() < 0.02 ? idbTrimThumbs() : undefined))
      .catch(() => {});
  }
  return toThumb(made.blob, made.w, made.h);
}

async function encode(src: ImageBitmap | HTMLVideoElement, w: number, h: number): Promise<{ blob: Blob; w: number; h: number }> {
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext('2d')!;
  g.drawImage(src, 0, 0, w, h);
  return { blob: await c.convertToBlob({ type: 'image/jpeg', quality: 0.82 }), w, h };
}

/** Decode an image blob at most `size` px on the long edge. */
export async function decodeScaled(blob: Blob, size: number, dims?: { width: number; height: number } | null): Promise<{ blob: Blob; w: number; h: number }> {
  const opts: ImageBitmapOptions = { imageOrientation: 'from-image' };
  if (dims && Math.max(dims.width, dims.height) > size) {
    if (dims.width >= dims.height) opts.resizeWidth = size;
    else opts.resizeHeight = size;
    opts.resizeQuality = 'medium';
  }
  const bmp = await createImageBitmap(blob, opts);
  try {
    const k = Math.min(1, size / Math.max(bmp.width, bmp.height));
    return await encode(bmp, Math.max(1, Math.round(bmp.width * k)), Math.max(1, Math.round(bmp.height * k)));
  } finally {
    bmp.close();
  }
}

/** An embedded JPEG preview (RAW, HEIC, TIFF): the largest embedded JPEG, else exifr's thumbnail. */
export async function embeddedPreview(fs: FsBackend, e: FsEntry): Promise<Blob | null> {
  const bytes = await fs.read(e.path);
  const big = largestEmbeddedJpeg(bytes);
  if (big) return new Blob([big as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' });
  const exifr = (await import('exifr')).default;
  const t = await exifr.thumbnail(bytes).catch(() => undefined);
  return t ? new Blob([t as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }) : null;
}

async function render(fs: FsBackend, e: FsEntry, size: number): Promise<{ blob: Blob; w: number; h: number } | null> {
  const kind = kindOf(e.name);
  if (kind === 'project') {
    const url = await projectPreview(fs, e.path);
    if (!url) return null;
    const blob = await (await fetch(url)).blob();
    return decodeScaled(blob, size);
  }
  if (kind === 'video') return videoFrame(await fs.file(e.path), size);
  if (kind === 'image' && WEB_DECODABLE.includes(extOfName(e.name))) {
    const f = await fs.file(e.path);
    const dims = sniffDimensions(new Uint8Array(await f.slice(0, 256 * 1024).arrayBuffer()));
    return decodeScaled(f, size, dims);
  }
  // RAW, HEIC, TIFF: the embedded preview
  const jpg = await embeddedPreview(fs, e);
  if (!jpg) return null;
  return decodeScaled(jpg, size);
}

/** The `preview` data URL saved at the start of a .darkroom project (see store/io.ts › serializeProject). */
export async function projectPreview(fs: FsBackend, path: string): Promise<string | null> {
  const head = await fs.read(path, { start: 0, length: 512 * 1024 });
  const text = new TextDecoder().decode(head);
  const m = /"preview"\s*:\s*"(data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+)"/.exec(text);
  return m ? m[1] : null;
}

/** A poster frame (10 % in, at most 1 s) of a video file. */
export async function videoFrame(file: Blob, size: number): Promise<{ blob: Blob; w: number; h: number } | null> {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  v.playsInline = true;
  try {
    await new Promise<void>((res, rej) => {
      v.onloadedmetadata = () => res();
      v.onerror = () => rej(new Error('video could not be read'));
      v.src = url;
    });
    const t = Math.min(1, (v.duration || 0) * 0.1);
    await new Promise<void>((res, rej) => {
      const to = setTimeout(() => rej(new Error('seek timeout')), 8000);
      v.onseeked = () => (clearTimeout(to), res());
      v.currentTime = t;
    });
    if (!v.videoWidth) return null;
    const k = Math.min(1, size / Math.max(v.videoWidth, v.videoHeight));
    return await encode(v, Math.max(1, Math.round(v.videoWidth * k)), Math.max(1, Math.round(v.videoHeight * k)));
  } finally {
    v.removeAttribute('src');
    v.load();
    URL.revokeObjectURL(url);
  }
}

/** Drop cached thumbnails of a path (after a rename / change on disk). */
export function forgetThumbs(path: string) {
  for (const [k, v] of mem) if (k.startsWith(path + '|')) {
    mem.delete(k);
    if (v) URL.revokeObjectURL(v.url);
  }
}
