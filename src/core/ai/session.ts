/**
 * ONNX Runtime session host. Runs inside the AI web worker (worker-gpu.ts / worker-wasm.ts) or, if workers
 * are unavailable, on the main thread (still async). Message protocol: see AiRequest / AiResponse.
 */
import type * as Ort from 'onnxruntime-web';

export type Ep = 'webgpu' | 'wasm';

export interface TensorData {
  data: Float32Array;
  dims: number[];
  /** Feed as this ONNX type (values converted from `data`). Default float32. */
  type?: 'float32' | 'int64';
}

export type AiRequest =
  | { type: 'init'; ep: Ep; wasm: ArrayBuffer; threads: number }
  | { type: 'load'; key: string; model: ArrayBuffer; /** force an EP (e.g. a model with ops WebGPU lacks) */ ep?: Ep }
  | { type: 'run'; key: string; inputs: Record<string, TensorData>; output?: string; /** also return these outputs in `extra` */ outputs?: string[] }
  | { type: 'release'; key: string };

export interface InitResult { ep: Ep; threads: number; f16: boolean }
export interface LoadResult { ep: Ep; ms: number; inputs: string[]; outputs: string[] }
export interface RunResult extends TensorData { ms: number; ep: Ep; /** outputs requested via `outputs` */ extra?: Record<string, TensorData> }

export type AiResponse = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string };

