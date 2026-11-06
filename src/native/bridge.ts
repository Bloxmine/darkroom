/**
 * Renderer side of the desktop shell. `initNative()` is a no-op in the browser.
 *
 *  - builds the native application menu from the SAME command table / menu layout
 *    the in-app MenuBar uses (src/ui/commands.ts, src/ui/MenuBar.tsx), keeps its
 *    enabled/checked state in sync and dispatches clicks back into the commands
 *  - tells the keyboard handler which shortcuts the native menu owns (no double-firing)
 *  - mirrors theme, document name / path / edited state to the window
 *  - receives files from Finder
 */
import './native.css';
import { subscribeRegistry } from '../core/registry';
import { useDoc } from '../store/doc';
import { useSettings } from '../store/settings';
import { useUi } from '../store/ui';
import { commands, keyHooks } from '../ui/commands';
import type { MenuItem } from '../ui/Menu';
import { MENUS } from '../ui/MenuBar';
import type { EditRole, NativeMenuItem, NativeMenuState, NativeMenuTemplate } from './api';
import { handleOpenedFiles, useDocFile } from './files';
import { native } from './native';

/** Edit commands that act on the focused text field instead of the graph while typing. */
const TEXT_ROLE: Record<string, EditRole> = {
  'edit.undo': 'undo',
  'edit.redo': 'redo',
  'edit.cut': 'cut',
  'edit.copy': 'copy',
  'edit.paste': 'paste',
  'edit.selectAll': 'selectAll',
  'edit.delete': 'delete',
};
/** Commands a shortcut may still trigger while a text field has focus. */
const typingOk = (id: string) => id.startsWith('file.') || id.startsWith('help.') || id === 'edit.prefs';
/** Cmd-combos that also mean something inside text fields: the renderer keeps handling them. */
const RENDERER_KEYS = new Set(['Ctrl+Backspace', 'Ctrl+Enter']);

const isTyping = (el: Element | null) => {
  const h = el as HTMLElement | null;
  if (!h) return false;
  if (h.tagName === 'TEXTAREA' || h.isContentEditable) return true;
  if (h.tagName === 'INPUT') return !['checkbox', 'radio', 'range', 'button'].includes((h as HTMLInputElement).type);
  return false;
};

/** Primary shortcut → Electron accelerator. Only Cmd-combos become native key equivalents. */
function accelerator(keys?: string) {
  const k = keys?.split('|')[0];
  if (!k || !k.includes('Ctrl+') || RENDERER_KEYS.has(k)) return null;
  return { combo: k, accel: k.replace('Ctrl+', 'CmdOrCtrl+') };
}

// --- template -----------------------------------------------------------------

let dyn = new Map<string, () => void>();
let owned = new Set<string>(); // `${id}|${combo}` handled by the native menu

function commandEnabled(id: string) {
  const ui = useUi.getState();
  if (TEXT_ROLE[id] && isTyping(document.activeElement)) return true;
  if (ui.dialog || ui.quickAdd) return false;
  const c = commands[id];
  return !!c && (c.enabled ? c.enabled() : true);
}

function cmdItem(id: string, label?: string): NativeMenuItem | null {
  const c = commands[id];
  if (!c) return null;
  const a = accelerator(c.keys);
  if (a) owned.add(`${id}|${a.combo}`);
  const checked = c.checked?.();
  return {
    type: 'cmd',
    id,
    label: label ?? c.label,
    ...(a ? { accelerator: a.accel } : {}),
    enabled: commandEnabled(id),
    ...(checked !== undefined ? { checked, radio: id.startsWith('view.theme.') } : {}),
  };
}

function convert(items: MenuItem[]): NativeMenuItem[] {
  const out: NativeMenuItem[] = [];
  for (const it of items) {
    if ('sep' in it) {
      if (out.length && out[out.length - 1].type !== 'sep') out.push({ type: 'sep' });
    } else if ('header' in it) {
      continue;
    } else if ('cmd' in it) {
      const x = cmdItem(it.cmd, it.label);
      if (x) out.push(x);
    } else if (it.submenu) {
      out.push({ type: 'submenu', label: it.label, items: convert(it.submenu()) });
    } else if (it.run) {
      const id = `dyn:${dyn.size}`;
      dyn.set(id, it.run);
      out.push({ type: 'cmd', id, label: it.label, enabled: !it.disabled, ...(it.checked !== undefined ? { checked: it.checked } : {}) });
    }
  }
  while (out.length && out[out.length - 1].type === 'sep') out.pop();
  return out;
}

const menuItems = (title: string, drop: string[] = []) =>
  convert((MENUS.find((m) => m.title === title)?.items() ?? []).filter((i) => !('cmd' in i && drop.includes(i.cmd))));

