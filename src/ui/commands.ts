import { GROUP } from '../core/graph';
import * as A from '../store/actions';
import { currentGraph, redo, undo, useDoc } from '../store/doc';
import { importImageDialog, openProjectFile, saveProjectFile, saveProjectFileAs, newProject } from '../store/io';
import { setNodeThumbnails, setTheme, THEMES, useSettings } from '../store/settings';
import { openDialog, status, useUi } from '../store/ui';
import { zoomViewer } from './viewerApi';
import { openDocs } from './docs/docs';
import { canEditInBuilder, exportNodeType, importNodeFile, openNodeBuilder } from '../store/extensions';
import * as T from '../store/timeline';
import * as GE from '../store/graphEdit';
import { useGraphUi } from '../store/graphUi';
import { savePresetFromSelection } from '../store/presets';

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
  run: () => (useDoc.getState().dirty && useSettings.getState().confirmDiscard ? openDialog('confirmNew') : void newProject()),
});
def({ id: 'file.open', label: 'Open Project…', icon: 'folder', keys: 'Ctrl+O', run: () => void openProjectFile() });
def({ id: 'file.save', label: 'Save Project', icon: 'diskette', keys: 'Ctrl+S', run: saveProjectFile });
def({ id: 'file.saveAs', label: 'Save Project As…', icon: 'diskette', keys: 'Ctrl+Shift+S', run: saveProjectFileAs });
def({ id: 'file.import', label: 'Import Image…', icon: 'image_add', keys: 'Ctrl+I', run: () => void importImageDialog() });
def({ id: 'file.export', label: 'Export Image…', icon: 'picture_save', keys: 'Ctrl+E', run: () => openDialog('export') });
def({ id: 'file.exportVideo', label: 'Export Video…', icon: 'film_save', keys: 'Ctrl+Shift+E', run: () => openDialog('exportVideo'), enabled: () => !T.useTimeline.getState().exporting });
def({ id: 'file.batch', label: 'Batch Process…', icon: 'images', keys: 'Ctrl+Shift+B', run: () => openDialog('batch') });

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
  run: () => GE.requestDelete(A.deleteSelection), // asks first above Preferences › General › confirm-delete count
  enabled: () => hasSel() || useDoc.getState().edgeSelection.length > 0 || useGraphUi.getState().frameSelection.length > 0,
});
def({ id: 'edit.prefs', label: 'Preferences…', icon: 'setting_tools', keys: 'Ctrl+,', run: () => openDialog('prefs') });
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
def({
  id: 'view.thumbnails',
  label: 'Node Thumbnails',
  icon: 'pictures',
  run: () => setNodeThumbnails(!useSettings.getState().nodeThumbnails),
  checked: () => useSettings.getState().nodeThumbnails,
});

