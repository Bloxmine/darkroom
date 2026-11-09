import { GL, ShaderCompileError, type Tex } from './gl';
import { GLSL_LIB } from './glsl';
import { flattenGraph, getPorts, IMAGE, OUTPUT } from './graph';
import { getNodeDef, missingNodeMessage, subscribeRegistry } from './registry';
import type { Asset, Graph, GraphNode, NodeDef, ParamDef, PassContext, RawTex, TexSource, UniformValue } from './types';

export interface RenderOptions {
  /** Node to render; default = first core.output node. Group-inner ids allowed ('g1/n2'). */
  nodeId?: string;
  /** Output port of that node; default = first output. */
  port?: string;
  /** Render scale relative to full resolution (preview < 1, export = 1). */
  scale?: number;
  /** Max long edge for preview; overrides `scale` if given. */
  maxSize?: number;
  /**
   * Interactive preview only: evaluate heavy nodes (NodeDef.heavy, default all `ai.*`) at this fixed
   * scale in a separate cache and resample their outputs to `scale`. Zooming the viewer then never
   * re-runs AI inference. Omit for exports (heavy nodes then run at `scale`, i.e. full resolution).
   */
  heavyScale?: number;
  /**
   * Render into a separate cache namespace (e.g. 'thumb' for node thumbnails)
   * so renders at another scale don't evict the viewer's per-node cache.
   * Tagged renders reuse the main namespace's finished CPU textures (decoded images).
   */
  cacheTag?: string;
}

/** Options for `Engine.thumbnail`. */
export interface ThumbnailOptions {
  /** Only use cache entries evaluated for this (root) graph at the current time (skip stale ones). */
  graph?: Graph;
  /** Show the red channel as greyscale (mask ports). */
  mask?: boolean;
}

interface CacheNamespace {
  cache: Map<string, CacheEntry>;
  cpu: Map<string, CpuEntry>;
  seen: Map<string, { graph: Graph; time: number }>;
}

export interface RenderResult {
  tex: Tex | null;
  width: number;
  height: number;
  /** Full-resolution size of the rendered node. */
  fullWidth: number;
  fullHeight: number;
  scale: number;
  ms: number;
  /** Nodes actually re-rendered by this call (0 = everything came from the cache). */
  evaluated: number;
}

export interface PresentOptions {
  /** Destination rectangle in canvas device pixels (x, y from top-left). */
  rect: { x: number; y: number; w: number; h: number };
  /** Optional comparison image (e.g. the original) shown left of `split`. */
  compare?: Tex | null;
  /** Split position in canvas device pixels (x). */
  split?: number;
  /** Nearest-neighbour when zoomed in. */
  pixelated?: boolean;
  background?: [number, number, number];
  /** Compare layout: 'h' = `compare` left of `split` (x), 'v' = `compare` above `split` (canvas y from the top), 'full' = only `compare`. Default 'h'. */
  compareMode?: 'h' | 'v' | 'full';
  /** Present-time channel view (no node): 0 RGB, 1 R, 2 G, 3 B, 4 alpha, 5 Rec.709 luma. */
  channel?: number;
  /** Clipping indicators: values ≥ hi in any channel → red, ≤ lo in all channels → blue (0..1). */
  clip?: { lo: number; hi: number } | null;
}

interface CacheEntry {
  key: string;
  outputs: Record<string, Tex | null>;
  owned: Tex[];
  size: { width: number; height: number };
  fullSize: { width: number; height: number };
}

interface CpuEntry {
  key: string;
  status: 'pending' | 'done' | 'error';
  textures: Record<string, Tex>;
  error?: string;
  /** Cancels this run when superseded. */
  ctl?: AbortController;
}

/** Built-in uniform names; params whose `u_<key>` would collide get no auto-uniform (use `uniforms()` instead). */
const RESERVED = new Set(['u_resolution', 'u_scale', 'u_time', 'u_iteration', 'u_prev', 'u_frame']);

const UNIFORM_TYPES: Partial<Record<ParamDef['type'], string>> = {
  float: 'float',
  int: 'int',
  bool: 'bool',
  color: 'vec4',
  vec2: 'vec2',
  enum: 'int',
};

/**
 * The graph evaluator. Owns a WebGL2 context on `canvas`, caches every node's
 * output texture and only re-renders nodes whose inputs/params changed.
 */
export class Engine {
  gl: GL;
  assets = new Map<string, Asset>();
  /** Errors by (flat) node id. */
  errors = new Map<string, string>();
  /** Called when async work finishes (cpu nodes) and a re-render is needed. */
  onInvalidate: () => void = () => {};
  time = 0;
  /** Timeline frame index, exposed to shaders as `u_frame` (0 for stills / still export). See docs/VIDEO.md. */
  frame = 0;
  /** Bumped by the host every displayed frame while live sources exist; re-runs `volatile: 'live'` cpu steps. */
  liveTick = 0;
  projectSize: { width: number; height: number } | null = null;
  /** In-flight async cpu() steps (see `whenCpuIdle`). */
  private cpuInflight = new Set<Promise<unknown>>();

