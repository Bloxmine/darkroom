/**
 * Workspace store: which workspace is active, the live (possibly rearranged) layout of every
 * workspace, the switcher bar's buttons, and the maximised stack. Saved custom workspaces live in
 * Preferences (`customWorkspaces`); the live layouts in localStorage `darkroom.workspace`.
 *
 * Public API for other modules (e.g. the file browser): setWorkspace(id), useWorkspace().
 */
import { create } from 'zustand';
import { setPref, useSettings } from '../../store/settings';
import { status } from '../../store/ui';
import * as L from './layout';
import { getPanel } from './panels';
import { allWorkspaces, BUILTIN_IDS, DEFAULT_WORKSPACE, deleteWorkspace as delWs, overwriteWorkspace, renameWorkspace as renWs, sanitizeSaved, saveWorkspace, WorkspaceError, type WorkspaceDef } from './workspaces';

const KEY = 'darkroom.workspace';

interface Persisted {
  v: 1;
  current: string;
  layouts: Record<string, unknown>;
  bar: string[];
  pinned: string[];
  recent: string[];
}

export interface WorkspaceState {
  current: string;
  /** Live layout per workspace id (absent = the workspace's definition). */
  layouts: Record<string, L.Layout>;
  /** The three switcher buttons in the toolbar. */
  bar: string[];
  /** Workspaces kept on the bar. */
  pinned: string[];
  /** Most recently used first. */
  recent: string[];
  /** Stack shown alone (double-click a tab), or null. */
  maximized: string | null;
  /** Bumped when panels move / the workspace changes (not on splitter drags): the graph re-fits. */
  arrangeTick: number;
}

function read(): Partial<Persisted> {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as Partial<Persisted>;
  } catch {
    /* unavailable / corrupt */
  }
  return {};
}

const strs = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : []);

let listKey: unknown = null;
let listCache: WorkspaceDef[] = [];
/** Built-in + saved workspaces (cached: layout objects stay identical while Preferences don't change). */
export function workspaceList(): WorkspaceDef[] {
  const c = useSettings.getState().customWorkspaces;
  if (c !== listKey) {
    listKey = c;
    listCache = allWorkspaces(sanitizeSaved(c));
  }
  return listCache;
}
const exists = (id: string) => workspaceList().some((w) => w.id === id);

function initial(): WorkspaceState {
  const p = read();
  const prefs = useSettings.getState();
  const layouts: Record<string, L.Layout> = {};
  for (const [id, raw] of Object.entries(p.layouts ?? {})) {
    const l = L.deserialize(raw);
    if (l) layouts[id] = l;
  }
  let current = prefs.rememberWorkspace && typeof p.current === 'string' ? p.current : prefs.defaultWorkspace;
  if (!exists(current)) current = exists(prefs.defaultWorkspace) ? prefs.defaultWorkspace : DEFAULT_WORKSPACE;
  const bar = strs(p.bar).filter(exists).slice(0, 3);
  for (const d of [current, 'essentials', 'browse', 'filmstrip']) if (bar.length < 3 && !bar.includes(d)) bar.push(d);
  if (!bar.includes(current)) bar[2] = current;
  return { current, layouts, bar, pinned: strs(p.pinned).filter(exists), recent: strs(p.recent).filter(exists).slice(0, 12), maximized: null, arrangeTick: 0 };
}

export const useWorkspaceStore = create<WorkspaceState>(initial);

let saveTimer = 0;
useWorkspaceStore.subscribe((s, p) => {
  if (s.current === p.current && s.layouts === p.layouts && s.bar === p.bar && s.pinned === p.pinned) return;
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    const st = useWorkspaceStore.getState();
    const out: Persisted = {
      v: 1,
      current: st.current,
      layouts: Object.fromEntries(Object.entries(st.layouts).map(([k, l]) => [k, JSON.parse(L.serialize(l))])),
      bar: st.bar,
      pinned: st.pinned,
      recent: st.recent,
    };
    try {
      localStorage.setItem(KEY, JSON.stringify(out));
    } catch {
      /* storage unavailable / full */
    }
  }, 150);
});

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

