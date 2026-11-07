/**
 * Main-thread AI runtime: picks an execution provider (WebGPU → WASM), starts the inference worker
 * (falls back to running ONNX Runtime on the main thread if workers fail), downloads models with
 * progress into Cache Storage, and exposes an observable state for the UI.
 *
 * The ONNX Runtime .wasm binaries are bundled by Vite from node_modules (`?url` imports) and are
 * themselves cached in Cache Storage on first use, so the app works offline afterwards.
 */
import jsepWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm?url';
import cpuWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import { deleteCached, fetchCached, listCached } from './cache';
import { approve, ensureConsent } from './consent';
import { MODELS, pickFile, type ModelFile, type Precision } from './models';
import { createHost, type AiRequest, type AiResponse, type Ep, type InitResult, type LoadResult, type RunResult, type TensorData } from './session';

export const ORT_VERSION = '1.31.1';
export type EpPreference = 'auto' | 'webgpu' | 'wasm';

export interface DownloadState {
  label: string;
  url: string;
  loaded: number;
  total: number;
  done: boolean;
  fromCache?: boolean;
  error?: string;
}

export interface ModelState {
  status: 'idle' | 'downloading' | 'loading' | 'ready' | 'error';
  precision?: Precision;
  ep?: Ep;
  loadMs?: number;
  lastInferMs?: number;
  lastSize?: string;
  error?: string;
}

export interface AiState {
  preference: EpPreference;
  backend: { status: 'idle' | 'starting' | 'ready' | 'error'; ep?: Ep; threads?: number; worker?: boolean; f16?: boolean; error?: string };
  downloads: Record<string, DownloadState>;
  models: Record<string, ModelState>;
  /** Inferences in flight. */
  running: number;
  /** Cached URL → bytes (refreshed by refreshCached()). */
  cached: Record<string, number>;
  /** Long-running node work with progress (e.g. tiled upscaling), shown in the progress toast. */
  tasks?: Record<string, { label: string; done: number; total: number }>;
}