  private cache = new Map<string, CacheEntry>();
  private cpu = new Map<string, CpuEntry>();
  /** Running count of node evaluations that missed the cache (for render stats). */
  private evalCount = 0;
  private presentProg = PRESENT_FRAG;
  private unsub: () => void;
  /** Flat id → (graph, time) it was last successfully evaluated for, in the active namespace. */
  private seen = new Map<string, { graph: Graph; time: number }>();
  /** Extra cache namespaces (RenderOptions.cacheTag). */
  private namespaces = new Map<string, CacheNamespace>();
  /** During a tagged render: the main namespace's CPU entries, reused when only the scale differs. */
  private borrowCpu: Map<string, CpuEntry> | null = null;
  private thumbTargets = new Map<string, Tex>();
  /** Time of the last render()/present() call (GPU work submitted). */
  private lastSubmit = 0;

  constructor(public canvas: HTMLCanvasElement | OffscreenCanvas) {
    this.gl = new GL(canvas);
    // Registry changes (plugins, custom nodes) invalidate everything.
    this.unsub = subscribeRegistry(() => {
      this.clearCache();
      this.onInvalidate();
    });
  }

  dispose() {
    this.unsub();
    this.clearCache();
  }

  addAsset(asset: Asset) {
    this.assets.set(asset.id, asset);
    this.onInvalidate();
  }

  clearCache() {
    for (const e of this.cache.values()) e.owned.forEach((t) => this.gl.release(t));
    this.cache.clear();
    for (const c of this.cpu.values()) Object.values(c.textures).forEach((t) => this.gl.destroy(t));
    this.cpu.clear();
    this.seen.clear();
    for (const tag of [...this.namespaces.keys()]) this.dropCache(tag);
  }

  /** Full-resolution project size: explicit, else first Image node's asset, else 1920x1080. */
  getProjectSize(graph: Graph) {
    if (this.projectSize) return this.projectSize;
    const flat = flattenGraph(graph);
    for (const n of flat.nodes) {
      if (n.type !== IMAGE && n.type !== 'core.video' && n.type !== 'core.raw') continue;
      const a = this.assets.get(String(n.params.asset ?? ''));
      if (a?.width && a.height) return { width: a.width, height: a.height };
    }
    return { width: 1920, height: 1080 };
  }

  render(graph: Graph, opts: RenderOptions = {}): RenderResult {
    this.lastSubmit = performance.now();
    if (opts.cacheTag) return this.inNamespace(opts.cacheTag, () => this.render(graph, { ...opts, cacheTag: undefined }));
    const t0 = performance.now();
    const evals0 = this.evalCount;
    const flat = flattenGraph(graph);
    const nodes = new Map(flat.nodes.map((n) => [n.id, n]));
    const incoming = new Map<string, Map<string, { node: string; port: string }>>();
    for (const e of flat.edges) {
      if (!incoming.has(e.to.node)) incoming.set(e.to.node, new Map());
      incoming.get(e.to.node)!.set(e.to.port, e.from);
    }
    const projectSize = this.getProjectSize(graph);

    let targetId = opts.nodeId;
    if (!targetId) targetId = flat.nodes.find((n) => n.type === OUTPUT)?.id;
    let targetPort = opts.port;
    if (targetId && !nodes.has(targetId)) {
      // a group node id: render the inner node feeding its first output
      const r = resolveGroupTarget(graph, targetId);
      if (r) {
        targetId = r.id;
        targetPort = r.port || targetPort;
      }
    }
    const empty: RenderResult = { tex: null, width: 0, height: 0, fullWidth: 0, fullHeight: 0, scale: 1, ms: 0, evaluated: 0 };
    if (!targetId || !nodes.has(targetId)) return empty;

    let scale = opts.scale ?? 1;
    if (opts.maxSize) scale = Math.min(1, opts.maxSize / Math.max(projectSize.width, projectSize.height));

    // drop cache entries for nodes no longer present
    for (const id of [...this.cache.keys()]) {
      if (!nodes.has(id)) {
        this.cache.get(id)!.owned.forEach((t) => this.gl.release(t));
        this.cache.delete(id);
        this.errors.delete(id);
      }
    }

    const memo = new Map<string, CacheEntry | null>();
    const visiting = new Set<string>();
    const evalNode = (id: string): CacheEntry | null => {
      if (memo.has(id)) return memo.get(id)!;
      if (visiting.has(id)) return null; // cycle guard
      visiting.add(id);
      const node = nodes.get(id)!;
      let res: CacheEntry | null = null;
      try {
        const hs = opts.heavyScale;
        const def = hs !== undefined && Math.abs(scale - hs) > 1e-6 && !node.bypass ? getNodeDef(node.type) : undefined;
        if (def && (def.heavy ?? def.id.startsWith('ai.'))) res = this.evalHeavyProxy(graph, node, scale, hs!);
        else res = this.evalNode(node, incoming.get(id) ?? new Map(), (src) => (nodes.has(src) ? evalNode(src) : null), scale, projectSize);
        if (res && this.errors.get(id)?.startsWith('[pending]')) this.errors.delete(id); // keep the marker while async cpu() is pending (renderReady / ui.pending rely on it)
      } catch (e) {
        this.errors.set(id, e instanceof ShaderCompileError ? e.log : String((e as Error)?.message ?? e));
        if (e instanceof ShaderCompileError) console.warn(`[darkroom] ${node.type}:`, e.log);
        res = null;
      }
      visiting.delete(id);
      memo.set(id, res);
      if (res) this.seen.set(id, { graph, time: this.time });
      return res;
    };

    const res = evalNode(targetId);
    const portName = targetPort ?? Object.keys(getPorts(nodes.get(targetId)!).outputs)[0] ?? 'out';
    const tex = res?.outputs[portName] ?? null;
    return {
      tex,
      width: tex?.width ?? 0,
      height: tex?.height ?? 0,
      fullWidth: res?.fullSize.width ?? 0,
      fullHeight: res?.fullSize.height ?? 0,
      scale,
      ms: performance.now() - t0,
      evaluated: this.evalCount - evals0,
    };
  }

