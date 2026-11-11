import { Fragment, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { GROUP_INPUT, GROUP_OUTPUT } from '../core/graph';
import { matchSearchable } from '../core/graphLayout';
import { getNodeDef, listNodeDefs, listPresets } from '../core/registry';
import { getUserPreset, isUserPreset, renameUserPreset, subscribeUserPresets } from '../core/userPresets';
import { addNode, freeSpot, type AddSpec } from '../store/actions';
import { useDoc } from '../store/doc';
import { deletePreset, exportPreset, importPresetFiles } from '../store/presets';
import { setPref, useSettings, type LibrarySort, type LibraryView } from '../store/settings';
import { Panel } from './Chrome';
import { categoryIcon, Icon, nodeIcon } from './Icon';
import { useContextMenu, type MenuItem } from './Menu';
import { useRegistry } from './useRegistry';
import { nodeThumb, skipPreview, useNodeThumbs } from './library/libraryThumbs';
import './library/library.css';

export const DND_TYPE = 'application/x-darkroom-add';

export interface Entry {
  key: string;
  spec: AddSpec;
  name: string;
  category: string;
  description?: string;
  tags?: string[];
  icon: string;
  /** A preset saved by the user (My Presets). */
  user?: boolean;
}

/** All addable entries (nodes + presets) for the current editing context. */
export function useAddEntries(): { nodes: Entry[]; presets: Entry[]; all: Map<string, Entry> } {
  const v = useRegistry();
  const inGroup = useDoc((s) => s.path.length > 0);
  return useMemo(() => {
    void v;
    const nodes = listNodeDefs()
      .filter((d) => !d.hidden || (inGroup && (d.id === GROUP_INPUT || d.id === GROUP_OUTPUT)))
      .map<Entry>((d) => ({ key: 'n:' + d.id, spec: { kind: 'node', type: d.id }, name: d.name, category: d.category, description: d.description, tags: d.tags, icon: nodeIcon(d.id) }));
    const presets = listPresets().map<Entry>((p) => ({
      key: 'p:' + p.id,
      spec: { kind: 'preset', id: p.id },
      name: p.name,
      category: p.category,
      description: p.description,
      tags: p.tags,
      icon: isUserPreset(p.id) ? 'star' : categoryIcon(p.category),
      user: isUserPreset(p.id),
    }));
    return { nodes, presets, all: new Map([...nodes, ...presets].map((e) => [e.key, e])) };
  }, [v, inGroup]);
}

/** Search score of an entry (-1 = no match): fuzzy on the name, then tags, category and description. */
export function matchEntry(e: Entry, q: string) {
  if (!q) return 0;
  return matchSearchable(e, q);
}

/** Favourite / recent add-node entries (Preferences, persisted). */
export function toggleFavorite(key: string) {
  const f = useSettings.getState().addFavorites;
  setPref('addFavorites', f.includes(key) ? f.filter((k) => k !== key) : [...f, key]);
}
export function pushRecent(key: string) {
  const r = useSettings.getState().addRecent;
  setPref('addRecent', [key, ...r.filter((k) => k !== key)].slice(0, 8));
}

export function useUserPresetsVersion() {
  return useSyncExternalStore(subscribeUserPresets, () => ver, () => ver);
}
let ver = 0;
subscribeUserPresets(() => ver++);

function group(list: Entry[]) {
  const m = new Map<string, Entry[]>();
  for (const e of list) m.set(e.category, [...(m.get(e.category) ?? []), e]);
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([c, l]) => [c, l.sort((a, b) => a.name.localeCompare(b.name))] as const);
}

