/** The Preferences panes (except Keyboard, see KeyboardPane.tsx). Every control applies live. */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { openDiagnostics } from '../../core/diag';
import { listInstalledPlugins, pluginsVersion, subscribePlugins } from '../../core/plugins';
import { MODELS } from '../../core/ai/models';
import { deleteCached, listCached, cacheAvailable } from '../../core/ai/cache';
import { engine, requestRender } from '../../store/engine';
import { expandNamePattern, NAME_TOKENS } from '../../store/exportName';
import { pickFiles } from '../../store/io';
import { clearAutosave } from '../../store/persist';
import { exportPrefsJson, importPrefsJson, resetPrefs, setPref, setTheme, THEMES, useSettings, type Prefs } from '../../store/settings';
import { openDialog, status, useUi } from '../../store/ui';
import { useViewer } from '../../store/viewer';
import { native } from '../../native/native';
import { Box, Button, Check, fmtBytes, Note, PopUp, Radios, Row, Sep, Stepper, TickSlider } from './controls';

/** Ask for confirmation in a sheet (provided by the window). */
export type Ask = (message: string, detail: string, ok: string, run: () => void) => void;
export interface PaneProps {
  ask: Ask;
}

const S =
  <K extends keyof Prefs>(k: K) =>
  (v: Prefs[K]) =>
    setPref(k, v);

// ---------------------------------------------------------------------------
export function GeneralPane() {
  const s = useSettings();
  return (
    <div className="slp-form">
      <Row label="At launch" top>
        <Radios
          value={s.launchAction}
          onChange={S('launchAction')}
          options={[
            { value: 'restore', label: 'Restore the last session' },
            { value: 'starter', label: 'Open the starter project' },
            { value: 'empty', label: 'Start with an empty project' },
          ]}
        />
      </Row>
      <Sep />
      <Row label="Autosave">
        <PopUp
          label="Autosave"
          value={s.autosaveMs}
          onChange={S('autosaveMs')}
          width={190}
          options={[
            { value: 800, label: 'After every change' },
            { value: 10000, label: 'Every 10 seconds' },
            { value: 30000, label: 'Every 30 seconds' },
            { value: 60000, label: 'Every minute' },
            { value: 0, label: 'Never' },
          ]}
        />
      </Row>
      <Row label="Undo history">
        <Stepper value={s.undoDepth} min={10} max={1000} step={10} onChange={S('undoDepth')} suffix="steps" />
      </Row>
      <Row>
        <Check checked={s.confirmDiscard} onChange={S('confirmDiscard')}>
          Ask before discarding unsaved changes
        </Check>
      </Row>
      <Row label="Node graph" top col>
        <Check checked={s.autoConnect} onChange={S('autoConnect')}>
          Connect new nodes to the selected node
        </Check>
        <Check checked={s.insertOnWire} onChange={S('insertOnWire')}>
          Drop a node on a wire to insert it (hold Alt to suppress)
        </Check>
      </Row>
      <Row label="Ask before deleting">
        <PopUp
          label="Ask before deleting"
          value={s.confirmDeleteOver}
          onChange={S('confirmDeleteOver')}
          width={190}
          options={[
            { value: 0, label: 'Never' },
            { value: 3, label: 'More than 3 nodes' },
            { value: 5, label: 'More than 5 nodes' },
            { value: 10, label: 'More than 10 nodes' },
            { value: 20, label: 'More than 20 nodes' },
            { value: 50, label: 'More than 50 nodes' },
          ]}
        />
      </Row>
      <Sep />
      <Row label="Default project name">
        <input
          className="slp-field"
          style={{ width: 220 }}
          value={s.defaultProjectName}
          maxLength={80}
          onChange={(e) => setPref('defaultProjectName', e.target.value)}
        />
      </Row>
      <Row>
        <Note>Used by File › New Project. Autosave keeps your work in this browser between sessions.</Note>
      </Row>
    </div>
  );
}

