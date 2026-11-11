/**
 * Diagnostics: an in-app log of errors, warnings and (in verbose mode) render / AI-job activity,
 * shown in Window › Diagnostics and as on-screen notifications. Sources:
 *   - engine hooks (cpu() jobs started / finished / failed / cancelled, node errors)
 *   - console messages that start with "[darkroom" (warn/error always; info/log only when verbose)
 *   - uncaught errors and unhandled promise rejections
 *   - a feedback-loop detector: a node whose cpu() keeps re-running without any edit
 */
import { create } from 'zustand';
import { engineHooks } from './engine';

export type Level = 'error' | 'warn' | 'info' | 'debug';

export interface DiagEvent {
  id: number;
  /** ms since epoch of the first occurrence; `last` = latest repeat. */
  t: number;
  last: number;
  level: Level;
  source: string;
  message: string;
  detail?: string;
  /** Flat node id (group-inner ids look like "g/inner"). */
  nodeId?: string;
  nodeType?: string;
  /** Identical consecutive events are folded into one with a count. */
  count: number;
}

interface DiagState {
  events: DiagEvent[];
  /** Events to show as notifications (errors / loop warnings), newest last. */
  toasts: DiagEvent[];
  open: boolean;
  /** Event to highlight when the window opens from a notification. */
  focus: number | null;
}

const MAX = 2000;
export const useDiag = create<DiagState>(() => ({ events: [], toasts: [], open: false, focus: null }));

/** Settings are read lazily (diag loads before the settings store). */
let settings: () => { verbose: boolean; toasts: boolean } = () => ({ verbose: false, toasts: true });
export function bindDiagSettings(fn: () => { verbose: boolean; toasts: boolean }) {
  settings = fn;
}
export const verbose = () => settings().verbose;

let nextId = 1;
export function log(level: Level, source: string, message: string, extra: { detail?: string; nodeId?: string; nodeType?: string; toast?: boolean } = {}) {
  if (level === 'debug' && !verbose()) return;
  const now = Date.now();
  const s = useDiag.getState();
  const prev = s.events[s.events.length - 1];
  let ev: DiagEvent;
  let events: DiagEvent[];
  if (prev && prev.level === level && prev.source === source && prev.message === message && prev.nodeId === extra.nodeId) {
    ev = { ...prev, last: now, count: prev.count + 1, detail: extra.detail ?? prev.detail };
    events = [...s.events.slice(0, -1), ev];
  } else {
    ev = { id: nextId++, t: now, last: now, level, source, message, count: 1, ...extra };
    events = [...s.events, ev].slice(-MAX);
  }
  const wantToast = (extra.toast ?? level === 'error') && settings().toasts && ev.count === 1;
  useDiag.setState({ events, toasts: wantToast ? [...s.toasts.filter((x) => x.id !== ev.id), ev].slice(-4) : s.toasts });
}

export const dismissToast = (id: number) => useDiag.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
export const clearDiag = () => useDiag.setState({ events: [], toasts: [] });
export const openDiagnostics = (focus: number | null = null) => useDiag.setState({ open: true, focus });
export const closeDiagnostics = () => useDiag.setState({ open: false });

