import { create } from 'zustand';

/**
 * User preferences (persisted to localStorage). The UI theme is applied as
 * `data-theme` on <html>; the CSS in src/ui/themes/ keys off that attribute.
 * index.html sets the attribute from the same storage key before first paint.
 */
export type ThemeId = 'classic' | 'aperture' | 'aqua';

export const THEMES: { id: ThemeId; label: string; description: string }[] = [
  { id: 'classic', label: 'Classic', description: 'Grey bevelled chrome, Tahoma — the classic Windows pro-tool look.' },
  { id: 'aperture', label: 'Aperture (dark)', description: 'Graphite panels, glossy Aqua controls and HUD inspectors, after Apple Aperture 2/3.' },
  { id: 'aqua', label: 'Aqua (light)', description: 'Light Mac OS X Leopard look: unified grey toolbar and blue Aqua buttons.' },
];

/** Colours the CSS can't reach: React Flow props and the WebGL viewer clear colour. */
export interface ThemeMeta {
  /** Viewer clear colour, linear 0–1 RGB. */
  viewerBg: [number, number, number];
  grid: string;
  gridMajor: string;
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
    minimapBg: '#7a7a7a',
    minimapMask: 'rgba(40,40,40,0.55)',
    minimapStroke: '#222',
    minimapRadius: 0,
  },
  aperture: {
    viewerBg: [0.075, 0.075, 0.078],
    grid: '#2b2b2b',
    gridMajor: '#323232',
    minimapBg: '#1d1d1d',
    minimapMask: 'rgba(0,0,0,0.45)',
    minimapStroke: '#0a0a0a',
    minimapRadius: 3,
  },
  aqua: {
    viewerBg: [0.235, 0.235, 0.24],
    grid: '#a9adb3',
    gridMajor: '#9ea2a8',
    minimapBg: '#c9ccd1',
    minimapMask: 'rgba(90,96,110,0.35)',
    minimapStroke: '#555',
    minimapRadius: 3,
  },
};

const KEY = 'darkroom.theme';
const isTheme = (v: unknown): v is ThemeId => THEMES.some((t) => t.id === v);

function loadTheme(): ThemeId {
  try {
    const v = localStorage.getItem(KEY);
    if (isTheme(v)) return v;
  } catch {
    /* storage unavailable */
  }
  return 'classic';
}

export interface SettingsState {
  theme: ThemeId;
}

export const useSettings = create<SettingsState>(() => ({ theme: loadTheme() }));

function applyTheme(t: ThemeId) {
  document.documentElement.dataset.theme = t;
}
applyTheme(useSettings.getState().theme);

export function setTheme(t: ThemeId) {
  if (!isTheme(t)) return;
  applyTheme(t);
  useSettings.setState({ theme: t });
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* storage unavailable */
  }
}

export const themeMeta = () => THEME_META[useSettings.getState().theme];
