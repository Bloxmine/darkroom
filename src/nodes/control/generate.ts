/**
 * sd.generate — "Generate (Stable Diffusion)": sends a txt2img / img2img / inpaint job with up to three
 * ControlNet maps to the user's own ComfyUI or AUTOMATIC1111 server (Preferences › Generation) and shows
 * the result. See src/core/sd and docs/CONTROLNET.md.
 *
 * Never generates while you drag sliders: a job only starts when the hidden `run` token changes (the
 * Generate button in Properties sets it) or with `autoRun` on. Results are cached by every param that
 * affects the image plus fingerprints of the inputs, so preview / export / zoom never re-generate; while
 * params change without a run, the last result of this node stays on screen.
 */
import { setAiTask } from '../../core/ai/runtime';
import { generate, SdError, serverConfig, SERVER_NAMES, type ServerConfig } from '../../core/sd/client';
import {
  buildCoreMLRequest,
  cachedCoreMLList,
  CoreMLResolveError,
  cropOutputSize,
  FIT_MODES,
  fitToModel,
  refreshCoreMLList,
  resolveControlNet,
  resolveModel,
  runCoreML,
  type FitMode,
  type Rect,
} from '../../core/sd/coreml';
import { applyStyle, STYLE_NAMES } from '../../core/sd/styles';
import { loadPrefs } from '../../store/prefs';
import { genSize } from '../../core/sd/size';
import type { GenSpec } from '../../core/sd/types';
import { defineNode } from '../../core/registry';
import type { CpuContext, NodeDef, ParamDef, Params, RawTex, TexSource } from '../../core/types';
import { texFingerprint } from '../ai/face-analysis';
import { makeCanvas } from '../ai/face-draw';
import { CATEGORY } from './_shared';

export const SD_GENERATE = 'sd.generate';
const CONTROLS = ['control1', 'control2', 'control3'] as const;

// ------------------------------------------------------------------------------------------ result memo
interface Entry {
  key: string;
  fp: Uint8Array;
  value: Promise<ImageBitmap>;
  /** Fires when every evaluation waiting on this job was superseded (reference-counted, like InferenceMemo). */
  ctl: AbortController;
  waiters: number;
  done: boolean;
  run: string;
  /** Set when the job resolved, so later evaluations can answer synchronously. */
  bmp?: ImageBitmap;
}
const results: Entry[] = [];
/** Jobs in flight per run token: a superseded evaluation of the same node re-joins it instead of cancelling it. */
const inflightByRun = new Map<string, Entry>();

/** Wait for `e` on behalf of one evaluation; when all waiters are superseded (after a grace period), cancel the job. */
function join(e: Entry, signal?: AbortSignal): Promise<ImageBitmap> {
  e.waiters++;
  if (signal) {
    const leave = () => {
      if (--e.waiters <= 0 && !e.done)
        setTimeout(() => {
          if (e.waiters > 0 || e.done) return;
          console.info('[darkroom sd] cancelled superseded generation');
          e.ctl.abort();
        }, 400);
    };
    if (signal.aborted) leave();
    else signal.addEventListener('abort', leave, { once: true });
  }
  return e.value;
}
/** Last result per run token (= per node, since tokens are unique timestamps): shown while params change. */
const lastByRun = new Map<string, ImageBitmap>();
const consumed = new Set<string>();

function similar(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let sum = 0, max = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    sum += d;
    if (d > max) max = d;
  }
  return a.length === 0 || (sum / a.length < 1.5 && max <= 16);
}
const findResult = (key: string, fp: Uint8Array) => results.find((e) => e.key === key && similar(e.fp, fp) && !e.ctl.signal.aborted);

