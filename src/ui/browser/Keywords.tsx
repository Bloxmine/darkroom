/** Keywords panel: a hierarchical keyword list with checkboxes that apply keywords to the selection (written to dc:subject / lr:hierarchicalSubject). */
import { useEffect, useState } from 'react';
import { Panel } from '../Chrome';
import { Icon } from '../Icon';
import { useContextMenu } from '../Menu';
import * as A from './actions';
import { focusProps } from './common';
import { useBrowser, type KeywordNode } from './store';

function useSelectionKeywords() {
  const sel = useBrowser((s) => s.selection);
  const entries = useBrowser((s) => s.entries);
  const meta = useBrowser((s) => s.meta);
  const files = sel.filter((p) => !entries.find((e) => e.path === p)?.dir);
  return { files, lists: files.map((p) => meta[p]?.xmp.keywords ?? []) };
}

function KwRow({ node, parent, depth, filter, sel, onMenu, current, setCurrent }: { node: KeywordNode; parent: string | null; depth: number; filter: string; sel: { files: string[]; lists: string[][] }; onMenu: (e: React.MouseEvent, path: string) => void; current: string | null; setCurrent: (p: string) => void }) {
  const path = parent ? `${parent}|${node.name}` : node.name;
  const [open, setOpen] = useState(true);
  const match = (n: KeywordNode): boolean => n.name.toLowerCase().includes(filter) || !!n.children?.some(match);
  if (filter && !match(node)) return null;
  const n = sel.lists.filter((l) => A.hasKeyword(l, path)).length;
  const state = !sel.files.length || n === 0 ? 'off' : n === sel.files.length ? 'on' : 'some';
  const isCategory = !!node.children?.length;
  return (
    <>
      <div className={'br-kw-row' + (current === path ? ' selected' : '')} style={{ paddingLeft: 4 + depth * 14 }} onClick={() => setCurrent(path)} onContextMenu={(e) => onMenu(e, path)} title={path.split('|').join(' › ')}>
        <span className={'br-twisty' + (isCategory ? '' : ' empty')} onClick={(e) => (e.stopPropagation(), setOpen(!open))}>
          {isCategory ? (open ? '▾' : '▸') : ''}
        </span>
        <input
          type="checkbox"
          checked={state === 'on'}
          ref={(el) => {
            if (el) el.indeterminate = state === 'some';
          }}
          disabled={!sel.files.length}
          onClick={(e) => e.stopPropagation()}
          onChange={() => A.setKeyword(sel.files, path, state !== 'on')}
        />
        <span className={'br-kw-name' + (isCategory ? ' category' : '')}>{node.name}</span>
        {n > 0 && sel.files.length > 1 && <span className="br-kw-count">{n}</span>}
      </div>
      {open && node.children?.map((c) => <KwRow key={c.name} node={c} parent={path} depth={depth + 1} filter={filter} sel={sel} onMenu={onMenu} current={current} setCurrent={setCurrent} />)}
    </>
  );
}

export function KeywordsPanel({ panelId }: { panelId: string }) {
  useEffect(() => void A.initBrowser(), []);
  const keywords = useBrowser((s) => s.keywords);
  const sel = useSelectionKeywords();
  const [filter, setFilter] = useState('');
  const [current, setCurrent] = useState<string | null>(null);
  const menu = useContextMenu();
  // keywords on the selected files that aren't in the list (Bridge's "Other Keywords")
  const known = new Set<string>();
  const walk = (ns: KeywordNode[], parent: string | null) =>
    ns.forEach((n) => {
      const p = parent ? `${parent}|${n.name}` : n.name;
      known.add(p);
      known.add(n.name);
      if (n.children) walk(n.children, p);
    });
  walk(keywords, null);
  const other = [...new Set(sel.lists.flat())].filter((k) => !known.has(k) && !known.has(k.split('|').pop()!)).sort();
  const onMenu = (e: React.MouseEvent, path: string) => {
    e.preventDefault();
    e.stopPropagation();
    setCurrent(path);
    menu.open(e, [
      { label: 'New Keyword', icon: 'add', run: () => void A.addKeyword(path.includes('|') ? path.slice(0, path.lastIndexOf('|')) : null) },
      { label: 'New Sub Keyword', icon: 'key_add', run: () => void A.addKeyword(path) },
      { label: 'Rename', icon: 'textfield_rename', run: () => void A.renameKeyword(path) },
      { label: 'Delete', icon: 'delete', run: () => void A.deleteKeyword(path) },
      { sep: true },
      { label: 'Apply to Selection', icon: 'tick', run: () => A.setKeyword(sel.files, path, true), disabled: !sel.files.length },
      { label: 'Remove from Selection', icon: 'cross', run: () => A.setKeyword(sel.files, path, false), disabled: !sel.files.length },
    ]);
  };
  return (
    <Panel title="Keywords" icon="key" className="br-panel">
      <div className="br-keywords" {...focusProps(panelId)}>
        <div className="br-kw-assigned">
          {sel.files.length ? (
            <>
              <span className="muted">Assigned:</span> {[...new Set(sel.lists.flat().map((k) => k.split('|').pop()))].join(', ') || <span className="muted">none</span>}
            </>
          ) : (
            <span className="muted">Select files to apply keywords.</span>
          )}
        </div>
        <div className="br-kw-list">
          {keywords.map((k) => (
            <KwRow key={k.name} node={k} parent={null} depth={0} filter={filter.toLowerCase()} sel={sel} onMenu={onMenu} current={current} setCurrent={setCurrent} />
          ))}
          {other.length > 0 && (
            <>
              <div className="br-section">Other Keywords (on the selection)</div>
              {other.map((k) => (
                <KwRow key={k} node={{ name: k }} parent={null} depth={0} filter={filter.toLowerCase()} sel={sel} onMenu={(e) => e.preventDefault()} current={current} setCurrent={setCurrent} />
              ))}
            </>
          )}
        </div>
        <div className="br-kw-bar">
          <input className="br-search" placeholder="Find keyword" value={filter} onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          <button className="tbtn small" title="New Keyword" onClick={() => void A.addKeyword(current?.includes('|') ? current.slice(0, current.lastIndexOf('|')) : null)}>
            <Icon name="add" />
          </button>
          <button className="tbtn small" title="New Sub Keyword" disabled={!current} onClick={() => current && void A.addKeyword(current)}>
            <Icon name="key_add" />
          </button>
          <button className="tbtn small" title="Delete Keyword" disabled={!current} onClick={() => current && void A.deleteKeyword(current)}>
            <Icon name="delete" />
          </button>
        </div>
      </div>
      {menu.el}
    </Panel>
  );
}