// ---------------------------------------------------------------------------
const TILE_CAPTION: Record<string, string> = {
  auto: 'Automatic',
  classic: 'Classic',
  aperture: 'Aperture',
  aqua: 'Aqua',
};

function ThemeTile({ id, selected }: { id: string; selected: boolean }) {
  const shot = (
    <>
      <span className="bar" />
      <span className="row">
        <span className="side" />
        <span className="view" />
        <span className="side" />
      </span>
      <span className="graph" />
    </>
  );
  return (
    <button
      type="button"
      className={'slp-tile' + (selected ? ' selected' : '')}
      data-t={id}
      onClick={() => setTheme(id as Prefs['theme'])}
      aria-pressed={selected}
    >
      <span className="shot">
        {shot}
        {id === 'auto' && <span className="half">{shot}</span>}
      </span>
      <span className="cap">{TILE_CAPTION[id]}</span>
    </button>
  );
}

export function AppearancePane() {
  const s = useSettings();
  const info = THEMES.find((t) => t.id === s.pref);
  return (
    <>
      <Box>
        <div className="slp-tiles">
          {THEMES.map((t) => (
            <ThemeTile key={t.id} id={t.id} selected={t.id === s.pref} />
          ))}
        </div>
        <div className="slp-note" style={{ marginTop: 10, textAlign: 'center' }}>
          {info?.description}
        </div>
      </Box>
      <div className="slp-form" style={{ marginTop: 16 }}>
        <Row label="Interface size" top>
          <TickSlider value={s.uiScale} stops={[0.9, 1, 1.1, 1.25]} labels={['90%', '100%', '110%', '125%']} onChange={S('uiScale')} width={240} />
        </Row>
        <Sep />
        <Row label="Node graph" top col>
          <Check checked={s.nodeThumbnails} onChange={S('nodeThumbnails')}>
            Show live thumbnails in nodes
          </Check>
          <Check checked={s.minimap} onChange={S('minimap')}>
            Show the minimap
          </Check>
          <Check checked={s.nodeTooltips} onChange={S('nodeTooltips')}>
            Show node descriptions as tooltips
          </Check>
          <Check checked={s.nodeIdTooltips} onChange={S('nodeIdTooltips')}>
            Show node ids in tooltips
          </Check>
          <Check checked={s.snapToGrid} onChange={S('snapToGrid')}>
            Snap nodes to the grid
          </Check>
        </Row>
        <Row label="Grid size">
          <PopUp
            label="Grid size"
            value={s.gridSize}
            onChange={S('gridSize')}
            width={160}
            disabled={!s.snapToGrid}
            options={[5, 10, 20, 25, 50].map((v) => ({ value: v, label: `${v} px` }))}
          />
        </Row>
        <Row label="Minimap">
          <PopUp
            label="Minimap position"
            value={s.minimap ? s.minimapPos : 'off'}
            onChange={(v) => {
              if (v === 'off') setPref('minimap', false);
              else {
                setPref('minimap', true);
                setPref('minimapPos', v);
              }
            }}
            width={160}
            options={[
              { value: 'bottom-right', label: 'Bottom right' },
              { value: 'bottom-left', label: 'Bottom left' },
              { value: 'top-right', label: 'Top right' },
              { value: 'top-left', label: 'Top left' },
              { value: 'off', label: 'Off' },
            ]}
          />
        </Row>
        <Row label="Wire style">
          <PopUp
            label="Wire style"
            value={s.wireStyle}
            onChange={S('wireStyle')}
            width={160}
            options={[
              { value: 'default', label: 'Curved (Bézier)' },
              { value: 'straight', label: 'Straight' },
              { value: 'step', label: 'Right angles' },
              { value: 'smoothstep', label: 'Rounded steps' },
            ]}
          />
        </Row>
        <Row label="Grid">
          <PopUp
            label="Grid"
            value={s.grid}
            onChange={S('grid')}
            width={160}
            options={[
              { value: 'lines', label: 'Lines' },
              { value: 'dots', label: 'Dots' },
              { value: 'none', label: 'None' },
            ]}
          />
        </Row>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
export function ViewerPane() {
  const s = useSettings();
  return (
    <div className="slp-form">
      <Row label="Default preview quality">
        <PopUp
          label="Default preview quality"
          value={s.defaultQuality}
          width={190}
          onChange={(v) => {
            setPref('defaultQuality', v);
            useUi.setState({ quality: v });
          }}
          options={[
            { value: 'draft', label: 'Draft (¼ screen)' },
            { value: 'half', label: 'Half (½ screen)' },
            { value: 'screen', label: 'Screen resolution' },
          ]}
        />
      </Row>
      <Row label="Background">
        <PopUp
          label="Viewer background"
          value={s.viewerBg}
          width={190}
          onChange={S('viewerBg')}
          options={[
            { value: 'theme', label: 'Theme default' },
            { value: 'black', label: 'Black' },
            { value: 'grey', label: 'Middle grey' },
            { value: 'white', label: 'White' },
            { value: 'checker', label: 'Checkerboard' },
          ]}
        />
      </Row>
      <Sep />
      <Row label="Zooming" top col>
        <Check checked={s.pixelZoom} onChange={S('pixelZoom')}>
          Show sharp pixels when zoomed in above 100%
        </Check>
        <Check checked={s.fitOnChange} onChange={S('fitOnChange')}>
          Zoom to fit when the image size changes
        </Check>
      </Row>
      <Row label="Compare" top col>
        <Check
          checked={s.compareDefault}
          onChange={(v) => {
            setPref('compareDefault', v);
            useUi.setState({ compare: v });
          }}
        >
          Show the A/B split line by default
        </Check>
        <Note>Drag the split line in the viewer to compare the original with the result.</Note>
      </Row>
      <Row label="Compare layout">
        <PopUp
          label="Compare layout"
          value={s.compareLayout}
          width={190}
          onChange={(v) => {
            setPref('compareLayout', v);
            useViewer.setState({ compareMode: v });
          }}
          options={[
            { value: 'h', label: 'Split left / right' },
            { value: 'v', label: 'Split top / bottom' },
            { value: 'toggle', label: 'Toggle (hold \\)' },
          ]}
        />
      </Row>
      <Sep />
      <Row label="Scopes" top col>
        <Check
          checked={s.scopesDefault}
          onChange={(v) => {
            setPref('scopesDefault', v);
            useViewer.setState({ scopes: v });
          }}
        >
          Show the scopes panel at launch
        </Check>
        <PopUp
          label="Default scope"
          value={s.scopesType}
          width={190}
          onChange={(v) => {
            setPref('scopesType', v);
            useViewer.setState({ scopeType: v });
          }}
          options={[
            { value: 'histogram', label: 'Histogram' },
            { value: 'waveform', label: 'Waveform' },
            { value: 'vectorscope', label: 'Vectorscope' },
            { value: 'parade', label: 'RGB parade' },
            { value: 'all', label: 'All four' },
          ]}
        />
      </Row>
      <Row label="Pixel readout" top col>
        <Check
          checked={s.pixelReadout}
          onChange={(v) => {
            setPref('pixelReadout', v);
            useViewer.setState({ readout: v });
          }}
        >
          Show the colour under the pointer
        </Check>
      </Row>
      <Row label="Eyedropper sample">
        <PopUp
          label="Eyedropper sample size"
          value={s.eyedropperSize}
          width={190}
          onChange={S('eyedropperSize')}
          options={[
            { value: 1, label: 'Point sample' },
            { value: 3, label: '3 × 3 average' },
            { value: 5, label: '5 × 5 average' },
          ]}
        />
      </Row>
      <Row label="Clipping shown at" top col>
        <span>
          Shadows ≤ <Stepper value={s.clipLow} min={0} max={64} onChange={S('clipLow')} />
        </span>
        <span>
          Highlights ≥ <Stepper value={s.clipHigh} min={192} max={255} onChange={S('clipHigh')} suffix="(8-bit levels)" />
        </span>
      </Row>
      <Row label="Preset thumbnails">
        <PopUp
          label="Preset browser thumbnail size"
          value={s.presetThumbSize}
          width={190}
          onChange={S('presetThumbSize')}
          options={[
            { value: 140, label: 'Small (140 px)' },
            { value: 200, label: 'Medium (200 px)' },
            { value: 260, label: 'Large (260 px)' },
          ]}
        />
      </Row>
    </div>
  );
}

// ---------------------------------------------------------------------------
interface GpuInfo {
  renderer: string;
  vendor: string;
  maxTex: number;
  floatRT: boolean;
  webgpu: string;
}

function readGpu(): GpuInfo {
  const g = engine?.gl;
  if (!g)
    return {
      renderer: 'WebGL2 unavailable',
      vendor: '—',
      maxTex: 0,
      floatRT: false,
      webgpu: '…',
    };
  const gl = g.gl;
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    renderer: String(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER)),
    vendor: String(gl.getParameter(dbg ? dbg.UNMASKED_VENDOR_WEBGL : gl.VENDOR)),
    maxTex: g.maxSize,
    floatRT: g.floatRT,
    webgpu: 'gpu' in navigator ? '…' : 'Not available',
  };
}

