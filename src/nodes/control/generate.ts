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

const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);

/** The params that change the picture (everything but the trigger / UI-only ones). */
function specKey(cfg: ServerConfig, p: Params, connected: Record<string, boolean>, size: [number, number]) {
  const seed = num(p.seed, -1);
  return JSON.stringify({
    server: `${cfg.kind} ${cfg.url}`,
    ckpt: p.checkpoint, pos: p.positive, neg: p.negative, steps: p.steps, cfg: p.cfg, sampler: p.sampler, scheduler: p.scheduler,
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
    'Generates an image with Stable Diffusion + ControlNet on your own ComfyUI or AUTOMATIC1111 / Forge server (Preferences › Generation; off by default). ' +
    'Connect control maps (Canny, Depth, OpenPose…) to control1–3 and pick a ControlNet model for each; connect “image” for img2img (denoise) and “mask” to inpaint. ' +
    'Nothing is sent until you press Generate (or turn on Auto-run): then the prompts and connected images go to that server only. Results are cached, so tweaking other nodes, zooming or exporting never re-generates.',
  tags: ['stable diffusion', 'sd', 'sdxl', 'generate', 'controlnet', 'comfyui', 'automatic1111', 'a1111', 'forge', 'img2img', 'inpaint', 'txt2img', 'ai'],
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
    ...unitParams(1),
    ...unitParams(2),
    ...unitParams(3),
    autoRun: { type: 'bool', default: false, label: 'Auto-run', description: 'Generate whenever something changes (after a short pause). Off = only the Generate button.' },
    run: { type: 'string', default: '', hidden: true, label: 'Run token', description: 'Set by the Generate button.' },
  },
  size: ({ inputSizes, projectSize }) => {
    const s = inputSizes.image ?? inputSizes.control1 ?? inputSizes.control2 ?? inputSizes.control3 ?? projectSize;
    return [s.width, s.height];
  },
  cpuReadsInputs: true,
  cpu: async (ctx: CpuContext) => {
    const p = ctx.params;
    const read = (k: string) => ctx.readInput(k);
    const tex = { image: read('image') ?? undefined, mask: read('mask') ?? undefined, controls: CONTROLS.map(read) };
    const any = tex.image ?? tex.controls.find(Boolean);
    const aspect = any ? any.width / any.height : ctx.projectSize.width / Math.max(1, ctx.projectSize.height);
    const run = String(p.run ?? '');
    const cfg = serverConfig();
    if (!cfg) return { gen: lastByRun.get(run) ?? placeholder(['Generation is off', 'Choose ComfyUI or AUTOMATIC1111 in Preferences › Generation'], aspect) };

    const connected: Record<string, boolean> = { image: !!tex.image, mask: !!tex.mask };
    CONTROLS.forEach((c, i) => (connected[c] = !!tex.controls[i]));
    const size = genSize(p, aspect);
    const key = specKey(cfg, p, connected, size);
    const fps = [tex.image, tex.mask, ...tex.controls].map((t) => (t ? texFingerprint(t) : new Uint8Array(0)));
    const fp = new Uint8Array(fps.reduce((a, f) => a + f.length, 0));
    fps.reduce((o, f) => (fp.set(f, o), o + f.length), 0);

    const hit = findResult(key, fp);
    const triggered = (run !== '' && !consumed.has(run)) || p.autoRun === true;
    const signal = ctx.signal;
    if (!hit && !triggered) {
      // this node's job is still running (a param changed meanwhile): keep waiting for it rather than cancelling it
      const flying = inflightByRun.get(run);
      if (flying && !flying.done && !flying.ctl.signal.aborted) {
        const bmp = await join(flying, signal);
        lastByRun.set(run, bmp);
        if (flying.key !== key) status('Generate: settings changed — press Generate to update the image.');
        return { gen: bmp };
      }
      const last = lastByRun.get(run);
      if (last && results.find((e) => e.run === run)?.key !== key) status('Generate: settings changed — press Generate to update the image.');
      return { gen: last ?? placeholder(['Press Generate', `${SERVER_NAMES[cfg.kind]} · ${cfg.url}`, 'in the Properties panel'], aspect) };
    }
    let entry = hit;
    if (!entry) {
      if (p.autoRun === true && !(run !== '' && !consumed.has(run))) {
        // auto-run: wait for the user to stop dragging; a newer evaluation aborts this one
        await new Promise((r) => setTimeout(r, 700));
        if (signal?.aborted) return { gen: lastByRun.get(run) ?? placeholder(['…'], aspect) };
      }
      if (run) consumed.add(run);
      const units = CONTROLS.map((_, i) => ({ i, t: tex.controls[i] })).filter((u) => u.t);
      const missing = units.find((u) => !String(p[`cn${u.i + 1}Model`] ?? '').trim());
      if (missing) throw new Error(`Generate: choose a ControlNet model for control${missing.i + 1} (ControlNet ${missing.i + 1} model).`);
      if (cfg.kind === 'comfyui' && !String(p.checkpoint ?? '').trim()) throw new Error('Generate: choose a checkpoint (ComfyUI needs one). Use Test connection under Generate to list them.');
      const seed = num(p.seed, -1) >= 0 ? Math.floor(num(p.seed, 0)) : Math.floor(Math.random() * 2 ** 31);
      const spec: GenSpec<null> = {
        checkpoint: String(p.checkpoint ?? '').trim(),
        positive: String(p.positive ?? ''),
        negative: String(p.negative ?? ''),
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
      e.value = runJob(cfg, spec, { image: tex.image, mask: tex.image ? tex.mask : undefined, controls: units.map((u) => u.t!) }, ctl.signal).finally(() => {
        e.done = true;
        if (inflightByRun.get(run) === e) inflightByRun.delete(run);
      });
      if (run) inflightByRun.set(run, e);
      entry = e;
      results.unshift(entry);
      if (results.length > 24) results.length = 24;
      e.value.catch(() => {
        const i = results.indexOf(e);
        if (i >= 0) results.splice(i, 1);
      });
    }
    const bmp = await join(entry, signal);
    if (run) lastByRun.set(run, bmp);
    return { gen: bmp };
  },
  passes: [{ frag: `void main() { fragColor = vec4(texture(u_gen, v_uv).rgb, 1.0); }` }],
});

export default [gen] satisfies NodeDef[];