  private evalNode(
    node: GraphNode,
    inc: Map<string, { node: string; port: string }>,
    evalSrc: (id: string) => CacheEntry | null,
    scale: number,
    projectSize: { width: number; height: number },
  ): CacheEntry | null {
    const def = getNodeDef(node.type);
    if (!def) throw new Error(missingNodeMessage(node.type));
    this.errors.delete(node.id);

    // --- inputs
    const inputs: Record<string, Tex | null> = {};
    const inputKeys: string[] = [];
    const inputSizes: Record<string, { width: number; height: number }> = {};
    const inputFullSizes: Record<string, { width: number; height: number }> = {};
    for (const [name, port] of Object.entries(def.inputs)) {
      const src = inc.get(name);
      const entry = src ? evalSrc(src.node) : null;
      const tex = entry?.outputs[src!.port] ?? null;
      inputs[name] = tex;
      inputKeys.push(entry ? `${src!.node}:${src!.port}:${entry.key}` : '-');
      if (tex && entry) {
        inputSizes[name] = { width: tex.width, height: tex.height };
        inputFullSizes[name] = entry.fullSize;
      } else if (!port.optional) {
        // required input missing → still render with fallback, but note it
      }
    }

    const outputs = def.outputs ?? { out: { type: 'image' } };
    const outNames = Object.keys(outputs);

    // --- bypass: pass first image input through
    if (node.bypass) {
      const first = Object.keys(def.inputs)[0];
      const t = first ? inputs[first] : null;
      const o: Record<string, Tex | null> = {};
      outNames.forEach((n) => (o[n] = t));
      const fs = (first && inputFullSizes[first]) || projectSize;
      return { key: 'bypass:' + inputKeys.join('|'), outputs: o, owned: [], size: t ? { width: t.width, height: t.height } : fs, fullSize: fs };
    }

    // --- size
    const getAsset = (aid: string) => this.assets.get(aid);
    let full: [number, number];
    if (def.size) full = def.size({ params: node.params, inputSizes: inputFullSizes, projectSize, getAsset });
    else {
      const firstConnected = Object.keys(def.inputs).find((k) => inputFullSizes[k] && def.inputs[k].type === 'image') ?? Object.keys(def.inputs).find((k) => inputFullSizes[k]);
      const s = firstConnected ? inputFullSizes[firstConnected] : projectSize;
      full = [s.width, s.height];
    }
    const width = Math.max(1, Math.round(full[0] * scale));
    const height = Math.max(1, Math.round(full[1] * scale));

    // --- cpu step
    let cpuTex: Record<string, Tex> = {};
    let cpuKey = '';
    if (def.cpu) {
      cpuKey = JSON.stringify([node.type, node.params, scale, def.cpuReadsInputs ? inputKeys : 0]);
      // time-varying sources re-run per time / per live tick
      if (def.volatile) cpuKey = JSON.stringify([node.type, node.params, scale, def.cpuReadsInputs ? inputKeys : 0, def.volatile === 'live' ? this.liveTick : this.time]);
      const borrowed = def.cpuReadsInputs ? undefined : this.borrowedCpu(node);
      if (borrowed) {
        // tagged namespace: reuse the main namespace's CPU result (same params, other scale)
        cpuKey = 'borrow:' + borrowed.key;
        if (this.cpu.get(node.id)?.key !== cpuKey) {
          this.cpu.get(node.id) && Object.values(this.cpu.get(node.id)!.textures).forEach((t) => this.gl.destroy(t));
          this.cpu.set(node.id, { key: cpuKey, status: 'done', textures: {} });
        }
      }
      const centry = this.cpu.get(node.id);
      // a pending volatile source is asked again: its frame may be ready synchronously by now
      if (!centry || centry.key !== cpuKey || (def.volatile && centry.status === 'pending')) {
        this.runCpu(node, def, cpuKey, inputs, scale, projectSize);
      }
      const c = this.cpu.get(node.id)!;
      // volatile sources keep showing their previous frame while the next one decodes
      const stale = !!def.volatile && c.status === 'pending' && Object.keys(c.textures).length > 0;
      if (stale) cpuKey += '~stale';
      if (c.status === 'pending' && !stale) {
        this.errors.set(node.id, '[pending] loading…');
        return null;
      }
      if (c.status === 'error') throw new Error(c.error);
      cpuTex = borrowed?.textures ?? c.textures;
    }

    const key = JSON.stringify([node.type, node.params, width, height, scale, this.time, inputKeys, cpuKey]) + (this.frame ? '#' + this.frame : '');
    const cached = this.cache.get(node.id);
    if (cached && cached.key === key) return cached;
    this.evalCount++;

    const fullSize = { width: full[0], height: full[1] };

    // pure CPU node
    if (!def.passes?.length) {
      const o: Record<string, Tex | null> = {};
      outNames.forEach((n) => (o[n] = cpuTex[n] ?? null));
      const entry: CacheEntry = { key, outputs: o, owned: [], size: { width, height }, fullSize };
      if (cached) cached.owned.forEach((t) => this.gl.release(t));
      this.cache.set(node.id, entry);
      return entry;
    }

    // --- GPU passes
    const passTex: Tex[] = [];
    const passSizes: { width: number; height: number }[] = [];
    const written: Record<string, Tex> = {};
    const temps: Tex[] = [];
    const inputNames = Object.keys(def.inputs);
    const cpuNames = Object.keys(cpuTex);

    const boundInputs: Record<string, Tex> = {};
    for (const n of inputNames) {
      const port = def.inputs[n];
      boundInputs[n] = inputs[n] ?? this.gl.fallback(port.fallback ?? (port.type === 'mask' ? 'white' : 'black'));
    }

    const paramUniforms: Record<string, UniformValue> = {};
    for (const [k, p] of Object.entries(def.params)) {
      const v = node.params[k] ?? p.default;
      if (!UNIFORM_TYPES[p.type] || RESERVED.has('u_' + k)) continue;
      if (p.type === 'enum') paramUniforms['u_' + k] = Math.max(0, p.options?.indexOf(String(v)) ?? 0);
      else if (p.type === 'bool') paramUniforms['u_' + k] = v ? 1 : 0;
      else paramUniforms['u_' + k] = v as UniformValue;
    }

    def.passes.forEach((pass, i) => {
      const ctx: PassContext = { params: node.params, width, height, scale, inputSizes, passSizes, time: this.time, frame: this.frame };
      const [pw, ph] = pass.size ? pass.size(ctx) : [width, height];
      const header = this.header(inputNames, i, cpuNames, Object.entries(def.params));
      const prog = this.gl.program(header + (typeof pass.frag === 'function' ? pass.frag(node.params) : pass.frag));
      const reps = Math.max(1, Math.floor(pass.repeat?.(ctx) ?? 1));
      const extra = pass.uniforms?.(ctx) ?? {};
      let prev: Tex = i > 0 ? passTex[i - 1] : boundInputs[inputNames[0]] ?? this.gl.fallback('black');
      let out: Tex | null = null;
      for (let r = 0; r < reps; r++) {
        out = this.gl.acquire(pw, ph, pass.filter ?? 'linear');
        const texs: Record<string, Tex> = { u_prev: prev };
        for (const n of inputNames) texs['u_' + n] = boundInputs[n];
        passTex.forEach((t, j) => (texs['u_pass' + j] = t));
        for (const n of cpuNames) texs['u_' + n] = cpuTex[n];
        const sizeU: Record<string, UniformValue> = {};
        for (const [n, t] of Object.entries(texs)) sizeU[n + '_size'] = [t.width, t.height];
        this.gl.draw(prog, out, texs, {
          ...paramUniforms,
          ...sizeU,
          u_resolution: [pw, ph],
          u_scale: scale,
          u_time: this.time,
          u_frame: this.frame,
          u_iteration: r,
          ...extra,
        });
        if (r > 0) temps.push(prev);
        prev = out;
      }
      passTex.push(out!);
      passSizes.push({ width: pw, height: ph });
      const isLast = i === def.passes!.length - 1;
      const target = pass.output ?? (isLast && !written[outNames[0]] ? outNames[0] : undefined);
      if (target) written[target] = out!;
    });

    const ownedSet = new Set(Object.values(written));
    passTex.forEach((t) => !ownedSet.has(t) && temps.push(t));
    temps.forEach((t) => !ownedSet.has(t) && this.gl.release(t));

    const o: Record<string, Tex | null> = {};
    outNames.forEach((n) => (o[n] = written[n] ?? null));
    const entry: CacheEntry = { key, outputs: o, owned: [...ownedSet], size: { width, height }, fullSize };
    if (cached) cached.owned.forEach((t) => !ownedSet.has(t) && this.gl.release(t));
    this.cache.set(node.id, entry);
    return entry;
  }

