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
  // Keyboard: command id → combo ('' = no shortcut)
  keyOverrides: Record<string, string>;
  // Advanced
  showFps: boolean;
  showNodeIds: boolean;
}

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
  keyOverrides: {},
  showFps: false,
  showNodeIds: false,
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
  dragRender: ['live', 'pause'],
  exportFormat: ['image/png', 'image/jpeg', 'image/webp'],
  exportScale: [0.25, 0.5, 1, 2],
};
const RANGES: Partial<Record<keyof Prefs, [number, number]>> = {
  undoDepth: [10, 1000],
  exportQuality: [0.1, 1],
};

/** Keep only valid, known keys (unknown or malformed values fall back to the default). */
export function sanitizePrefs(x: unknown): Prefs {
  const src = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
  const out = { ...PREF_DEFAULTS } as Record<string, unknown>;
  for (const k of Object.keys(PREF_DEFAULTS) as (keyof Prefs)[]) {
    const v = src[k];
    const d = PREF_DEFAULTS[k];
    if (v === undefined) continue;
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
