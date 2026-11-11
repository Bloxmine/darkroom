/** Preferences › Keyboard: searchable command table with recordable, persisted shortcut overrides. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { setPref, useSettings } from '../../store/settings';
import { commands, defaultKeys, displayKeys } from '../commands';
import { Button, Note } from './controls';
import { comboFromEvent, recording } from './keys';

const CATEGORY: Record<string, string> = {
  file: 'File',
  edit: 'Edit',
  view: 'View',
  node: 'Node',
  playback: 'Playback',
  window: 'Window',
  help: 'Help',
};
const ORDER = ['File', 'Edit', 'View', 'View › Theme', 'Node', 'Playback', 'Window', 'Help'];
const catRank = (c: string) => (ORDER.includes(c) ? ORDER.indexOf(c) : ORDER.length);

/** Order-insensitive form of a combo for conflict detection. */
const norm = (c: string) => {
  const parts = c.split('+');
  const key = parts.pop() || '+';
  return [...parts.sort(), key.toUpperCase()].join('+');
};

interface RowData {
  id: string;
  label: string;
  icon?: string;
  cat: string;
  keys: string;
  modified: boolean;
}

export function KeyboardPane() {
  const overrides = useSettings((s) => s.keyOverrides);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const [rec, setRec] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);

  const rows: RowData[] = useMemo(
    () =>
      Object.values(commands)
        .map((c) => ({
          id: c.id,
          label: c.label.replace('…', ''),
          icon: c.icon,
          cat: c.id.startsWith('view.theme.') ? 'View › Theme' : (CATEGORY[c.id.split('.')[0]] ?? 'Other'),
          keys: c.keys ?? '',
          modified: c.id in overrides,
        }))
        .sort((a, b) => catRank(a.cat) - catRank(b.cat) || a.cat.localeCompare(b.cat) || a.label.localeCompare(b.label)),
    [overrides],
  );

  const conflicts = useMemo(() => {
    const by = new Map<string, string[]>();
    for (const r of rows) for (const k of r.keys.split('|').filter(Boolean)) by.set(norm(k), [...(by.get(norm(k)) ?? []), r.id]);
    const out = new Map<string, string[]>();
    for (const ids of by.values()) if (ids.length > 1) for (const id of ids) out.set(id, [...(out.get(id) ?? []), ...ids.filter((x) => x !== id)]);
    return out;
  }, [rows]);

  const assign = (id: string, combo: string | null) => {
    const next = { ...useSettings.getState().keyOverrides };
    if (combo === null || combo === (defaultKeys[id] ?? '')) delete next[id];
    else next[id] = combo;
    setPref('keyOverrides', next);
  };

  // record: the next non-modifier key press becomes the shortcut (Esc cancels)
  useEffect(() => {
    recording.active = !!rec;
    if (!rec) return;
    const kd = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) return setRec(null);
      const c = comboFromEvent(e);
      if (!c) return;
      assign(rec, c);
      setRec(null);
    };
    window.addEventListener('keydown', kd, true);
    return () => {
      window.removeEventListener('keydown', kd, true);
      recording.active = false;
    };
  }, [rec]);

  const ql = q.trim().toLowerCase();
  const shown = ql ? rows.filter((r) => (r.label + ' ' + r.cat + ' ' + displayKeys(r.keys) + ' ' + r.keys).toLowerCase().includes(ql)) : rows;
  const selRow = rows.find((r) => r.id === sel);
  const selConf = sel ? conflicts.get(sel) : undefined;
  const nameOf = (id: string) => commands[id]?.label.replace('…', '') ?? id;

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
        <Note>Click a shortcut, then press the new key combination. Esc cancels.</Note>
        <span style={{ flex: 1 }} />
        <span className="slp-search">
          <input placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search commands" />
        </span>
      </div>
      <div className="slp-table-wrap" style={{ height: 270 }} ref={wrap}>
        <table className="slp-table">
          <colgroup>
            <col />
            <col style={{ width: 110 }} />
            <col style={{ width: 150 }} />
          </colgroup>
          <thead>
            <tr>
              <th>Command</th>
              <th>Menu</th>
              <th>Shortcut</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr className="empty">
                <td colSpan={3}>No commands match “{q}”</td>
              </tr>
            )}
            {shown.map((r) => (
              <tr
                key={r.id}
                data-cmd={r.id}
                className={(sel === r.id ? 'sel ' : '') + (conflicts.has(r.id) ? 'conflict' : '')}
                onMouseDown={() => setSel(r.id)}
                onDoubleClick={() => setRec(r.id)}
                title={conflicts.has(r.id) ? `Also used by: ${conflicts.get(r.id)!.map(nameOf).join(', ')}` : undefined}
              >
                <td>
                  {r.icon ? <img src={`/icons/fatcow/16x16/${r.icon}.png`} alt="" /> : <span style={{ display: 'inline-block', width: 21 }} />}
                  <span className={r.modified ? 'modified' : ''}>{r.label}</span>
                </td>
                <td>{r.cat}</td>
                <td
                  className="slp-key shortcut-cell"
                  onClick={() => {
                    setSel(r.id);
                    setRec(r.id);
                  }}
                >
                  {rec === r.id ? (
                    <span className="slp-recording">Type shortcut…</span>
                  ) : (
                    <>
                      {conflicts.has(r.id) && '⚠ '}
                      {r.keys
                        .split('|')
                        .filter(Boolean)
                        .map((k) => displayKeys(k))
                        .join(', ') || <span style={{ opacity: 0.45 }}>none</span>}
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="slp-foot" style={{ marginTop: 8 }}>
        <Button disabled={!selRow} onClick={() => sel && setRec(sel)}>
          Record…
        </Button>
        <Button disabled={!selRow || !selRow.keys} onClick={() => sel && assign(sel, '')}>
          Clear
        </Button>
        <Button disabled={!selRow?.modified} onClick={() => sel && assign(sel, null)}>
          Reset
        </Button>
        <span className="grow" />
        {selConf ? (
          <span className="slp-error">⚠ Same shortcut as {selConf.map(nameOf).join(', ')}</span>
        ) : (
          <Note>{Object.keys(overrides).length ? `${Object.keys(overrides).length} customized` : 'All shortcuts are at their defaults'}</Note>
        )}
      </div>
    </>
  );
}