  private runCpu(
    node: GraphNode,
    def: NodeDef,
    key: string,
    inputs: Record<string, Tex | null>,
    scale: number,
    projectSize: { width: number; height: number },
  ) {
    const cpu = this.cpu; // the active namespace's map (async results must land there)
    const old = cpu.get(node.id);
    if (old?.status === 'pending') old.ctl?.abort(); // a newer run replaces it
    const entry: CpuEntry = { key, status: 'pending', textures: old?.textures ?? {}, ctl: new AbortController() };
    cpu.set(node.id, entry);
    const finish = (res: Record<string, TexSource>) => {
      if (cpu.get(node.id) !== entry) return; // superseded
      const textures: Record<string, Tex> = {};
      for (const [k, src] of Object.entries(res)) textures[k] = def.volatile ? this.gl.uploadFrame(src, entry.textures[k]) : this.gl.upload(src, entry.textures[k]);
      for (const [k, t] of Object.entries(entry.textures)) if (!(k in res)) this.gl.destroy(t);
      entry.textures = textures;
      entry.status = 'done';
    };
    const fail = (e: unknown) => {
      if (cpu.get(node.id) !== entry) return;
      entry.status = 'error';
      entry.error = String((e as Error)?.message ?? e);
    };
    try {
      const r = def.cpu!({
        signal: entry.ctl!.signal,
        nodeId: node.id,
        params: node.params,
        scale,
        projectSize,
        getAsset: (id) => this.assets.get(id),
        time: this.time,
        frame: this.frame,
        readInput: (name) => {
          const t = inputs[name];
          if (!t) return null;
          return { width: t.width, height: t.height, data: this.gl.readFloat(t) } satisfies RawTex;
        },
      });
      if (r instanceof Promise) {
        const done = r.then(finish, fail).finally(() => {
          this.cpuInflight.delete(done);
          this.onInvalidate();
        });
        this.cpuInflight.add(done);
      } else finish(r);
    } catch (e) {
      fail(e);
    }
  }