// View › Theme (radio group)
for (const t of THEMES)
  def({
    id: 'view.theme.' + t.id,
    label: t.label,
    run: () => {
      setTheme(t.id);
      status(`Theme: ${t.label}`);
    },
    checked: () => useSettings.getState().pref === t.id,
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

// Node › Arrange / Frames (node-graph editor, see store/graphEdit.ts)
const sel2 = () => useDoc.getState().selection.length > 1;
def({ id: 'graph.tidy', label: 'Tidy Up Graph', icon: 'chart_organisation', keys: 'Shift+L', run: GE.tidyUp, enabled: () => currentGraph().nodes.length > 1 });
def({ id: 'graph.alignLeft', label: 'Align Left', icon: 'shape_align_left', run: () => GE.alignSelection('left'), enabled: sel2 });
def({ id: 'graph.alignTop', label: 'Align Top', icon: 'shape_align_top', run: () => GE.alignSelection('top'), enabled: sel2 });
def({ id: 'graph.distributeH', label: 'Distribute Horizontally', icon: 'shape_align_center', run: () => GE.distributeSelection('x'), enabled: () => useDoc.getState().selection.length > 2 });
def({ id: 'graph.distributeV', label: 'Distribute Vertically', icon: 'shape_align_middle', run: () => GE.distributeSelection('y'), enabled: () => useDoc.getState().selection.length > 2 });
def({ id: 'graph.frame', label: 'Frame Selection', icon: 'shape_square_add', keys: 'Ctrl+J', run: () => void GE.addFrame(graphApi.mouseFlowPos() ?? undefined) });
def({ id: 'graph.note', label: 'Add Sticky Note', icon: 'note_add', keys: 'Shift+N', run: () => void GE.addFrame(graphApi.mouseFlowPos() ?? undefined, 'note') });
def({ id: 'graph.selectUp', label: 'Select Upstream', icon: 'arrow_left', keys: 'Shift+ArrowLeft', run: () => GE.selectConnected('up'), enabled: hasSel });
def({ id: 'graph.selectDown', label: 'Select Downstream', icon: 'arrow_right', keys: 'Shift+ArrowRight', run: () => GE.selectConnected('down'), enabled: hasSel });
def({ id: 'node.collapse', label: 'Collapse / Expand Node', icon: 'bullet_arrow_up', keys: 'H', run: () => GE.setCollapsed(undefined), enabled: hasSel });
def({ id: 'node.rename', label: 'Rename Node…', icon: 'textfield_rename', keys: 'F2', run: () => useGraphUi.setState({ renaming: useDoc.getState().selection[0] ?? null }), enabled: hasSel });
def({ id: 'node.savePreset', label: 'Save as Preset…', icon: 'star', run: savePresetFromSelection, enabled: hasSel });
def({
  id: 'view.minimap',
  label: 'Minimap',
  icon: 'map',
  keys: 'Shift+M',
  run: () => useSettings.setState((s) => ({ minimap: !s.minimap })),
  checked: () => useSettings.getState().minimap,
});

// Node › custom nodes, Edit › Plugins (phase 5)
const selType = () => selNodes()[0]?.type ?? '';
def({ id: 'node.newCustom', label: 'New Custom Node…', icon: 'script_add', run: () => openNodeBuilder() });
def({ id: 'node.editType', label: 'Edit Node Type…', icon: 'script_edit', run: () => openNodeBuilder(selType()), enabled: () => canEditInBuilder(selType()) });
def({ id: 'node.importType', label: 'Import Node Type…', icon: 'script_import', run: () => void importNodeFile() });
def({ id: 'node.exportType', label: 'Export Node Type…', icon: 'script_export', run: () => exportNodeType(selType()), enabled: () => canEditInBuilder(selType()) });
def({ id: 'edit.plugins', label: 'Plugins…', icon: 'plugin', run: () => openDialog('plugins') });

// Playback (store/timeline.ts). Space is handled in Transport.tsx (only while the project is in motion).
const motion = () => T.inMotion() && !T.useTimeline.getState().exporting;
def({
  id: 'playback.toggle',
  label: 'Play / Pause',
  icon: 'control_play_blue',
  keys: 'Space',
  run: T.togglePlay,
  checked: () => T.useTimeline.getState().playing,
  enabled: () => !T.useTimeline.getState().exporting,
});
def({ id: 'playback.prevFrame', label: 'Previous Frame', icon: 'control_rewind_blue', keys: 'ArrowLeft', run: () => T.stepFrame(-1), enabled: motion });
def({ id: 'playback.nextFrame', label: 'Next Frame', icon: 'control_fastforward_blue', keys: 'ArrowRight', run: () => T.stepFrame(1), enabled: motion });
def({ id: 'playback.start', label: 'Go to Start', icon: 'control_start_blue', run: T.goToStart, enabled: motion });
def({
  id: 'playback.loop',
  label: 'Loop Playback',
  icon: 'control_repeat_blue',
  run: () => T.setTimeline({ loop: !T.useTimeline.getState().loop }),
  checked: () => T.useTimeline.getState().loop,
});
def({
  id: 'playback.realtime',
  label: 'Realtime Playback (drop frames)',
  icon: 'clock_play',
  run: () => T.setTimeline({ realtime: !T.useTimeline.getState().realtime }),
  checked: () => T.useTimeline.getState().realtime,
});
def({
  id: 'playback.animate',
  label: 'Animate (play time on stills: moving grain & noise)',
  icon: 'film',
  run: () => {
    const on = !T.useTimeline.getState().animate;
    T.setTimeline({ animate: on });
    if (on) T.play();
    status(on ? 'Animate on: noise and grain move over time. Space plays/pauses.' : 'Animate off.');
  },
  checked: () => T.useTimeline.getState().animate,
});

// Help
def({ id: 'help.docs', label: 'Darkroom Help', icon: 'book_open', run: () => openDocs() });
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
  if (k !== want && !(e.code === 'Digit' + want) && !(e.code === 'Key' + want)) return false; // Key*: ⌥-letters on macOS
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

/** Set by the desktop app (src/native/bridge.ts): shortcuts its native menu owns, so they don't fire twice. */
export const keyHooks = { nativeOwns: (_id: string, _combo: string) => false };

export function handleKeyDown(e: KeyboardEvent) {
  if (useUi.getState().dialog || useUi.getState().quickAdd) return;
  if (isTyping(e.target)) return;
  for (const c of Object.values(commands)) {
    if (!c.keys) continue;
    const combo = c.keys.split('|').find((k) => matches(e, k));
    if (!combo) continue;
    if (keyHooks.nativeOwns(c.id, combo)) return; // the native menu item's accelerator runs it
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

// ---------------------------------------------------------------------------
// User shortcut overrides (Preferences › Keyboard). `keys` is rewritten in place so
// handleKeyDown, the in-app menus and the native menu (src/native/bridge.ts) all agree.
// ---------------------------------------------------------------------------

/** The built-in shortcut of every command (before overrides). */
export const defaultKeys: Record<string, string | undefined> = {};
export function applyKeyOverrides(o: Record<string, string> = useSettings.getState().keyOverrides) {
  for (const c of Object.values(commands)) {
    if (!(c.id in defaultKeys)) defaultKeys[c.id] = c.keys;
    c.keys = c.id in o ? o[c.id] || undefined : defaultKeys[c.id];
  }
}
applyKeyOverrides();
useSettings.subscribe((s, p) => s.keyOverrides !== p.keyOverrides && applyKeyOverrides(s.keyOverrides));
