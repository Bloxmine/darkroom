import {
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  BackgroundVariant,
  ConnectionLineType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge as RfEdge,
  type EdgeChange,
  type NodeChange,
  type OnConnectEnd,
} from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getPorts, GROUP, OUTPUT, wouldCycle } from '../core/graph';
import { getNodeDef } from '../core/registry';
import * as A from '../store/actions';
import { currentGraph, effectiveViewed, outputNodeId, setSelection, useDoc } from '../store/doc';
import { flatId, localIdForFlat } from '../store/graphPath';
import { importImageFiles } from '../store/io';
import { THEME_META, useSettings } from '../store/settings';
import { useUi } from '../store/ui';
import { Panel } from './Chrome';
import { graphApi } from './commands';
import { Icon, nodeColor } from './Icon';
import { DND_TYPE } from './Library';
import { useContextMenu, type MenuItem } from './Menu';
import { addNodeMenus } from './MenuBar';
import { inHandle, NodeView, outHandle, portOf, type DrNode } from './NodeView';
import { QuickAdd } from './QuickAdd';
import { useRegistry } from './useRegistry';

const nodeTypes = { dr: NodeView };

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

function Flow() {
  const rf = useReactFlow<DrNode, RfEdge>();
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
  // Preferences › Appearance
  const wire = useSettings((s) => s.wireStyle);
  const gridStyle = useSettings((s) => s.grid);
  const minimap = useSettings((s) => s.minimap);
  const tips = useSettings((s) => s.nodeTooltips);
  const wrap = useRef<HTMLDivElement>(null);
  const mouse = useRef<{ x: number; y: number; inside: boolean }>({ x: 0, y: 0, inside: false });
  const ctx = useContextMenu();

  const [nodes, setNodes] = useState<DrNode[]>([]);
  const [edges, setEdges] = useState<RfEdge[]>([]);

  // --- rebuild React Flow nodes/edges from the document
  useEffect(() => {
    const sel = new Set(selection);
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
    setNodes((prev) => {
      const old = new Map(prev.map((n) => [n.id, n]));
      return graph.nodes.map((gn) => {
        const o = old.get(gn.id);
        return {
          id: gn.id,
          type: 'dr',
          position: o?.dragging ? o.position : gn.position,
          measured: o?.measured,
          selected: sel.has(gn.id),
          dragging: o?.dragging,
          domAttributes: tips && getNodeDef(gn.type)?.description ? { title: `${getNodeDef(gn.type)!.name}: ${getNodeDef(gn.type)!.description}` } : undefined,
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
    });
  }, [graph, selection, viewed, errors, pending, path, outId, regV, tips]);

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
          className: (ptype === 'mask' ? 'edge-mask' : '') + (src?.bypass ? ' edge-bypass' : ''),
          style: src ? ({ '--edge-accent': nodeColor(src.type) } as React.CSSProperties) : undefined,
          type: wire,
        };
      }),
    );
  }, [graph, edgeSel, wire]);

  // Selection lives in the doc store (single source of truth); everything else is local RF state.
  const onNodesChange = useCallback((ch: NodeChange<DrNode>[]) => {
    const sel = ch.filter((c) => c.type === 'select');
    const rest = ch.filter((c) => c.type !== 'select');
    if (rest.length) setNodes((ns) => applyNodeChanges(rest, ns));
    if (sel.length) {
      const s = useDoc.getState();
      const set = new Set(s.selection);
      for (const c of sel) {
        if (c.type !== 'select') continue;
        if (c.selected) set.add(c.id);
        else set.delete(c.id);
      }
      setSelection([...set].sort(), s.edgeSelection);
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
    (x: number, y: number, from?: { node: string; port: string; kind: 'source' | 'target' }) => {
      const f = clientToFlow(x, y);
      // from a dragged connection: put the new node's port at the drop point; otherwise centre it
      const flow = from ? (from.kind === 'source' ? { x: f.x + 6, y: f.y - 40 } : { x: f.x - 150, y: f.y - 40 }) : { x: f.x - 75, y: f.y - 20 };
      useUi.setState({ quickAdd: { x, y, flow, from } });
    },
    [clientToFlow],
  );
  useEffect(() => {
    graphApi.fitView = () => void rf.fitView({ padding: 0.25, duration: 200, maxZoom: 1.2 });
    graphApi.mouseFlowPos = () => (mouse.current.inside ? clientToFlow(mouse.current.x, mouse.current.y) : null);
    graphApi.openQuickAdd = () => {
      const r = wrap.current?.getBoundingClientRect();
      if (!r) return;
      const m = mouse.current;
      const x = m.inside ? m.x : r.left + r.width / 2 - 140;
      const y = m.inside ? m.y : r.top + r.height / 3;
      openQuickAddAt(x, y);
    };
  }, [rf, clientToFlow, openQuickAddAt]);

  // fit when entering/leaving groups or loading a project
  const fitTick = useUi((s) => s.fitGraphTick);
  useEffect(() => {
    const t = setTimeout(() => void rf.fitView({ padding: 0.25, maxZoom: 1.1 }), 60);
    return () => clearTimeout(t);
  }, [path.join('/'), loadCount, fitTick, rf]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- connections
  const isValidConnection = useCallback(
    (c: Connection | RfEdge) => c.source !== c.target && !wouldCycle(currentGraph(), c.source, c.target),
    [],
  );
  const onConnect = useCallback((c: Connection) => {
    A.connectPorts({ node: c.source, port: portOf(c.sourceHandle) }, { node: c.target, port: portOf(c.targetHandle) });
  }, []);
  const onConnectEnd: OnConnectEnd = useCallback(
    (event, state) => {
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

  // --- context menus
  const nodeMenu = (id: string): MenuItem[] => {
    const n = currentGraph().nodes.find((x) => x.id === id);
    if (!n) return [];
    const items: MenuItem[] = [
      { label: 'View in Viewer', icon: 'eye', keys: '1', run: () => A.viewNode(id) },
      { label: n.bypass ? 'Enable (Un-bypass)' : 'Bypass', icon: 'link_break', keys: 'B', run: () => A.toggleBypass([id]) },
    ];
    if (n.type === GROUP) {
      items.push({ sep: true }, { cmd: 'edit.enterGroup' }, { cmd: 'edit.ungroup' });
    }
    if (n.type === OUTPUT && !path.length) items.push({ label: 'Use as Project Output', icon: 'flag_finish', run: () => A.setOutputNode(id) });
    items.push({ sep: true }, { cmd: 'edit.cut' }, { cmd: 'edit.copy' }, { cmd: 'edit.duplicate' }, { cmd: 'edit.delete' }, { sep: true }, { cmd: 'edit.group' });
    return items;
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const pos = clientToFlow(e.clientX, e.clientY);
    const spec = e.dataTransfer.getData(DND_TYPE);
    if (spec) {
      A.addNode(JSON.parse(spec), { x: pos.x - 70, y: pos.y - 20 });
      return;
    }
    if (e.dataTransfer.files.length) void importImageFiles([...e.dataTransfer.files], pos);
  };

  return (
    <div
      className="flow-wrap"
      ref={wrap}
      onMouseMove={(e) => (mouse.current = { x: e.clientX, y: e.clientY, inside: true })}
      onMouseLeave={() => (mouse.current.inside = false)}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(DND_TYPE) || e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }
      }}
      onDrop={onDrop}
    >
      <ReactFlow<DrNode, RfEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectEnd={onConnectEnd}
        isValidConnection={isValidConnection}
        onNodeDragStop={(_, __, dragged) => A.moveNodes(Object.fromEntries(dragged.map((n) => [n.id, { x: Math.round(n.position.x), y: Math.round(n.position.y) }])))}
        onNodeDoubleClick={(_, n) => (n.data.node.type === GROUP ? A.enterGroup(n.id) : A.viewNode(n.id))}
        onPaneContextMenu={(e) => {
          e.preventDefault();
          openQuickAddAt(e.clientX, e.clientY);
        }}
        onNodeContextMenu={(e, n) => {
          e.preventDefault();
          if (!useDoc.getState().selection.includes(n.id)) setSelection([n.id]);
          ctx.open(e, nodeMenu(n.id));
        }}
        onEdgeContextMenu={(e, edge) => {
          e.preventDefault();
          ctx.open(e, [
            { label: 'Delete Connection', icon: 'disconnect', run: () => A.removeEdges([edge.id]) },
            { sep: true },
            { label: 'Add Node', icon: 'add', submenu: () => addNodeMenus(() => clientToFlow(e.clientX, e.clientY)) },
          ]);
        }}
        onSelectionContextMenu={(e) => {
          e.preventDefault();
          ctx.open(e, [{ cmd: 'edit.group' }, { cmd: 'node.bypass' }, { sep: true }, { cmd: 'edit.copy' }, { cmd: 'edit.duplicate' }, { cmd: 'edit.delete' }]);
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
        snapToGrid
        snapGrid={[10, 10]}
        connectionRadius={24}
        defaultEdgeOptions={{ type: wire }}
        connectionLineType={wire === 'default' ? ConnectionLineType.Bezier : (wire as ConnectionLineType)}
        fitView
      >
        {gridStyle === 'lines' && <Background variant={BackgroundVariant.Lines} gap={20} color={tm.grid} lineWidth={1} />}
        {gridStyle === 'lines' && <Background id="major" variant={BackgroundVariant.Lines} gap={100} color={tm.gridMajor} lineWidth={1} />}
        {gridStyle === 'dots' && <Background variant={BackgroundVariant.Dots} gap={20} size={1.6} color={tm.gridDot} />}
        {minimap && <MiniMap
          pannable
          zoomable
          className="minimap"
          nodeColor={(n) => nodeColor((n.data as DrNode['data']).node.type)}
          nodeStrokeColor={tm.minimapStroke}
          nodeBorderRadius={tm.minimapRadius}
          maskColor={tm.minimapMask}
          bgColor={tm.minimapBg}
        />}
      </ReactFlow>
      {graph.nodes.length === 0 && (
        <div className="flow-empty">
          <Icon name="node_design" size={32} />
          <div>Empty graph</div>
          <div className="muted">Press Tab or right-click to add a node · drop images here to import</div>
        </div>
      )}
      <QuickAdd />
      {ctx.el}
    </div>
  );
}

export function GraphEditor() {
  const count = useDoc((s) => currentGraph(s).nodes.length);
  const depth = useDoc((s) => s.path.length);
  return (
    <Panel
      title={depth ? 'Node Graph — Group' : 'Node Graph'}
      icon="node_design"
      className="graph-panel"
      tools={
        <span className="panel-meta">
          {count} node{count === 1 ? '' : 's'}
        </span>
      }
    >
      <Breadcrumb />
      <ReactFlowProvider>
        <Flow />
      </ReactFlowProvider>
    </Panel>
  );
}
