/**
 * Commands for the viewer's pro tools. Registered into the shared command table (commands.ts),
 * so they appear in the menus (MenuBar › View, the native Mac menu), the shortcut list and
 * Preferences › Keyboard like every other command.
 */
import { useDoc, currentGraph } from '../../store/doc';
import { clearSnapshot, engine, fitZoomFor, imageRect, presented, takeSnapshot, viewerCanvas } from '../../store/engine';
import { useTimeline } from '../../store/timeline';
import { readRegion } from '../../core/readback';
import type { Tex } from '../../core/gl';
import { flatId } from '../../store/graphPath';
import { nodeName } from '../../store/actions';
import { status, useUi } from '../../store/ui';
import { CHANNELS, clearSamplers, useViewer, type CompareRef } from '../../store/viewer';
import type { CompareMode } from '../../core/scopes';
import { applyKeyOverrides, commands, type Command } from '../commands';
import type { MenuItem } from '../Menu';
import './spaceKey';

const def = (c: Command) => (commands[c.id] = c);
const V = () => useViewer.getState();
const setV = useViewer.setState;

/** Zoom so the image covers the whole viewer (crop the overflow). */
export function fillViewer() {
  const r = imageRect();
  if (!r.fullW || !r.fullH) return;
  const cw = viewerCanvas.width;
  const ch = viewerCanvas.height;
  const z = Math.max(cw / r.fullW, ch / r.fullH);
  useUi.setState({ fit: false, zoom: Math.max(z, fitZoomFor(r.fullW, r.fullH)), panX: 0, panY: 0 });
}

def({ id: 'view.fill', label: 'Fill Viewer', icon: 'zoom_extend', keys: 'Ctrl+Shift+F', run: fillViewer });
def({
  id: 'view.scopes',
  label: 'Scopes',
  icon: 'layer_histogram',
  keys: 'Shift+S',
  run: () => setV((s) => ({ scopes: !s.scopes })),
  checked: () => V().scopes,
});
def({
  id: 'view.readout',
  label: 'Pixel Readout',
  icon: 'color_pick',
  keys: 'Shift+I',
  run: () => setV((s) => ({ readout: !s.readout })),
  checked: () => V().readout,
});
def({ id: 'view.clearSamplers', label: 'Clear Colour Samplers', icon: 'draw_eraser', run: clearSamplers, enabled: () => V().samplers.length > 0 });
def({
  id: 'view.clip',
  label: 'Clipping Indicators',
  icon: 'contrast_high',
  keys: 'J',
  run: () => setV((s) => ({ clip: !s.clip })),
  checked: () => V().clip,
});
for (const c of CHANNELS)
  def({
    id: 'view.channel.' + c.id,
    label: c.label,
    icon: c.id === 'rgb' ? 'layer_rgb' : undefined,
    keys: c.keys,
    run: () => setV((s) => ({ channel: s.channel === c.id && c.id !== 'rgb' ? 'rgb' : c.id })),
    checked: () => V().channel === c.id,
  });
def({
  id: 'view.presetBrowser',
  label: 'Preset Browser',
  icon: 'book_picture',
  keys: 'Shift+P',
  run: () => setV((s) => ({ presetBrowser: !s.presetBrowser })),
  checked: () => V().presetBrowser,
});

// --- compare --------------------------------------------------------------------
const MODES: { id: CompareMode; label: string; icon: string }[] = [
  { id: 'h', label: 'Split Left / Right', icon: 'split_panel_vertical' },
  { id: 'v', label: 'Split Top / Bottom', icon: 'split_panel' },
  { id: 'toggle', label: 'Toggle (hold \\ for the reference)', icon: 'arrow_refresh' },
];
for (const m of MODES)
  def({
    id: 'view.compareMode.' + m.id,
    label: m.label,
    icon: m.icon,
    run: () => {
      setV({ compareMode: m.id });
      useUi.setState({ compare: true });
    },
    checked: () => V().compareMode === m.id,
  });
def({
  id: 'view.compareSwap',
  label: 'Swap Compare Sides',
  icon: 'arrow_switch',
  run: () => setV((s) => ({ swap: !s.swap })),
  checked: () => V().swap,
  enabled: () => V().compareMode !== 'toggle',
});

const REFS: { id: CompareRef; label: string }[] = [
  { id: 'source', label: 'Compare with Source Image' },
  { id: 'pinned', label: 'Compare with Pinned Node' },
  { id: 'snapshot', label: 'Compare with Snapshot' },
];
for (const r of REFS)
  def({
    id: 'view.compareRef.' + r.id,
    label: r.label,
    run: () => {
      setV({ compareRef: r.id });
      useUi.setState({ compare: true });
    },
    checked: () => V().compareRef === r.id,
    enabled: () => (r.id === 'pinned' ? !!V().pinned : r.id === 'snapshot' ? !!V().snapshot : true),
  });

