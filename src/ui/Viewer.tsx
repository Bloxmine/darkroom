import { useEffect, useRef, useState } from 'react';
import { splitHit } from '../core/scopes';
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
import { ContextMenu, type MenuItem } from './Menu';
import { addSampler, CHANNELS, useViewer } from '../store/viewer';
import { useSpace } from './viewer/spaceKey';
import { channelMenuItems, compareMenuItems, fillViewer } from './viewer/viewerCommands';
import { setHover } from './viewer/pixels';
import { EyedropLayer, ReadoutChip, SamplerMarkers, SplitHandle } from './viewer/ViewerOverlays';
import { ScopesDock, ScopesFloat } from './viewer/Scopes';
import { PresetBrowser } from './viewer/PresetBrowser';
import './viewer/viewerPro.css';

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

const ZOOMS = [0.125, 0.25, 0.5, 1, 2, 4, 8, 16];

/** A toolbar button that drops down a menu. */
function MenuButton({ icon, label, title, items, checked }: { icon?: string; label?: React.ReactNode; title: string; items: () => MenuItem[]; checked?: boolean }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  return (
    <>
      <button
        className={'tbtn vx-menubtn' + (checked ? ' checked' : '') + (at ? ' open' : '')}
        title={title}
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          setAt(at ? null : { x: r.left, y: r.bottom + 1 });
        }}
      >
        {icon && <Icon name={icon} />}
        {label && <span className="vx-menubtn-label">{label}</span>}
        <span className="vx-caret">▾</span>
      </button>
      {at && <ContextMenu x={at.x} y={at.y} items={items()} onClose={() => setAt(null)} />}
    </>
  );
}

/** Name of the compare reference image for the labels. */
function useReferenceName(compareOn: boolean) {
  const ref = useViewer((s) => s.compareRef);
  const pinned = useViewer((s) => s.pinned);
  const snap = useViewer((s) => s.snapshot);
  const hold = useViewer((s) => s.hold);
  const src = useDoc((s) => {
    if (!compareOn && !hold) return '';
    const t = effectiveViewed(s);
    const src = t && compareSource(s.project.graph, t);
    if (!src) return '';
    const parts = src.split('/');
    const n = graphAt(s.project.graph, parts.slice(0, -1))?.nodes.find((x) => x.id === parts[parts.length - 1]);
    return n ? nodeName(n) : src;
  });
  if (ref === 'snapshot' && snap) return `Snapshot ${snap.name}`;
  if (ref === 'pinned' && pinned) return `Pinned: ${pinned.name}`;
  return src;
}

