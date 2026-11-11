/**
 * File browser actions: navigation, selection, metadata (ratings / labels / keywords → XMP
 * sidecars), file operations, collections, and opening files in the editor.
 * Errors are logged as `[darkroom files] …` (Window › Diagnostics) and shown in the status bar.
 */
import type { FsBackend } from '../../core/files/backend';
import { basename, dirname, joinPath } from '../../core/files/backend';
import { electronBackend } from '../../core/files/electron';
import { summarizeRawMeta } from '../../core/files/exif';
import type { Filters } from '../../core/files/facets';
import { isBrowsable, kindOf } from '../../core/files/kinds';
import { stemOf } from '../../core/files/sidecar';
import { forgetThumbs, setThumbConcurrency } from '../../core/files/thumbs';
import type { FileMetaResult, FsEntry } from '../../core/files/types';
import { filesBackend, hasFsAccess, webBackend } from '../../core/files/web';
import { labelName, mergeXmp, parseXmp, type LabelColor, type XmpData, labelColor } from '../../core/files/xmp';
import { native } from '../../native/native';
import { openBatch } from '../../store/batch';
import { useDoc } from '../../store/doc';
import { importImageFiles, loadProject, starterProject, validateProject } from '../../store/io';
import { importAndWire } from '../../store/launch';
import { status } from '../../store/ui';
import { setWorkspace } from '../workspace/store';
import { fsRef, useBrowser, visibleItems, type BrowserState, type ItemMeta, type KeywordNode, type SmartCollection } from './store';

const S = () => useBrowser.getState();
const set = (p: Partial<BrowserState> | ((s: BrowserState) => Partial<BrowserState>)) => useBrowser.setState(p);
const fail = (what: string, e: unknown) => {
  const msg = (e as Error)?.message ?? String(e);
  console.error(`[darkroom files] ${what}: ${msg}`);
  status(`${what}: ${msg}`, 'error');
};
const uid = () => Math.random().toString(36).slice(2, 10);

export function backend(): FsBackend {
  if (!fsRef.current) {
    fsRef.current = native?.files ? electronBackend(native.files) : hasFsAccess() ? webBackend() : filesBackend();
    setThumbConcurrency(fsRef.current.kind === 'electron' ? 6 : 4);
  }
  return fsRef.current;
}

let inited = false;
/** Load the roots and reopen the last folder. Called once when the first browser panel mounts. */
export async function initBrowser() {
  if (inited) return;
  inited = true;
  await refreshRoots();
  const last = S().lastFolder;
  if (!last || S().source) return;
  const root = S().roots.find((r) => last === r.path || last.startsWith(r.path.endsWith('/') ? r.path : r.path + '/'));
  if (root && !root.needsPermission) await openFolder(last, { quiet: true });
}

export async function refreshRoots() {
  try {
    set({ roots: await backend().roots() });
  } catch (e) {
    fail('Could not list locations', e);
  }
}

export async function addFolder() {
  try {
    const r = await backend().addRoot();
    if (!r) return;
    await refreshRoots();
    if (!S().favorites.includes(r.path)) set((s) => ({ favorites: [...s.favorites, r.path] }));
    await openFolder(r.path);
  } catch (e) {
    fail('Could not add the folder', e);
  }
}

export async function removeRoot(path: string) {
  try {
    await backend().removeRoot(path);
    set((s) => ({ favorites: s.favorites.filter((f) => f !== path) }));
    await refreshRoots();
  } catch (e) {
    fail('Could not remove the location', e);
  }
}

