/** Content panel: the thumbnail grid / details list / filmstrip of the current folder or collection (virtualised). */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { basename } from '../../core/files/backend';
import { orientedDims } from '../../core/files/facets';
import { typeLabel } from '../../core/files/kinds';
import type { FsEntry } from '../../core/files/types';
import { addOpenedFiles, OPENED_ROOT } from '../../core/files/web';
import { hasFilters } from '../../core/files/facets';
import { pickFiles } from '../../store/io';
import { Panel } from '../Chrome';
import { Icon } from '../Icon';
import { useContextMenu, type MenuItem } from '../Menu';
import * as A from './actions';
import { fmtDate, fmtSize, folderDropProps, focusProps, handleItemKey, itemMenu, LabelChip, labelCss, Stars, startItemDrag, ThumbImg } from './common';
import { Filmstrip } from './Filmstrip';
import { PreviewBody } from './Preview';
import { itemDate, SORTS, useBrowser, useVisibleItems, type ViewMode } from './store';

const LABEL_H = 44;
const GAP = 10;

function useViewport(ref: React.RefObject<HTMLDivElement | null>) {
  const [vp, setVp] = useState({ w: 0, h: 0, top: 0, left: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const upd = () => setVp({ w: el.clientWidth, h: el.clientHeight, top: el.scrollTop, left: el.scrollLeft });
    upd();
    const ro = new ResizeObserver(upd);
    ro.observe(el);
    el.addEventListener('scroll', upd, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener('scroll', upd);
    };
  }, [ref]);
  return vp;
}

function onCellMouseDown(ev: React.MouseEvent, path: string) {
  if (ev.button === 2) {
    if (!useBrowser.getState().selection.includes(path)) A.select(path);
    return;
  }
  if (ev.button !== 0) return;
  if (ev.shiftKey) A.select(path, 'range');
  else if (ev.metaKey || ev.ctrlKey) A.select(path, 'toggle');
  else if (!useBrowser.getState().selection.includes(path)) A.select(path);
  else useBrowser.setState({ focus: path, anchor: path });
}
function onCellClick(ev: React.MouseEvent, path: string) {
  // plain click on an already-selected item of a multi-selection: narrow to it (on mouse up, so dragging the group works)
  if (!ev.shiftKey && !ev.metaKey && !ev.ctrlKey && useBrowser.getState().selection.length > 1) A.select(path);
}

function GridCell({ e, size, x, y, selected, focused, onMenu }: { e: FsEntry; size: number; x: number; y: number; selected: boolean; focused: boolean; onMenu: (ev: React.MouseEvent) => void }) {
  const meta = useBrowser((s) => s.meta[e.path]);
  const label = meta?.xmp.label;
  const lc = labelCss(label);
  return (
    <div
      className={'br-cell' + (selected ? ' selected' : '') + (focused ? ' focused' : '') + (meta?.xmp.rating === -1 ? ' rejected' : '')}
      style={{ left: x, top: y, width: size + 12, height: size + LABEL_H }}
      data-path={e.path}
      title={`${e.name}\n${e.dir ? 'Folder' : `${typeLabel(e.name)} · ${fmtSize(e.size)}`}`}
      onMouseDown={(ev) => onCellMouseDown(ev, e.path)}
      onClick={(ev) => onCellClick(ev, e.path)}
      onDoubleClick={() => void A.openInDarkroom(e.path)}
      onContextMenu={onMenu}
      draggable
      onDragStart={(ev) => startItemDrag(ev, e.path)}
      {...(e.dir ? folderDropProps(e.path) : {})}
    >
      <div className="br-cell-img" style={{ width: size, height: size }}>
        <ThumbImg e={e} px={size} />
      </div>
      <div className="br-cell-meta">
        {!e.dir && <Stars rating={meta?.xmp.rating} small onRate={(r) => A.setRating(useBrowser.getState().selection.includes(e.path) ? A.selectedFiles() : [e.path], r)} />}
      </div>
      <div className="br-cell-name" style={lc ? { background: lc, color: '#fff' } : undefined}>
        {e.name}
      </div>
    </div>
  );
}

