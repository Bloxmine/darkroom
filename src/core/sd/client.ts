/**
 * Generation bridge client: talks to the user's own ComfyUI or AUTOMATIC1111 (Forge / SD.Next) server.
 *
 * Privacy: nothing is sent anywhere unless the user picks a server in Preferences › Generation *and* runs an
 * sd.generate node; then the node's input images (init image, control maps, mask) and prompts go to that URL
 * and nowhere else. Requests are plain browser fetches, so the server has to allow this page's origin (CORS):
 * ComfyUI `--enable-cors-header`, A1111 `--api --cors-allow-origins=<origin>` (docs/CONTROLNET.md).
 */
import { loadPrefs } from '../../store/prefs';
import { buildA1111Payload } from './a1111';
import { buildComfyWorkflow, COMFY_OUTPUT_NODE } from './comfy';
import type { GenSpec, ServerKind, ServerLists } from './types';

export interface ServerConfig {
  kind: ServerKind;
  url: string;
}

export const DEFAULT_URLS: Record<ServerKind, string> = { comfyui: 'http://127.0.0.1:8188', a1111: 'http://127.0.0.1:7860' };
export const SERVER_NAMES: Record<ServerKind, string> = { comfyui: 'ComfyUI', a1111: 'AUTOMATIC1111' };

/** The configured server, or null when generation is off (the default). */
export function serverConfig(): ServerConfig | null {
  const p = loadPrefs();
  if (p.genServer === 'off') return null;
  const kind = p.genServer;
  const url = (kind === 'comfyui' ? p.genUrlComfy : p.genUrlA1111).trim() || DEFAULT_URLS[kind];
  return { kind, url: url.replace(/\/+$/, '') };
}

/** Loopback or private-LAN host (the only kind the UI suggests; any URL the user types is still allowed). */
export function isLocalUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return (
      h === 'localhost' || h.endsWith('.local') || h === '::1' || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^169\.254\./.test(h) || /^f[cd][0-9a-f]{2}:/i.test(h)
    );
  } catch {
    return false;
  }
}

export function corsHint(kind: ServerKind): string {
  const origin = typeof location !== 'undefined' ? location.origin : '*';
  return kind === 'comfyui'
    ? `Start ComfyUI with --enable-cors-header (or --enable-cors-header ${origin}).`
    : `Start the WebUI with --api --cors-allow-origins=${origin}.`;
}

export class SdError extends Error {}

/** fetch with a timeout and readable errors (unreachable / CORS / HTTP status with the server's message). */
async function call(cfg: ServerConfig, path: string, init: RequestInit = {}, timeoutMs = 30000, cancel?: AbortSignal): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  let res: Response;
  try {
    throwIfCancelled(cancel);
    res = await fetch(cfg.url + path, { ...init, signal: cancel ? AbortSignal.any([ctl.signal, cancel]) : ctl.signal, mode: 'cors', credentials: 'omit' });
  } catch (e) {
    const name = SERVER_NAMES[cfg.kind];
    throwIfCancelled(cancel);
    if ((e as Error)?.name === 'AbortError') throw new SdError(`${name} at ${cfg.url} did not answer within ${Math.round(timeoutMs / 1000)} s (${path}).`);
    const mixed = typeof location !== 'undefined' && location.protocol === 'https:' && cfg.url.startsWith('http:') && !/^http:\/\/(localhost|127\.|\[::1\])/.test(cfg.url);
    throw new SdError(
      `Could not reach ${name} at ${cfg.url}. Is it running? The browser also blocks it unless CORS is enabled: ${corsHint(cfg.kind)}` +
        (mixed ? ' This page is HTTPS, so a plain-HTTP LAN address is blocked as mixed content: use localhost, HTTPS, or the Mac app.' : ''),
    );
  } finally {
    clearTimeout(t);
  }
  if (!res.ok) {
    let detail = '';
    try {
      const txt = await res.text();
      try {
        const j = JSON.parse(txt);
        detail = j?.error?.message ?? j?.error ?? j?.detail ?? j?.message ?? txt;
        if (j?.node_errors && Object.keys(j.node_errors).length) {
          detail += ' — ' + Object.entries(j.node_errors as Record<string, { errors?: { message?: string; details?: string }[]; class_type?: string }>)
            .map(([id, ne]) => `${ne.class_type ?? id}: ${(ne.errors ?? []).map((x) => `${x.message}${x.details ? ` (${x.details})` : ''}`).join('; ')}`)
            .join(' | ');
        }
        if (typeof detail !== 'string') detail = JSON.stringify(detail);
      } catch {
        detail = txt;
      }
    } catch {
      /* ignore */
    }
    throw new SdError(`${SERVER_NAMES[cfg.kind]} ${path}: HTTP ${res.status}${detail ? ` — ${String(detail).slice(0, 400)}` : ''}`);
  }
  return res;
}
const json = async <T>(cfg: ServerConfig, path: string, init?: RequestInit, timeoutMs?: number, cancel?: AbortSignal) => (await call(cfg, path, init, timeoutMs, cancel)).json() as Promise<T>;

function throwIfCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Generation superseded', 'AbortError');
}
const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(new DOMException('Generation superseded', 'AbortError'))), { once: true });
  });

// ---------------------------------------------------------------------------------- lists (Test connection)
type ObjectInfo = Record<string, { input?: { required?: Record<string, unknown[]> } }>;
const comfyOptions = (info: ObjectInfo, node: string, input: string): string[] => {
  const v = info[node]?.input?.required?.[input]?.[0];
  if (Array.isArray(v)) return v.map(String);
  // newer ComfyUI: ["COMBO", { options: [...] }]
  const o = info[node]?.input?.required?.[input]?.[1] as { options?: unknown[] } | undefined;
  return Array.isArray(o?.options) ? o!.options.map(String) : [];
};

export async function fetchLists(cfg: ServerConfig): Promise<ServerLists> {
  if (cfg.kind === 'comfyui') {
    const [ck, cn, ks] = await Promise.all([
      json<ObjectInfo>(cfg, '/object_info/CheckpointLoaderSimple', undefined, 10000),
      json<ObjectInfo>(cfg, '/object_info/ControlNetLoader', undefined, 10000).catch(() => ({}) as ObjectInfo),
      json<ObjectInfo>(cfg, '/object_info/KSampler', undefined, 10000),
    ]);
    return {
      checkpoints: comfyOptions(ck, 'CheckpointLoaderSimple', 'ckpt_name'),
      controlnets: comfyOptions(cn, 'ControlNetLoader', 'control_net_name'),
      samplers: comfyOptions(ks, 'KSampler', 'sampler_name'),
      schedulers: comfyOptions(ks, 'KSampler', 'scheduler'),
    };
  }
  const [models, cn, samplers, schedulers] = await Promise.all([
    json<{ title: string; model_name: string }[]>(cfg, '/sdapi/v1/sd-models', undefined, 10000),
    json<{ model_list?: string[] }>(cfg, '/controlnet/model_list', undefined, 10000).catch(() => ({ model_list: [] as string[] })),
    json<{ name: string }[]>(cfg, '/sdapi/v1/samplers', undefined, 10000).catch(() => []),
    json<{ name: string; label?: string }[]>(cfg, '/sdapi/v1/schedulers', undefined, 10000).catch(() => []),
  ]);
  return {
    checkpoints: models.map((m) => m.title || m.model_name),
    controlnets: (cn.model_list ?? []).filter((m) => m && m !== 'None'),
    samplers: samplers.map((s) => s.name),
    schedulers: schedulers.map((s) => s.name),
  };
}

