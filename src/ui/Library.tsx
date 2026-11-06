import { useMemo, useState } from 'react';
import { GROUP_INPUT, GROUP_OUTPUT } from '../core/graph';
import { listNodeDefs, listPresets } from '../core/registry';
import { addNode, freeSpot, type AddSpec } from '../store/actions';
import { useDoc } from '../store/doc';
import { Panel } from './Chrome';
import { categoryIcon, Icon, nodeIcon } from './Icon';
import { useRegistry } from './useRegistry';

export const DND_TYPE = 'application/x-darkroom-add';

interface Entry {
  key: string;
  spec: AddSpec;
  name: string;
  category: string;
  description?: string;
  tags?: string[];
  icon: string;
}

/** All addable entries (nodes + presets) for the current editing context. */
export function useAddEntries(): { nodes: Entry[]; presets: Entry[] } {
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
      icon: 'bricks',
    }));
    return { nodes, presets };
  }, [v, inGroup]);
}

export function matchEntry(e: Entry, q: string) {
  if (!q) return 0;
  const n = e.name.toLowerCase();
  if (n.startsWith(q)) return 3;
  if (n.includes(q)) return 2;
  const hay = [e.category, ...(e.tags ?? []), e.description ?? '', e.key].join(' ').toLowerCase();
  return q.split(/\s+/).every((w) => hay.includes(w) || n.includes(w)) ? 1 : -1;
}

function group(list: Entry[]) {
  const m = new Map<string, Entry[]>();
  for (const e of list) m.set(e.category, [...(m.get(e.category) ?? []), e]);
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([c, l]) => [c, l.sort((a, b) => a.name.localeCompare(b.name))] as const);
}

export function Library() {
  const { nodes, presets } = useAddEntries();
  const [q, setQ] = useState('');
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [sel, setSel] = useState<string | null>(null);
  const ql = q.trim().toLowerCase();
  const filt = (l: Entry[]) => (ql ? l.filter((e) => matchEntry(e, ql) >= 0) : l);
  const sections: { id: string; title: string; icon: string; cats: ReturnType<typeof group> }[] = [
    { id: 'nodes', title: 'Nodes', icon: 'plugin', cats: group(filt(nodes)) },
    { id: 'presets', title: 'Presets', icon: 'star', cats: group(filt(presets)) },
  ];
  const toggle = (k: string) => setClosed((c) => ({ ...c, [k]: !c[k] }));
  const selEntry = [...nodes, ...presets].find((e) => e.key === sel);

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
          return (
            <div key={s.id} className="tree-root">
              <div className="tree-row tree-section" onClick={() => toggle(s.id)}>
                <span className={'tree-toggle' + (open ? ' open' : '')} />
                <Icon name={s.icon} />
                <span>{s.title}</span>
                <span className="tree-count">{s.cats.reduce((a, [, l]) => a + l.length, 0)}</span>
              </div>
              {open && (
                <div className="tree-children">
                  {s.cats.length === 0 && <div className="tree-row tree-empty">{ql ? 'No matches' : 'None registered'}</div>}
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
                        {copen && (
                          <div className="tree-children">
                            {list.map((e) => (
                              <div
                                key={e.key}
                                className={'tree-row tree-leaf' + (sel === e.key ? ' selected' : '')}
                                title={e.description}
                                draggable
                                onDragStart={(ev) => {
                                  ev.dataTransfer.setData(DND_TYPE, JSON.stringify(e.spec));
                                  ev.dataTransfer.effectAllowed = 'copy';
                                }}
                                onClick={() => setSel(e.key)}
                                onDoubleClick={() => addNode(e.spec, freeSpot())}
                              >
                                <Icon name={e.icon} />
                                <span>{e.name}</span>
                              </div>
                            ))}
                          </div>
                        )}
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
            <div className="lib-info-desc">{selEntry.description || 'No description.'}</div>
            <div className="lib-info-meta">
              {selEntry.spec.kind === 'preset' ? 'Preset' : 'Node'} · <code>{selEntry.key.slice(2)}</code>
            </div>
          </>
        ) : (
          <div className="lib-info-desc muted">Drag an item onto the Node Graph, or double-click to add it.</div>
        )}
      </div>
    </Panel>
  );
}
