import { GROUP } from '../core/graph';
import * as A from '../store/actions';
import { currentGraph, redo, undo, useDoc } from '../store/doc';
import { importImageDialog, openProjectFile, saveProjectFile, newProject } from '../store/io';
import { openDialog, status, useUi } from '../store/ui';
import { zoomViewer } from './viewerApi';

/** Imperative hooks registered by the graph editor (fit view, quick-add at cursor…). */
export const graphApi = {
  fitView: () => {},
  openQuickAdd: () => {},
  /** Flow position under the mouse if it is over the graph, else null. */
  mouseFlowPos: (): { x: number; y: number } | null => null,
};

export interface Command {
  id: string;
  label: string;
  icon?: string;
  /** Display string, also parsed for matching, e.g. 'Ctrl+Shift+Z'. Multiple: 'Ctrl+Y|Ctrl+Shift+Z'. */
  keys?: string;
  run: () => void;
  enabled?: () => boolean;
  checked?: () => boolean;
}

const hasSel = () => useDoc.getState().selection.length > 0;
const selNodes = () => {
  const s = useDoc.getState();
  const set = new Set(s.selection);
  return currentGraph(s).nodes.filter((n) => set.has(n.id));
};

export const commands: Record<string, Command> = {};
const def = (c: Command) => (commands[c.id] = c);

// File
def({
  id: 'file.new',
  label: 'New Project',
  icon: 'page_white',
  keys: 'Ctrl+Alt+N',
  run: () => (useDoc.getState().dirty ? openDialog('confirmNew') : void newProject()),
});
def({ id: 'file.open', label: 'Open Project…', icon: 'folder', keys: 'Ctrl+O', run: () => void openProjectFile() });
def({ id: 'file.save', label: 'Save Project', icon: 'diskette', keys: 'Ctrl+S', run: saveProjectFile });
def({ id: 'file.import', label: 'Import Image…', icon: 'image_add', keys: 'Ctrl+I', run: () => void importImageDialog() });
def({ id: 'file.export', label: 'Export Image…', icon: 'picture_save', keys: 'Ctrl+E', run: () => openDialog('export') });

// Edit
def({ id: 'edit.undo', label: 'Undo', icon: 'arrow_undo', keys: 'Ctrl+Z', run: undo, enabled: () => useDoc.getState().past.length > 0 });
def({ id: 'edit.redo', label: 'Redo', icon: 'arrow_redo', keys: 'Ctrl+Shift+Z|Ctrl+Y', run: redo, enabled: () => useDoc.getState().future.length > 0 });
def({
  id: 'edit.cut',
  label: 'Cut',
  icon: 'cut',
  keys: 'Ctrl+X',
  run: () => A.copySelection() && A.deleteSelection(),
  enabled: hasSel,
});
def({ id: 'edit.copy', label: 'Copy', icon: 'page_copy', keys: 'Ctrl+C', run: () => void A.copySelection(), enabled: hasSel });
def({
  id: 'edit.paste',
  label: 'Paste',
  icon: 'page_paste',
  keys: 'Ctrl+V',
  run: () => void A.pasteClipboard(graphApi.mouseFlowPos() ?? undefined),
});
def({ id: 'edit.duplicate', label: 'Duplicate', icon: 'page_white_copy', keys: 'Ctrl+D', run: A.duplicateSelection, enabled: hasSel });
def({
  id: 'edit.delete',
  label: 'Delete',
  icon: 'cross',
  keys: 'Delete|Backspace',
  run: A.deleteSelection,
  enabled: () => hasSel() || useDoc.getState().edgeSelection.length > 0,
});
def({ id: 'edit.selectAll', label: 'Select All', icon: 'table_select_all', keys: 'Ctrl+A', run: A.selectAll });
def({ id: 'edit.group', label: 'Group Selection', icon: 'shape_group', keys: 'Ctrl+G', run: A.groupSelection, enabled: hasSel });
def({
  id: 'edit.ungroup',
  label: 'Ungroup',
  icon: 'shape_ungroup',
  keys: 'Ctrl+Shift+G',
  run: A.ungroupSelection,
  enabled: () => selNodes().some((n) => n.type === GROUP),
});
def({
  id: 'edit.enterGroup',
  label: 'Open Group',
  icon: 'door_in',
  keys: 'Ctrl+Enter',
  run: () => A.enterGroup(),
  enabled: () => selNodes()[0]?.type === GROUP,
});
def({
  id: 'edit.exitGroup',
  label: 'Close Group (Up One Level)',
  icon: 'door_out',
  keys: 'Ctrl+Backspace',
  run: () => A.exitGroup(),
  enabled: () => useDoc.getState().path.length > 0,
});

