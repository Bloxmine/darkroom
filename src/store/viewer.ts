/**
 * Viewer "pro" state: scopes, pixel readout + colour samplers, eyedropper, channel / clipping
 * view and the A/B compare setup (layout, swap, what the reference is). Kept apart from
 * store/ui.ts so these features stay self-contained; store/engine.ts reads it at present time.
 */
import { create } from 'zustand';
import type { CompareMode } from '../core/scopes';
import { useSettings } from './settings';

export type ScopeType = 'histogram' | 'waveform' | 'vectorscope' | 'parade' | 'all';
export type HistMode = 'rgb' | 'luma' | 'parade';
export type WaveMode = 'luma' | 'rgb';
export type Channel = 'rgb' | 'r' | 'g' | 'b' | 'a' | 'luma';
/** What the viewed image is compared against. */
export type CompareRef = 'source' | 'pinned' | 'snapshot';

export const CHANNELS: { id: Channel; label: string; keys: string }[] = [
  { id: 'rgb', label: 'RGB (composite)', keys: 'Alt+0' },
  { id: 'r', label: 'Red', keys: 'Alt+1' },
  { id: 'g', label: 'Green', keys: 'Alt+2' },
  { id: 'b', label: 'Blue', keys: 'Alt+3' },
  { id: 'a', label: 'Alpha', keys: 'Alt+4' },
  { id: 'luma', label: 'Luminance (Rec.709)', keys: 'Alt+5' },
];
export const CHANNEL_INDEX: Record<Channel, number> = { rgb: 0, r: 1, g: 2, b: 3, a: 4, luma: 5 };

/** A pixel value read from the viewer: full-res image px + straight RGBA floats. */
export interface PixelSample {
  x: number;
  y: number;
  rgba: [number, number, number, number];
  /** Which image it came from ('ref' = the compare reference). */
  side: 'main' | 'ref';
}

export interface Sampler {
  id: number;
  /** Normalised image coordinates (0..1, top-left origin). */
  u: number;
  v: number;
  value: PixelSample | null;
}

export interface ViewerState {
  scopes: boolean;
  scopeType: ScopeType;
  histMode: HistMode;
  waveMode: WaveMode;
  /** Docked beside the viewer, or floating over the window. */
  scopesDock: 'right' | 'float';
  scopesWidth: number;
  scopesFloat: { x: number; y: number; w: number; h: number };
  readout: boolean;
  hover: PixelSample | null;
  samplers: Sampler[];
  channel: Channel;
  clip: boolean;
  compareMode: CompareMode;
  swap: boolean;
  /** Split position for the top/bottom layout (fraction of the viewer height). */
  splitY: number;
  /** `\` held: show the reference full-frame. */
  hold: boolean;
  compareRef: CompareRef;
  pinned: { id: string; name: string } | null;
  /** Snapshot taken (time; the texture itself lives in store/engine.ts). */
  snapshot: { at: number; name: string } | null;
  /** Eyedropper armed: the next viewer click picks a colour for this target. */
  eyedrop: { label: string; size: number; token?: string } | null;
  presetBrowser: boolean;
}

const prefs = useSettings.getState();

export const useViewer = create<ViewerState>(() => ({
  scopes: prefs.scopesDefault,
  scopeType: prefs.scopesType,
  histMode: 'rgb',
  waveMode: 'luma',
  scopesDock: 'right',
  scopesWidth: 300,
  scopesFloat: { x: 80, y: 120, w: 340, h: 300 },
  readout: prefs.pixelReadout,
  hover: null,
  samplers: [],
  channel: 'rgb',
  clip: false,
  compareMode: prefs.compareLayout,
  swap: false,
  splitY: 0.5,
  hold: false,
  compareRef: 'source',
  pinned: null,
  snapshot: null,
  eyedrop: null,
  presetBrowser: false,
}));

// ---------------------------------------------------------------------------
// Eyedropper
// ---------------------------------------------------------------------------

let pickCb: ((rgba: [number, number, number, number]) => void) | null = null;

/** Arm the eyedropper: the next click in the viewer calls `onPick` with the (averaged) colour. */
export function startEyedropper(label: string, onPick: (rgba: [number, number, number, number]) => void, opts: { size?: number; token?: string } = {}) {
  pickCb = onPick;
  useViewer.setState({ eyedrop: { label, size: opts.size ?? useSettings.getState().eyedropperSize, token: opts.token } });
}
export function cancelEyedropper() {
  pickCb = null;
  if (useViewer.getState().eyedrop) useViewer.setState({ eyedrop: null });
}
/** Deliver a picked colour (viewer) and disarm. */
export function finishEyedropper(rgba: [number, number, number, number]) {
  const cb = pickCb;
  cancelEyedropper();
  cb?.(rgba);
}

// ---------------------------------------------------------------------------
// Samplers
// ---------------------------------------------------------------------------

export const MAX_SAMPLERS = 4;

export function addSampler(u: number, v: number): boolean {
  const s = useViewer.getState().samplers;
  if (s.length >= MAX_SAMPLERS) return false;
  // reuse the lowest free number, like Photoshop's colour samplers
  const used = new Set(s.map((x) => x.id));
  let id = 1;
  while (used.has(id)) id++;
  useViewer.setState({ samplers: [...s, { id, u, v, value: null }].sort((a, b) => a.id - b.id) });
  return true;
}
export function moveSampler(id: number, u: number, v: number) {
  useViewer.setState((s) => ({ samplers: s.samplers.map((x) => (x.id === id ? { ...x, u, v } : x)) }));
}
export function removeSampler(id: number) {
  useViewer.setState((s) => ({ samplers: s.samplers.filter((x) => x.id !== id) }));
}
export const clearSamplers = () => useViewer.setState({ samplers: [] });
