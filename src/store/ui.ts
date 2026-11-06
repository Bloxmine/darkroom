import { create } from 'zustand';

export type Quality = 'draft' | 'half' | 'screen' | 'full';

export const QUALITY_LABELS: Record<Quality, string> = {
  draft: 'Draft (¼ screen)',
  half: 'Half (½ screen)',
  screen: 'Screen resolution',
  full: 'Full resolution (1:1)',
};

export type DialogId = 'export' | 'about' | 'shortcuts' | 'confirmNew' | 'prefs' | 'plugins' | null;

export interface QuickAddState {
  /** Screen (client) position of the popup. */
  x: number;
  y: number;
  /** Flow position for the new node. */
  flow: { x: number; y: number };
  /** Auto-connect from/to this handle after adding. */
  from?: { node: string; port: string; kind: 'source' | 'target'; portType?: string };
}

export interface UiState {
  // viewer
  fit: boolean;
  /** Device pixels per full-resolution image pixel. */
  zoom: number;
  /** Image centre offset from the canvas centre in device px. */
  panX: number;
  panY: number;
  compare: boolean;
  /** Split position as a fraction of the canvas width. */
  split: number;
  quality: Quality;
  // panels
  showLibrary: boolean;
  showProperties: boolean;
  libraryWidth: number;
  propertiesWidth: number;
  /** Fraction of the centre column given to the viewer. */
  viewerFrac: number;
  // dialogs/popups
  dialog: DialogId;
  quickAdd: QuickAddState | null;
  // status
  message: string;
  messageKind: 'info' | 'error';
  // render stats
  renderMs: number;
  fullWidth: number;
  fullHeight: number;
  renderScale: number;
  renderWidth: number;
  renderHeight: number;
  /** Flat id → error text (pending entries excluded). */
  errors: Record<string, string>;
  pending: string[];
  /** Fit-graph request counter. */
  fitGraphTick: number;
}

export const useUi = create<UiState>(() => ({
  fit: true,
  zoom: 1,
  panX: 0,
  panY: 0,
  compare: false,
  split: 0.5,
  quality: 'screen',
  showLibrary: true,
  showProperties: true,
  libraryWidth: 220,
  propertiesWidth: 300,
  viewerFrac: 0.56,
  dialog: null,
  quickAdd: null,
  message: 'Ready',
  messageKind: 'info',
  renderMs: 0,
  fullWidth: 0,
  fullHeight: 0,
  renderScale: 1,
  renderWidth: 0,
  renderHeight: 0,
  errors: {},
  pending: [],
  fitGraphTick: 0,
}));

let msgTimer = 0;
export function status(message: string, kind: 'info' | 'error' = 'info') {
  useUi.setState({ message, messageKind: kind });
  clearTimeout(msgTimer);
  msgTimer = window.setTimeout(() => useUi.setState({ message: 'Ready', messageKind: 'info' }), kind === 'error' ? 8000 : 4000);
}

export const openDialog = (dialog: DialogId) => useUi.setState({ dialog });
export const closeDialog = () => useUi.setState({ dialog: null });