// View
def({ id: 'view.fitGraph', label: 'Frame All Nodes', icon: 'zoom_fit', keys: 'F', run: () => graphApi.fitView() });
def({ id: 'view.fitImage', label: 'Fit Image to Viewer', icon: 'arrow_inout', keys: 'Shift+F', run: () => useUi.setState({ fit: true, panX: 0, panY: 0 }) });
def({ id: 'view.actual', label: 'Actual Pixels (100%)', icon: 'zoom_actual', keys: 'Ctrl+1', run: () => useUi.setState({ fit: false, zoom: 1, panX: 0, panY: 0 }) });
def({ id: 'view.zoomIn', label: 'Zoom In', icon: 'zoom_in', keys: 'Ctrl+=', run: () => zoomViewer(1.25) });
def({ id: 'view.zoomOut', label: 'Zoom Out', icon: 'zoom_out', keys: 'Ctrl+-', run: () => zoomViewer(0.8) });
def({
  id: 'view.compare',
  label: 'Compare with Original (A/B)',
  icon: 'compare',
  keys: 'C',
  run: () => useUi.setState((s) => ({ compare: !s.compare })),
  checked: () => useUi.getState().compare,
});
def({
  id: 'view.library',
  label: 'Node Library Panel',
  icon: 'application_side_tree',
  keys: 'Ctrl+Shift+L',
  run: () => useUi.setState((s) => ({ showLibrary: !s.showLibrary })),
  checked: () => useUi.getState().showLibrary,
});
def({
  id: 'view.properties',
  label: 'Properties Panel',
  icon: 'application_side_list',
  keys: 'Ctrl+Shift+P',
  run: () => useUi.setState((s) => ({ showProperties: !s.showProperties })),
  checked: () => useUi.getState().showProperties,
});

// Node
def({ id: 'node.add', label: 'Add Node…', icon: 'add', keys: 'Tab', run: () => graphApi.openQuickAdd() });
def({ id: 'node.bypass', label: 'Toggle Bypass', icon: 'link_break', keys: 'B', run: () => A.toggleBypass(), enabled: hasSel });
def({ id: 'node.view', label: 'View Selected Node', icon: 'eye', keys: '1', run: () => A.viewNode(), enabled: hasSel });
def({
  id: 'node.viewOutput',
  label: 'View Output',
  icon: 'monitor',
  keys: '0',
  run: () => {
    useDoc.setState({ viewed: null });
    status('Viewing project output.');
  },
});

// Help
def({ id: 'help.shortcuts', label: 'Keyboard Shortcuts', icon: 'keyboard', keys: 'F1', run: () => openDialog('shortcuts') });
def({ id: 'help.about', label: 'About Darkroom…', icon: 'information', run: () => openDialog('about') });

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

export function displayKeys(keys?: string) {
  if (!keys) return '';
  const k = keys.split('|')[0];
  return isMac ? k.replace('Ctrl+', '⌘').replace('Alt+', '⌥').replace('Shift+', '⇧') : k;
}

function matches(e: KeyboardEvent, combo: string) {
  const parts = combo.split('+');
  let key = parts.pop()!;
  if (key === '' && combo.endsWith('+')) key = '+';
  const ctrl = parts.includes('Ctrl');
  const shift = parts.includes('Shift');
  const alt = parts.includes('Alt');
  if ((e.ctrlKey || e.metaKey) !== ctrl || e.altKey !== alt) return false;
  const k = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  const want = key.length === 1 ? key.toUpperCase() : key;
  // '=' / '-' style keys: ignore shift (Shift+= is '+')
  if (want === '=' && (k === '=' || k === '+')) return true;
  if (k !== want && !(e.code === 'Digit' + want)) return false;
  return e.shiftKey === shift;
}

const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || el.isContentEditable) return true;
  if (tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type;
    return !['checkbox', 'radio', 'range', 'button'].includes(type);
  }
  return false;
};

export function handleKeyDown(e: KeyboardEvent) {
  if (useUi.getState().dialog || useUi.getState().quickAdd) return;
  if (isTyping(e.target)) return;
  for (const c of Object.values(commands)) {
    if (!c.keys) continue;
    if (!c.keys.split('|').some((k) => matches(e, k))) continue;
    // Ctrl+V: let the native paste event handle it (images, text)
    if (c.id === 'edit.paste') return;
    if (c.enabled && !c.enabled()) {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    c.run();
    return;
  }
}
