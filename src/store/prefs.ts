/**
 * Preferences schema: every user setting, its default, validation and the
 * versioned localStorage format. The live store is `useSettings` in
 * ./settings.ts (which re-exports everything here); this module has no
 * runtime dependencies so any store can import it without cycles.
 *
 * Storage: `darkroom.prefs` = { version: 1, prefs: {...} }. The legacy keys
 * `darkroom.theme` (also read by index.html before first paint, so it is kept
 * in sync) and `darkroom.nodeThumbnails` are migrated on first load.
 */

export type ThemeId = 'classic' | 'aperture' | 'aqua';
/** What the user picked: a concrete theme, or 'auto' = Aperture in dark mode, Aqua in light mode. */
export type ThemePref = ThemeId | 'auto';

export type LaunchAction = 'restore' | 'starter' | 'empty';
export type WireStyle = 'default' | 'straight' | 'step' | 'smoothstep';
export type GridStyle = 'lines' | 'dots' | 'none';
export type ViewerBg = 'theme' | 'black' | 'grey' | 'white' | 'checker';
export type DragRender = 'live' | 'pause';
export type DefaultQuality = 'draft' | 'half' | 'screen';
export type ExportFormat = 'image/png' | 'image/jpeg' | 'image/webp';
/** Local Stable Diffusion server for the sd.generate node (see docs/CONTROLNET.md). */
export type GenServer = 'off' | 'comfyui' | 'a1111' | 'coreml';
export type CoreMLUnitsPref = 'cpuAndNeuralEngine' | 'cpuAndGPU' | 'all';

export interface Prefs {
  // General
  launchAction: LaunchAction;
  /** Autosave debounce in ms; 0 = off. */
  autosaveMs: number;
  undoDepth: number;
  confirmDiscard: boolean;
  defaultProjectName: string;
  // Appearance
  theme: ThemePref;
  uiScale: number;
  nodeThumbnails: boolean;
  minimap: boolean;
  wireStyle: WireStyle;
  grid: GridStyle;
  nodeTooltips: boolean;
  // Viewer
  defaultQuality: DefaultQuality;
  viewerBg: ViewerBg;
  pixelZoom: boolean;
  compareDefault: boolean;
  fitOnChange: boolean;
  // Viewer › pro tools (scopes, readout, eyedropper, compare, clipping, preset browser)
  scopesDefault: boolean;
  scopesType: 'histogram' | 'waveform' | 'vectorscope' | 'parade' | 'all';
  pixelReadout: boolean;
  eyedropperSize: number;
  compareLayout: 'h' | 'v' | 'toggle';
  /** Clipping indicator thresholds in 8-bit levels: ≤ clipLow → blue, ≥ clipHigh → red. */
  clipLow: number;
  clipHigh: number;
  presetThumbSize: number;
  // Performance
  /** Long-edge cap of the viewer preview in px; 0 = none. */
  previewCap: number;
  poolSize: number;
  dragRender: DragRender;
  // Export
  exportFormat: ExportFormat;
  exportQuality: number;
  filenamePattern: string;
  includeSourceName: boolean;
  exportScale: number;
  // Plugins & AI
  allowCodePlugins: boolean;
  aiPreferWebGPU: boolean;
  /** Re-run AI nodes at the zoomed-in preview resolution (off: they stay at fit-to-window resolution until export). */
  aiFollowZoom: boolean;
  /** Ask before downloading an AI model larger than this many MB for the first time (0 = never ask). */
  aiConfirmMB: number;
  // Generation (sd.generate → the user's own ComfyUI / AUTOMATIC1111 server; off by default, see docs/CONTROLNET.md)
  genServer: GenServer;
  genUrlComfy: string;
  genUrlA1111: string;
  /** Built-in Core ML engine (Mac app): compute units, and lazy loading to save memory. */
  coremlUnits: CoreMLUnitsPref;
  coremlReduceMemory: boolean;
  // Keyboard: command id → combo ('' = no shortcut)
  keyOverrides: Record<string, string>;
  // Advanced
  showFps: boolean;
  /** Log every render, AI job and helper message in Window › Diagnostics. */
  verboseDiagnostics: boolean;
  /** Pop up a notification when a node or the app reports an error. */
  errorToasts: boolean;
  showNodeIds: boolean;
  // Node graph editor (Appearance / General)
  snapToGrid: boolean;
  gridSize: number;
  /** Adding a node while one is selected places it to the right and wires it up. */
  autoConnect: boolean;
  minimapPos: MinimapPos;
  /** Ask before deleting more than this many nodes at once; 0 = never ask. */
  confirmDeleteOver: number;
  /** Include the node id in node tooltips. */
  nodeIdTooltips: boolean;
  /** Dropping a node on a wire splices it in (hold Alt to suppress). */
  insertOnWire: boolean;
  /** Add-node search: recently added and starred entries ('n:<type>' / 'p:<preset id>'). */
  addRecent: string[];
  addFavorites: string[];
  // Workspaces (src/ui/workspace): the one opened at launch, and the user's saved layouts
  defaultWorkspace: string;
  /** Reopen the workspace that was active when the app was last closed (else `defaultWorkspace`). */
  rememberWorkspace: boolean;
  customWorkspaces: { id: string; name: string; layout: unknown }[];
  // Node Library panel views
  libraryView: LibraryView;
  /** Tile size of the Icons view in px. */
  libraryIconSize: number;
  /** Live preview thumbnails of each node in the Icons view (off: category icons). */
  libraryPreviews: boolean;
  librarySort: LibrarySort;
}

