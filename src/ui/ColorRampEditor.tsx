/**
 * Blender-style Color Ramp editor (NodeDef.editor = 'colorRamp').
 *
 * Params: `count`, `pos0..7`, `color0..7`, `interpolation`, `colorMode`, `hueInterpolation`.
 * The gradient preview uses the same JS evaluator the node bakes its 256×1 LUT with
 * (evalRamp in src/nodes/math/_shared.ts), so it matches the GPU output.
 *
 * Editing model: stops keep their identity (index) while dragged past each other; when a gesture
 * ends, the stops are re-sorted into pos0..N by position and the active index follows its stop.
 * A drag or colour-pick is a "transaction": live updates are written silently (no history), and on
 * release the document is restored to the pre-gesture state and the final values are committed as
 * ONE undo step, however long the gesture took.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { GraphNode, NodeEditorKind, ParamValue, Project } from '../core/types';
import { getNodeDef } from '../core/registry';
import { clone } from '../core/graph';
import { evalRamp, RAMP_HUE, RAMP_INTERP, RAMP_MAX, RAMP_MODES, rampFromParams, type Ramp, type RampStop, type RGBA } from '../nodes/math/_shared';
import { commitProject, useDoc } from '../store/doc';
import { groupNodeAt, updateGraphAt } from '../store/graphPath';
import { ColorPopup, cssColor, toHex } from './ColorPicker';
import { Icon } from './Icon';
import { useContextMenu } from './Menu';
import { NumField } from './NumField';
import './colorRamp.css';

// ---------------------------------------------------------------------------
// Param ownership (Properties hides these from the generic rows)
// ---------------------------------------------------------------------------

const RAMP_KEY = /^(count|interpolation|colorMode|hueInterpolation|pos[0-7]|color[0-7])$/;

/** True if the custom editor `kind` renders param `key` itself. */
export function editorOwnsParam(kind: NodeEditorKind, key: string): boolean {
  return kind === 'colorRamp' && RAMP_KEY.test(key);
}

/** Custom editor for a node (dispatch on NodeDef.editor). */
export function NodeParamEditor({ kind, node }: { kind: NodeEditorKind; node: GraphNode }) {
  if (kind === 'colorRamp') return <ColorRampEditor node={node} />;
  return null;
}

// ---------------------------------------------------------------------------
// Param writes (multi-key, one undo step)
// ---------------------------------------------------------------------------

type Patch = Record<string, ParamValue>;

function patchProject(p: Project, path: string[], nodeId: string, patch: Patch): Project {
  const map = (nodes: GraphNode[], id: string, fn: (n: GraphNode) => GraphNode) => nodes.map((n) => (n.id === id ? fn(n) : n));
  let root = updateGraphAt(p.graph, path, (g) => ({ ...g, nodes: map(g.nodes, nodeId, (n) => ({ ...n, params: { ...n.params, ...clone(patch) } })) }));
  // inner node of an enclosing group with some of these params exposed: keep the group's copy in sync
  if (path.length) {
    const gnode = groupNodeAt(root, path);
    const ex = gnode?.group?.exposed.filter((e) => e.node === nodeId && e.param in patch) ?? [];
    if (gnode && ex.length) {
      root = updateGraphAt(root, path.slice(0, -1), (g) => ({
        ...g,
        nodes: map(g.nodes, gnode.id, (gn) => ({ ...gn, params: { ...gn.params, ...Object.fromEntries(ex.map((e) => [e.key, clone(patch[e.param])])) } })),
      }));
    }
  }
  return { ...p, graph: root };
}

/** Pre-gesture project while a drag / colour pick is in progress. */
let txBase: { project: Project; nodeId: string } | null = null;

/** Live update during a gesture: no history entry. */
function writeLive(nodeId: string, patch: Patch) {
  const s = useDoc.getState();
  if (!txBase || txBase.nodeId !== nodeId) txBase = { project: s.project, nodeId };
  commitProject((p) => patchProject(p, s.path, nodeId, patch), { silent: true });
}

/** Commit `patch` as one undo step. Ends any open gesture: its live edits are folded into this step. */
function writeCommit(nodeId: string, patch: Patch) {
  const s = useDoc.getState();
  if (txBase) {
    if (txBase.nodeId === nodeId) useDoc.setState({ project: txBase.project });
    txBase = null;
  }
  // skip no-op commits (e.g. a click on a marker without moving it)
  const cur = useDoc.getState();
  const node = findNode(cur.project, s.path, nodeId);
  if (node && Object.entries(patch).every(([k, v]) => JSON.stringify(node.params[k]) === JSON.stringify(v))) {
    return;
  }
  commitProject((p) => patchProject(p, s.path, nodeId, patch));
}

