/**
 * Scopes: histogram (RGB / luma / parade), waveform (luma / RGB), vectorscope (75% / 100% bar
 * targets, skin-tone line) and RGB parade, from the viewed node's output.
 *
 * Data path: after a viewer render (throttled to ~10 fps, trailing), the presented texture is
 * point-decimated on the GPU to ≤ 256 px and read back asynchronously (PBO + fence, never a sync
 * readPixels, see core/readback.ts); the few-KB result is binned on the CPU (core/scopes.ts) and
 * drawn on 2D canvases with graticules. Nothing runs while the panel is hidden.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { decimate } from '../../core/readback';
import {
  clippedFractions,
  histogram,
  histogramPeak,
  KB,
  KG,
  KR,
  phosphor,
  SKIN_TONE_DEG,
  vectorscope,
  vectorTargets,
  waveform,
  type Histogram,
  type WaveChannel,
} from '../../core/scopes';
import { afterRender, engine, presented, requestRender } from '../../store/engine';
import { useSettings } from '../../store/settings';
import { useViewer, type HistMode, type ScopeType, type WaveMode } from '../../store/viewer';
import { Splitter } from '../Chrome';
import { Icon } from '../Icon';
import './viewerPro.css';

interface ScopeData {
  img: ImageData;
  hist: Histogram;
  clip: { shadows: number; highlights: number };
  /** Bumped per update (redraw key). */
  seq: number;
  ms: number;
}

const useScopeData = create<{ data: ScopeData | null; vzoom: boolean }>(() => ({ data: null, vzoom: false }));

// ---------------------------------------------------------------------------
// Update scheduling
// ---------------------------------------------------------------------------

const INTERVAL = 100; // ms → ~10 fps
let timer = 0;
let last = 0;
let busy = false;
let again = false;
let seq = 0;

async function update() {
  if (!engine || !useViewer.getState().scopes) return;
  const tex = presented.tex;
  if (!tex) return;
  if (busy) {
    again = true;
    return;
  }
  busy = true;
  last = performance.now();
  try {
    const t0 = performance.now();
    const img = await decimate(engine.gl, tex, 256);
    if (!img) return;
    const s = useSettings.getState();
    const hist = histogram(img.data);
    const clip = clippedFractions(img.data, s.clipLow, s.clipHigh);
    useScopeData.setState({ data: { img, hist, clip, seq: ++seq, ms: performance.now() - t0 } });
  } finally {
    busy = false;
    last = performance.now(); // the next one waits INTERVAL after this finished: a slow GPU gets fewer readbacks
    if (again) {
      again = false;
      schedule();
    }
  }
}

/** A pointer button is held (slider / curve / viewer drag): update at half rate so the drag stays fluid. */
let dragging = false;
window.addEventListener('pointerdown', () => (dragging = true), true);
window.addEventListener('pointerup', () => {
  dragging = false;
  schedule(); // settle on the final value
}, true);
window.addEventListener('pointercancel', () => (dragging = false), true);

function schedule() {
  if (timer || !useViewer.getState().scopes) return;
  timer = window.setTimeout(() => {
    timer = 0;
    void update();
  }, Math.max(0, (dragging ? 2 * INTERVAL : INTERVAL) - (performance.now() - last)));
}

afterRender.add(schedule);
useViewer.subscribe((s, p) => {
  if (s.scopes && !p.scopes) {
    requestRender();
    schedule();
  }
});

/** Testing hook: the latest scope data (histograms are 256-bin arrays). */
(globalThis as Record<string, unknown>).__darkroomScopes = {
  get: () => {
    const d = useScopeData.getState().data;
    return d && { width: d.img.width, height: d.img.height, r: [...d.hist.r], g: [...d.hist.g], b: [...d.hist.b], y: [...d.hist.y], count: d.hist.count, clip: d.clip, ms: d.ms, seq: d.seq };
  },
};

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

interface Colors {
  bg: string;
  grid: string;
  strong: string;
  text: string;
  trace: [number, number, number];
  skin: string;
  target: string;
  font: string;
}

