import { useEffect, useRef, useState } from 'react';
import { GROUP } from '../core/graph';
import { nodeName } from '../store/actions';
import { effectiveViewed, outputNodeId, useDoc } from '../store/doc';
import { compareSource, engine, engineError, imageRect, requestRender, viewerCanvas } from '../store/engine';
import { graphAt } from '../store/graphPath';
import { themeMeta, useSettings } from '../store/settings';
import { QUALITY_LABELS, useUi, type Quality } from '../store/ui';
import { Panel } from './Chrome';
import { Icon } from './Icon';
import { ToolButton } from './Toolbar';
import { AnimateButton, Transport } from './Transport';
import { zoomViewer } from './viewerApi';
import { ViewerToolOverlay } from './viewerTools/ViewerToolOverlay';

function useViewedName() {
  const key = useDoc((s) => {
    const id = effectiveViewed(s);
    if (!id) return '(nothing)\u0000';
    const parts = id.split('/');
    const names: string[] = [];
    let g = s.project.graph;
    for (const p of parts) {
      const n = g.nodes.find((x) => x.id === p);
      if (!n) break;
      names.push(nodeName(n));
      if (n.type === GROUP && n.group) g = n.group.graph;
    }
    return (names[names.length - 1] ?? id) + '\u0000' + names.slice(0, -1).join(' › ');
  });
  const [name, path] = key.split('\u0000');
  return { name, path };
}

// The viewer clear colour follows the UI theme. store/engine.ts passes a fixed
// background to Engine.present(), so substitute the theme's colour here.
if (engine) {
  const present = engine.present.bind(engine);
  engine.present = (tex, opts) => present(tex, { ...opts, background: themeMeta().viewerBg });
  useSettings.subscribe((s, p) => s.theme !== p.theme && requestRender());
}

const ZOOMS = [0.125, 0.25, 0.5, 1, 2, 4, 8];

