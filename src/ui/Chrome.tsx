import { useRef, type ReactNode } from 'react';
import { openDiagnostics } from '../core/diag';
import { flattenGraph } from '../core/graph';
import { effectiveViewed, useDoc } from '../store/doc';
import { useUi } from '../store/ui';
import { Icon } from './Icon';

/** A panel with a bevelled title bar. */
export function Panel({
  title,
  icon,
  tools,
  children,
  className,
}: {
  title: ReactNode;
  icon?: string;
  tools?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={'panel' + (className ? ' ' + className : '')}>
      <header className="panel-title">
        {icon && <Icon name={icon} />}
        <span className="panel-title-text">{title}</span>
        <span className="panel-title-tools">{tools}</span>
      </header>
      <div className="panel-body">{children}</div>
    </section>
  );
}

/** Drag handle between panes. `onDrag` receives the pointer delta in CSS px since drag start. */
export function Splitter({ dir, onDrag, onStart }: { dir: 'h' | 'v'; onStart: () => void; onDrag: (delta: number) => void }) {
  const start = useRef(0);
  return (
    <div
      className={'splitter splitter-' + dir}
      onPointerDown={(e) => {
        e.preventDefault();
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        start.current = dir === 'v' ? e.clientX : e.clientY;
        onStart();
        document.body.classList.add(dir === 'v' ? 'resizing-v' : 'resizing-h');
      }}
      onPointerMove={(e) => {
        if (!(e.target as HTMLElement).hasPointerCapture(e.pointerId)) return;
        onDrag((dir === 'v' ? e.clientX : e.clientY) - start.current);
      }}
      onPointerUp={(e) => {
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
        document.body.classList.remove('resizing-v', 'resizing-h');
      }}
    >
      <span className="splitter-grip" />
    </div>
  );
}

export function StatusBar() {
  const ui = useUi((s) => s);
  const nodeCount = useDoc((s) => flattenGraph(s.project.graph).nodes.length);
  const levelCount = useDoc((s) => s.path.length);
  const dirty = useDoc((s) => s.dirty);
  const viewed = useDoc((s) => effectiveViewed(s));
  const errCount = Object.keys(ui.errors).length;
  const zoomPct = Math.round(ui.zoom * 100 * 10) / 10;
  return (
    <footer className="statusbar">
      <span className={'sb-pane sb-msg' + (ui.messageKind === 'error' ? ' sb-error' : '')}>
        {ui.messageKind === 'error' ? <Icon name="error" /> : <Icon name={ui.pending.length ? 'hourglass' : 'information'} />}
        {ui.pending.length ? `Loading… (${ui.pending.length})` : ui.message}
      </span>
      {errCount > 0 && (
        <span className="sb-pane sb-error sb-click" onClick={() => openDiagnostics()} title={'Click to open Diagnostics\n\n' + Object.entries(ui.errors).map(([k, v]) => `${k}: ${v}`).join('\n\n')}>
          <Icon name="exclamation" />
          {errCount} error{errCount > 1 ? 's' : ''}
        </span>
      )}
      <span className="sb-pane" title="Last viewer render that recomputed nodes: CPU time to evaluate the graph and submit GPU work, and how many nodes were re-rendered (cached frames are free)">
        <Icon name="clock" />
        {ui.renderMs.toFixed(1)} ms · {ui.renderNodes} node{ui.renderNodes === 1 ? '' : 's'}
      </span>
      <span className="sb-pane" title="Full resolution of the viewed node">
        <Icon name="image" />
        {ui.fullWidth} × {ui.fullHeight}
      </span>
      <span className="sb-pane" title={`Preview render: ${ui.renderWidth} × ${ui.renderHeight}`}>
        <Icon name="layer_resize" />
        Preview {Math.round(ui.renderScale * 1000) / 10}%
      </span>
      <span className="sb-pane" title="Viewer zoom (100% = one image pixel per screen pixel)">
        <Icon name="magnifier" />
        {zoomPct}%
      </span>
      <span className="sb-pane" title={`Viewing ${viewed ?? '—'}`}>
        <Icon name="node_magnifier" />
        {nodeCount} nodes{levelCount ? ` · depth ${levelCount}` : ''}
      </span>
      <span className="sb-pane sb-dirty" title={dirty ? 'Unsaved changes (autosaved to this browser)' : 'Saved'}>
        {dirty ? 'MOD' : ''}
      </span>
      <span className="sb-grip" />
    </footer>
  );
}
