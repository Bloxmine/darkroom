import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { getUserPreset } from '../core/userPresets';
import { addNode } from '../store/actions';
import { useGraphUi } from '../store/graphUi';
import { useSettings } from '../store/settings';
import { useUi } from '../store/ui';
import { categoryIcon, Icon } from './Icon';
import { matchEntry, pushRecent, toggleFavorite, useAddEntries, useUserPresetsVersion, type Entry } from './Library';

/** Tab / right-click searchable "add node" popup. */
export function QuickAdd() {
  const qa = useUi((s) => s.quickAdd);
  if (!qa) return null;
  return <QuickAddInner key={`${qa.x},${qa.y}`} />;
}

interface Row {
  e: Entry;
  /** Section header shown above this row. */
  header?: string;
  headerIcon?: string;
  section: string;
}

function QuickAddInner() {
  const qa = useUi((s) => s.quickAdd)!;
  const ctx = useGraphUi((s) => s.qa);
  const { nodes, presets, all } = useAddEntries();
  useUserPresetsVersion();
  const favs = useSettings((s) => s.addFavorites);
  const recent = useSettings((s) => s.addRecent);
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: qa.x, top: qa.y });
  const close = () => {
    useUi.setState({ quickAdd: null });
    useGraphUi.setState({ qa: {} });
  };

  const rows = useMemo<Row[]>(() => {
    const ql = q.trim().toLowerCase();
    const list = [...nodes, ...presets];
    if (ql) {
      return list
        .map((e) => ({ e, s: matchEntry(e, ql) + (favs.includes(e.key) ? 40 : 0) + (recent.includes(e.key) ? 20 : 0) }))
        .filter((x) => x.s >= 0)
        .sort((a, b) => b.s - a.s || a.e.name.localeCompare(b.e.name))
        .map((x) => ({ e: x.e, section: 'r' }));
    }
    const out: Row[] = [];
    const add = (es: Entry[], section: string, title: string, icon: string) =>
      es.forEach((e, i) => out.push({ e, section, ...(i === 0 ? { header: title, headerIcon: icon } : {}) }));
    add(favs.map((k) => all.get(k)).filter((e): e is Entry => !!e), 'fav', 'Favorites', 'star');
    add(recent.map((k) => all.get(k)).filter((e): e is Entry => !!e), 'rec', 'Recent', 'clock');
    const sorted = list.sort((a, b) =>
      a.spec.kind === b.spec.kind ? a.category.localeCompare(b.category) || a.name.localeCompare(b.name) : a.spec.kind === 'node' ? -1 : 1,
    );
    let last = '';
    for (const e of sorted) {
      const cat = (e.spec.kind === 'preset' ? (e.user ? 'My Presets › ' : 'Presets › ') : '') + e.category;
      out.push({ e, section: 'all', ...(cat !== last ? { header: cat, headerIcon: e.user ? 'star' : categoryIcon(e.category) } : {}) });
      last = cat;
    }
    return out;
  }, [q, nodes, presets, all, favs, recent]);

  useLayoutEffect(() => {
    const r = boxRef.current?.getBoundingClientRect();
    if (!r) return;
    setPos({ left: Math.max(4, Math.min(qa.x, window.innerWidth - r.width - 4)), top: Math.max(4, Math.min(qa.y, window.innerHeight - r.height - 4)) });
  }, [qa.x, qa.y]);

  useEffect(() => {
    listRef.current?.querySelector('.qa-item.active')?.scrollIntoView({ block: 'nearest' });
  }, [idx]);

  useEffect(() => {
    const down = (e: MouseEvent) => !boxRef.current?.contains(e.target as Node) && close();
    window.addEventListener('mousedown', down);
    return () => window.removeEventListener('mousedown', down);
  }, []);

  const pick = (i: number) => {
    const r = rows[i];
    if (!r) return;
    close();
    pushRecent(r.e.key);
    addNode(r.e.spec, qa.flow, qa.from && { node: qa.from.node, port: qa.from.port, kind: qa.from.kind }, { auto: ctx.auto, edge: ctx.edge });
  };

  const cur = rows[idx]?.e;
  const thumb = cur?.spec.kind === 'preset' ? getUserPreset(cur.spec.id)?.thumb : undefined;
  const hint = ctx.edge ? 'Insert on wire' : qa.from ? 'Connect' : ctx.auto ? 'Add & connect to selection' : 'Add node';
  return (
    <div className="quickadd window" ref={boxRef} style={{ position: 'fixed', ...pos }} onMouseDown={(e) => e.stopPropagation()}>
      <div className="qa-head">
        <Icon name={ctx.edge ? 'connect' : 'add'} />
        <input
          autoFocus
          className="field"
          placeholder={`${hint} — type to search`}
          value={q}
          spellCheck={false}
          onChange={(e) => {
            setQ(e.target.value);
            setIdx(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') setIdx((i) => Math.min(rows.length - 1, i + 1));
            else if (e.key === 'ArrowUp') setIdx((i) => Math.max(0, i - 1));
            else if (e.key === 'PageDown') setIdx((i) => Math.min(rows.length - 1, i + 10));
            else if (e.key === 'PageUp') setIdx((i) => Math.max(0, i - 10));
            else if (e.key === 'Enter') pick(idx);
            else if (e.key === 'Escape' || e.key === 'Tab') close();
            else if (e.key === 's' && (e.metaKey || e.ctrlKey) && cur) toggleFavorite(cur.key);
            else return;
            e.preventDefault();
          }}
        />
      </div>
      <div className="qa-list sunken" ref={listRef}>
        {rows.length === 0 && <div className="qa-empty">No matching nodes</div>}
        {rows.map((r, i) => {
          const fav = favs.includes(r.e.key);
          return (
            <div key={r.section + r.e.key}>
              {r.header && (
                <div className="qa-cat">
                  {r.headerIcon && <Icon name={r.headerIcon} />} {r.header}
                </div>
              )}
              <div className={'qa-item' + (i === idx ? ' active' : '')} onMouseEnter={() => setIdx(i)} onClick={() => pick(i)}>
                <Icon name={r.e.icon} />
                <span className="qa-text">
                  <span className="qa-name">{r.e.name}</span>
                  {r.e.description && <span className="qa-desc">{r.e.description}</span>}
                </span>
                {r.section !== 'all' && (
                  <span className="qa-meta" title={r.e.category}>
                    <Icon name={r.e.user ? 'star' : categoryIcon(r.e.category)} /> {r.e.category}
                  </span>
                )}
                <button
                  className={'qa-star' + (fav ? ' on' : '')}
                  title={fav ? 'Remove from Favorites (⌘/Ctrl+S)' : 'Add to Favorites (⌘/Ctrl+S)'}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleFavorite(r.e.key);
                  }}
                >
                  <Icon name="star" />
                </button>
              </div>
            </div>
          );
        })}
      </div>
      <div className="qa-foot">
        {thumb && <img className="qa-thumb" src={thumb} alt="" />}
        <span>{cur?.description ?? ' '}</span>
      </div>
    </div>
  );
}
