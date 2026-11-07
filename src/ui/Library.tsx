import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { GROUP_INPUT, GROUP_OUTPUT } from '../core/graph';
import { matchSearchable } from '../core/graphLayout';
import { listNodeDefs, listPresets } from '../core/registry';
import { getUserPreset, isUserPreset, renameUserPreset, subscribeUserPresets } from '../core/userPresets';
import { addNode, freeSpot, type AddSpec } from '../store/actions';
import { useDoc } from '../store/doc';
import { deletePreset, exportPreset, importPresetFiles } from '../store/presets';
import { setPref, useSettings } from '../store/settings';
import { Panel } from './Chrome';
import { categoryIcon, Icon, nodeIcon } from './Icon';
import { useContextMenu, type MenuItem } from './Menu';
import { useRegistry } from './useRegistry';

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
      icon: isUserPreset(p.id) ? 'star' : 'bricks',
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

export function Library() {
  const { nodes, presets, all } = useAddEntries();
  useUserPresetsVersion();
  const favs = useSettings((s) => s.addFavorites);
  const [q, setQ] = useState('');
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [sel, setSel] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const ctx = useContextMenu();
  const ql = q.trim().toLowerCase();
  const filt = (l: Entry[]) => (ql ? l.filter((e) => matchEntry(e, ql) >= 0) : l);
  const favList = favs.map((k) => all.get(k)).filter((e): e is Entry => !!e);
  const sections: { id: string; title: string; icon: string; cats: ReturnType<typeof group>; flat?: Entry[]; empty?: string }[] = [
    ...(favList.length ? [{ id: 'favs', title: 'Favorites', icon: 'star', cats: [], flat: filt(favList) }] : []),
    { id: 'nodes', title: 'Nodes', icon: 'plugin', cats: group(filt(nodes)) },
    { id: 'presets', title: 'Presets', icon: 'bricks', cats: group(filt(presets.filter((p) => !p.user))) },
    {
      id: 'mine',
      title: 'My Presets',
      icon: 'star',
      cats: group(filt(presets.filter((p) => p.user))),
      empty: 'Select a group, then Node › Save as Preset…',
    },
  ];
  const toggle = (k: string) => setClosed((c) => ({ ...c, [k]: !c[k] }));
  const selEntry = sel ? all.get(sel) : undefined;
  const selThumb = selEntry?.spec.kind === 'preset' ? getUserPreset(selEntry.spec.id)?.thumb : undefined;

  const entryMenu = (e: Entry): MenuItem[] => {
    const fav = favs.includes(e.key);
    const items: MenuItem[] = [
      { label: 'Add to Graph', icon: 'add', run: () => void addNode(e.spec, freeSpot(), undefined, { auto: true }) },
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
    return items;
  };

  const leaf = (e: Entry, keyPrefix = '') => (
    <div
      key={keyPrefix + e.key}
      className={'tree-row tree-leaf' + (sel === e.key ? ' selected' : '')}
      title={e.description}
      draggable={renaming !== e.key}
      onDragStart={(ev) => {
        ev.dataTransfer.setData(DND_TYPE, JSON.stringify(e.spec));
        ev.dataTransfer.effectAllowed = 'copy';
      }}
      onClick={() => setSel(e.key)}
      onDoubleClick={() => addNode(e.spec, freeSpot(), undefined, { auto: true })}
      onContextMenu={(ev) => {
        ev.preventDefault();
        setSel(e.key);
        ctx.open(ev, entryMenu(e));
      }}
    >
      <Icon name={e.icon} />
      {renaming === e.key ? <RenameRow entry={e} onDone={() => setRenaming(null)} /> : <span className="lib-name">{e.name}</span>}
      <button
        className={'lib-star' + (favs.includes(e.key) ? ' on' : '')}
        title={favs.includes(e.key) ? 'Remove from Favorites' : 'Add to Favorites'}
        onClick={(ev) => {
          ev.stopPropagation();
          toggleFavorite(e.key);
        }}
        onDoubleClick={(ev) => ev.stopPropagation()}
      >
        <Icon name="star" />
      </button>
    </div>
  );

  return (
    <Panel title="Node Library" icon="application_side_tree" className="library">
      <div className="lib-search">
        <Icon name="magnifier" />
        <input className="field" placeholder="Search nodes & presets" value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} />
        {q && (
          <button className="tbtn small" title="Clear" onClick={() => setQ('')}>
            <Icon name="cross" />
          </button>
        )}
      </div>
      <div className="tree sunken">
        {sections.map((s) => {
          const open = !closed[s.id] || !!ql;
          const count = s.flat ? s.flat.length : s.cats.reduce((a, [, l]) => a + l.length, 0);
          return (
            <div key={s.id} className="tree-root">
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
                <span className="tree-count">{count}</span>
              </div>
              {open && (
                <div className="tree-children">
                  {count === 0 && <div className="tree-row tree-empty">{ql ? 'No matches' : (s.empty ?? 'None registered')}</div>}
                  {s.flat?.map((e) => leaf(e, 'fav:'))}
                  {s.cats.map(([cat, list]) => {
                    const ck = s.id + ':' + cat;
                    const copen = !closed[ck] || !!ql;
                    return (
                      <div key={ck}>
                        <div className="tree-row tree-cat" onClick={() => toggle(ck)}>
                          <span className={'tree-toggle' + (copen ? ' open' : '')} />
                          <Icon name={categoryIcon(cat)} />
                          <span>{cat}</span>
                        </div>
                        {copen && <div className="tree-children">{list.map((e) => leaf(e))}</div>}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
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
              {selEntry.user ? 'My Preset' : selEntry.spec.kind === 'preset' ? 'Preset' : 'Node'} · <code>{selEntry.key.slice(2)}</code>
            </div>
          </>
        ) : (
          <div className="lib-info-desc muted">Drag an item onto the Node Graph, or double-click to add it. Click ☆ to favourite.</div>
        )}
      </div>
      {ctx.el}
    </Panel>
  );
}
