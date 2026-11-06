import { useMemo, useState, useSyncExternalStore } from 'react';
import { AiDownloadToast, AiModelsSection } from '../core/ai/AiModels';
import { deleteUserNode, getNodeOrigin, listUserNodes } from '../core/customNodes';
import {
  fetchPluginSource,
  installPlugin,
  listInstalledPlugins,
  PluginConflictError,
  pluginsVersion,
  setPluginEnabled,
  subscribePlugins,
  TrustRequiredError,
  uninstallPlugin,
  type InstallOptions,
  type PluginState,
} from '../core/plugins';
import { listNodeDefs, listPresets } from '../core/registry';
import { exportNodeType, importNodeFile, openNodeBuilder } from '../store/extensions';
import { pickFiles } from '../store/io';
import { closeDialog, status, useUi } from '../store/ui';
import { Dialog } from './Dialogs';
import { Icon } from './Icon';
import { NodeBuilderHost } from './NodeBuilder';
import { useRegistry } from './useRegistry';
import './nodeBuilder.css';

function usePlugins() {
  useSyncExternalStore(subscribePlugins, pluginsVersion);
  return listInstalledPlugins();
}

function PluginRow({ st, busy, setBusy }: { st: PluginState; busy: boolean; setBusy: (b: boolean) => void }) {
  const r = st.record;
  const nodes = st.status === 'loaded' ? st.nodes.length : (r.nodeIds?.length ?? 0);
  const presets = st.status === 'loaded' ? st.presets.length : (r.presetIds?.length ?? 0);
  const toggle = async (on: boolean) => {
    setBusy(true);
    try {
      const s = await setPluginEnabled(r.id, on);
      status(on ? (s?.status === 'error' ? `${r.name} failed to load: ${s.error}` : `Enabled ${r.name}.`) : `Disabled ${r.name}; its nodes are unregistered.`, s?.status === 'error' ? 'error' : 'info');
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!confirm(`Uninstall “${r.name}” (${r.id})? Nodes from it in your projects will show an error.`)) return;
    await uninstallPlugin(r.id);
    status(`Uninstalled ${r.name}.`);
  };
  return (
    <tr>
      <td className="nb-center">
        <input type="checkbox" checked={r.enabled} disabled={busy} title={r.enabled ? 'Disable' : 'Enable'} onChange={(e) => void toggle(e.target.checked)} />
      </td>
      <td>
        <div className="pm-name">
          <Icon name={st.status === 'error' ? 'plugin_error' : r.enabled ? 'plugin' : 'plugin_disabled'} /> {r.name}
        </div>
        <div className="pm-desc">
          <code>{r.id}</code>
          {r.description ? ` — ${r.description}` : ''}
        </div>
        {r.url && <div className="pm-desc" title={r.url}>from {r.url}</div>}
        {st.status === 'error' && <div className="pm-status-error">Error: {st.error}</div>}
        {st.warnings.map((w, i) => (
          <div key={i} className="pm-warn">
            ⚠ {w}
          </div>
        ))}
      </td>
      <td className="nowrap">{r.version}</td>
      <td>{r.author ?? '—'}</td>
      <td>
        <span className={'pm-tier ' + r.tier} title={r.tier === 'code' ? 'Runs JavaScript (trusted on install)' : 'JSON + GLSL only'}>
          {r.tier}
        </span>
      </td>
      <td className="nowrap">
        {nodes} / {presets}
      </td>
      <td className="nowrap">{st.status === 'loaded' ? 'Loaded' : st.status === 'disabled' ? 'Disabled' : 'Error'}</td>
      <td>
        <button className="tbtn small" title="Uninstall" onClick={() => void remove()}>
          <Icon name="bin" />
        </button>
      </td>
    </tr>
  );
}