type GpuNav = Navigator & {
  gpu?: {
    requestAdapter(): Promise<{
      info?: { vendor?: string; architecture?: string; description?: string };
    } | null>;
  };
  deviceMemory?: number;
};

export function PerformancePane() {
  const s = useSettings();
  const [gpu, setGpu] = useState(readGpu);
  const [bytes, setBytes] = useState(engine?.gl.bytes ?? 0);
  useEffect(() => {
    const nav = navigator as GpuNav;
    nav.gpu
      ?.requestAdapter()
      .then((a) => {
        const i = a?.info;
        setGpu((g) => ({
          ...g,
          webgpu: a
            ? `Available${i && (i.description || i.vendor) ? ` (${[i.vendor, i.architecture || i.description].filter(Boolean).join(' ')})` : ''}`
            : 'No adapter',
        }));
      })
      .catch(() => setGpu((g) => ({ ...g, webgpu: 'Unavailable' })));
    const t = setInterval(() => setBytes(engine?.gl.bytes ?? 0), 1000);
    return () => clearInterval(t);
  }, []);
  const nav = navigator as GpuNav;
  return (
    <>
      <Box title="Graphics">
        <div className="slp-kv">
          <span>Renderer:</span>
          <span>{gpu.renderer}</span>
          <span>Vendor:</span>
          <span>{gpu.vendor}</span>
          <span>Max texture size:</span>
          <span>
            {gpu.maxTex} × {gpu.maxTex} px
          </span>
          <span>Float render targets:</span>
          <span className={gpu.floatRT ? 'slp-ok' : 'slp-bad'}>{gpu.floatRT ? 'Yes (16-bit half float)' : 'No (8-bit fallback)'}</span>
          <span>WebGPU:</span>
          <span>{gpu.webgpu}</span>
          <span>CPU threads:</span>
          <span>{navigator.hardwareConcurrency || '—'}</span>
          <span>Device memory:</span>
          <span>{nav.deviceMemory ? `≥ ${nav.deviceMemory} GB` : 'Not reported'}</span>
        </div>
      </Box>
      <div className="slp-form" style={{ marginTop: 16 }}>
        <Row label="Limit preview resolution to">
          <PopUp
            label="Preview resolution cap"
            value={s.previewCap}
            width={170}
            onChange={S('previewCap')}
            options={[
              { value: 0, label: 'No limit' },
              { value: 1024, label: '1024 px long edge' },
              { value: 2048, label: '2048 px long edge' },
              { value: 4096, label: '4096 px long edge' },
            ]}
          />
        </Row>
        <Row label="Keep idle render targets">
          <PopUp
            label="Texture pool size"
            value={s.poolSize}
            width={170}
            onChange={S('poolSize')}
            options={[
              { value: 8, label: '8 (least memory)' },
              { value: 24, label: '24 (default)' },
              { value: 48, label: '48' },
              { value: 96, label: '96 (fastest)' },
            ]}
          />
        </Row>
        <Row label="While dragging sliders" top>
          <Radios
            value={s.dragRender}
            onChange={S('dragRender')}
            options={[
              { value: 'live', label: 'Update the viewer live' },
              {
                value: 'pause',
                label: 'Pause rendering until the mouse is released',
              },
            ]}
          />
        </Row>
        <Sep />
        <Row label="Render cache">
          <Button
            onClick={() => {
              engine?.clearCache();
              requestRender();
              setTimeout(() => setBytes(engine?.gl.bytes ?? 0), 200);
              status('Render cache cleared.');
            }}
          >
            Clear Cache
          </Button>
          <Note>About {fmtBytes(bytes)} of GPU textures in use</Note>
        </Row>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
const Q_STOPS = [0.5, 0.7, 0.85, 0.92, 1];
export function ExportPane() {
  const s = useSettings();
  const ext = s.exportFormat === 'image/png' ? 'png' : s.exportFormat === 'image/jpeg' ? 'jpg' : 'webp';
  const q = Q_STOPS.reduce((a, b) => (Math.abs(b - s.exportQuality) < Math.abs(a - s.exportQuality) ? b : a));
  return (
    <div className="slp-form">
      <Row label="Default format">
        <PopUp
          label="Default format"
          value={s.exportFormat}
          width={170}
          onChange={S('exportFormat')}
          options={[
            { value: 'image/png', label: 'PNG (lossless)' },
            { value: 'image/jpeg', label: 'JPEG' },
            { value: 'image/webp', label: 'WebP' },
          ]}
        />
      </Row>
      <Row label="Quality" top>
        <span
          style={{
            opacity: s.exportFormat === 'image/png' ? 0.45 : 1,
            pointerEvents: s.exportFormat === 'image/png' ? 'none' : undefined,
          }}
        >
          <TickSlider value={q} stops={Q_STOPS} labels={['Least', 'Low', 'Medium', 'High', 'Best']} onChange={S('exportQuality')} width={260} />
        </span>
      </Row>
      <Row label="Scale">
        <PopUp
          label="Export scale"
          value={s.exportScale}
          width={170}
          onChange={S('exportScale')}
          options={[
            { value: 0.25, label: '25%' },
            { value: 0.5, label: '50%' },
            { value: 1, label: '100% (full size)' },
            { value: 2, label: '200%' },
          ]}
        />
      </Row>
      <Sep />
      <Row label="File name">
        <input
          className="slp-field"
          style={{ width: 260 }}
          value={s.filenamePattern}
          maxLength={120}
          onChange={(e) => setPref('filenamePattern', e.target.value)}
          spellCheck={false}
        />
      </Row>
      <Row label="Insert">
        {NAME_TOKENS.map((t) => (
          <Button
            key={t.token}
            small
            title={t.label}
            onClick={() => setPref('filenamePattern', (s.filenamePattern + (s.filenamePattern ? '-' : '') + t.token).slice(0, 120))}
          >
            {t.token.slice(1, -1)}
          </Button>
        ))}
      </Row>
      <Row>
        <Check checked={s.includeSourceName} onChange={S('includeSourceName')}>
          Include the source image’s file name
        </Check>
      </Row>
      <Row label="Example">
        <span className="slp-small">
          <b>
            {expandNamePattern(s.filenamePattern, {
              scale: s.exportScale,
              includeSource: s.includeSourceName,
            })}
          </b>
          .{ext}
        </span>
      </Row>
      <Row>
        <Note>
          These are the defaults of File › Export Image.{' '}
          {native ? 'The save location is chosen when exporting.' : 'Your browser saves exports to its downloads folder.'}
        </Note>
      </Row>
    </div>
  );
}

// ---------------------------------------------------------------------------
function modelName(url: string) {
  for (const m of Object.values(MODELS)) {
    const f = m.files.find((x) => x.url === url);
    if (f) return `${m.name} (${f.precision})`;
  }
  const file = url.split('/').pop() ?? url;
  return /ort-wasm/.test(file) ? 'ONNX Runtime (' + file + ')' : file;
}

export function PluginsPane({ ask }: PaneProps) {
  const s = useSettings();
  useSyncExternalStore(subscribePlugins, pluginsVersion);
  const plugins = listInstalledPlugins();
  const [cached, setCached] = useState<Record<string, number> | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const refresh = () => void listCached().then(setCached, () => setCached({}));
  useEffect(refresh, []);
  const entries = useMemo(() => Object.entries(cached ?? {}).sort((a, b) => b[1] - a[1]), [cached]);
  const total = entries.reduce((a, [, b]) => a + b, 0);
  return (
    <>
      <div className="slp-form">
        <Row label="Plugins" top col>
          <Check checked={s.allowCodePlugins} onChange={S('allowCodePlugins')}>
            Allow code plugins (JavaScript)
          </Check>
          <Note>Data plugins (shader packs) are always allowed. Code plugins run with full access to the editor.</Note>
        </Row>
      </div>
      <div style={{ marginTop: 10 }}>
        <div className="slp-table-wrap" style={{ height: 104 }}>
          <table className="slp-table">
            <colgroup>
              <col />
              <col style={{ width: 80 }} />
              <col style={{ width: 70 }} />
              <col style={{ width: 90 }} />
            </colgroup>
            <thead>
              <tr>
                <th>Installed plugin</th>
                <th>Version</th>
                <th>Type</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {plugins.length === 0 && (
                <tr className="empty">
                  <td colSpan={4}>No plugins installed</td>
                </tr>
              )}
              {plugins.map((p) => (
                <tr key={p.record.id}>
                  <td title={p.record.description}>
                    <img src={`/icons/fatcow/16x16/${p.record.tier === 'code' ? 'script_gear' : 'plugin'}.png`} alt="" />
                    {p.record.name}
                  </td>
                  <td>{p.record.version}</td>
                  <td>{p.record.tier === 'code' ? 'Code' : 'Data'}</td>
                  <td>{p.status === 'loaded' ? 'Enabled' : p.status === 'disabled' ? 'Disabled' : 'Error'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="slp-foot" style={{ marginTop: 8 }}>
          <span className="grow" />
          <Button onClick={() => openDialog('plugins')}>Plugin Manager…</Button>
        </div>
      </div>
      <div className="slp-box-title" style={{ marginTop: 6 }}>
        AI models
      </div>
      <div className="slp-table-wrap" style={{ height: 104 }}>
        <table className="slp-table">
          <colgroup>
            <col />
            <col style={{ width: 100 }} />
          </colgroup>
          <thead>
            <tr>
              <th>Downloaded model</th>
              <th>Size</th>
            </tr>
          </thead>
          <tbody>
            {cached === null && (
              <tr className="empty">
                <td colSpan={2}>Reading cache…</td>
              </tr>
            )}
            {cached !== null && entries.length === 0 && (
              <tr className="empty">
                <td colSpan={2}>
                  {cacheAvailable() ? 'No models downloaded yet. AI nodes download their model on first use.' : 'Model cache unavailable in this context.'}
                </td>
              </tr>
            )}
            {entries.map(([url, size]) => (
              <tr key={url} className={sel === url ? 'sel' : ''} onClick={() => setSel(url)} title={url}>
                <td>
                  <img src="/icons/fatcow/16x16/brain.png" alt="" />
                  {modelName(url)}
                </td>
                <td className="right">{fmtBytes(size)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="slp-foot" style={{ marginTop: 8 }}>
        <Check checked={s.aiPreferWebGPU} onChange={S('aiPreferWebGPU')}>
          Prefer WebGPU for AI
        </Check>
        <Check checked={s.aiFollowZoom} onChange={S('aiFollowZoom')}>
          Re-run AI nodes when zooming in
        </Check>
        <label title="Ask once before a model larger than this is downloaded for the first time">
          Ask before downloads over{' '}
          <select value={s.aiConfirmMB} onChange={(e) => setPref('aiConfirmMB', Number(e.target.value))}>
            <option value={0}>never ask</option>
            <option value={25}>25 MB</option>
            <option value={50}>50 MB</option>
            <option value={100}>100 MB</option>
            <option value={250}>250 MB</option>
          </select>
        </label>
        <span className="grow" />
        <Note>{entries.length ? `${entries.length} files, ${fmtBytes(total)}` : ''}</Note>
        <Button disabled={!sel} onClick={() => sel && void deleteCached(sel).then(() => (setSel(null), refresh()))}>
          Delete
        </Button>
        <Button
          disabled={!entries.length}
          onClick={() =>
            ask(
              'Delete all downloaded AI models?',
              'AI nodes will download their models again the next time they are used.',
              'Delete All',
              () => void deleteCached().then(refresh),
            )
          }
        >
          Delete All
        </Button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
function saveText(text: string, name: string) {
  if (native) {
    void native.saveFile(new TextEncoder().encode(text), {
      suggestedName: name,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    return;
  }
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function AdvancedPane({ ask }: PaneProps) {
  const s = useSettings();
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  return (
    <div className="slp-form">
      <Row label="Preferences" top col>
        <span style={{ display: 'flex', gap: 8 }}>
          <Button onClick={() => (saveText(exportPrefsJson(), 'Darkroom Preferences.json'), setMsg({ text: 'Preferences exported.' }))}>Export…</Button>
          <Button
            onClick={async () => {
              const [f] = await pickFiles('.json,application/json');
              if (!f) return;
              try {
                importPrefsJson(await f.text());
                setMsg({ text: `Imported preferences from ${f.name}.` });
              } catch (e) {
                setMsg({
                  text: `Could not import ${f.name}: ${(e as Error).message}`,
                  error: true,
                });
              }
            }}
          >
            Import…
          </Button>
          <Button
            onClick={() =>
              ask(
                'Reset all preferences to their defaults?',
                'Every setting in every pane, including keyboard shortcuts, returns to its original value. This cannot be undone.',
                'Reset',
                () => (resetPrefs(), setMsg({ text: 'All preferences were reset.' })),
              )
            }
          >
            Reset All…
          </Button>
        </span>
        {msg && <span className={msg.error ? 'slp-error' : 'slp-note'}>{msg.text}</span>}
      </Row>
      <Row label="Autosaved session" top col>
        <Button
          onClick={() =>
            ask(
              'Clear the autosaved project?',
              'The open project stays open, but it will not be restored at the next launch unless you change it again.',
              'Clear',
              () => void clearAutosave().then(() => setMsg({ text: 'Autosaved project cleared.' })),
            )
          }
        >
          Clear Autosave…
        </Button>
      </Row>
      <Sep />
      <Row label="Viewer" top>
        <Check checked={s.showFps} onChange={S('showFps')}>
          Show frame rate and render time overlay
        </Check>
      </Row>
      <Row label="Diagnostics" top col>
        <Check checked={s.errorToasts} onChange={S('errorToasts')}>
          Show errors as on-screen notifications
        </Check>
        <Check checked={s.verboseDiagnostics} onChange={S('verboseDiagnostics')}>
          Verbose mode: log every render, AI job, model download and helper message
        </Check>
        <Button onClick={() => openDiagnostics()}>Open Diagnostics…</Button>
        <Note>Window › Diagnostics (Ctrl+Alt+D) shows the log; copy or save it to report a problem.</Note>
      </Row>
      <Row label="Developer" top col>
        <Check checked={s.showNodeIds} onChange={S('showNodeIds')}>
          Show flattened node ids in the graph
        </Check>
        <Button onClick={() => window.open('/harness.html', '_blank', 'noopener')}>Open Render Harness</Button>
        <Note>The headless render harness used by the test and benchmark scripts.</Note>
      </Row>
    </div>
  );
}
