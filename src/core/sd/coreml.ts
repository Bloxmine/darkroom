/**
 * Built-in Core ML engine, renderer side (Mac app only): model / ControlNet resolution, fitting the inputs to the
 * model's fixed resolution, the request builder (pure, unit-tested) and the call through window.darkroomNative.coreml.
 * The heavy lifting is in electron/coreml (process + downloads) and native/coreml-sd (the Swift helper).
 */
import type { CoreMLComputeUnits, CoreMLControlNetInfo, CoreMLEvent, CoreMLGenerateRequest, CoreMLModelInfo, CoreMLModelList, CoreMLScheduler } from '../../native/api';
import { native } from '../../native/native';
import { CONTROL_KINDS, type ControlKind } from './coreml-catalog';
import type { GenSpec } from './types';

export const coremlApi = () => native?.coreml;
/** The engine exists in this build (Mac app). Availability on this Mac (arch, macOS) is in status(). */
export const hasCoreML = () => !!coremlApi();

export type FitMode = 'letterbox' | 'crop' | 'stretch';
export const FIT_MODES: FitMode[] = ['letterbox', 'crop', 'stretch'];

// --------------------------------------------------------------------------------------------- console log
/**
 * Mirror the engine's events into the renderer console as `[darkroom coreml] …` (Diagnostics captures these):
 * errors (helper crashes, load failures), warnings, and info for state changes / job phases / downloads.
 */
let logging = false;
export function installCoreMLLogging() {
  const api = coremlApi();
  if (!api || logging) return;
  logging = true;
  const lastPhase = new Map<string, string>();
  api.onEvent((e) => {
    if (e.type === 'log') (e.level === 'error' ? console.error : e.level === 'warn' ? console.warn : console.info)(`[darkroom coreml] ${e.message}`);
    else if (e.type === 'state') console.info(`[darkroom coreml] engine ${e.state}${e.detail ? ` — ${e.detail}` : ''}`);
    else if (e.type === 'job') {
      if (lastPhase.get(e.jobId) === e.phase) return;
      lastPhase.set(e.jobId, e.phase);
      if (lastPhase.size > 50) lastPhase.delete(lastPhase.keys().next().value!);
      (e.phase === 'planning' && /cannot/i.test(e.message) ? console.warn : console.info)(`[darkroom coreml] job ${e.jobId}: ${e.phase} — ${e.message}`);
    } else if (e.type === 'download' && e.state !== 'downloading')
      (e.state === 'error' ? console.error : console.info)(`[darkroom coreml] download ${e.id}: ${e.state}${e.error ? ` — ${e.error}` : ''}`);
  });
}
installCoreMLLogging();

// ------------------------------------------------------------------------------------------- model list cache
let list: CoreMLModelList | null = null;
export const cachedCoreMLList = () => list;
export function setCachedCoreMLList(l: CoreMLModelList | null) {
  list = l;
}

/** ControlNet kind from a model card id (lllyasviel/control_v11p_sd15_canny) or a file name (Canny-SE, LineArtAnime-5x5). */
export function kindOf(s: string): ControlKind | null {
  const v = s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const rules: [RegExp, ControlKind][] = [
    [/lineartanime|s2lineart/, 'lineart_anime'],
    [/inpaint/, 'inpaint'],
    [/normalbae|normal/, 'normalbae'],
    [/softedge|hed|pidi/, 'softedge'],
    [/lineart/, 'lineart'],
    [/openpose|pose/, 'openpose'],
    [/scribble/, 'scribble'],
    [/tile/, 'tile'],
    [/seg/, 'seg'],
    [/depth/, 'depth'],
    [/canny/, 'canny'],
    [/mlsd/, 'mlsd'],
    [/shuffle/, 'shuffle'],
    [/ip2p|instrp2p|pix2pix/, 'ip2p'],
  ];
  return rules.find(([re]) => re.test(v))?.[1] ?? null;
}
export const controlNetKind = (c: Pick<CoreMLControlNetInfo, 'version' | 'name'>) => kindOf(c.version) ?? kindOf(c.name);
export const isControlKind = (s: string): s is ControlKind => (CONTROL_KINDS as readonly string[]).includes(s.trim().toLowerCase());

export class CoreMLResolveError extends Error {}

/** `checkpoint` param → model: '' = the first SD 1.5 model (one with ControlNet support if needed); else an id or a name. */
export function resolveModel(value: string, l: CoreMLModelList, needControlNet: boolean): CoreMLModelInfo {
  const v = value.trim();
  const usable = l.models.filter((m) => m.kind !== 'sdxl');
  if (!usable.length)
    throw new CoreMLResolveError('No Core ML Stable Diffusion model is installed. Download one in Preferences › Generation › Core ML (built-in), or add a folder with models.');
  if (v) {
    const m = usable.find((x) => x.id === v) ?? usable.find((x) => x.name === v) ?? usable.find((x) => x.id.endsWith(':' + v));
    if (!m) throw new CoreMLResolveError(`Core ML model “${v}” is not installed. Pick one from the list under Generate.`);
    if (needControlNet && !m.controlNetSupport)
      throw new CoreMLResolveError(`${m.name} has no ControlNet support (converted without --unet-support-controlnet). Pick a “_cn” model or disconnect the control maps.`);
    return m;
  }
  const pick = (needControlNet ? usable.filter((m) => m.controlNetSupport) : usable).sort((a, b) => Number(b.kind === 'sd15') - Number(a.kind === 'sd15'))[0];
  if (!pick) throw new CoreMLResolveError('None of the installed Core ML models supports ControlNet. Download a “_cn” model in Preferences › Generation.');
  return pick;
}

