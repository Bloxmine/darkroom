import { create } from 'zustand';
import { OUTPUT } from '../core/graph';
import type { Graph, Project } from '../core/types';
import { graphAt, updateGraphAt, validPath } from './graphPath';

/**
 * The document store: project + editing context (group path, selection,
 * viewed node) + undo history.
 */
interface Snapshot {
  project: Project;
  path: string[];
  viewed: string | null;
}

export interface DocState {
  project: Project;
  /** Nested group ids being edited (empty = root graph). */
  path: string[];
  /** Selected node ids at the current level. */
  selection: string[];
  /** Selected edge ids at the current level. */
  edgeSelection: string[];
  /** Flat engine id of the node shown in the viewer; null = project output. */
  viewed: string | null;
  past: Snapshot[];
  future: Snapshot[];
  dirty: boolean;
  /** Bumped on project load / new so views can refit. */
  loadCount: number;
}

export const emptyProject = (): Project => ({ version: 1, name: 'Untitled', graph: { nodes: [], edges: [] }, assets: {} });

export const useDoc = create<DocState>(() => ({
  project: emptyProject(),
  path: [],
  selection: [],
  edgeSelection: [],
  viewed: null,
  past: [],
  future: [],
  dirty: false,
  loadCount: 0,
}));

const MAX_HISTORY = 200;
let lastCoalesce: { key: string; t: number } | null = null;

const snap = (s: DocState): Snapshot => ({ project: s.project, path: s.path, viewed: s.viewed });

export interface CommitOpts {
  /** Consecutive commits with the same key within ~1s merge into one undo step (slider drags). */
  coalesce?: string;
  /** Don't mark dirty / record history (e.g. pure UI state stored in the doc). */
  silent?: boolean;
}

/** Replace the whole project, recording an undo step. */
export function commitProject(fn: (p: Project) => Project, opts: CommitOpts = {}) {
  const s = useDoc.getState();
  const next = fn(s.project);
  if (next === s.project) return;
  if (opts.silent) {
    useDoc.setState({ project: next });
    return;
  }
  const now = performance.now();
  const merge = !!opts.coalesce && lastCoalesce?.key === opts.coalesce && now - lastCoalesce.t < 1200;
  lastCoalesce = opts.coalesce ? { key: opts.coalesce, t: now } : null;
  useDoc.setState({
    project: next,
    past: merge ? s.past : [...s.past.slice(-MAX_HISTORY + 1), snap(s)],
    future: [],
    dirty: true,
  });
}

/** Mutate the graph at the current group path. */
export function commitGraph(fn: (g: Graph) => Graph, opts: CommitOpts = {}) {
  const { path } = useDoc.getState();
  commitProject((p) => {
    const cur = graphAt(p.graph, path);
    if (!cur) return p;
    const ng = fn(cur);
    if (ng === cur) return p;
    return { ...p, graph: updateGraphAt(p.graph, path, () => ng) };
  }, opts);
}

/** The graph currently being edited. */
export function currentGraph(s: DocState = useDoc.getState()): Graph {
  return graphAt(s.project.graph, s.path) ?? s.project.graph;
}

function restore(s: DocState, sn: Snapshot): Partial<DocState> {
  const path = validPath(sn.project.graph, sn.path);
  const g = graphAt(sn.project.graph, path)!;
  const ids = new Set(g.nodes.map((n) => n.id));
  return {
    project: sn.project,
    path,
    viewed: sn.viewed,
    selection: s.selection.filter((id) => ids.has(id)),
    edgeSelection: [],
    dirty: true,
  };
}

export function undo() {
  const s = useDoc.getState();
  const prev = s.past[s.past.length - 1];
  if (!prev) return;
  lastCoalesce = null;
  useDoc.setState({ ...restore(s, prev), past: s.past.slice(0, -1), future: [snap(s), ...s.future] });
}

export function redo() {
  const s = useDoc.getState();
  const next = s.future[0];
  if (!next) return;
  lastCoalesce = null;
  useDoc.setState({ ...restore(s, next), past: [...s.past, snap(s)], future: s.future.slice(1) });
}

/** Replace the document (New / Open / restore). Clears history. */
export function setProject(project: Project, opts: { viewed?: string | null; dirty?: boolean } = {}) {
  lastCoalesce = null;
  useDoc.setState((s) => ({
    project,
    path: [],
    selection: [],
    edgeSelection: [],
    viewed: opts.viewed ?? null,
    past: [],
    future: [],
    dirty: opts.dirty ?? false,
    loadCount: s.loadCount + 1,
  }));
}

export function setSelection(ids: string[], edges: string[] = []) {
  const s = useDoc.getState();
  if (sameIds(s.selection, ids) && sameIds(s.edgeSelection, edges)) return;
  useDoc.setState({ selection: ids, edgeSelection: edges });
}

const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export function setPath(path: string[]) {
  const s = useDoc.getState();
  useDoc.setState({ path: validPath(s.project.graph, path), selection: [], edgeSelection: [] });
}

export function setViewed(flat: string | null) {
  useDoc.setState({ viewed: flat });
}

/** Flat id of the project output node (what export renders). */
export function outputNodeId(p: Project): string | undefined {
  if (p.outputNode && p.graph.nodes.some((n) => n.id === p.outputNode)) return p.outputNode;
  return p.graph.nodes.find((n) => n.type === OUTPUT)?.id;
}

/** The effective viewed flat id (falls back to output). */
export function effectiveViewed(s: DocState = useDoc.getState()): string | undefined {
  if (s.viewed && flatExists(s.project.graph, s.viewed)) return s.viewed;
  return outputNodeId(s.project);
}

export function flatExists(root: Graph, flat: string): boolean {
  const parts = flat.split('/');
  const g = graphAt(root, parts.slice(0, -1));
  return !!g?.nodes.some((n) => n.id === parts[parts.length - 1]);
}

export const markSaved = () => useDoc.setState({ dirty: false });
