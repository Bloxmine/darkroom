import { Engine } from '../core/engine';
import { flattenGraph, IMAGE } from '../core/graph';
import type { Tex } from '../core/gl';
import type { Graph } from '../core/types';
import { effectiveViewed, useDoc } from './doc';
import { useUi, type Quality } from './ui';
import { previewCapScale } from './settings';

/**
 * The engine singleton. Lives outside React: it owns a canvas which the
 * Viewer component adopts into its DOM. Rendering is coalesced to one rAF.
 */
export const viewerCanvas = document.createElement('canvas');
viewerCanvas.className = 'viewer-canvas';

let engineErr: string | null = null;
let eng: Engine | null = null;
try {
  eng = new Engine(viewerCanvas);
} catch (e) {
  engineErr = String((e as Error)?.message ?? e);
  console.error('[darkroom] WebGL2 unavailable', e);
}
export const engine = eng as Engine;
export const engineError = engineErr;

if (eng) eng.onInvalidate = () => requestRender();

/** Called after every viewer render (e.g. the node-thumbnail scheduler). */
export const afterRender = new Set<() => void>();

let raf = 0;
/** While true (video export owns the canvas), viewer renders are skipped. */
let suspended = false;
export function suspendRender(on: boolean) {
  suspended = on;
  if (on && raf) {
    cancelAnimationFrame(raf);
    raf = 0;
  }
}
/** Render the viewer synchronously now (playback: exactly one render per timeline step). */
export function renderImmediately() {
  if (!eng || suspended) return;
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  renderNow();
}
export function requestRender() {
  if (raf || !eng || suspended) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    renderNow();
  });
}

const QUALITY_FACTOR: Record<Quality, number> = { draft: 0.25, half: 0.5, screen: 1, full: 1 };
const SCALE_STEPS = [1 / 32, 1 / 16, 1 / 8, 0.1875, 0.25, 0.3125, 0.375, 0.5, 0.625, 0.75, 0.875, 1];

/** Pick a render scale ≥ s from a small set (keeps the cache stable while zooming). */
function quantize(s: number) {
  for (const q of SCALE_STEPS) if (q >= s - 1e-4) return q;
  return 1;
}

let lastFull = { w: 0, h: 0 };
/** Last preview render scale (used to measure sizes without trashing the cache). */
export let previewScale = 0.25;

export function fitZoomFor(w: number, h: number) {
  const cw = viewerCanvas.width;
  const ch = viewerCanvas.height;
  if (!w || !h || !cw || !ch) return 1;
  const m = 24 * (window.devicePixelRatio || 1);
  return Math.max(0.01, Math.min((cw - m) / w, (ch - m) / h));
}

const isSourceType = (t?: string) => t === IMAGE || t === 'core.raw' || t === 'core.video' || t === 'core.webcam';

/** Nearest upstream core.image / core.raw node of `target` in the flattened graph (or the first image). */
export function compareSource(graph: Graph, target: string): string | undefined {
  const flat = flattenGraph(graph);
  const byId = new Map(flat.nodes.map((n) => [n.id, n]));
  const inc = new Map<string, string[]>();
  for (const e of flat.edges) inc.set(e.to.node, [...(inc.get(e.to.node) ?? []), e.from.node]);
  // a group id isn't in the flat graph: start from its inner nodes' sources
  let frontier = byId.has(target) ? [target] : flat.nodes.filter((n) => n.id.startsWith(target + '/')).map((n) => n.id);
  const seen = new Set<string>();
  while (frontier.length) {
    const next: string[] = [];
    for (const id of frontier) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (isSourceType(byId.get(id)?.type) && id !== target) return id;
      next.push(...(inc.get(id) ?? []));
    }
    frontier = next;
  }
  return flat.nodes.find((n) => isSourceType(n.type))?.id;
}

