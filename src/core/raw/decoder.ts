/**
 * RAW decoding via libraw-wasm, which runs LibRaw (WASM) in its own Web Worker.
 * We talk to that worker directly (same {id, fn, args} protocol as the package's
 * LibRaw class) so Vite bundles the worker + wasm as regular assets.
 *
 * Decodes are cached in memory per (asset, decode options), bounded by size.
 * Linear 16-bit output becomes a Float32 RawTex (uploaded as RGBA16F) so the
 * full dynamic range reaches the GPU; the core.raw shader then applies
 * exposure / custom WB and encodes to the engine's display-referred sRGB.
 */
import type { RawMeta, RawTex } from '../types';
import { decodeKey, libRawSettings, toRawMeta, toRgba, type DecodeOptions } from './develop';

export { toRgba };

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

/** One LibRaw worker. Calls are serialised (LibRaw holds one open file at a time). */
class RawWorker {
  private w: Worker;
  private pending = new Map<number, Pending>();
  private next = 0;
  private tail: Promise<unknown> = Promise.resolve();
  dead = false;

  constructor(Ctor: new () => Worker) {
    this.w = new Ctor();
    this.w.onmessage = ({ data }) => {
      const p = this.pending.get(data?.id);
      if (!p) return;
      this.pending.delete(data.id);
      if (data.error) p.reject(new Error(String(data.error)));
      else p.resolve(data.out);
    };
    this.w.onerror = (e) => {
      e.preventDefault?.();
      this.kill(new Error(`RAW decoder crashed${e.message ? `: ${e.message}` : ''}`));
    };
  }

  private call<T>(fn: string, ...args: unknown[]): Promise<T> {
    if (this.dead) return Promise.reject(new Error('RAW decoder was shut down'));
    const id = this.next++;
    const transfer = args.filter((a): a is Uint8Array => a instanceof Uint8Array).map((a) => a.buffer as ArrayBuffer);
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.w.postMessage({ id, fn, args }, transfer);
    });
  }

  /** Run a sequence of calls exclusively. */
  run<T>(job: () => Promise<T>): Promise<T> {
    const p = this.tail.then(job, job);
    this.tail = p.catch(() => {});
    return p;
  }

  open = (bytes: Uint8Array, settings: Record<string, unknown>) => this.call<void>('open', bytes, settings);
  metadata = () => this.call<Record<string, unknown>>('metadata', false);
  imageData = () => this.call<{ width: number; height: number; colors: number; bits: number; data: Uint8Array | Uint16Array }>('imageData');

  kill(err = new Error('RAW decoder shut down')) {
    if (this.dead) return;
    this.dead = true;
    this.w.terminate();
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}

let worker: RawWorker | null = null;
let idleTimer = 0;
let busy = 0;

let WorkerCtor: Promise<new () => Worker> | null = null;
/** Get the decoder (loaded lazily: the worker + 1.4 MB wasm are only fetched once a RAW is opened). It is terminated after 60 s idle to give back its never-shrinking WASM heap. */
async function getWorker() {
  WorkerCtor ??= import('libraw-wasm/dist/worker.js?worker').then((m) => m.default);
  const Ctor = await WorkerCtor;
  clearTimeout(idleTimer);
  if (!worker || worker.dead) worker = new RawWorker(Ctor);
  return worker;
}
function release() {
  busy--;
  clearTimeout(idleTimer);
  if (busy <= 0)
    idleTimer = setTimeout(() => {
      if (busy <= 0) {
        worker?.kill();
        worker = null;
      }
    }, 60_000) as unknown as number;
}

async function withWorker<T>(fn: (w: RawWorker) => Promise<T>): Promise<T> {
  busy++;
  let w: RawWorker | null = null;
  try {
    w = await getWorker();
    const ww = w;
    return await ww.run(() => fn(ww));
  } catch (e) {
    // a WASM abort can leave LibRaw in a bad state: start fresh next time
    w?.kill();
    throw e;
  } finally {
    release();
  }
}

const friendly = (e: unknown) => {
  const m = String((e as Error)?.message ?? e);
  if (/unsupported|not raw|recogni|file format|no image/i.test(m)) return new Error(`Unsupported, damaged or unrecognised RAW file (${m}).`);
  if (/memory|alloc/i.test(m)) return new Error(`Not enough memory to decode this RAW file (${m}).`);
  return new Error(`Could not decode RAW file: ${m}`);
};

/** Open a RAW file just far enough to read its metadata. */
export async function readRawMeta(bytes: Uint8Array): Promise<RawMeta> {
  try {
    return await withWorker(async (w) => {
      await w.open(bytes.slice(), { halfSize: true });
      const m = await w.metadata();
      if (!m || !m.width) throw new Error('not a recognised RAW file (no image found)');
      return toRawMeta(m);
    });
  } catch (e) {
    throw friendly(e);
  }
}

export interface DecodedRaw extends RawTex {
  /** True when `data` holds linear light (16-bit linear output), false for sRGB-encoded 8-bit. */
  linear: boolean;
  meta: RawMeta;
  ms: number;
}

// ---------------------------------------------------------------------------
// cache
// ---------------------------------------------------------------------------

interface Entry {
  key: string;
  assetId: string;
  value?: DecodedRaw;
  promise: Promise<DecodedRaw>;
  bytes: number;
  used: number;
}

const cache = new Map<string, Entry>();
/** Budget for cached decodes (the most recent decode is always kept). */
export let RAW_CACHE_BYTES = 768 * 1024 * 1024;
export const setRawCacheBudget = (b: number) => (RAW_CACHE_BYTES = b);

function evict(keep: string) {
  let total = 0;
  for (const e of cache.values()) total += e.bytes;
  const list = [...cache.values()].filter((e) => e.value && e.key !== keep).sort((a, b) => a.used - b.used);
  while (total > RAW_CACHE_BYTES && list.length) {
    const e = list.shift()!;
    cache.delete(e.key);
    total -= e.bytes;
  }
}

/** Drop cached decodes of one asset (or all). */
export function forgetRaw(assetId?: string) {
  for (const [k, e] of cache) if (!assetId || e.assetId === assetId) cache.delete(k);
}

export const rawCacheStats = () => ({ entries: cache.size, bytes: [...cache.values()].reduce((s, e) => s + e.bytes, 0) });

/** Decode (or fetch from cache) a RAW asset with the given options. */
export function decodeRaw(assetId: string, bytes: Uint8Array, opts: DecodeOptions): Promise<DecodedRaw> {
  const key = assetId + '#' + bytes.byteLength + '#' + decodeKey(opts);
  const hit = cache.get(key);
  if (hit) {
    hit.used = performance.now();
    return hit.promise;
  }
  const e: Entry = { key, assetId, bytes: 0, used: performance.now(), promise: null! };
  e.promise = (async () => {
    const t0 = performance.now();
    let img, meta;
    try {
      [img, meta] = await withWorker(async (w) => {
        await w.open(bytes.slice(), libRawSettings(opts));
        const m = await w.metadata();
        const d = await w.imageData();
        if (!d?.data?.length) throw new Error('decoder returned no pixels');
        return [d, m] as const;
      });
    } catch (err) {
      throw friendly(err);
    }
    const linear = opts.output === '16-bit linear';
    const tex = toRgba(img, !linear);
    const out: DecodedRaw = { ...tex, linear, meta: toRawMeta(meta ?? {}), ms: performance.now() - t0 };
    e.value = out;
    e.bytes = tex.data.byteLength;
    evict(key);
    return out;
  })();
  e.promise.catch(() => cache.get(key) === e && cache.delete(key));
  cache.set(key, e);
  return e.promise;
}
