import { create } from 'zustand';
import { DEFAULT_NODE_SIZE, type Size } from '../core/graphLayout';
import { GROUP } from '../core/graph';
import type { GraphNode } from '../core/types';
import { useSettings } from './settings';

/**
 * Transient node-graph editor state that isn't part of the document: selected frames,
 * the wire under the cursor / a dragged node, inline rename, editor dialogs.
 */
export interface GraphUiState {
  /** Selected frame ids at the current level (nodes live in useDoc.selection). */
  frameSelection: string[];
  /** Edge id highlighted as the insert-on-wire target while dragging a node. */
  insertEdge: string | null;
  /** The node being dragged while insert-on-wire is armed. */
  insertNode: string | null;
  /** Edge under the mouse (quick-add inserts onto it). */
  hoverEdge: string | null;
  /** Edge temporarily hidden while Ctrl/⌘-dragging it off an input. */
  detachedEdge: string | null;
  /** Node / frame being renamed inline. */
  renaming: string | null;
  /** Context of the open quick-add popup: insert onto a wire / auto-connect to the selection. */
  qa: { edge?: string; auto?: boolean };
  /** Editor dialogs. */
  dialog: { kind: 'savePreset'; groupId: string } | { kind: 'confirmDelete'; count: number; run: () => void } | null;
}

export const useGraphUi = create<GraphUiState>(() => ({
  frameSelection: [],
  insertEdge: null,
  insertNode: null,
  hoverEdge: null,
  detachedEdge: null,
  renaming: null,
  qa: {},
  dialog: null,
}));

/** Measured node sizes, provided by the mounted graph editor (React Flow knows them). */
export const nodeSizes = {
  measured: (_id: string): Size | undefined => undefined,
};

/** A node's size: measured if it is on screen, else an estimate from its ports / thumbnail. */
export function sizeOf(n: GraphNode, rows = 1): Size {
  const m = nodeSizes.measured(n.id);
  if (m) return m;
  return estimateSize(n, rows);
}

export function estimateSize(n: Pick<GraphNode, 'type' | 'collapsed'>, rows = 1): Size {
  if (n.collapsed) return { width: DEFAULT_NODE_SIZE.width, height: 22 };
  const thumbs = useSettings.getState().nodeThumbnails;
  return { width: DEFAULT_NODE_SIZE.width, height: 26 + (n.type === GROUP ? 16 : 0) + Math.max(1, rows) * 16 + 8 + (thumbs ? 99 : 0) };
}

// test / console hook (like __darkroomAi): the graph editor's transient state
(globalThis as Record<string, unknown>).__darkroomGraphUi = useGraphUi;
