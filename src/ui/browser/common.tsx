/** Shared bits of the browser panels: thumbnails, stars, label chips, the item context menu, drag data. */
import { useEffect, useState } from 'react';
import { kindOf } from '../../core/files/kinds';
import { cachedThumb, requestThumb, type Thumb } from '../../core/files/thumbs';
import type { FsEntry } from '../../core/files/types';
import { LABELS, labelColor, type LabelColor } from '../../core/files/xmp';
import { Icon } from '../Icon';
import type { MenuItem } from '../Menu';
import * as A from './actions';
import { useBrowser } from './store';

/** dataTransfer type for browser items dragged onto the graph / viewer / folders. */
export const DND_FILES = 'application/x-darkroom-files';

export const KIND_ICON: Record<string, string> = { folder: 'folder', image: 'picture', raw: 'camera', video: 'film', project: 'node_design', other: 'page_white' };

export function useThumb(e: FsEntry, px: number): Thumb | null | undefined {
  const [t, setT] = useState<Thumb | null | undefined>(() => (e.dir ? null : cachedThumb(e, px)));
  useEffect(() => {
    if (e.dir) return setT(null);
    const c = cachedThumb(e, px);
    if (c !== undefined) return setT(c);
    setT((prev) => prev ?? undefined); // keep a smaller bucket's image while the bigger one loads
    const ac = new AbortController();
    const t = setTimeout(() => {
      requestThumb(A.backend(), e, px, ac.signal).then(
        (r) => !ac.signal.aborted && setT(r),
        () => {},
      );
    }, 30); // skip cells that only fly past while scrolling
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [e, px]);
  return t;
}

/** A thumbnail image, or the kind's icon while loading / when none can be made. */
export function ThumbImg({ e, px, fit = 'contain' }: { e: FsEntry; px: number; fit?: 'contain' | 'cover' }) {
  const t = useThumb(e, px);
  if (t)
    return <img className="br-thumb-img" src={t.url} alt="" draggable={false} style={{ objectFit: fit }} />;
  const k = e.dir ? 'folder' : kindOf(e.name);
  return (
    <span className={'br-thumb-icon' + (t === undefined && !e.dir ? ' loading' : '')}>
      <Icon name={k === 'folder' ? 'folder' : KIND_ICON[k]} size={32} />
    </span>
  );
}

export function Stars({ rating, onRate, small }: { rating?: number; onRate?: (r: number) => void; small?: boolean }) {
  if (rating === -1)
    return (
      <span className={'br-stars reject' + (small ? ' small' : '')} title="Rejected" onClick={onRate ? (ev) => (ev.stopPropagation(), onRate(0)) : undefined}>
        Reject
      </span>
    );
  return (
    <span className={'br-stars' + (small ? ' small' : '')}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span
          key={i}
          className={'br-star' + (i <= (rating ?? 0) ? ' on' : '')}
          onClick={
            onRate
              ? (ev) => {
                  ev.stopPropagation();
                  onRate(i === rating ? i - 1 : i);
                }
              : undefined
          }
        >
          {i <= (rating ?? 0) ? '★' : onRate ? '·' : ''}
        </span>
      ))}
    </span>
  );
}

export const labelCss = (label?: string) => {
  const c = labelColor(label);
  return c ? LABELS.find((l) => l.color === c)!.css : label ? '#999' : undefined;
};

export function LabelChip({ label }: { label?: string }) {
  const css = labelCss(label);
  if (!css) return null;
  return <span className="br-label-chip" style={{ background: css }} title={label} />;
}