/**
 * A unit's ControlNet: an id, a file name, or a kind keyword (“canny”, “depth”, … — what the Core ML presets use),
 * matched to the model's attention variant and resolution.
 */
export function resolveControlNet(value: string, model: CoreMLModelInfo, l: CoreMLModelList): CoreMLControlNetInfo {
  const v = value.trim();
  const fits = (c: CoreMLControlNetInfo) => c.width === model.width && c.height === model.height && (c.attention === model.attention || c.attention === 'unknown' || model.attention === 'unknown');
  const exact = l.controlNets.find((c) => c.id === v) ?? l.controlNets.find((c) => c.name === v);
  const kind = exact ? controlNetKind(exact) : isControlKind(v) ? (v.toLowerCase() as ControlKind) : kindOf(v);
  if (exact && fits(exact)) return exact;
  const alt = kind ? l.controlNets.find((c) => controlNetKind(c) === kind && fits(c)) : undefined;
  if (alt) return alt;
  const variant = `${model.attention === 'splitEinsum' ? 'split-einsum (“-SE”)' : 'original'} ${model.width}×${model.height}`;
  if (exact)
    throw new CoreMLResolveError(`ControlNet ${exact.name} (${exact.attention === 'splitEinsum' ? 'split-einsum' : 'original'} ${exact.width}×${exact.height}) does not match ${model.name}; it needs the ${variant} variant.`);
  throw new CoreMLResolveError(
    `No ${kind ?? `“${v}”`} ControlNet for ${model.name} is installed (needs the ${variant} variant). Download it in Preferences › Generation › Core ML (built-in).`,
  );
}

// ---------------------------------------------------------------------------------------------- fitting
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Fit {
  /** Where the (whole) source image is drawn on the model-size canvas (may extend past it for crop). */
  draw: Rect;
  /** The part of the model's output that becomes the node's result. */
  keep: Rect;
  /** Output aspect (w/h) of the node's result. */
  aspect: number;
}

/**
 * Map a source of srcW×srcH onto a model that only generates modelW×modelH:
 *  letterbox — the whole source fits inside (padding), the result is cropped back to it: same aspect, nothing lost;
 *  crop      — the source covers the frame, the centre is generated at full model resolution; result = that crop;
 *  stretch   — the source is squashed to the model's size and the result stretched back.
 */
export function fitToModel(srcW: number, srcH: number, modelW: number, modelH: number, mode: FitMode): Fit {
  const full: Rect = { x: 0, y: 0, w: modelW, h: modelH };
  if (mode === 'stretch' || srcW <= 0 || srcH <= 0) return { draw: full, keep: full, aspect: srcW > 0 && srcH > 0 ? srcW / srcH : modelW / modelH };
  const s = mode === 'crop' ? Math.max(modelW / srcW, modelH / srcH) : Math.min(modelW / srcW, modelH / srcH);
  const w = srcW * s, h = srcH * s;
  const draw = { x: (modelW - w) / 2, y: (modelH - h) / 2, w, h };
  if (mode === 'crop') return { draw, keep: full, aspect: modelW / modelH };
  // letterbox: keep the content area, snapped to whole pixels
  const kx = Math.max(0, Math.round(draw.x)), ky = Math.max(0, Math.round(draw.y));
  const keep = { x: kx, y: ky, w: Math.min(modelW, Math.round(draw.x + w)) - kx, h: Math.min(modelH, Math.round(draw.y + h)) - ky };
  return { draw, keep, aspect: srcW / srcH };
}

/** Node output size for crop mode: the largest rect of the model's aspect inside the input. */
export function cropOutputSize(srcW: number, srcH: number, modelW: number, modelH: number): [number, number] {
  const a = modelW / modelH;
  return srcW / srcH > a ? [Math.max(1, Math.round(srcH * a)), srcH] : [srcW, Math.max(1, Math.round(srcW / a))];
}

// ---------------------------------------------------------------------------------------- request builder
export function coremlScheduler(sampler: string, scheduler: string): CoreMLScheduler {
  const s = `${sampler} ${scheduler}`.toLowerCase();
  if (/pndm|plms/.test(s)) return 'pndm';
  if (/karras/.test(s)) return 'dpm++karras';
  return 'dpm++';
}