// ------------------------------------------------------------------------------------- shared list store
const LISTS_KEY = 'darkroom.sd.lists';
interface ListState {
  server?: string;
  lists?: ServerLists;
  status: 'idle' | 'testing' | 'ok' | 'error';
  message?: string;
}
let listState: ListState = (() => {
  try {
    const j = JSON.parse(localStorage.getItem(LISTS_KEY) ?? 'null');
    if (j?.lists) return { server: j.server, lists: j.lists, status: 'idle' as const };
  } catch {
    /* none */
  }
  return { status: 'idle' as const };
})();
const subs = new Set<() => void>();
export const getListState = () => listState;
export function subscribeLists(fn: () => void) {
  subs.add(fn);
  return () => void subs.delete(fn);
}
function setLists(s: ListState) {
  listState = s;
  subs.forEach((f) => f());
}

/** Test the connection: fetches checkpoints / ControlNets / samplers / schedulers and remembers them for the pickers. */
export async function testConnection(cfg: ServerConfig | null = serverConfig()): Promise<ServerLists> {
  if (!cfg) throw new SdError('Generation is off. Choose ComfyUI or AUTOMATIC1111 in Preferences › Generation.');
  const server = `${cfg.kind} ${cfg.url}`;
  setLists({ ...listState, status: 'testing', message: undefined });
  try {
    const lists = await fetchLists(cfg);
    setLists({ server, lists, status: 'ok', message: `Connected to ${SERVER_NAMES[cfg.kind]}: ${lists.checkpoints.length} checkpoints, ${lists.controlnets.length} ControlNet models.` });
    try {
      localStorage.setItem(LISTS_KEY, JSON.stringify({ server, lists }));
    } catch {
      /* ignore */
    }
    return lists;
  } catch (e) {
    setLists({ ...listState, status: 'error', message: String((e as Error)?.message ?? e) });
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------- generate
export interface GenImages {
  init?: Blob;
  mask?: Blob;
  controls: Blob[];
}

export interface GenProgress {
  (done: number, total: number, label?: string): void;
}

const b64 = async (blob: Blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/**
 * Run one generation; resolves with the result image (PNG/JPEG/WebP blob). `signal` stops waiting (uploads, polling,
 * the A1111 request); a ComfyUI job that has not started yet is also removed from the server's queue.
 */
export async function generate(cfg: ServerConfig, spec: GenSpec<null>, images: GenImages, progress: GenProgress, signal?: AbortSignal): Promise<Blob> {
  return cfg.kind === 'comfyui' ? generateComfy(cfg, spec, images, progress, signal) : generateA1111(cfg, spec, images, progress, signal);
}

async function generateComfy(cfg: ServerConfig, spec: GenSpec<null>, images: GenImages, progress: GenProgress, signal?: AbortSignal): Promise<Blob> {
  const clientId = 'darkroom-' + Math.random().toString(36).slice(2, 10);
  const upload = async (blob: Blob, role: string) => {
    const fd = new FormData();
    fd.append('image', blob, `darkroom_${role}_${Date.now().toString(36)}.png`);
    fd.append('type', 'input');
    fd.append('overwrite', 'true');
    const r = await json<{ name: string; subfolder?: string }>(cfg, '/upload/image', { method: 'POST', body: fd }, 60000, signal);
    return r.subfolder ? `${r.subfolder}/${r.name}` : r.name;
  };
  progress(0, spec.steps, 'Uploading images…');
  const init = images.init ? await upload(images.init, 'init') : undefined;
  const mask = images.init && images.mask ? await upload(images.mask, 'mask') : undefined;
  const controls = await Promise.all(spec.controls.map(async (c, i) => ({ ...c, image: await upload(images.controls[i], `control${i + 1}`) })));
  const wf = buildComfyWorkflow({ ...spec, init, mask, controls });

  // progress over the websocket (optional: polling /history is what decides completion)
  let ws: WebSocket | null = null;
  let promptId = '';
  let wsError = '';
  try {
    ws = new WebSocket(cfg.url.replace(/^http/, 'ws') + '/ws?clientId=' + encodeURIComponent(clientId));
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return; // binary preview frames
      try {
        const m = JSON.parse(ev.data) as { type: string; data?: { prompt_id?: string; value?: number; max?: number; exception_message?: string } };
        if (m.data?.prompt_id && promptId && m.data.prompt_id !== promptId) return;
        if (m.type === 'progress' && m.data?.max) progress(m.data.value ?? 0, m.data.max, 'Generating…');
        if (m.type === 'execution_error') wsError = m.data?.exception_message ?? 'execution error';
      } catch {
        /* ignore */
      }
    };
    ws.onerror = () => {};
  } catch {
    ws = null;
  }
  try {
    const q = await json<{ prompt_id: string }>(cfg, '/prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: wf, client_id: clientId }) }, 30000, signal);
    promptId = q.prompt_id;
    progress(0, spec.steps, 'Queued…');
    const t0 = Date.now();
    for (;;) {
      await wait(750, signal).catch((e) => {
        // superseded: drop the job if it is still queued (a running one finishes; its result is simply not shown)
        void call(cfg, '/queue', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ delete: [promptId] }) }, 5000).catch(() => {});
        throw e;
      });
      if (wsError) throw new SdError(`ComfyUI: ${wsError}`);
      const h = await json<Record<string, { status?: { status_str?: string; completed?: boolean; messages?: [string, { exception_message?: string }][] }; outputs?: Record<string, { images?: { filename: string; subfolder: string; type: string }[] }> }>>(
        cfg,
        '/history/' + encodeURIComponent(promptId),
        undefined,
        30000,
        signal,
      );
      const e = h[promptId];
      if (e) {
        if (e.status?.status_str === 'error') {
          const msg = e.status.messages?.find((m) => m[0] === 'execution_error')?.[1]?.exception_message;
          throw new SdError(`ComfyUI: ${msg ?? 'the workflow failed'}`);
        }
        const img = e.outputs?.[COMFY_OUTPUT_NODE]?.images?.[0] ?? Object.values(e.outputs ?? {}).flatMap((o) => o.images ?? [])[0];
        if (img) {
          const qs = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder ?? '', type: img.type ?? 'output' });
          return await (await call(cfg, '/view?' + qs.toString(), {}, 60000, signal)).blob();
        }
        if (e.status?.completed) throw new SdError('ComfyUI finished without an output image.');
      }
      if (Date.now() - t0 > 30 * 60 * 1000) throw new SdError('ComfyUI: gave up waiting after 30 minutes.');
    }
  } finally {
    ws?.close();
  }
}