function findNode(p: Project, path: string[], id: string): GraphNode | undefined {
  let g = p.graph;
  for (const gid of path) {
    const gn = g.nodes.find((n) => n.id === gid);
    if (!gn?.group) return undefined;
    g = gn.group.graph;
  }
  return g.nodes.find((n) => n.id === id);
}

// ---------------------------------------------------------------------------
// Stop helpers
// ---------------------------------------------------------------------------

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const round = (x: number) => Math.round(x * 10000) / 10000;

/** Patch writing `stops` (in this order) into count / pos0..N / color0..N. */
function stopsPatch(stops: RampStop[]): Patch {
  const p: Patch = { count: stops.length };
  stops.forEach((s, i) => {
    p['pos' + i] = round(clamp01(s.pos));
    p['color' + i] = [...s.color];
  });
  return p;
}

/** Stable sort by position; returns the sorted stops and where index `active` ended up. */
function sortStops(stops: RampStop[], active: number): { stops: RampStop[]; active: number } {
  const order = stops.map((s, i) => ({ s, i })).sort((a, b) => a.s.pos - b.s.pos || a.i - b.i);
  return { stops: order.map((o) => o.s), active: Math.max(0, order.findIndex((o) => o.i === active)) };
}

/** Opaque version of a colour (for marker fills; alpha is shown on the bar). */
const opaque = (c: RGBA) => cssColor([c[0], c[1], c[2], 1]);

// ---------------------------------------------------------------------------
// Gradient drawing
// ---------------------------------------------------------------------------

function drawRamp(canvas: HTMLCanvasElement, ramp: Ramp) {
  const w = Math.max(2, Math.round(canvas.clientWidth * (window.devicePixelRatio || 1)));
  if (canvas.width !== w) canvas.width = w;
  canvas.height = 1;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const img = ctx.createImageData(w, 1);
  for (let x = 0; x < w; x++) {
    // pixel centre → t, the same mapping the baked LUT uses at its ends (t = 0 and 1 included)
    const c = evalRamp(ramp, w === 1 ? 0 : x / (w - 1));
    img.data[x * 4] = Math.round(clamp01(c[0]) * 255);
    img.data[x * 4 + 1] = Math.round(clamp01(c[1]) * 255);
    img.data[x * 4 + 2] = Math.round(clamp01(c[2]) * 255);
    img.data[x * 4 + 3] = Math.round(clamp01(c[3]) * 255);
  }
  ctx.putImageData(img, 0, 0);
}

/** Canvas strip showing a ramp (stretches to its CSS box). */
function RampCanvas({ ramp, className }: { ramp: Ramp; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const cur = useRef(ramp);
  cur.current = ramp;
  const key = JSON.stringify(ramp);
  useLayoutEffect(() => {
    if (ref.current) drawRamp(ref.current, cur.current);
  }, [key]);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => drawRamp(el, cur.current));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return <canvas ref={ref} className={className} />;
}