// --- float16 helpers (fp16 models may keep fp16 I/O) --------------------------------------------
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
function toHalf(v: number) {
  f32[0] = v;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  let exp = ((x >>> 23) & 0xff) - 127 + 15;
  let mant = x & 0x7fffff;
  if (exp <= 0) {
    if (exp < -10) return sign;
    mant = (mant | 0x800000) >> (1 - exp);
    return sign | ((mant + 0x1000) >> 13);
  }
  if (exp >= 31) return sign | 0x7c00;
  mant += 0x1000;
  if (mant & 0x800000) {
    mant = 0;
    exp++;
  }
  if (exp >= 31) return sign | 0x7c00;
  return sign | (exp << 10) | (mant >> 13);
}
function fromHalf(h: number) {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

export function createHost(ort: typeof Ort) {
  let ep: Ep = 'wasm';
  /** A failed WebGPU run can leave ORT's JSEP backend unusable, so after one failure everything moves to WASM. */
  let gpuBroken = false;
  /** WebGPU sessions keep their bytes so an op the WebGPU EP can't run falls back to WASM at run time. */
  const sessions = new Map<string, { s: Ort.InferenceSession; ep: Ep; bytes?: Uint8Array }>();
  const opts = (e: Ep): Ort.InferenceSession.SessionOptions => ({ executionProviders: [e], graphOptimizationLevel: 'all', logSeverityLevel: 3 });
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = queue.then(fn, fn);
    queue = p.catch(() => {});
    return p;
  };

  const meta = (s: Ort.InferenceSession, name: string, input: boolean) => {
    const list = (input ? s.inputMetadata : s.outputMetadata) as readonly { name: string; isTensor: boolean; type?: string }[] | undefined;
    return list?.find((m) => m.name === name);
  };

  async function runOnce(s: Ort.InferenceSession, used: Ep, msg: Extract<AiRequest, { type: 'run' }>) {
    const feeds: Record<string, Ort.Tensor> = {};
    for (const [name, t] of Object.entries(msg.inputs)) {
      if (meta(s, name, true)?.type === 'float16') {
        const h = new Uint16Array(t.data.length);
        for (let i = 0; i < h.length; i++) h[i] = toHalf(t.data[i]);
        feeds[name] = new ort.Tensor('float16', h, t.dims);
      } else if (t.type === 'int64') feeds[name] = new ort.Tensor('int64', BigInt64Array.from(t.data, (v) => BigInt(Math.round(v))), t.dims);
      else feeds[name] = new ort.Tensor('float32', t.data, t.dims);
    }
    const t0 = performance.now();
    const out = await s.run(feeds);
    const ms = performance.now() - t0;
    const toF32 = async (tensor: Ort.Tensor) => {
      const raw = await tensor.getData();
      if (tensor.type === 'float16') {
        const h = raw as unknown as ArrayLike<number>;
        const data = new Float32Array(h.length);
        // Float16Array (newer Chromium) yields numbers; Uint16Array yields bits
        const bits = raw instanceof Uint16Array;
        for (let i = 0; i < h.length; i++) data[i] = bits ? fromHalf(h[i]) : h[i];
        return data;
      }
      return new Float32Array(raw as Float32Array);
    };
    const tensor = out[msg.output ?? msg.outputs?.[0] ?? s.outputNames[0]];
    const data = await toF32(tensor);
    const transfer: Transferable[] = [data.buffer];
    let extra: Record<string, TensorData> | undefined;
    if (msg.outputs) {
      extra = {};
      for (const name of msg.outputs) {
        const t = out[name];
        if (!t) continue;
        const d = await toF32(t);
        extra[name] = { data: d, dims: [...t.dims] };
        transfer.push(d.buffer);
      }
    }
    for (const t of Object.values(out)) t.dispose?.();
    return { value: { data, dims: [...tensor.dims], ms, ep: used, extra } satisfies RunResult, transfer };
  }

  async function handle(msg: AiRequest): Promise<{ value: unknown; transfer?: Transferable[] }> {
    switch (msg.type) {
      case 'init': {
        ort.env.logLevel = 'error';
        ort.env.wasm.wasmBinary = new Uint8Array(msg.wasm);
        ort.env.wasm.numThreads = msg.threads;
        let f16 = false;
        ep = msg.ep;
        if (ep === 'webgpu') {
          const gpu = (globalThis.navigator as Navigator & { gpu?: { requestAdapter(): Promise<{ features: Set<string> } | null> } }).gpu;
          const adapter = await gpu?.requestAdapter().catch(() => null);
          if (!adapter) ep = 'wasm';
          else f16 = adapter.features.has('shader-f16');
        }
        return { value: { ep, threads: msg.threads, f16 } satisfies InitResult };
      }
      case 'load': {
        const t0 = performance.now();
        const bytes = new Uint8Array(msg.model);
        let used: Ep = gpuBroken ? 'wasm' : (msg.ep ?? ep);
        let s: Ort.InferenceSession;
        try {
          s = await ort.InferenceSession.create(bytes, opts(used));
        } catch (e) {
          if (used !== 'webgpu') throw e;
          console.warn('[darkroom ai] WebGPU session failed, falling back to WASM:', e);
          used = 'wasm';
          s = await ort.InferenceSession.create(bytes, opts('wasm'));
        }
        sessions.get(msg.key)?.s.release().catch(() => {});
        sessions.set(msg.key, { s, ep: used, bytes: used === 'webgpu' ? bytes : undefined });
        return { value: { ep: used, ms: performance.now() - t0, inputs: [...s.inputNames], outputs: [...s.outputNames] } satisfies LoadResult };
      }
      case 'run':
        return serial(async () => {
          let entry = sessions.get(msg.key);
          if (!entry) throw new Error(`model ${msg.key} not loaded`);
          const toWasm = async () => {
            const s = await ort.InferenceSession.create(entry!.bytes!, opts('wasm'));
            entry!.s.release().catch(() => {});
            entry = { s, ep: 'wasm' };
            sessions.set(msg.key, entry);
            return entry;
          };
          if (entry.ep === 'webgpu' && gpuBroken && entry.bytes) entry = await toWasm();
          try {
            return await runOnce(entry.s, entry.ep, msg);
          } catch (e) {
            if (entry.ep !== 'webgpu' || !entry.bytes) throw e;
            console.warn(`[darkroom ai] ${msg.key}: WebGPU run failed (${(e as Error)?.message ?? e}); using WASM from now on`);
            gpuBroken = true;
            const w = await toWasm();
            return runOnce(w.s, 'wasm', msg);
          }
        });
      case 'release': {
        await sessions.get(msg.key)?.s.release();
        sessions.delete(msg.key);
        return { value: true };
      }
    }
  }
  return { handle };
}

/** Wire a host to a worker's message port. Skips emscripten pthread workers (they re-run this script). */
export function serveWorker(ort: typeof Ort) {
  const scope = globalThis as unknown as {
    name?: string;
    onmessage: ((ev: MessageEvent<{ id: number; msg: AiRequest }>) => void) | null;
    postMessage(m: AiResponse, o?: { transfer: Transferable[] }): void;
  };
  if (scope.name?.startsWith('em-pthread')) return;
  const host = createHost(ort);
  scope.onmessage = async (ev) => {
    const { id, msg } = ev.data;
    try {
      const { value, transfer } = await host.handle(msg);
      scope.postMessage({ id, ok: true, value } satisfies AiResponse, { transfer: transfer ?? [] });
    } catch (e) {
      scope.postMessage({ id, ok: false, error: String((e as Error)?.message ?? e) } satisfies AiResponse);
    }
  };
}