export type LibraryView = 'list' | 'icons' | 'details' | 'compact';
export type LibrarySort = 'name' | 'category' | 'recent';

export type MinimapPos = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';

export const PREF_DEFAULTS: Prefs = {
  launchAction: 'restore',
  autosaveMs: 800,
  undoDepth: 200,
  confirmDiscard: true,
  defaultProjectName: 'Untitled',
  theme: 'auto',
  uiScale: 1,
  nodeThumbnails: true,
  minimap: true,
  wireStyle: 'default',
  grid: 'lines',
  nodeTooltips: true,
  defaultQuality: 'screen',
  viewerBg: 'theme',
  pixelZoom: true,
  compareDefault: false,
  fitOnChange: true,
  scopesDefault: false,
  scopesType: 'histogram',
  pixelReadout: true,
  eyedropperSize: 3,
  compareLayout: 'h',
  clipLow: 2,
  clipHigh: 253,
  presetThumbSize: 200,
  previewCap: 0,
  poolSize: 24,
  dragRender: 'live',
  exportFormat: 'image/png',
  exportQuality: 0.92,
  filenamePattern: '{project}',
  includeSourceName: false,
  exportScale: 1,
  allowCodePlugins: true,
  aiPreferWebGPU: true,
  aiFollowZoom: false,
  aiConfirmMB: 50,
  genServer: 'off',
  genUrlComfy: 'http://127.0.0.1:8188',
  genUrlA1111: 'http://127.0.0.1:7860',
  coremlUnits: 'cpuAndNeuralEngine',
  coremlReduceMemory: false,
  keyOverrides: {},
  showFps: false,
  verboseDiagnostics: false,
  errorToasts: true,
  showNodeIds: false,
  snapToGrid: true,
  gridSize: 10,
  autoConnect: true,
  minimapPos: 'bottom-right',
  confirmDeleteOver: 10,
  nodeIdTooltips: false,
  insertOnWire: true,
  addRecent: [],
  addFavorites: [],
  defaultWorkspace: 'essentials',
  rememberWorkspace: true,
  customWorkspaces: [],
  libraryView: 'list',
  libraryIconSize: 72,
  libraryPreviews: false,
  librarySort: 'category',
};