  private header(inputs: string[], passIndex: number, cpuNames: string[], params: [string, ParamDef][]) {
    const lines = ['#version 300 es', 'precision highp float;', 'precision highp int;', 'in vec2 v_uv;', 'out vec4 fragColor;',
      'uniform vec2 u_resolution;', 'uniform float u_scale;', 'uniform float u_time;', 'uniform int u_iteration;', 'uniform int u_frame;'];
    const sampler = (n: string) => lines.push(`uniform sampler2D ${n};`, `uniform vec2 ${n}_size;`);
    sampler('u_prev');
    inputs.forEach((n) => sampler('u_' + n));
    for (let i = 0; i < passIndex; i++) sampler('u_pass' + i);
    cpuNames.forEach((n) => sampler('u_' + n));
    for (const [k, p] of params) {
      const t = UNIFORM_TYPES[p.type];
      if (t && !RESERVED.has('u_' + k)) lines.push(`uniform ${t} u_${k};`);
    }
    return lines.join('\n') + '\n' + GLSL_LIB + '\n#line 1\n';
  }

  /** Resolves when no async cpu() step is in flight (video export waits on this before reading a frame). */
  async whenCpuIdle(): Promise<void> {
    while (this.cpuInflight.size) await Promise.allSettled([...this.cpuInflight]);
  }

  /** Is an async cpu() step in flight? */
  get cpuBusy() {
    return this.cpuInflight.size > 0;
  }