function readColors(el: Element): Colors {
  const cs = getComputedStyle(el);
  const v = (k: string, d: string) => cs.getPropertyValue(k).trim() || d;
  const tr = v('--scope-trace', '#c8f0b0');
  const m = /^#?([0-9a-f]{6})$/i.exec(tr);
  const n = m ? parseInt(m[1], 16) : 0xc8f0b0;
  return {
    bg: v('--scope-bg', '#0c0c0c'),
    grid: v('--scope-grid', 'rgba(255,255,255,0.14)'),
    strong: v('--scope-grid-strong', 'rgba(255,255,255,0.4)'),
    text: v('--scope-text', '#9a9a9a'),
    trace: [(n >> 16) & 255, (n >> 8) & 255, n & 255],
    skin: v('--scope-skin', '#e0a070'),
    target: v('--scope-target', '#d6c27a'),
    font: `9px ${v('--scope-font', 'Menlo, Monaco, monospace')}`,
  };
}

type Ctx = CanvasRenderingContext2D;
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}


function hline(ctx: Ctx, x0: number, x1: number, y: number) {
  ctx.beginPath();
  ctx.moveTo(x0, Math.round(y) + 0.5);
  ctx.lineTo(x1, Math.round(y) + 0.5);
  ctx.stroke();
}
function vline(ctx: Ctx, x: number, y0: number, y1: number) {
  ctx.beginPath();
  ctx.moveTo(Math.round(x) + 0.5, y0);
  ctx.lineTo(Math.round(x) + 0.5, y1);
  ctx.stroke();
}

function histGraticule(ctx: Ctx, p: Rect, c: Colors, labels: boolean) {
  ctx.strokeStyle = c.grid;
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 3]);
  for (let i = 1; i < 4; i++) vline(ctx, p.x + (p.w * i) / 4, p.y, p.y + p.h);
  for (let i = 1; i < 4; i++) hline(ctx, p.x, p.x + p.w, p.y + (p.h * i) / 4);
  ctx.setLineDash([]);
  ctx.strokeStyle = c.strong;
  ctx.strokeRect(p.x + 0.5, p.y + 0.5, p.w - 1, p.h - 1);
  if (!labels) return;
  ctx.fillStyle = c.text;
  ctx.font = c.font;
  ctx.textBaseline = 'top';
  [0, 64, 128, 192, 255].forEach((v, i) => {
    ctx.textAlign = i === 0 ? 'left' : i === 4 ? 'right' : 'center';
    ctx.fillText(String(v), p.x + (p.w * v) / 255, p.y + p.h + 3);
  });
}

