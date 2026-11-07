/**
 * Preset Browser (View › Preset Browser, Shift+P): every preset applied to the current image as a
 * live thumbnail. Each preview is a temporary copy of the graph with the preset group spliced in
 * after the same node "Apply" would use, rendered through the engine in its own cache namespace
 * ('presetBrowser', a small maxSize) a couple per idle frame, then point-decimated + read back
 * asynchronously — the UI and the viewer never block on it. The shared upstream chain is cached
 * in that namespace, so each preset only costs its own nodes.
 *
 * Click a tile to apply: the preset is inserted on the wire after the selected node, else after
 * the viewed node, else on the wire into the Output (undoable, via actions.addNode).
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { getPorts, GROUP, GROUP_OUTPUT, IMAGE, OUTPUT } from '../../core/graph';
import { decimate } from '../../core/readback';
import { getNodeDef, listPresets, registryVersion, subscribeRegistry } from '../../core/registry';
import type { Graph, GraphNode, PresetDef } from '../../core/types';
import { addNode, buildNode, viewNode } from '../../store/actions';
import { currentGraph, effectiveViewed, useDoc } from '../../store/doc';
import { engine, PREVIEW_PREFIX } from '../../store/engine';
import { rightOf } from '../../store/graphEdit';
import { graphAt, localIdForFlat, updateGraphAt } from '../../store/graphPath';
import { useSettings } from '../../store/settings';
import { status } from '../../store/ui';
import { useViewer } from '../../store/viewer';
import { categoryIcon, Icon } from '../Icon';
import './viewerPro.css';

// ---------------------------------------------------------------------------
// Where a preset goes
// ---------------------------------------------------------------------------

const isSource = (t: string) => t === IMAGE || t === 'core.raw' || t === 'core.video' || t === 'core.webcam';

export interface ApplyPlan {
  path: string[];
  /** Output feeding the preset (null: nothing to apply to). */
  feed: { node: string; port: string } | null;
  /** Wire to splice the preset into. */
  edge?: string;
  /** Re-point the viewer at the new node (the anchor was the viewed node, not the output). */
  view: boolean;
}

/** After the selected node, else after the viewed node, else on the wire into the output. */
export function applyPlan(): ApplyPlan {
  const s = useDoc.getState();
  const g = currentGraph(s);
  const path = s.path;
  const after = (n: GraphNode, view: boolean): ApplyPlan | null => {
    if (n.type === OUTPUT || n.type === GROUP_OUTPUT) return null;
    const port = Object.keys(getPorts(n).outputs)[0];
    if (!port) return null;
    const e = g.edges.find((x) => x.from.node === n.id && x.from.port === port);
    return { path, feed: { node: n.id, port }, edge: e?.id, view };
  };
  if (s.selection.length === 1) {
    const n = g.nodes.find((x) => x.id === s.selection[0]);
    const p = n && after(n, false);
    if (p) return p;
  }
  const viewed = effectiveViewed(s);
  const local = viewed ? localIdForFlat(path, viewed) : null;
  if (local && viewed === [...path, local].join('/')) {
    const n = g.nodes.find((x) => x.id === local);
    const p = n && after(n, true);
    if (p) return p;
  }
  const out = g.nodes.find((n) => n.type === OUTPUT) ?? g.nodes.find((n) => n.type === GROUP_OUTPUT);
  const e = out && g.edges.find((x) => x.to.node === out.id);
  if (e) return { path, feed: e.from, edge: e.id, view: false };
  const src = g.nodes.find((n) => isSource(n.type));
  const port = src && Object.keys(getPorts(src).outputs)[0];
  return { path, feed: src && port ? { node: src.id, port } : null, view: false };
}