export function Viewer() {
  const host = useRef<HTMLDivElement>(null);
  const ui = useUi();
  const viewed = useViewedName();
  const isOutput = useDoc((s) => effectiveViewed(s) === outputNodeId(s.project));
  const compareName = useDoc((s) => {
    if (!ui.compare) return '';
    const t = effectiveViewed(s);
    const src = t && compareSource(s.project.graph, t);
    if (!src) return '';
    const parts = src.split('/');
    const n = graphAt(s.project.graph, parts.slice(0, -1))?.nodes.find((x) => x.id === parts[parts.length - 1]);
    return n ? nodeName(n) : src;
  });
  const [spaceDown, setSpaceDown] = useState(false);
  const drag = useRef<{ kind: 'pan' | 'split'; x: number; y: number; px: number; py: number } | null>(null);

  // adopt the engine canvas & keep its backing store in sync with the panel size
  useEffect(() => {
    const el = host.current!;
    el.prepend(viewerCanvas);
    const ro = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(el.clientWidth * dpr));
      const h = Math.max(1, Math.round(el.clientHeight * dpr));
      if (viewerCanvas.width !== w || viewerCanvas.height !== h) {
        viewerCanvas.width = w;
        viewerCanvas.height = h;
      }
      requestRender();
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      viewerCanvas.remove();
    };
  }, []);

  useEffect(() => {
    const kd = (e: KeyboardEvent) => e.code === 'Space' && !(e.target as HTMLElement)?.closest?.('input,textarea') && setSpaceDown(true);
    const ku = (e: KeyboardEvent) => e.code === 'Space' && setSpaceDown(false);
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    return () => {
      window.removeEventListener('keydown', kd);
      window.removeEventListener('keyup', ku);
    };
  }, []);

  // wheel zoom must be non-passive
  useEffect(() => {
    const el = host.current!;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
      zoomViewer(factor, { x: (e.clientX - r.left) * dpr, y: (e.clientY - r.top) * dpr });
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    const el = host.current!;
    el.setPointerCapture(e.pointerId);
    const r = el.getBoundingClientRect();
    const onSplit = ui.compare && Math.abs(e.clientX - r.left - ui.split * r.width) < 6 && !spaceDown && e.button === 0;
    const dpr = window.devicePixelRatio || 1;
    drag.current = { kind: onSplit ? 'split' : 'pan', x: e.clientX, y: e.clientY, px: ui.fit ? 0 : ui.panX / dpr, py: ui.fit ? 0 : ui.panY / dpr };
    e.preventDefault();
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const r = host.current!.getBoundingClientRect();
    if (d.kind === 'split') {
      useUi.setState({ split: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) });
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    if (useUi.getState().fit) {
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 3) return;
      // freeze the fitted view so panning starts from it
      useUi.setState({ fit: false, zoom: imageRect().zoom, panX: 0, panY: 0 });
    }
    useUi.setState({ panX: (d.px + e.clientX - d.x) * dpr, panY: (d.py + e.clientY - d.y) * dpr });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    drag.current = null;
    host.current?.releasePointerCapture(e.pointerId);
  };

  const zoomPct = Math.round(ui.zoom * 1000) / 10;
  return (
    <Panel
      title={
        <>
          Viewer — <b>{viewed.name}</b>
          {viewed.path && <span className="muted"> (in {viewed.path})</span>}
          {!isOutput && <span className="viewer-badge">node preview</span>}
        </>
      }
      icon="monitor"
      className="viewer-panel"
    >
      <div className="viewer-toolbar">
        <ToolButton id="view.fitImage" />
        <ToolButton id="view.actual" />
        <ToolButton id="view.zoomOut" />
        <select
          className="field select zoom-select"
          value=""
          onChange={(e) => {
            const v = e.target.value;
            if (v === 'fit') useUi.setState({ fit: true, panX: 0, panY: 0 });
            else if (v) useUi.setState({ fit: false, zoom: +v, panX: 0, panY: 0 });
          }}
          title="Zoom"
        >
          <option value="">{ui.fit ? `Fit (${zoomPct}%)` : `${zoomPct}%`}</option>
          <option value="fit">Fit to window</option>
          {ZOOMS.map((z) => (
            <option key={z} value={z}>
              {z * 100}%
            </option>
          ))}
        </select>
        <ToolButton id="view.zoomIn" />
        <span className="tsep" />
        <ToolButton id="view.compare" />
        <AnimateButton />
        {ui.compare && <span className="muted small compare-label">A: {compareName || '—'} │ B: {viewed.name}</span>}
        <span className="tsep" />
        <label className="tb-label" title="Preview render resolution. Export always renders at full resolution.">
          <Icon name="layer_resize" /> Preview
          <select className="field select" value={ui.quality} onChange={(e) => useUi.setState({ quality: e.target.value as Quality })}>
            {(Object.keys(QUALITY_LABELS) as Quality[]).map((q) => (
              <option key={q} value={q}>
                {QUALITY_LABELS[q]}
              </option>
            ))}
          </select>
        </label>
        <span className="flex1" />
        <ToolButton id="node.viewOutput" />
        <span className="muted small viewer-res">
          {ui.fullWidth}×{ui.fullHeight} @ {Math.round(ui.renderScale * 100)}%
        </span>
      </div>
      <div
        className={'viewer-host' + (spaceDown ? ' grab' : '')}
        ref={host}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={() => useUi.setState({ fit: true, panX: 0, panY: 0 })}
      >
        {ui.compare && (
          <div className="split-line" style={{ left: `${ui.split * 100}%` }}>
            <span className="split-tag a">A</span>
            <span className="split-tag b">B</span>
          </div>
        )}
        <ViewerToolOverlay host={host} spaceDown={spaceDown} />
        {engineError && (
          <div className="viewer-error">
            <Icon name="error" /> WebGL2 is not available: {engineError}
          </div>
        )}
      </div>
      <Transport />
    </Panel>
  );
}