function drawHistogram(ctx: Ctx, W: number, H: number, d: ScopeData, mode: HistMode, c: Colors, dpr: number) {
  const h = d.hist;
  const area: Rect = { x: 6, y: 6, w: W - 12, h: H - 22 };
  const chans: ('r' | 'g' | 'b' | 'y')[] = mode === 'luma' ? ['y'] : ['r', 'g', 'b'];
  const panes: Rect[] =
    mode === 'parade'
      ? [0, 1, 2].map((i) => {
          const gw = (area.w - 8) / 3;
          return { x: area.x + i * (gw + 4), y: area.y, w: gw, h: area.h };
        })
      : [area];
  const peak = histogramPeak(...chans.map((k) => h[k]));
  panes.forEach((p) => histGraticule(ctx, p, c, mode !== 'parade'));
  const RGB: Record<'r' | 'g' | 'b', [number, number, number]> = { r: [255, 70, 64], g: [70, 235, 70], b: [96, 140, 255] };
  const sets: { p: Rect; chans: { bins: Uint32Array; rgb: [number, number, number] }[] }[] =
    mode === 'luma'
      ? [{ p: area, chans: [{ bins: h.y, rgb: c.trace }] }]
      : mode === 'parade'
        ? (['r', 'g', 'b'] as const).map((k, i) => ({ p: panes[i], chans: [{ bins: h[k], rgb: RGB[k] }] }))
        : [{ p: area, chans: (['r', 'g', 'b'] as const).map((k) => ({ bins: h[k], rgb: RGB[k] })) }];
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.imageSmoothingEnabled = false;
  sets.forEach(({ p, chans: cs }, i) => ctx.drawImage(histImage(p.w - 2, p.h - 2, dpr, cs, peak, 'hist' + mode + i), p.x + 1, p.y + 1, p.w - 2, p.h - 2));
  ctx.restore();
  if (mode === 'rgb') {
    // luma outline on top
    const bottom = area.y + area.h - 1;
    ctx.beginPath();
    for (let i = 0; i < 256; i++) {
      const x = area.x + 1 + ((area.w - 2) * (i + 0.5)) / 256;
      const y = bottom - (area.h - 2) * Math.min(1, h.y[i] / peak);
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.stroke();
  }
  if (mode === 'parade') {
    ctx.fillStyle = c.text;
    ctx.font = c.font;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';
    ['R', 'G', 'B'].forEach((l, i) => ctx.fillText(l, panes[i].x + panes[i].w / 2, area.y + area.h + 3));
  }
  // clipping warnings (Lightroom-style corner triangles)
  const tri = (x: number, dir: 1 | -1, on: boolean, col: string) => {
    ctx.beginPath();
    ctx.moveTo(x, area.y + 2);
    ctx.lineTo(x + dir * 9, area.y + 2);
    ctx.lineTo(x, area.y + 11);
    ctx.closePath();
    ctx.fillStyle = on ? col : 'rgba(128,128,128,0.25)';
    ctx.fill();
  };
  tri(area.x + 2, 1, d.clip.shadows > 0.001, '#3b7bff');
  tri(area.x + area.w - 2, -1, d.clip.highlights > 0.001, '#ff3b3b');
}

/**
 * Filled histogram as pixels (device resolution): one column per output pixel, channels added
 * (R+G = yellow …), a brighter top edge. Drawn with one drawImage instead of vector paths, which
 * keeps the per-update cost flat even with software rasterisation.
 */
function histImage(w: number, h: number, dpr: number, chans: { bins: Uint32Array; rgb: [number, number, number] }[], peak: number, slot: string): HTMLCanvasElement {
  const pw = Math.max(1, Math.round(w * dpr));
  const ph = Math.max(1, Math.round(h * dpr));
  const cv = scratch(slot, pw, ph);
  const id = new ImageData(pw, ph);
  const px = id.data;
  const tops = new Int32Array(pw);
  const minW = Math.max(2, Math.round(dpr * 1.5)); // isolated spikes stay visible
  for (const { bins, rgb } of chans) {
    tops.fill(ph);
    for (let i = 0; i < 256; i++) {
      const v = bins[i] / peak;
      if (!v) continue;
      const top = Math.max(0, Math.min(ph - 1, Math.round(ph * (1 - Math.min(1, v)))));
      const x0 = Math.floor((i * pw) / 256);
      const x1 = Math.min(pw, Math.max(Math.floor(((i + 1) * pw) / 256), x0 + minW));
      for (let x = x0; x < x1; x++) if (top < tops[x]) tops[x] = top;
    }
    for (let x = 0; x < pw; x++) {
      const top = tops[x];
      if (top >= ph) continue;
      for (let y = top; y < ph; y++) {
        const o = (y * pw + x) * 4;
        const k = y - top < 1.5 * dpr ? 1 : 0.58;
        px[o] = Math.min(255, px[o] + rgb[0] * k);
        px[o + 1] = Math.min(255, px[o + 1] + rgb[1] * k);
        px[o + 2] = Math.min(255, px[o + 2] + rgb[2] * k);
        px[o + 3] = 255;
      }
    }
  }
  cv.getContext('2d')!.putImageData(id, 0, 0);
  return cv;
}

function ireGraticule(ctx: Ctx, p: Rect, c: Colors, labels: boolean) {
  ctx.lineWidth = 1;
  ctx.font = c.font;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  for (let ire = 0; ire <= 100; ire += 10) {
    const y = p.y + p.h - (p.h * ire) / 100;
    const major = ire % 50 === 0;
    ctx.strokeStyle = major ? c.strong : c.grid;
    ctx.setLineDash(major ? [] : [2, 3]);
    hline(ctx, p.x, p.x + p.w, y);
    const every = p.h < 70 ? 50 : p.h < 140 ? 20 : 10;
    if (labels && ire % every === 0) {
      ctx.fillStyle = c.text;
      ctx.fillText(String(ire), p.x - 3, y);
    }
  }
  ctx.setLineDash([]);
  ctx.strokeStyle = c.grid;
  vline(ctx, p.x, p.y, p.y + p.h);
  vline(ctx, p.x + p.w, p.y, p.y + p.h);
}

/** A cols × 256 waveform as an RGBA canvas (level 255 at the top). */
function waveCanvas(d: ScopeData, chans: { ch: WaveChannel; rgb: [number, number, number] }[], slot: string): HTMLCanvasElement {
  const { img } = d;
  const cols = img.width;
  const out = new ImageData(cols, 256);
  const k = 48 / img.height;
  for (const { ch, rgb } of chans) {
    const wf = waveform(img.data, img.width, img.height, ch, cols);
    for (let lv = 0; lv < 256; lv++)
      for (let x = 0; x < cols; x++) {
        const n = wf[lv * cols + x];
        if (!n) continue;
        const a = phosphor(n, k);
        const o = ((255 - lv) * cols + x) * 4;
        out.data[o] = Math.min(255, out.data[o] + rgb[0] * a);
        out.data[o + 1] = Math.min(255, out.data[o + 1] + rgb[1] * a);
        out.data[o + 2] = Math.min(255, out.data[o + 2] + rgb[2] * a);
        out.data[o + 3] = 255;
      }
  }
  const cv = scratch('wave' + slot, cols, 256);
  cv.getContext('2d')!.putImageData(out, 0, 0);
  return cv;
}

const scratchCanvases = new Map<string, HTMLCanvasElement>();
/** Reused offscreen canvases (one per use), resized only when needed. */
function scratch(key: string, w: number, h: number): HTMLCanvasElement {
  let c = scratchCanvases.get(key);
  if (!c) scratchCanvases.set(key, (c = document.createElement('canvas')));
  if (c.width !== w) c.width = w;
  if (c.height !== h) c.height = h;
  return c;
}

function drawWaveform(ctx: Ctx, W: number, H: number, d: ScopeData, mode: WaveMode | 'parade', c: Colors) {
  const area: Rect = { x: 26, y: 7, w: W - 32, h: H - 14 };
  const R: [number, number, number] = [255, 70, 60];
  const G: [number, number, number] = [70, 240, 80];
  const B: [number, number, number] = [80, 120, 255];
  const panes: { p: Rect; chans: { ch: WaveChannel; rgb: [number, number, number] }[]; label?: string }[] =
    mode === 'parade'
      ? ([
          ['r', R, 'R'],
          ['g', G, 'G'],
          ['b', B, 'B'],
        ] as const).map(([ch, rgb, label], i) => {
          const gw = (area.w - 8) / 3;
          return { p: { x: area.x + i * (gw + 4), y: area.y, w: gw, h: area.h }, chans: [{ ch, rgb: [...rgb] as [number, number, number] }], label };
        })
      : [{ p: area, chans: mode === 'rgb' ? [{ ch: 'r', rgb: R }, { ch: 'g', rgb: G }, { ch: 'b', rgb: B }] : [{ ch: 'y', rgb: c.trace }] }];
  panes.forEach(({ p }, i) => ireGraticule(ctx, p, c, i === 0));
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.imageSmoothingEnabled = true;
  panes.forEach(({ p, chans }, i) => ctx.drawImage(waveCanvas(d, chans, mode + i), p.x + 1, p.y, p.w - 1, p.h));
  ctx.restore();
  if (mode === 'parade') {
    ctx.font = c.font;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    panes.forEach(({ p, label }, i) => {
      ctx.fillStyle = ['#ff6a5e', '#6aec74', '#7a9cff'][i];
      ctx.fillText(label!, p.x + p.w - 3, p.y + 2);
    });
  }
}

let vsTintCache: { n: number; gain: number; rgb: Uint8ClampedArray } | null = null;
/** Per-cell display colour of the vectorscope trace: the hue at that Cb/Cr, lifted toward white. */
function vsTint(n: number, gain: number) {
  if (vsTintCache && vsTintCache.n === n && vsTintCache.gain === gain) return vsTintCache.rgb;
  const rgb = new Uint8ClampedArray(n * n * 3);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const cb = ((x + 0.5) / n - 0.5) / gain;
      const cr = (0.5 - (y + 0.5) / n) / gain;
      const Y = 0.6;
      const r = Y + 2 * (1 - KR) * cr;
      const b = Y + 2 * (1 - KB) * cb;
      const g = (Y - KR * r - KB * b) / KG;
      const m = Math.max(r, g, b, 1e-3);
      const o = (y * n + x) * 3;
      rgb[o] = 255 * (0.45 + 0.55 * Math.max(0, r / m));
      rgb[o + 1] = 255 * (0.45 + 0.55 * Math.max(0, g / m));
      rgb[o + 2] = 255 * (0.45 + 0.55 * Math.max(0, b / m));
    }
  vsTintCache = { n, gain, rgb };
  return rgb;
}

