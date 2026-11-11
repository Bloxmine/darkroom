/** Filter panel (Bridge's): facets with counts; ticking values filters the Content panel live. */
import { useEffect, useMemo, useState } from 'react';
import { countFacets, FACETS, hasFilters, type FacetId } from '../../core/files/facets';
import { LABELS } from '../../core/files/xmp';
import { Panel } from '../Chrome';
import { Icon } from '../Icon';
import * as A from './actions';
import { focusProps } from './common';
import { facetItems, useBrowser } from './store';

export function FilterPanel({ panelId }: { panelId: string }) {
  useEffect(() => void A.initBrowser(), []);
  const entries = useBrowser((s) => s.entries);
  const meta = useBrowser((s) => s.meta);
  const filters = useBrowser((s) => s.filters);
  const pending = useBrowser((s) => s.metaPending);
  const src = useBrowser((s) => s.source);
  const [closed, setClosed] = useState<Record<string, boolean>>({ lens: true, focal: true });
  const counts = useMemo(() => countFacets(facetItems({ entries, meta }), filters), [entries, meta, filters]);
  const toggle = (f: FacetId, v: string) =>
    useBrowser.setState((s) => {
      const cur = s.filters[f] ?? [];
      const next = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v];
      return { filters: { ...s.filters, [f]: next } };
    });
  const any = hasFilters(filters);
  return (
    <Panel
      title="Filter"
      icon="filter"
      className="br-panel"
      tools={
        <>
          <button className="tbtn small" title="Save as Smart Collection…" disabled={!any || src?.type === 'collection'} onClick={() => void A.saveSmartCollection()}>
            <Icon name="book_add" />
          </button>
          <button className="tbtn small" title="Clear Filter" disabled={!any} onClick={() => useBrowser.setState({ filters: {} })}>
            <Icon name="filter_delete" />
          </button>
        </>
      }
    >
      <div className="br-filter" {...focusProps(panelId)}>
        {!entries.some((e) => !e.dir) && <div className="br-hint muted">Open a folder to filter its items.</div>}
        {pending > 0 && (
          <div className="br-hint muted">
            <Icon name="hourglass" /> Reading metadata… ({pending} left)
          </div>
        )}
        {FACETS.map((f) => {
          const vals = counts[f.id];
          if (!vals?.length) return null;
          const open = !closed[f.id];
          const n = filters[f.id]?.length ?? 0;
          return (
            <div key={f.id} className="br-facet">
              <div className="br-section" onClick={() => setClosed((c) => ({ ...c, [f.id]: open }))}>
                {open ? '▾' : '▸'} {f.title}
                {n > 0 && <span className="br-facet-n"> ({n})</span>}
              </div>
              {open &&
                vals.map((v) => {
                  const on = !!filters[f.id]?.includes(v.value);
                  const lab = f.id === 'label' ? LABELS.find((l) => l.color === v.value) : undefined;
                  return (
                    <label key={v.value} className={'br-facet-row' + (on ? ' on' : '') + (v.count === 0 && !on ? ' zero' : '')}>
                      <input type="checkbox" checked={on} onChange={() => toggle(f.id, v.value)} />
                      {lab && <span className="br-label-chip" style={{ background: lab.css }} />}
                      <span className={'br-facet-label' + (f.id === 'rating' && /^[1-5]$/.test(v.value) ? ' stars' : '')}>{v.label}</span>
                      <span className="br-facet-count">{v.count}</span>
                    </label>
                  );
                })}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