/** Small read-only ramp strip for the node body in the graph. */
export function RampStrip({ node }: { node: GraphNode }) {
  if (getNodeDef(node.type)?.editor !== 'colorRamp') return null;
  return (
    <div className="cramp-strip" title="Color Ramp">
      <RampCanvas ramp={rampFromParams(node.params)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

export function ColorRampEditor({ node }: { node: GraphNode }) {
  const ramp = rampFromParams(node.params);
  const stops = ramp.stops;
  const n = stops.length;
  const [activeRaw, setActive] = useState(0);
  const active = Math.min(n - 1, Math.max(0, activeRaw));
  const [picker, setPicker] = useState<DOMRect | null>(null);
  const [dragging, setDragging] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const menu = useContextMenu();
  const id = node.id;

  // new node selected: start at the first stop, close the picker
  useEffect(() => {
    setActive(0);
    setPicker(null);
  }, [id]);

  const latest = useRef({ stops, ramp });
  latest.current = { stops, ramp };

  /** Commit `next` stops sorted by position, with the active marker following stop `act`. */
  const commitStops = (next: RampStop[], act: number) => {
    const s = sortStops(next, act);
    setActive(s.active);
    writeCommit(id, stopsPatch(s.stops));
  };

  const posAt = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    return clamp01((clientX - r.left) / Math.max(1, r.width));
  };

  /** Drag stop `i` (window-level listeners so the pointer can leave the widget). */
  const startDrag = (i: number, e: React.PointerEvent, base: RampStop[]) => {
    const x0 = e.clientX;
    const grab = posAt(e.clientX) - base[i].pos; // keep the grab offset (no jump on click)
    let moved = false;
    let cur = base;
    setDragging(true);
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - x0) < 2) return;
      moved = true;
      let p = clamp01(posAt(ev.clientX) - grab);
      if (ev.shiftKey) p = Math.round(p * 20) / 20; // snap to 0.05
      cur = cur.map((s, j) => (j === i ? { ...s, pos: p } : s));
      writeLive(id, { ['pos' + i]: round(p) });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      setDragging(false);
      commitStops(cur, i);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const focus = () => root.current?.focus({ preventScroll: true });

  const onMarkerDown = (i: number, e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    focus();
    setActive(i);
    setPicker(null);
    startDrag(i, e, stops);
  };

  const onBarDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    focus();
    setPicker(null);
    const t = posAt(e.clientX);
    if (n >= RAMP_MAX) {
      // full: pick (and drag) the nearest stop instead
      let best = 0;
      stops.forEach((s, j) => Math.abs(s.pos - t) < Math.abs(stops[best].pos - t) && (best = j));
      setActive(best);
      startDrag(best, e, stops);
      return;
    }
    const next = [...stops, { pos: t, color: evalRamp(ramp, t) }];
    setActive(n);
    writeLive(id, stopsPatch(next)); // live: the drag below finishes it as one undo step
    startDrag(n, e, next);
  };

  const addStop = () => {
    if (n >= RAMP_MAX) return;
    const sorted = sortStops(stops, active);
    const a = sorted.stops[sorted.active];
    // midpoint between the active stop and its right neighbour (left one if it is the last)
    const nb = sorted.stops[sorted.active + 1] ?? sorted.stops[sorted.active - 1];
    const t = nb ? (a.pos + nb.pos) / 2 : a.pos < 0.5 ? (a.pos + 1) / 2 : a.pos / 2;
    commitStops([...stops, { pos: t, color: evalRamp(ramp, t) }], n);
  };

  const removeStop = () => {
    if (n <= 1) return;
    const next = stops.filter((_, j) => j !== active);
    const s = sortStops(next, Math.max(0, active - 1));
    setActive(s.active);
    writeCommit(id, stopsPatch(s.stops));
  };

  const setPos = (p: number) => commitStops(stops.map((s, j) => (j === active ? { ...s, pos: clamp01(p) } : s)), active);

  const setEnum = (k: string, v: string) => writeCommit(id, { [k]: v });

  const openMenu = (e: React.MouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    menu.open({ clientX: r.left, clientY: r.bottom + 1 }, [
      {
        label: 'Flip Color Ramp',
        icon: 'shape_flip_horizontal',
        run: () => commitStops(stops.map((s) => ({ ...s, pos: 1 - s.pos })), active),
      },
      {
        label: 'Distribute Stops Evenly',
        icon: 'shape_align_center',
        disabled: n < 2,
        run: () => {
          const s = sortStops(stops, active);
          setActive(s.active);
          writeCommit(id, stopsPatch(s.stops.map((st, j) => ({ ...st, pos: j / (n - 1) }))));
        },
      },
      {
        label: 'Distribute Stops from Left',
        icon: 'shape_align_left',
        disabled: n < 2,
        run: () => {
          const s = sortStops(stops, active);
          setActive(s.active);
          writeCommit(id, stopsPatch(s.stops.map((st, j) => ({ ...st, pos: j / n }))));
        },
      },
      { sep: true },
      {
        label: 'Reset Color Ramp',
        icon: 'arrow_rotate_anticlockwise',
        run: () => {
          setActive(0);
          writeCommit(id, stopsPatch([{ pos: 0, color: [0, 0, 0, 1] }, { pos: 1, color: [1, 1, 1, 1] }]));
        },
      },
    ]);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t !== root.current) return; // typing in a field / select
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      e.stopPropagation();
      removeStop();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      e.stopPropagation();
      const d = (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 0.1 : 0.01);
      setPos(stops[active].pos + d);
    } else if (e.key === '[' || e.key === ']') {
      // previous / next stop by position
      e.preventDefault();
      e.stopPropagation();
      const s = sortStops(stops, active);
      const k = Math.min(n - 1, Math.max(0, s.active + (e.key === '[' ? -1 : 1)));
      const target = s.stops[k];
      setActive(stops.indexOf(target));
    }
  };

  const ac = stops[active].color;
  const hsx = ramp.mode !== 'RGB';
  const curvy = ramp.interpolation === 'Cardinal' || ramp.interpolation === 'B-Spline';

  return (
    <div
      className={'cramp' + (dragging ? ' dragging' : '')}
      ref={root}
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <div className="cramp-head">
        <div className="cramp-tools">
          <button className="tbtn small" title={n >= RAMP_MAX ? `At most ${RAMP_MAX} stops` : 'Add a stop between the active stop and its neighbour'} disabled={n >= RAMP_MAX} onClick={addStop}>
            <Icon name="add" />
          </button>
          <button className="tbtn small" title="Remove the active stop (Delete)" disabled={n <= 1} onClick={removeStop}>
            <Icon name="delete" />
          </button>
          <button className="tbtn small cramp-menu-btn" title="Ramp operations" onClick={openMenu}>
            <span className="cramp-caret" />
          </button>
        </div>
        <div className="cramp-enums">
          <select className="field select" title="Colour mode: blend stops in RGB, HSV or HSL" value={ramp.mode} onChange={(e) => setEnum('colorMode', e.target.value)}>
            {RAMP_MODES.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
          <select className="field select" title="Interpolation between stops" value={ramp.interpolation} onChange={(e) => setEnum('interpolation', e.target.value)}>
            {RAMP_INTERP.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </div>
      </div>

      {hsx && (
        <div className="cramp-subhead">
          <span>Hue</span>
          <select
            className="field select"
            title={'Hue interpolation' + (ramp.interpolation === 'Linear' || ramp.interpolation === 'Ease' ? '' : ' (applies to Linear and Ease only)')}
            value={ramp.hue}
            onChange={(e) => setEnum('hueInterpolation', e.target.value)}
          >
            {RAMP_HUE.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="cramp-band">
        <div className="cramp-track" ref={track}>
          <div
            className="cramp-bar"
            onPointerDown={onBarDown}
            title={n >= RAMP_MAX ? 'Click to grab the nearest stop' : 'Click to add a stop here (then drag to place it)'}
          >
            <div className="cramp-checker" />
            <RampCanvas ramp={ramp} className="cramp-canvas" />
            {stops.map((s, i) => (
              <div key={i} className={'cramp-line' + (i === active ? ' active' : '')} style={{ left: `${s.pos * 100}%` }} />
            ))}
          </div>
          <div className="cramp-markers">
            {stops
              .map((s, i) => ({ s, i }))
              .sort((a, b) => (a.i === active ? 1 : b.i === active ? -1 : 0)) // active marker on top
              .map(({ s, i }) => (
                <div
                  key={i}
                  className={'cramp-marker' + (i === active ? ' active' : '')}
                  style={{ left: `${s.pos * 100}%` }}
                  onPointerDown={(e) => onMarkerDown(i, e)}
                  onDoubleClick={(e) => {
                    setActive(i);
                    setPicker(e.currentTarget.getBoundingClientRect());
                  }}
                  title={`Stop ${i + 1} · ${s.pos.toFixed(3)} · ${toHex(s.color)}${s.color[3] < 1 ? ` α ${s.color[3].toFixed(2)}` : ''}\nDrag to move (Shift snaps) · double-click to pick colour`}
                >
                  <svg viewBox="0 0 12 14" width="12" height="14" aria-hidden>
                    <path className="cramp-flag" d="M6 0.5 L11.5 5.5 V13.5 H0.5 V5.5 Z" />
                    <rect className="cramp-chip" x="2.5" y="6.5" width="7" height="5" style={{ fill: opaque(s.color) }} />
                  </svg>
                </div>
              ))}
          </div>
        </div>
      </div>

      <div className="cramp-active">
        <label className="cramp-field" title="Active stop ([ and ] step through stops by position)">
          <span>Stop</span>
          <NumField value={active + 1} int step={1} width={28} onChange={(v) => setActive(Math.min(n, Math.max(1, v)) - 1)} />
        </label>
        <label className="cramp-field cramp-pos" title="Position of the active stop (← → nudge, Shift ×10)">
          <span>Pos</span>
          <NumField value={round(stops[active].pos)} step={0.001} onChange={setPos} />
        </label>
        <button
          className="swatch cramp-swatch"
          title={`Pick the active stop's colour\n${toHex(ac)} α ${ac[3].toFixed(2)}`}
          onClick={(e) => setPicker(picker ? null : e.currentTarget.getBoundingClientRect())}
        >
          <span className="cramp-swatch-checker">
            <span style={{ background: cssColor(ac) }} />
          </span>
        </button>
      </div>
      <div className="cramp-hint">
        {curvy && hsx ? `${ramp.interpolation} blends in RGB · ` : ''}
        Click bar to add · drag ▲ to move · Del removes
      </div>

      {picker && (
        <ColorPopup
          key={id + ':' + active}
          anchor={picker}
          value={ac}
          onChange={(c) => writeLive(id, { ['color' + active]: [...c] })}
          onClose={() => {
            setPicker(null);
            writeCommit(id, { ['color' + active]: [...latest.current.stops[active].color] });
            focus();
          }}
        />
      )}
      {menu.el}
    </div>
  );
}
