import { useEffect, useMemo, useRef, useState } from 'react';
import { clearDiag, closeDiagnostics, diagText, dismissToast, openDiagnostics, useDiag, type DiagEvent, type Level } from '../../core/diag';
import { getNodeDef } from '../../core/registry';
import * as A from '../../store/actions';
import { setSelection } from '../../store/doc';
import { setPref, useSettings } from '../../store/settings';
import { status } from '../../store/ui';
import { Icon } from '../Icon';
import './diagnostics.css';

const LEVEL_ICON: Record<Level, string> = { error: 'exclamation', warn: 'error', info: 'information', debug: 'bullet_white' };

/** Notifications + the Diagnostics window (Window › Diagnostics). Mounted once in main.tsx. */
export function DiagnosticsHost() {
  const open = useDiag((s) => s.open);
  return (
    <>
      <Toasts />
      {open && <DiagnosticsWindow />}
    </>
  );
}

const nodeLabel = (e: DiagEvent) => (e.nodeType ? (getNodeDef(e.nodeType)?.name ?? e.nodeType) : '');

/** Reveal a node from a log entry: view it, and select its top-level node. */
function revealNode(id: string) {
  A.viewNode(id);
  setSelection([id.split('/')[0]]);
}

function Toasts() {
  const toasts = useDiag((s) => s.toasts);
  useEffect(() => {
    if (!toasts.length) return;
    // errors stay 15 s, warnings 10 s (hovering a toast keeps it: it is re-added on mouse leave)
    const timers = toasts.map((t) => setTimeout(() => dismissToast(t.id), t.level === 'error' ? 15000 : 10000));
    return () => timers.forEach(clearTimeout);
  }, [toasts]);
  if (!toasts.length) return null;
  return (
    <div className="diag-toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={'diag-toast ' + t.level}>
          <Icon name={LEVEL_ICON[t.level]} />
          <div className="diag-toast-body">
            <div className="diag-toast-title">
              {t.level === 'error' ? 'Error' : 'Warning'}
              {t.nodeType ? ` in ${nodeLabel(t)}` : t.source !== 'app' ? ` (${t.source})` : ''}
            </div>
            <div className="diag-toast-msg">{t.message.replace(/^[\w.]+: /, '')}</div>
            <div className="diag-toast-actions">
              {t.nodeId && (
                <button className="btn" onClick={() => revealNode(t.nodeId!)}>
                  Show Node
                </button>
              )}
              <button className="btn" onClick={() => (openDiagnostics(t.id), dismissToast(t.id))}>
                Details…
              </button>
            </div>
          </div>
          <button className="diag-toast-close" onClick={() => dismissToast(t.id)} title="Dismiss">
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

function DiagnosticsWindow() {
  const events = useDiag((s) => s.events);
  const focus = useDiag((s) => s.focus);
  const verboseOn = useSettings((s) => s.verboseDiagnostics);
  const [levels, setLevels] = useState<Record<Level, boolean>>({ error: true, warn: true, info: true, debug: true });
  const [source, setSource] = useState('all');
  const [query, setQuery] = useState('');
  const [follow, setFollow] = useState(true);
  const [expanded, setExpanded] = useState<number | null>(focus);
  const [off, setOff] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const list = useRef<HTMLDivElement>(null);

  const sources = useMemo(() => [...new Set(events.map((e) => e.source))].sort(), [events]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return events.filter(
      (e) =>
        levels[e.level] &&
        (source === 'all' || e.source === source) &&
        (!q || `${e.message} ${e.detail ?? ''} ${e.nodeType ?? ''} ${e.nodeId ?? ''}`.toLowerCase().includes(q)),
    );
  }, [events, levels, source, query]);
  const counts = useMemo(() => {
    const c = { error: 0, warn: 0, info: 0, debug: 0 } as Record<Level, number>;
    for (const e of events) c[e.level] += e.count;
    return c;
  }, [events]);

  useEffect(() => {
    if (follow && list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [shown, follow]);
  useEffect(() => {
    if (focus == null) return;
    setExpanded(focus);
    list.current?.querySelector(`[data-ev="${focus}"]`)?.scrollIntoView({ block: 'center' });
  }, [focus]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && closeDiagnostics();
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

  const save = () => {
    const blob = new Blob([diagText(shown)], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `darkroom-diagnostics-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.log`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  return (
    <div className="diag-win window" style={{ transform: `translate(${off.x}px, ${off.y}px)` }} role="dialog" aria-label="Diagnostics">
      <div
        className="titlebar"
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, ox: off.x, oy: off.y };
        }}
        onPointerMove={(e) => drag.current && setOff({ x: drag.current.ox + e.clientX - drag.current.x, y: drag.current.oy + e.clientY - drag.current.y })}
        onPointerUp={() => (drag.current = null)}
      >
        <Icon name="bug" />
        <span className="titlebar-text">Diagnostics</span>
        <button className="titlebar-close" onClick={closeDiagnostics} title="Close (Esc)" onPointerDown={(e) => e.stopPropagation()}>
          ✕
        </button>
      </div>
      <div className="diag-toolbar">
        {(['error', 'warn', 'info', 'debug'] as Level[]).map((l) => (
          <label key={l} className={'diag-lvl ' + l} title={l === 'debug' ? 'Verbose entries (renders, jobs, downloads)' : undefined}>
            <input type="checkbox" checked={levels[l]} onChange={(e) => setLevels({ ...levels, [l]: e.target.checked })} />
            <Icon name={LEVEL_ICON[l]} /> {({ error: 'Errors', warn: 'Warnings', info: 'Info', debug: 'Verbose' } as const)[l]} <span className="diag-count">{counts[l]}</span>
          </label>
        ))}
        <select value={source} onChange={(e) => setSource(e.target.value)} title="Source">
          <option value="all">All sources</option>
          {sources.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <input className="diag-search" type="search" placeholder="Filter…" value={query} onChange={(e) => setQuery(e.target.value)} spellCheck={false} />
      </div>
      <div className="diag-list" ref={list} onScroll={(e) => setFollow(e.currentTarget.scrollHeight - e.currentTarget.scrollTop - e.currentTarget.clientHeight < 24)}>
        {shown.length === 0 ? (
          <div className="diag-empty">{events.length ? 'Nothing matches the filters.' : verboseOn ? 'No events yet.' : 'No errors or warnings. Turn on Verbose to see every render and AI job.'}</div>
        ) : (
          shown.map((e) => (
            <div key={e.id} data-ev={e.id} className={'diag-row ' + e.level + (expanded === e.id ? ' open' : '') + (focus === e.id ? ' focus' : '')} onClick={() => setExpanded(expanded === e.id ? null : e.id)}>
              <span className="diag-time">{new Date(e.last).toLocaleTimeString([], { hour12: false })}</span>
              <Icon name={LEVEL_ICON[e.level]} />
              <span className="diag-src">{e.source}</span>
              <span className="diag-msg">
                {e.message}
                {e.count > 1 && <span className="diag-rep">×{e.count}</span>}
                {e.nodeId && (
                  <button
                    className="diag-node"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      revealNode(e.nodeId!);
                    }}
                    title="View this node"
                  >
                    {nodeLabel(e) || e.nodeId}
                  </button>
                )}
                {expanded === e.id && e.detail && <pre className="diag-detail">{e.detail}</pre>}
              </span>
            </div>
          ))
        )}
      </div>
      <div className="diag-foot">
        <label title="Log every render, AI job, model download and helper message (Preferences › Advanced)">
          <input type="checkbox" checked={verboseOn} onChange={(e) => setPref('verboseDiagnostics', e.target.checked)} /> Verbose
        </label>
        <span className="grow" />
        <button
          className="btn"
          onClick={() =>
            void navigator.clipboard.writeText(diagText(shown)).then(
              () => status('Diagnostics copied to the clipboard.'),
              () => status('Could not copy to the clipboard.', 'error'),
            )
          }
        >
          <Icon name="page_copy" /> Copy
        </button>
        <button className="btn" onClick={save}>
          <Icon name="diskette" /> Save Log…
        </button>
        <button className="btn" onClick={clearDiag}>
          <Icon name="bin_empty" /> Clear
        </button>
      </div>
    </div>
  );
}
