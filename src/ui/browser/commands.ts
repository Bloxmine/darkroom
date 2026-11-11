/**
 * Browser commands in the shared command table (so the in-app menus, the native Mac menu and
 * Preferences › Keyboard list them) and Bridge's Label menu. Their keys (0–5, 6–9, Space, Delete…)
 * are handled by the browser panels themselves while they have focus — they're shown in the menus
 * as hints only, so they never clash with the node editor's single-key shortcuts.
 */
import { commands, type Command } from '../commands';
import type { MenuItem } from '../Menu';
import { MENUS } from '../MenuBar';
import { LABELS } from '../../core/files/xmp';
import * as A from './actions';
import { useBrowser } from './store';
import { status } from '../../store/ui';

const files = () => A.selectedFiles();
const hasFiles = () => files().length > 0;
const one = () => useBrowser.getState().selection.length === 1;
const caps = () => A.backend().caps;

const defs: Command[] = [
  { id: 'browser.addFolder', label: 'Add Folder to Browser…', icon: 'folder_add', run: () => void A.addFolder(), enabled: () => A.backend().kind !== 'files' },
  { id: 'browser.open', label: 'Open in Darkroom', icon: 'picture_go', run: () => one() && void A.openInDarkroom(useBrowser.getState().selection[0]), enabled: one },
  { id: 'browser.openNew', label: 'Open as New Project', icon: 'page_white', run: () => one() && void A.openAsNewProject(files()[0]), enabled: () => files().length === 1 },
  { id: 'browser.review', label: 'Review Mode', icon: 'monitor', run: () => A.openLoupe(), enabled: hasFiles },
  { id: 'browser.batchRename', label: 'Batch Rename…', icon: 'document_rename', run: () => A.batchRename(files()), enabled: () => hasFiles() && caps().rename },
  { id: 'browser.reveal', label: 'Reveal in Finder', icon: 'folder_explorer', run: () => one() && A.reveal(useBrowser.getState().selection[0]), enabled: () => one() && caps().reveal },
  { id: 'browser.trash', label: 'Move to Trash', icon: 'bin', run: () => void A.trashPaths(useBrowser.getState().selection), enabled: () => useBrowser.getState().selection.length > 0 && caps().trash },
  { id: 'browser.newCollection', label: 'New Collection from Selection…', icon: 'book_add', run: () => void A.newCollection(files()), enabled: hasFiles },
  { id: 'browser.reject', label: 'Reject', icon: 'reject', run: () => A.setRating(files(), -1), enabled: hasFiles },
  ...[0, 1, 2, 3, 4, 5].map((r) => ({ id: `browser.rate${r}`, label: r ? '★'.repeat(r) : 'No Rating', run: () => A.setRating(files(), r), enabled: hasFiles })),
  { id: 'browser.label.none', label: 'No Label', run: () => A.setLabel(files(), null), enabled: hasFiles },
  ...LABELS.map((l) => ({ id: `browser.label.${l.color}`, label: l.name, icon: `tag_${l.color}`, run: () => A.setLabel(files(), l.color), enabled: hasFiles })),
];
for (const c of defs) commands[c.id] = c;

/** Display-only shortcut hints (the browser panels handle these keys). */
const HINT: Record<string, string> = { 'browser.reject': 'Alt+Delete', 'browser.open': 'Enter', 'browser.review': 'Space', 'browser.batchRename': 'Ctrl+Shift+R', 'browser.trash': 'Delete' };
for (let r = 0; r <= 5; r++) HINT[`browser.rate${r}`] = String(r);
for (const l of LABELS) if (l.key) HINT[`browser.label.${l.color}`] = l.key;

/** Only capability-dependent items are greyed out: the native menu isn't rebuilt on every selection change, so the rest run and report "nothing selected". */
const CAPS: Record<string, () => boolean> = {
  'browser.batchRename': () => caps().rename,
  'browser.reveal': () => caps().reveal,
  'browser.trash': () => caps().trash,
  'browser.addFolder': () => A.backend().kind !== 'files',
};
const item = (id: string): MenuItem => {
  const c = commands[id];
  const run = () => (c.enabled && !c.enabled() ? status('Select files in the Content panel first.', 'error') : c.run());
  return { label: c.label, icon: c.icon, keys: HINT[id], run, disabled: CAPS[id] ? !CAPS[id]() : false };
};

/** Bridge's Label menu (ratings and colour labels for the selected files). */
export const labelMenuItems = (): MenuItem[] => [
  ...[0, 1, 2, 3, 4, 5].map((r) => item(`browser.rate${r}`)),
  item('browser.reject'),
  { sep: true },
  item('browser.label.none'),
  ...LABELS.map((l) => item(`browser.label.${l.color}`)),
];

/** Browser file commands (in the Label menu, after the labels). */
const fileMenuItems = (): MenuItem[] => [
  { sep: true },
  item('browser.open'),
  item('browser.openNew'),
  item('browser.review'),
  { sep: true },
  item('browser.batchRename'),
  item('browser.newCollection'),
  item('browser.reveal'),
  item('browser.trash'),
  { sep: true },
  item('browser.addFolder'),
];

if (!MENUS.some((m) => m.title === 'Label')) {
  const at = MENUS.findIndex((m) => m.title === 'Window');
  MENUS.splice(at < 0 ? MENUS.length : at, 0, { title: 'Label', items: () => [...labelMenuItems(), ...fileMenuItems()] });
}

/** ⌘A arrives through the native menu (Edit › Select All) in the Mac app: select browser items while a browser panel has focus. */
const browserFocused = () => !!useBrowser.getState().activePanel && !!document.activeElement?.closest('[data-browser-panel]');
const selectAllCmd = commands['edit.selectAll'];
if (selectAllCmd) {
  const graphSelectAll = selectAllCmd.run;
  selectAllCmd.run = () => (browserFocused() ? A.selectAll() : graphSelectAll());
}
