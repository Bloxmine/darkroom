import { Engine } from '../core/engine';
import { flattenGraph, IMAGE } from '../core/graph';
import type { Tex } from '../core/gl';
import type { Graph } from '../core/types';
import { effectiveViewed, useDoc } from './doc';
import { useUi, type Quality } from './ui';
import { currentPrefs, previewCapScale, useSettings } from './settings';
import { log as diagLog, verbose } from '../core/diag';
import { CHANNEL_INDEX, useViewer } from './viewer';
import { copyTexture } from '../core/readback';

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
  if (cw < 64 || ch < 64) return; // collapsed / mid-layout viewer: nothing useful to render

  // Estimate the display zoom (needs the node's full size: use last frame's or the project size).
  let fw = lastFull.w;
  let fh = lastFull.h;
  if (!fw) {
    const ps = eng.getProjectSize(graph);
    fw = ps.width;
    fh = ps.height;
  }
  const zoom = ui.fit ? fitZoomFor(fw, fh) : ui.zoom;
  // never preview below a 256 px long edge: tiny transient zooms would otherwise start (and abandon) AI jobs
  const floor = quantize(Math.min(1, 256 / Math.max(fw, fh, 1)));
  const scale = Math.max(floor, Math.min(ui.quality === 'full' ? 1 : Math.min(1, quantize(Math.min(1, zoom) * QUALITY_FACTOR[ui.quality])), previewCapScale(fw, fh))); // cap: Preferences › Performance
  previewScale = scale;
  // AI / heavy nodes stay at the fit-to-window preview resolution while zooming (see RenderOptions.heavyScale).
  // It is derived from the *project* (source) size, never from the viewed node's size: a node that changes
  // the image size (AI Upscale ×4, crop, borders) would otherwise feed back into its own inference
  // resolution — the result changes the viewed size, which changes the scale, which restarts the job.
  const ps = eng.getProjectSize(graph);
  const psFloor = quantize(Math.min(1, 256 / Math.max(ps.width, ps.height, 1)));
  const fitScale = Math.max(psFloor, Math.min(1, quantize(Math.min(1, fitZoomFor(ps.width, ps.height)) * QUALITY_FACTOR[ui.quality]), previewCapScale(ps.width, ps.height)));
  const heavyScale = ui.quality === 'full' || currentPrefs().aiFollowZoom ? undefined : fitScale;

  let res;
  try {
    res = eng.render(graph, { nodeId: target, scale, heavyScale });
  } catch (e) {
    console.error(e);
    eng.present(null, { rect: { x: 0, y: 0, w: 0, h: 0 }, background: BG });
    return;
  }
  // While something upstream is still computing, the viewed node may report a placeholder size (e.g. the
  // un-upscaled input). Don't refit to it: that flip-flops the zoom and the preview scale every frame.
  const pendingNow = [...eng.errors.values()].some((v) => v.startsWith('[pending]'));
  if (res.evaluated > 0 && verbose())
    diagLog('debug', 'render', `${target ?? 'output'} @ ${scale}${heavyScale !== undefined ? ` (AI ${heavyScale})` : ''} → ${res.width}×${res.height}, ${res.evaluated} node${res.evaluated === 1 ? '' : 's'}, ${res.ms.toFixed(1)} ms${pendingNow ? ', waiting on async nodes' : ''}`);
  if (res.fullWidth && (res.fullWidth !== lastFull.w || res.fullHeight !== lastFull.h) && (!pendingNow || !lastFull.w)) {
    const first = !lastFull.w;
    lastFull = { w: res.fullWidth, h: res.fullHeight };
    if (!first || ui.fit) requestRender(); // re-run with the right size
  }
  const vw = useViewer.getState();
  const comparing = (ui.compare || vw.hold) && !!target;
  let cmp: Tex | null = null;
  if (comparing) cmp = compareTexture(graph, target!, scale, heavyScale);
  const z = ui.fit ? fitZoomFor(res.fullWidth || fw, res.fullHeight || fh) : ui.zoom;
  const w = (res.fullWidth || fw) * z;
  const h = (res.fullHeight || fh) * z;
  const panX = ui.fit ? 0 : ui.panX;
  const panY = ui.fit ? 0 : ui.panY;
  const x = cw / 2 + panX - w / 2;
  const y = ch / 2 + panY - h / 2;
  presented = { tex: res.tex, ref: comparing ? cmp : null, target: target ?? null, fullW: res.fullWidth, fullH: res.fullHeight };
  const ref = cmp ?? res.tex;
  const mode = vw.hold ? 'full' : vw.compareMode === 'toggle' ? null : vw.compareMode;
  const prefs = useSettings.getState();
  eng.present(vw.swap && mode && mode !== 'full' && ref ? ref : res.tex, {
    rect: { x, y, w, h },
    compare: comparing && mode ? (vw.swap && mode !== 'full' ? res.tex : ref) : null,
    compareMode: mode ?? undefined,
    split: mode === 'v' ? vw.splitY * ch : ui.split * cw,
    pixelated: z > 1.001,
    background: BG,
    channel: CHANNEL_INDEX[vw.channel],
    clip: vw.clip ? { lo: (prefs.clipLow + 0.5) / 255, hi: (prefs.clipHigh - 0.5) / 255 } : null,
  });

  // publish stats (only when changed to avoid needless React work)
  const errors: Record<string, string> = {};
  const pending: string[] = [];
  for (const [k, v] of eng.errors) {
    if (k.includes(PREVIEW_PREFIX)) continue; // the preset browser's temporary nodes
    if (v.startsWith('[pending]')) pending.push(k);
    else errors[k] = v;
  }
  const prev = useUi.getState();
  const patch: Partial<typeof prev> = {
    // a fully cached frame keeps showing the last real render's cost
    ...(res.evaluated > 0 ? { renderMs: Math.round(res.ms * 10) / 10, renderNodes: res.evaluated } : {}),
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

/** Node-id prefix of temporary preview nodes (preset browser); their errors stay out of the status bar. */
export const PREVIEW_PREFIX = '__pb_';

/** What the viewer showed last frame (pixel readout, scopes, snapshot). Valid until the next render. */
export let presented: { tex: Tex | null; ref: Tex | null; target: string | null; fullW: number; fullH: number } = {
  tex: null,
  ref: null,
  target: null,
  fullW: 0,
  fullH: 0,
};

/** Owned copy of a viewer frame for "compare with snapshot". */
let snapshotTex: Tex | null = null;

/** The comparison image for `target` per Viewer › Compare › Reference. */
function compareTexture(graph: Graph, target: string, scale: number, heavyScale?: number): Tex | null {
  const vw = useViewer.getState();
  if (vw.compareRef === 'snapshot' && snapshotTex) return snapshotTex;
  if (vw.compareRef === 'pinned' && vw.pinned && vw.pinned.id !== target) {
    const r = eng!.render(graph, { nodeId: vw.pinned.id, scale, heavyScale });
    if (r.tex) return r.tex;
  }
  const src = compareSource(graph, target);
  return src && src !== target ? eng!.render(graph, { nodeId: src, scale }).tex : null;
}

/** Copy the current viewer frame as the compare snapshot. False if nothing is shown. */
export function takeSnapshot(): boolean {
  if (!eng || !presented.tex) return false;
  const copy = copyTexture(eng.gl, presented.tex);
  if (snapshotTex) eng.gl.destroy(snapshotTex);
  snapshotTex = copy;
  return true;
}
export function clearSnapshot() {
  if (eng && snapshotTex) eng.gl.destroy(snapshotTex);
  snapshotTex = null;
}

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
useViewer.subscribe((s, p) => {
  if (
    s.channel !== p.channel ||
    s.clip !== p.clip ||
    s.compareMode !== p.compareMode ||
    s.swap !== p.swap ||
    s.splitY !== p.splitY ||
    s.hold !== p.hold ||
    s.compareRef !== p.compareRef ||
    s.pinned !== p.pinned ||
    s.snapshot !== p.snapshot
  )
    requestRender();
});
useSettings.subscribe((s, p) => {
  if (s.clipLow !== p.clipLow || s.clipHigh !== p.clipHigh) requestRender();
});
useUi.subscribe((s, p) => {
  if (s.fit !== p.fit || s.zoom !== p.zoom || s.panX !== p.panX || s.panY !== p.panY || s.compare !== p.compare || s.split !== p.split || s.quality !== p.quality)
    requestRender();
});
