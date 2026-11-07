/**
 * Pixel reads for the readout chip, colour samplers and eyedropper: map a viewer position to
 * the presented texture (the viewed node, or the compare reference on its side of the split)
 * and read 1 px / an n×n block back asynchronously (core/readback.ts). Hover reads are
 * throttled; after every render the hover point and the samplers are refreshed (throttled too),
 * so the values stay live while you drag a slider.
 */
import { readRegion } from '../../core/readback';
import { averageRgba, canvasToImagePx, imageToTexel, sampleBlock, splitSide } from '../../core/scopes';
import { afterRender, engine, imageRect, presented, viewerCanvas } from '../../store/engine';
import { useUi } from '../../store/ui';
import { useViewer, type PixelSample } from '../../store/viewer';

/** Which image is under a viewer point (CSS px relative to the viewer). */
export function sideAt(cssX: number, cssY: number): 'main' | 'ref' {
  const ui = useUi.getState();
  const v = useViewer.getState();
  if (!presented.ref || (!ui.compare && !v.hold)) return 'main';
  const dpr = window.devicePixelRatio || 1;
  return splitSide(cssX, cssY, v.compareMode, v.compareMode === 'v' ? v.splitY : ui.split, viewerCanvas.width / dpr, viewerCanvas.height / dpr, v.swap, v.hold);
}

/** Viewer point (CSS px relative to the viewer) → full-res image px, or null outside the image. */
export function imagePxAt(cssX: number, cssY: number) {
  const dpr = window.devicePixelRatio || 1;
  return canvasToImagePx(cssX * dpr, cssY * dpr, imageRect());
}

/** Average colour of an n×n block around full-res image px (ix, iy) of the presented image. */
export async function samplePixel(ix: number, iy: number, side: 'main' | 'ref' = 'main', size = 1): Promise<PixelSample | null> {
  if (!engine) return null;
  const p = presented;
  const tex = side === 'ref' && p.ref ? p.ref : p.tex;
  if (!tex || !p.fullW || !p.fullH) return null;
  const t = imageToTexel(ix, iy, p.fullW, p.fullH, tex.width, tex.height);
  const [x0, y0, w, h] = sampleBlock(t.x, t.y, size, tex.width, tex.height);
  const data = await readRegion(engine.gl, tex, x0, y0, w, h);
  if (!data) return null;
  return { x: ix, y: iy, rgba: averageRgba(data), side };
}

// ---------------------------------------------------------------------------
// Hover + samplers (live)
// ---------------------------------------------------------------------------

let hoverPt: { x: number; y: number } | null = null;
let hoverBusy = false;
let hoverAgain = false;
let lastHover = 0;
let hoverTimer = 0;

async function readHover() {
  if (!hoverPt) return;
  if (hoverBusy) {
    hoverAgain = true;
    return;
  }
  hoverBusy = true;
  lastHover = performance.now();
  try {
    const { x, y } = hoverPt;
    const px = imagePxAt(x, y);
    const v = px ? await samplePixel(px.x, px.y, sideAt(x, y)) : null;
    if (hoverPt) useViewer.setState({ hover: v });
  } finally {
    hoverBusy = false;
    if (hoverAgain) {
      hoverAgain = false;
      scheduleHover();
    }
  }
}

function scheduleHover() {
  if (hoverTimer) return;
  const wait = Math.max(0, 33 - (performance.now() - lastHover));
  hoverTimer = window.setTimeout(() => {
    hoverTimer = 0;
    void readHover();
  }, wait);
}

/** Pointer moved over the viewer (CSS px relative to it); null = left the viewer. */
export function setHover(pt: { x: number; y: number } | null) {
  hoverPt = pt;
  if (!pt) {
    if (useViewer.getState().hover) useViewer.setState({ hover: null });
    return;
  }
  if (!useViewer.getState().readout && !useViewer.getState().eyedrop) return;
  scheduleHover();
}

let samplersBusy = false;
let samplersAgain = false;
async function readSamplers() {
  const ss = useViewer.getState().samplers;
  if (!ss.length || !presented.fullW) return;
  if (samplersBusy) {
    samplersAgain = true;
    return;
  }
  samplersBusy = true;
  try {
    const W = presented.fullW;
    const H = presented.fullH;
    const vals = await Promise.all(ss.map((s) => samplePixel(Math.min(W - 1, Math.floor(s.u * W)), Math.min(H - 1, Math.floor(s.v * H)), 'main')));
    const byId = new Map(ss.map((s, i) => [s.id, vals[i]]));
    useViewer.setState((st) => ({ samplers: st.samplers.map((s) => (byId.has(s.id) ? { ...s, value: byId.get(s.id) ?? s.value } : s)) }));
  } finally {
    samplersBusy = false;
    if (samplersAgain) {
      samplersAgain = false;
      refresh();
    }
  }
}

let refreshTimer = 0;
let lastRefresh = 0;
function refresh() {
  if (refreshTimer) return;
  const wait = Math.max(0, 100 - (performance.now() - lastRefresh));
  refreshTimer = window.setTimeout(() => {
    refreshTimer = 0;
    lastRefresh = performance.now();
    const v = useViewer.getState();
    if (hoverPt && (v.readout || v.eyedrop)) void readHover();
    void readSamplers();
  }, wait);
}

afterRender.add(refresh);
useViewer.subscribe((s, p) => {
  if (s.samplers.length !== p.samplers.length || s.samplers.some((x, i) => x.u !== p.samplers[i]?.u || x.v !== p.samplers[i]?.v)) refresh();
});