function drawVectorscope(ctx: Ctx, W: number, H: number, d: ScopeData, zoom: boolean, c: Colors) {
  const S = Math.max(40, Math.min(W, H) - 14);
  const ox = (W - S) / 2;
  const oy = (H - S) / 2;
  const cx = ox + S / 2;
  const cy = oy + S / 2;
  const R = S / 2;
  const gain = zoom ? 1.8 : 0.9;
  const at = (cb: number, cr: number): [number, number] => [cx + cb * gain * S, cy - cr * gain * S];
  // graticule
  ctx.lineWidth = 1;
  ctx.strokeStyle = c.strong;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = c.grid;
  ctx.setLineDash([2, 3]);
  for (const f of [0.25, 0.5, 0.75]) {
    ctx.beginPath();
    ctx.arc(cx, cy, R * f, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  hline(ctx, cx - R, cx + R, cy);
  vline(ctx, cx, cy - R, cy + R);
  ctx.strokeStyle = c.strong;
  for (let a = 0; a < 360; a += 10) {
    const t = (a * Math.PI) / 180;
    const len = a % 30 === 0 ? 6 : 3;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(t) * R, cy - Math.sin(t) * R);
    ctx.lineTo(cx + Math.cos(t) * (R - len), cy - Math.sin(t) * (R - len));
    ctx.stroke();
  }
  // skin-tone line
  const st = (SKIN_TONE_DEG * Math.PI) / 180;
  ctx.strokeStyle = c.skin;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(st) * R, cy - Math.sin(st) * R);
  ctx.stroke();
  ctx.setLineDash([]);
  // trace
  const N = 200;
  const total = Math.max(1, d.hist.count);
  const dens = vectorscope(d.img.data, N, gain);
  const tint = vsTint(N, gain);
  const id = new ImageData(N, N);
  const k = (0.25 * N * N) / total;
  for (let i = 0; i < N * N; i++) {
    const n = dens[i];
    if (!n) continue;
    const a = phosphor(n, k);
    id.data[i * 4] = tint[i * 3] * a;
    id.data[i * 4 + 1] = tint[i * 3 + 1] * a;
    id.data[i * 4 + 2] = tint[i * 3 + 2] * a;
    id.data[i * 4 + 3] = 255;
  }
  const cv = scratch('vec', N, N);
  cv.getContext('2d')!.putImageData(id, 0, 0);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(cv, ox, oy, S, S);
  ctx.restore();
  // targets: 75% boxes (labelled) and 100% dots
  ctx.font = c.font;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  const t75 = vectorTargets(0.75);
  const t100 = vectorTargets(1);
  t75.forEach((t, i) => {
    const [x, y] = at(t.cb, t.cr);
    if (Math.hypot(x - cx, y - cy) > R + 4) return;
    ctx.strokeStyle = c.target;
    ctx.strokeRect(Math.round(x - 5) + 0.5, Math.round(y - 5) + 0.5, 10, 10);
    const [x1, y1] = at(t100[i].cb, t100[i].cr);
    if (Math.hypot(x1 - cx, y1 - cy) <= R) {
      ctx.fillStyle = c.target;
      ctx.fillRect(Math.round(x1) - 1, Math.round(y1) - 1, 3, 3);
    }
    if (S < 110) return; // too small for labels
    const dx = x - cx;
    const dy = y - cy;
    const l = Math.hypot(dx, dy) || 1;
    ctx.fillStyle = c.text;
    ctx.fillText(t.label, x + (dx / l) * 14, y + (dy / l) * 14);
  });
  if (W < 150) return;
  ctx.fillStyle = c.text;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(zoom ? 'gain ×2' : 'gain ×1', 4, 4);
  ctx.fillStyle = c.skin;
  ctx.textBaseline = 'bottom';
  ctx.fillText('— skin', 4, H - 4);
  ctx.fillStyle = c.target;
  ctx.textAlign = 'right';
  ctx.fillText('□ 75%  · 100%', W - 4, H - 4);
}