function BuiltinPacks() {
  useRegistry();
  const packs = useMemo(() => {
    const m = new Map<string, { nodes: number; presets: number }>();
    for (const d of listNodeDefs()) {
      if (getNodeOrigin(d.id)) continue;
      const ns = d.id.split('.')[0];
      const e = m.get(ns) ?? { nodes: 0, presets: 0 };
      e.nodes++;
      m.set(ns, e);
    }
    const pluginPresets = new Set(listInstalledPlugins().flatMap((s) => s.presets));
    for (const p of listPresets()) {
      if (pluginPresets.has(p.id)) continue;
      const ns = p.id.split('.')[0];
      const e = m.get(ns) ?? { nodes: 0, presets: 0 };
      e.presets++;
      m.set(ns, e);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, []);
  return (
    <div className="pm-builtin">
      {packs.map(([ns, c]) => (
        <div key={ns}>
          <Icon name="package" /> <b>{ns}</b> <span className="muted">— {[c.nodes && `${c.nodes} nodes`, c.presets && `${c.presets} presets`].filter(Boolean).join(', ')} · read-only</span>
        </div>
      ))}
    </div>
  );
}

function MyNodes() {
  useRegistry();
  const nodes = listUserNodes();
  if (!nodes.length) return <div className="muted">No custom nodes yet. Create one with Node › New Custom Node…</div>;
  return (
    <div className="pm-scroll">
      <table className="grid-table pm-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>ID</th>
            <th>Category</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {nodes.map((n) => (
            <tr key={n.id}>
              <td>{n.name}</td>
              <td>
                <code>{n.id}</code>
              </td>
              <td>{n.category}</td>
              <td className="nowrap">
                <button className="tbtn small" title="Edit in Node Builder" onClick={() => (closeDialog(), openNodeBuilder(n.id))}>
                  <Icon name="script_edit" />
                </button>
                <button className="tbtn small" title="Export .drnode.json" onClick={() => exportNodeType(n.id)}>
                  <Icon name="diskette" />
                </button>
                <button
                  className="tbtn small"
                  title="Delete from library"
                  onClick={() => {
                    if (confirm(`Delete “${n.id}” from your library?`)) void deleteUserNode(n.id);
                  }}
                >
                  <Icon name="bin" />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PluginManager() {
  const list = usePlugins();
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState('/plugins/example-shader-pack.drplugin.json');
  const [error, setError] = useState<string | null>(null);
  const [trust, setTrust] = useState<InstallOptions | null>(null);
  const [conflict, setConflict] = useState<{ opts: InstallOptions; message: string } | null>(null);

  async function install(opts: InstallOptions) {
    setError(null);
    setBusy(true);
    try {
      const st = await installPlugin(opts);
      if (st.status === 'error') setError(`${st.record.name}: ${st.error}`);
      else status(`Installed ${st.record.name} ${st.record.version}: ${st.nodes.length} nodes, ${st.presets.length} presets.`);
      setTrust(null);
      setConflict(null);
    } catch (e) {
      if (e instanceof TrustRequiredError) setTrust(opts);
      else if (e instanceof PluginConflictError) setConflict({ opts, message: e.message });
      else setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const fromFile = async () => {
    const [f] = await pickFiles('.json,.drplugin.json,.js,.mjs,application/json,text/javascript');
    if (!f) return;
    const source = await f.text();
    void install({ source, fileName: f.name });
  };
  const fromUrl = async () => {
    setError(null);
    try {
      setBusy(true);
      const r = await fetchPluginSource(url.trim());
      setBusy(false);
      void install({ source: r.source, url: r.url });
    } catch (e) {
      setBusy(false);
      setError((e as Error).message);
    }
  };

  return (
    <>
      <Dialog
        title="Plugins"
        icon="plugin"
        onClose={closeDialog}
        width={760}
        buttons={
          <>
            <button className="btn nb-left-btn" onClick={() => window.open('/plugins/README.md', '_blank')}>
              <Icon name="book_open" /> Plugin Docs
            </button>
            <button className="btn default" onClick={closeDialog} autoFocus>
              Close
            </button>
          </>
        }
      >
        <fieldset className="groupbox pm-section">
          <legend>Installed plugins</legend>
          {list.length ? (
            <div className="pm-scroll">
              <table className="grid-table pm-table">
                <thead>
                  <tr>
                    <th title="Enabled">On</th>
                    <th>Plugin</th>
                    <th>Version</th>
                    <th>Author</th>
                    <th>Tier</th>
                    <th title="Nodes / presets" className="nowrap">N / P</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {list.map((st) => (
                    <PluginRow key={st.record.id} st={st} busy={busy} setBusy={setBusy} />
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="muted">No plugins installed.</div>
          )}
          <div className="pm-url">
            <button className="btn" disabled={busy} onClick={() => void fromFile()}>
              <Icon name="plugin_add" /> Install from File…
            </button>
            <span className="muted">or URL:</span>
            <input className="field text" value={url} spellCheck={false} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void fromUrl()} aria-label="Plugin URL" />
            <button className="btn" disabled={busy || !url.trim()} onClick={() => void fromUrl()}>
              <Icon name="world_go" /> Install from URL
            </button>
          </div>
          {error && (
            <div className="pm-status-error" role="alert">
              <Icon name="exclamation" /> {error}
            </div>
          )}
        </fieldset>
        <fieldset className="groupbox pm-section">
          <legend>My custom nodes</legend>
          <MyNodes />
          <div className="pm-actions" style={{ marginTop: 6 }}>
            <button className="btn" onClick={() => (closeDialog(), openNodeBuilder())}>
              <Icon name="script_add" /> New Custom Node…
            </button>
            <button className="btn" onClick={() => void importNodeFile()}>
              <Icon name="script_import" /> Import .drnode.json…
            </button>
          </div>
        </fieldset>
        <fieldset className="groupbox pm-section">
          <legend>Built-in node packs</legend>
          <BuiltinPacks />
        </fieldset>
        <fieldset className="groupbox pm-section">
          <legend>AI Models</legend>
          <AiModelsSection />
        </fieldset>
      </Dialog>
      {trust && (
        <Dialog
          title="Trust this plugin?"
          icon="shield"
          onClose={() => setTrust(null)}
          width={480}
          buttons={
            <>
              <button className="btn" disabled={busy} onClick={() => void install({ ...trust, trusted: true })}>
                Trust and Install
              </button>
              <button className="btn default" onClick={() => setTrust(null)} autoFocus>
                Cancel
              </button>
            </>
          }
        >
          <div className="about pm-trust">
            <Icon name="error" size={32} />
            <div>
              <p>
                <b>This is a code plugin.</b> It runs JavaScript with the same access as Darkroom itself: it can read your projects and images, make network requests and store data in
                this browser.
              </p>
              <p>
                Source: <span className="pm-source">{trust.url ?? trust.fileName ?? 'unknown'}</span> ({(trust.source.length / 1024).toFixed(1)} KB)
              </p>
              <p>Only install plugins from authors you trust. Preview:</p>
              <pre>{trust.source.slice(0, 1200)}{trust.source.length > 1200 ? '\n…' : ''}</pre>
            </div>
          </div>
        </Dialog>
      )}
      {conflict && (
        <Dialog
          title="Plugin already installed"
          icon="plugin_error"
          onClose={() => setConflict(null)}
          width={420}
          buttons={
            <>
              <button className="btn default" disabled={busy} onClick={() => void install({ ...conflict.opts, replace: true })}>
                Replace
              </button>
              <button className="btn" onClick={() => setConflict(null)}>
                Cancel
              </button>
            </>
          }
        >
          <p>{conflict.message}</p>
        </Dialog>
      )}
    </>
  );
}

/** Mounted once in App: the Node Builder window and the Plugins dialog. */
export function ExtensionsHost() {
  const d = useUi((s) => s.dialog);
  return (
    <>
      <NodeBuilderHost />
      {d === 'plugins' && <PluginManager />}
      <AiDownloadToast />
    </>
  );
}