/** Web: re-request access to a remembered folder (from a click). */
export async function grantAccess(path: string) {
  const ok = await backend().requestPermission?.(path);
  await refreshRoots();
  if (ok) await openFolder(path);
  else status('Access to the folder was not granted.', 'error');
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

let gen = 0;
let unwatch: (() => void) | null = null;

export async function listFolders(dir: string): Promise<FsEntry[]> {
  try {
    const list = (await backend().list(dir, { hidden: S().showHidden })).filter((e) => e.dir).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    set((s) => ({ tree: { ...s.tree, [dir]: list } }));
    return list;
  } catch (e) {
    set((s) => ({ tree: { ...s.tree, [dir]: [] } }));
    console.error(`[darkroom files] could not list ${dir}: ${(e as Error).message}`);
    return [];
  }
}

/**
 * Show a folder in the Content panel. `changed` (from the folder watcher) refreshes in place: the
 * selection and filter stay, and metadata is only re-read for new / modified files and files whose
 * sidecar changed — not for the whole folder (our own sidecar writes trigger the watcher too).
 */
export async function openFolder(path: string, opts: { history?: boolean; quiet?: boolean; keepSelection?: boolean; filters?: Filters; smart?: string; changed?: string[] } = {}) {
  const g = ++gen;
  const fs = backend();
  set({ loading: true, error: null, ...(opts.keepSelection ? {} : { selection: [], anchor: null, focus: null }) });
  let all: FsEntry[];
  try {
    all = await fs.list(path, { hidden: S().showHidden });
  } catch (e) {
    if (g !== gen) return;
    set({ loading: false, error: (e as Error).message });
    if (!opts.quiet) fail(`Could not open ${basename(path)}`, e);
    return;
  }
  if (g !== gen) return;
  const entries = all.filter((e) => e.dir || isBrowsable(e.name));
  const prevEntries = new Map(S().entries.map((e) => [e.path, e]));
  set((s) => {
    const hist = opts.history === false ? s.history : [...s.history.slice(0, s.historyIndex + 1), path].slice(-50);
    const recent = [path, ...s.recent.filter((r) => r !== path)].slice(0, 12);
    const sel = opts.keepSelection ? s.selection.filter((p) => entries.some((e) => e.path === p)) : [];
    return {
      source: opts.smart ? { type: 'smart', id: opts.smart } : { type: 'folder', path },
      entries,
      names: all.map((e) => e.name),
      loading: false,
      filters: opts.changed ? s.filters : (opts.filters ?? (opts.keepSelection ? s.filters : {})),
      selection: sel,
      focus: opts.keepSelection ? s.focus : null,
      history: hist,
      historyIndex: opts.history === false ? s.historyIndex : hist.length - 1,
      recent,
      lastFolder: path,
      tree: { ...s.tree, [path]: entries.filter((e) => e.dir) },
    };
  });
  unwatch?.();
  unwatch = fs.caps.watch
    ? fs.watch(path, (names) => {
        if (names.length && names.every((n) => n.startsWith('.'))) return; // atomic-write temp files
        void openFolder(path, { history: false, keepSelection: true, quiet: true, changed: names, smart: opts.smart, filters: opts.filters });
      })
    : null;
  let files = entries.filter((e) => !e.dir);
  if (opts.changed) {
    const stems = new Set(opts.changed.filter((n) => /\.xmp$/i.test(n)).map((n) => n.replace(/(\.[^.]+)?\.xmp$/i, '').toLowerCase()));
    const meta = S().meta;
    files = files.filter((e) => {
      const p = prevEntries.get(e.path);
      return !p || p.mtime !== e.mtime || p.size !== e.size || !meta[e.path] || stems.has(stemOf(e.name).toLowerCase());
    });
  }
  void loadMeta(
    files.map((e) => e.path),
    g,
  );
}

export async function refresh() {
  const src = S().source;
  if (src?.type === 'folder' || src?.type === 'smart') await openFolder(S().lastFolder ?? '', { history: false, keepSelection: true, quiet: true });
  else if (src?.type === 'collection') await openCollection(src.id);
}

export const canBack = () => S().historyIndex > 0;
export const canForward = () => S().historyIndex < S().history.length - 1;
export function goBack() {
  if (!canBack()) return;
  const i = S().historyIndex - 1;
  set({ historyIndex: i });
  void openFolder(S().history[i], { history: false });
}
export function goForward() {
  if (!canForward()) return;
  const i = S().historyIndex + 1;
  set({ historyIndex: i });
  void openFolder(S().history[i], { history: false });
}
/** The folder above the current one, unless that would leave the granted root. */
export function parentFolder(): string | null {
  const src = S().source;
  if (src?.type !== 'folder') return null;
  const p = src.path;
  if (S().roots.some((r) => r.path === p)) return null;
  const up = dirname(p);
  return S().roots.some((r) => up === r.path || up.startsWith(r.path + '/')) ? up : null;
}
export function goUp() {
  const up = parentFolder();
  if (up) void openFolder(up);
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

export function metaFrom(r: FileMetaResult): ItemMeta {
  const iptc = r.exif?.iptc;
  const base: XmpData = iptc ? { title: iptc.title, description: iptc.description, keywords: iptc.keywords, creator: iptc.creator, copyright: iptc.copyright } : {};
  const embedded = mergeXmp(base, r.exif?.xmp ? parseXmp(r.exif.xmp) : null);
  return { exif: r.exif, xmp: mergeXmp(embedded, r.sidecar ? parseXmp(r.sidecar) : null), sidecarPath: r.sidecarPath, ...(r.error ? { error: r.error } : {}) };
}

/** Read EXIF + sidecars in the background (chunks; dropped when another folder opens). */
async function loadMeta(paths: string[], g: number) {
  const CH = fsRef.current?.kind === 'electron' ? 48 : 12;
  set({ metaPending: paths.length });
  for (let i = 0; i < paths.length; i += CH) {
    if (g !== gen) return;
    const chunk = paths.slice(i, i + CH);
    let res: FileMetaResult[];
    try {
      res = await backend().meta(chunk);
    } catch (e) {
      console.error(`[darkroom files] metadata failed: ${(e as Error).message}`);
      res = chunk.map((p) => ({ path: p, exif: null, sidecarPath: '', sidecar: null, error: (e as Error).message }));
    }
    if (g !== gen) return;
    set((s) => {
      const meta = { ...s.meta };
      for (const r of res) meta[r.path] = metaFrom(r);
      return { meta, metaPending: Math.max(0, paths.length - i - chunk.length) };
    });
  }
}

async function reloadMeta(paths: string[]) {
  try {
    const res = await backend().meta(paths);
    set((s) => {
      const meta = { ...s.meta };
      for (const r of res) meta[r.path] = metaFrom(r);
      return { meta };
    });
  } catch (e) {
    console.error(`[darkroom files] metadata failed: ${(e as Error).message}`);
  }
}

/** RAW formats exifr can't read (CR3, RAF, some ORF/RW2): fall back to LibRaw's metadata (on demand: decodes the header). */
const rawTried = new Set<string>();
export async function ensureRawMeta(path: string) {
  const m = S().meta[path];
  if (kindOf(path) !== 'raw' || rawTried.has(path) || (m?.exif?.model && m.exif.iso)) return;
  rawTried.add(path);
  try {
    const { readRawMeta } = await import('../../core/raw/decoder');
    const bytes = await backend().read(path);
    const rm = summarizeRawMeta(await readRawMeta(bytes));
    set((s) => {
      const cur = s.meta[path] ?? { exif: null, xmp: {}, sidecarPath: '' };
      return { meta: { ...s.meta, [path]: { ...cur, exif: { ...rm, ...(cur.exif ?? {}), ...Object.fromEntries(Object.entries(rm).filter(([k]) => !cur.exif?.[k as keyof typeof rm])) } } } };
    });
  } catch (e) {
    console.warn(`[darkroom files] RAW metadata unavailable for ${basename(path)}: ${(e as Error).message}`);
  }
}

/** Write XMP fields for many files (optimistic; reverted on failure). */
export async function updateXmp(paths: string[], patch: (cur: XmpData) => XmpData, what = 'Metadata') {
  const files = paths.filter((p) => !S().entries.find((e) => e.path === p)?.dir);
  if (!files.length) return;
  const before = new Map(files.map((p) => [p, S().meta[p]]));
  const next = new Map(files.map((p) => [p, patch(before.get(p)?.xmp ?? {})]));
  set((s) => {
    const meta = { ...s.meta };
    for (const p of files) meta[p] = { ...(meta[p] ?? { exif: null, sidecarPath: '' }), xmp: next.get(p)! };
    return { meta };
  });
  const fs = backend();
  let failed = 0;
  let last = '';
  const queue = [...files];
  const worker = async () => {
    for (let p = queue.shift(); p; p = queue.shift()) {
      try {
        const where = await fs.writeXmp(p, next.get(p)!);
        set((s) => ({ meta: { ...s.meta, [p]: { ...s.meta[p], sidecarPath: where.replace(/^idb:/, '') } } }));
      } catch (e) {
        failed++;
        last = (e as Error).message;
        const b = before.get(p);
        set((s) => {
          const meta = { ...s.meta };
          if (b) meta[p] = b;
          else delete meta[p];
          return { meta };
        });
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  if (failed) fail(`${what} not saved for ${failed} file${failed > 1 ? 's' : ''}`, new Error(last));
}

export function setRating(paths: string[], rating: number) {
  if (!paths.length) return;
  void updateXmp(paths, (x) => ({ ...x, rating }), 'Rating');
  status(rating < 0 ? `Rejected ${paths.length} item(s)` : rating ? `Rated ${paths.length} item(s) ${'★'.repeat(rating)}` : `Removed the rating of ${paths.length} item(s)`);
}

/** Set a label; applying the label all items already have removes it (Bridge's toggle). */
export function setLabel(paths: string[], color: LabelColor | null) {
  if (!paths.length) return;
  const all = color && paths.every((p) => labelColor(S().meta[p]?.xmp.label) === color);
  const label = !color || all ? undefined : labelName(color);
  void updateXmp(paths, (x) => ({ ...x, label }), 'Label');
  status(label ? `Label “${label}” on ${paths.length} item(s)` : `Removed the label of ${paths.length} item(s)`);
}

/** Does a file's keyword list contain `kw` (a "Parent|Child" path; a flat keyword with the same leaf name counts)? */
export const hasKeyword = (list: string[] | undefined, kw: string) => {
  const leaf = kw.split('|').pop();
  return !!list?.some((k) => k === kw || (!k.includes('|') && k === leaf));
};

export function setKeyword(paths: string[], kw: string, on: boolean) {
  void updateXmp(
    paths,
    (x) => {
      const cur = x.keywords ?? [];
      const keywords = on ? (hasKeyword(cur, kw) ? cur : [...cur, kw]) : cur.filter((k) => !hasKeyword([k], kw));
      return { ...x, keywords };
    },
    'Keywords',
  );
  status(`${on ? 'Applied' : 'Removed'} keyword “${kw.split('|').pop()}” ${on ? 'to' : 'from'} ${paths.length} item(s)`);
}

export function setFields(paths: string[], fields: Partial<XmpData>) {
  void updateXmp(paths, (x) => ({ ...x, ...fields }), 'Metadata');
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export function select(path: string, mode: 'single' | 'toggle' | 'range' = 'single') {
  const s = S();
  if (mode === 'toggle') {
    const has = s.selection.includes(path);
    set({ selection: has ? s.selection.filter((p) => p !== path) : [...s.selection, path], anchor: path, focus: path });
    return;
  }
  if (mode === 'range' && s.anchor) {
    const items = visibleItems(s).map((e) => e.path);
    const a = items.indexOf(s.anchor);
    const b = items.indexOf(path);
    if (a >= 0 && b >= 0) {
      set({ selection: items.slice(Math.min(a, b), Math.max(a, b) + 1), focus: path });
      return;
    }
  }
  set({ selection: [path], anchor: path, focus: path });
}

export const selectAll = () => set({ selection: visibleItems().map((e) => e.path) });
export const selectNone = () => set({ selection: [], anchor: null });

/** Arrow-key navigation over the visible items. */
export function moveFocus(delta: number, extend = false) {
  const items = visibleItems();
  if (!items.length) return;
  const s = S();
  const cur = s.focus ? items.findIndex((e) => e.path === s.focus) : -1;
  const i = Math.max(0, Math.min(items.length - 1, cur < 0 ? 0 : cur + delta));
  const p = items[i].path;
  if (extend) select(p, 'range');
  else set({ selection: [p], anchor: p, focus: p });
}

/** The files the commands act on: the selection (files only). */
export const selectedFiles = () => {
  const s = S();
  const dirs = new Set(s.entries.filter((e) => e.dir).map((e) => e.path));
  return s.selection.filter((p) => !dirs.has(p));
};
export const entryOf = (p: string) => S().entries.find((e) => e.path === p);

// ---------------------------------------------------------------------------
// Dialog helpers
// ---------------------------------------------------------------------------

export const askConfirm = (title: string, message: string, ok = 'OK', icon?: string) =>
  new Promise<boolean>((resolve) => set({ dialog: { type: 'confirm', title, message, ok, icon, resolve: (v) => (set({ dialog: null }), resolve(v)) } }));

export const askText = (title: string, label: string, value = '', ok = 'OK') =>
  new Promise<string | null>((resolve) => set({ dialog: { type: 'prompt', title, label, value, ok, resolve: (v) => (set({ dialog: null }), resolve(v)) } }));

// ---------------------------------------------------------------------------
// File operations
// ---------------------------------------------------------------------------

const capsWhy = () => backend().caps.why ?? 'Not available here.';

export async function trashPaths(paths: string[]) {
  const fs = backend();
  if (!paths.length) return;
  if (!fs.caps.trash) return status(capsWhy(), 'error');
  const names = paths.map(basename);
  const ok = await askConfirm(
    'Move to Trash',
    paths.length === 1 ? `Move “${names[0]}” to the Trash?` : `Move ${paths.length} items to the Trash?\n\n${names.slice(0, 8).join('\n')}${names.length > 8 ? '\n…' : ''}`,
    'Move to Trash',
    'bin',
  );
  if (!ok) return;
  try {
    const res = await fs.trash(paths);
    const bad = res.filter((r) => !r.ok);
    const done = new Set(res.filter((r) => r.ok).map((r) => r.from));
    set((s) => ({ entries: s.entries.filter((e) => !done.has(e.path)), selection: s.selection.filter((p) => !done.has(p)) }));
    if (bad.length) fail(`${bad.length} item(s) not moved to the Trash`, new Error(bad[0].error));
    else status(`Moved ${done.size} item(s) to the Trash.`);
  } catch (e) {
    fail('Move to Trash failed', e);
  }
}

/** Apply renames (from the Rename / Batch Rename dialogs). Returns the number renamed. */
export async function applyRenames(pairs: { from: string; to: string }[]): Promise<number> {
  const fs = backend();
  if (!fs.caps.rename) {
    status(capsWhy(), 'error');
    return 0;
  }
  try {
    const res = await fs.rename(pairs);
    const ok = res.filter((r) => r.ok && r.from !== r.to);
    const bad = res.filter((r) => !r.ok);
    for (const r of ok) forgetThumbs(r.from);
    const moved = new Map(ok.map((r) => [r.from, r.to]));
    set((s) => ({
      selection: s.selection.map((p) => moved.get(p) ?? p),
      focus: s.focus ? (moved.get(s.focus) ?? s.focus) : null,
      collections: s.collections.map((c) => ({ ...c, paths: c.paths.map((p) => moved.get(p) ?? p) })),
    }));
    await refresh();
    if (bad.length) fail(`${bad.length} file(s) not renamed`, new Error(bad[0].error));
    else status(`Renamed ${ok.length} file(s).`);
    return ok.length;
  } catch (e) {
    fail('Rename failed', e);
    return 0;
  }
}

export async function renameOne(path: string) {
  const name = await askText('Rename', 'New name:', basename(path), 'Rename');
  if (!name || name === basename(path)) return;
  await applyRenames([{ from: path, to: name }]);
}

export function batchRename(paths: string[]) {
  if (!backend().caps.rename) return status(capsWhy(), 'error');
  if (paths.length) set({ dialog: { type: 'batchRename', paths } });
}

export async function transferTo(paths: string[], dest: string, mode: 'move' | 'copy') {
  const fs = backend();
  if (!(mode === 'copy' ? fs.caps.copy : fs.caps.move)) return status(capsWhy(), 'error');
  try {
    const res = await fs.transfer(paths, dest, mode);
    const bad = res.filter((r) => !r.ok);
    const n = res.length - bad.length;
    if (n) status(`${mode === 'copy' ? 'Copied' : 'Moved'} ${n} item(s) to ${basename(dest)}.`);
    if (bad.length) fail(`${bad.length} item(s) not ${mode === 'copy' ? 'copied' : 'moved'}`, new Error(bad[0].error));
    if (mode === 'move') await refresh();
    set((s) => ({ tree: { ...s.tree, [dest]: undefined } }));
  } catch (e) {
    fail(mode === 'copy' ? 'Copy failed' : 'Move failed', e);
  }
}

export async function newFolder() {
  const src = S().source;
  if (src?.type !== 'folder') return;
  const fs = backend();
  if (!fs.caps.mkdir) return status(capsWhy(), 'error');
  const name = await askText('New Folder', 'Folder name:', 'untitled folder', 'Create');
  if (!name) return;
  try {
    await fs.mkdir(src.path, name);
    await refresh();
    void listFolders(src.path);
  } catch (e) {
    fail('Could not create the folder', e);
  }
}

export function reveal(path: string) {
  const fs = backend();
  if (!fs.caps.reveal) return status(capsWhy(), 'error');
  fs.reveal(path);
}

export async function openWithDefault(path: string) {
  try {
    await backend().openDefault(path);
  } catch (e) {
    fail('Could not open with the default app', e);
  }
}

export async function copyPaths(paths: string[]) {
  const text = paths.map((p) => backend().displayPath(p)).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    status(paths.length === 1 ? `Copied ${text}` : `Copied ${paths.length} paths.`);
  } catch (e) {
    fail('Could not copy the path', e);
  }
}

// ---------------------------------------------------------------------------
// Opening in Darkroom
// ---------------------------------------------------------------------------

async function confirmDiscard(): Promise<boolean> {
  if (!useDoc.getState().dirty) return true;
  return askConfirm('Unsaved Changes', 'The current project has unsaved changes (they are kept in the autosave until you replace the project). Open anyway?', 'Open', 'error');
}

/** Open a folder item, or a file in the editor: replaces the graph's source image (RAW → RAW node, video → Video node); a project opens. */
export async function openInDarkroom(path: string) {
  const e = entryOf(path);
  if (e?.dir) return openFolder(path);
  const kind = kindOf(path);
  if (kind === 'other') return status(`Can’t open ${basename(path)} in Darkroom.`, 'error');
  try {
    status(`Opening ${basename(path)}…`);
    const file = await backend().file(path);
    if (kind === 'project') {
      if (!(await confirmDiscard())) return;
      const text = await file.text();
      if (native) {
        const { openProjectText } = await import('../../native/files');
        await openProjectText({ path, name: basename(path).replace(/\.darkroom$/i, ''), text });
      } else {
        const p = validateProject(JSON.parse(text));
        if (!p.name || p.name === 'Untitled') p.name = basename(path).replace(/\.darkroom$/i, '');
        await loadProject(p);
        status(`Opened ${basename(path)}`);
      }
    } else {
      const id = await importAndWire(file);
      if (!id) return;
    }
    setWorkspace('essentials');
  } catch (err) {
    fail(`Could not open ${basename(path)}`, err);
  }
}

/** A fresh starter project (Image → preset → Output) with this file as its source. */
export async function openAsNewProject(path: string) {
  const kind = kindOf(path);
  if (kind === 'project') return openInDarkroom(path);
  if (!(await confirmDiscard())) return;
  try {
    const file = await backend().file(path);
    const p = await starterProject();
    p.name = basename(path).replace(/\.[^.]+$/, '');
    await loadProject(p, { dirty: true });
    if (native) (await import('../../native/files')).setDocPath(null);
    await importAndWire(file);
    setWorkspace('essentials');
    status(`New project from ${basename(path)}`);
  } catch (e) {
    fail(`Could not open ${basename(path)}`, e);
  }
}

/** Add files as new Image / RAW / Video nodes (at a graph position, e.g. a drop). */
export async function addToGraph(paths: string[], at?: { x: number; y: number }) {
  const files = paths.filter((p) => kindOf(p) !== 'other' && kindOf(p) !== 'project');
  if (!files.length) return status('Nothing to add: choose images, RAW files or videos.', 'error');
  try {
    const list = await Promise.all(files.map((p) => backend().file(p)));
    await importImageFiles(list, at);
  } catch (e) {
    fail('Could not add to the graph', e);
  }
}

export async function batchProcess(paths: string[]) {
  const files = paths.filter((p) => kindOf(p) === 'image' || kindOf(p) === 'raw');
  if (!files.length) return status('Batch Process needs images or RAW files.', 'error');
  try {
    status(`Reading ${files.length} file(s)…`);
    openBatch(await Promise.all(files.map((p) => backend().file(p))));
  } catch (e) {
    fail('Could not start the batch', e);
  }
}

// ---------------------------------------------------------------------------
// Favorites, collections, keywords
// ---------------------------------------------------------------------------

export const addFavorite = (p: string) => set((s) => ({ favorites: s.favorites.includes(p) ? s.favorites : [...s.favorites, p] }));
export const removeFavorite = (p: string) => set((s) => ({ favorites: s.favorites.filter((f) => f !== p) }));

export async function newCollection(paths: string[] = []) {
  const name = await askText('New Collection', 'Collection name:', 'Collection', 'Create');
  if (!name) return null;
  const c = { id: 'c' + uid(), name, paths: [...new Set(paths)] };
  set((s) => ({ collections: [...s.collections, c] }));
  status(`Collection “${name}” created${paths.length ? ` with ${paths.length} item(s)` : ''}.`);
  return c.id;
}
export function addToCollection(id: string, paths: string[]) {
  set((s) => ({ collections: s.collections.map((c) => (c.id === id ? { ...c, paths: [...new Set([...c.paths, ...paths])] } : c)) }));
  status(`Added ${paths.length} item(s) to “${S().collections.find((c) => c.id === id)?.name}”.`);
}
export function removeFromCollection(id: string, paths: string[]) {
  set((s) => ({ collections: s.collections.map((c) => (c.id === id ? { ...c, paths: c.paths.filter((p) => !paths.includes(p)) } : c)) }));
  if (S().source?.type === 'collection') void openCollection(id);
}
export async function renameCollection(id: string, smart = false) {
  const cur = smart ? S().smart.find((c) => c.id === id) : S().collections.find((c) => c.id === id);
  const name = await askText('Rename Collection', 'Name:', cur?.name ?? '', 'Rename');
  if (!name) return;
  if (smart) set((s) => ({ smart: s.smart.map((c) => (c.id === id ? { ...c, name } : c)) }));
  else set((s) => ({ collections: s.collections.map((c) => (c.id === id ? { ...c, name } : c)) }));
}
export async function deleteCollection(id: string, smart = false) {
  const cur = smart ? S().smart.find((c) => c.id === id) : S().collections.find((c) => c.id === id);
  if (!(await askConfirm('Delete Collection', `Delete the collection “${cur?.name}”? The files themselves are not touched.`, 'Delete'))) return;
  if (smart) set((s) => ({ smart: s.smart.filter((c) => c.id !== id) }));
  else set((s) => ({ collections: s.collections.filter((c) => c.id !== id) }));
}

export async function openCollection(id: string) {
  const c = S().collections.find((x) => x.id === id);
  if (!c) return;
  const g = ++gen;
  unwatch?.();
  unwatch = null;
  set({ loading: true, source: { type: 'collection', id }, error: null, filters: {} });
  const fs = backend();
  const found = await Promise.all(c.paths.map((p) => fs.stat(p).catch(() => null)));
  if (g !== gen) return;
  const entries = found.filter((e): e is FsEntry => !!e && !e.dir);
  set((s) => ({ entries, names: [], loading: false, selection: s.selection.filter((p) => entries.some((e) => e.path === p)) }));
  if (entries.length < c.paths.length) status(`${c.paths.length - entries.length} item(s) of “${c.name}” are missing or not accessible.`, 'error');
  void loadMeta(
    entries.map((e) => e.path),
    g,
  );
}

/** Save the current folder + filter as a Smart Collection. */
export async function saveSmartCollection() {
  const s = S();
  const folder = s.lastFolder;
  if (!folder) return;
  const name = await askText('New Smart Collection', 'Name (the current folder and Filter panel selection are saved):', 'Smart Collection', 'Save');
  if (!name) return;
  const c: SmartCollection = { id: 's' + uid(), name, folder, filters: JSON.parse(JSON.stringify(s.filters)) };
  set((st) => ({ smart: [...st.smart, c] }));
}
export async function openSmart(id: string) {
  const c = S().smart.find((x) => x.id === id);
  if (c) await openFolder(c.folder, { filters: c.filters, smart: id });
}

const kwPath = (parent: string | null, name: string) => (parent ? `${parent}|${name}` : name);
function mapTree(nodes: KeywordNode[], parent: string | null, fn: (n: KeywordNode, path: string) => KeywordNode | null): KeywordNode[] {
  return nodes.flatMap((n) => {
    const p = kwPath(parent, n.name);
    const r = fn(n, p);
    if (!r) return [];
    return [{ ...r, children: r.children ? mapTree(r.children, p, fn) : undefined }];
  });
}
export async function addKeyword(parent: string | null) {
  const name = (await askText(parent ? 'New Sub Keyword' : 'New Keyword', 'Keyword:', '', 'Add'))?.replace(/\|/g, '').trim();
  if (!name) return;
  if (!parent) return set((s) => ({ keywords: [...s.keywords, { name }].sort((a, b) => a.name.localeCompare(b.name)) }));
  set((s) => ({
    keywords: mapTree(s.keywords, null, (n, p) => (p === parent ? { ...n, children: [...(n.children ?? []), { name }].sort((a, b) => a.name.localeCompare(b.name)) } : n)),
  }));
}
export async function renameKeyword(path: string) {
  const name = (await askText('Rename Keyword', 'Keyword:', path.split('|').pop(), 'Rename'))?.replace(/\|/g, '').trim();
  if (!name) return;
  set((s) => ({ keywords: mapTree(s.keywords, null, (n, p) => (p === path ? { ...n, name } : n)) }));
}
export async function deleteKeyword(path: string) {
  if (!(await askConfirm('Delete Keyword', `Delete “${path.split('|').join(' › ')}” from the keyword list? Files that have it keep it.`, 'Delete'))) return;
  set((s) => ({ keywords: mapTree(s.keywords, null, (n, p) => (p === path ? null : n)) }));
}

// ---------------------------------------------------------------------------
// Loupe / review
// ---------------------------------------------------------------------------

export function openLoupe(path?: string) {
  const p = path ?? S().focus ?? S().selection[0];
  const e = p ? entryOf(p) : undefined;
  if (e && !e.dir) set({ loupe: p });
}
export const closeLoupe = () => set({ loupe: null });
export function loupeStep(d: number) {
  const items = visibleItems().filter((e) => !e.dir);
  const i = items.findIndex((e) => e.path === S().loupe);
  const n = items[Math.max(0, Math.min(items.length - 1, i + d))];
  if (n) set({ loupe: n.path, selection: [n.path], focus: n.path, anchor: n.path });
}

export { joinPath, reloadMeta };
