/**
 * Cache-first binary downloads (models + the ONNX Runtime wasm) in Cache Storage, with progress.
 * Falls back to a plain fetch where Cache Storage is unavailable (insecure origins, some file:// hosts).
 */

export const CACHE_NAME = 'darkroom-models';

export type Progress = (loaded: number, total: number) => void;

const hasCaches = () => typeof caches !== 'undefined';

async function openCache(): Promise<Cache | null> {
  if (!hasCaches()) return null;
  try {
    return await caches.open(CACHE_NAME);
  } catch {
    return null;
  }
}

/** Fetch `url` as an ArrayBuffer, from the cache when present; stores a fresh download in the cache. */
export async function fetchCached(url: string, onProgress?: Progress, expectedBytes = 0): Promise<{ buffer: ArrayBuffer; fromCache: boolean }> {
  // Cache Storage only accepts http(s) keys. Files bundled with the Mac app (app://) are local anyway.
  const cacheable = /^https?:/i.test(new URL(url, location.href).protocol);
  const cache = cacheable ? await openCache() : undefined;
  const hit = await cache?.match(url).catch(() => undefined);
  if (hit) {
    const buffer = await hit.arrayBuffer();
    onProgress?.(buffer.byteLength, buffer.byteLength);
    return { buffer, fromCache: true };
  }
  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) throw new Error(`Download failed (${res.status} ${res.statusText}): ${url}`);
  const total = Number(res.headers.get('content-length')) || expectedBytes;
  let buffer: ArrayBuffer;
  if (res.body && onProgress) {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    onProgress(0, total);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.byteLength;
      onProgress(loaded, Math.max(total, loaded));
    }
    const out = new Uint8Array(loaded);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.byteLength;
    }
    buffer = out.buffer;
  } else buffer = await res.arrayBuffer();
  if (cache) {
    const headers = { 'content-type': 'application/octet-stream', 'content-length': String(buffer.byteLength) };
    await cache.put(url, new Response(buffer.slice(0), { headers })).catch((e) => console.warn('[darkroom ai] could not cache', url, e));
  }
  return { buffer, fromCache: false };
}

/** Cached URLs → size in bytes. */
export async function listCached(): Promise<Record<string, number>> {
  const cache = await openCache();
  if (!cache) return {};
  const out: Record<string, number> = {};
  for (const req of await cache.keys()) {
    const res = await cache.match(req);
    out[req.url] = Number(res?.headers.get('content-length')) || 0;
  }
  return out;
}

export async function deleteCached(url?: string) {
  if (!hasCaches()) return;
  if (!url) await caches.delete(CACHE_NAME);
  else await (await openCache())?.delete(url);
}

export const cacheAvailable = hasCaches;
