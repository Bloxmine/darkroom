import {
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  BackgroundVariant,
  ConnectionLineType,
  MiniMap,
  Panel as RfPanel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge as RfEdge,
  type EdgeChange,
  type NodeChange,
  type NodeTypes,
  type OnConnectEnd,
  type PanelPosition,
} from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import './graphEditor.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getPorts, GROUP, OUTPUT, wouldCycle } from '../core/graph';
import { DEFAULT_NODE_SIZE, frameMembers, type Pt } from '../core/graphLayout';
import { getNodeDef } from '../core/registry';
import * as A from '../store/actions';
import { currentGraph, effectiveViewed, outputNodeId, setSelection, useDoc } from '../store/doc';
import * as GE from '../store/graphEdit';
import { nodeSizes, useGraphUi } from '../store/graphUi';
import { flatId, localIdForFlat } from '../store/graphPath';
import { importImageFiles } from '../store/io';
import { savePresetFromSelection } from '../store/presets';
import { setPref, THEME_META, useSettings } from '../store/settings';
import { useUi } from '../store/ui';
import { Panel } from './Chrome';
import { graphApi } from './commands';
import { FrameView, type FrameNode } from './FrameView';
import { frameIdOf, frameRfId, isFrameRfId, TAG_COLORS, tagColor } from './graphIds';
import { GraphDialogs } from './GraphDialogs';
import { Icon, nodeColor } from './Icon';
import { DND_TYPE } from './Library';
import { useContextMenu, type MenuItem } from './Menu';
import { addNodeMenus } from './MenuBar';
import { inHandle, NodeView, outHandle, portOf, type DrNode } from './NodeView';
import { QuickAdd } from './QuickAdd';
import { useRegistry } from './useRegistry';
import '../store/presets'; // load "My Presets" from IndexedDB
import { pinToCompare } from './viewer/viewerCommands';

type AnyNode = DrNode | FrameNode;
const nodeTypes = { dr: NodeView, frame: FrameView } as unknown as NodeTypes;

function Breadcrumb() {
  const path = useDoc((s) => s.path);
  const root = useDoc((s) => s.project.graph);
  const names: string[] = [];
  let g = root;
  for (const id of path) {
    const n = g.nodes.find((x) => x.id === id);
    names.push(n ? A.nodeName(n) : id);
    g = n?.group?.graph ?? g;
  }
  return (
    <div className="breadcrumb">
      <button className={'crumb' + (path.length ? '' : ' current')} onClick={() => A.exitGroup(0)} title="Root graph">
        <Icon name="house" /> Root
      </button>
      {names.map((nm, i) => (
        <span key={i} className="crumb-wrap">
          <span className="crumb-sep">›</span>
          <button className={'crumb' + (i === path.length - 1 ? ' current' : '')} onClick={() => A.exitGroup(i + 1)}>
            <Icon name="bricks" /> {nm}
          </button>
        </span>
      ))}
      {path.length > 0 && (
        <button className="tbtn small crumb-up" title="Up one level (Ctrl+Backspace)" onClick={() => A.exitGroup()}>
          <Icon name="arrow_up" />
        </button>
      )}
      <span className="crumb-hint">{path.length ? 'Editing group contents' : ''}</span>
    </div>
  );
}

/** Sample an edge's SVG path (flow coordinates). */
function edgePoints(root: HTMLElement | null, id: string, n = 28): Pt[] {
  const p = root?.querySelector<SVGPathElement>(`.react-flow__edge[data-id="${CSS.escape(id)}"] path.react-flow__edge-path`);
  if (!p) return [];
  const len = p.getTotalLength();
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const q = p.getPointAtLength((len * i) / n);
    out.push({ x: q.x, y: q.y });
  }
  return out;
}

const segsCross = (a: Pt, b: Pt, c: Pt, d: Pt) => {
  const o = (p: Pt, q: Pt, r: Pt) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
};

/** Colour-tag submenu (nodes and frames). */
function colorItems(set: (c: string | undefined) => void, custom: () => void, allowNone = true): MenuItem[] {
  return [
    ...(allowNone ? [{ label: 'None', icon: 'cross', run: () => set(undefined) }] : []),
    ...TAG_COLORS.map((c) => ({ label: c[0].toUpperCase() + c.slice(1), icon: `tag_${['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink'].includes(c) ? c : 'blue'}`, run: () => set(c) })),
    { sep: true as const },
    { label: 'Custom Colour…', icon: 'palette', run: custom },
  ];
}

