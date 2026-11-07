/**
 * MediaPipe Tasks Vision runtime (Face Landmarker, Pose Landmarker, Image Segmenter) for the people AI nodes.
 *
 * - Package: `@mediapipe/tasks-vision` 0.10.35, pinned. 0.10.35 is the last release without the usage-metrics
 *   upload that 1.x added (POSTs to odml.pa.googleapis.com), so "nothing leaves the device" still holds.
 * - The WASM loader (.js) and binary (.wasm) are bundled from node_modules with Vite `?url` (no CDN). The
 *   runtime fetches both cache-first into Cache Storage ('darkroom-models') and hands MediaPipe blob URLs,
 *   so the PWA and Electron work offline after the first use (the 11 MB .wasm is too big for the PWA precache).
 * - Models (.task / .tflite) download from storage.googleapis.com/mediapipe-models (CORS: *), pinned to
 *   version "1" of each model path, into the same cache, with progress in the AI toast.
 * - Runs on the main thread (MediaPipe's loader is a classic script that sets `self.ModuleFactory`), async
 *   between calls. Task creation is serialised (that global is shared). `runningMode: 'IMAGE'`.
 * - Delegate: CPU (XNNPACK) by default: fast for these small models and bit-for-bit deterministic. With the
 *   AI preference set to WebGPU (or `?mpDelegate=GPU`), the GPU delegate is used; it renders into its own
 *   OffscreenCanvas WebGL context, separate from the engine's. Falls back to CPU if GPU creation fails.
 */
import type * as MPV from '@mediapipe/tasks-vision';
import loaderUrl from '@mediapipe/tasks-vision/vision_wasm_internal.js?url';
import wasmUrl from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url';
import { registerModel } from './models';
import { download, getAiState } from './runtime';

export const MEDIAPIPE_VERSION = '0.10.35';

const gs = (path: string) => `https://storage.googleapis.com/mediapipe-models/${path}`;

export interface MpModel {
  id: string;
  name: string;
  url: string;
  bytes: number;
}

export const MP_MODELS = {
  face: { id: 'mp-face-landmarker', name: 'MediaPipe Face Landmarker', url: gs('face_landmarker/face_landmarker/float16/1/face_landmarker.task'), bytes: 3758596 },
  poseLite: { id: 'mp-pose-lite', name: 'MediaPipe Pose Landmarker (lite)', url: gs('pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task'), bytes: 5777746 },
  poseFull: { id: 'mp-pose-full', name: 'MediaPipe Pose Landmarker (full)', url: gs('pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task'), bytes: 9398198 },
  selfie: { id: 'mp-selfie-multiclass', name: 'MediaPipe Selfie Multiclass (hair / skin / clothes)', url: gs('image_segmenter/selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite'), bytes: 16371837 },
} satisfies Record<string, MpModel>;

// list them in Plugins › AI Models (download / delete only; they don't run through ONNX Runtime)
const page = 'https://ai.google.dev/edge/mediapipe/solutions/vision/';
registerModel(
  { id: MP_MODELS.face.id, name: MP_MODELS.face.name, task: 'face', licence: 'Apache-2.0', page: page + 'face_landmarker', credit: 'MediaPipe Face Landmarker: BlazeFace short-range detector + 478-point Face Mesh v2 with irises (Google)', files: [{ precision: 'fp16', url: MP_MODELS.face.url, bytes: MP_MODELS.face.bytes }], external: true },
  { id: MP_MODELS.poseLite.id, name: MP_MODELS.poseLite.name, task: 'pose', licence: 'Apache-2.0', page: page + 'pose_landmarker', credit: 'MediaPipe Pose Landmarker lite: BlazePose GHUM 3D, 33 landmarks + segmentation (Google)', files: [{ precision: 'fp16', url: MP_MODELS.poseLite.url, bytes: MP_MODELS.poseLite.bytes }], external: true },
  { id: MP_MODELS.poseFull.id, name: MP_MODELS.poseFull.name, task: 'pose', licence: 'Apache-2.0', page: page + 'pose_landmarker', credit: 'MediaPipe Pose Landmarker full: BlazePose GHUM 3D, 33 landmarks + segmentation (Google)', files: [{ precision: 'fp16', url: MP_MODELS.poseFull.url, bytes: MP_MODELS.poseFull.bytes }], external: true },
  { id: MP_MODELS.selfie.id, name: MP_MODELS.selfie.name, task: 'segmentation', licence: 'Apache-2.0', page: page + 'image_segmenter', credit: 'MediaPipe Selfie Multiclass 256×256: background, hair, body skin, face skin, clothes, accessories (Google)', files: [{ precision: 'fp32', url: MP_MODELS.selfie.url, bytes: MP_MODELS.selfie.bytes }], external: true },
);