function renderNow() {
  if (!eng) return;
  const doc = useDoc.getState();
  const ui = useUi.getState();
  const graph = doc.project.graph;
  const target = effectiveViewed(doc);
  const cw = viewerCanvas.width;
  const ch = viewerCanvas.height;
  if (!cw || !ch) return;

  // Estimate the display zoom (needs the node's full size: use last frame's or the project size).
  let fw = lastFull.w;
  let fh = lastFull.h;
  if (!fw) {
    const ps = eng.getProjectSize(graph);
    fw = ps.width;
    fh = ps.height;
  }
  const zoom = ui.fit ? fitZoomFor(fw, fh) : ui.zoom;
  const scale = Math.min(ui.quality === 'full' ? 1 : Math.min(1, quantize(Math.min(1, zoom) * QUALITY_FACTOR[ui.quality])), previewCapScale(fw, fh)); // cap: Preferences › Performance
  previewScale = scale;

  let res;
  try {
    res = eng.render(graph, { nodeId: target, scale });
  } catch (e) {
    console.error(e);
    eng.present(null, { rect: { x: 0, y: 0, w: 0, h: 0 }, background: BG });
    return;
  }
  if (res.fullWidth && (res.fullWidth !== lastFull.w || res.fullHeight !== lastFull.h)) {
    const first = !lastFull.w;
    lastFull = { w: res.fullWidth, h: res.fullHeight };
    if (!first || ui.fit) requestRender(); // re-run with the right size
  }
  let cmp: Tex | null = null;
  if (ui.compare && target) {
    const src = compareSource(graph, target);
    if (src && src !== target) cmp = eng.render(graph, { nodeId: src, scale }).tex;
  }
  const z = ui.fit ? fitZoomFor(res.fullWidth || fw, res.fullHeight || fh) : ui.zoom;
  const w = (res.fullWidth || fw) * z;
  const h = (res.fullHeight || fh) * z;
  const panX = ui.fit ? 0 : ui.panX;
  const panY = ui.fit ? 0 : ui.panY;
  const x = cw / 2 + panX - w / 2;
  const y = ch / 2 + panY - h / 2;
  eng.present(res.tex, {
    rect: { x, y, w, h },
    compare: ui.compare ? (cmp ?? res.tex) : null,
    split: ui.split * cw,
    pixelated: z > 1.001,
    background: BG,
  });

  // publish stats (only when changed to avoid needless React work)
  const errors: Record<string, string> = {};
  const pending: string[] = [];
  for (const [k, v] of eng.errors) {
    if (v.startsWith('[pending]')) pending.push(k);
    else errors[k] = v;
  }
  const prev = useUi.getState();
  const patch: Partial<typeof prev> = {
    renderMs: Math.round(res.ms * 10) / 10,
    fullWidth: res.fullWidth,
    fullHeight: res.fullHeight,
    renderScale: res.scale,
    renderWidth: res.width,
    renderHeight: res.height,
  };
  if (ui.fit && Math.abs(prev.zoom - z) > 1e-6) patch.zoom = z;
  if (JSON.stringify(errors) !== JSON.stringify(prev.errors)) patch.errors = errors;
  if (pending.join() !== prev.pending.join()) patch.pending = pending;
  useUi.setState(patch);
  for (const fn of afterRender) fn();
}

const BG: [number, number, number] = [0.235, 0.235, 0.24];

/** Current display rect of the image in canvas device px (for hit-testing in the viewer). */
export function imageRect() {
  const ui = useUi.getState();
  const cw = viewerCanvas.width;
  const ch = viewerCanvas.height;
  const z = ui.fit ? fitZoomFor(lastFull.w, lastFull.h) : ui.zoom;
  const w = lastFull.w * z;
  const h = lastFull.h * z;
  const px = ui.fit ? 0 : ui.panX;
  const py = ui.fit ? 0 : ui.panY;
  return { x: cw / 2 + px - w / 2, y: ch / 2 + py - h / 2, w, h, zoom: z, fullW: lastFull.w, fullH: lastFull.h };
}

export function resetRenderSize() {
  lastFull = { w: 0, h: 0 };
}

// Re-render whenever something render-relevant changes.
useDoc.subscribe((s, p) => {
  if (s.project.graph !== p.project.graph || s.viewed !== p.viewed || s.project.outputNode !== p.project.outputNode) requestRender();
});
useUi.subscribe((s, p) => {
  if (s.fit !== p.fit || s.zoom !== p.zoom || s.panX !== p.panX || s.panY !== p.panY || s.compare !== p.compare || s.split !== p.split || s.quality !== p.quality)
    requestRender();
});
