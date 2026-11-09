/**
 * Interactive viewer overlay for nodes with a `viewerTool` (points / brush / box). Maps screen ↔
 * normalised image coordinates (0..1, top-left origin), edits the node's params through setParam
 * (undoable; a stroke or drag is one undo step), draws the points/box/brush cursor, a translucent
 * preview of the node's mask output, and a small floating HUD. Styled with theme tokens only.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ParamValue } from '../../core/types';
import { useDoc } from '../../store/doc';
import { afterRender, engine, imageRect } from '../../store/engine';
import { useUi } from '../../store/ui';
import { boxJson, parseBox, parsePoints, parseStrokes, pointsJson, strokesJson, type Box, type Stroke, type ToolPoint } from './data';
import { beginGesture, editParam, endGesture, resolveTool, useToolUi, type ActiveTool } from './tool';
import './viewerTools.css';

type Drag =
  | { kind: 'move'; idx: number }
  | { kind: 'press'; x: number; y: number; cx: number; cy: number; label: number }
  | { kind: 'box'; x: number; y: number }
  | { kind: 'stroke'; strokes: Stroke[]; cur: Stroke }
  | null;

const HIT = 9; // css px

/** Automation handle: normalised image point → client (CSS px) coordinates in the viewer. */
(globalThis as Record<string, unknown>).__darkroomViewerTools = {
  toClient(x: number, y: number) {
    const host = document.querySelector('.viewer-host');
    if (!host) return null;
    const b = host.getBoundingClientRect();
    const r = imageRect();
    const dpr = window.devicePixelRatio || 1;
    return { x: b.left + (r.x + x * r.w) / dpr, y: b.top + (r.y + y * r.h) / dpr };
  },
  ui: useToolUi,
};

export function ViewerToolOverlay({ host, spaceDown }: { host: React.RefObject<HTMLDivElement | null>; spaceDown: boolean }) {
  const selection = useDoc((s) => s.selection);
  const path = useDoc((s) => s.path);
  const graph = useDoc((s) => s.project.graph);
  const tool = useMemo(() => resolveTool(useDoc.getState()), [selection, path, graph]);
  const doneFor = useToolUi((s) => s.doneFor);
  // re-show a dismissed tool when the selection changes
  useEffect(() => {
    if (useToolUi.getState().doneFor && tool?.flat !== useToolUi.getState().doneFor) useToolUi.setState({ doneFor: null });
  }, [tool?.flat]);
  if (!tool) return null;
  if (doneFor === tool.flat)
    return (
      <button className="btn vt-reopen" onClick={() => useToolUi.setState({ doneFor: null })} title="Show the viewer tool again">
        ✎ {tool.name}
      </button>
    );
  return <ToolLayer tool={tool} host={host} spaceDown={spaceDown} />;
}