async function generateA1111(cfg: ServerConfig, spec: GenSpec<null>, images: GenImages, progress: GenProgress, signal?: AbortSignal): Promise<Blob> {
  const init = images.init ? await b64(images.init) : undefined;
  const mask = images.init && images.mask ? await b64(images.mask) : undefined;
  const controls = await Promise.all(spec.controls.map(async (c, i) => ({ ...c, image: await b64(images.controls[i]) })));
  const req = buildA1111Payload({ ...spec, init, mask, controls });
  let done = false;
  const poll = (async () => {
    while (!done) {
      await new Promise((r) => setTimeout(r, 800));
      if (done || signal?.aborted) break;
      try {
        const p = await json<{ progress?: number; state?: { sampling_step?: number; sampling_steps?: number } }>(cfg, '/sdapi/v1/progress?skip_current_image=true', undefined, 5000);
        const tot = p.state?.sampling_steps || spec.steps;
        progress(p.state?.sampling_step ?? Math.round((p.progress ?? 0) * tot), tot, 'Generating…');
      } catch {
        /* progress is best effort */
      }
    }
  })();
  try {
    progress(0, spec.steps, 'Generating…');
    const r = await json<{ images?: string[] }>(cfg, req.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req.body) }, 30 * 60 * 1000, signal);
    const first = r.images?.[0];
    if (!first) throw new SdError('AUTOMATIC1111 returned no image.');
    const bin = atob(first.replace(/^data:[^,]*,/, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: 'image/png' });
  } finally {
    done = true;
    await poll;
  }
}