/** Allowed values for enumerated prefs (validation of imported / stored JSON). */
const ENUMS: Partial<Record<keyof Prefs, readonly unknown[]>> = {
  launchAction: ['restore', 'starter', 'empty'],
  autosaveMs: [0, 800, 10000, 30000, 60000],
  theme: ['auto', 'classic', 'aperture', 'aqua'],
  uiScale: [0.9, 1, 1.1, 1.25],
  wireStyle: ['default', 'straight', 'step', 'smoothstep'],
  grid: ['lines', 'dots', 'none'],
  defaultQuality: ['draft', 'half', 'screen'],
  viewerBg: ['theme', 'black', 'grey', 'white', 'checker'],
  previewCap: [0, 1024, 2048, 4096],
  poolSize: [8, 24, 48, 96],
  aiConfirmMB: [0, 25, 50, 100, 250],
  dragRender: ['live', 'pause'],
  exportFormat: ['image/png', 'image/jpeg', 'image/webp'],
  exportScale: [0.25, 0.5, 1, 2],
  gridSize: [5, 10, 20, 25, 50],
  minimapPos: ['bottom-right', 'bottom-left', 'top-right', 'top-left'],
  confirmDeleteOver: [0, 3, 5, 10, 20, 50],
  genServer: ['off', 'comfyui', 'a1111', 'coreml'],
  coremlUnits: ['cpuAndNeuralEngine', 'cpuAndGPU', 'all'],
  scopesType: ['histogram', 'waveform', 'vectorscope', 'parade', 'all'],
  eyedropperSize: [1, 3, 5],
  compareLayout: ['h', 'v', 'toggle'],
  presetThumbSize: [140, 200, 260],
  libraryView: ['list', 'icons', 'details', 'compact'],
  librarySort: ['name', 'category', 'recent'],
};
const RANGES: Partial<Record<keyof Prefs, [number, number]>> = {
  undoDepth: [10, 1000],
  exportQuality: [0.1, 1],
  clipLow: [0, 64],
  clipHigh: [192, 255],
  libraryIconSize: [40, 160],
};

/** Keep only valid, known keys (unknown or malformed values fall back to the default). */
export function sanitizePrefs(x: unknown): Prefs {
  const src = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
  const out = { ...PREF_DEFAULTS } as Record<string, unknown>;
  for (const k of Object.keys(PREF_DEFAULTS) as (keyof Prefs)[]) {
    const v = src[k];
    const d = PREF_DEFAULTS[k];
    if (v === undefined) continue;
    if (k === 'customWorkspaces') {
      // shape only; layouts are validated by src/ui/workspace/workspaces.ts (sanitizeSaved)
      if (Array.isArray(v))
        out[k] = v
          .filter((w): w is { id: string; name: string; layout: unknown } => !!w && typeof w === 'object' && typeof w.id === 'string' && typeof w.name === 'string' && !!w.layout && typeof w.layout === 'object')
          .slice(0, 50)
          .map((w) => ({ id: w.id.slice(0, 40), name: w.name.slice(0, 60), layout: w.layout }));
      continue;
    }
    const en = ENUMS[k];
    if (en) {
      if (en.includes(v)) out[k] = v;
      continue;
    }
    if (typeof d === 'number' && typeof v === 'number' && Number.isFinite(v)) {
      const r = RANGES[k];
      out[k] = r ? Math.min(r[1], Math.max(r[0], k === 'undoDepth' ? Math.round(v) : v)) : v;
    } else if (typeof d === 'boolean' && typeof v === 'boolean') out[k] = v;
    else if (typeof d === 'string' && typeof v === 'string') out[k] = v.slice(0, 200);
    else if (Array.isArray(d) && Array.isArray(v)) out[k] = [...new Set(v.filter((s): s is string => typeof s === 'string'))].slice(0, 100);
    else if (k === 'keyOverrides' && v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, s]) => typeof s === 'string')) as Record<string, string>;
    }
  }
  return out as unknown as Prefs;
}

export const PREFS_KEY = 'darkroom.prefs';
export const PREFS_VERSION = 1;
export const LEGACY_THEME_KEY = 'darkroom.theme';
export const LEGACY_THUMBS_KEY = 'darkroom.nodeThumbnails';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // storage unavailable
  }
}

/** Load stored prefs (migrating the pre-v1 keys). */
export function loadPrefs(): Prefs {
  const raw = read(PREFS_KEY);
  if (raw) {
    try {
      const j = JSON.parse(raw) as { version?: number; prefs?: unknown };
      // future versions: migrate j.prefs by j.version here
      return sanitizePrefs(j?.prefs);
    } catch {
      /* corrupt: fall through to legacy keys / defaults */
    }
  }
  const legacy: Partial<Prefs> = {};
  const t = read(LEGACY_THEME_KEY);
  if (t) legacy.theme = t as ThemePref;
  const th = read(LEGACY_THUMBS_KEY);
  if (th !== null) legacy.nodeThumbnails = th === '1';
  return sanitizePrefs(legacy);
}

export function savePrefs(p: Prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ version: PREFS_VERSION, prefs: p }));
    localStorage.setItem(LEGACY_THEME_KEY, p.theme); // index.html applies it before first paint
    localStorage.setItem(LEGACY_THUMBS_KEY, p.nodeThumbnails ? '1' : '0');
  } catch {
    /* storage unavailable / full */
  }
}