// ---------------------------------------------------------------------------------------------- helpers
/** RawTex → canvas resized to w×h (opaque). `mask`: the r channel goes to r, g and b (masks only carry r). */
function texToCanvas(t: RawTex, w: number, h: number, mask = false) {
  const id = new ImageData(t.width, t.height);
  const k = t.data instanceof Uint8Array ? 1 : 255;
  for (let i = 0; i < t.width * t.height * 4; i++) {
    const c = i & 3;
    id.data[i] = c === 3 ? 255 : Math.min(255, Math.max(0, t.data[mask ? i - c : i] * k + 0.5));
  }
  const src = makeCanvas(t.width, t.height);
  src.g.putImageData(id, 0, 0);
  const dst = makeCanvas(w, h);
  dst.g.imageSmoothingQuality = 'high';
  dst.g.drawImage(src.canvas as CanvasImageSource, 0, 0, w, h);
  return dst.canvas;
}
async function toPng(t: RawTex, w: number, h: number, mask = false): Promise<Blob> {
  const c = texToCanvas(t, w, h, mask);
  if ('convertToBlob' in c) return c.convertToBlob({ type: 'image/png' });
  return new Promise((res, rej) => (c as HTMLCanvasElement).toBlob((b) => (b ? res(b) : rej(new Error('PNG encoding failed'))), 'image/png'));
}

function placeholder(lines: string[], aspect: number): TexSource {
  const w = 768, h = Math.max(64, Math.round(w / Math.max(0.2, aspect)));
  const { canvas, g } = makeCanvas(w, h);
  g.fillStyle = '#1b1c1f';
  g.fillRect(0, 0, w, h);
  g.strokeStyle = '#3a3c42';
  g.lineWidth = 2;
  g.strokeRect(12, 12, w - 24, h - 24);
  g.fillStyle = '#c9cbd1';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  lines.forEach((l, i) => {
    g.font = i === 0 ? '600 28px -apple-system, "Helvetica Neue", Arial, sans-serif' : '20px -apple-system, "Helvetica Neue", Arial, sans-serif';
    g.fillText(l, w / 2, h / 2 + (i - (lines.length - 1) / 2) * 38, w - 60);
  });
  return canvas;
}

function status(msg: string, kind: 'info' | 'error' = 'info') {
  const ui = (globalThis as { __darkroom?: { ui?: { setState(p: object): void } } }).__darkroom?.ui;
  ui?.setState({ message: msg, messageKind: kind });
}

/** Debug trace of every cpu() decision: localStorage['darkroom.debug.sd'] = '1' (console.info, captured by Diagnostics in verbose mode). */
let dbgOn = false, dbgAt = 0;
function dbg(...a: unknown[]) {
  const now = Date.now();
  if (now - dbgAt > 1000) {
    dbgAt = now;
    try {
      dbgOn = localStorage.getItem('darkroom.debug.sd') === '1';
    } catch {
      dbgOn = false;
    }
  }
  if (dbgOn) console.info('[darkroom sd]', ...a);
}
let cpuCalls = 0;
const hash = (s: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16);
};

const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);

/** The params that change the picture (everything but the trigger / UI-only ones). */
function specKey(cfg: ServerConfig, p: Params, connected: Record<string, boolean>, size: [number, number]) {
  const seed = num(p.seed, -1);
  return JSON.stringify({
    server: `${cfg.kind} ${cfg.url}`,
    ...(cfg.kind === 'coreml' ? { fit: p.fit, units: loadPrefs().coremlUnits } : {}),
    style: p.style, ckpt: p.checkpoint, pos: p.positive, neg: p.negative, steps: p.steps, cfg: p.cfg, sampler: p.sampler, scheduler: p.scheduler,
    seed, rnd: seed < 0 ? p.run : undefined, size,
    denoise: connected.image ? p.denoise : undefined,
    mask: connected.image && connected.mask,
    cn: CONTROLS.map((c, i) => (connected[c] ? [p[`cn${i + 1}Model`], p[`cn${i + 1}Weight`], p[`cn${i + 1}Start`], p[`cn${i + 1}End`]] : null)),
  });
}

