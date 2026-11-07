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
}

export const useToolUi = create<ToolUiState>(() => ({ pointMode: 1, brushSize: 80, brushHardness: 0.6, erase: false, doneFor: null, tint: true }));

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
}

function ownTool(n: GraphNode) {
  return toolDef(getNodeDef(n.type)?.viewerTool);
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
    };
  }
  // a group (e.g. a preset): the first inner node with a tool whose param is exposed on the group
  if (n.type === GROUP && n.group) {
    for (const inner of n.group.graph.nodes) {
      const d = ownTool(inner);
      if (!d) continue;
      const ex = (p?: string) => (p ? n.group!.exposed.find((e) => e.node === inner.id && e.param === p)?.key : undefined);
      const keys = { param: ex(d.param), vec2: ex(d.vec2Param), box: ex(d.boxParam) };
      if (!keys.param && !keys.vec2) continue;
      return {
        def: d,
        nodeId: n.id,
        keys,
        values: { param: keys.param ? n.params[keys.param] : undefined, vec2: keys.vec2 ? n.params[keys.vec2] : undefined, box: keys.box ? n.params[keys.box] : undefined },
        flat: flatId(s.path, n.id) + '/' + inner.id,
        name: d.label ?? nodeName(inner),
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
