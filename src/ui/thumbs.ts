import { getPorts, GROUP, GROUP_INPUT, GROUP_OUTPUT } from '../core/graph';
import type { Graph } from '../core/types';
import { useDoc } from '../store/doc';
import { afterRender, engine } from '../store/engine';
import { graphAt } from '../store/graphPath';
import { useSettings } from '../store/settings';

/**
 * Node thumbnails: a tiny subscription store keyed by flat node id, outside
 * React and the document (no pixels in Zustand / undo history).
 *
 * Design
 * - Nodes the viewer renders are already in the engine's main cache; their
 *   thumbnails are just a GPU downsample + async readback of that texture.
 * - Nodes off the viewed path (side branches, dead ends) are rendered in a
 *   separate engine cache namespace ('thumb', at ≤256 px), so they never evict
 *   the viewer's preview-scale cache entries. That namespace borrows decoded
 *   image textures from the main one instead of re-uploading photos.
 * - Freshness is tracked per node by (graph identity, time): an entry only
 *   counts if it was evaluated for the current document graph. `cacheKey` is
 *   the version: a canvas is redrawn only when its node's key changed.
 * - The pass is debounced (~250 ms after the last viewer render, in idle time)
 *   and skipped while the viewer is busy (slider drag, playback). Readbacks are
 *   async (PBO + fence) and only collected when no newer GPU work is queued, so
 *   they never make the main thread wait for a viewer frame.
 */

export const THUMB_W = 140;
export const THUMB_H = 90;
const THUMB_RENDER_SIZE = 256;
const INTERVAL = 250;
const MAX_WAIT = 1000;
const BUDGET_MS = 12;
const TAG = 'thumb';

type Draw = (img: ImageData | null) => void;
interface Sub {
  flat: string;
  port: string;
  draw: Draw;
  key: string | null;
}

const subs = new Map<string, Set<Sub>>();
/** Debug counters (window.__darkroom.thumbStats). */
export const thumbStats = { passes: 0, passMs: 0, maxPassMs: 0, offPathRenders: 0, reads: 0, drawn: 0, abandoned: 0 };

let timer = 0;
let firstRequest = 0;
let idleQueued = false;
let lastRun = 0;
let lastMainRender = 0;

export function subscribeThumb(flat: string, port: string, draw: Draw): () => void {
  const s: Sub = { flat, port, draw, key: null };
  let set = subs.get(flat);
  if (!set) subs.set(flat, (set = new Set()));
  set.add(s);
  schedule();
  return () => {
    set!.delete(s);
    if (!set!.size) subs.delete(flat);
  };
}

const enabled = () => !!engine && useSettings.getState().nodeThumbnails;

/** Debounced: a pass runs ~250 ms after the last request, but at least once per MAX_WAIT while busy. */
function schedule() {
  if (!enabled() || !subs.size || idleQueued) return;
  const now = performance.now();
  if (!firstRequest) firstRequest = now;
  const due = Math.max(lastRun + INTERVAL, Math.min(now + INTERVAL, firstRequest + MAX_WAIT));
  clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = 0;
    idleQueued = true;
    const go = () => {
      idleQueued = false;
      firstRequest = 0;
      run();
    };
    if ('requestIdleCallback' in window) requestIdleCallback(go, { timeout: 300 });
    else go();
  }, Math.max(16, due - now));
}

afterRender.add(() => {
  lastMainRender = performance.now();
  schedule();
});
useDoc.subscribe((s, p) => {
  if (s.path !== p.path) schedule();
});
useSettings.subscribe((s, p) => {
  if (s.nodeThumbnails === p.nodeThumbnails) return;
  if (s.nodeThumbnails) schedule();
  else engine?.dropCache(TAG);
});

/** What a node's thumbnail shows: the flat engine node + port (groups → the inner node feeding the output). */
interface Target {
  id: string;
  port: string;
  mask: boolean;
}

