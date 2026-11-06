/**
 * "AI Models" UI: a section for the Plugin Manager (runtime / execution provider, per-model download
 * status, cache management) and a small floating progress toast shown while a model downloads.
 * (The status bar shows "Loading… (n)" while nodes are pending, so download progress needs its own spot.)
 */
import { useEffect, useSyncExternalStore } from 'react';
import { MODELS, pickFile } from './models';
import { clearModelCache, getAiState, prefetchModel, refreshCached, setEpPreference, subscribeAi, type EpPreference } from './runtime';

const useAiState = () => useSyncExternalStore(subscribeAi, getAiState);

const mb = (b: number) => `${(b / 1e6).toFixed(1)} MB`;

export function AiModelsSection() {
  const s = useAiState();
  useEffect(() => void refreshCached(), []);
  const be = s.backend;
  const isolated = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
  const ep = be.ep ?? (s.preference === 'wasm' ? 'wasm' : 'webgpu');
  const totalCached = Object.values(s.cached).reduce((a, b) => a + b, 0);
  return (
    <div className="pm-ai">
      <div className="pm-desc" style={{ marginBottom: 6 }}>
        AI nodes (category <b>AI</b>) run neural networks locally in this browser with ONNX Runtime Web. Models download once from Hugging Face on first use and are kept in
        the browser cache, so they then work offline. Nothing is uploaded.
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
        <label>
          Run on:{' '}
          <select value={s.preference} onChange={(e) => void setEpPreference(e.target.value as EpPreference)}>
            <option value="auto">Auto (WebGPU if available)</option>
            <option value="webgpu">WebGPU (GPU)</option>
            <option value="wasm">WASM (CPU)</option>
          </select>
        </label>
        <span className="muted">
          {be.status === 'ready'
            ? `Active: ${be.ep === 'webgpu' ? 'WebGPU' : `WASM, ${be.threads} thread${be.threads === 1 ? '' : 's'}${isolated ? '' : ' (page not cross-origin isolated)'}`}${be.worker ? ', in a worker' : ', main thread'}`
            : be.status === 'starting'
              ? 'Starting…'
              : be.status === 'error'
                ? `Error: ${be.error}`
                : 'Not started (starts with the first AI node)'}
        </span>
      </div>
      <table className="grid-table pm-table">
        <thead>
          <tr>
            <th>Model</th>
            <th>Licence</th>
            <th>Size</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {Object.values(MODELS).map((m) => {
            const st = s.models[m.id];
            const cachedFile = m.files.find((f) => s.cached[f.url]);
            const file = cachedFile ?? pickFile(m, ep, !!be.f16);
            const dl = s.downloads[file.url];
            let status = cachedFile ? `Downloaded (${cachedFile.precision})` : 'Not downloaded';
            if (dl && !dl.done) status = `Downloading… ${dl.total ? Math.round((dl.loaded / dl.total) * 100) : 0}%`;
            else if (st?.status === 'loading') status = 'Loading…';
            else if (st?.status === 'error') status = `Error: ${st.error}`;
            else if (st?.status === 'ready')
              status = `Ready (${st.precision}, ${st.ep === 'webgpu' ? 'WebGPU' : 'WASM'})${st.lastInferMs != null ? ` · last run ${st.lastInferMs} ms @ ${st.lastSize}` : ''}`;
            return (
              <tr key={m.id}>
                <td>
                  <div className="pm-name">{m.name}</div>
                  <div className="pm-desc">
                    <a href={m.page} target="_blank" rel="noreferrer">
                      {m.credit}
                    </a>
                  </div>
                </td>
                <td className="nowrap">{m.licence}</td>
                <td className="nowrap">{mb(cachedFile ? s.cached[cachedFile.url] || cachedFile.bytes : file.bytes)}</td>
                <td>{status}</td>
                <td className="nowrap">
                  {cachedFile ? (
                    <button className="btn" onClick={() => void Promise.all(m.files.map((f) => clearModelCache(f.url)))}>
                      Delete
                    </button>
                  ) : (
                    <button className="btn" disabled={!!dl && !dl.done} onClick={() => void prefetchModel(m.id).catch(() => {})}>
                      Download
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="pm-actions" style={{ marginTop: 6, display: 'flex', gap: 8, alignItems: 'center' }}>
        <span className="muted">Cached (models + runtime): {mb(totalCached)}</span>
        <button className="btn" disabled={!totalCached} onClick={() => confirm('Delete all downloaded AI models from this browser?') && void clearModelCache()}>
          Clear all
        </button>
      </div>
    </div>
  );
}

/** Floating progress while AI files download (mount once, e.g. next to the dialogs). */
export function AiDownloadToast() {
  const s = useAiState();
  const active = Object.values(s.downloads).filter((d) => !d.done);
  if (!active.length) return null;
  return (
    <div
      role="status"
      style={{
        position: 'fixed',
        right: 12,
        bottom: 32,
        zIndex: 1000,
        background: 'var(--face, #d4d0c8)',
        color: 'var(--text, #000)',
        border: '1px solid var(--dk, #404040)',
        boxShadow: '2px 2px 6px rgba(0,0,0,.35)',
        padding: '6px 10px',
        font: '12px var(--font, sans-serif)',
        minWidth: 240,
        pointerEvents: 'none',
      }}
    >
      {active.map((d) => {
        const pct = d.total ? Math.min(100, (d.loaded / d.total) * 100) : 0;
        return (
          <div key={d.url} style={{ margin: '2px 0' }}>
            <div>
              Downloading {d.label}… {d.total ? `${pct.toFixed(0)}% of ${mb(d.total)}` : mb(d.loaded)}
            </div>
            <div style={{ height: 6, background: 'var(--field, #fff)', border: '1px solid var(--lo, #808080)', marginTop: 2 }}>
              <div style={{ width: `${pct}%`, height: '100%', background: 'var(--sel, #316ac5)' }} />
            </div>
          </div>
        );
      })}
      <div className="muted" style={{ marginTop: 2 }}>
        One-time download; cached for offline use.
      </div>
    </div>
  );
}