export function Viewer() {
  const host = useRef<HTMLDivElement>(null);
  const ui = useUi();
  const viewed = useViewedName();
  const isOutput = useDoc((s) => effectiveViewed(s) === outputNodeId(s.project));
  const compareName = useReferenceName(ui.compare);
  const spaceDown = useSpace((s) => s.down);
  const vw = useViewer();
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

  // pixel readout: track the pointer even over overlays (capture phase)
  useEffect(() => {
    const el = host.current!;
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      setHover({ x: e.clientX - r.left, y: e.clientY - r.top });
    };
    const leave = () => setHover(null);
    el.addEventListener('pointermove', move, true);
    el.addEventListener('pointerleave', leave);
    return () => {
      el.removeEventListener('pointermove', move, true);
      el.removeEventListener('pointerleave', leave);
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
    // preventDefault below suppresses the mousedown focus change: leave any text field explicitly
    const ae = document.activeElement as HTMLElement | null;
    if (ae && ae !== document.body && ae.matches?.('input,textarea,select,[contenteditable]')) ae.blur();
    const el = host.current!;
    el.setPointerCapture(e.pointerId);
    const r = el.getBoundingClientRect();
    const v = useViewer.getState();
    const lx = e.clientX - r.left;
    const ly = e.clientY - r.top;
    // Shift-click: drop a colour sampler (up to 4)
    if (e.shiftKey && e.button === 0 && !spaceDown) {
      const ir = imageRect();
      const dpr = window.devicePixelRatio || 1;
      const u = (lx * dpr - ir.x) / ir.w;
      const w = (ly * dpr - ir.y) / ir.h;
      if (u >= 0 && u <= 1 && w >= 0 && w <= 1) {
        if (!addSampler(u, w)) useUi.setState({ message: 'Up to 4 colour samplers — Alt-click one to remove it.', messageKind: 'info' });
        e.preventDefault();
        return;
      }
    }
    const onSplit = ui.compare && !spaceDown && e.button === 0 && splitHit(lx, ly, v.compareMode, v.compareMode === 'v' ? v.splitY : ui.split, r.width, r.height);
    const dpr = window.devicePixelRatio || 1;
    drag.current = { kind: onSplit ? 'split' : 'pan', x: e.clientX, y: e.clientY, px: ui.fit ? 0 : ui.panX / dpr, py: ui.fit ? 0 : ui.panY / dpr };
    e.preventDefault();
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const r = host.current!.getBoundingClientRect();
    if (d.kind === 'split') {
      if (useViewer.getState().compareMode === 'v') useViewer.setState({ splitY: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) });
      else useUi.setState({ split: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) });
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
        <ToolButton id="view.fill" />
        <ToolButton id="view.zoomOut" />
        <select
          className="field select zoom-select"
          value=""
          onChange={(e) => {
            const v = e.target.value;
            if (v === 'fit') useUi.setState({ fit: true, panX: 0, panY: 0 });
            else if (v === 'fill') fillViewer();
            else if (v) useUi.setState({ fit: false, zoom: +v, panX: 0, panY: 0 });
          }}
          title="Zoom"
        >
          <option value="">{ui.fit ? `Fit (${zoomPct}%)` : `${zoomPct}%`}</option>
          <option value="fit">Fit to window</option>
          <option value="fill">Fill window</option>
          {ZOOMS.map((z) => (
            <option key={z} value={z}>
              {z * 100}%
            </option>
          ))}
        </select>
        <ToolButton id="view.zoomIn" />
        <span className="tsep" />
        <ToolButton id="view.compare" />
        <MenuButton title="Compare: layout, swap, reference (source / pinned node / snapshot)" items={compareMenuItems} />
        <ToolButton id="view.snapshot" />
        <AnimateButton />
        <span className="tsep" />
        <MenuButton
          icon="layer_rgb"
          label={vw.channel === 'rgb' ? 'RGB' : vw.channel === 'luma' ? 'Luma' : vw.channel.toUpperCase()}
          title={'Channel view: ' + (CHANNELS.find((c) => c.id === vw.channel)?.label ?? '') + ' (⌥0–⌥5)'}
          checked={vw.channel !== 'rgb'}
          items={channelMenuItems}
        />
        <ToolButton id="view.clip" />
        <ToolButton id="view.readout" />
        <ToolButton id="view.scopes" />
        <ToolButton id="view.presetBrowser" />
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
      <div className="vx-main">
        <div
          className={'viewer-host' + (spaceDown ? ' grab' : '') + (vw.eyedrop ? ' eyedrop' : '')}
          ref={host}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onDoubleClick={() => useUi.setState({ fit: true, panX: 0, panY: 0 })}
        >
          <SplitHandle refName={compareName} mainName={viewed.name} />
          <ViewerToolOverlay host={host} spaceDown={spaceDown} />
          <SamplerMarkers />
          <EyedropLayer />
          <ReadoutChip />
          {vw.channel !== 'rgb' && <div className="vx-flag vx-flag-channel">{CHANNELS.find((c) => c.id === vw.channel)?.label}</div>}
          {vw.clip && <div className="vx-flag vx-flag-clip">Clipping</div>}
          {engineError && (
            <div className="viewer-error">
              <Icon name="error" /> WebGL2 is not available: {engineError}
            </div>
          )}
        </div>
        <ScopesDock />
      </div>
      <ScopesFloat />
      <PresetBrowser />
      <Transport />
    </Panel>
  );
}
