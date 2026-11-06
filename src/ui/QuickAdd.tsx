import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { addNode } from '../store/actions';
import { useUi } from '../store/ui';
import { Icon } from './Icon';
import { matchEntry, useAddEntries } from './Library';

/** Tab / right-click searchable "add node" popup. */
export function QuickAdd() {
  const qa = useUi((s) => s.quickAdd);
  if (!qa) return null;
  return <QuickAddInner key={`${qa.x},${qa.y}`} />;
}

function QuickAddInner() {
  const qa = useUi((s) => s.quickAdd)!;
  const { nodes, presets } = useAddEntries();
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: qa.x, top: qa.y });
  const close = () => useUi.setState({ quickAdd: null });

  const items = useMemo(() => {
    const ql = q.trim().toLowerCase();
    const all = [...nodes, ...presets];
    if (!ql) return all.sort((a, b) => (a.spec.kind === b.spec.kind ? a.category.localeCompare(b.category) || a.name.localeCompare(b.name) : a.spec.kind === 'node' ? -1 : 1));
    return all
      .map((e) => ({ e, s: matchEntry(e, ql) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s || a.e.name.localeCompare(b.e.name))
      .map((x) => x.e);
  }, [q, nodes, presets]);

  useLayoutEffect(() => {
    const r = boxRef.current?.getBoundingClientRect();
    if (!r) return;
    setPos({ left: Math.min(qa.x, window.innerWidth - r.width - 4), top: Math.min(qa.y, window.innerHeight - r.height - 4) });
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
    const e = items[i];
    if (!e) return;
    close();
    addNode(e.spec, qa.flow, qa.from && { node: qa.from.node, port: qa.from.port, kind: qa.from.kind });
  };

  const catOf = (i: number) => (items[i] ? items[i].category + items[i].spec.kind : '');
  return (
    <div className="quickadd window" ref={boxRef} style={{ position: 'fixed', ...pos }} onMouseDown={(e) => e.stopPropagation()}>
      <div className="qa-head">
        <Icon name="add" />
        <input
          autoFocus
          className="field"
          placeholder="Add node — type to search"
          value={q}
          spellCheck={false}
          onChange={(e) => {
            setQ(e.target.value);
            setIdx(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') setIdx((i) => Math.min(items.length - 1, i + 1));
            else if (e.key === 'ArrowUp') setIdx((i) => Math.max(0, i - 1));
            else if (e.key === 'Enter') pick(idx);
            else if (e.key === 'Escape' || e.key === 'Tab') close();
            else return;
            e.preventDefault();
          }}
        />
      </div>
      <div className="qa-list sunken" ref={listRef}>
        {items.length === 0 && <div className="qa-empty">No matching nodes</div>}
        {items.map((e, i) => {
          const header = !q.trim() && catOf(i) !== catOf(i - 1) ? (e.spec.kind === 'preset' ? `Presets › ${e.category}` : e.category) : null;
          return (
            <div key={e.key}>
              {header && <div className="qa-cat">{header}</div>}
              <div className={'qa-item' + (i === idx ? ' active' : '')} title={e.description} onMouseEnter={() => setIdx(i)} onClick={() => pick(i)}>
                <Icon name={e.icon} />
                <span className="qa-name">{e.name}</span>
                <span className="qa-meta">{q.trim() ? (e.spec.kind === 'preset' ? 'Preset · ' : '') + e.category : ''}</span>
              </div>
            </div>
          );
        })}
      </div>
      <div className="qa-foot">{items[idx]?.description ?? ' '}</div>
    </div>
  );
}