/** One scope on a canvas sized to its box (device pixels). */
function ScopeCanvas({ kind, histMode, waveMode }: { kind: Exclude<ScopeType, 'all'>; histMode: HistMode; waveMode: WaveMode }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const data = useScopeData((s) => s.data);
  const vzoom = useScopeData((s) => s.vzoom);
  const theme = useSettings((s) => s.theme);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current!.parentElement!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const cv = ref.current;
    if (!cv || !size.w || !size.h) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(size.w * dpr);
    cv.height = Math.round(size.h * dpr);
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const c = readColors(cv);
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, size.w, size.h);
    if (!data) {
      ctx.fillStyle = c.text;
      ctx.font = c.font;
      ctx.textAlign = 'center';
      ctx.fillText('waiting for a frame…', size.w / 2, size.h / 2);
      return;
    }
    if (kind === 'histogram') drawHistogram(ctx, size.w, size.h, data, histMode, c, dpr);
    else if (kind === 'waveform') drawWaveform(ctx, size.w, size.h, data, waveMode, c);
    else if (kind === 'parade') drawWaveform(ctx, size.w, size.h, data, 'parade', c);
    else drawVectorscope(ctx, size.w, size.h, data, vzoom, c);
  }, [data, size, kind, histMode, waveMode, vzoom, theme]);
  return <canvas ref={ref} className="vx-scope-canvas" data-scope={kind} />;
}