/** Re-render on view changes; returns the image rect in CSS px relative to the host. */
function useImageRect(host: React.RefObject<HTMLDivElement | null>) {
  useUi((s) => s.fit);
  useUi((s) => s.zoom);
  useUi((s) => s.panX);
  useUi((s) => s.panY);
  useUi((s) => s.fullWidth);
  useUi((s) => s.fullHeight);
  const [, bump] = useState(0);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const ro = new ResizeObserver(() => bump((n) => n + 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, [host]);
  const r = imageRect();
  const dpr = window.devicePixelRatio || 1;
  return { x: r.x / dpr, y: r.y / dpr, w: r.w / dpr, h: r.h / dpr, fullW: r.fullW, fullH: r.fullH, zoom: r.zoom / dpr };
}

function ToolLayer({ tool, host, spaceDown }: { tool: ActiveTool; host: React.RefObject<HTMLDivElement | null>; spaceDown: boolean }) {
  const ui = useToolUi();
  const rect = useImageRect(host);
  const layer = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag>(null);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const [boxDraft, setBoxDraft] = useState<Box | null>(null);
  const [mods, setMods] = useState({ shift: false, alt: false });
  const raf = useRef(0);
  const pending = useUi((s) => s.pending.some((p) => p === tool.flat || tool.flat.startsWith(p + '/') || p.startsWith(tool.flat + '/')));
  const { def } = tool;

  const points = def.kind === 'points' && !def.vec2Param && !tool.handles ? parsePoints(tool.values.param) : [];
  const vec2 = !tool.handles && def.vec2Param && Array.isArray(tool.values.vec2) ? (tool.values.vec2 as number[]) : null;
  // multi-handle tool: the enabled handles, with their index in tool.handles
  const handles = (tool.handles ?? []).map((h, i) => ({ ...h, i })).filter((h) => h.on && h.value);
  const activeIdx = handles.some((h) => h.i === ui.activeHandle) ? ui.activeHandle : (handles[0]?.i ?? 0);
  const shownPoints: ToolPoint[] = tool.handles ? handles.map((h) => ({ x: h.value![0], y: h.value![1], label: 1 })) : vec2 ? [{ x: vec2[0], y: vec2[1], label: 1 }] : points;
  const box = boxDraft ?? (def.kind === 'box' ? parseBox(tool.values.param) : def.boxParam ? parseBox(tool.values.box) : null);

  // modifier keys (mode display) and brush shortcuts
  useEffect(() => {
    const typing = (e: KeyboardEvent) => !!(e.target as HTMLElement)?.closest?.('input,textarea,select,[contenteditable]');
    const kd = (e: KeyboardEvent) => {
      setMods({ shift: e.shiftKey, alt: e.altKey });
      if (typing(e) || def.kind !== 'brush' || e.metaKey || e.ctrlKey) return;
      const s = useToolUi.getState();
      if (e.key === '[') useToolUi.setState({ brushSize: Math.max(2, Math.round(s.brushSize / 1.2)) });
      else if (e.key === ']') useToolUi.setState({ brushSize: Math.min(1000, Math.round(s.brushSize * 1.2)) });
      else if (e.key === 'x' || e.key === 'X') useToolUi.setState({ erase: !s.erase });
    };
    const ku = (e: KeyboardEvent) => setMods({ shift: e.shiftKey, alt: e.altKey });
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    return () => {
      window.removeEventListener('keydown', kd);
      window.removeEventListener('keyup', ku);
    };
  }, [def.kind]);

  const norm = (e: { clientX: number; clientY: number }) => {
    const r = layer.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left - rect.x) / rect.w, y: (e.clientY - r.top - rect.y) / rect.h, cx: e.clientX - r.left, cy: e.clientY - r.top };
  };
  const toCss = (p: { x: number; y: number }) => ({ x: rect.x + p.x * rect.w, y: rect.y + p.y * rect.h });
  const hitPoint = (cx: number, cy: number) => {
    let best = -1, bd = HIT;
    shownPoints.forEach((p, i) => {
      const c = toCss(p);
      const d = Math.hypot(c.x - cx, c.y - cy);
      if (d <= bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  };
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const label = (e: { shiftKey: boolean; altKey: boolean }) => (e.altKey ? 0 : e.shiftKey ? 1 : ui.pointMode);

  const writePoints = (pts: ToolPoint[]) => {
    if (tool.handles) {
      // one moved handle: pts[k] belongs to handles[k] (shown order)
      pts.forEach((p, k) => {
        const h = handles[k];
        if (h && (p.x !== h.value![0] || p.y !== h.value![1])) editParam(tool.nodeId, h.key, [Math.round(clamp(p.x) * 1e4) / 1e4, Math.round(clamp(p.y) * 1e4) / 1e4]);
      });
    } else if (vec2 && tool.keys.vec2) {
      const p = pts[0];
      if (p) editParam(tool.nodeId, tool.keys.vec2, [Math.round(clamp(p.x) * 1e4) / 1e4, Math.round(clamp(p.y) * 1e4) / 1e4]);
    } else if (tool.keys.param) editParam(tool.nodeId, tool.keys.param, pointsJson(pts));
  };
  const writeBox = (b: Box | null) => {
    const key = def.kind === 'box' ? tool.keys.param : tool.keys.box;
    if (key) editParam(tool.nodeId, key, boxJson(b));
  };
  const writeStrokes = (s: Stroke[]) => tool.keys.param && editParam(tool.nodeId, tool.keys.param, strokesJson(s));

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || spaceDown) return; // middle button / space: let the viewer pan
    e.stopPropagation();
    e.preventDefault();
    layer.current!.setPointerCapture(e.pointerId);
    const p = norm(e);
    beginGesture();
    if (def.kind === 'brush') {
      const fullH = rect.fullH || 1;
      const cur: Stroke = { r: ui.brushSize / 2 / fullH, h: ui.brushHardness, p: [clamp(p.x), clamp(p.y)], ...(ui.erase ? { e: 1 } : {}) };
      const strokes = [...parseStrokes(tool.values.param), cur];
      drag.current = { kind: 'stroke', strokes, cur };
      writeStrokes(strokes);
      return;
    }
    if (def.kind === 'box') {
      drag.current = { kind: 'box', x: p.x, y: p.y };
      return;
    }
    const hit = hitPoint(p.cx, p.cy);
    if (tool.handles) {
      // drag a handle, or move the selected handle to the click and drag it from there
      const k = hit >= 0 ? hit : handles.findIndex((h) => h.i === activeIdx);
      if (k < 0) return;
      useToolUi.setState({ activeHandle: handles[k].i });
      if (hit < 0) writePoints(shownPoints.map((q, j) => (j === k ? { ...q, x: clamp(p.x), y: clamp(p.y) } : q)));
      drag.current = { kind: 'move', idx: k };
    } else if (hit >= 0) drag.current = { kind: 'move', idx: hit };
    else if (def.single) {
      writePoints([{ x: clamp(p.x), y: clamp(p.y), label: 1 }]);
      drag.current = { kind: 'move', idx: 0 };
    } else drag.current = { kind: 'press', x: p.x, y: p.y, cx: p.cx, cy: p.cy, label: label(e) };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const p = norm(e);
    if (def.kind === 'brush') setHover({ x: p.cx, y: p.cy });
    const d = drag.current;
    if (!d) return;
    e.stopPropagation();
    if (d.kind === 'move') {
      const pts = shownPoints.map((q, i) => (i === d.idx ? { ...q, x: clamp(p.x), y: clamp(p.y) } : q));
      writePoints(pts);
    } else if (d.kind === 'press') {
      if (def.boxParam && Math.hypot(p.cx - d.cx, p.cy - d.cy) > 5) drag.current = { kind: 'box', x: d.x, y: d.y };
    } else if (d.kind === 'box') {
      setBoxDraft([Math.min(d.x, p.x), Math.min(d.y, p.y), Math.max(d.x, p.x), Math.max(d.y, p.y)].map(clamp) as Box);
    } else if (d.kind === 'stroke') {
      const pp = d.cur.p;
      const lx = pp[pp.length - 2], ly = pp[pp.length - 1];
      const dist = Math.hypot((p.x - lx) * rect.fullW, (p.y - ly) * rect.fullH);
      if (dist < Math.max(1.5, ui.brushSize * 0.08)) return;
      pp.push(clamp(p.x), clamp(p.y));
      if (!raf.current)
        raf.current = requestAnimationFrame(() => {
          raf.current = 0;
          if (drag.current?.kind === 'stroke') writeStrokes(drag.current.strokes);
        });
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (layer.current?.hasPointerCapture(e.pointerId)) layer.current.releasePointerCapture(e.pointerId);
    if (!d) return;
    e.stopPropagation();
    const p = norm(e);
    if (d.kind === 'press') writePoints([...points, { x: clamp(d.x), y: clamp(d.y), label: d.label }]);
    else if (d.kind === 'box') {
      const b = [Math.min(d.x, p.x), Math.min(d.y, p.y), Math.max(d.x, p.x), Math.max(d.y, p.y)].map(clamp) as Box;
      setBoxDraft(null);
      writeBox(b[2] - b[0] > 0.005 && b[3] - b[1] > 0.005 ? b : null);
    } else if (d.kind === 'stroke') {
      cancelAnimationFrame(raf.current);
      raf.current = 0;
      writeStrokes(d.strokes);
    }
    endGesture();
  };

  const onContextMenu = (e: React.MouseEvent) => {
    if (def.kind !== 'points' || def.single) return;
    e.preventDefault();
    e.stopPropagation();
    const p = norm(e);
    const hit = hitPoint(p.cx, p.cy);
    if (hit >= 0) writePoints(points.filter((_, i) => i !== hit));
    else if (box) writeBox(null);
  };

  const clear = () => {
    const sets: [string, ParamValue][] = [];
    if (tool.keys.param) sets.push([tool.keys.param, '']);
    if (tool.keys.box) sets.push([tool.keys.box, '']);
    sets.forEach(([k, v]) => editParam(tool.nodeId, k, v));
  };

  const cursor = def.kind === 'brush' ? 'none' : 'crosshair';
  const brushR = (ui.brushSize / 2) * rect.zoom;
  const effLabel = mods.alt ? 0 : mods.shift ? 1 : ui.pointMode;

  return (
    <>
      {def.previewPort && ui.tint && <MaskTint flat={tool.flat} port={def.previewPort} rect={rect} host={host} />}
      <div
        ref={layer}
        className="vt-layer"
        style={{ cursor: spaceDown ? 'grab' : cursor, pointerEvents: spaceDown ? 'none' : undefined }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => setHover(null)}
        onContextMenu={onContextMenu}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <svg className="vt-svg">
          {box && (() => {
            const a = toCss({ x: box[0], y: box[1] }), b = toCss({ x: box[2], y: box[3] });
            return <rect className="vt-box" x={a.x} y={a.y} width={b.x - a.x} height={b.y - a.y} />;
          })()}
          {shownPoints.map((p, i) => {
            const c = toCss(p);
            const h = tool.handles ? handles[i] : undefined;
            if (h) {
              const col = h.color ? `rgb(${h.color.slice(0, 3).map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255)).join(',')})` : undefined;
              return (
                <g key={h.key} className={'vt-light' + (h.i === activeIdx ? ' vt-active' : '')} transform={`translate(${c.x},${c.y})`}>
                  <circle r={11} />
                  <circle r={4.5} className="vt-light-core" style={col ? { fill: col } : undefined} />
                  {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => (
                    <line key={a} x1={14} x2={19} transform={`rotate(${a})`} />
                  ))}
                  <text className="vt-light-label" x={15} y={-13}>
                    {h.label}
                  </text>
                </g>
              );
            }
            if (def.single)
              return (
                <g key={i} className="vt-light" transform={`translate(${c.x},${c.y})`}>
                  <circle r={11} />
                  <circle r={4} className="vt-light-core" />
                  {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => (
                    <line key={a} x1={14} x2={19} transform={`rotate(${a})`} />
                  ))}
                </g>
              );
            return (
              <g key={i} className={'vt-pt ' + (p.label ? 'pos' : 'neg')} transform={`translate(${c.x},${c.y})`}>
                <circle r={7} />
                <line x1={-3.5} x2={3.5} />
                {p.label ? <line y1={-3.5} y2={3.5} /> : null}
              </g>
            );
          })}
          {def.kind === 'brush' && hover && <circle className={'vt-brush' + (ui.erase ? ' erase' : '')} cx={hover.x} cy={hover.y} r={Math.max(1, brushR)} />}
        </svg>
      </div>
      <div className="vt-hud" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
        <div className="vt-title">
          <b>{tool.name}</b>
          <span className="vt-kind">{def.kind === 'brush' ? 'Brush' : def.kind === 'box' ? 'Box' : tool.handles ? (handles.every((h) => /^\d+$/.test(String(h.label))) ? (handles.length > 1 ? `${handles.length} lights` : 'Light') : `${handles.length} handle${handles.length === 1 ? '' : 's'}`) : def.single ? 'Position' : 'Points'}</span>
          {pending && <span className="vt-busy">working…</span>}
        </div>
        {def.kind === 'points' && !def.single && (
          <div className="vt-row">
            <div className="vt-seg">
              <button className={'btn' + (effLabel === 1 ? ' vt-on' : '')} onClick={() => useToolUi.setState({ pointMode: 1 })} title="New points include (hold Shift)">
                + Include
              </button>
              <button className={'btn' + (effLabel === 0 ? ' vt-on' : '')} onClick={() => useToolUi.setState({ pointMode: 0 })} title="New points exclude (hold Alt)">
                − Exclude
              </button>
            </div>
            <span className="vt-count">{points.length} pt{points.length === 1 ? '' : 's'}</span>
          </div>
        )}
        {tool.handles && handles.length > 1 && (
          <div className="vt-row">
            <div className="vt-seg">
              {handles.map((h) => (
                <button key={h.key} className={'btn' + (h.i === activeIdx ? ' vt-on' : '')} onClick={() => useToolUi.setState({ activeHandle: h.i })} title="Clicks on the image move this handle">
                  {h.color && <span className="vt-swatch" style={{ background: `rgb(${h.color.slice(0, 3).map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255)).join(',')})` }} />}
                  {/^\d+$/.test(String(h.label)) ? `Light ${h.label}` : h.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {def.kind === 'brush' && (
          <>
            <div className="vt-row">
              <div className="vt-seg">
                <button className={'btn' + (!ui.erase ? ' vt-on' : '')} onClick={() => useToolUi.setState({ erase: false })}>
                  Paint
                </button>
                <button className={'btn' + (ui.erase ? ' vt-on' : '')} onClick={() => useToolUi.setState({ erase: true })} title="X toggles">
                  Erase
                </button>
              </div>
            </div>
            <label className="vt-row vt-slider">
              <span>Size</span>
              <input type="range" min={2} max={600} step={1} value={ui.brushSize} onChange={(e) => useToolUi.setState({ brushSize: +e.target.value })} />
              <span className="vt-val">{ui.brushSize}px</span>
            </label>
            <label className="vt-row vt-slider">
              <span>Hardness</span>
              <input type="range" min={0} max={1} step={0.01} value={ui.brushHardness} onChange={(e) => useToolUi.setState({ brushHardness: +e.target.value })} />
              <span className="vt-val">{Math.round(ui.brushHardness * 100)}%</span>
            </label>
          </>
        )}
        <div className="vt-hint">
          {def.kind === 'brush'
            ? '[ ] size · X erase · Space-drag pans'
            : def.kind === 'box'
              ? 'Drag a box · Space-drag pans'
              : tool.handles
                ? handles.length > 1
                  ? 'Drag a light · a click moves the selected light'
                  : 'Click or drag to place the light'
                : def.single
                ? 'Click or drag to place'
                : `Click to add · Shift include · Alt exclude · drag a point to move · right-click removes${def.boxParam ? ' · drag empty area for a box' : ''}`}
        </div>
        <div className="vt-row vt-actions">
          {def.previewPort && (
            <label className="vt-check">
              <input type="checkbox" checked={ui.tint} onChange={(e) => useToolUi.setState({ tint: e.target.checked })} /> Show mask
            </label>
          )}
          <span className="flex1" />
          {!def.vec2Param && (
            <button className="btn" onClick={clear}>
              Clear
            </button>
          )}
          <button className="btn" onClick={() => useToolUi.setState({ doneFor: tool.flat })}>
            Done
          </button>
        </div>
      </div>
    </>
  );
}

/** Translucent tint of a node's mask output over the image (downsampled readback of the cached output). */
function MaskTint({ flat, port, rect, host }: { flat: string; port: string; rect: { x: number; y: number; w: number; h: number }; host: React.RefObject<HTMLDivElement | null> }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const viewedSelf = useDoc((s) => (s.viewed ?? '') === flat);
  useEffect(() => {
    if (!engine) return;
    let last = '';
    let timer = 0;
    let alive = true;
    const run = () => {
      timer = 0;
      const graph = useDoc.getState().project.graph;
      try {
        if (!engine.isCached(flat, graph)) engine.render(graph, { nodeId: flat, port, maxSize: 640, cacheTag: 'viewerTool' });
      } catch {
        return;
      }
      const key = engine.cacheKey(flat, graph);
      if (!key) {
        if (!last) timer = window.setTimeout(run, 300); // still computing
        return;
      }
      if (key === last) return;
      last = key;
      void engine.thumbnail(flat, port, 640, { graph, mask: true }).then((img) => {
        const c = canvas.current;
        if (!alive || !c) return;
        if (!img) {
          last = '';
          timer = window.setTimeout(run, 250);
          return;
        }
        const col = getComputedStyle(host.current ?? document.body).getPropertyValue('--sel').trim() || '#3a6fd2';
        const ctx = c.getContext('2d', { willReadFrequently: true })!;
        c.width = img.width;
        c.height = img.height;
        ctx.fillStyle = col;
        ctx.fillRect(0, 0, 1, 1);
        const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
        const d = img.data;
        for (let i = 0; i < d.length; i += 4) {
          const m = d[i];
          d[i] = r;
          d[i + 1] = g;
          d[i + 2] = b;
          d[i + 3] = m * 0.5;
        }
        ctx.putImageData(img, 0, 0);
      });
    };
    const schedule = () => {
      if (!timer) timer = window.setTimeout(run, 120);
    };
    afterRender.add(schedule);
    const unsub = useDoc.subscribe((a, b) => a.project.graph !== b.project.graph && schedule());
    schedule();
    return () => {
      alive = false;
      unsub();
      afterRender.delete(schedule);
      clearTimeout(timer);
    };
  }, [flat, port, host]);
  if (viewedSelf) return null;
  return <canvas ref={canvas} className="vt-tint" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }} />;
}