export function applyPreset(id: string) {
  const plan = applyPlan();
  const g = currentGraph();
  const from = plan.feed && g.nodes.find((n) => n.id === plan.feed!.node);
  const pos = from ? rightOf(from) : { x: 0, y: 0 };
  const nid = plan.edge
    ? addNode({ kind: 'preset', id }, pos, undefined, { edge: plan.edge })
    : addNode({ kind: 'preset', id }, pos, plan.feed ? { ...plan.feed, kind: 'source' } : undefined);
  if (!nid) return status('Could not add that preset.', 'error');
  if (plan.view) viewNode(nid);
  const p = listPresets().find((x) => x.id === id);
  status(`Applied preset “${p?.name ?? id}”. Undo (⌘Z) removes it.`);
}

// ---------------------------------------------------------------------------
// Preview rendering
// ---------------------------------------------------------------------------

/** Does a group (recursively) contain AI / generation nodes (slow, may download models)? */
function isSlowGraph(g: Graph): boolean {
  return g.nodes.some((n) => {
    if (n.type === GROUP && n.group) return isSlowGraph(n.group.graph);
    const d = getNodeDef(n.type);
    return n.type.startsWith('ai.') || n.type.startsWith('sd.') || !!d?.heavy;
  });
}
export const isSlowPreset = (p: PresetDef) => p.category === 'AI' || p.category === 'ControlNet' || isSlowGraph(p.group.graph);

/** Flat id + port feeding a (preview) group node's output. */
function groupTarget(n: GraphNode, prefix: string, depth = 0): { id: string; port: string } | null {
  if (n.type !== GROUP || !n.group) return { id: prefix + n.id, port: Object.keys(getPorts(n).outputs)[0] ?? 'out' };
  if (depth > 12) return null;
  const out = n.group.graph.nodes.find((x) => x.type === GROUP_OUTPUT);
  const e = out && n.group.graph.edges.find((x) => x.to.node === out.id);
  const inner = e && n.group.graph.nodes.find((x) => x.id === e.from.node);
  if (!e || !inner) return null;
  const r = groupTarget(inner, prefix + n.id + '/', depth + 1);
  return r && (inner.type === GROUP ? r : { ...r, port: e.from.port });
}

interface Thumb {
  url: string | null;
  key: string;
  error?: string;
}

const thumbs = new Map<string, Thumb>();
let version = 0;
const listeners = new Set<() => void>();
const bump = () => {
  version++;
  listeners.forEach((f) => f());
};
const subscribeThumbs = (f: () => void) => {
  listeners.add(f);
  return () => void listeners.delete(f);
};

/** Render one preset preview for the current plan. Null url + no error = still pending (retry). */
async function renderPreview(p: PresetDef, size: number, key: string): Promise<Thumb | null> {
  if (!engine) return { url: null, key, error: 'WebGL2 unavailable' };
  const plan = applyPlan();
  if (!plan.feed) return { url: null, key, error: 'Nothing to apply to' };
  const s = useDoc.getState();
  const n = buildNode({ kind: 'preset', id: p.id }, { x: 0, y: 0 });
  if (!n) return { url: null, key, error: 'Unknown preset' };
  n.id = PREVIEW_PREFIX + p.id.replace(/[^\w]/g, '_');
  const inPort = Object.keys(getPorts(n).inputs)[0];
  if (!inPort) return { url: null, key, error: 'Preset has no input' };
  const root: Graph = updateGraphAt(s.project.graph, plan.path, (g) => ({
    ...g,
    nodes: [...g.nodes, n],
    edges: [...g.edges, { id: n.id + '_in', from: plan.feed!, to: { node: n.id, port: inPort } }],
  }));
  const prefix = plan.path.length ? plan.path.join('/') + '/' : '';
  const t = groupTarget(n, prefix);
  if (!t) return { url: null, key, error: 'Preset has no output' };
  const res = engine.render(root, { nodeId: t.id, port: t.port, maxSize: size, cacheTag: 'presetBrowser' });
  const pending = [...engine.errors].filter(([k, v]) => k.startsWith(prefix + n.id + '/') && v.startsWith('[pending]'));
  const errs = [...engine.errors].filter(([k, v]) => k.startsWith(prefix + n.id + '/') && !v.startsWith('[pending]'));
  for (const [k] of [...pending, ...errs]) engine.errors.delete(k); // keep them out of the status bar
  if (errs.length) return { url: null, key, error: errs[0][1].split('\n')[0] };
  if (pending.length || !res.tex) return null;
  // first use of a preset's node types compiles their shaders on the GPU: allow time for that
  const img = await decimate(engine.gl, res.tex, size, 20000);
  if (!img) return null;
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d')!.putImageData(img, 0, 0);
  return { url: c.toDataURL('image/jpeg', 0.86), key };
}