const TYPES: { id: ScopeType; label: string; title: string }[] = [
  { id: 'histogram', label: 'Hist', title: 'Histogram' },
  { id: 'waveform', label: 'Wave', title: 'Waveform (IRE)' },
  { id: 'vectorscope', label: 'Vec', title: 'Vectorscope (Rec.709 CbCr)' },
  { id: 'parade', label: 'Parade', title: 'RGB parade' },
  { id: 'all', label: 'All', title: 'All four scopes' },
];

function ScopeStats() {
  const d = useScopeData((s) => s.data);
  if (!d) return <div className="vx-scopes-foot muted">—</div>;
  const pct = (x: number) => (x * 100 < 0.05 && x > 0 ? '<0.1' : (x * 100).toFixed(1)) + '%';
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * d.hist.y[i];
  const mean = d.hist.count ? sum / d.hist.count / 255 : 0;
  return (
    <div className="vx-scopes-foot" title={`Scopes sample: ${d.img.width}×${d.img.height} px (point-decimated on the GPU), ${d.ms.toFixed(1)} ms readback + binning`}>
      <span className={d.clip.shadows > 0.001 ? 'clip-lo' : ''}>▼ {pct(d.clip.shadows)}</span>
      <span className={d.clip.highlights > 0.001 ? 'clip-hi' : ''}>▲ {pct(d.clip.highlights)}</span>
      <span>Ȳ {mean.toFixed(3)}</span>
      <span className="muted">
        {d.img.width}×{d.img.height}
      </span>
    </div>
  );
}