type Vision = typeof MPV;
/** MediaPipe's (non-exported) WasmFileset shape. */
interface WasmFileset {
  wasmLoaderPath: string;
  wasmBinaryPath: string;
}
let visionP: Promise<Vision> | null = null;
let filesetP: Promise<WasmFileset> | null = null;

/** The tasks-vision module (lazy: keeps ~150 kB out of the main bundle until a people node runs). */
export function vision(): Promise<Vision> {
  return (visionP ??= import('@mediapipe/tasks-vision').catch((e) => {
    visionP = null;
    throw e;
  }));
}

function fileset(): Promise<WasmFileset> {
  return (filesetP ??= (async () => {
    const [js, wasm] = await Promise.all([download('MediaPipe runtime (JS)', loaderUrl), download('MediaPipe runtime (WASM)', wasmUrl, 11153617)]);
    return {
      wasmLoaderPath: URL.createObjectURL(new Blob([js], { type: 'text/javascript' })),
      wasmBinaryPath: URL.createObjectURL(new Blob([wasm], { type: 'application/wasm' })),
    };
  })().catch((e) => {
    filesetP = null;
    throw e;
  }));
}

const modelBytes = new Map<string, Promise<Uint8Array>>();
export function mpModelBytes(m: MpModel): Promise<Uint8Array> {
  let p = modelBytes.get(m.id);
  if (!p) {
    p = download(m.name, m.url, m.bytes).then((b) => new Uint8Array(b));
    p.catch(() => modelBytes.delete(m.id));
    modelBytes.set(m.id, p);
  }
  return p;
}

export type MpDelegate = 'CPU' | 'GPU';
export function mpDelegate(): MpDelegate {
  try {
    const q = new URLSearchParams(location.search).get('mpDelegate');
    if (q === 'GPU' || q === 'CPU') return q;
  } catch {
    /* no location */
  }
  return getAiState().preference === 'webgpu' ? 'GPU' : 'CPU';
}

/** Serialise task creation: MediaPipe's loader hands the wasm module over through the global `self.ModuleFactory`. */
let createQueue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const p = createQueue.then(fn, fn);
  createQueue = p.catch(() => {});
  return p;
}

/** Per-task timings for the docs / debugging (also logged to the console). */
export const mpTimings: Record<string, { createMs?: number; lastMs?: number; delegate?: MpDelegate; size?: string }> = {};
(globalThis as Record<string, unknown>).__darkroomMp = { timings: mpTimings, version: MEDIAPIPE_VERSION };

interface Creatable<T> {
  createFromOptions(fs: WasmFileset, opts: object): Promise<T>;
}

const tasks = new Map<string, Promise<unknown>>();

/** Create (once per key + delegate) a MediaPipe task from a model; GPU creation failures fall back to CPU. */
export function getTask<T extends { close(): void }>(key: string, model: MpModel, make: (v: Vision) => Creatable<T>, options: object): Promise<T> {
  const delegate = mpDelegate();
  const k = `${key}:${delegate}`;
  let p = tasks.get(k) as Promise<T> | undefined;
  if (!p) {
    p = (async () => {
      const [v, fs, buf] = await Promise.all([vision(), fileset(), mpModelBytes(model)]);
      const create = (d: MpDelegate) =>
        serial(() => make(v).createFromOptions(fs, { ...options, baseOptions: { modelAssetBuffer: buf.slice(), delegate: d }, runningMode: 'IMAGE' }));
      const t0 = performance.now();
      let task: T;
      let used = delegate;
      try {
        task = await create(delegate);
      } catch (e) {
        if (delegate !== 'GPU') throw e;
        console.warn(`[darkroom ai] MediaPipe ${model.name}: GPU delegate failed (${(e as Error)?.message}); using CPU`);
        used = 'CPU';
        task = await create('CPU');
      }
      mpTimings[key] = { ...mpTimings[key], createMs: Math.round(performance.now() - t0), delegate: used };
      return task;
    })();
    p.catch(() => tasks.delete(k));
    tasks.set(k, p);
  }
  return p;
}

export function noteRun(key: string, ms: number, w: number, h: number) {
  mpTimings[key] = { delegate: mpDelegate(), ...mpTimings[key], lastMs: Math.round(ms), size: `${w}×${h}` };
  console.info(`[darkroom ai] MediaPipe ${key} ${w}×${h} (${mpTimings[key].delegate}): ${ms.toFixed(0)} ms`);
}

/** Post to the editor's status bar if present (no-op in the harness). */
export function mpStatus(msg: string, kind: 'info' | 'error' = 'info') {
  const ui = (globalThis as { __darkroom?: { ui?: { setState(p: object): void } } }).__darkroom?.ui;
  ui?.setState({ message: msg, messageKind: kind });
}