let seq = 0;
async function runJob(cfg: ServerConfig, spec: GenSpec<null>, tex: { image?: RawTex; mask?: RawTex; controls: RawTex[] }, signal: AbortSignal): Promise<ImageBitmap> {
  const id = `sd${++seq}`;
  const label = `${SERVER_NAMES[cfg.kind]}: generating`;
  setAiTask(id, { label: `${label} (preparing)`, done: 0, total: spec.steps });
  status(`Generate: sending the job to ${SERVER_NAMES[cfg.kind]} at ${cfg.url}…`);
  const t0 = performance.now();
  try {
    const [W, H] = [spec.width, spec.height];
    const images = {
      init: tex.image ? await toPng(tex.image, W, H) : undefined,
      mask: tex.mask ? await toPng(tex.mask, W, H, true) : undefined,
      controls: await Promise.all(tex.controls.map((c) => toPng(c, W, H))),
    };
    const blob = await generate(cfg, spec, images, (done, total, what) => setAiTask(id, { label: `${label}${what ? ` — ${what}` : ''}`, done, total }), signal);
    const bmp = await createImageBitmap(blob);
    status(`Generate: done in ${((performance.now() - t0) / 1000).toFixed(1)} s (${bmp.width}×${bmp.height}, seed ${spec.seed}).`);
    return bmp;
  } catch (e) {
    if ((e as Error)?.name === 'AbortError' || signal.aborted) {
      status('Generate: cancelled (superseded).');
      throw e;
    }
    const msg = e instanceof SdError ? e.message : `Generate failed: ${(e as Error)?.message ?? e}`;
    status(msg, 'error');
    throw new Error(msg);
  } finally {
    setAiTask(id, null);
  }
}