export function fmtSize(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

export const fmtDate = (ms: number) => (ms ? new Date(ms).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');

/** Context menu for the selection (Content, Filmstrip, Preview). */
export function itemMenu(paths: string[]): MenuItem[] {
  const fs = A.backend();
  const s = useBrowser.getState();
  const first = paths[0];
  const e = first ? A.entryOf(first) : undefined;
  const files = paths.filter((p) => !A.entryOf(p)?.dir);
  const why = fs.caps.why;
  const inCollection = s.source?.type === 'collection' ? s.source.id : null;
  const none = !paths.length;
  const ratings = (): MenuItem[] => [
    { label: 'No Rating', keys: '0', run: () => A.setRating(files, 0) },
    ...[1, 2, 3, 4, 5].map((r) => ({ label: '★'.repeat(r), keys: String(r), run: () => A.setRating(files, r) })),
    { sep: true },
    { label: 'Reject', icon: 'reject', keys: 'Alt+Delete', run: () => A.setRating(files, -1) },
  ];
  const labels = (): MenuItem[] => [
    { label: 'No Label', run: () => A.setLabel(files, null) },
    ...LABELS.map((l) => ({ label: l.name, icon: `tag_${l.color === 'purple' ? 'purple' : l.color}`, keys: l.key, run: () => A.setLabel(files, l.color as LabelColor) })),
  ];
  const collections = (): MenuItem[] => [
    { label: 'New Collection…', icon: 'add', run: () => void A.newCollection(paths) },
    ...(s.collections.length ? [{ sep: true } as MenuItem] : []),
    ...s.collections.map((c) => ({ label: c.name, icon: 'book', run: () => A.addToCollection(c.id, files) })),
  ];
  return [
    { label: e?.dir ? 'Open Folder' : 'Open in Darkroom', icon: e?.dir ? 'folder_go' : 'picture_go', keys: 'Enter', run: () => first && void A.openInDarkroom(first), disabled: paths.length !== 1 },
    { label: 'Open as New Project', icon: 'page_white', run: () => first && void A.openAsNewProject(first), disabled: files.length !== 1 },
    { label: 'Add to Graph', icon: 'image_add', run: () => void A.addToGraph(files), disabled: !files.length },
    { label: 'Batch Process…', icon: 'images', run: () => void A.batchProcess(files), disabled: !files.length },
    { label: 'Open with Default App', icon: 'application', run: () => first && void A.openWithDefault(first), disabled: paths.length !== 1 || !fs.caps.openDefault, title: fs.caps.openDefault ? undefined : why },
    { sep: true },
    { label: 'Rating', icon: 'star', submenu: ratings, disabled: !files.length },
    { label: 'Label', icon: 'tag_blue', submenu: labels, disabled: !files.length },
    { label: 'Add to Collection', icon: 'book', submenu: collections, disabled: !files.length },
    ...(inCollection ? [{ label: 'Remove from Collection', icon: 'book_delete', run: () => A.removeFromCollection(inCollection, paths) } as MenuItem] : []),
    { sep: true },
    { label: 'Rename…', icon: 'textfield_rename', keys: 'F2', run: () => first && void A.renameOne(first), disabled: paths.length !== 1 || !fs.caps.rename, title: fs.caps.rename ? undefined : why },
    { label: 'Batch Rename…', icon: 'document_rename', keys: 'Ctrl+Shift+R', run: () => A.batchRename(files), disabled: !files.length || !fs.caps.rename, title: fs.caps.rename ? undefined : why },
    { label: 'Reveal in Finder', icon: 'folder_explorer', run: () => first && A.reveal(first), disabled: paths.length !== 1 || !fs.caps.reveal, title: fs.caps.reveal ? undefined : why },
    { label: 'Copy Path', icon: 'page_copy', run: () => void A.copyPaths(paths), disabled: none },
    { sep: true },
    { label: 'Move to Trash', icon: 'bin', keys: 'Delete', run: () => void A.trashPaths(paths), disabled: none || !fs.caps.trash, title: fs.caps.trash ? undefined : why },
  ];
}

/** Bridge-style key handling shared by Content, Filmstrip and Preview. Returns true if handled. */
export function handleItemKey(e: React.KeyboardEvent, opts: { cols?: number; horizontal?: boolean } = {}): boolean {
  const s = useBrowser.getState();
  const mod = e.metaKey || e.ctrlKey;
  const files = A.selectedFiles();
  const k = e.key;
  const cols = opts.cols ?? 1;
  const go = (d: number) => A.moveFocus(d, e.shiftKey);
  if (k === 'ArrowRight' && !mod) return go(1), true;
  if (k === 'ArrowLeft' && !mod) return go(-1), true;
  if (k === 'ArrowDown' && !mod && !opts.horizontal) return go(cols), true;
  if (k === 'ArrowUp' && !mod && !opts.horizontal) return go(-cols), true;
  if (k === 'Home') return A.moveFocus(-1e9, e.shiftKey), true;
  if (k === 'End') return A.moveFocus(1e9, e.shiftKey), true;
  if (k === 'ArrowUp' && mod) return A.goUp(), true;
  if ((k === 'ArrowDown' && mod) || (k === 'Enter' && !e.altKey)) {
    const p = s.focus ?? s.selection[0];
    if (p) void A.openInDarkroom(p);
    return true;
  }
  if (k === 'a' && mod) return A.selectAll(), true;
  if (k === '[' && mod) return A.goBack(), true;
  if (k === ']' && mod) return A.goForward(), true;
  if (k === ' ' && !mod) return A.openLoupe(), true;
  if (k === 'F2') {
    if (s.selection.length === 1) void A.renameOne(s.selection[0]);
    return true;
  }
  if ((k === 'r' || k === 'R') && mod && e.shiftKey) return A.batchRename(files), true;
  if (k === 'F5') return void A.refresh(), true;
  if ((k === 'Delete' || k === 'Backspace') && e.altKey) return A.setRating(files, -1), true;
  if (k === 'Delete' || (k === 'Backspace' && (mod || A.backend().kind === 'electron'))) {
    void A.trashPaths(s.selection);
    return true;
  }
  if (!mod && !e.altKey && /^[0-5]$/.test(k)) return A.setRating(files, Number(k)), true;
  if (!mod && !e.altKey && /^[6-9]$/.test(k)) {
    const l = LABELS.find((x) => x.key === k);
    if (l) A.setLabel(files, l.color);
    return true;
  }
  if (mod && /^[0-5]$/.test(k)) return A.setRating(files, Number(k)), true; // Bridge's ⌘0–⌘5 (browser build; the Mac app's menu keeps ⌘1 etc.)
  if (mod && /^[6-9]$/.test(k)) {
    const l = LABELS.find((x) => x.key === k);
    if (l) A.setLabel(files, l.color);
    return true;
  }
  return false;
}

/** Start dragging the selection (or the item under the pointer). */
export function startItemDrag(ev: React.DragEvent, path: string) {
  const s = useBrowser.getState();
  const paths = s.selection.includes(path) ? s.selection : [path];
  if (!s.selection.includes(path)) A.select(path);
  ev.dataTransfer.setData(DND_FILES, JSON.stringify(paths));
  ev.dataTransfer.setData('text/plain', paths.map((p) => A.backend().displayPath(p)).join('\n'));
  ev.dataTransfer.effectAllowed = 'copyMove';
}

/** Folder targets: drop items to move (⌥ copies). */
export function folderDropProps(dir: string) {
  return {
    onDragOver: (ev: React.DragEvent) => {
      if (!ev.dataTransfer.types.includes(DND_FILES)) return;
      ev.preventDefault();
      ev.stopPropagation();
      ev.dataTransfer.dropEffect = ev.altKey ? 'copy' : 'move';
      (ev.currentTarget as HTMLElement).classList.add('br-drop');
    },
    onDragLeave: (ev: React.DragEvent) => (ev.currentTarget as HTMLElement).classList.remove('br-drop'),
    onDrop: (ev: React.DragEvent) => {
      (ev.currentTarget as HTMLElement).classList.remove('br-drop');
      const raw = ev.dataTransfer.getData(DND_FILES);
      if (!raw) return;
      ev.preventDefault();
      ev.stopPropagation();
      const paths = (JSON.parse(raw) as string[]).filter((p) => p !== dir);
      if (paths.length) void A.transferTo(paths, dir, ev.altKey ? 'copy' : 'move');
    },
  };
}

/** Panel focus tracking for the status bar. */
export const focusProps = (panelId: string) => ({
  onFocus: () => useBrowser.getState().activePanel !== panelId && useBrowser.setState({ activePanel: panelId }),
  onBlur: (e: React.FocusEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setTimeout(() => useBrowser.getState().activePanel === panelId && !document.activeElement?.closest('[data-browser-panel]') && useBrowser.setState({ activePanel: null }), 0);
  },
  'data-browser-panel': panelId,
  tabIndex: -1,
});