/** Changes whenever the preview input would: graph, level, selection, viewed node, size. */
function inputKey(size: number) {
  const s = useDoc.getState();
  return JSON.stringify([size, s.path, s.selection.length === 1 ? s.selection[0] : '', s.viewed ?? '', registryVersion()]) + '|' + graphVersion;
}
let graphVersion = 0;
let lastGraph: Graph | null = null;

/** The idle-time render queue. */
function useRenderQueue(presets: PresetDef[], size: number, open: boolean) {
  const queue = useRef<string[]>([]);
  const tries = useRef(new Map<string, number>());
  const retryAt = useRef(new Map<string, number>());
  useEffect(() => {
    if (!open) return;
    let alive = true;
    let timer = 0;
    let key = '';
    const refill = () => {
      const g = useDoc.getState().project.graph;
      if (g !== lastGraph) {
        lastGraph = g;
        graphVersion++;
      }
      key = inputKey(size);
      queue.current = presets.filter((p) => thumbs.get(p.id)?.key !== key).map((p) => p.id);
      tries.current.clear();
      retryAt.current.clear();
    };
    const tick = async () => {
      if (!alive) return;
      const t0 = performance.now();
      let n = 0;
      let scanned = 0;
      while (queue.current.length && n < 3 && performance.now() - t0 < 14 && scanned++ < queue.current.length + 1) {
        const id = queue.current.shift()!;
        const p = presets.find((x) => x.id === id);
        if (!p) continue;
        if ((retryAt.current.get(id) ?? 0) > performance.now()) {
          queue.current.push(id); // an async node in it is still working: look again later
          continue;
        }
        let th: Thumb | null = null;
        const r0 = performance.now();
        try {
          th = await renderPreview(p, size, key);
          if (performance.now() - r0 > 8) n = 3; // a slow one (shader compiles): yield the frame
        } catch (e) {
          th = { url: null, key, error: String((e as Error)?.message ?? e) };
        }
        if (!alive) return;
        if (th) {
          thumbs.set(id, th);
          bump();
        } else {
          const k = (tries.current.get(id) ?? 0) + 1;
          tries.current.set(id, k);
          retryAt.current.set(id, performance.now() + 200);
          if (k < 60) queue.current.push(id); // async (cpu) node still working: retry later (≈ 12 s max)
        }
        n++;
      }
      const more = queue.current.some((id) => (retryAt.current.get(id) ?? 0) <= performance.now());
      // next batch when the browser is idle (never ahead of input / viewer frames)
      const ric = (window as unknown as { requestIdleCallback?: (f: () => void, o: { timeout: number }) => number }).requestIdleCallback;
      timer = window.setTimeout(() => (ric ? ric(() => void tick(), { timeout: 200 }) : void tick()), more ? 0 : 120);
    };
    refill();
    void tick();
    // debounce: a slider drag shouldn't restart every preview each frame
    let deb = 0;
    const again = () => {
      clearTimeout(deb);
      deb = window.setTimeout(refill, 350);
    };
    const u1 = useDoc.subscribe((s, p) => (s.project.graph !== p.project.graph || s.selection !== p.selection || s.viewed !== p.viewed || s.path !== p.path) && again());
    const u2 = subscribeRegistry(again);
    return () => {
      alive = false;
      clearTimeout(timer);
      clearTimeout(deb);
      u1();
      u2();
      engine?.dropCache('presetBrowser');
    };
  }, [open, presets, size]);
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

export function PresetBrowser() {
  const open = useViewer((s) => s.presetBrowser);
  if (!open) return null;
  return <PresetBrowserWindow />;
}

function PresetBrowserWindow() {
  const size = useSettings((s) => s.presetThumbSize);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('All');
  const [ai, setAi] = useState(false);
  const regV = useSyncExternalStore(subscribeRegistry, registryVersion);
  useSyncExternalStore(subscribeThumbs, () => version);
  const all = useMemo(() => listPresets().sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name)), [regV]);
  const cats = useMemo(() => ['All', ...new Set(all.filter((p) => ai || !isSlowPreset(p)).map((p) => p.category))], [all, ai]);
  const shown = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return all.filter(
      (p) =>
        (ai || !isSlowPreset(p)) &&
        (cat === 'All' || p.category === cat) &&
        (!ql || [p.name, p.category, p.description ?? '', ...(p.tags ?? [])].some((s) => s.toLowerCase().includes(ql))),
    );
  }, [all, q, cat, ai]);
  useRenderQueue(shown, size, true);
  const plan = applyPlan();
  const g = graphAt(useDoc.getState().project.graph, plan.path);
  const anchor = plan.feed && g?.nodes.find((n) => n.id === plan.feed!.node);
  const anchorName = anchor ? (anchor.label ?? getNodeDef(anchor.type)?.name ?? anchor.type) : '';
  useDoc((s) => `${s.selection.join()}|${s.viewed}|${s.path.join('/')}`); // re-render the "applies after" hint
  const done = shown.filter((p) => thumbs.get(p.id)?.url).length;
  return createPortal(
    <div className="vx-pb window" role="dialog" aria-label="Preset Browser">
      <div className="titlebar">
        <Icon name="book_picture" />
        <span className="titlebar-text">Preset Browser</span>
        <button className="titlebar-close" title="Close (Shift+P)" onClick={() => useViewer.setState({ presetBrowser: false })}>
          ✕
        </button>
      </div>
      <div className="vx-pb-bar">
        <input className="field text vx-pb-search" placeholder="Search presets…" value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} autoFocus />
        <select className="field select" value={cats.includes(cat) ? cat : 'All'} onChange={(e) => setCat(e.target.value)} title="Category">
          {cats.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <label className="vx-check" title="AI and generation presets run neural networks (and may download models) for every preview">
          <input type="checkbox" checked={ai} onChange={(e) => setAi(e.target.checked)} /> Include AI presets (slow)
        </label>
        <span className="flex1" />
        <span className="muted small">
          {done < shown.length ? `Rendering ${done}/${shown.length}…` : `${shown.length} presets`} · applies after <b>{anchorName || '—'}</b>
        </span>
      </div>
      <div className="vx-pb-grid" style={{ '--pb-size': `${size}px` } as React.CSSProperties}>
        {shown.map((p) => {
          const th = thumbs.get(p.id);
          return (
            <button key={p.id} className="vx-pb-tile" title={p.description ? `${p.name}\n${p.description}` : p.name} onClick={() => applyPreset(p.id)} data-preset={p.id}>
              <span className="vx-pb-img">
                {th?.url ? <img src={th.url} alt="" draggable={false} /> : th?.error ? <span className="vx-pb-err">{th.error}</span> : <span className="vx-pb-wait" />}
              </span>
              <span className="vx-pb-name">
                <Icon name={categoryIcon(p.category)} /> {p.name}
              </span>
              <span className="vx-pb-cat muted">{p.category}</span>
            </button>
          );
        })}
        {!shown.length && <div className="muted vx-pb-empty">No presets match.</div>}
      </div>
    </div>,
    document.body,
  );
}