// ------------------------------------------------------------------------------------------------ Core ML
/** RawTex drawn into a model-size canvas at `draw`; letterbox padding: black for maps/masks, a blurred cover for photos. */
function texToModelCanvas(t: RawTex, W: number, H: number, draw: Rect, kind: 'photo' | 'map' | 'mask') {
  const src = texToCanvas(t, t.width, t.height, kind === 'mask');
  const dst = makeCanvas(W, H);
  const g = dst.g as CanvasRenderingContext2D;
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);
  g.imageSmoothingQuality = 'high';
  if (kind === 'photo' && (draw.w < W - 0.5 || draw.h < H - 0.5)) {
    const s = Math.max(W / t.width, H / t.height);
    g.filter = 'blur(12px)';
    g.drawImage(src as CanvasImageSource, (W - t.width * s) / 2, (H - t.height * s) / 2, t.width * s, t.height * s);
    g.filter = 'none';
  }
  g.drawImage(src as CanvasImageSource, draw.x, draw.y, draw.w, draw.h);
  return dst.canvas;
}
async function canvasPng(c: OffscreenCanvas | HTMLCanvasElement): Promise<Uint8Array> {
  const blob =
    'convertToBlob' in c
      ? await c.convertToBlob({ type: 'image/png' })
      : await new Promise<Blob>((res, rej) => (c as HTMLCanvasElement).toBlob((b) => (b ? res(b) : rej(new Error('PNG encoding failed'))), 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

const PHASE_LABEL: Record<string, string> = {
  queued: 'queued',
  planning: 'planning',
  compiling: 'compiling for the Neural Engine (first use, can take minutes)',
  loading: 'loading the model',
  encoding: 'encoding',
  denoising: 'denoising',
  decoding: 'decoding',
};

async function runCoreMLJob(spec: GenSpec<null>, tex: { image?: RawTex; mask?: RawTex; controls: RawTex[] }, fit: FitMode, signal: AbortSignal): Promise<ImageBitmap> {
  const id = `sd${++seq}`;
  const jobId = `${id}-${Date.now().toString(36)}`;
  setAiTask(id, { label: 'Core ML: generating (preparing)', done: 0, total: spec.steps });
  status('Generate: preparing the Core ML job…');
  const t0 = performance.now();
  try {
    const list = cachedCoreMLList() ?? (await refreshCoreMLList());
    const model = resolveModel(spec.checkpoint, list, spec.controls.length > 0);
    const cns = spec.controls.map((c) => resolveControlNet(c.model, model, list));
    const W = model.width, H = model.height;
    const ref = tex.image ?? tex.controls[0];
    const f = fitToModel(ref?.width ?? W, ref?.height ?? H, W, H, fit);
    const png = (t: RawTex, kind: 'photo' | 'map' | 'mask') => canvasPng(texToModelCanvas(t, W, H, f.draw, kind));
    const prefs = loadPrefs();
    const req = buildCoreMLRequest(
      {
        ...spec,
        width: W,
        height: H,
        init: tex.image ? await png(tex.image, 'photo') : undefined,
        mask: tex.image && tex.mask ? await png(tex.mask, 'mask') : undefined,
        controls: await Promise.all(spec.controls.map(async (c, i) => ({ ...c, image: await png(tex.controls[i], 'map') }))),
      },
      { jobId, model, controlNets: cns, computeUnits: prefs.coremlUnits, reduceMemory: prefs.coremlReduceMemory },
    );
    const res = await runCoreML(
      req,
      (phase, step, total, message) => {
        setAiTask(id, { label: `Core ML: ${PHASE_LABEL[phase] ?? phase}${phase === 'denoising' ? '' : '…'}`, done: phase === 'denoising' ? step : 0, total: phase === 'denoising' ? total : 1 });
        if (phase === 'compiling' || phase === 'planning' || phase === 'queued') status(`Generate: ${message}`);
      },
      signal,
    );
    const blob = new Blob([res.png as BlobPart], { type: 'image/png' });
    const k = f.keep;
    const bmp = k.x === 0 && k.y === 0 && k.w === res.width && k.h === res.height ? await createImageBitmap(blob) : await createImageBitmap(blob, k.x, k.y, k.w, k.h);
    const sps = res.timings.stepsPerSec ? `, ${Number(res.timings.stepsPerSec).toFixed(2)} steps/s` : '';
    const ld = res.load ? ` Model ${res.load.firstLoad ? 'compiled' : 'loaded'} in ${(res.load.ms / 1000).toFixed(1)} s.${res.load.note ? ' ' + res.load.note : ''}` : '';
    status(`Generate: Core ML done in ${((performance.now() - t0) / 1000).toFixed(1)} s (${model.name}, ${W}×${H}${sps}, seed ${res.seed}).${ld}`);
    return bmp;
  } catch (e) {
    if ((e as Error)?.name === 'AbortError' || signal.aborted) {
      status('Generate: cancelled.');
      throw e;
    }
    const msg = e instanceof CoreMLResolveError || e instanceof SdError ? (e as Error).message : `Generate failed: ${(e as Error)?.message ?? e}`;
    status(msg, 'error');
    throw new Error(msg);
  } finally {
    setAiTask(id, null);
  }
}

/** Crop mode on Core ML: the node outputs the centre crop at the model's aspect. */
function coremlCropSize(p: Params, w: number, h: number): [number, number] | null {
  if (p.fit !== 'crop') return null;
  if (loadPrefs().genServer !== 'coreml') return null;
  const l = cachedCoreMLList();
  if (!l) return null;
  try {
    const m = resolveModel(String(p.checkpoint ?? ''), l, false);
    return cropOutputSize(w, h, m.width, m.height);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------------------------------------- node
const unitParams = (i: number): Record<string, ParamDef> => ({
  [`cn${i}Model`]: { type: 'string', default: '', label: `ControlNet ${i} model`, description: `ControlNet model (file name as the server lists it) applied with the map on “control${i}”. Pick one from the list under Generate.` },
  [`cn${i}Weight`]: { type: 'float', default: 1, min: 0, max: 2, step: 0.01, label: `ControlNet ${i} weight` },
  [`cn${i}Start`]: { type: 'float', default: 0, min: 0, max: 1, step: 0.01, label: `ControlNet ${i} start` },
  [`cn${i}End`]: { type: 'float', default: 1, min: 0, max: 1, step: 0.01, label: `ControlNet ${i} end` },
});

const gen = defineNode({
  id: SD_GENERATE,
  name: 'Generate (Stable Diffusion)',
  category: CATEGORY,
  color: '#7fb0ff',
  heavy: true,
  description:
    'Generates an image with Stable Diffusion + ControlNet on your own ComfyUI or AUTOMATIC1111 / Forge server, or in the Mac app with the built-in Core ML engine (Preferences › Generation; off by default). ' +
    'Connect control maps (Canny, Depth, OpenPose…) to control1–3 and pick a ControlNet model for each; connect “image” for img2img (denoise) and “mask” to inpaint. ' +
    'Nothing is sent until you press Generate (or turn on Auto-run): then the prompts and connected images go to that server only. Results are cached, so tweaking other nodes, zooming or exporting never re-generates.',
  tags: ['stable diffusion', 'sd', 'sdxl', 'generate', 'controlnet', 'comfyui', 'automatic1111', 'a1111', 'forge', 'img2img', 'inpaint', 'txt2img', 'ai', 'core ml', 'coreml', 'neural engine', 'style'],
  inputs: {
    image: { type: 'image', label: 'Init image (img2img)', optional: true },
    control1: { type: 'image', label: 'Control 1', optional: true },
    control2: { type: 'image', label: 'Control 2', optional: true },
    control3: { type: 'image', label: 'Control 3', optional: true },
    mask: { type: 'mask', label: 'Inpaint mask', optional: true, fallback: 'black' },
  },
  params: {
    positive: { type: 'string', default: 'a photo, highly detailed, natural light', multiline: true, label: 'Prompt' },
    negative: { type: 'string', default: 'blurry, lowres, deformed, watermark, text', multiline: true, label: 'Negative prompt' },
    style: {
      type: 'enum',
      default: 'none',
      options: STYLE_NAMES,
      label: 'Style',
      description: 'Appends a curated style to the prompt (and its opposite to the negative prompt): oil painting, watercolor, anime cel, pencil sketch, cinematic photo, pixel art, riso print…',
    },
    checkpoint: { type: 'string', default: '', label: 'Checkpoint', description: 'Model file as the server lists it (pick from the list under Generate). Empty = the A1111 current model; ComfyUI needs one.' },
    steps: { type: 'int', default: 20, min: 1, max: 150, step: 1, label: 'Steps' },
    cfg: { type: 'float', default: 7, min: 1, max: 30, step: 0.1, label: 'CFG scale' },
    sampler: { type: 'string', default: '', label: 'Sampler', description: 'Empty = server default (ComfyUI euler, A1111 its default).' },
    scheduler: { type: 'string', default: '', label: 'Scheduler', description: 'Empty = server default (ComfyUI normal, A1111 automatic).' },
    seed: { type: 'int', default: -1, min: -1, max: 2147483647, step: 1, label: 'Seed', description: '−1 = a new random seed for every Generate.' },
    denoise: { type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, label: 'Denoise (img2img)', description: 'Only with an init image: 0 = keep it, 1 = ignore it.' },
    baseSize: { type: 'enum', default: '512', options: ['512', '768', '1024'], label: 'Base size', description: 'With width/height 0: short side of the generated image (512 for SD 1.5, 1024 for SDXL); the aspect follows the input.' },
    width: { type: 'int', default: 0, min: 0, max: 2048, step: 8, label: 'Width', description: '0 = match the input aspect (see Base size). Rounded to multiples of 8.' },
    height: { type: 'int', default: 0, min: 0, max: 2048, step: 8, label: 'Height' },
    fit: {
      type: 'enum',
      default: 'letterbox',
      options: FIT_MODES,
      label: 'Fit (Core ML)',
      description:
        'Core ML models generate one fixed size (e.g. 512×512). letterbox: the whole input fits, the result is cropped back to its aspect · crop: the centre is generated at full model resolution and the output is that crop · stretch: squash to the model size and stretch back. Width/height/base size are ignored on Core ML.',
    },
    ...unitParams(1),
    ...unitParams(2),
    ...unitParams(3),
    autoRun: { type: 'bool', default: false, label: 'Auto-run', description: 'Generate whenever something changes (after a short pause). Off = only the Generate button.' },
    run: { type: 'string', default: '', hidden: true, label: 'Run token', description: 'Set by the Generate button.' },
  },
  size: ({ params, inputSizes, projectSize }) => {
    const s = inputSizes.image ?? inputSizes.control1 ?? inputSizes.control2 ?? inputSizes.control3 ?? projectSize;
    return coremlCropSize(params, s.width, s.height) ?? [s.width, s.height];
  },
  cpuReadsInputs: true,
  // Not `async` on purpose: every answer that needs no running job (cached result, last result, placeholder) is
  // returned synchronously. An async answer leaves the node pending for a tick, and when two renders of different
  // scales alternate in one cache namespace (export / renderReady at 1 vs the viewer at its preview scale), each
  // pending run is replaced by the other and its completion re-invalidates the viewer — an endless re-evaluation
  // loop (flicker, export never finishing). A Promise is returned only while a generation is really in flight.
  cpu: (ctx: CpuContext) => {
    const p = ctx.params;
    const read = (k: string) => ctx.readInput(k);
    const tex = { image: read('image') ?? undefined, mask: read('mask') ?? undefined, controls: CONTROLS.map(read) };
    const any = tex.image ?? tex.controls.find(Boolean);
    const aspect = any ? any.width / any.height : ctx.projectSize.width / Math.max(1, ctx.projectSize.height);
    const run = String(p.run ?? '');
    const cfg = serverConfig();
    if (!cfg) return { gen: lastByRun.get(run) ?? placeholder(['Generation is off', 'Choose a server or Core ML in Preferences › Generation'], aspect) };

    const connected: Record<string, boolean> = { image: !!tex.image, mask: !!tex.mask };
    CONTROLS.forEach((c, i) => (connected[c] = !!tex.controls[i]));
    const size = genSize(p, aspect);
    const key = specKey(cfg, p, connected, size);
    const fps = [tex.image, tex.mask, ...tex.controls].map((t) => (t ? texFingerprint(t) : new Uint8Array(0)));
    const fp = new Uint8Array(fps.reduce((a, f) => a + f.length, 0));
    fps.reduce((o, f) => (fp.set(f, o), o + f.length), 0);

    const hit = findResult(key, fp);
    const triggered = (run !== '' && !consumed.has(run)) || p.autoRun === true;
    dbg(`cpu#${++cpuCalls} node=${ctx.nodeId ?? '?'} scale=${ctx.scale} key=${hash(key)} fp=${hash(Array.from(fp.subarray(0, 64)).join(','))} in=${[tex.image, ...tex.controls].map((t) => (t ? `${t.width}x${t.height}` : '-')).join(',')} hit=${!!hit} triggered=${triggered} run=${run}`);
    const signal = ctx.signal;
    if (hit?.bmp) {
      if (run) lastByRun.set(run, hit.bmp);
      return { gen: hit.bmp };
    }
    // Core ML with no usable model installed: a static message, never a retry
    const cml = cfg.kind === 'coreml' ? cachedCoreMLList() : null;
    const noModel = !!cml && !cml.models.some((m) => m.kind !== 'sdxl');
    if (!hit && !triggered) {
      // this node's job is still running (a param changed meanwhile): keep waiting for it rather than cancelling it
      const flying = inflightByRun.get(run);
      if (flying && !flying.done && !flying.ctl.signal.aborted) {
        return join(flying, signal).then((bmp) => {
          lastByRun.set(run, bmp);
          if (flying.key !== key) status('Generate: settings changed — press Generate to update the image.');
          return { gen: bmp };
        });
      }
      const last = lastByRun.get(run);
      if (last && results.find((e) => e.run === run)?.key !== key) status('Generate: settings changed — press Generate to update the image.');
      if (!last && noModel) return { gen: placeholder(['No Core ML model installed', 'Install one in Preferences › Generation'], aspect) };
      return { gen: last ?? placeholder(['Press Generate', cfg.kind === 'coreml' ? 'Core ML (built-in)' : `${SERVER_NAMES[cfg.kind]} · ${cfg.url}`, 'in the Properties panel'], aspect) };
    }
    if (hit) return join(hit, signal).then((bmp) => (run && lastByRun.set(run, bmp), { gen: bmp }));
    const autoDebounce = p.autoRun === true && !(run !== '' && !consumed.has(run));
    if (noModel) {
      if (run) consumed.add(run);
      status('Generate: no Core ML model is installed. Download one in Preferences › Generation › Core ML (built-in).', 'error');
      return { gen: lastByRun.get(run) ?? placeholder(['No Core ML model installed', 'Install one in Preferences › Generation'], aspect) };
    }
    const start = () => {
      if (run) consumed.add(run);
      // a unit at weight 0 is off (presets use that for optional ones): it needs no model
      const units = CONTROLS.map((_, i) => ({ i, t: tex.controls[i] })).filter((u) => u.t && num(p[`cn${u.i + 1}Weight`], 1) !== 0);
      const missing = units.find((u) => !String(p[`cn${u.i + 1}Model`] ?? '').trim());
      if (missing) throw new Error(`Generate: choose a ControlNet model for control${missing.i + 1} (ControlNet ${missing.i + 1} model).`);
      if (cfg.kind === 'comfyui' && !String(p.checkpoint ?? '').trim()) throw new Error('Generate: choose a checkpoint (ComfyUI needs one). Use Test connection under Generate to list them.');
      const seed = num(p.seed, -1) >= 0 ? Math.floor(num(p.seed, 0)) : Math.floor(Math.random() * 2 ** 31);
      const styled = applyStyle(String(p.style ?? 'none'), String(p.positive ?? ''), String(p.negative ?? ''));
      const spec: GenSpec<null> = {
        checkpoint: String(p.checkpoint ?? '').trim(),
        positive: styled.positive,
        negative: styled.negative,
        steps: Math.max(1, Math.round(num(p.steps, 20))),
        cfg: num(p.cfg, 7),
        sampler: String(p.sampler ?? '').trim(),
        scheduler: String(p.scheduler ?? '').trim(),
        seed,
        width: size[0],
        height: size[1],
        init: tex.image ? null : undefined,
        mask: tex.image && tex.mask ? null : undefined,
        denoise: num(p.denoise, 0.6),
        controls: units.map((u) => ({
          image: null,
          model: String(p[`cn${u.i + 1}Model`]).trim(),
          weight: num(p[`cn${u.i + 1}Weight`], 1),
          start: num(p[`cn${u.i + 1}Start`], 0),
          end: num(p[`cn${u.i + 1}End`], 1),
        })),
      };
      const ctl = new AbortController();
      const e: Entry = { key, fp, ctl, waiters: 0, done: false, run, value: undefined as unknown as Promise<ImageBitmap> };
      const jobTex = { image: tex.image, mask: tex.image ? tex.mask : undefined, controls: units.map((u) => u.t!) };
      const fit = (FIT_MODES as string[]).includes(String(p.fit)) ? (p.fit as FitMode) : 'letterbox';
      e.value = (cfg.kind === 'coreml' ? runCoreMLJob(spec, jobTex, fit, ctl.signal) : runJob(cfg, spec, jobTex, ctl.signal)).finally(() => {
        e.done = true;
        if (inflightByRun.get(run) === e) inflightByRun.delete(run);
      });
      if (run) inflightByRun.set(run, e);
      results.unshift(e);
      if (results.length > 24) results.length = 24;
      e.value.then(
        (bmp) => (e.bmp = bmp),
        () => {
          const i = results.indexOf(e);
          if (i >= 0) results.splice(i, 1);
        },
      );
      return join(e, signal).then((bmp) => (run && lastByRun.set(run, bmp), { gen: bmp }));
    };
    if (!autoDebounce) return start();
    // auto-run: wait for the user to stop dragging; a newer evaluation aborts this one
    return new Promise<void>((r) => setTimeout(r, 700)).then(() => (signal?.aborted ? { gen: lastByRun.get(run) ?? placeholder(['…'], aspect) } : start()));
  },
  passes: [{ frag: `void main() { fragColor = vec4(texture(u_gen, v_uv).rgb, 1.0); }` }],
});

export default [gen] satisfies NodeDef[];