function ScopesBody({ onTitleDown }: { onTitleDown?: (e: React.PointerEvent) => void }) {
  const v = useViewer();
  const vzoom = useScopeData((s) => s.vzoom);
  const kinds: Exclude<ScopeType, 'all'>[] = v.scopeType === 'all' ? ['histogram', 'waveform', 'vectorscope', 'parade'] : [v.scopeType];
  return (
    <>
      <div className="vx-scopes-head" onPointerDown={onTitleDown}>
        <Icon name="layer_histogram" />
        <span className="vx-seg" role="tablist">
          {TYPES.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={v.scopeType === t.id}
              className={v.scopeType === t.id ? 'on' : ''}
              title={t.title}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => useViewer.setState({ scopeType: t.id })}
            >
              {t.label}
            </button>
          ))}
        </span>
        <span className="flex1" />
        <button className="vx-iconbtn" title={v.scopesDock === 'right' ? 'Float the scopes' : 'Dock beside the viewer'} onPointerDown={(e) => e.stopPropagation()} onClick={() => useViewer.setState({ scopesDock: v.scopesDock === 'right' ? 'float' : 'right' })}>
          <Icon name={v.scopesDock === 'right' ? 'application_double' : 'application_side_list'} />
        </button>
        <button className="vx-iconbtn" title="Close scopes (Shift+S)" onPointerDown={(e) => e.stopPropagation()} onClick={() => useViewer.setState({ scopes: false })}>
          <Icon name="cross" />
        </button>
      </div>
      {(v.scopeType === 'histogram' || v.scopeType === 'waveform' || v.scopeType === 'vectorscope' || v.scopeType === 'all') && (
        <div className="vx-scopes-sub">
          {(v.scopeType === 'histogram' || v.scopeType === 'all') && (
            <label title="Histogram mode">
              Hist
              <select className="field select" value={v.histMode} onChange={(e) => useViewer.setState({ histMode: e.target.value as HistMode })}>
                <option value="rgb">RGB overlay</option>
                <option value="luma">Luma</option>
                <option value="parade">RGB parade</option>
              </select>
            </label>
          )}
          {(v.scopeType === 'waveform' || v.scopeType === 'all') && (
            <label title="Waveform mode">
              Wave
              <select className="field select" value={v.waveMode} onChange={(e) => useViewer.setState({ waveMode: e.target.value as WaveMode })}>
                <option value="luma">Luma</option>
                <option value="rgb">RGB overlay</option>
              </select>
            </label>
          )}
          {(v.scopeType === 'vectorscope' || v.scopeType === 'all') && (
            <label className="vx-check" title="Vectorscope gain ×2 (for low-saturation images)">
              <input type="checkbox" checked={vzoom} onChange={(e) => useScopeData.setState({ vzoom: e.target.checked })} /> Vec ×2
            </label>
          )}
        </div>
      )}
      <div className={'vx-scopes-grid n' + kinds.length}>
        {kinds.map((k) => (
          <div key={k} className={'vx-scope vx-scope-' + k} title={TYPES.find((t) => t.id === k)?.title}>
            <ScopeCanvas kind={k} histMode={v.histMode} waveMode={v.waveMode} />
          </div>
        ))}
      </div>
      <ScopeStats />
    </>
  );
}

/** Docked beside the viewer canvas (inside the viewer panel). */
export function ScopesDock() {
  const on = useViewer((s) => s.scopes && s.scopesDock === 'right');
  const width = useViewer((s) => s.scopesWidth);
  const start = useRef(0);
  if (!on) return null;
  return (
    <>
      <Splitter
        dir="v"
        onStart={() => (start.current = useViewer.getState().scopesWidth)}
        onDrag={(d) => useViewer.setState({ scopesWidth: Math.max(200, Math.min(640, start.current - d)) })}
      />
      <div className="vx-scopes docked" style={{ width }} aria-label="Scopes">
        <ScopesBody />
      </div>
    </>
  );
}

/** Floating over the window; drag the header, resize from the corner. */
export function ScopesFloat() {
  const on = useViewer((s) => s.scopes && s.scopesDock === 'float');
  const f = useViewer((s) => s.scopesFloat);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      const cur = useViewer.getState().scopesFloat;
      if (Math.abs(r.width - cur.w) > 1 || Math.abs(r.height - cur.h) > 1) useViewer.setState({ scopesFloat: { ...cur, w: r.width, h: r.height } });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [on]);
  if (!on) return null;
  const onTitleDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const sx = e.clientX - f.x;
    const sy = e.clientY - f.y;
    const move = (ev: PointerEvent) =>
      useViewer.setState((s) => ({
        scopesFloat: { ...s.scopesFloat, x: Math.max(0, Math.min(window.innerWidth - 80, ev.clientX - sx)), y: Math.max(0, Math.min(window.innerHeight - 30, ev.clientY - sy)) },
      }));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return createPortal(
    <div className="vx-scopes floating window" ref={box} style={{ left: f.x, top: f.y, width: f.w, height: f.h }} aria-label="Scopes">
      <ScopesBody onTitleDown={onTitleDown} />
    </div>,
    document.body,
  );
}