/** Open the system colour picker and report the chosen colour. */
function pickColor(initial: string, done: (c: string) => void) {
  const i = document.createElement('input');
  i.type = 'color';
  i.value = /^#[0-9a-f]{6}$/i.test(initial) ? initial : '#4a7bd0';
  i.style.position = 'fixed';
  i.style.opacity = '0';
  i.style.pointerEvents = 'none';
  document.body.appendChild(i);
  i.addEventListener('change', () => {
    done(i.value);
    i.remove();
  });
  i.addEventListener('blur', () => setTimeout(() => i.remove(), 500));
  i.click();
}

function Flow() {
  const rf = useReactFlow<AnyNode, RfEdge>();
  const regV = useRegistry();
  const graph = useDoc((s) => currentGraph(s));
  const path = useDoc((s) => s.path);
  const selection = useDoc((s) => s.selection);
  const viewed = useDoc((s) => effectiveViewed(s));
  const outId = useDoc((s) => outputNodeId(s.project));
  const loadCount = useDoc((s) => s.loadCount);
  const errors = useUi((s) => s.errors);
  const pending = useUi((s) => s.pending);
  const tm = THEME_META[useSettings((s) => s.theme)];
  // Preferences › Appearance / General
  const wire = useSettings((s) => s.wireStyle);
  const gridStyle = useSettings((s) => s.grid);
  const minimap = useSettings((s) => s.minimap);
  const minimapPos = useSettings((s) => s.minimapPos);
  const tips = useSettings((s) => s.nodeTooltips);
  const idTips = useSettings((s) => s.nodeIdTooltips);
  const snap = useSettings((s) => s.snapToGrid);
  const gridSize = useSettings((s) => s.gridSize);
  const frameSel = useGraphUi((s) => s.frameSelection);
  const insertEdge = useGraphUi((s) => s.insertEdge);
  const insertNode = useGraphUi((s) => (s.insertEdge ? s.insertNode : null));
  const detached = useGraphUi((s) => s.detachedEdge);
  const wrap = useRef<HTMLDivElement>(null);
  const mouse = useRef<{ x: number; y: number; inside: boolean }>({ x: 0, y: 0, inside: false });
  const ctx = useContextMenu();

  const [nodes, setNodes] = useState<AnyNode[]>([]);
  const [edges, setEdges] = useState<RfEdge[]>([]);
  /** Positions of nodes moved along with a dragged frame (kept across doc rebuilds mid-drag). */
  const live = useRef<Map<string, Pt>>(new Map());

  // measured sizes for placement / tidy / frames
  useEffect(() => {
    nodeSizes.measured = (id) => {
      const m = rf.getInternalNode(id)?.measured;
      return m?.width && m?.height ? { width: m.width, height: m.height } : undefined;
    };
    return () => {
      nodeSizes.measured = () => undefined;
    };
  }, [rf]);

  // --- rebuild React Flow nodes/edges from the document
  useEffect(() => {
    const sel = new Set(selection);
    const fsel = new Set(frameSel);
    const errBy = new Map<string, string>();
    for (const [k, v] of Object.entries(errors)) {
      const id = localIdForFlat(path, k);
      if (id) errBy.set(id, (errBy.has(id) ? errBy.get(id) + '\n\n' : '') + (k.includes('/') && k !== flatId(path, id) ? `[${k}] ` : '') + v);
    }
    const pend = new Set(pending.map((k) => localIdForFlat(path, k)).filter(Boolean));
    // nodes of unknown type have no port defs: derive sockets from their edges so wires still draw
    const edgePortsOf = (id: string) => ({
      inputs: [...new Set(graph.edges.filter((e) => e.to.node === id).map((e) => e.to.port))],
      outputs: [...new Set(graph.edges.filter((e) => e.from.node === id).map((e) => e.from.port))],
    });
    const tip = (type: string, id: string) => {
      const d = getNodeDef(type);
      const parts = [tips && d?.description ? `${d.name}: ${d.description}` : '', idTips ? `id: ${flatId(path, id)} · type: ${type}` : ''].filter(Boolean);
      return parts.length ? { title: parts.join('\n') } : undefined;
    };
    setNodes((prev) => {
      const old = new Map(prev.map((n) => [n.id, n]));
      const frames: FrameNode[] = (graph.frames ?? []).map((f) => {
        const id = frameRfId(f.id);
        const o = old.get(id);
        return {
          id,
          type: 'frame',
          position: o?.dragging ? o.position : (live.current.get(id) ?? f.position),
          width: o?.resizing ? o.width : f.size.width,
          height: o?.resizing ? o.height : f.size.height,
          measured: o?.measured,
          resizing: o?.resizing,
          selected: fsel.has(f.id),
          dragging: o?.dragging,
          dragHandle: '.fr-head',
          // below every node even when selected (React Flow adds 1000 to selected nodes); smaller frames above bigger ones
          zIndex: f.kind === 'note' ? -2500 : -3000 + Math.min(400, Math.round(4e6 / Math.max(1, f.size.width * f.size.height))),
          className: 'rf-frame',
          data: { frame: f },
        };
      });
      const drs = graph.nodes.map((gn) => {
        const o = old.get(gn.id);
        return {
          id: gn.id,
          type: 'dr',
          className: insertNode === gn.id ? 'rf-inserting' : undefined,
          position: o?.dragging ? o.position : (live.current.get(gn.id) ?? gn.position),
          measured: o?.measured,
          selected: sel.has(gn.id),
          dragging: o?.dragging,
          domAttributes: tip(gn.type, gn.id),
          data: {
            node: gn,
            viewed: viewed === flatId(path, gn.id),
            isOutput: !path.length && gn.type === OUTPUT && gn.id === outId,
            error: errBy.get(gn.id),
            pending: pend.has(gn.id),
            edgePorts: gn.type !== GROUP && !getNodeDef(gn.type) ? edgePortsOf(gn.id) : undefined,
          },
        } satisfies DrNode;
      });
      return [...frames, ...drs];
    });
  }, [graph, selection, frameSel, viewed, errors, pending, path, outId, regV, tips, idTips, insertNode]);

  const edgeSel = useDoc((s) => s.edgeSelection);
  useEffect(() => {
    const es = new Set(edgeSel);
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    setEdges(
      graph.edges.map((e) => {
        const src = byId.get(e.from.node);
        const dst = byId.get(e.to.node);
        const ptype = dst ? getPorts(dst).inputs[e.to.port]?.type : undefined;
        return {
          id: e.id,
          source: e.from.node,
          target: e.to.node,
          sourceHandle: outHandle(e.from.port),
          targetHandle: inHandle(e.to.port),
          selected: es.has(e.id),
          className:
            (ptype === 'mask' ? 'edge-mask' : '') + (src?.bypass ? ' edge-bypass' : '') + (e.id === insertEdge ? ' edge-insert' : '') + (e.id === detached ? ' edge-detached' : ''),
          style: src ? ({ '--edge-accent': nodeColor(src.type) } as React.CSSProperties) : undefined,
          type: wire,
        };
      }),
    );
  }, [graph, edgeSel, wire, insertEdge, detached]);

  // Selection lives in the doc store (nodes) / graphUi (frames); everything else is local RF state.
  const onNodesChange = useCallback((ch: NodeChange<AnyNode>[]) => {
    const sel = ch.filter((c) => c.type === 'select');
    const rest = ch.filter((c) => c.type !== 'select');
    if (rest.length) setNodes((ns) => applyNodeChanges(rest, ns));
    if (sel.length) {
      const s = useDoc.getState();
      const set = new Set(s.selection);
      const fset = new Set(useGraphUi.getState().frameSelection);
      for (const c of sel) {
        if (c.type !== 'select') continue;
        if (isFrameRfId(c.id)) {
          if (c.selected) fset.add(frameIdOf(c.id));
          else fset.delete(frameIdOf(c.id));
        } else if (c.selected) set.add(c.id);
        else set.delete(c.id);
      }
      setSelection([...set].sort(), s.edgeSelection);
      const fs = [...fset].sort();
      if (fs.join() !== useGraphUi.getState().frameSelection.join()) useGraphUi.setState({ frameSelection: fs });
    }
  }, []);
  const onEdgesChange = useCallback((ch: EdgeChange<RfEdge>[]) => {
    const sel = ch.filter((c) => c.type === 'select');
    const rest = ch.filter((c) => c.type !== 'select');
    if (rest.length) setEdges((es) => applyEdgeChanges(rest, es));
    if (sel.length) {
      const s = useDoc.getState();
      const set = new Set(s.edgeSelection);
      for (const c of sel) {
        if (c.type !== 'select') continue;
        if (c.selected) set.add(c.id);
        else set.delete(c.id);
      }
      setSelection(s.selection, [...set].sort());
    }
  }, []);

  // --- imperative API for commands
  const clientToFlow = useCallback((x: number, y: number) => rf.screenToFlowPosition({ x, y }), [rf]);
  const openQuickAddAt = useCallback(
    (x: number, y: number, from?: { node: string; port: string; kind: 'source' | 'target' }, qa: { edge?: string; auto?: boolean } = {}) => {
      const f = clientToFlow(x, y);
      // from a dragged connection: put the new node's port at the drop point; otherwise centre it
      const flow = from ? (from.kind === 'source' ? { x: f.x + 6, y: f.y - 40 } : { x: f.x - 150, y: f.y - 40 }) : { x: f.x - 75, y: f.y - 20 };
      useGraphUi.setState({ qa });
      useUi.setState({ quickAdd: { x, y, flow, from } });
    },
    [clientToFlow],
  );
  /** Keep fitted nodes out from under the minimap. */
  const fitPadding = useCallback(() => {
    const s = useSettings.getState();
    if (!s.minimap) return 0.2;
    const [v, h] = s.minimapPos.split('-');
    return { top: v === 'top' ? '120px' : '8%', bottom: v === 'bottom' ? '120px' : '8%', left: h === 'left' ? '170px' : '6%', right: h === 'right' ? '170px' : '6%' } as const;
  }, []);
  useEffect(() => {
    graphApi.fitView = () => void rf.fitView({ padding: fitPadding(), duration: 200, maxZoom: 1.2 });
    graphApi.mouseFlowPos = () => (mouse.current.inside ? clientToFlow(mouse.current.x, mouse.current.y) : null);
    graphApi.openQuickAdd = () => {
      const r = wrap.current?.getBoundingClientRect();
      if (!r) return;
      const m = mouse.current;
      const x = m.inside ? m.x : r.left + r.width / 2 - 140;
      const y = m.inside ? m.y : r.top + r.height / 3;
      const edge = m.inside ? (useGraphUi.getState().hoverEdge ?? undefined) : undefined;
      openQuickAddAt(x, y, undefined, edge ? { edge } : { auto: true });
    };
  }, [rf, clientToFlow, openQuickAddAt, fitPadding]);

  // fit when entering/leaving groups or loading a project
  const fitTick = useUi((s) => s.fitGraphTick);
  useEffect(() => {
    const t = setTimeout(() => void rf.fitView({ padding: fitPadding(), maxZoom: 1.1 }), 60);
    return () => clearTimeout(t);
  }, [path.join('/'), loadCount, fitTick, rf]); // eslint-disable-line react-hooks/exhaustive-deps
  // leaving a level: drop transient selection / hover state
  useEffect(() => useGraphUi.setState({ frameSelection: [], hoverEdge: null, insertEdge: null, renaming: null }), [path.join('/')]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- connections
  /** Ctrl/⌘-drag off a connected input: the edge being rewired (hidden until dropped). */
  const rewiring = useRef<string | null>(null);
  const isValidConnection = useCallback((c: Connection | RfEdge) => {
    if (c.source === c.target) return false;
    const g = currentGraph();
    const old = rewiring.current;
    return !wouldCycle(old ? { ...g, edges: g.edges.filter((e) => e.id !== old) } : g, c.source, c.target);
  }, []);
  const onConnect = useCallback((c: Connection) => {
    const from = { node: c.source, port: portOf(c.sourceHandle) };
    const to = { node: c.target, port: portOf(c.targetHandle) };
    if (rewiring.current) {
      GE.rewire(rewiring.current, from, to);
      rewiring.current = null;
      useGraphUi.setState({ detachedEdge: null });
      return;
    }
    A.connectPorts(from, to);
  }, []);
  const onConnectEnd: OnConnectEnd = useCallback(
    (event, state) => {
      if (rewiring.current) {
        // dropped on nothing: the wire stays disconnected
        if (!state.isValid) GE.rewire(rewiring.current, null, null);
        rewiring.current = null;
        useGraphUi.setState({ detachedEdge: null });
        return;
      }
      if (state.isValid || !state.fromNode || !state.fromHandle) return;
      const t = event.target as HTMLElement | null;
      if (!t?.classList.contains('react-flow__pane')) return;
      const pt = 'changedTouches' in event ? event.changedTouches[0] : event;
      openQuickAddAt(pt.clientX, pt.clientY, {
        node: state.fromNode.id,
        port: portOf(state.fromHandle.id),
        kind: state.fromHandle.type,
      });
    },
    [openQuickAddAt],
  );

  // --- knife (Ctrl + right-drag across wires) and Ctrl/⌘-drag rewiring
  const [knife, setKnife] = useState<Pt[] | null>(null);
  const suppressCtx = useRef(false);
  const onMouseDownCapture = (e: React.MouseEvent) => {
    const t = e.target as HTMLElement;
    // Ctrl/⌘ + drag from a connected input: pick the wire up by its end
    if (e.button === 0 && (e.ctrlKey || e.metaKey) && t.closest('.react-flow__handle.target')) {
      const h = t.closest('.react-flow__handle.target') as HTMLElement;
      const nodeId = h.dataset.nodeid!;
      const port = portOf(h.dataset.handleid);
      const edge = currentGraph().edges.find((x) => x.to.node === nodeId && x.to.port === port);
      if (!edge) return;
      const src = wrap.current?.querySelector<HTMLElement>(
        `.react-flow__handle.source[data-nodeid="${CSS.escape(edge.from.node)}"][data-handleid="${CSS.escape(outHandle(edge.from.port))}"]`,
      );
      if (!src) return;
      e.stopPropagation();
      e.preventDefault();
      rewiring.current = edge.id;
      useGraphUi.setState({ detachedEdge: edge.id });
      // macOS turns Ctrl+click into a context-menu click: swallow it for this gesture
      suppressCtx.current = true;
      window.addEventListener('mouseup', () => setTimeout(() => (suppressCtx.current = false), 50), { once: true, capture: true });
      src.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: e.clientX, clientY: e.clientY, button: 0, view: window }));
      return;
    }
    // Ctrl + right-drag on the canvas: cut wires
    if (e.button === 2 && e.ctrlKey && !t.closest('.react-flow__node')) {
      e.stopPropagation();
      const r = wrap.current!.getBoundingClientRect();
      const pts: Pt[] = [{ x: e.clientX - r.left, y: e.clientY - r.top }];
      setKnife([...pts]);
      suppressCtx.current = true;
      const move = (m: MouseEvent) => {
        pts.push({ x: m.clientX - r.left, y: m.clientY - r.top });
        setKnife([...pts]);
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        setKnife(null);
        const flow = pts.map((p) => clientToFlow(p.x + r.left, p.y + r.top));
        const cut = currentGraph().edges.filter((ed) => {
          const ep = edgePoints(wrap.current, ed.id);
          for (let i = 1; i < flow.length; i++) for (let j = 1; j < ep.length; j++) if (segsCross(flow[i - 1], flow[i], ep[j - 1], ep[j])) return true;
          return false;
        });
        if (cut.length) A.removeEdges(cut.map((x) => x.id));
        setTimeout(() => (suppressCtx.current = false), 50);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    }
  };

  // --- dragging: frames carry their contents; a single node can be dropped onto a wire
  const drag = useRef<{ members: Map<string, Pt>; frames: Map<string, Pt>; single: string | null } | null>(null);
  const raf = useRef(0);
  const lastCheck = useRef(0);
  const onNodeDragStart = (_: unknown, __: AnyNode, dragged: AnyNode[]) => {
    const g = currentGraph();
    const ids = new Set(dragged.map((n) => n.id));
    const members = new Map<string, Pt>();
    const frames = new Map<string, Pt>();
    const tnodes = g.nodes.map((n) => ({ id: n.id, position: n.position, size: nodeSizes.measured(n.id) ?? DEFAULT_NODE_SIZE }));
    const queue = dragged.filter((n) => isFrameRfId(n.id)).map((n) => frameIdOf(n.id));
    const seen = new Set(queue);
    while (queue.length) {
      const fid = queue.shift()!;
      const f = g.frames?.find((x) => x.id === fid);
      if (!f) continue;
      frames.set(frameRfId(fid), f.position);
      const m = frameMembers(f, tnodes, g.frames);
      for (const id of m.nodes) if (!ids.has(id)) members.set(id, g.nodes.find((n) => n.id === id)!.position);
      for (const id of m.frames)
        if (!seen.has(id) && !ids.has(frameRfId(id))) {
          seen.add(id);
          queue.push(id);
          members.set(frameRfId(id), g.frames!.find((x) => x.id === id)!.position);
        }
    }
    const one = dragged.length === 1 && dragged[0].type === 'dr' ? dragged[0].id : null;
    drag.current = { members, frames, single: one && useSettings.getState().insertOnWire ? one : null };
    useGraphUi.setState({ insertNode: drag.current.single });
  };
  const findInsertEdge = (id: string, pos: Pt): string | null => {
    const size = nodeSizes.measured(id) ?? DEFAULT_NODE_SIZE;
    const r = { x: pos.x + 4, y: pos.y + 4, w: size.width - 8, h: size.height - 8 };
    const c = { x: pos.x + size.width / 2, y: pos.y + size.height / 2 };
    let best: { id: string; d: number } | null = null;
    for (const e of currentGraph().edges) {
      if (e.from.node === id || e.to.node === id) continue;
      for (const p of edgePoints(wrap.current, e.id, 32)) {
        if (p.x < r.x || p.x > r.x + r.w || p.y < r.y || p.y > r.y + r.h) continue;
        const d = Math.hypot(p.x - c.x, p.y - c.y);
        if (!best || d < best.d) best = { id: e.id, d };
      }
    }
    return best && GE.canInsertOnEdge(id, best.id) ? best.id : null;
  };
  const onNodeDrag = (e: MouseEvent | TouchEvent, _: AnyNode, dragged: AnyNode[]) => {
    const d = drag.current;
    if (!d) return;
    if (d.frames.size && d.members.size) {
      // all dragged frames move by the same delta: use the first one's
      const [fid, start] = [...d.frames][0];
      const now = dragged.find((n) => n.id === fid)?.position;
      if (now) {
        const dx = now.x - start.x;
        const dy = now.y - start.y;
        for (const [id, p] of d.members) live.current.set(id, { x: p.x + dx, y: p.y + dy });
        setNodes((ns) => ns.map((n) => (live.current.has(n.id) ? { ...n, position: live.current.get(n.id)! } : n)));
      }
    }
    if (d.single) {
      const alt = e.altKey;
      const pos = dragged[0].position;
      const check = () => {
        lastCheck.current = performance.now();
        const hit = alt ? null : findInsertEdge(d.single!, pos);
        if (hit !== useGraphUi.getState().insertEdge) useGraphUi.setState({ insertEdge: hit });
      };
      // hit-test at most every 40 ms, plus once more after the last move
      cancelAnimationFrame(raf.current);
      if (performance.now() - lastCheck.current > 40) check();
      else raf.current = requestAnimationFrame(check);
    }
  };
  const onNodeDragStop = (e: MouseEvent | TouchEvent, _: AnyNode, dragged: AnyNode[]) => {
    cancelAnimationFrame(raf.current);
    const d = drag.current;
    drag.current = null;
    const np: Record<string, Pt> = {};
    const fp: Record<string, Pt> = {};
    const put = (id: string, p: Pt) => {
      const q = { x: Math.round(p.x), y: Math.round(p.y) };
      if (isFrameRfId(id)) fp[frameIdOf(id)] = q;
      else np[id] = q;
    };
    for (const n of dragged) put(n.id, n.position);
    for (const [id, p] of live.current) put(id, p);
    live.current.clear();
    const target = useGraphUi.getState().insertEdge;
    useGraphUi.setState({ insertEdge: null });
    if (d?.single && target && !e.altKey && GE.insertOnEdge(d.single, target, np[d.single])) return;
    GE.moveItems(np, fp);
  };

  // --- context menus
  const nodeMenu = (id: string): MenuItem[] => {
    const n = currentGraph().nodes.find((x) => x.id === id);
    if (!n) return [];
    const items: MenuItem[] = [
      { label: 'View in Viewer', icon: 'eye', keys: '1', run: () => A.viewNode(id) },
      { label: 'Pin to Compare', icon: 'tag_blue', keys: 'Shift+K', run: () => pinToCompare(id) },
      { label: n.bypass ? 'Enable (Un-bypass)' : 'Bypass', icon: 'link_break', keys: 'B', run: () => A.toggleBypass([id]) },
      { cmd: 'node.rename' },
      { label: n.collapsed ? 'Expand' : 'Collapse', icon: 'bullet_arrow_up', keys: 'H', run: () => GE.setCollapsed(undefined, !n.collapsed) },
      {
        label: 'Colour Tag',
        icon: 'color_swatch',
        submenu: () => colorItems((c) => GE.setNodeColor(undefined, c), () => pickColor(n.color ?? '', (c) => GE.setNodeColor(undefined, c))),
      },
    ];
    if (n.type === GROUP) {
      items.push({ sep: true }, { cmd: 'edit.enterGroup' }, { cmd: 'edit.ungroup' }, { cmd: 'node.savePreset' });
    }
    if (n.type === OUTPUT && !path.length) items.push({ label: 'Use as Project Output', icon: 'flag_finish', run: () => A.setOutputNode(id) });
    items.push(
      { sep: true },
      { cmd: 'graph.selectUp' },
      { cmd: 'graph.selectDown' },
      { sep: true },
      { cmd: 'edit.cut' },
      { cmd: 'edit.copy' },
      { cmd: 'edit.duplicate' },
      { cmd: 'edit.delete' },
      { sep: true },
      { cmd: 'edit.group' },
      { cmd: 'graph.frame' },
    );
    return items;
  };
  const frameMenu = (fid: string): MenuItem[] => {
    const f = currentGraph().frames?.find((x) => x.id === fid);
    if (!f) return [];
    return [
      { label: 'Rename', icon: 'textfield_rename', run: () => useGraphUi.setState({ renaming: 'frame:' + fid }) },
      { label: f.kind === 'note' || f.note ? 'Edit Note' : 'Add Note', icon: 'note_edit', run: () => useGraphUi.setState({ renaming: 'note:' + fid }) },
      { label: 'Colour', icon: 'color_swatch', submenu: () => colorItems((c) => GE.updateFrame(fid, { color: c }), () => pickColor(f.color ?? '', (c) => GE.updateFrame(fid, { color: c })), false) },
      { sep: true },
      {
        label: 'Select Contents',
        icon: 'table_select_all',
        run: () => {
          const g = currentGraph();
          const m = frameMembers(
            f,
            g.nodes.map((n) => ({ id: n.id, position: n.position, size: nodeSizes.measured(n.id) })),
          );
          setSelection(m.nodes.sort());
        },
      },
      { label: f.kind === 'note' ? 'Delete Note' : 'Delete Frame', icon: 'cross', run: () => GE.deleteFrames([fid]) },
    ];
  };
  const paneMenu = (e: React.MouseEvent | MouseEvent): MenuItem[] => {
    const at = () => clientToFlow(e.clientX, e.clientY);
    return [
      { label: 'Add Node…', icon: 'add', keys: 'Tab', run: () => openQuickAddAt(e.clientX, e.clientY) },
      { label: 'Add Node', icon: 'node_design', submenu: () => addNodeMenus(at) },
      { sep: true },
      { label: 'Add Frame', icon: 'shape_square_add', run: () => void GE.addFrame(at()) },
      { label: 'Add Sticky Note', icon: 'note_add', run: () => void GE.addFrame(at(), 'note') },
      { sep: true },
      { cmd: 'graph.tidy' },
      { cmd: 'edit.paste' },
      { cmd: 'edit.selectAll' },
      { cmd: 'view.fitGraph' },
    ];
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const pos = clientToFlow(e.clientX, e.clientY);
    const spec = e.dataTransfer.getData(DND_TYPE);
    if (spec) {
      // dropped onto a wire: insert there
      const hit = (e.target as Element).closest?.('.react-flow__edge') as HTMLElement | null;
      A.addNode(JSON.parse(spec), { x: pos.x - 70, y: pos.y - 20 }, undefined, hit?.dataset.id && useSettings.getState().insertOnWire ? { edge: hit.dataset.id } : {});
      return;
    }
    if (e.dataTransfer.files.length) void importImageFiles([...e.dataTransfer.files], pos);
  };

  const [vert, horiz] = minimapPos.split('-');
  return (
    <div
      className="flow-wrap"
      ref={wrap}
      onMouseMove={(e) => (mouse.current = { x: e.clientX, y: e.clientY, inside: true })}
      onMouseLeave={() => (mouse.current.inside = false)}
      onMouseDownCapture={onMouseDownCapture}
      onContextMenuCapture={(e) => {
        if (suppressCtx.current) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(DND_TYPE) || e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }
      }}
      onDrop={onDrop}
    >
      <ReactFlow<AnyNode, RfEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectEnd={onConnectEnd}
        isValidConnection={isValidConnection}
        onNodeDragStart={onNodeDragStart}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        onNodeDoubleClick={(_, n) => {
          if (n.type !== 'dr') return;
          if (n.data.node.type === GROUP) A.enterGroup(n.id);
          else A.viewNode(n.id);
        }}
        onEdgeClick={(e, edge) => {
          if (e.altKey) {
            e.stopPropagation();
            A.removeEdges([edge.id]);
          }
        }}
        onEdgeMouseEnter={(_, edge) => useGraphUi.setState({ hoverEdge: edge.id })}
        onEdgeMouseLeave={() => useGraphUi.setState({ hoverEdge: null })}
        onPaneContextMenu={(e) => {
          e.preventDefault();
          if (suppressCtx.current) return;
          if (e.shiftKey) ctx.open(e, paneMenu(e));
          else openQuickAddAt(e.clientX, e.clientY);
        }}
        onNodeContextMenu={(e, n) => {
          e.preventDefault();
          if (suppressCtx.current) return;
          if (isFrameRfId(n.id)) {
            useGraphUi.setState({ frameSelection: [frameIdOf(n.id)] });
            ctx.open(e, frameMenu(frameIdOf(n.id)));
            return;
          }
          if (!useDoc.getState().selection.includes(n.id)) setSelection([n.id]);
          ctx.open(e, nodeMenu(n.id));
        }}
        onEdgeContextMenu={(e, edge) => {
          e.preventDefault();
          if (suppressCtx.current) return;
          ctx.open(e, [
            { label: 'Delete Connection', icon: 'disconnect', keys: 'Alt+Click', run: () => A.removeEdges([edge.id]) },
            { sep: true },
            { label: 'Insert Node…', icon: 'connect', keys: 'Tab', run: () => openQuickAddAt(e.clientX, e.clientY, undefined, { edge: edge.id }) },
            { label: 'Insert Node', icon: 'add', submenu: () => addNodeMenus(() => clientToFlow(e.clientX, e.clientY), { edge: edge.id }) },
          ]);
        }}
        onSelectionContextMenu={(e) => {
          e.preventDefault();
          ctx.open(e, [
            { cmd: 'edit.group' },
            { cmd: 'graph.frame' },
            { label: 'Save as Preset…', icon: 'star', run: savePresetFromSelection },
            { cmd: 'node.bypass' },
            { label: 'Collapse / Expand', icon: 'bullet_arrow_up', keys: 'H', run: () => GE.setCollapsed(undefined) },
            { label: 'Colour Tag', icon: 'color_swatch', submenu: () => colorItems((c) => GE.setNodeColor(undefined, c), () => pickColor('', (c) => GE.setNodeColor(undefined, c))) },
            { sep: true },
            { cmd: 'graph.tidy' },
            { cmd: 'graph.alignLeft' },
            { cmd: 'graph.alignTop' },
            { cmd: 'graph.distributeH' },
            { cmd: 'graph.distributeV' },
            { sep: true },
            { cmd: 'edit.copy' },
            { cmd: 'edit.duplicate' },
            { cmd: 'edit.delete' },
          ]);
        }}
        deleteKeyCode={null}
        selectionKeyCode="Shift"
        multiSelectionKeyCode={['Meta', 'Control', 'Shift']}
        panOnDrag={[1]}
        selectionOnDrag
        panActivationKeyCode="Space"
        zoomOnDoubleClick={false}
        minZoom={0.1}
        maxZoom={3}
        snapToGrid={snap}
        snapGrid={[gridSize, gridSize]}
        connectionRadius={24}
        defaultEdgeOptions={{ type: wire }}
        connectionLineType={wire === 'default' ? ConnectionLineType.Bezier : (wire as ConnectionLineType)}
        fitView
        fitViewOptions={{ padding: fitPadding() }}
        attributionPosition={horiz === 'right' ? 'bottom-left' : 'bottom-right'}
      >
        {gridStyle === 'lines' && <Background variant={BackgroundVariant.Lines} gap={20} color={tm.grid} lineWidth={1} />}
        {gridStyle === 'lines' && <Background id="major" variant={BackgroundVariant.Lines} gap={100} color={tm.gridMajor} lineWidth={1} />}
        {gridStyle === 'dots' && <Background variant={BackgroundVariant.Dots} gap={20} size={1.6} color={tm.gridDot} />}
        {minimap && (
          <MiniMap
            pannable
            zoomable
            position={minimapPos as PanelPosition}
            className={`minimap mm-${vert}`}
            nodeColor={(n) => (n.type === 'frame' ? 'transparent' : nodeColor((n.data as DrNode['data']).node.type))}
            nodeStrokeColor={(n) => (n.type === 'frame' ? tagColor((n.data as FrameNode['data']).frame.color || 'blue') : tm.minimapStroke)}
            nodeBorderRadius={tm.minimapRadius}
            maskColor={tm.minimapMask}
            bgColor={tm.minimapBg}
          />
        )}
        <RfPanel position={minimapPos as PanelPosition} className={`mm-toggle-panel mm-${vert} mm-${horiz}`}>
          <button
            className={'mm-toggle' + (minimap ? ' on' : '')}
            title={(minimap ? 'Hide' : 'Show') + ' the minimap (Shift+M) · right-click to move it'}
            onClick={() => setPref('minimap', !minimap)}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              ctx.open(
                e,
                (['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const).map((p) => ({
                  label: p.replace('-', ' ').replace(/^\w/, (c) => c.toUpperCase()),
                  checked: minimapPos === p,
                  run: () => setPref('minimapPos', p),
                })),
              );
            }}
          >
            <Icon name="map" />
          </button>
        </RfPanel>
      </ReactFlow>
      {knife && (
        <svg className="knife-overlay">
          <polyline points={knife.map((p) => `${p.x},${p.y}`).join(' ')} />
        </svg>
      )}
      {graph.nodes.length === 0 && !graph.frames?.length && (
        <div className="flow-empty">
          <Icon name="node_design" size={32} />
          <div>Empty graph</div>
          <div className="muted">Press Tab or right-click to add a node · drop images here to import</div>
        </div>
      )}
      <QuickAdd />
      <GraphDialogs />
      {ctx.el}
    </div>
  );
}

function GraphTools() {
  const count = useDoc((s) => currentGraph(s).nodes.length);
  return (
    <span className="graph-tools">
      <button className="tbtn small" title="Tidy Up Graph (Shift+L) — the selection, or everything" onClick={GE.tidyUp}>
        <Icon name="chart_organisation" />
      </button>
      <button className="tbtn small" title="Frame Selection (Ctrl+J)" onClick={() => void GE.addFrame(graphApi.mouseFlowPos() ?? undefined)}>
        <Icon name="shape_square_add" />
      </button>
      <button className="tbtn small" title="Add Sticky Note (Shift+N)" onClick={() => void GE.addFrame(undefined, 'note')}>
        <Icon name="note_add" />
      </button>
      <span className="panel-meta">
        {count} node{count === 1 ? '' : 's'}
      </span>
    </span>
  );
}

export function GraphEditor() {
  const depth = useDoc((s) => s.path.length);
  return (
    <Panel title={depth ? 'Node Graph — Group' : 'Node Graph'} icon="node_design" className="graph-panel" tools={<GraphTools />}>
      <Breadcrumb />
      <ReactFlowProvider>
        <Flow />
      </ReactFlowProvider>
    </Panel>
  );
}

