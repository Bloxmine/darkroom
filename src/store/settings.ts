import { create } from 'zustand';
import { loadPrefs, PREF_DEFAULTS, PREFS_VERSION, sanitizePrefs, savePrefs, type Prefs, type ThemeId, type ThemePref } from './prefs';

export * from './prefs';

/**
 * User preferences (persisted to localStorage, see ./prefs.ts for the schema,
 * defaults and migration). The UI theme is applied as `data-theme` on <html>;
 * the CSS in src/ui/themes/ keys off that attribute. index.html sets the
 * attribute from the legacy `darkroom.theme` key before first paint.
 */

export const THEMES: { id: ThemePref; label: string; description: string }[] = [
  {
    id: 'auto',
    label: 'Auto (match system)',
    description: 'Follows the system appearance: Aperture (dark) in Dark Mode, Aqua (light) in Light Mode.',
  },
  {
    id: 'classic',
    label: 'Classic',
    description: 'Grey bevelled chrome, Tahoma — the classic Windows pro-tool look.',
  },
  {
    id: 'aperture',
    label: 'Aperture (dark)',
    description: 'Graphite panels, glossy Aqua controls and HUD inspectors, after Apple Aperture 2/3.',
  },
  {
    id: 'aqua',
    label: 'Aqua (light)',
    description: 'Light Mac OS X Leopard look: unified grey toolbar and blue Aqua buttons.',
  },
];

/** Colours the CSS can't reach: React Flow props and the WebGL viewer clear colour. */
export interface ThemeMeta {
  /** Viewer clear colour, linear 0–1 RGB. */
  viewerBg: [number, number, number];
  grid: string;
  gridMajor: string;
  /** Dot colour of the 'dots' graph grid (Preferences › Appearance). */
  gridDot: string;
  minimapBg: string;
  minimapMask: string;
  minimapStroke: string;
  minimapRadius: number;
}

export const THEME_META: Record<ThemeId, ThemeMeta> = {
  classic: {
    viewerBg: [0.235, 0.235, 0.24],
    grid: '#666',
    gridMajor: '#595959',
    gridDot: '#4f4f4f',
    minimapBg: '#7a7a7a',
    minimapMask: 'rgba(40,40,40,0.55)',
    minimapStroke: '#222',
    minimapRadius: 0,
  },
  aperture: {
    viewerBg: [0.075, 0.075, 0.078],
    grid: '#2b2b2b',
    gridMajor: '#323232',
    gridDot: '#4a4a4a',
    minimapBg: '#1d1d1d',
    minimapMask: 'rgba(0,0,0,0.45)',
    minimapStroke: '#0a0a0a',
    minimapRadius: 3,
  },
  aqua: {
    viewerBg: [0.235, 0.235, 0.24],
    grid: '#a9adb3',
    gridMajor: '#9ea2a8',
    gridDot: '#80848b',
    minimapBg: '#c9ccd1',
    minimapMask: 'rgba(90,96,110,0.35)',
    minimapStroke: '#555',
    minimapRadius: 3,
  },
};

const isPref = (v: unknown): v is ThemePref => THEMES.some((t) => t.id === v);

const darkQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
/** Resolve a preference to a concrete theme ('auto' → Aperture when the system is dark, else Aqua). */
export const resolveTheme = (p: ThemePref): ThemeId => (p === 'auto' ? (darkQuery?.matches ? 'aperture' : 'aqua') : p);

/** Every preference except `theme`, which is stored as `pref` (the choice) + `theme` (resolved). */
export type SettingsState = Omit<Prefs, 'theme'> & {
  /** The user's theme choice (may be 'auto'). */
  pref: ThemePref;
  /** The theme actually applied (never 'auto'). */
  theme: ThemeId;
};

