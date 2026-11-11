/**
 * CoreMLEngine — Electron main's side of the built-in Core ML Stable Diffusion engine.
 *
 * Spawns the Swift helper (native/coreml-sd → Resources/darkroom-coreml/darkroom-coreml) on demand and talks to it
 * over stdin/stdout JSON lines; routes replies by request id; streams progress to the renderer; runs one job at a
 * time (later jobs queue; cancelling a queued job just removes it); quits the helper after a long idle period (the
 * helper itself frees model memory after a shorter one). The renderer only ever sends model *ids*; paths come from
 * our own scan of Darkroom's models folder and the folders the user picked in a native dialog.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type {
  CoreMLControlNetInfo,
  CoreMLEngineState,
  CoreMLEvent,
  CoreMLGenerateRequest,
  CoreMLGenerateResult,
  CoreMLModelInfo,
  CoreMLModelList,
  CoreMLStatus,
} from '../../src/native/api';

export interface EngineOptions {
  /** Absolute path of the helper binary (may not exist). */
  helperPath: string;
  /** Darkroom's own models folder (~/Library/Application Support/Darkroom/coreml-models). */
  modelsDir: string;
  /** Where the helper keeps its "already compiled" markers. */
  stateDir: string;
  /** Settings file for the user-added folders. */
  settingsFile: string;
  emit: (e: CoreMLEvent) => void;
  log?: (...a: unknown[]) => void;
}

interface Pending {
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
  jobId?: string;
}

export class CoreMLError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** FNV-1a, for stable short folder ids. */
const fnv = (s: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
};

/** Darwin kernel major → macOS: 22 = 13.x. The helper needs 13.1 (Darwin 22.2). */
function macOSOk(): boolean {
  const [maj, min] = os.release().split('.').map(Number);
  return maj > 22 || (maj === 22 && min >= 2);
}

const IDLE_QUIT_MS = 20 * 60 * 1000;

export class CoreMLEngine {
  private proc: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  private pending = new Map<string, Pending>();
  private seq = 0;
  private state: CoreMLEngineState = 'stopped';
  private hello: Record<string, unknown> = {};
  private loaded: CoreMLStatus['loaded'];
  private loadedKey = '';
  private chain: Promise<unknown> = Promise.resolve();
  private queued = new Set<string>();
  private cancelledJobs = new Set<string>();
  private activeJob: { jobId: string; reqId: string } | null = null;
  private idleQuit: NodeJS.Timeout | null = null;
  private folders: string[] = [];
  private paths = new Map<string, string>(); // id → absolute path (from the last scan)
  private ids = new Map<string, string>();   // path → id
  private stderrTail: string[] = [];

  constructor(private o: EngineOptions) {
    try {
      const j = JSON.parse(readFileSync(o.settingsFile, 'utf8')) as { folders?: unknown };
      if (Array.isArray(j.folders)) this.folders = j.folders.filter((f): f is string => typeof f === 'string');
    } catch {
      /* none yet */
    }
  }

  // ------------------------------------------------------------------------------------------- availability
  unavailableReason(): string | undefined {
    if (process.platform !== 'darwin') return 'The built-in Core ML engine is only available in the Mac app.';
    if (!macOSOk()) return 'The built-in Core ML engine needs macOS 13.1 or later.';
    if (!existsSync(this.o.helperPath)) return `The Core ML helper is missing from this build (${path.basename(this.o.helperPath)}).`;
    const archs = this.helperArchs();
    const want = process.arch === 'arm64' ? 'arm64' : 'x86_64';
    if (archs && !archs.includes(want))
      return want === 'x86_64' ? 'The built-in Core ML engine needs an Apple silicon Mac (this build has no Intel helper).' : `The Core ML helper has no ${want} slice.`;
    return undefined;
  }

