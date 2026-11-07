/**
 * Viewer tools: which node's tool is active (from the selection), tool UI state (not saved in the
 * document), and param editing with gesture-level undo (a whole brush stroke / point drag = one step).
 */
import { create } from 'zustand';
import { GROUP } from '../../core/graph';
import { getNodeDef } from '../../core/registry';
import type { GraphNode, ParamValue, ViewerToolDef } from '../../core/types';
import { nodeName, setParam } from '../../store/actions';
import { currentGraph, useDoc, type DocState } from '../../store/doc';
import { flatId } from '../../store/graphPath';
import { toolDef } from './data';

export interface ToolUiState {
  /** Points: label of new points (1 positive, 0 negative). Shift / Alt override per click. */
  pointMode: 1 | 0;
  /** Brush diameter in full-resolution image pixels. */
  brushSize: number;
  brushHardness: number;
  erase: boolean;
  /** Flat id whose tool was dismissed with Done (re-shown when the selection changes). */
  doneFor: string | null;
  /** Show the mask tint. */
  tint: boolean;
  /** Multi-handle tools: index (into ActiveTool.handles) of the handle a click on empty space moves. */
  activeHandle: number;
}

export const useToolUi = create<ToolUiState>(() => ({ pointMode: 1, brushSize: 80, brushHardness: 0.6, erase: false, doneFor: null, tint: true, activeHandle: 0 }));

export interface ActiveTool {
  def: ViewerToolDef;
  /** Node at the current graph level whose params are edited (the tool node, or a group exposing its params). */
  nodeId: string;
  /** Keys on that node (exposed keys for a group). */
  keys: { param?: string; vec2?: string; box?: string };
  values: { param?: ParamValue; vec2?: ParamValue; box?: ParamValue };
  /** Engine flat id of the node that owns the tool (for the mask preview). */
  flat: string;
  name: string;
  /** Multi-handle points tool (ViewerToolDef.handles): the editable handles, keyed on the edited node. */
  handles?: ToolHandle[];
}

export interface ToolHandle {
  /** Param key on the edited node (exposed key for a group). */
  key: string;
  label: string;
  on: boolean;
  value: number[] | null;
  color?: number[];
}

function ownTool(n: GraphNode) {
  return toolDef(getNodeDef(n.type)?.viewerTool);
}

/**
 * Handles of a multi-handle tool. `inner` is the node with the tool; `outer` the edited node (the same
 * node, or a group exposing the handle params: handles whose param is not exposed are left out).
 */
function resolveHandles(def: ViewerToolDef, inner: GraphNode, exposedKey: (p: string) => string | undefined, outer: GraphNode): ToolHandle[] | undefined {
  if (!def.handles?.length) return undefined;
  const pdefs = getNodeDef(inner.type)?.params ?? {};
  const read = (p: string): ParamValue | undefined => {
    const k = exposedKey(p);
    return (k ? outer.params[k] : inner.params[p]) ?? pdefs[p]?.default;
  };
  const out: ToolHandle[] = [];
  def.handles.forEach((h, i) => {
    const key = exposedKey(h.param);
    if (!key) return;
    const v = read(h.param);
    const c = h.colorParam ? read(h.colorParam) : undefined;
    out.push({
      key,
      label: h.label ?? String(i + 1),
      on: h.enabledBy ? !!read(h.enabledBy) : true,
      value: Array.isArray(v) ? (v as number[]) : null,
      color: Array.isArray(c) ? (c as number[]) : undefined,
    });
  });
  return out;
}

/** The active tool for the current selection, or null. */
export function resolveTool(s: DocState): ActiveTool | null {
  if (s.selection.length !== 1) return null;
  const g = currentGraph(s);
  const n = g.nodes.find((x) => x.id === s.selection[0]);
  if (!n) return null;
  const own = ownTool(n);
  if (own) {
    return {
      def: own,
      nodeId: n.id,
      keys: { param: own.param, vec2: own.vec2Param, box: own.boxParam },
      values: { param: own.param ? n.params[own.param] : undefined, vec2: own.vec2Param ? n.params[own.vec2Param] : undefined, box: own.boxParam ? n.params[own.boxParam] : undefined },
      flat: flatId(s.path, n.id),
      name: own.label ?? nodeName(n),
      handles: resolveHandles(own, n, (p) => p, n),
    };
  }
  // a group (e.g. a preset): the first inner node with a tool whose param is exposed on the group
  if (n.type === GROUP && n.group) {
    for (const inner of n.group.graph.nodes) {
      const d = ownTool(inner);
      if (!d) continue;
      const ex = (p?: string) => (p ? n.group!.exposed.find((e) => e.node === inner.id && e.param === p)?.key : undefined);
      const keys = { param: ex(d.param), vec2: ex(d.vec2Param), box: ex(d.boxParam) };
      const handles = resolveHandles(d, inner, ex, n);
      if (!keys.param && !keys.vec2 && !handles?.length) continue;
      return {
        def: d,
        nodeId: n.id,
        keys,
        values: { param: keys.param ? n.params[keys.param] : undefined, vec2: keys.vec2 ? n.params[keys.vec2] : undefined, box: keys.box ? n.params[keys.box] : undefined },
        flat: flatId(s.path, n.id) + '/' + inner.id,
        name: d.label ?? nodeName(inner),
        handles,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// editing with gesture undo
// ---------------------------------------------------------------------------
let gestureMark: { before: unknown; active: boolean } | null = null;

/** Start a gesture: the next edit becomes a new undo step, later edits of the gesture merge into it. */
export function beginGesture() {
  const s = useDoc.getState();
  gestureMark = { before: s.past[s.past.length - 1], active: false };
}

/** Set a tool param. Inside a gesture, all edits collapse into one undo step at endGesture(). */
export function editParam(nodeId: string, key: string, value: ParamValue) {
  if (gestureMark && !gestureMark.active) {
    gestureMark.active = true;
    setParam(nodeId, key, value, false); // a fresh undo step
  } else setParam(nodeId, key, value, !!gestureMark);
}

export function endGesture() {
  const m = gestureMark;
  gestureMark = null;
  if (!m?.active) return;
  const s = useDoc.getState();
  const i = m.before === undefined ? -1 : s.past.lastIndexOf(m.before as DocState['past'][number]);
  if (m.before !== undefined && i < 0) return; // history was trimmed meanwhile: leave it
  if (s.past.length > i + 2) useDoc.setState({ past: s.past.slice(0, i + 2) });
}