  /** Draw a rendered texture to the canvas (the viewer). */
  present(res: Tex | null, opts: PresentOptions) {
    this.lastSubmit = performance.now();
    const gl = this.gl.gl;
    const bg = opts.background ?? [0.11, 0.11, 0.12];
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!res) return;
    const prog = this.gl.program(this.presentProg);
    const H = gl.drawingBufferHeight;
    const { x, y, w, h } = opts.rect;
    const setFilter = (t: Tex) => {
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      const f = opts.pixelated ? gl.NEAREST : gl.LINEAR;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    };
    setFilter(res);
    if (opts.compare) setFilter(opts.compare);
    this.gl.draw(
      prog,
      null,
      { u_img: res, u_cmp: opts.compare ?? res },
      {
        u_rect: [x, H - y - h, w, h],
        u_split: opts.compare ? (opts.compareMode === 'v' ? H - (opts.split ?? 0) : (opts.split ?? 0)) : -1,
        u_cmpMode: !opts.compare ? 0 : opts.compareMode === 'v' ? 2 : opts.compareMode === 'full' ? 3 : 1,
        u_channel: opts.channel ?? 0,
        u_clip: opts.clip ? [1, opts.clip.lo, opts.clip.hi] : [0, 0, 1],
        u_bg: bg,
      },
    );
    // restore filters
    const restore = (t: Tex) => {
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, t.filter === 'nearest' ? gl.NEAREST : gl.LINEAR);
    };
    restore(res);
    if (opts.compare) restore(opts.compare);
  }

  // ---------------------------------------------------------------------------
  // Cache namespaces + node thumbnails
  // ---------------------------------------------------------------------------

  /**
   * A heavy node in the interactive viewer: evaluate it (and its upstream) once at `heavyScale` in the
   * 'heavy' cache namespace, then resample its outputs to the current `scale`. Changing the zoom only
   * costs a blit; the inference re-runs only when the node's inputs or params change.
   */
  private evalHeavyProxy(graph: Graph, node: GraphNode, scale: number, heavyScale: number): CacheEntry | null {
    this.inNamespace('heavy', () => this.render(graph, { nodeId: node.id, scale: heavyScale }));
    const src = this.namespaces.get('heavy')?.cache.get(node.id);
    if (!src || this.errors.get(node.id)?.startsWith('[pending]')) return null;
    const key = JSON.stringify(['heavy', src.key, scale]);
    const cached = this.cache.get(node.id);
    if (cached?.key === key) return cached;
    const w = Math.max(1, Math.round(src.fullSize.width * scale));
    const h = Math.max(1, Math.round(src.fullSize.height * scale));
    const prog = this.gl.program(BLIT_FRAG);
    const outputs: Record<string, Tex | null> = {};
    const owned: Tex[] = [];
    for (const [port, t] of Object.entries(src.outputs)) {
      if (!t) {
        outputs[port] = null;
        continue;
      }
      const o = this.gl.acquire(w, h, t.filter);
      this.gl.draw(prog, o, { u_src: t }, {});
      outputs[port] = o;
      owned.push(o);
    }
    cached?.owned.forEach((t) => this.gl.release(t));
    const entry: CacheEntry = { key, outputs, owned, size: { width: w, height: h }, fullSize: src.fullSize };
    this.cache.set(node.id, entry);
    return entry;
  }

  private inNamespace<T>(tag: string, fn: () => T): T {
    let ns = this.namespaces.get(tag);
    if (!ns) this.namespaces.set(tag, (ns = { cache: new Map(), cpu: new Map(), seen: new Map() }));
    const main = { cache: this.cache, cpu: this.cpu, seen: this.seen, borrow: this.borrowCpu };
    this.cache = ns.cache;
    this.cpu = ns.cpu;
    this.seen = ns.seen;
    this.borrowCpu = main.cpu;
    try {
      return fn();
    } finally {
      this.cache = main.cache;
      this.cpu = main.cpu;
      this.seen = main.seen;
      this.borrowCpu = main.borrow;
    }
  }

  /** In a tagged render: the main namespace's finished CPU entry for `node` if only its scale differs. */
  private borrowedCpu(node: GraphNode): CpuEntry | undefined {
    const m = this.borrowCpu?.get(node.id);
    if (!m || m.status !== 'done') return undefined;
    try {
      const [type, params, , reads] = JSON.parse(m.key) as [string, unknown, number, unknown];
      if (reads !== 0 || type !== node.type || JSON.stringify(params) !== JSON.stringify(node.params)) return undefined;
    } catch {
      return undefined;
    }
    return m;
  }

  /** Free a tagged cache namespace (e.g. when thumbnails are turned off). */
  dropCache(tag: string) {
    const ns = this.namespaces.get(tag);
    if (!ns) return;
    for (const e of ns.cache.values()) e.owned.forEach((t) => this.gl.release(t));
    for (const c of ns.cpu.values()) Object.values(c.textures).forEach((t) => this.gl.destroy(t));
    this.namespaces.delete(tag);
  }

  /**
   * The cache entry for a flat node id: the main namespace first, then tagged ones.
   * With `graph`, only entries evaluated for that graph (and the current time) count.
   */
  private findEntry(id: string, graph?: Graph): { tag: string; entry: CacheEntry } | null {
    const fresh = (seen: CacheNamespace['seen'], anyTime = false) => {
      if (!graph) return true;
      const s = seen.get(id);
      return !!s && s.graph === graph && (anyTime || s.time === this.time);
    };
    // The main (viewer) cache is re-rendered every frame during playback, so a thumbnail that
    // trails the playhead by a frame is fine there; tagged caches must match the current time.
    const main = this.cache.get(id);
    if (main && fresh(this.seen, true)) return { tag: '', entry: main };
    for (const [tag, ns] of this.namespaces) {
      const e = ns.cache.get(id);
      if (e && fresh(ns.seen)) return { tag, entry: e };
    }
    return null;
  }

  /** Is the node's output cached (and, with `graph`, current for it) in any namespace? */
  isCached(id: string, graph?: Graph) {
    return !!this.findEntry(id, graph);
  }

  /** Version of a node's cached output (changes whenever its pixels may have); null if not cached. */
  cacheKey(id: string, graph?: Graph): string | null {
    const f = this.findEntry(id, graph);
    return f ? f.tag + '|' + f.entry.key : null;
  }

  /**
   * Downsample a node's CACHED output on the GPU to fit `maxSize` (one box-filtered
   * pass into a small pooled RGBA8 target) and read the few KB back asynchronously
   * (PBO + fence, so it never stalls the render loop). Null if the node isn't cached.
   * Pixels are straight (unpremultiplied) RGBA, top row first.
   */
  thumbnail(id: string, port?: string, maxSize = 160, opts: ThumbnailOptions = {}): Promise<ImageData | null> {
    const f = this.findEntry(id, opts.graph);
    if (!f) return Promise.resolve(null);
    const outs = f.entry.outputs;
    const src = (port ? outs[port] : undefined) ?? outs[Object.keys(outs)[0]] ?? null;
    if (!src) return Promise.resolve(null);
    const k = Math.min(1, maxSize / Math.max(src.width, src.height));
    const w = Math.max(1, Math.round(src.width * k));
    const h = Math.max(1, Math.round(src.height * k));
    const tk = w + 'x' + h;
    let dst = this.thumbTargets.get(tk);
    if (!dst) {
      if (this.thumbTargets.size > 32) {
        for (const t of this.thumbTargets.values()) this.gl.destroy(t);
        this.thumbTargets.clear();
      }
      dst = this.gl.createTarget(w, h, 'linear', false);
      this.thumbTargets.set(tk, dst);
    }
    const gl = this.gl.gl;
    // nearest-filtered targets would alias: sample them bilinearly for the box filter
    // (linear and mipmapped textures are left as they are; no sync getTexParameter)
    const nearest = src.filter === 'nearest';
    if (nearest) {
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const ratio = Math.max(src.width / w, src.height / h);
    this.gl.draw(this.gl.program(THUMB_FRAG), dst, { u_src: src }, {
      u_resolution: [w, h],
      u_taps: Math.max(1, Math.min(8, Math.ceil(ratio / 2))),
      u_mask: opts.mask ? 1 : 0,
    });
    if (nearest) {
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    }
    // async readback
    const bytes = w * h * 4;
    const pbo = gl.createBuffer()!;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, bytes, gl.STREAM_READ);
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    const fenced = performance.now();
    return new Promise((resolve) => {
      const done = (ok: boolean) => {
        let img: ImageData | null = null;
        if (ok && !gl.isContextLost()) {
          const px = new Uint8ClampedArray(bytes);
          gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
          gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, px);
          gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
          img = new ImageData(px, w, h);
        }
        gl.deleteBuffer(pbo);
        if (sync) gl.deleteSync(sync);
        resolve(img);
      };
      // getBufferSubData makes the browser drain the GPU queue: read only once the fence has
      // passed AND no newer engine work was submitted (else it would wait for that frame too).
      // If the engine stays busy, give up (null) rather than stall; the caller retries later.
      const poll = () => {
        if (!sync || gl.isContextLost()) return done(false);
        const st = gl.clientWaitSync(sync, 0, 0);
        if ((st === gl.ALREADY_SIGNALED || st === gl.CONDITION_SATISFIED) && this.lastSubmit < fenced) return done(true);
        if (performance.now() - fenced > 3000) return done(false);
        if (st === gl.WAIT_FAILED) return done(false);
        setTimeout(poll, 8);
      };
      setTimeout(poll, 0);
    });
  }

  /** Read a rendered texture back as ImageData (8-bit, clamped). */
  toImageData(t: Tex): ImageData {
    return new ImageData(this.gl.readU8(t) as Uint8ClampedArray<ArrayBuffer>, t.width, t.height);
  }

  /** Render at full resolution and encode. */
  async export(graph: Graph, opts: { nodeId?: string; type?: 'image/png' | 'image/jpeg' | 'image/webp'; quality?: number; scale?: number } = {}): Promise<Blob> {
    const scale = opts.scale ?? 1;
    const res = this.render(graph, { nodeId: opts.nodeId, scale });
    if (!res.tex) throw new Error('Nothing to export — connect something to the Output node.');
    const want = [Math.round(res.fullWidth * scale), Math.round(res.fullHeight * scale)];
    if (res.tex.width < want[0] || res.tex.height < want[1]) {
      const max = this.gl.maxSize;
      const fit = Math.floor((max / Math.max(want[0] / scale, want[1] / scale)) * 100);
      throw new Error(
        `The output would be ${want[0]}×${want[1]} px, larger than this GPU's ${max} px texture limit. ` + `The largest scale that fits is ${fit}% — export at that or less, or reduce upscaling in the graph.`,
      );
    }
    const img = this.toImageData(res.tex);
    const c = new OffscreenCanvas(img.width, img.height);
    c.getContext('2d')!.putImageData(img, 0, 0);
    return c.convertToBlob({ type: opts.type ?? 'image/png', quality: opts.quality ?? 0.92 });
  }
}