export function workspaceDef(id: string): WorkspaceDef | undefined {
  return workspaceList().find((w) => w.id === id);
}

/** The live layout of a workspace (its definition until rearranged). */
export function layoutOf(id: string, s: WorkspaceState = useWorkspaceStore.getState()): L.Layout {
  return s.layouts[id] ?? workspaceDef(id)?.layout ?? { root: null };
}

export const currentLayout = (s: WorkspaceState = useWorkspaceStore.getState()) => layoutOf(s.current, s);

/** Is the panel on screen in the current workspace (active tab of a non-minimised stack)? */
export function isPanelVisible(panelId: string, s: WorkspaceState = useWorkspaceStore.getState()) {
  const root = currentLayout(s).root;
  if (s.maximized) {
    const m = L.findNode(root, s.maximized);
    return !!m && L.visiblePanelIds(m).includes(panelId);
  }
  return L.visiblePanelIds(root).includes(panelId);
}

export const isPanelOpen = (panelId: string) => L.panelIds(currentLayout().root).includes(panelId);

/** Active workspace + all workspaces, reactive. */
export function useWorkspace(): { current: string; name: string; workspaces: WorkspaceDef[]; layout: L.Layout } {
  const current = useWorkspaceStore((s) => s.current);
  const layout = useWorkspaceStore((s) => currentLayout(s));
  useSettings((s) => s.customWorkspaces);
  const workspaces = workspaceList();
  return { current, name: workspaces.find((w) => w.id === current)?.name ?? current, workspaces, layout };
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

/** Switch workspace (instant; app state is untouched). Unknown ids are ignored. */
export function setWorkspace(id: string): void {
  const def = workspaceDef(id);
  if (!def) return;
  useWorkspaceStore.setState((s) => {
    let bar = s.bar;
    if (!bar.includes(id)) {
      // replace the least recently used, unpinned button (Bridge keeps button positions stable)
      const cand = bar.map((b, i) => [b, i] as const).filter(([b]) => !s.pinned.includes(b) && b !== s.current);
      const rank = (b: string) => {
        const r = s.recent.indexOf(b);
        return r < 0 ? 999 : r;
      };
      cand.sort((a, b) => rank(b[0]) - rank(a[0]));
      const slot = cand[0]?.[1] ?? bar.length - 1;
      bar = [...bar];
      bar[slot] = id;
    }
    return { current: id, bar, recent: [id, ...s.recent.filter((r) => r !== id)].slice(0, 12), maximized: null, arrangeTick: s.arrangeTick + 1 };
  });
  status(`Workspace: ${def.name}`);
}

/** Apply a layout change to the current workspace. `arrange` = panels moved (graph re-fits). */
export function updateLayout(fn: (root: L.LayoutNode | null) => L.LayoutNode | null, arrange = true) {
  useWorkspaceStore.setState((s) => {
    const cur = currentLayout(s);
    const root = fn(cur.root);
    if (root === cur.root) return {};
    const maximized = s.maximized && L.findNode(root, s.maximized) ? s.maximized : null;
    return { layouts: { ...s.layouts, [s.current]: { root } }, maximized, arrangeTick: arrange ? s.arrangeTick + 1 : s.arrangeTick };
  });
}

/** Back to the workspace's saved arrangement. */
export function resetWorkspace(id = useWorkspaceStore.getState().current) {
  useWorkspaceStore.setState((s) => {
    const layouts = { ...s.layouts };
    delete layouts[id];
    return { layouts, maximized: null, arrangeTick: s.arrangeTick + 1 };
  });
  status(`Reset workspace “${workspaceDef(id)?.name ?? id}”.`);
}

export function toggleMaximize(stackId: string) {
  useWorkspaceStore.setState((s) => ({ maximized: s.maximized === stackId ? null : stackId, arrangeTick: s.arrangeTick + 1 }));
}

/** Add a panel to the current layout, or close it if it is open. */
export function togglePanel(panelId: string) {
  if (isPanelOpen(panelId)) closePanel(panelId);
  else openPanel(panelId);
}

const EDGE: Record<string, 'left' | 'right' | 'top' | 'bottom'> = { library: 'left', properties: 'right', graph: 'bottom', 'browser.folders': 'left', 'browser.favorites': 'left', 'browser.filter': 'left', 'browser.filmstrip': 'bottom' };
const NEAR: Record<string, string[]> = {
  scopes: ['properties'],
  'browser.keywords': ['browser.metadata'],
  'browser.metadata': ['browser.keywords', 'browser.preview'],
  'browser.favorites': ['browser.folders'],
  'browser.folders': ['browser.favorites'],
  'browser.collections': ['browser.folders', 'browser.favorites'],
};

export function openPanel(panelId: string, near?: string) {
  useWorkspaceStore.setState({ maximized: null });
  updateLayout((root) => {
    const ids = L.panelIds(root);
    const n = near ?? NEAR[panelId]?.find((x) => ids.includes(x));
    return L.addPanel(root, panelId, n ? { near: n } : { edge: EDGE[panelId] ?? 'right' });
  });
}

export function closePanel(panelId: string) {
  updateLayout((root) => L.removePanel(root, panelId));
}

// --- saved workspaces ------------------------------------------------------

const saved = () => sanitizeSaved(useSettings.getState().customWorkspaces);

/** Save the current layout as a new workspace (same name = overwrite) and switch to it. Throws WorkspaceError. */
export function saveCurrentAs(name: string): string {
  const s = useWorkspaceStore.getState();
  const r = saveWorkspace(saved(), name, currentLayout(s));
  setPref('customWorkspaces', r.saved);
  // the arrangement moves into the new workspace: it starts from its saved layout, and the
  // workspace it was made from goes back to its own saved layout (as in Bridge)
  useWorkspaceStore.setState((st) => {
    const layouts = { ...st.layouts };
    delete layouts[r.id];
    if (st.current !== r.id) delete layouts[st.current];
    return { layouts };
  });
  setWorkspace(r.id);
  status(r.overwritten ? `Updated workspace “${name.trim()}”.` : `Saved workspace “${name.trim()}”.`);
  return r.id;
}

/** Store the current arrangement into the (custom) workspace it belongs to. */
export function overwriteCurrent() {
  const s = useWorkspaceStore.getState();
  setPref('customWorkspaces', overwriteWorkspace(saved(), s.current, currentLayout(s)));
  status(`Updated workspace “${workspaceDef(s.current)?.name}”.`);
}

export function renameWorkspace(id: string, name: string) {
  setPref('customWorkspaces', renWs(saved(), id, name));
}

export function deleteWorkspace(id: string) {
  const list = delWs(saved(), id);
  const name = workspaceDef(id)?.name ?? id;
  setPref('customWorkspaces', list);
  if (useSettings.getState().defaultWorkspace === id) setPref('defaultWorkspace', DEFAULT_WORKSPACE);
  useWorkspaceStore.setState((s) => {
    const layouts = { ...s.layouts };
    delete layouts[id];
    const bar = s.bar.map((b) => (b === id ? (BUILTIN_IDS.find((x) => !s.bar.includes(x)) ?? DEFAULT_WORKSPACE) : b));
    return { layouts, bar, pinned: s.pinned.filter((p) => p !== id), recent: s.recent.filter((r) => r !== id) };
  });
  if (useWorkspaceStore.getState().current === id) setWorkspace(DEFAULT_WORKSPACE);
  status(`Deleted workspace “${name}”.`);
}

export function togglePinned(id: string) {
  useWorkspaceStore.setState((s) => {
    if (s.pinned.includes(id)) return { pinned: s.pinned.filter((p) => p !== id) };
    const bar = s.bar.includes(id) ? s.bar : [...s.bar.slice(0, 2), id];
    return { pinned: [...s.pinned, id], bar };
  });
}

export { WorkspaceError };

/** Min size hint for a stack (largest of its panels' minWidth / minHeight). */
export function stackMin(st: L.StackNode, dir: L.Dir): number {
  return Math.max(60, ...st.tabs.map((t) => (dir === 'row' ? getPanel(t)?.minWidth : getPanel(t)?.minHeight) ?? 0));
}