function Grid({ items, size, onMenu }: { items: FsEntry[]; size: number; onMenu: (ev: React.MouseEvent, p: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const vp = useViewport(ref);
  const sel = useBrowser((s) => s.selection);
  const focus = useBrowser((s) => s.focus);
  const selSet = useMemo(() => new Set(sel), [sel]);
  const cw = size + 12 + GAP;
  const ch = size + LABEL_H + GAP;
  const cols = Math.max(1, Math.floor((vp.w - GAP) / cw));
  colsRef.current = cols;
  const rows = Math.ceil(items.length / cols);
  const first = Math.max(0, Math.floor(vp.top / ch) - 2);
  const last = Math.min(rows, Math.ceil((vp.top + vp.h) / ch) + 2);
  const pad = Math.max(GAP, Math.floor((vp.w - cols * cw + GAP) / 2));
  // keep the focused item in view (keyboard navigation)
  useEffect(() => {
    const el = ref.current;
    const i = focus ? items.findIndex((e) => e.path === focus) : -1;
    if (!el || i < 0) return;
    const top = Math.floor(i / cols) * ch + GAP;
    if (top < el.scrollTop) el.scrollTop = top - GAP;
    else if (top + ch > el.scrollTop + el.clientHeight) el.scrollTop = top + ch - el.clientHeight;
  }, [focus, cols, ch, items]);
  const cells = [];
  for (let r = first; r < last; r++)
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const e = items[i];
      if (!e) break;
      cells.push(<GridCell key={e.path} e={e} size={size} x={pad + c * cw} y={GAP + r * ch} selected={selSet.has(e.path)} focused={focus === e.path} onMenu={(ev) => onMenu(ev, e.path)} />);
    }
  return (
    <div className="br-grid" ref={ref} onMouseDown={(ev) => ev.target === ev.currentTarget && A.selectNone()} onContextMenu={(ev) => ev.target === ev.currentTarget && onMenu(ev, '')}>
      <div className="br-grid-inner" style={{ height: rows * ch + GAP }}>
        {cells}
      </div>
    </div>
  );
}

const ROW_H = 22;
const COLS: { id: string; label: string; w: number }[] = [
  { id: 'name', label: 'Name', w: 260 },
  { id: 'date', label: 'Date Created', w: 150 },
  { id: 'size', label: 'Size', w: 80 },
  { id: 'type', label: 'Type', w: 130 },
  { id: 'dims', label: 'Dimensions', w: 100 },
  { id: 'rating', label: 'Rating', w: 80 },
  { id: 'label', label: 'Label', w: 90 },
];

function ListView({ items, onMenu }: { items: FsEntry[]; onMenu: (ev: React.MouseEvent, p: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const vp = useViewport(ref);
  const sel = useBrowser((s) => s.selection);
  const focus = useBrowser((s) => s.focus);
  const meta = useBrowser((s) => s.meta);
  const sortKey = useBrowser((s) => s.sortKey);
  const asc = useBrowser((s) => s.sortAsc);
  const selSet = useMemo(() => new Set(sel), [sel]);
  colsRef.current = 1;
  const first = Math.max(0, Math.floor(vp.top / ROW_H) - 5);
  const last = Math.min(items.length, Math.ceil((vp.top + vp.h) / ROW_H) + 5);
  useEffect(() => {
    const el = ref.current;
    const i = focus ? items.findIndex((e) => e.path === focus) : -1;
    if (!el || i < 0) return;
    const top = i * ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H * 2 > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H * 2 - el.clientHeight;
  }, [focus, items]);
  const rows = [];
  for (let i = first; i < last; i++) {
    const e = items[i];
    const m = meta[e.path];
    const d = orientedDims(m?.exif);
    rows.push(
      <div
        key={e.path}
        className={'br-row' + (selSet.has(e.path) ? ' selected' : '') + (focus === e.path ? ' focused' : '') + (i % 2 ? ' odd' : '')}
        style={{ top: ROW_H + i * ROW_H }}
        data-path={e.path}
        onMouseDown={(ev) => onCellMouseDown(ev, e.path)}
        onClick={(ev) => onCellClick(ev, e.path)}
        onDoubleClick={() => void A.openInDarkroom(e.path)}
        onContextMenu={(ev) => onMenu(ev, e.path)}
        draggable
        onDragStart={(ev) => startItemDrag(ev, e.path)}
        {...(e.dir ? folderDropProps(e.path) : {})}
      >
        <span style={{ width: COLS[0].w }} className="br-row-name">
          <span className="br-row-thumb">
            <ThumbImg e={e} px={64} />
          </span>
          {e.name}
        </span>
        <span style={{ width: COLS[1].w }}>{fmtDate(itemDate(e, m))}</span>
        <span style={{ width: COLS[2].w }} className="num">
          {e.dir ? '' : fmtSize(e.size)}
        </span>
        <span style={{ width: COLS[3].w }}>{typeLabel(e.name, e.dir)}</span>
        <span style={{ width: COLS[4].w }} className="num">
          {d ? `${d.w} × ${d.h}` : ''}
        </span>
        <span style={{ width: COLS[5].w }}>{!e.dir && <Stars rating={m?.xmp.rating} small />}</span>
        <span style={{ width: COLS[6].w }}>
          {m?.xmp.label && (
            <>
              <LabelChip label={m.xmp.label} /> {m.xmp.label}
            </>
          )}
        </span>
      </div>,
    );
  }
  return (
    <div className="br-list" ref={ref} onMouseDown={(ev) => ev.target === ev.currentTarget && A.selectNone()}>
      <div className="br-list-inner" style={{ height: ROW_H * (items.length + 1), minWidth: COLS.reduce((a, c) => a + c.w, 0) }}>
        <div className="br-list-head">
          {COLS.map((c) => (
            <span
              key={c.id}
              style={{ width: c.w }}
              className={sortKey === c.id ? 'sorted' : ''}
              onClick={() => (c.id === 'label' ? null : useBrowser.setState((s) => (s.sortKey === c.id ? { sortAsc: !s.sortAsc } : { sortKey: c.id as typeof s.sortKey, sortAsc: true })))}
            >
              {c.label}
              {sortKey === c.id ? (asc ? ' ▲' : ' ▼') : ''}
            </span>
          ))}
        </div>
        {rows}
      </div>
    </div>
  );
}

/** Columns of the grid, for ↑/↓ (set while rendering). */
const colsRef = { current: 1 };

function PathBar() {
  const src = useBrowser((s) => s.source);
  const roots = useBrowser((s) => s.roots);
  const collections = useBrowser((s) => s.collections);
  const smart = useBrowser((s) => s.smart);
  if (!src) return <div className="br-pathbar muted">No folder</div>;
  if (src.type !== 'folder') {
    const c = src.type === 'collection' ? collections.find((x) => x.id === src.id) : smart.find((x) => x.id === src.id);
    return (
      <div className="br-pathbar">
        <Icon name={src.type === 'collection' ? 'book' : 'book_open'} />
        <span className="br-crumb current">{c?.name ?? 'Collection'}</span>
        {src.type === 'smart' && c && 'folder' in c && <span className="muted">&nbsp;— in {basename(c.folder)}</span>}
      </div>
    );
  }
  const root = roots.filter((r) => src.path === r.path || src.path.startsWith(r.path + '/')).sort((a, b) => b.path.length - a.path.length)[0];
  const crumbs: { name: string; path: string }[] = [];
  if (root) {
    crumbs.push({ name: root.name, path: root.path });
    let acc = root.path;
    for (const seg of src.path.slice(root.path.length).split('/').filter(Boolean)) crumbs.push({ name: seg, path: (acc = acc + '/' + seg) });
  } else crumbs.push({ name: basename(src.path), path: src.path });
  return (
    <div className="br-pathbar">
      {crumbs.map((c, i) => (
        <span key={c.path} className="br-crumb-wrap">
          {i > 0 && <span className="br-crumb-sep">▸</span>}
          <span className={'br-crumb' + (i === crumbs.length - 1 ? ' current' : '')} onClick={() => i < crumbs.length - 1 && void A.openFolder(c.path)} {...folderDropProps(c.path)}>
            {i === 0 && <Icon name="folder" />} {c.name}
          </span>
        </span>
      ))}
    </div>
  );
}

function Tools() {
  const histIdx = useBrowser((s) => s.historyIndex);
  useBrowser((s) => s.history.length);
  const src = useBrowser((s) => s.source);
  const sortKey = useBrowser((s) => s.sortKey);
  const asc = useBrowser((s) => s.sortAsc);
  const menu = useContextMenu();
  void histIdx;
  const sortItems = (): MenuItem[] => [
    ...SORTS.map((s) => ({ label: s.label, checked: s.id === sortKey, run: () => useBrowser.setState({ sortKey: s.id }) })),
    { sep: true },
    { label: 'Ascending Order', checked: asc, run: () => useBrowser.setState((s) => ({ sortAsc: !s.sortAsc })) },
  ];
  return (
    <>
      <button className="tbtn small" title="Go Back (⌘[)" disabled={!A.canBack()} onClick={A.goBack}>
        <Icon name="arrow_left" />
      </button>
      <button className="tbtn small" title="Go Forward (⌘])" disabled={!A.canForward()} onClick={A.goForward}>
        <Icon name="arrow_right" />
      </button>
      <button className="tbtn small" title="Go to Parent Folder (⌘↑)" disabled={!A.parentFolder()} onClick={A.goUp}>
        <Icon name="arrow_up" />
      </button>
      <button className="tbtn small" title="Refresh (F5)" disabled={!src} onClick={() => void A.refresh()}>
        <Icon name="arrow_refresh" />
      </button>
      <button className="tbtn small" title="New Folder" disabled={src?.type !== 'folder' || !A.backend().caps.mkdir} onClick={() => void A.newFolder()}>
        <Icon name="folder_add" />
      </button>
      <button
        className="tbtn small br-sort-btn"
        title="Sort"
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          menu.open({ clientX: r.left, clientY: r.bottom }, sortItems());
        }}
      >
        <Icon name={asc ? 'sort_ascending' : 'sort_descending'} /> Sort by {SORTS.find((s) => s.id === sortKey)?.label} ▾
      </button>
      {menu.el}
    </>
  );
}

function BottomBar({ count }: { count: number }) {
  const total = useBrowser((s) => s.entries.length);
  const sel = useBrowser((s) => s.selection.length);
  const pending = useBrowser((s) => s.metaPending);
  const loading = useBrowser((s) => s.loading);
  const size = useBrowser((s) => s.thumbSize);
  const view = useBrowser((s) => s.view);
  const filtered = useBrowser((s) => hasFilters(s.filters));
  const views: { id: ViewMode; icon: string; title: string }[] = [
    { id: 'grid', icon: 'application_view_tile', title: 'View as Thumbnails' },
    { id: 'strip', icon: 'film', title: 'View as Filmstrip' },
    { id: 'list', icon: 'application_view_detail', title: 'View as Details' },
  ];
  return (
    <div className="br-bottombar">
      <span className="br-count">
        {loading ? (
          <>
            <Icon name="hourglass" /> Loading…
          </>
        ) : (
          <>
            {count} item{count === 1 ? '' : 's'}
            {filtered && total !== count ? ` (${total - count} hidden by filter)` : ''}
            {sel ? `, ${sel} selected` : ''}
          </>
        )}
        {pending > 0 && <span className="muted"> · reading metadata ({pending})</span>}
      </span>
      <span className="br-spacer" />
      <Icon name="image" />
      <input type="range" className="br-size" min={64} max={360} step={2} value={size} disabled={view === 'list'} title="Thumbnail size" onChange={(e) => useBrowser.setState({ thumbSize: Number(e.target.value) })} />
      <Icon name="picture" size={16} />
      <span className="br-views">
        {views.map((v) => (
          <button key={v.id} className={'tbtn small' + (view === v.id ? ' checked' : '')} title={v.title} onClick={() => useBrowser.setState({ view: v.id })}>
            <Icon name={v.icon} />
          </button>
        ))}
      </span>
    </div>
  );
}

function EmptyState() {
  const fs = A.backend();
  const src = useBrowser((s) => s.source);
  const error = useBrowser((s) => s.error);
  const loading = useBrowser((s) => s.loading);
  const filtered = useBrowser((s) => hasFilters(s.filters));
  if (loading) return null;
  if (error)
    return (
      <div className="br-empty">
        <Icon name="error" size={32} />
        <p>{error}</p>
      </div>
    );
  if (src) return <div className="br-empty muted">{filtered ? 'No items match the filter.' : 'This folder has no images, RAW files, videos or Darkroom projects.'}</div>;
  if (fs.kind === 'files')
    return (
      <div className="br-empty">
        <Icon name="folder_error" size={32} />
        <p>
          <b>This browser can’t open folders.</b>
          <br />
          Browsing folders needs the File System Access API (Chrome, Edge, Arc or Opera) or the Darkroom Mac app. You can still browse, rate and open individual files:
        </p>
        <button
          className="btn"
          onClick={async () => {
            const files = await pickFiles('image/*,video/*,.dng,.cr2,.cr3,.nef,.arw,.raf,.orf,.rw2,.pef,.srw,.heic,.tif,.tiff,.darkroom', true);
            if (!files.length) return;
            addOpenedFiles(files);
            await A.openFolder(OPENED_ROOT);
          }}
        >
          <Icon name="folder_image" /> Open Files…
        </button>
      </div>
    );
  return (
    <div className="br-empty">
      <Icon name="folder_image" size={32} />
      <p>Choose a folder in Favorites or Folders{fs.kind === 'web' ? ' — the browser asks for access once' : ''}.</p>
      <button className="btn" onClick={() => void A.addFolder()}>
        <Icon name="folder_add" /> Add Folder…
      </button>
    </div>
  );
}

export function ContentPanel({ panelId }: { panelId: string }) {
  useEffect(() => void A.initBrowser(), []);
  const items = useVisibleItems();
  const view = useBrowser((s) => s.view);
  const size = useBrowser((s) => s.thumbSize);
  const menu = useContextMenu();
  const openMenu = (ev: React.MouseEvent, path: string) => {
    ev.preventDefault();
    ev.stopPropagation();
    const sel = useBrowser.getState().selection;
    const paths = path ? (sel.includes(path) ? sel : [path]) : sel;
    if (path && !sel.includes(path)) A.select(path);
    const src = useBrowser.getState().source;
    const extra: MenuItem[] = !path
      ? [
          { label: 'New Folder…', icon: 'folder_add', run: () => void A.newFolder(), disabled: src?.type !== 'folder' || !A.backend().caps.mkdir },
          { label: 'Refresh', icon: 'arrow_refresh', run: () => void A.refresh(), disabled: !src },
          { label: 'Select All', icon: 'table_select_all', run: A.selectAll },
          { label: 'Show Folders', checked: useBrowser.getState().showFolders, run: () => useBrowser.setState((s) => ({ showFolders: !s.showFolders })) },
          { label: 'Show Hidden Files', checked: useBrowser.getState().showHidden, run: () => (useBrowser.setState((s) => ({ showHidden: !s.showHidden })), void A.refresh()) },
          ...(src?.type === 'folder' ? [{ label: 'Reveal in Finder', icon: 'folder_explorer', run: () => A.reveal(src.path), disabled: !A.backend().caps.reveal } as MenuItem] : []),
        ]
      : [];
    menu.open(ev, path ? itemMenu(paths) : extra);
  };
  const body =
    !items.length ? (
      <EmptyState />
    ) : view === 'list' ? (
      <ListView items={items} onMenu={openMenu} />
    ) : view === 'strip' ? (
      <div className="br-stripview">
        <div className="br-stripview-preview">
          <PreviewBody panelId={panelId} />
        </div>
        <Filmstrip height={Math.max(90, Math.min(160, size * 0.7))} onMenu={openMenu} />
      </div>
    ) : (
      <Grid items={items} size={size} onMenu={openMenu} />
    );
  return (
    <Panel title="Content" icon="images" tools={<Tools />} className="br-panel">
      <div
        className="br-content"
        {...focusProps(panelId)}
        onKeyDown={(e) => {
          if ((e.target as HTMLElement).closest('input,textarea,select')) return;
          if (handleItemKey(e, { cols: view === 'grid' ? colsRef.current : 1, horizontal: view === 'strip' })) {
            e.preventDefault();
            e.stopPropagation();
          }
        }}
      >
        <PathBar />
        {body}
        <BottomBar count={items.length} />
      </div>
      {menu.el}
    </Panel>
  );
}
