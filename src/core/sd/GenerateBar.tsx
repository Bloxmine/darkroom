/**
 * Properties-panel controls for sd.generate (mounted by src/ui/Properties.tsx above the generic param rows):
 * the Generate button (sets the hidden `run` token), the server status, Test connection, and pickers that
 * fill the string params (checkpoint, sampler, scheduler, ControlNet models) from the server's lists.
 */
import { useState, useSyncExternalStore } from 'react';
import type { GraphNode } from '../types';
import * as A from '../../store/actions';
import { openDialog } from '../../store/ui';
import { useSettings } from '../../store/settings';
import { getListState, isLocalUrl, SERVER_NAMES, serverConfig, subscribeLists, testConnection } from './client';
import { getAiState, subscribeAi } from '../ai/runtime';

export const SD_NODE_TYPES = new Set(['sd.generate']);

/** sd.generate itself, or a group (e.g. the control.* presets) that exposes its `run` token. */
export function showGenerateBar(node: GraphNode): boolean {
  return SD_NODE_TYPES.has(node.type) || !!node.group?.exposed.some((e) => e.key === 'run');
}

function Pick({ node, k, label, options }: { node: GraphNode; k: string; label: string; options: string[] }) {
  const v = String(node.params[k] ?? '');
  if (!options.length) return null;
  if (node.group && !node.group.exposed.some((e) => e.key === k)) return null; // a group: only its exposed params
  return (
    <div className="prow">
      <div className="plabel" title={`Fills “${k}” from the server's list`}>{label}</div>
      <div className="pwidget">
        <select className="field select" value={options.includes(v) ? v : ''} onChange={(e) => A.setParam(node.id, k, e.target.value, false)}>
          <option value="">{v && !options.includes(v) ? `(${v})` : '— choose —'}</option>
          {options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

export function GenerateBar({ node }: { node: GraphNode }) {
  useSettings(); // re-render when the server prefs change
  const lists = useSyncExternalStore(subscribeLists, getListState);
  const ai = useSyncExternalStore(subscribeAi, getAiState);
  const [err, setErr] = useState('');
  const cfg = serverConfig();
  const busy = Object.values(ai.tasks ?? {}).some((t) => /generating/.test(t.label));
  const L = lists.lists;
  const openPrefs = () => {
    try {
      localStorage.setItem('darkroom.prefs.lastPane', 'generation');
    } catch {
      /* ignore */
    }
    openDialog('prefs');
  };
  return (
    <div className="sd-bar" style={{ padding: '6px 8px 8px', borderBottom: '1px solid var(--border, rgba(127,127,127,0.25))' }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          className="btn default"
          disabled={!cfg || busy}
          title={cfg ? `Send this job to ${SERVER_NAMES[cfg.kind]} at ${cfg.url}` : 'Choose a server in Preferences › Generation first'}
          onClick={() => A.setParam(node.id, 'run', String(Date.now()), false)}
        >
          {busy ? 'Generating…' : 'Generate'}
        </button>
        <button
          className="btn"
          disabled={!cfg || lists.status === 'testing'}
          onClick={() => {
            setErr('');
            testConnection().catch((e) => setErr(String((e as Error)?.message ?? e)));
          }}
        >
          {lists.status === 'testing' ? 'Testing…' : 'Test connection'}
        </button>
        <button className="btn" onClick={openPrefs}>
          Server…
        </button>
      </div>
      <div className="muted small" style={{ marginTop: 4, lineHeight: 1.35 }}>
        {cfg ? (
          <>
            {SERVER_NAMES[cfg.kind]} · <code>{cfg.url}</code>
            {!isLocalUrl(cfg.url) && <b> — not a local address: images are sent over the network.</b>}
            <br />
            Generate sends the prompts and the connected images to this server only.
          </>
        ) : (
          <>Generation is off. Choose your ComfyUI or AUTOMATIC1111 server in Preferences › Generation.</>
        )}
      </div>
      {(err || (lists.status === 'error' && lists.message)) && <div className="small" style={{ color: 'var(--error, #e5534b)', marginTop: 4 }}>{err || lists.message}</div>}
      {lists.status === 'ok' && lists.message && <div className="muted small" style={{ marginTop: 4 }}>{lists.message}</div>}
      {L && (
        <div style={{ marginTop: 4 }}>
          <Pick node={node} k="checkpoint" label="Checkpoint" options={L.checkpoints} />
          <Pick node={node} k="sampler" label="Sampler" options={L.samplers} />
          <Pick node={node} k="scheduler" label="Scheduler" options={L.schedulers} />
          {[1, 2, 3].map((i) => (
            <Pick key={i} node={node} k={`cn${i}Model`} label={`ControlNet ${i}`} options={L.controlnets} />
          ))}
        </div>
      )}
    </div>
  );
}