function RenameRow({ entry, onDone }: { entry: Entry; onDone: () => void }) {
  const [v, setV] = useState(entry.name);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const commit = () => {
    if (v.trim() && v.trim() !== entry.name && entry.spec.kind === 'preset') void renameUserPreset(entry.spec.id, v.trim());
    onDone();
  };
  return (
    <input
      ref={ref}
      className="field lib-rename"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') onDone();
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Library panel: List (tree) / Icons / Details / Compact views
// ---------------------------------------------------------------------------

const VIEWS: { id: LibraryView; label: string; icon: string }[] = [
  { id: 'list', label: 'List', icon: 'application_side_tree' },
  { id: 'icons', label: 'Icons', icon: 'application_view_icons' },
  { id: 'details', label: 'Details', icon: 'application_view_detail' },
  { id: 'compact', label: 'Compact', icon: 'application_view_list' },
];

/** Input / output port names of an entry (Details view). */
function entryPorts(e: Entry): { inputs: string[]; outputs: string[] } {
  if (e.spec.kind === 'node') {
    const d = getNodeDef(e.spec.type);
    return { inputs: Object.keys(d?.inputs ?? {}), outputs: Object.keys(d?.outputs ?? { out: 1 }) };
  }
  const id = e.spec.id;
  const p = listPresets().find((x) => x.id === id);
  const nodes = p?.group.graph.nodes ?? [];
  const name = (n: (typeof nodes)[number], d: string) => String(n.params.name ?? d);
  return { inputs: nodes.filter((n) => n.type === GROUP_INPUT).map((n) => name(n, 'image')), outputs: nodes.filter((n) => n.type === GROUP_OUTPUT).map((n) => name(n, 'out')) };
}

const kindOf = (e: Entry) => (e.user ? 'My Preset' : e.spec.kind === 'preset' ? 'Preset' : 'Node');

type DetailCol = 'name' | 'category' | 'kind' | 'description' | 'inputs' | 'outputs';
const DETAIL_COLS: { id: DetailCol; label: string }[] = [
  { id: 'name', label: 'Name' },
  { id: 'category', label: 'Category' },
  { id: 'kind', label: 'Kind' },
  { id: 'description', label: 'Description' },
  { id: 'inputs', label: 'Inputs' },
  { id: 'outputs', label: 'Outputs' },
];

interface Section {
  id: string;
  title: string;
  icon: string;
  /** Category groups (empty for flat sections). */
  cats: (readonly [string, Entry[]])[];
  flat?: Entry[];
  empty?: string;
}

export function Library() {
  const { nodes, presets, all } = useAddEntries();
  useUserPresetsVersion();
  const favs = useSettings((s) => s.addFavorites);
  const recent = useSettings((s) => s.addRecent);
  const view = useSettings((s) => s.libraryView);
  const tile = useSettings((s) => s.libraryIconSize);
  const previews = useSettings((s) => s.libraryPreviews);
  const sort = useSettings((s) => s.librarySort);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [sel, setSel] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dsort, setDsort] = useState<{ col: DetailCol; desc: boolean }>({ col: 'name', desc: false });
  const scroller = useRef<HTMLDivElement>(null);
  const ctx = useContextMenu();
  const ql = q.trim().toLowerCase();

  const cats = useMemo(() => [...new Set([...nodes, ...presets].map((e) => e.category))].sort((a, b) => a.localeCompare(b)), [nodes, presets]);
  const rank = (e: Entry) => {
    const i = recent.indexOf(e.key);
    return i < 0 ? 1e6 : i;
  };
  const cmp = (a: Entry, b: Entry) =>
    sort === 'recent' ? rank(a) - rank(b) || a.name.localeCompare(b.name) : sort === 'category' ? a.category.localeCompare(b.category) || a.name.localeCompare(b.name) : a.name.localeCompare(b.name);
  const filt = (l: Entry[]) => l.filter((e) => (!cat || e.category === cat) && (!ql || matchEntry(e, ql) >= 0)).sort(cmp);
  const grouped = (l: Entry[]) => group(filt(l)).map(([c, list]) => [c, [...list].sort(cmp)] as const);
  const favList = favs.map((k) => all.get(k)).filter((e): e is Entry => !!e);
  const recentList = recent.map((k) => all.get(k)).filter((e): e is Entry => !!e);
  const sections: Section[] = [
    ...(favList.length ? [{ id: 'favs', title: 'Favorites', icon: 'star', cats: [], flat: filt(favList) }] : []),
    ...(sort === 'recent' && recentList.length ? [{ id: 'recent', title: 'Recently Used', icon: 'clock', cats: [], flat: filt(recentList) }] : []),
    { id: 'nodes', title: 'Nodes', icon: 'plugin', cats: grouped(nodes) },
    { id: 'presets', title: 'Presets', icon: 'bricks', cats: grouped(presets.filter((p) => !p.user)) },
    { id: 'mine', title: 'My Presets', icon: 'star', cats: grouped(presets.filter((p) => p.user)), empty: 'Select a group, then Node › Save as Preset…' },
  ];
  const toggle = (k: string) => setClosed((c) => ({ ...c, [k]: !c[k] }));
  const keyOf = (rid: string | null) => (rid ? rid.slice(rid.indexOf('|') + 1) : null);
  const selEntry = sel ? all.get(keyOf(sel)!) : undefined;
  const selThumb = selEntry?.spec.kind === 'preset' ? getUserPreset(selEntry.spec.id)?.thumb : undefined;

  // live previews (Icons view, optional): nodes in display order
  const previewTypes = useMemo(
    () => (view === 'icons' && previews ? filt(nodes).flatMap((e) => (e.spec.kind === 'node' && !skipPreview(e.spec.type) ? [e.spec.type] : [])) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view, previews, nodes, ql, cat, sort],
  );
  useNodeThumbs(previewTypes, view === 'icons' && previews);

  const add = (e: Entry) => {
    pushRecent(e.key);
    void addNode(e.spec, freeSpot(), undefined, { auto: true });
  };

  const entryMenu = (e: Entry): MenuItem[] => {
    const fav = favs.includes(e.key);
    const items: MenuItem[] = [
      { label: 'Add to Graph', icon: 'add', run: () => add(e) },
      { label: fav ? 'Remove from Favorites' : 'Add to Favorites', icon: 'star', run: () => toggleFavorite(e.key) },
    ];
    if (e.user && e.spec.kind === 'preset') {
      const id = e.spec.id;
      items.push(
        { sep: true },
        { label: 'Rename…', icon: 'textfield_rename', run: () => setRenaming(e.key) },
        { label: 'Export Preset…', icon: 'page_white_put', run: () => exportPreset(id) },
        { label: 'Delete Preset', icon: 'cross', run: () => void deletePreset(id) },
        { sep: true },
        { label: 'Import Presets…', icon: 'page_white_get', run: () => void importPresetFiles() },
      );
    }
    items.push(
      { sep: true },
      { label: 'View', icon: 'application_view_icons', submenu: () => VIEWS.map((v) => ({ label: v.label, icon: v.icon, checked: view === v.id, run: () => setPref('libraryView', v.id) })) },
    );
    return items;
  };

  /** Keyboard order of the rows on screen (filled while rendering). */
  const order: string[] = [];
  const rowProps = (e: Entry, rid: string) => {
    order.push(rid);
    return {
      'data-row': rid,
      title: e.description ? `${e.name}\n${e.description}` : e.name,
      draggable: renaming !== e.key,
      onDragStart: (ev: React.DragEvent) => {
        ev.dataTransfer.setData(DND_TYPE, JSON.stringify(e.spec));
        ev.dataTransfer.effectAllowed = 'copy';
      },
      onClick: () => setSel(rid),
      onDoubleClick: () => add(e),
      onContextMenu: (ev: React.MouseEvent) => {
        ev.preventDefault();
        setSel(rid);
        ctx.open(ev, entryMenu(e));
      },
    };
  };
  const star = (e: Entry) => (
    <button
      className={'lib-star' + (favs.includes(e.key) ? ' on' : '')}
      title={favs.includes(e.key) ? 'Remove from Favorites' : 'Add to Favorites'}
      onClick={(ev) => {
        ev.stopPropagation();
        toggleFavorite(e.key);
      }}
      onDoubleClick={(ev) => ev.stopPropagation()}
      tabIndex={-1}
    >
      <Icon name="star" />
    </button>
  );
  const label = (e: Entry, cls = 'lib-name') => (renaming === e.key ? <RenameRow entry={e} onDone={() => setRenaming(null)} /> : <span className={cls}>{e.name}</span>);
  const sectionCount = (s: Section) => (s.flat ? s.flat.length : s.cats.reduce((a, [, l]) => a + l.length, 0));
  const sectionHead = (s: Section, open: boolean) => (
    <div
      className="tree-row tree-section"
      onClick={() => toggle(s.id)}
      onContextMenu={(ev) => {
        if (s.id !== 'mine') return;
        ev.preventDefault();
        ctx.open(ev, [{ label: 'Import Presets…', icon: 'page_white_get', run: () => void importPresetFiles() }]);
      }}
    >
      <span className={'tree-toggle' + (open ? ' open' : '')} />
      <Icon name={s.icon} />
      <span>{s.title}</span>
      <span className="tree-count">{sectionCount(s)}</span>
    </div>
  );
  const emptyRow = (s: Section) => sectionCount(s) === 0 && <div className="tree-row tree-empty">{ql || cat ? 'No matches' : (s.empty ?? 'None registered')}</div>;
  const isOpen = (k: string) => !closed[k] || !!ql;

  // --- List: the classic tree -------------------------------------------------------------
  const listView = () =>
    sections.map((s) => {
      const open = isOpen(s.id);
      const leaf = (e: Entry) => {
        const rid = s.id + '|' + e.key;
        return (
          <div key={rid} className={'tree-row tree-leaf' + (sel === rid ? ' selected' : '')} {...rowProps(e, rid)}>
            <Icon name={e.icon} />
            {label(e)}
            {star(e)}
          </div>
        );
      };
      return (
        <div key={s.id} className="tree-root">
          {sectionHead(s, open)}
          {open && (
            <div className="tree-children">
              {emptyRow(s)}
              {s.flat?.map(leaf)}
              {s.cats.map(([c, list]) => {
                const ck = s.id + ':' + c;
                const copen = isOpen(ck);
                return (
                  <div key={ck}>
                    <div className="tree-row tree-cat" onClick={() => toggle(ck)}>
                      <span className={'tree-toggle' + (copen ? ' open' : '')} />
                      <Icon name={categoryIcon(c)} />
                      <span>{c}</span>
                    </div>
                    {copen && <div className="tree-children">{list.map(leaf)}</div>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      );
    });

  // --- Icons: grid of large icons / live previews under collapsible category headers -------
  const iconsView = () => {
    const tileEl = (s: Section, e: Entry) => {
      const rid = s.id + '|' + e.key;
      const thumb = previews && e.spec.kind === 'node' ? nodeThumb(e.spec.type) : e.spec.kind === 'preset' && e.user ? (getUserPreset(e.spec.id)?.thumb ?? null) : null;
      return (
        <div key={rid} className={'lib-tile' + (sel === rid ? ' selected' : '') + (favs.includes(e.key) ? ' fav' : '')} {...rowProps(e, rid)}>
          <span className={'lib-tile-img' + (thumb ? ' thumb' : '')}>{thumb ? <img src={thumb} alt="" draggable={false} /> : <Icon name={e.icon} size={32} />}</span>
          {label(e, 'lib-tile-name')}
          {star(e)}
        </div>
      );
    };
    return sections.map((s) => {
      const open = isOpen(s.id);
      return (
        <div key={s.id} className="lib-ic-section">
          {sectionHead(s, open)}
          {open && (
            <>
              {emptyRow(s)}
              {s.flat && s.flat.length > 0 && <div className="lib-grid">{s.flat.map((e) => tileEl(s, e))}</div>}
              {s.cats.map(([c, list]) => {
                const ck = s.id + ':' + c;
                const copen = isOpen(ck);
                return (
                  <div key={ck} className="lib-ic-group">
                    <div className="lib-ic-cat" onClick={() => toggle(ck)}>
                      <span className={'tree-toggle' + (copen ? ' open' : '')} />
                      <Icon name={categoryIcon(c)} />
                      <span className="lib-ic-cat-name">{c}</span>
                      <span className="tree-count">{list.length}</span>
                    </div>
                    {copen && <div className="lib-grid">{list.map((e) => tileEl(s, e))}</div>}
                  </div>
                );
              })}
            </>
          )}
        </div>
      );
    });
  };

  // --- Details: sortable table ------------------------------------------------------------
  const detailsView = () => {
    const rows = filt([...nodes, ...presets]);
    const val = (e: Entry, c: DetailCol): string => {
      if (c === 'name') return e.name;
      if (c === 'category') return e.category;
      if (c === 'kind') return kindOf(e);
      if (c === 'description') return e.description ?? '';
      const p = entryPorts(e);
      return (c === 'inputs' ? p.inputs : p.outputs).join(', ');
    };
    const sorted = [...rows].sort((a, b) => {
      const r = val(a, dsort.col).localeCompare(val(b, dsort.col), undefined, { numeric: true }) || a.name.localeCompare(b.name);
      return dsort.desc ? -r : r;
    });
    return (
      <table className="lib-details">
        <thead>
          <tr>
            <th className="lib-d-star" title="Favorite">
              <Icon name="star" />
            </th>
            {DETAIL_COLS.map((c) => (
              <th
                key={c.id}
                className={'lib-d-' + c.id + (dsort.col === c.id ? ' sorted' : '')}
                onClick={() => setDsort((d) => ({ col: c.id, desc: d.col === c.id ? !d.desc : false }))}
                title={`Sort by ${c.label}`}
              >
                {c.label}
                {dsort.col === c.id && <span className="lib-d-arrow">{dsort.desc ? '▼' : '▲'}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((e) => {
            const rid = 'all|' + e.key;
            const p = entryPorts(e);
            return (
              <tr key={rid} className={sel === rid ? 'selected' : ''} {...rowProps(e, rid)}>
                <td className="lib-d-star">{star(e)}</td>
                <td className="lib-d-name">
                  <Icon name={e.icon} />
                  {label(e)}
                </td>
                <td className="lib-d-category">{e.category}</td>
                <td className="lib-d-kind">{kindOf(e)}</td>
                <td className="lib-d-description">{e.description}</td>
                <td className="lib-d-inputs">{p.inputs.join(', ') || '—'}</td>
                <td className="lib-d-outputs">{p.outputs.join(', ') || '—'}</td>
              </tr>
            );
          })}
          {!sorted.length && (
            <tr>
              <td colSpan={7} className="tree-empty">
                No matches
              </td>
            </tr>
          )}
        </tbody>
      </table>
    );
  };

  // --- Compact: dense rows, no descriptions (flows into columns when wide) -----------------
  const compactView = () =>
    sections.map((s) => {
      const open = isOpen(s.id);
      const list = s.flat ?? s.cats.flatMap(([, l]) => l);
      let lastCat = '';
      return (
        <div key={s.id} className="lib-cp-section">
          {sectionHead(s, open)}
          {open && (
            <div className="lib-cp-cols">
              {emptyRow(s)}
              {list.map((e) => {
                const rid = s.id + '|' + e.key;
                const head = !s.flat && sort !== 'name' && sort !== 'recent' && e.category !== lastCat;
                lastCat = e.category;
                return (
                  <Fragment key={rid}>
                    {head && <div className="lib-cp-cat">{e.category}</div>}
                    <div className={'lib-cp-row' + (sel === rid ? ' selected' : '')} {...rowProps(e, rid)}>
                      <Icon name={e.icon} />
                      {label(e)}
                      {favs.includes(e.key) && <span className="lib-cp-fav">★</span>}
                    </div>
                  </Fragment>
                );
              })}
            </div>
          )}
        </div>
      );
    });

  const body = view === 'icons' ? iconsView() : view === 'details' ? detailsView() : view === 'compact' ? compactView() : listView();

  // keep the selection on screen
  useEffect(() => {
    if (!sel) return;
    scroller.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(sel)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [sel, view]);

  const onKey = (ev: React.KeyboardEvent) => {
    if ((ev.target as HTMLElement).tagName === 'INPUT') return;
    const k = ev.key;
    const i = sel ? order.indexOf(sel) : -1;
    let next: string | undefined;
    if (k === 'Enter' || k === ' ') {
      const e = keyOf(sel) && all.get(keyOf(sel)!);
      if (e && k === 'Enter') add(e);
      else if (e) toggleFavorite(e.key);
    } else if (k === 'Home') next = order[0];
    else if (k === 'End') next = order[order.length - 1];
    else if (k === 'PageDown' || k === 'PageUp') next = order[Math.max(0, Math.min(order.length - 1, i + (k === 'PageDown' ? 15 : -15)))];
    else if (view === 'icons' && (k === 'ArrowUp' || k === 'ArrowDown') && sel) {
      // geometric: the nearest tile in the row above / below
      const cur = scroller.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(sel)}"]`)?.getBoundingClientRect();
      if (cur) {
        const cx = cur.left + cur.width / 2;
        let best: [number, string] | null = null;
        for (const el of scroller.current!.querySelectorAll<HTMLElement>('[data-row]')) {
          const r = el.getBoundingClientRect();
          const dy = k === 'ArrowDown' ? r.top - cur.bottom : cur.top - r.bottom;
          if (dy < -2) continue;
          const score = dy * 4 + Math.abs(r.left + r.width / 2 - cx);
          if (!best || score < best[0]) best = [score, el.dataset.row!];
        }
        next = best?.[1];
      }
    } else if (k === 'ArrowDown' || (view === 'icons' && k === 'ArrowRight')) next = order[Math.min(order.length - 1, i + 1)];
    else if (k === 'ArrowUp' || (view === 'icons' && k === 'ArrowLeft')) next = order[Math.max(0, i - 1)];
    else if ((k === 'ArrowLeft' || k === 'ArrowRight') && view === 'list' && selEntry) {
      const sec = sel!.slice(0, sel!.indexOf('|'));
      if (!sections.find((s) => s.id === sec)?.flat) {
        const ck = sec + ':' + selEntry.category;
        if ((k === 'ArrowLeft') === isOpen(ck)) toggle(ck);
      }
    } else if (k === 'F2' && selEntry?.user) setRenaming(selEntry.key);
    else return;
    ev.preventDefault();
    ev.stopPropagation(); // not the graph / playback shortcuts
    if (next) setSel(next);
  };

  return (
    <Panel
      title="Node Library"
      icon="application_side_tree"
      className={'library lib-view-' + view}
      tools={
        <span className="lib-views" role="radiogroup" aria-label="Library view">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              role="radio"
              aria-checked={view === v.id}
              className={'tbtn small' + (view === v.id ? ' checked' : '')}
              title={`${v.label} view`}
              onClick={() => setPref('libraryView', v.id)}
              onMouseDown={(e) => e.preventDefault()}
              data-libview={v.id}
            >
              <Icon name={v.icon} />
            </button>
          ))}
        </span>
      }
    >
      <div className="lib-search">
        <Icon name="magnifier" />
        <input className="field" placeholder="Search nodes & presets" value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} onKeyDown={(e) => e.key === 'ArrowDown' && (e.preventDefault(), scroller.current?.focus(), setSel(order[0] ?? null))} />
        {q && (
          <button className="tbtn small" title="Clear" onClick={() => setQ('')}>
            <Icon name="cross" />
          </button>
        )}
      </div>
      <div className="lib-filter">
        <select className="field select" value={cat} onChange={(e) => setCat(e.target.value)} title="Show one category" data-libcat>
          <option value="">All categories</option>
          {cats.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select className="field select" value={sort} onChange={(e) => setPref('librarySort', e.target.value as LibrarySort)} title="Sort" data-libsort>
          <option value="category">By category</option>
          <option value="name">A–Z</option>
          <option value="recent">Recently used</option>
        </select>
      </div>
      <div className={'tree sunken lib-scroll lib-' + view} ref={scroller} tabIndex={0} onKeyDown={onKey} style={{ '--lib-tile': `${tile}px` } as React.CSSProperties}>
        {body}
      </div>
      <div className="lib-info">
        {selEntry ? (
          <>
            <div className="lib-info-title">
              <Icon name={selEntry.icon} /> {selEntry.name}
            </div>
            {selThumb && <img className="lib-info-thumb" src={selThumb} alt="" />}
            <div className="lib-info-desc">{selEntry.description || 'No description.'}</div>
            <div className="lib-info-meta">
              {kindOf(selEntry)} · {selEntry.category} · <code>{selEntry.key.slice(2)}</code>
            </div>
          </>
        ) : (
          <div className="lib-info-desc muted">Drag an item onto the Node Graph, or double-click (Enter) to add it. Click ☆ to favourite.</div>
        )}
      </div>
      {view === 'icons' && (
        <div className="lib-bottombar">
          <label className="lib-previews" title="Show each node applied to the current image (renders in the background; AI and model nodes keep their icon)">
            <input type="checkbox" checked={previews} onChange={(e) => setPref('libraryPreviews', e.target.checked)} data-libpreviews /> Previews
          </label>
          <span className="flex1" />
          <Icon name="application_view_tile" />
          <input
            type="range"
            className="lib-size"
            min={40}
            max={160}
            step={4}
            value={tile}
            onChange={(e) => setPref('libraryIconSize', +e.target.value)}
            title={`Thumbnail size: ${tile}px`}
            data-libsize
          />
          <Icon name="application_view_gallery" />
        </div>
      )}
      {ctx.el}
    </Panel>
  );
}