export interface CoreMLBuildContext {
  jobId: string;
  model: CoreMLModelInfo;
  /** One per spec.controls entry, already resolved. */
  controlNets: CoreMLControlNetInfo[];
  computeUnits: CoreMLComputeUnits;
  reduceMemory: boolean;
}

/** GenSpec (images as PNG bytes at the model's size) → the IPC request. Pure. */
export function buildCoreMLRequest(spec: GenSpec<Uint8Array>, c: CoreMLBuildContext): CoreMLGenerateRequest {
  if (spec.width !== c.model.width || spec.height !== c.model.height)
    throw new CoreMLResolveError(`Core ML: ${c.model.name} generates ${c.model.width}×${c.model.height} only (got ${spec.width}×${spec.height}).`);
  if (spec.init && !c.model.img2img) throw new CoreMLResolveError(`${c.model.name} has no VAE encoder, so it cannot do img2img.`);
  const req: CoreMLGenerateRequest = {
    jobId: c.jobId,
    modelId: c.model.id,
    computeUnits: c.computeUnits,
    prompt: spec.positive,
    negative: spec.negative,
    seed: spec.seed >>> 0,
    steps: Math.max(1, Math.min(150, Math.round(spec.steps))),
    guidance: spec.cfg,
    scheduler: coremlScheduler(spec.sampler, spec.scheduler),
    controls: spec.controls.map((u, i) => {
      const cn = c.controlNets[i];
      const inpaint = controlNetKind(cn) === 'inpaint' && !!spec.init && !!spec.mask;
      return { controlNetId: cn.id, ...(inpaint ? { maskedCond: true } : { image: u.image }), weight: u.weight, start: u.start, end: u.end };
    }),
    reduceMemory: c.reduceMemory,
  };
  if (spec.init) {
    req.init = spec.init;
    req.strength = Math.max(0.01, Math.min(1, spec.denoise));
    if (spec.mask) req.mask = spec.mask;
  }
  return req;
}

// --------------------------------------------------------------------------------------------- native call
/** Helper errors arrive as “Error invoking remote method 'x': Error: [code] message”. */
export function cleanIpcError(e: unknown): { code: string; message: string } {
  const raw = String((e as Error)?.message ?? e);
  const m = /\[(\w+)\]\s*([\s\S]*)$/.exec(raw);
  if (m) return { code: m[1], message: m[2] };
  return { code: 'error', message: raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') };
}

export async function refreshCoreMLList(): Promise<CoreMLModelList> {
  const api = coremlApi();
  if (!api) throw new CoreMLResolveError('The built-in Core ML engine is only available in the Darkroom Mac app.');
  try {
    const l = await api.listModels();
    setCachedCoreMLList(l);
    return l;
  } catch (e) {
    throw new CoreMLResolveError(cleanIpcError(e).message);
  }
}

export type CoreMLProgress = (phase: string, step: number, total: number, message: string) => void;

/** Run one request; progress via the engine's events; `signal` cancels (queued jobs are dropped, a running one stops at the next step). */
export async function runCoreML(req: CoreMLGenerateRequest, progress: CoreMLProgress, signal?: AbortSignal) {
  const api = coremlApi();
  if (!api) throw new CoreMLResolveError('The built-in Core ML engine is only available in the Darkroom Mac app.');
  const off = api.onEvent((e: CoreMLEvent) => {
    if (e.type === 'job' && e.jobId === req.jobId) progress(e.phase, e.step, e.total, e.message);
  });
  const onAbort = () => api.cancel(req.jobId);
  signal?.addEventListener('abort', onAbort, { once: true });
  const t0 = performance.now();
  console.info(`[darkroom coreml] generate ${req.jobId}: ${req.modelId}, ${req.computeUnits}, ${req.steps} steps, ${req.controls.length} ControlNet(s)${req.init ? `, img2img ${req.strength}` : ''}${req.mask ? ', mask' : ''}`);
  try {
    if (signal?.aborted) throw new DOMException('Generation superseded', 'AbortError');
    const r = await api.generate(req);
    const tm = r.timings;
    console.info(
      `[darkroom coreml] done ${req.jobId} in ${((performance.now() - t0) / 1000).toFixed(1)} s` +
        (r.load ? ` (load ${(r.load.ms / 1000).toFixed(1)} s${r.load.firstLoad ? ', first load/compile' : ''})` : '') +
        ` — denoise ${tm.denoiseMs} ms, ${Number(tm.stepsPerSec ?? 0).toFixed(2)} steps/s`,
    );
    return r;
  } catch (e) {
    if (signal?.aborted) {
      console.info(`[darkroom coreml] cancelled ${req.jobId} (superseded)`);
      throw new DOMException('Generation superseded', 'AbortError');
    }
    const { code, message } = cleanIpcError(e);
    if (code === 'cancelled') throw new DOMException('Generation cancelled', 'AbortError');
    console.error(`[darkroom coreml] ${req.jobId} failed [${code}]: ${message}`);
    throw new CoreMLResolveError(`Core ML: ${message}`);
  } finally {
    off();
    signal?.removeEventListener('abort', onAbort);
  }
}