/** Map a (possibly nested) group node id to the flat inner node + port feeding its first output. */
function resolveGroupTarget(graph: Graph, id: string, prefix = ''): { id: string; port: string } | undefined {
  const g = graph.nodes.find((n) => n.id === id);
  if (!g && id.includes('/')) {
    // a nested group addressed by its flat path ('g1/g2'): descend into the outer group first
    const [head, ...rest] = id.split('/');
    const outer = graph.nodes.find((n) => n.id === head);
    return outer?.group ? resolveGroupTarget(outer.group.graph, rest.join('/'), prefix + head + '/') : undefined;
  }
  if (!g) return undefined;
  if (!g.group) return { id: prefix + id, port: '' };
  const outNode = g.group.graph.nodes.find((n) => n.type === 'core.groupOutput');
  const e = g.group.graph.edges.find((e) => e.to.node === outNode?.id);
  if (!e) return undefined;
  const r = resolveGroupTarget(g.group.graph, e.from.node, prefix + id + '/');
  return r && { id: r.id, port: r.port || e.from.port };
}

const BLIT_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_src;
void main() { fragColor = texture(u_src, v_uv); }`;

const PRESENT_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_img;
uniform sampler2D u_cmp;
uniform vec4 u_rect;   // x, y (GL bottom-left origin), w, h
uniform float u_split; // canvas x (mode 1) / GL y (mode 2) of the split; <0 = none
uniform int u_cmpMode; // 0 none, 1 left/right, 2 top/bottom, 3 compare only
uniform int u_channel; // 0 rgb, 1 r, 2 g, 3 b, 4 a, 5 luma
uniform vec3 u_clip;   // on, lo, hi
uniform vec3 u_bg;
void main() {
  vec2 p = gl_FragCoord.xy;
  vec2 uv = (p - u_rect.xy) / u_rect.zw;
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) { fragColor = vec4(u_bg, 1.0); return; }
  uv.y = 1.0 - uv.y; // texture row 0 = image top
  bool useCmp = u_cmpMode == 3 || (u_cmpMode == 1 && p.x < u_split) || (u_cmpMode == 2 && p.y > u_split);
  vec4 c = useCmp ? texture(u_cmp, uv) : texture(u_img, uv);
  vec3 rgb = c.rgb;
  float a = c.a;
  if (u_channel == 1) rgb = vec3(c.r);
  else if (u_channel == 2) rgb = vec3(c.g);
  else if (u_channel == 3) rgb = vec3(c.b);
  else if (u_channel == 4) { rgb = vec3(c.a); a = 1.0; }
  else if (u_channel == 5) rgb = vec3(dot(c.rgb, vec3(0.2126, 0.7152, 0.0722)));
  // checkerboard behind transparency
  vec2 cb = floor(p / 8.0);
  float chk = mod(cb.x + cb.y, 2.0) < 1.0 ? 0.32 : 0.42;
  vec3 col = mix(vec3(chk), clamp(rgb, 0.0, 1.0), clamp(a, 0.0, 1.0));
  if (u_clip.x > 0.5 && a > 0.0) {
    vec3 v = u_channel == 0 ? c.rgb : rgb;
    if (max(v.r, max(v.g, v.b)) >= u_clip.z) col = vec3(1.0, 0.0, 0.0);
    else if (max(v.r, max(v.g, v.b)) <= u_clip.y) col = vec3(0.0, 0.35, 1.0);
  }
  if ((u_cmpMode == 1 && abs(p.x - u_split) < 1.0) || (u_cmpMode == 2 && abs(p.y - u_split) < 1.0)) col = vec3(1.0);
  fragColor = vec4(col, 1.0);
}`;


/** Thumbnail downsample: an n×n grid of bilinear taps (≈2n×2n box) per output pixel, premultiplied. */
const THUMB_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_src;
uniform vec2 u_resolution;
uniform int u_taps;
uniform int u_mask;
void main() {
  vec2 px = 1.0 / u_resolution;
  vec4 acc = vec4(0.0);
  float n = float(u_taps);
  for (int y = 0; y < 8; y++) {
    if (y >= u_taps) break;
    for (int x = 0; x < 8; x++) {
      if (x >= u_taps) break;
      vec2 o = (vec2(float(x), float(y)) + 0.5) / n - 0.5;
      vec4 c = clamp(texture(u_src, v_uv + o * px), 0.0, 1.0);
      acc += vec4(c.rgb * c.a, c.a);
    }
  }
  acc /= n * n;
  if (u_mask == 1) { float m = acc.a > 0.0 ? acc.r / acc.a : 0.0; fragColor = vec4(m, m, m, 1.0); return; }
  fragColor = acc.a > 0.0 ? vec4(acc.rgb / acc.a, acc.a) : vec4(0.0);
}`;