const toState = (p: Prefs): SettingsState => {
  const { theme, ...rest } = p;
  return { ...rest, pref: theme, theme: resolveTheme(theme) };
};
/** The persistable prefs of the current state. */
export const currentPrefs = (s: SettingsState = useSettings.getState()): Prefs => {
  const { pref, theme: _resolved, ...rest } = s;
  void _resolved;
  return { ...rest, theme: pref };
};

export const useSettings = create<SettingsState>(() => toState(loadPrefs()));

function applyTheme(t: ThemeId) {
  document.documentElement.dataset.theme = t;
}
function applyScale(s: number) {
  const r = document.documentElement;
  r.style.setProperty('--ui-scale', String(s));
  if (s === 1) delete r.dataset.uiScale;
  else r.dataset.uiScale = String(s);
}
applyTheme(useSettings.getState().theme);
applyScale(useSettings.getState().uiScale);

// persist + apply document-level prefs on every change
useSettings.subscribe((s, p) => {
  if (s.theme !== p.theme) applyTheme(s.theme);
  if (s.uiScale !== p.uiScale) applyScale(s.uiScale);
  savePrefs(currentPrefs(s));
});

// 'auto': follow live system appearance changes
darkQuery?.addEventListener('change', () => {
  const { pref, theme } = useSettings.getState();
  const t = resolveTheme(pref);
  if (t !== theme) useSettings.setState({ theme: t });
});

export function setTheme(p: ThemePref) {
  if (!isPref(p)) return;
  useSettings.setState({ pref: p, theme: resolveTheme(p) });
}

/** Set one preference (validated); applies live and saves immediately. */
export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]) {
  if (key === 'theme') return setTheme(value as ThemePref);
  const clean = sanitizePrefs({ ...currentPrefs(), [key]: value });
  useSettings.setState({ [key]: clean[key] } as Partial<SettingsState>);
}

/** Restore the given preferences (default: all) to their defaults. */
export function resetPrefs(keys: (keyof Prefs)[] = Object.keys(PREF_DEFAULTS) as (keyof Prefs)[]) {
  const next = { ...currentPrefs() } as Record<string, unknown>;
  for (const k of keys) next[k] = PREF_DEFAULTS[k];
  useSettings.setState(toState(sanitizePrefs(next)));
}

/** All preferences as a JSON document (Preferences › Advanced › Export). */
export function exportPrefsJson(): string {
  return JSON.stringify(
    {
      format: 'darkroom-preferences',
      version: PREFS_VERSION,
      prefs: currentPrefs(),
    },
    null,
    2,
  );
}

/** Replace preferences from an exported JSON document. Throws on malformed input. */
export function importPrefsJson(text: string) {
  const j = JSON.parse(text) as { format?: string; prefs?: unknown };
  if (!j || typeof j !== 'object' || !j.prefs || typeof j.prefs !== 'object') throw new Error('Not a Darkroom preferences file.');
  useSettings.setState(toState(sanitizePrefs({ ...currentPrefs(), ...(j.prefs as object) })));
}

/** Viewer clear colour per the Viewer › Background preference ('checker' is drawn on top by ui/prefs/runtime.ts). */
const VIEWER_BG: Partial<Record<Prefs['viewerBg'], [number, number, number]>> = {
  black: [0, 0, 0],
  grey: [0.42, 0.42, 0.42],
  white: [1, 1, 1],
};

export const themeMeta = (): ThemeMeta => {
  const s = useSettings.getState();
  const m = THEME_META[s.theme];
  const bg = VIEWER_BG[s.viewerBg];
  return bg ? { ...m, viewerBg: bg } : m;
};

export function setNodeThumbnails(on: boolean) {
  setPref('nodeThumbnails', on);
}

/** Render-scale ceiling for the viewer preview from Performance › Preview resolution cap. */
export function previewCapScale(fullW: number, fullH: number): number {
  const cap = useSettings.getState().previewCap;
  const long = Math.max(fullW, fullH);
  return cap && long > cap ? cap / long : 1;
}
