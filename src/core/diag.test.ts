import { beforeEach, describe, expect, it } from 'vitest';
import { bindDiagSettings, clearDiag, detectLoop, log, noteEdit, useDiag } from './diag';

describe('diagnostics log', () => {
  beforeEach(() => {
    clearDiag();
    bindDiagSettings(() => ({ verbose: false, toasts: true }));
  });

  it('folds identical consecutive events and toasts errors once', () => {
    log('error', 'node', 'boom', { nodeId: 'n1' });
    log('error', 'node', 'boom', { nodeId: 'n1' });
    const s = useDiag.getState();
    expect(s.events).toHaveLength(1);
    expect(s.events[0].count).toBe(2);
    expect(s.toasts).toHaveLength(1);
  });

  it('drops debug events unless verbose', () => {
    log('debug', 'render', 'frame');
    expect(useDiag.getState().events).toHaveLength(0);
    bindDiagSettings(() => ({ verbose: true, toasts: true }));
    log('debug', 'render', 'frame');
    expect(useDiag.getState().events).toHaveLength(1);
    expect(useDiag.getState().toasts).toHaveLength(0);
  });

  it('flags a node that keeps re-running without edits, but not after an edit', () => {
    const t0 = 1_000_000;
    noteEdit();
    let flagged = false;
    for (let i = 0; i < 6; i++) flagged = detectLoop('loopy', 'ai.upscale', Date.now() + t0 + i * 1000) || flagged;
    expect(flagged).toBe(true);
    expect(useDiag.getState().events.some((e) => e.source === 'loop' && e.nodeId === 'loopy')).toBe(true);
    // a node whose re-runs are each preceded by an edit is fine
    let flagged2 = false;
    const base = Date.now() + 2_000_000;
    for (let i = 0; i < 6; i++) {
      noteEdit(base + i * 1000);
      flagged2 = detectLoop('edited', 'color.levels', base + i * 1000 + 5) || flagged2;
    }
    expect(flagged2).toBe(false);
  });
});