function resolve(root: Graph, flat: string, port: string, depth = 0): Target | null {
  if (depth > 32) return null;
  const parts = flat.split('/');
  const prefix = parts.slice(0, -1);
  const g = graphAt(root, prefix);
  const n = g?.nodes.find((x) => x.id === parts[parts.length - 1]);
  if (!g || !n) return null;
  const pre = prefix.length ? prefix.join('/') + '/' : '';
  if (n.type === GROUP_INPUT) return null;
  if (n.type === GROUP_OUTPUT) {
    const e = g.edges.find((e) => e.to.node === n.id);
    return e ? resolve(root, pre + e.from.node, e.from.port, depth + 1) : null;
  }
  if (n.type === GROUP) {
    if (!n.group || n.bypass) return null;
    const name = port || Object.keys(getPorts(n).outputs)[0];
    const out = n.group.graph.nodes.find((x) => x.type === GROUP_OUTPUT && String(x.params.name ?? 'out') === name);
    const e = out && n.group.graph.edges.find((e) => e.to.node === out.id);
    return e ? resolve(root, flat + '/' + e.from.node, e.from.port, depth + 1) : null;
  }
  const outs = getPorts(n).outputs;
  const p = port in outs ? port : Object.keys(outs)[0] ?? 'out';
  return { id: flat, port: p, mask: outs[p]?.type === 'mask' };
}

function run() {
  if (!enabled() || !subs.size) return;
  const t0 = performance.now();
  lastRun = t0;
  const dr = (window as unknown as { __darkroom?: Record<string, unknown> }).__darkroom;
  if (dr && !dr.thumbStats) dr.thumbStats = thumbStats;
  const graph = useDoc.getState().project.graph;
  const targets = new Map<Sub, Target | null>();
  for (const set of subs.values()) for (const s of set) targets.set(s, resolve(graph, s.flat, s.port));

  // the viewer is busy (slider drag, playback): stay out of its way, try again later
  if (t0 - lastMainRender < 150) {
    schedule();
    return;
  }

  // 1) make sure every shown node has a current cache entry (off-path → 'thumb' namespace)
  let more = false;
  const tried = new Set<string>();
  for (const t of targets.values()) {
    if (!t || tried.has(t.id) || engine.isCached(t.id, graph)) continue;
    if (performance.now() - t0 > BUDGET_MS) {
      more = true;
      break;
    }
    tried.add(t.id);
    try {
      engine.render(graph, { nodeId: t.id, port: t.port, maxSize: THUMB_RENDER_SIZE, cacheTag: TAG });
    } catch (e) {
      console.warn('[darkroom] thumbnail render failed', e);
    }
    thumbStats.offPathRenders++;
  }

  // 2) redraw the canvases whose node version changed (one shared readback per target)
  const size = Math.round(Math.max(THUMB_W, THUMB_H) * Math.min(2, window.devicePixelRatio || 1));
  const reads = new Map<string, Promise<ImageData | null>>();
  for (const [s, t] of targets) {
    const v = t && engine.cacheKey(t.id, graph);
    const key = t && v ? `${t.id}:${t.port}:${t.mask}:${v}` : null;
    if (key === s.key) continue;
    if (!key || !t) {
      // deferred off-path render: keep the old picture until the next pass
      if (more && t) s.key = '-';
      else {
        s.key = null;
        s.draw(null);
      }
      continue;
    }
    s.key = key;
    let r = reads.get(key);
    if (!r) {
      reads.set(key, (r = engine.thumbnail(t.id, t.port, size, { graph, mask: t.mask })));
      thumbStats.reads++;
    }
    void r.then((img) => {
      if (s.key !== key) return;
      if (img) {
        thumbStats.drawn++;
        s.draw(img);
      } else {
        thumbStats.abandoned++;
        s.key = null; // readback abandoned (engine stayed busy): retry on the next pass
        schedule();
      }
    });
  }
  const dt = performance.now() - t0;
  thumbStats.passes++;
  thumbStats.passMs += dt;
  thumbStats.maxPassMs = Math.max(thumbStats.maxPassMs, dt);
  if (more) schedule();
}

/** Force all thumbnails to refresh (e.g. after a theme change); mostly for debugging. */
export function refreshThumbs() {
  for (const set of subs.values()) for (const s of set) s.key = null;
  schedule();
}
