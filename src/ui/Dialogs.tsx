import { useEffect, useRef, useState, type ReactNode } from 'react';
import { listNodeDefs, listPresets } from '../core/registry';
import { useDoc } from '../store/doc';
import { EXT, exportImage, measureOutput, newProject, type ExportType } from '../store/io';
import { useSettings } from '../store/settings';
import { exportBaseName } from '../store/exportName';
import { closeDialog, status, useUi } from '../store/ui';
import { commands, displayKeys } from './commands';
import { Icon } from './Icon';
import { BatchDialog } from './BatchDialog';
import { ExportVideoDialog } from './ExportVideoDialog';
import { PrefsWindow } from './prefs/PrefsWindow';

/** A classic modal window: title bar, body, buttons bottom-right. */
export function Dialog({
  title,
  icon,
  children,
  buttons,
  onClose,
  width = 380,
}: {
  title: string;
  icon?: string;
  children: ReactNode;
  buttons: ReactNode;
  onClose: () => void;
  width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [off, setOff] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  return (
    <div className="modal-backdrop">
      <div className="window dialog" ref={ref} style={{ width, transform: `translate(${off.x}px, ${off.y}px)` }} role="dialog" aria-label={title}>
        <div
          className="titlebar"
          onPointerDown={(e) => {
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
            drag.current = { x: e.clientX, y: e.clientY, ox: off.x, oy: off.y };
          }}
          onPointerMove={(e) => drag.current && setOff({ x: drag.current.ox + e.clientX - drag.current.x, y: drag.current.oy + e.clientY - drag.current.y })}
          onPointerUp={() => (drag.current = null)}
        >
          {icon && <Icon name={icon} />}
          <span className="titlebar-text">{title}</span>
          <button className="titlebar-close" onClick={onClose} title="Close" onPointerDown={(e) => e.stopPropagation()}>
            ✕
          </button>
        </div>
        <div className="dialog-body">{children}</div>
        <div className="dialog-buttons">{buttons}</div>
      </div>
    </div>
  );
}

function ExportDialog() {
  const [type, setType] = useState<ExportType>(() => useSettings.getState().exportFormat); // defaults: Preferences › Export
  const [quality, setQuality] = useState(() => useSettings.getState().exportQuality);
  const exportScale = useSettings((s) => s.exportScale);
  const [busy, setBusy] = useState(false);
  const [size] = useState(() => measureOutput());
  useDoc((s) => s.project.name); // re-render on rename (file name preview)
  const lossy = type !== 'image/png';
  const go = async () => {
    setBusy(true);
    try {
      await exportImage(type, quality);
      closeDialog();
    } catch (e) {
      status(`Export failed: ${(e as Error).message}`, 'error');
      setBusy(false);
    }
  };
  const mp = (size.width * size.height) / 1e6;
  return (
    <Dialog
      title="Export Image"
      icon="picture_save"
      onClose={closeDialog}
      buttons={
        <>
          <button className="btn default" disabled={busy || !size.width} onClick={() => void go()}>
            {busy ? 'Rendering…' : 'Export'}
          </button>
          <button className="btn" onClick={closeDialog}>
            Cancel
          </button>
        </>
      }
    >
      <fieldset className="groupbox">
        <legend>Format</legend>
        {(Object.keys(EXT) as ExportType[]).map((t) => (
          <label key={t} className="radio">
            <input type="radio" name="fmt" checked={type === t} onChange={() => setType(t)} />
            {t === 'image/png' ? 'PNG — lossless, 8 bit' : t === 'image/jpeg' ? 'JPEG — lossy, smallest' : 'WebP — lossy, modern'}
          </label>
        ))}
      </fieldset>
      <fieldset className="groupbox" disabled={!lossy}>
        <legend>Quality</legend>
        <div className="slider-row">
          <input
            type="range"
            className="slider"
            min={0.1}
            max={1}
            step={0.01}
            value={quality}
            onChange={(e) => setQuality(+e.target.value)}
            style={{ '--fill': `${((quality - 0.1) / 0.9) * 100}%` } as React.CSSProperties}
          />
          <span className="field num readonly">{Math.round(quality * 100)}</span>
        </div>
      </fieldset>
      <fieldset className="groupbox">
        <legend>Output</legend>
        <table className="kv">
          <tbody>
            <tr>
              <td>File name</td>
              <td>
                <code>
                  {exportBaseName()}.{EXT[type]}
                </code>
              </td>
            </tr>
            <tr>
              <td>Dimensions</td>
              <td>
                <b>
                  {size.width} × {size.height}
                </b>{' '}
                px ({mp.toFixed(1)} MP)
              </td>
            </tr>
            <tr>
              <td>Resolution</td>
              <td>{exportScale === 1 ? 'Full (scale 1.0)' : `${exportScale * 100}% (scale ${exportScale})`}, rendered from the Output node</td>
            </tr>
          </tbody>
        </table>
      </fieldset>
    </Dialog>
  );
}

function AboutDialog() {
  return (
    <Dialog
      title="About Darkroom"
      icon="information"
      onClose={closeDialog}
      width={430}
      buttons={
        <button className="btn default" onClick={closeDialog} autoFocus>
          OK
        </button>
      }
    >
      <div className="about">
        <Icon name="camera_lens" size={32} />
        <div>
          <div className="about-title">Darkroom</div>
          <div className="muted">Node-based, shader-based image editor · WebGL2</div>
          <p>
            {listNodeDefs().length} node types and {listPresets().length} presets registered.
          </p>
        </div>
      </div>
      <fieldset className="groupbox">
        <legend>Credits</legend>
        <p className="small">
          Icons: <b>Farm-Fresh Web Icons</b> by FatCow Web Hosting (
          <a href="http://www.fatcow.com/free-icons" target="_blank" rel="noreferrer">
            http://www.fatcow.com/free-icons
          </a>
          ), licensed under{' '}
          <a href="https://creativecommons.org/licenses/by/3.0/" target="_blank" rel="noreferrer">
            CC BY 3.0
          </a>
          .
        </p>
        <p className="small">Node graph: React Flow (MIT). State: Zustand, Immer (MIT).</p>
      </fieldset>
    </Dialog>
  );
}

const SHORTCUT_GROUPS: { title: string; ids: string[] }[] = [
  { title: 'File', ids: ['file.new', 'file.open', 'file.save', 'file.import', 'file.export', 'file.batch'] },
  { title: 'Edit', ids: ['edit.undo', 'edit.redo', 'edit.cut', 'edit.copy', 'edit.paste', 'edit.duplicate', 'edit.delete', 'edit.selectAll', 'edit.prefs'] },
  { title: 'Nodes & Groups', ids: ['node.add', 'node.bypass', 'node.view', 'node.viewOutput', 'edit.group', 'edit.ungroup', 'edit.enterGroup', 'edit.exitGroup'] },
  { title: 'View', ids: ['view.fitGraph', 'view.fitImage', 'view.actual', 'view.zoomIn', 'view.zoomOut', 'view.compare', 'view.library', 'view.properties'] },
  { title: 'Playback', ids: ['playback.toggle', 'playback.prevFrame', 'playback.nextFrame', 'file.exportVideo'] },
  {
    title: 'Viewer',
    ids: ['view.fill', 'view.scopes', 'view.readout', 'view.clip', 'view.channel.rgb', 'view.channel.r', 'view.channel.g', 'view.channel.b', 'view.channel.a', 'view.channel.luma', 'view.snapshot', 'view.pinCompare', 'view.presetBrowser'],
  },
];

function ShortcutsDialog() {
  return (
    <Dialog
      title="Keyboard Shortcuts"
      icon="keyboard"
      onClose={closeDialog}
      width={720}
      buttons={
        <button className="btn default" onClick={closeDialog} autoFocus>
          Close
        </button>
      }
    >
      <div className="shortcut-cols">
        {SHORTCUT_GROUPS.map((g) => (
          <fieldset className="groupbox" key={g.title}>
            <legend>{g.title}</legend>
            <table className="kv shortcuts">
              <tbody>
                {g.ids.map((id) => {
                  const c = commands[id];
                  if (!c) return null;
                  return (
                    <tr key={id}>
                      <td>
                        {c.icon && <Icon name={c.icon} />} {c.label.replace('…', '')}
                      </td>
                      <td>
                        {(c.keys ?? '').split('|').map((k) => (
                          <kbd key={k}>{displayKeys(k)}</kbd>
                        ))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </fieldset>
        ))}
        <fieldset className="groupbox">
          <legend>Mouse</legend>
          <table className="kv shortcuts">
            <tbody>
              <tr>
                <td>Graph: add node at cursor</td>
                <td>Right-click / Tab</td>
              </tr>
              <tr>
                <td>Graph: pan</td>
                <td>Middle-drag / Space+drag</td>
              </tr>
              <tr>
                <td>Graph: box select</td>
                <td>Left-drag on empty canvas</td>
              </tr>
              <tr>
                <td>Graph: open group / view node</td>
                <td>Double-click</td>
              </tr>
              <tr>
                <td>Connection into empty space</td>
                <td>Opens add-node popup</td>
              </tr>
              <tr>
                <td>Viewer: zoom / pan</td>
                <td>Wheel / drag</td>
              </tr>
              <tr>
                <td>Viewer: fit</td>
                <td>Double-click</td>
              </tr>
              <tr>
                <td>Viewer: pan over a tool</td>
                <td>Space+drag</td>
              </tr>
              <tr>
                <td>Viewer: show compare reference</td>
                <td>Hold \</td>
              </tr>
              <tr>
                <td>Viewer: colour sampler (max 4)</td>
                <td>Shift-click · Alt-click removes</td>
              </tr>
              <tr>
                <td>Play / pause (in motion)</td>
                <td>Tap Space</td>
              </tr>
              <tr>
                <td>Parameter: reset / expose</td>
                <td>Right-click</td>
              </tr>
            </tbody>
          </table>
        </fieldset>
      </div>
    </Dialog>
  );
}

function ConfirmNewDialog() {
  return (
    <Dialog
      title="Darkroom"
      icon="error"
      onClose={closeDialog}
      buttons={
        <>
          <button
            className="btn default"
            autoFocus
            onClick={() => {
              closeDialog();
              void newProject();
            }}
          >
            Discard
          </button>
          <button className="btn" onClick={closeDialog}>
            Cancel
          </button>
        </>
      }
    >
      <div className="about">
        <Icon name="error" size={32} />
        <div>
          <p>
            <b>The current project has unsaved changes.</b>
          </p>
          <p>Start a new project and discard them? (Use File › Save Project first to keep a copy.)</p>
        </div>
      </div>
    </Dialog>
  );
}

export function Dialogs() {
  const d = useUi((s) => s.dialog);
  if (d === 'export') return <ExportDialog />;
  if (d === 'exportVideo') return <ExportVideoDialog />;
  if (d === 'about') return <AboutDialog />;
  if (d === 'shortcuts') return <ShortcutsDialog />;
  if (d === 'confirmNew') return <ConfirmNewDialog />;
  if (d === 'prefs') return <PrefsWindow />;
  if (d === 'batch') return <BatchDialog />;
  return null;
}