function buildTemplate(): NativeMenuTemplate {
  dyn = new Map();
  owned = new Set();
  const sep = { type: 'sep' } as const;
  const role = (r: Extract<NativeMenuItem, { type: 'role' }>['role'], label?: string) => ({ type: 'role' as const, role: r, ...(label ? { label } : {}) });
  const fileItems = menuItems('File');
  // File: New, Open…, Open Recent ▸, ─, Close, Save, Save As…, ─, Import…, Export…
  const at = (id: string) => fileItems.findIndex((i) => i.type === 'cmd' && i.id === id);
  if (at('file.open') >= 0) fileItems.splice(at('file.open') + 1, 0, role('recentDocuments'), sep, role('close', 'Close Window'));
  return {
    menus: [
      {
        label: 'Darkroom',
        role: 'appMenu',
        items: [
          cmdItem('help.about', 'About Darkroom')!,
          sep,
          cmdItem('edit.prefs', 'Preferences…')!,
          sep,
          role('services'),
          sep,
          role('hide', 'Hide Darkroom'),
          role('hideOthers'),
          role('unhide'),
          sep,
          role('quit', 'Quit Darkroom'),
        ],
      },
      { label: 'File', items: fileItems },
      { label: 'Edit', items: menuItems('Edit', ['edit.prefs']) },
      { label: 'View', items: [...menuItems('View'), sep, role('togglefullscreen'), role('toggleDevTools', 'Developer Tools')] },
      { label: 'Node', items: menuItems('Node') },
      { label: 'Window', role: 'windowMenu', items: [role('minimize'), role('zoom'), sep, ...menuItems('Window'), sep, role('front')] },
      { label: 'Help', role: 'help', items: menuItems('Help', ['help.about']) },
    ],
  };
}

/** Pull enabled/checked out of the template (the structure signature ignores them). */
function extractState(t: NativeMenuTemplate): NativeMenuState {
  const st: NativeMenuState = {};
  const walk = (items: NativeMenuItem[]) =>
    items.forEach((i) => {
      if (i.type === 'cmd') st[i.id] = { enabled: i.enabled, ...(i.checked !== undefined ? { checked: i.checked } : {}) };
      else if (i.type === 'submenu') walk(i.items);
    });
  t.menus.forEach((m) => walk(m.items));
  return st;
}

let lastSig = '';
let lastState: NativeMenuState = {};
let timer = 0;

function syncMenu() {
  timer = 0;
  const t = buildTemplate();
  const st = extractState(t);
  const sig = JSON.stringify(t, (k, v) => (k === 'enabled' || k === 'checked' ? undefined : v));
  if (sig !== lastSig) {
    lastSig = sig;
    native!.setMenu(t, st);
  } else {
    const diff: NativeMenuState = {};
    for (const [id, s] of Object.entries(st)) {
      const o = lastState[id];
      if (!o || o.enabled !== s.enabled || o.checked !== s.checked) diff[id] = s;
    }
    if (Object.keys(diff).length) native!.updateMenuState(diff);
  }
  lastState = st;
}
const scheduleMenu = () => {
  if (!timer) timer = window.setTimeout(syncMenu, 40);
};

// --- dispatch -----------------------------------------------------------------

function dispatch(id: string, viaAccelerator: boolean) {
  const d = dyn.get(id);
  if (d) return d();
  const typing = isTyping(document.activeElement);
  // Paste always goes through the DOM paste event: text fields get text, the graph gets images / nodes (App.tsx).
  if (id === 'edit.paste') return native!.editRole('paste');
  if (TEXT_ROLE[id] && typing) return native!.editRole(TEXT_ROLE[id]);
  const ui = useUi.getState();
  if (ui.dialog || ui.quickAdd) return;
  if (viaAccelerator && typing && !typingOk(id)) return;
  const c = commands[id];
  if (!c || (c.enabled && !c.enabled())) return;
  c.run();
}

// --- init -----------------------------------------------------------------------

export function initNative(booted: Promise<unknown>) {
  if (!native) return;

  // menu
  keyHooks.nativeOwns = (id, combo) => owned.has(`${id}|${combo}`);
  native.onMenuCommand(dispatch);
  syncMenu();
  useDoc.subscribe(scheduleMenu);
  useUi.subscribe(scheduleMenu);
  useSettings.subscribe(scheduleMenu);
  subscribeRegistry(scheduleMenu);
  window.addEventListener('focusin', scheduleMenu);
  window.addEventListener('focusout', scheduleMenu);

  // theme → nativeTheme.themeSource + window background
  const theme = () => native!.setTheme(useSettings.getState().pref, useSettings.getState().theme);
  theme();
  useSettings.subscribe((s, p) => (s.pref !== p.pref || s.theme !== p.theme) && theme());

  // document → window title / represented file / edited dot
  let lastDoc = '';
  const doc = () => {
    const { project, dirty } = useDoc.getState();
    const d = { title: project.name || 'Untitled', path: useDocFile.getState().path, edited: dirty };
    const k = JSON.stringify(d);
    if (k !== lastDoc) native!.setDocument(d);
    lastDoc = k;
  };
  doc();
  useDoc.subscribe(doc);
  useDocFile.subscribe(doc);

  // Finder → app (queued in main until we're ready)
  native.onOpenFiles((files) => void handleOpenedFiles(files));
  void booted.finally(() => native!.ready());
}