// ---------------------------------------------------------------------------
// observable state
// ---------------------------------------------------------------------------
const PREF_KEY = 'darkroom.ai.ep';
function readPref(): EpPreference {
  try {
    const q = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('aiEp') : null;
    const v = q ?? localStorage.getItem(PREF_KEY);
    return v === 'webgpu' || v === 'wasm' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

let state: AiState = { preference: readPref(), backend: { status: 'idle' }, downloads: {}, models: {}, running: 0, cached: {} };
const listeners = new Set<() => void>();
function set(patch: Partial<AiState> | ((s: AiState) => Partial<AiState>)) {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
  listeners.forEach((l) => l());
}
export const getAiState = () => state;
export function subscribeAi(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}
const setModel = (id: string, patch: Partial<ModelState>) => set((s) => ({ models: { ...s.models, [id]: { ...(s.models[id] ?? { status: 'idle' }), ...patch } } }));
/** Show (or with null, clear) progress of a long-running AI task in the progress toast. */
export function setAiTask(id: string, task: { label: string; done: number; total: number } | null) {
  set((s) => {
    const tasks = { ...s.tasks };
    if (task) tasks[id] = task;
    else delete tasks[id];
    return { tasks };
  });
}
const setDownload = (url: string, patch: Partial<DownloadState>) =>
  set((s) => ({ downloads: { ...s.downloads, [url]: { ...(s.downloads[url] ?? { label: url, url, loaded: 0, total: 0, done: false }), ...patch } } }));

/** Post to the editor's status bar if present (no-op in the harness). */
function post(msg: string, kind: 'info' | 'error' = 'info') {
  const ui = (globalThis as { __darkroom?: { ui?: { setState(p: object): void } } }).__darkroom?.ui;
  ui?.setState({ message: msg, messageKind: kind });
}

/** Cache-first download with progress in the AI toast / AI Models panel (also used by the MediaPipe runtime). */
export async function download(label: string, url: string, expected = 0) {
  await ensureConsent(url, label, expected);
  setDownload(url, { label, loaded: 0, total: expected, done: false, error: undefined });
  let last = 0;
  try {
    const r = await fetchCached(
      url,
      (loaded, total) => {
        const now = performance.now();
        if (now - last < 100 && loaded < total) return;
        last = now;
        setDownload(url, { loaded, total });
        if (total) post(`Downloading ${label}… ${Math.round((loaded / total) * 100)}% of ${(total / 1e6).toFixed(1)} MB`);
      },
      expected,
    );
    setDownload(url, { loaded: r.buffer.byteLength, total: r.buffer.byteLength, done: true, fromCache: r.fromCache });
    return r.buffer;
  } catch (e) {
    setDownload(url, { error: String((e as Error)?.message ?? e), done: true });
    throw e;
  }
}

// ---------------------------------------------------------------------------
// backend (worker or inline)
// ---------------------------------------------------------------------------
interface Backend {
  call<T>(msg: AiRequest, transfer?: Transferable[]): Promise<T>;
  dispose(): void;
  worker: boolean;
  ep: Ep;
  f16: boolean;
}

function workerBackend(gpu: boolean): { call: Backend['call']; dispose(): void } {
  const w = gpu
    ? new Worker(new URL('./worker-gpu.ts', import.meta.url), { type: 'module', name: 'darkroom-ai' })
    : new Worker(new URL('./worker-wasm.ts', import.meta.url), { type: 'module', name: 'darkroom-ai' });
  let seq = 0;
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  const failAll = (e: Error) => {
    pending.forEach((p) => p.reject(e));
    pending.clear();
  };
  w.onmessage = (ev: MessageEvent<AiResponse>) => {
    const p = pending.get(ev.data.id);
    if (!p) return;
    pending.delete(ev.data.id);
    if (ev.data.ok) p.resolve(ev.data.value);
    else p.reject(new Error(ev.data.error));
  };
  w.onerror = (ev) => {
    ev.preventDefault?.();
    failAll(new Error('AI worker crashed: ' + (ev.message || 'unknown error')));
  };
  return {
    call: <T>(msg: AiRequest, transfer: Transferable[] = []) =>
      new Promise<T>((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        w.postMessage({ id, msg }, transfer);
      }),
    dispose: () => {
      failAll(new Error('AI runtime restarted'));
      w.terminate();
    },
  };
}

async function hasWebGpu() {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return false;
  try {
    return !!(await gpu.requestAdapter());
  } catch {
    return false;
  }
}

let backendP: Promise<Backend> | null = null;

async function startBackend(): Promise<Backend> {
  set({ backend: { status: 'starting' } });
  const pref = state.preference;
  const gpu = pref !== 'wasm' && (await hasWebGpu());
  if (pref === 'webgpu' && !gpu) console.warn('[darkroom ai] WebGPU requested but unavailable; using WASM');
  const wasm = await download(gpu ? 'ONNX Runtime (WebGPU + CPU)' : 'ONNX Runtime (CPU)', gpu ? jsepWasmUrl : cpuWasmUrl);
  const isolated = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
  const threads = isolated ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) >> 1)) : 1;

  // 1) web worker
  if (typeof Worker !== 'undefined') {
    let wb: ReturnType<typeof workerBackend> | null = null;
    try {
      wb = workerBackend(gpu);
      const init = await withTimeout(wb.call<InitResult>({ type: 'init', ep: gpu ? 'webgpu' : 'wasm', wasm: wasm.slice(0), threads }), 20000, 'AI worker did not start');
      set({ backend: { status: 'ready', ep: init.ep, threads: init.threads, worker: true, f16: init.f16 } });
      return { ...wb, worker: true, ep: init.ep, f16: init.f16 };
    } catch (e) {
      wb?.dispose();
      console.warn('[darkroom ai] worker unavailable, running inference on the main thread:', e);
    }
  }
  // 2) inline (main thread, async)
  const ort = gpu ? await import('onnxruntime-web') : await import('onnxruntime-web/wasm');
  const host = createHost(ort);
  const init = (await host.handle({ type: 'init', ep: gpu ? 'webgpu' : 'wasm', wasm, threads: 1 })).value as InitResult;
  set({ backend: { status: 'ready', ep: init.ep, threads: 1, worker: false, f16: init.f16 } });
  return { call: async <T,>(msg: AiRequest) => (await host.handle(msg)).value as T, dispose() {}, worker: false, ep: init.ep, f16: init.f16 };
}

function withTimeout<T>(p: Promise<T>, ms: number, msg: string) {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms);
    p.then((v) => (clearTimeout(t), resolve(v)), (e) => (clearTimeout(t), reject(e)));
  });
}

function getBackend() {
  if (!backendP) {
    backendP = startBackend().catch((e) => {
      backendP = null;
      set({ backend: { status: 'error', error: String((e as Error)?.message ?? e) } });
      throw e;
    });
  }
  return backendP;
}

// ---------------------------------------------------------------------------
// models
// ---------------------------------------------------------------------------
interface Loaded { key: string; file: ModelFile; info: LoadResult }
const loaded = new Map<string, Promise<Loaded>>();

