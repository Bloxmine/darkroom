/**
 * Window › Workspace and Window › panel commands, kept in the shared command table (src/ui/commands.ts)
 * so the in-app menus, keyboard shortcuts, Preferences › Keyboard and the native Mac menu
 * (src/native/bridge.ts) all pick them up. Custom workspaces add / remove their commands live.
 */
import { applyKeyOverrides, commands, type Command } from '../commands';
import { useSettings } from '../../store/settings';
import type { MenuItem } from '../Menu';
import { listPanels, subscribePanels } from './panels';
import { isPanelOpen, resetWorkspace, setWorkspace, togglePanel, useWorkspaceStore, workspaceList } from './store';
import { openWorkspaceDialog } from './dialogs';

export const WS_PREFIX = 'window.workspace.';
export const PANEL_PREFIX = 'window.panel.';
/**
 * Ctrl(⌘)+Alt(⌥)+1…7 go to the first seven workspaces. (Bridge CS3 used Ctrl+F1…F6, but on a Mac ⌘F5
 * toggles VoiceOver and other ⌘F-keys are system shortcuts, so the app would never see them.)
 */
const FKEYS = ['Ctrl+Alt+1', 'Ctrl+Alt+2', 'Ctrl+Alt+3', 'Ctrl+Alt+4', 'Ctrl+Alt+5', 'Ctrl+Alt+6', 'Ctrl+Alt+7'];

const cur = () => useWorkspaceStore.getState().current;
const isCustom = () => !workspaceList().find((w) => w.id === cur())?.builtin;

const fixed: Command[] = [
  { id: WS_PREFIX + 'new', label: 'New Workspace…', icon: 'layout_add', run: () => openWorkspaceDialog('new') },
  { id: WS_PREFIX + 'save', label: 'Save Changes to Workspace', icon: 'diskette', run: () => openWorkspaceDialog('overwrite'), enabled: isCustom },
  { id: WS_PREFIX + 'rename', label: 'Rename Workspace…', icon: 'layout_edit', run: () => openWorkspaceDialog('rename'), enabled: isCustom },
  { id: WS_PREFIX + 'delete', label: 'Delete Workspace…', icon: 'layout_delete', run: () => openWorkspaceDialog('delete'), enabled: () => workspaceList().some((w) => !w.builtin) },
  { id: WS_PREFIX + 'reset', label: 'Reset Workspace', icon: 'arrow_refresh', run: () => resetWorkspace() },
];
const FIXED_IDS = new Set(fixed.map((c) => c.id));

function sync() {
  for (const c of fixed) if (!commands[c.id]) commands[c.id] = c;
  const list = workspaceList();
  const want = new Set(list.map((w) => WS_PREFIX + w.id));
  for (const id of Object.keys(commands)) if (id.startsWith(WS_PREFIX) && !FIXED_IDS.has(id) && !want.has(id)) delete commands[id];
  list.forEach((w, i) => {
    const id = WS_PREFIX + w.id;
    const prev = commands[id];
    commands[id] = { id, label: w.name, icon: w.icon ?? 'layouts', keys: prev ? prev.keys : FKEYS[i], run: () => setWorkspace(w.id), checked: () => cur() === w.id };
  });
  const panels = listPanels();
  for (const p of panels) {
    const id = PANEL_PREFIX + p.id;
    commands[id] = { ...commands[id], id, label: p.title, icon: p.icon, run: () => togglePanel(p.id), checked: () => isPanelOpen(p.id) };
  }
  // the old fixed-layout toggles now open / close the docked panels
  if (commands['view.library']) Object.assign(commands['view.library'], { run: () => togglePanel('library'), checked: () => isPanelOpen('library') });
  if (commands['view.properties']) Object.assign(commands['view.properties'], { run: () => togglePanel('properties'), checked: () => isPanelOpen('properties') });
  applyKeyOverrides();
}

sync();
subscribePanels(sync);
useSettings.subscribe((s, p) => s.customWorkspaces !== p.customWorkspaces && sync());

/** Window › Workspace submenu (also the switcher's ▾ menu). */
export function workspaceMenuItems(): MenuItem[] {
  const list = workspaceList();
  return [
    ...list.filter((w) => w.builtin).map((w) => ({ cmd: WS_PREFIX + w.id })),
    ...(list.some((w) => !w.builtin) ? [{ sep: true } as MenuItem, ...list.filter((w) => !w.builtin).map((w) => ({ cmd: WS_PREFIX + w.id }))] : []),
    { sep: true },
    { cmd: WS_PREFIX + 'new' },
    { cmd: WS_PREFIX + 'save' },
    { cmd: WS_PREFIX + 'rename' },
    { cmd: WS_PREFIX + 'delete' },
    { sep: true },
    { cmd: WS_PREFIX + 'reset' },
  ];
}

/** Window menu: one toggle per panel, editor panels first. */
export function panelMenuItems(): MenuItem[] {
  const panels = listPanels();
  const editor = panels.filter((p) => p.group !== 'browser').map((p) => ({ cmd: PANEL_PREFIX + p.id }));
  const browser = panels.filter((p) => p.group === 'browser').map((p) => ({ cmd: PANEL_PREFIX + p.id }));
  return [...editor, ...(browser.length ? [{ sep: true } as MenuItem, ...browser] : [])];
}
