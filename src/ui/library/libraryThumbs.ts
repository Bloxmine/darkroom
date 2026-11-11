/**
 * Live preview thumbnails for the Node Library's Icons view (optional, off by default): each node
 * applied to the current image where the Preset Browser would apply a preset (after the selected /
 * viewed node, else before the Output). Rendered through the engine in its own cache namespace
 * ('libraryPreview', small maxSize) a few per idle frame, then point-decimated and read back
 * asynchronously, like src/ui/viewer/PresetBrowser.tsx. AI / heavy / model nodes and sources are
 * never rendered: they keep their icon.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { getPorts, IMAGE } from '../../core/graph';
import { decimate } from '../../core/readback';
import { getNodeDef, registryVersion, subscribeRegistry } from '../../core/registry';
import type { Graph } from '../../core/types';
import { buildNode } from '../../store/actions';
import { useDoc } from '../../store/doc';
import { engine, PREVIEW_PREFIX } from '../../store/engine';
import { updateGraphAt } from '../../store/graphPath';
import { applyPlan } from '../viewer/PresetBrowser';

export const THUMB_PX = 112;
const TAG = 'libraryPreview';

const SLOW_CATS = /^(ai|controlnet|generation)$/i;
const SOURCES = new Set([IMAGE, 'core.raw', 'core.video', 'core.webcam']);

/** Nodes that never get a live preview (slow, need models / downloads, or have nothing to apply to). */
export function skipPreview(type: string): boolean {
  const d = getNodeDef(type);
  if (!d) return true;
  if (SOURCES.has(type) || d.hidden || d.volatile) return true;
  if (type.startsWith('ai.') || type.startsWith('sd.') || type.startsWith('mp.') || d.heavy || SLOW_CATS.test(d.category)) return true;
  if (!d.passes?.length && d.cpu) return true; // pure-CPU nodes (often async / model backed)
  return false;
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
const subscribe = (f: () => void) => {
  listeners.add(f);
  return () => void listeners.delete(f);
};

export function nodeThumb(type: string): string | null {
  return thumbs.get(type)?.url ?? null;
}

async function render(type: string, key: string): Promise<Thumb | null> {
  if (!engine) return { url: null, key, error: 'WebGL2 unavailable' };
  const plan = applyPlan();
  const s = useDoc.getState();
  const n = buildNode({ kind: 'node', type }, { x: 0, y: 0 });
  if (!n) return { url: null, key, error: 'Unknown node' };
  n.id = PREVIEW_PREFIX + 'lib_' + type.replace(/[^\w]/g, '_');
  const ports = getPorts(n);
  const inPort = Object.entries(ports.inputs).find(([, p]) => p.type === 'image')?.[0];
  const outPort = Object.entries(ports.outputs).find(([, p]) => p.type === 'image')?.[0] ?? Object.keys(ports.outputs)[0];
  if (!outPort) return { url: null, key, error: 'No output' };
  if (inPort && !plan.feed) return { url: null, key, error: 'Nothing to apply to' };
  const root: Graph = updateGraphAt(s.project.graph, plan.path, (g) => ({
    ...g,
    nodes: [...g.nodes, n],
    edges: inPort && plan.feed ? [...g.edges, { id: n.id + '_in', from: plan.feed, to: { node: n.id, port: inPort } }] : g.edges,
  }));
  const prefix = plan.path.length ? plan.path.join('/') + '/' : '';
  const fid = prefix + n.id;
  const res = engine.render(root, { nodeId: fid, port: outPort, maxSize: THUMB_PX, cacheTag: TAG });
  const mine = [...engine.errors].filter(([k]) => k === fid || k.startsWith(fid + '/'));
  for (const [k] of mine) engine.errors.delete(k); // keep them out of the status bar
  const errs = mine.filter(([, v]) => !v.startsWith('[pending]'));
  if (errs.length) return { url: null, key, error: errs[0][1].split('\n')[0] };
  if (mine.length || !res.tex) return null;
  const img = await decimate(engine.gl, res.tex, THUMB_PX, 20000);
  if (!img) return null;
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d')!.putImageData(img, 0, 0);
  return { url: c.toDataURL('image/jpeg', 0.85), key };
}

let graphVersion = 0;
let lastGraph: Graph | null = null;
function inputKey() {
  const s = useDoc.getState();
  if (s.project.graph !== lastGraph) {
    lastGraph = s.project.graph;
    graphVersion++;
  }
  return JSON.stringify([s.path, s.selection.length === 1 ? s.selection[0] : '', s.viewed ?? '', registryVersion(), graphVersion]);
}

/**
 * Render previews for `types` (in order) while `on`; re-renders when the image upstream changes.
 * Returns a version number that changes as thumbnails arrive.
 */
export function useNodeThumbs(types: string[], on: boolean): number {
  const v = useSyncExternalStore(subscribe, () => version);
  const sig = types.join(',');
  useEffect(() => {
    if (!on || !engine) return;
    let alive = true;
    let timer = 0;
    let key = '';
    let queue: string[] = [];
    const tries = new Map<string, number>();
    const list = sig ? sig.split(',') : [];
    const refill = () => {
      key = inputKey();
      queue = list.filter((t) => !skipPreview(t) && thumbs.get(t)?.key !== key);
      tries.clear();
    };
    const tick = async () => {
      if (!alive) return;
      const t0 = performance.now();
      let n = 0;
      while (queue.length && n < 3 && performance.now() - t0 < 12) {
        const t = queue.shift()!;
        let th: Thumb | null;
        const r0 = performance.now();
        try {
          th = await render(t, key);
        } catch (e) {
          th = { url: null, key, error: String((e as Error)?.message ?? e) };
        }
        if (!alive) return;
        if (performance.now() - r0 > 8) n = 3; // shader compiles: yield the frame
        if (th) {
          thumbs.set(t, th);
          bump();
        } else {
          const k = (tries.get(t) ?? 0) + 1;
          tries.set(t, k);
          if (k < 20) queue.push(t);
        }
        n++;
      }
      const ric = (window as unknown as { requestIdleCallback?: (f: () => void, o: { timeout: number }) => number }).requestIdleCallback;
      timer = window.setTimeout(() => (ric ? ric(() => void tick(), { timeout: 250 }) : void tick()), queue.length ? 16 : 150);
    };
    refill();
    void tick();
    let deb = 0;
    const again = () => {
      clearTimeout(deb);
      deb = window.setTimeout(refill, 400);
    };
    const u1 = useDoc.subscribe((s, p) => (s.project.graph !== p.project.graph || s.selection !== p.selection || s.viewed !== p.viewed || s.path !== p.path) && again());
    const u2 = subscribeRegistry(again);
    return () => {
      alive = false;
      clearTimeout(timer);
      clearTimeout(deb);
      u1();
      u2();
      engine?.dropCache(TAG);
    };
  }, [sig, on]);
  return v;
}