async function loadModel(id: string): Promise<Loaded> {
  const model = MODELS[id];
  if (!model) throw new Error('unknown AI model ' + id);
  const be = await getBackend();
  const tryFile = async (file: ModelFile): Promise<Loaded> => {
    setModel(id, { status: 'downloading', precision: file.precision, error: undefined });
    const raw = await download(`${model.name} (${file.precision})`, file.url, file.bytes);
    const buf = model.prepare ? await model.prepare(raw) : raw;
    setModel(id, { status: 'loading' });
    const key = `${id}:${file.precision}`;
    const info = await be.call<LoadResult>({ type: 'load', key, model: buf, ep: model.wasmOnly ? 'wasm' : undefined }, [buf]);
    setModel(id, { status: 'ready', ep: info.ep, loadMs: Math.round(info.ms) });
    post(`${model.name} ready (${info.ep === 'webgpu' ? 'WebGPU' : 'WASM'}, ${file.precision}).`);
    return { key, file, info };
  };
  const first = pickFile(model, model.wasmOnly ? 'wasm' : be.ep, be.f16);
  try {
    return await tryFile(first);
  } catch (e) {
    const alt = model.files.find((f) => f !== first && f.precision !== 'fp16');
    if (!alt) throw e;
    console.warn(`[darkroom ai] ${model.name} ${first.precision} failed (${(e as Error)?.message}); trying ${alt.precision}`);
    return tryFile(alt);
  }
}

export function ensureModel(id: string): Promise<Loaded> {
  let p = loaded.get(id);
  if (!p) {
    p = loadModel(id).catch((e) => {
      loaded.delete(id);
      setModel(id, { status: 'error', error: String((e as Error)?.message ?? e) });
      post(`AI model failed: ${(e as Error)?.message ?? e}`, 'error');
      throw e;
    });
    loaded.set(id, p);
  }
  return p;
}

/** Run a model on one input tensor; returns its first (or named) output as float32. */
export async function runModel(id: string, input: TensorData, opts: { output?: string } = {}): Promise<RunResult> {
  const m = await ensureModel(id);
  const be = await getBackend();
  set((s) => ({ running: s.running + 1 }));
  try {
    const r = await be.call<RunResult>({ type: 'run', key: m.key, inputs: { [m.info.inputs[0]]: input }, output: opts.output }, [input.data.buffer]);
    const size = input.dims.slice(-2).reverse().join('×');
    setModel(id, { lastInferMs: Math.round(r.ms), lastSize: size, ep: r.ep });
    console.info(`[darkroom ai] ${id} ${m.file.precision} ${size} on ${r.ep}${be.worker ? ' (worker)' : ' (main thread)'}: ${r.ms.toFixed(0)} ms`);
    return r;
  } finally {
    set((s) => ({ running: s.running - 1 }));
  }
}

/**
 * Run a model with several named inputs (int64 allowed via TensorData.type) and get several named
 * outputs back (default: all of the model's outputs). Input buffers are transferred: pass copies of
 * anything you keep (e.g. cached embeddings).
 */
export async function runModelMulti(id: string, inputs: Record<string, TensorData>, outputs?: string[]): Promise<Record<string, TensorData>> {
  const m = await ensureModel(id);
  const be = await getBackend();
  const names = outputs ?? m.info.outputs;
  set((s) => ({ running: s.running + 1 }));
  try {
    const r = await be.call<RunResult>({ type: 'run', key: m.key, inputs, outputs: names }, Object.values(inputs).map((t) => t.data.buffer));
    const first = Object.values(inputs)[0];
    const size = first ? first.dims.slice(-2).reverse().join('×') : '';
    setModel(id, { lastInferMs: Math.round(r.ms), lastSize: size, ep: r.ep });
    console.info(`[darkroom ai] ${id} ${m.file.precision} on ${r.ep}${be.worker ? ' (worker)' : ' (main thread)'}: ${r.ms.toFixed(0)} ms`);
    return r.extra ?? {};
  } finally {
    set((s) => ({ running: s.running - 1 }));
  }
}

// ---------------------------------------------------------------------------
// management (AI Models dialog)
// ---------------------------------------------------------------------------
/** Restart the runtime with another execution provider. Models reload on next use. */
export async function setEpPreference(p: EpPreference) {
  try {
    localStorage.setItem(PREF_KEY, p);
  } catch {
    /* ignore */
  }
  set({ preference: p });
  await resetRuntime();
}

export async function resetRuntime() {
  const old = backendP;
  backendP = null;
  loaded.clear();
  set({ backend: { status: 'idle' }, models: {} });
  if (old) (await old.catch(() => null))?.dispose();
}

export async function refreshCached() {
  set({ cached: await listCached().catch(() => ({})) });
}

export async function clearModelCache(url?: string) {
  await deleteCached(url);
  await refreshCached();
}

/** Download a model ahead of time (no inference). */
export const prefetchModel = (id: string) => {
  const m = MODELS[id];
  const f = m?.files[0];
  approve(...(m?.files ?? []).map((x) => x.url)); // an explicit Download click is consent
  return (m?.external && f ? download(`${m.name}`, f.url, f.bytes) : ensureModel(id)).then(() => refreshCached());
};

export const ORT_WASM_URLS = { jsep: jsepWasmUrl, cpu: cpuWasmUrl };

/** Debug/automation handle (used by the render harness tooling and benchmarks). */
(globalThis as Record<string, unknown>).__darkroomAi = { getState: getAiState, setEpPreference, clearModelCache, prefetchModel, runModel, runModelMulti };