  private helperArchs(): string[] | null {
    try {
      const j = JSON.parse(readFileSync(this.o.helperPath + '.json', 'utf8')) as { archs?: string[] };
      return j.archs ?? null;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------------------------------------ folders
  folderList(): CoreMLStatus['folders'] {
    return this.folders.map((p) => ({ id: 'f' + fnv(p), name: path.basename(p), path: p }));
  }

  async addFolder(p: string) {
    if (!this.folders.includes(p)) this.folders.push(p);
    await this.saveSettings();
    return this.folderList();
  }

  async removeFolder(id: string) {
    this.folders = this.folders.filter((p) => 'f' + fnv(p) !== id);
    await this.saveSettings();
    return this.folderList();
  }

  private async saveSettings() {
    await mkdir(path.dirname(this.o.settingsFile), { recursive: true });
    await writeFile(this.o.settingsFile, JSON.stringify({ folders: this.folders }, null, 2));
  }

  private roots(): { tag: string; label: string; dir: string; own: boolean }[] {
    return [
      { tag: 'darkroom', label: 'Darkroom', dir: this.o.modelsDir, own: true },
      ...this.folders.map((p) => ({ tag: 'f' + fnv(p), label: path.basename(p), dir: p, own: false })),
    ];
  }

  // ---------------------------------------------------------------------------------------- helper process
  private setState(s: CoreMLEngineState, detail?: string) {
    this.state = s;
    this.o.emit({ type: 'state', state: s, detail });
  }

  private async ensureHelper(): Promise<void> {
    if (this.proc) return;
    if (this.starting) return this.starting;
    const reason = this.unavailableReason();
    if (reason) throw new CoreMLError('unavailable', reason);
    this.setState('starting');
    this.starting = new Promise<void>((resolve, reject) => {
      const p = spawn(this.o.helperPath, ['--state-dir', this.o.stateDir, '--idle-unload', '300'], { stdio: ['pipe', 'pipe', 'pipe'] });
      this.proc = p;
      let ready = false;
      p.on('error', (e) => {
        this.proc = null;
        this.setState('error', e.message);
        if (!ready) reject(new CoreMLError('spawn', `Could not start the Core ML helper: ${e.message}`));
      });
      p.on('exit', (code, sig) => {
        const wasReady = ready;
        const clean = code === 0 && !sig;
        this.o.log?.(`[coreml] helper exit code=${code} sig=${sig}`);
      this.o.emit({ type: 'log', level: clean ? 'info' : 'error', message: clean ? 'helper exited' : `helper exited unexpectedly (${sig ?? `code ${code}`})${this.stderrTail.length ? ': ' + this.stderrTail.slice(-3).join(' | ') : ''}` });
        this.proc = null;
        this.loaded = undefined;
        this.loadedKey = '';
        const why = `The Core ML helper exited (${sig ?? code})${this.stderrTail.length ? `: ${this.stderrTail.slice(-3).join(' | ')}` : ''}`;
        for (const [, w] of this.pending) w.reject(new CoreMLError('exited', why));
        this.pending.clear();
        this.setState('stopped');
        if (!wasReady) reject(new CoreMLError('exited', why));
      });
      p.stderr!.setEncoding('utf8');
      p.stderr!.on('data', (d: string) => {
        for (const l of d.split('\n').filter(Boolean)) {
          this.stderrTail.push(l.slice(0, 300));
          if (this.stderrTail.length > 20) this.stderrTail.shift();
          this.o.log?.('[coreml helper]', l);
          this.o.emit({ type: 'log', level: /error|fail|exception|fatal/i.test(l) ? 'error' : 'info', message: `helper: ${l.slice(0, 500)}` });
        }
      });
      readline.createInterface({ input: p.stdout! }).on('line', (line) => {
        let m: Record<string, unknown>;
        try {
          m = JSON.parse(line);
        } catch {
          return;
        }
        if (m.event === 'ready') {
          ready = true;
          this.setState('idle');
          resolve();
          return;
        }
        this.onMessage(m);
      });
    }).finally(() => (this.starting = null));
    await this.starting;
    this.hello = await this.call('hello');
  }

  private onMessage(m: Record<string, unknown>) {
    if (m.event === 'progress') {
      const w = this.pending.get(String(m.id));
      const phase = String(m.phase);
      if (phase === 'compiling' && this.state !== 'compiling') this.setState('compiling', String(m.message));
      if (w?.jobId)
        this.o.emit({ type: 'job', jobId: w.jobId, phase: phase as never, step: Number(m.step) || 0, total: Number(m.total) || 0, message: String(m.message ?? '') });
      return;
    }
    if (m.event === 'state') {
      const s = String(m.state);
      if (s === 'unloaded') this.setState('unloaded', 'Models freed after being idle');
      else if (s === 'loading' || s === 'busy' || s === 'ready' || s === 'idle') this.setState(s);
      return;
    }
    const w = this.pending.get(String(m.id));
    if (!w) return;
    this.pending.delete(String(m.id));
    this.o.log?.(`[coreml] ← ${String(m.id)} ${m.ok ? 'ok' : `error ${JSON.stringify(m.error)}`}`);
    if (m.ok) w.resolve((m.result ?? {}) as Record<string, unknown>);
    else {
      const e = (m.error ?? {}) as { code?: string; message?: string };
      w.reject(new CoreMLError(e.code ?? 'error', e.message ?? 'Core ML helper error'));
    }
  }

  private call(cmd: string, args: Record<string, unknown> = {}, jobId?: string): Promise<Record<string, unknown>> {
    const p = this.proc;
    if (!p?.stdin) return Promise.reject(new CoreMLError('stopped', 'The Core ML helper is not running.'));
    const id = `m${++this.seq}`;
    if (jobId && this.activeJob?.jobId === jobId) this.activeJob.reqId = id;
    this.o.log?.(`[coreml] → ${id} ${cmd}${jobId ? ` job=${jobId}` : ''}${cmd === 'load' ? ` ${path.basename(String(args.modelDir))} ${args.computeUnits} cns=${(args.controlNets as string[]).map((c) => path.basename(c)).join(',')}` : ''}`);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, jobId });
      p.stdin!.write(JSON.stringify({ id, cmd, ...args }) + '\n');
    });
  }

  private touch() {
    if (this.idleQuit) clearTimeout(this.idleQuit);
    this.idleQuit = setTimeout(() => {
      if (!this.activeJob && !this.queued.size) this.shutdown();
    }, IDLE_QUIT_MS);
  }

  shutdown() {
    const p = this.proc;
    if (!p) return;
    try {
      p.stdin?.write(JSON.stringify({ id: 'bye', cmd: 'shutdown' }) + '\n');
      p.stdin?.end();
    } catch {
      /* gone */
    }
    setTimeout(() => {
      if (p.exitCode === null && p.signalCode === null) p.kill('SIGTERM');
    }, 1500).unref();
  }

  // ------------------------------------------------------------------------------------------------ public
  async status(): Promise<CoreMLStatus> {
    this.o.log?.('[coreml] status()');
    const reason = this.unavailableReason();
    return {
      available: !reason,
      reason,
      arch: process.arch,
      state: this.state,
      helperVersion: this.hello.version as string | undefined,
      neuralEngine: this.hello.neuralEngine as boolean | undefined,
      loaded: this.loaded,
      modelsDir: this.o.modelsDir,
      folders: this.folderList(),
      cacheBytes: await dirSize(this.cacheDir()).catch(() => 0),
    };
  }

  /** Core ML caches compiled models per process name in ~/Library/Caches/<executable name>. */
  cacheDir() {
    return path.join(os.homedir(), 'Library', 'Caches', path.basename(this.o.helperPath));
  }

  async listModels(): Promise<CoreMLModelList> {
    this.o.log?.('[coreml] listModels()');
    await this.ensureHelper();
    this.touch();
    const roots = this.roots();
    const r = (await this.call('listModels', { roots: roots.map((x) => x.dir) })) as { models: Record<string, unknown>[]; controlNets: Record<string, unknown>[] };
    this.paths.clear();
    this.ids.clear();
    const idFor = (p: string) => {
      const root = roots.find((x) => p === x.dir || p.startsWith(x.dir + path.sep));
      if (!root) return null;
      const id = `${root.tag}:${path.relative(root.dir, p)}`;
      this.paths.set(id, p);
      this.ids.set(p, id);
      return { id, root };
    };
    const models: CoreMLModelInfo[] = [];
    for (const m of r.models) {
      const k = idFor(String(m.path));
      if (!k) continue;
      models.push({
        id: k.id, name: String(m.name), root: k.root.label, kind: m.kind as CoreMLModelInfo['kind'], attention: m.attention as CoreMLModelInfo['attention'],
        width: Number(m.width), height: Number(m.height), controlNetSupport: !!m.controlNetSupport, img2img: !!m.img2img, bytes: Number(m.bytes) || 0, deletable: k.root.own,
      });
    }
    const controlNets: CoreMLControlNetInfo[] = [];
    for (const c of r.controlNets) {
      const k = idFor(String(c.path));
      if (!k) continue;
      controlNets.push({
        id: k.id, name: String(c.name), root: k.root.label, attention: c.attention as CoreMLControlNetInfo['attention'], width: Number(c.width), height: Number(c.height),
        version: String(c.version ?? ''), bytes: Number(c.bytes) || 0, deletable: k.root.own,
      });
    }
    return { models, controlNets };
  }

  /** Resolve a renderer-supplied id to a path from our own scan (never a renderer path). */
  private async resolve(id: string): Promise<string> {
    if (!this.paths.has(id)) await this.listModels();
    const p = this.paths.get(id);
    if (!p) throw new CoreMLError('notFound', `Core ML model “${id}” was not found. Was it moved or deleted? (Preferences › Generation lists the installed models.)`);
    return p;
  }

  pathOf(id: string) {
    return this.paths.get(id);
  }

  generate(req: CoreMLGenerateRequest): Promise<CoreMLGenerateResult> {
    this.o.log?.(`[coreml] generate() job=${req?.jobId} model=${req?.modelId} units=${req?.computeUnits} steps=${req?.steps} controls=${req?.controls?.length}`);
    if (!req || typeof req.jobId !== 'string' || typeof req.modelId !== 'string') return Promise.reject(new CoreMLError('badRequest', 'Bad Core ML request'));
    this.queued.add(req.jobId);
    if (this.activeJob) this.o.emit({ type: 'job', jobId: req.jobId, phase: 'queued', step: 0, total: req.steps, message: 'Waiting for the previous Core ML job…' });
    const run = async (): Promise<CoreMLGenerateResult> => {
      this.queued.delete(req.jobId);
      if (this.cancelledJobs.delete(req.jobId)) throw new CoreMLError('cancelled', 'Cancelled.');
      this.activeJob = { jobId: req.jobId, reqId: '' };
      try {
        await this.ensureHelper();
        const modelDir = await this.resolve(req.modelId);
        const cnPaths = await Promise.all([...new Set(req.controls.map((c) => c.controlNetId))].map((id) => this.resolve(id)));
        const key = JSON.stringify([modelDir, req.computeUnits, cnPaths.slice().sort(), !!req.reduceMemory]);
        let load: CoreMLGenerateResult['load'];
        if (key !== this.loadedKey) {
          const r = await this.call('load', { modelDir, computeUnits: req.computeUnits, controlNets: cnPaths, reduceMemory: !!req.reduceMemory, idleUnloadSeconds: 300 }, req.jobId);
          this.loadedKey = key;
          load = { ms: Number(r.ms), firstLoad: !!r.firstLoad, unetDevice: r.unetDevice as string | undefined, note: (r.note as string) || undefined };
          this.loaded = { modelId: req.modelId, computeUnits: req.computeUnits, unetDevice: load.unetDevice, note: load.note, controlNets: req.controls.map((c) => c.controlNetId) };
        }
        if (this.cancelledJobs.delete(req.jobId)) throw new CoreMLError('cancelled', 'Cancelled.');
        const nameOf = (id: string) => path.basename(this.paths.get(id)!, '.mlmodelc');
        const b64 = (u?: Uint8Array) => (u ? Buffer.from(u.buffer, u.byteOffset, u.byteLength).toString('base64') : undefined);
        const r = await this.call(
          'generate',
          {
            prompt: req.prompt, negative: req.negative, seed: req.seed >>> 0, steps: req.steps, guidance: req.guidance, scheduler: req.scheduler,
            startingImage: b64(req.init), strength: req.strength, mask: b64(req.mask),
            controlNetInputs: req.controls.map((c) => ({ name: nameOf(c.controlNetId), image: b64(c.image), weight: c.weight, start: c.start, end: c.end, maskedCond: !!c.maskedCond })),
          },
          req.jobId,
        );
        const png = new Uint8Array(Buffer.from(String(r.image), 'base64'));
        return { png, width: Number(r.width), height: Number(r.height), seed: Number(r.seed), timings: (r.timings ?? {}) as Record<string, number>, load };
      } finally {
        this.activeJob = null;
        this.touch();
      }
    };
    const job = this.chain.then(run, run);
    this.chain = job.catch(() => {});
    return job;
  }

  cancel(jobId: string) {
    if (this.queued.has(jobId)) {
      this.cancelledJobs.add(jobId);
      return;
    }
    if (this.activeJob?.jobId === jobId) {
      this.cancelledJobs.add(jobId);
      if (this.proc) void this.call('cancel', {}).catch(() => {});
    }
  }

  async unload() {
    if (!this.proc) return;
    await this.call('unload').catch(() => {});
    this.loaded = undefined;
    this.loadedKey = '';
  }

  async clearCache() {
    this.shutdown();
    await new Promise((r) => setTimeout(r, 1800));
    await rm(this.cacheDir(), { recursive: true, force: true });
    await rm(this.o.stateDir, { recursive: true, force: true });
  }
}

async function dirSize(dir: string): Promise<number> {
  let n = 0;
  let items: import('node:fs').Dirent[];
  try {
    items = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const it of items) {
    const p = path.join(dir, it.name);
    if (it.isDirectory()) n += await dirSize(p);
    else if (it.isFile()) n += (await stat(p)).size;
  }
  return n;
}