/** Pin a node (current level; default: the selection) as the compare reference. */
export function pinToCompare(id?: string) {
  const s = useDoc.getState();
  const nid = id ?? s.selection[0];
  const n = nid && currentGraph(s).nodes.find((x) => x.id === nid);
  if (!n) return status('Select a node to pin for comparison.', 'error');
  setV({ pinned: { id: flatId(s.path, n.id), name: nodeName(n) }, compareRef: 'pinned' });
  useUi.setState({ compare: true });
  status(`Pinned “${nodeName(n)}” as the compare reference. Viewing another node compares it against this one.`);
}
def({ id: 'view.pinCompare', label: 'Pin Node to Compare', icon: 'tag_blue', keys: 'Shift+K', run: () => pinToCompare(), enabled: () => useDoc.getState().selection.length === 1 });
def({
  id: 'view.unpinCompare',
  label: 'Unpin Compare Node',
  icon: 'tag_blue_delete',
  run: () => setV((s) => ({ pinned: null, compareRef: s.compareRef === 'pinned' ? 'source' : s.compareRef })),
  enabled: () => !!V().pinned,
});

export function snapshotNow() {
  if (!takeSnapshot()) return status('Nothing to snapshot yet.', 'error');
  const name = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  setV({ snapshot: { at: Date.now(), name }, compareRef: 'snapshot' });
  useUi.setState({ compare: true });
  status(`Snapshot taken (${name}). Keep editing — the viewer compares against it.`);
}
def({ id: 'view.snapshot', label: 'Take Snapshot', icon: 'camera_add', keys: 'Shift+T', run: snapshotNow });
def({
  id: 'view.clearSnapshot',
  label: 'Discard Snapshot',
  icon: 'camera_delete',
  run: () => {
    clearSnapshot();
    setV((s) => ({ snapshot: null, compareRef: s.compareRef === 'snapshot' ? 'source' : s.compareRef }));
  },
  enabled: () => !!V().snapshot,
});

// user shortcut overrides (Preferences › Keyboard) also apply to the commands above
applyKeyOverrides();

/** Automation / console hook (scripts/app-snap.mjs). */
(globalThis as Record<string, unknown>).__darkroomViewer = {
  useViewer,
  useTimeline,
  presented: () => presented,
  readRegion: (t: Tex, x: number, y: number, w = 1, h = 1) => readRegion(engine.gl, t, x, y, w, h),
};

// --- hold \ : show the reference full-frame ------------------------------------------
if (typeof window !== 'undefined') {
  const typing = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.('input:not([type=checkbox]):not([type=radio]):not([type=range]),textarea,select,[contenteditable=""],[contenteditable="true"]');
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Backslash' || e.ctrlKey || e.metaKey || e.altKey || typing(e.target) || useUi.getState().dialog) return;
    e.preventDefault();
    if (!V().hold) setV({ hold: true });
  });
  const up = () => V().hold && setV({ hold: false });
  window.addEventListener('keyup', (e) => e.code === 'Backslash' && up());
  window.addEventListener('blur', up);
}

// --- menus -----------------------------------------------------------------------------
/** Viewer entries for View in the menu bar (and the native Mac menu). */
export function viewerMenuItems(): MenuItem[] {
  return [
    { cmd: 'view.fill' },
    { sep: true },
    { label: 'Compare', icon: 'compare', submenu: compareMenuItems },
    { label: 'Channel', icon: 'layer_rgb', submenu: channelMenuItems },
    { cmd: 'view.clip' },
    { sep: true },
    { cmd: 'view.scopes' },
    { cmd: 'view.readout' },
    { cmd: 'view.clearSamplers' },
    { cmd: 'view.presetBrowser' },
  ];
}
export function compareMenuItems(): MenuItem[] {
  return [
    { cmd: 'view.compare', label: 'Show Compare' },
    { sep: true },
    ...MODES.map((m) => ({ cmd: 'view.compareMode.' + m.id })),
    { cmd: 'view.compareSwap' },
    { sep: true },
    ...REFS.map((r) => ({ cmd: 'view.compareRef.' + r.id })),
    { sep: true },
    { cmd: 'view.snapshot' },
    { cmd: 'view.clearSnapshot' },
    { cmd: 'view.pinCompare' },
    { cmd: 'view.unpinCompare' },
  ];
}
export const channelMenuItems = (): MenuItem[] => CHANNELS.map((c) => ({ cmd: 'view.channel.' + c.id }));