/** Plain-text export of the log. */
export function diagText(events = useDiag.getState().events) {
  return events
    .map((e) => {
      const t = new Date(e.t).toISOString().replace('T', ' ').slice(0, 23);
      const n = e.nodeId ? ` [${e.nodeType ?? ''} ${e.nodeId}]` : '';
      return `${t} ${e.level.toUpperCase().padEnd(5)} ${e.source}${n}: ${e.message}${e.count > 1 ? ` (×${e.count})` : ''}${e.detail ? '\n    ' + e.detail.replace(/\n/g, '\n    ') : ''}`;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Feedback-loop detector
// ---------------------------------------------------------------------------
/** Window and threshold: this many cpu() starts of one node within LOOP_MS with no edit in between. */
const LOOP_MS = 20000;
const LOOP_RUNS = 6;
const starts = new Map<string, number[]>();
const warned = new Map<string, number>();
let lastEdit = 0;
/** Call when the user edits the document (the store subscribes in initDiagnostics). */
export const noteEdit = (now = Date.now()) => {
  lastEdit = now;
};

export function detectLoop(nodeId: string, type: string, now = Date.now()) {
  const arr = (starts.get(nodeId) ?? []).filter((t) => now - t < LOOP_MS && t > lastEdit);
  arr.push(now);
  starts.set(nodeId, arr);
  if (arr.length >= LOOP_RUNS && now - (warned.get(nodeId) ?? 0) > 60000) {
    warned.set(nodeId, now);
    log('warn', 'loop', `“${type}” re-ran ${arr.length}× in ${Math.round((now - arr[0]) / 1000)} s without any edit — likely a feedback loop (its input keeps changing, e.g. resolution or size).`, {
      nodeId,
      nodeType: type,
      toast: true,
      detail: 'Open Window › Diagnostics with verbose mode on to see each render and job. Please report this as a bug if it keeps happening.',
    });
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
let installed = false;
export function initDiagnostics() {
  if (installed) return;
  installed = true;

  engineHooks.onCpuStart = (id, type) => {
    if (verbose()) log('debug', 'job', `start ${type}`, { nodeId: id, nodeType: type });
    detectLoop(id, type);
  };
  engineHooks.onCpuDone = (id, type, ms) => verbose() && log('debug', 'job', `done ${type} in ${Math.round(ms)} ms`, { nodeId: id, nodeType: type });
  engineHooks.onCpuCancel = (id, type) => verbose() && log('debug', 'job', `superseded ${type}`, { nodeId: id, nodeType: type });
  engineHooks.onCpuError = (id, type, e) =>
    log('error', 'node', `${type}: ${String((e as Error)?.message ?? e)}`, { nodeId: id, nodeType: type, detail: (e as Error)?.stack });
  engineHooks.onNodeError = (id, type, msg) => {
    if (msg.startsWith('[pending]')) return;
    // async failures already arrived through onCpuError with the same text; don't notify twice
    const recent = useDiag.getState().events.slice(-20).some((e) => e.nodeId === id && e.message.endsWith(msg.split('\n')[0]));
    if (!recent) log('error', 'node', `${type}: ${msg.split('\n')[0]}`, { nodeId: id, nodeType: type, detail: msg.includes('\n') ? msg : undefined });
  };

  // console capture: only the app's own "[darkroom …]" messages
  const wrap = (method: 'error' | 'warn' | 'info' | 'log', level: Level) => {
    const orig = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      orig(...args);
      const first = args[0];
      if (typeof first !== 'string' || !first.startsWith('[darkroom')) return;
      if ((level === 'info' || level === 'debug') && !verbose()) return;
      const m = /^\[darkroom ?([^\]]*)\]\s*/.exec(first);
      const source = m?.[1] || 'app';
      const rest = args.slice(1).map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : safeJson(a))).join(' ');
      const err = args.find((a): a is Error => a instanceof Error);
      log(level, source, (first.slice(m?.[0].length ?? 0) + (rest ? ' ' + rest : '')).trim(), { detail: err?.stack });
    };
  };
  wrap('error', 'error');
  wrap('warn', 'warn');
  wrap('info', 'debug');
  wrap('log', 'debug');

  window.addEventListener('error', (e) => log('error', 'app', e.message || 'Uncaught error', { detail: e.error?.stack ?? `${e.filename}:${e.lineno}` }));
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason as Error | undefined;
    if (r?.name === 'AbortError') return; // superseded jobs are expected
    log('error', 'app', `Unhandled: ${String(r?.message ?? r)}`, { detail: r?.stack });
  });
}

function safeJson(v: unknown) {
  try {
    return JSON.stringify(v).slice(0, 300);
  } catch {
    return String(v);
  }
}
