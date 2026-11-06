import { GL, ShaderCompileError, type Tex } from './gl';
import { GLSL_LIB } from './glsl';
import { flattenGraph, getPorts, IMAGE, OUTPUT } from './graph';
import { getNodeDef, subscribeRegistry } from './registry';
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
}

/** Built-in uniform names; params whose `u_<key>` would collide get no auto-uniform (use `uniforms()` instead). */
const RESERVED = new Set(['u_resolution', 'u_scale', 'u_time', 'u_iteration', 'u_prev']);

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
  projectSize: { width: number; height: number } | null = null;

  private cache = new Map<string, CacheEntry>();
  private cpu = new Map<string, CpuEntry>();
  private presentProg = PRESENT_FRAG;
  private unsub: () => void;

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
  }

  /** Full-resolution project size: explicit, else first Image node's asset, else 1920x1080. */
  getProjectSize(graph: Graph) {
    if (this.projectSize) return this.projectSize;
    const flat = flattenGraph(graph);
    for (const n of flat.nodes) {
      if (n.type !== IMAGE) continue;
      const a = this.assets.get(String(n.params.asset ?? ''));
      if (a?.width && a.height) return { width: a.width, height: a.height };
    }
    return { width: 1920, height: 1080 };
  }

  render(graph: Graph, opts: RenderOptions = {}): RenderResult {
    const t0 = performance.now();
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
    const empty: RenderResult = { tex: null, width: 0, height: 0, fullWidth: 0, fullHeight: 0, scale: 1, ms: 0 };
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
        res = this.evalNode(node, incoming.get(id) ?? new Map(), (src) => (nodes.has(src) ? evalNode(src) : null), scale, projectSize);
        if (this.errors.get(id)?.startsWith('[pending]')) this.errors.delete(id);
      } catch (e) {
        this.errors.set(id, e instanceof ShaderCompileError ? e.log : String((e as Error)?.message ?? e));
        if (e instanceof ShaderCompileError) console.warn(`[darkroom] ${node.type}:`, e.log);
        res = null;
      }
      visiting.delete(id);
      memo.set(id, res);
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
    if (!def) throw new Error(`Unknown node type "${node.type}" (missing plugin?)`);
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
      const centry = this.cpu.get(node.id);
      if (!centry || centry.key !== cpuKey) {
        this.runCpu(node, def, cpuKey, inputs, scale, projectSize);
      }
      const c = this.cpu.get(node.id)!;
      if (c.status === 'pending') {
        this.errors.set(node.id, '[pending] loading…');
        return null;
      }
      if (c.status === 'error') throw new Error(c.error);
      cpuTex = c.textures;
    }

    const key = JSON.stringify([node.type, node.params, width, height, scale, this.time, inputKeys, cpuKey]);
    const cached = this.cache.get(node.id);
    if (cached && cached.key === key) return cached;

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
      const ctx: PassContext = { params: node.params, width, height, scale, inputSizes, passSizes };
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
    const old = this.cpu.get(node.id);
    const entry: CpuEntry = { key, status: 'pending', textures: old?.textures ?? {} };
    this.cpu.set(node.id, entry);
    const finish = (res: Record<string, TexSource>) => {
      if (this.cpu.get(node.id) !== entry) return; // superseded
      const textures: Record<string, Tex> = {};
      for (const [k, src] of Object.entries(res)) textures[k] = this.gl.upload(src, entry.textures[k]);
      for (const [k, t] of Object.entries(entry.textures)) if (!(k in res)) this.gl.destroy(t);
      entry.textures = textures;
      entry.status = 'done';
    };
    const fail = (e: unknown) => {
      if (this.cpu.get(node.id) !== entry) return;
      entry.status = 'error';
      entry.error = String((e as Error)?.message ?? e);
    };
    try {
      const r = def.cpu!({
        params: node.params,
        scale,
        projectSize,
        getAsset: (id) => this.assets.get(id),
        readInput: (name) => {
          const t = inputs[name];
          if (!t) return null;
          return { width: t.width, height: t.height, data: this.gl.readFloat(t) } satisfies RawTex;
        },
      });
      if (r instanceof Promise) {
        r.then(finish, fail).finally(() => this.onInvalidate());
      } else finish(r);
    } catch (e) {
      fail(e);
    }
  }

  private header(inputs: string[], passIndex: number, cpuNames: string[], params: [string, ParamDef][]) {
    const lines = ['#version 300 es', 'precision highp float;', 'precision highp int;', 'in vec2 v_uv;', 'out vec4 fragColor;',
      'uniform vec2 u_resolution;', 'uniform float u_scale;', 'uniform float u_time;', 'uniform int u_iteration;'];
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

  /** Draw a rendered texture to the canvas (the viewer). */
  present(res: Tex | null, opts: PresentOptions) {
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
        u_split: opts.compare ? (opts.split ?? 0) : -1,
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

  /** Read a rendered texture back as ImageData (8-bit, clamped). */
  toImageData(t: Tex): ImageData {
    return new ImageData(this.gl.readU8(t) as Uint8ClampedArray<ArrayBuffer>, t.width, t.height);
  }

  /** Render at full resolution and encode. */
  async export(graph: Graph, opts: { nodeId?: string; type?: 'image/png' | 'image/jpeg' | 'image/webp'; quality?: number; scale?: number } = {}): Promise<Blob> {
    const res = this.render(graph, { nodeId: opts.nodeId, scale: opts.scale ?? 1 });
    if (!res.tex) throw new Error('Nothing to export — connect something to the Output node.');
    const img = this.toImageData(res.tex);
    const c = new OffscreenCanvas(img.width, img.height);
    c.getContext('2d')!.putImageData(img, 0, 0);
    return c.convertToBlob({ type: opts.type ?? 'image/png', quality: opts.quality ?? 0.92 });
  }
}

/** Map a (possibly nested) group node id to the flat inner node + port feeding its first output. */
function resolveGroupTarget(graph: Graph, id: string, prefix = ''): { id: string; port: string } | undefined {
  const g = graph.nodes.find((n) => n.id === id);
  if (!g) return undefined;
  if (!g.group) return { id: prefix + id, port: '' };
  const outNode = g.group.graph.nodes.find((n) => n.type === 'core.groupOutput');
  const e = g.group.graph.edges.find((e) => e.to.node === outNode?.id);
  if (!e) return undefined;
  const r = resolveGroupTarget(g.group.graph, e.from.node, prefix + id + '/');
  return r && { id: r.id, port: r.port || e.from.port };
}

const PRESENT_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_img;
uniform sampler2D u_cmp;
uniform vec4 u_rect;   // x, y (GL bottom-left origin), w, h
uniform float u_split; // canvas x of split; <0 = none
uniform vec3 u_bg;
void main() {
  vec2 p = gl_FragCoord.xy;
  vec2 uv = (p - u_rect.xy) / u_rect.zw;
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) { fragColor = vec4(u_bg, 1.0); return; }
  uv.y = 1.0 - uv.y; // texture row 0 = image top
  vec4 c = (u_split >= 0.0 && p.x < u_split) ? texture(u_cmp, uv) : texture(u_img, uv);
  // checkerboard behind transparency
  vec2 cb = floor(p / 8.0);
  float chk = mod(cb.x + cb.y, 2.0) < 1.0 ? 0.32 : 0.42;
  vec3 col = mix(vec3(chk), clamp(c.rgb, 0.0, 1.0), clamp(c.a, 0.0, 1.0));
  if (u_split >= 0.0 && abs(p.x - u_split) < 1.0) col = vec3(1.0);
  fragColor = vec4(col, 1.0);
}`;
