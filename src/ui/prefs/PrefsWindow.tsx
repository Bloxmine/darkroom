/**
 * The Preferences window, after Mac OS X 10.6 System Preferences: unified grey
 * title bar + icon toolbar, a fixed-width content pane whose height animates to
 * fit each pane, Aqua controls, live-applied settings (no OK/Cancel).
 * Theme-independent: it stays a light Aqua window in every app theme.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentType } from 'react';
import './prefs.css';
import { resetPrefs, type Prefs } from '../../store/settings';
import { closeDialog } from '../../store/ui';
import { Button } from './controls';
import { KeyboardPane } from './KeyboardPane';
import { GenerationPane } from '../../core/sd/GenerationPane';
import { recording } from './keys';
import { AdvancedPane, AppearancePane, ExportPane, GeneralPane, PerformancePane, PluginsPane, ViewerPane, type Ask, type PaneProps } from './panes';

interface PaneDef {
  id: string;
  label: string;
  icon: string;
  Comp: ComponentType<PaneProps>;
  keys: (keyof Prefs)[];
  help: string[];
}

const PANES: PaneDef[] = [
  {
    id: 'general',
    label: 'General',
    icon: 'setting_tools',
    Comp: GeneralPane,
    keys: ['launchAction', 'autosaveMs', 'undoDepth', 'confirmDiscard', 'defaultProjectName', 'autoConnect', 'insertOnWire', 'confirmDeleteOver'],
    help: [
      'Choose what Darkroom shows when it starts: the project you were last working on (restored from autosave), the starter project with a sample photo, or an empty graph.',
      'Autosave stores the open project in this browser so it survives a reload. “After every change” saves about a second after you stop editing; the timed settings save at most that often.',
      'Undo history sets how many steps Edit › Undo can go back. Larger values use more memory on big projects.',
    ],
  },
  {
    id: 'appearance',
    label: 'Appearance',
    icon: 'color_wheel',
    Comp: AppearancePane,
    keys: ['theme', 'uiScale', 'nodeThumbnails', 'minimap', 'wireStyle', 'grid', 'nodeTooltips', 'nodeIdTooltips', 'snapToGrid', 'gridSize', 'minimapPos'],
    help: [
      'Click a picture to change the look of the whole application. Automatic follows the system: Aperture in Dark Mode, Aqua in Light Mode.',
      'Interface size enlarges the menus, toolbars, panels and status bar. The node graph and viewer keep their own zoom.',
      'Wire style and grid change how the node graph is drawn; they don’t affect the image.',
    ],
  },
  {
    id: 'viewer',
    label: 'Viewer',
    icon: 'monitor',
    Comp: ViewerPane,
    keys: ['defaultQuality', 'viewerBg', 'pixelZoom', 'compareDefault', 'fitOnChange', 'compareLayout', 'scopesDefault', 'scopesType', 'pixelReadout', 'eyedropperSize', 'clipLow', 'clipHigh', 'presetThumbSize'],
    help: [
      'Preview quality is the resolution the viewer renders at; lower is faster on large images. Export always renders at full resolution.',
      'The background fills the viewer around the image. The checkerboard makes it easy to see the image edges.',
      'With sharp pixels on, zooming in past 100% shows individual pixels instead of a smoothed image.',
      'Scopes, the pixel readout, clipping indicators and the channel view are in the viewer toolbar and View menu. Clipping marks pixels at or beyond the thresholds: blue for crushed shadows, red for blown highlights.',
    ],
  },
  {
    id: 'performance',
    label: 'Performance',
    icon: 'speedometer',
    Comp: PerformancePane,
    keys: ['previewCap', 'poolSize', 'dragRender'],
    help: [
      'The Graphics box describes the GPU Darkroom is rendering with. Float render targets give 16-bit precision between nodes.',
      'Limiting the preview resolution keeps editing fluid on very large photos. Idle render targets are reused between frames: more is faster but holds more GPU memory.',
      'Clear Cache frees every cached intermediate image; the viewer re-renders from scratch.',
    ],
  },
  {
    id: 'export',
    label: 'Export',
    icon: 'picture_save',
    Comp: ExportPane,
    keys: ['exportFormat', 'exportQuality', 'exportScale', 'filenamePattern', 'includeSourceName'],
    help: [
      'These defaults are used by File › Export Image. You can still change the format and quality in the export window.',
      'The file name pattern may contain {project}, {source}, {date}, {time} and {scale}; they are replaced when exporting.',
    ],
  },
  {
    id: 'plugins',
    label: 'Plugins & AI',
    icon: 'plugin',
    Comp: PluginsPane,
    keys: ['allowCodePlugins', 'aiPreferWebGPU'],
    help: [
      'Data plugins add shader nodes and presets and are always safe. Code plugins are JavaScript modules; turn them off to block installing any.',
      'AI nodes download their neural-network models once and keep them in the browser’s cache. Delete them here to free disk space.',
      'With WebGPU preferred, AI models run on the graphics card when the browser supports it, and on the CPU otherwise.',
    ],
  },
  {
    id: 'generation',
    label: 'Generation',
    icon: 'artwork',
    Comp: GenerationPane,
    keys: ['genServer', 'genUrlComfy', 'genUrlA1111'],
    help: [
      'Generate (Stable Diffusion) nodes send a job to your own ComfyUI or AUTOMATIC1111 / Forge server and show the result. It is off by default.',
      'Nothing is sent until you choose a server here and press Generate on a node. Then the prompts and the images connected to that node go to this URL only.',
      'The server must allow requests from Darkroom (CORS). Test Connection lists its checkpoints and ControlNet models. Help › ControlNet has the launch commands.',
    ],
  },
  {
    id: 'keyboard',
    label: 'Keyboard',
    icon: 'keyboard',
    Comp: KeyboardPane,
    keys: ['keyOverrides'],
    help: [
      'Every menu command is listed with its shortcut. Click a shortcut (or select a row and click Record…) and press the new key combination; Esc cancels.',
      'Shortcuts used by more than one command are shown in red. Customized commands are shown in bold; Reset returns one to its default.',
    ],
  },
  {
    id: 'advanced',
    label: 'Advanced',
    icon: 'cog',
    Comp: AdvancedPane,
    keys: ['showFps', 'showNodeIds'],
    help: [
      'Export your preferences to move them to another browser or computer, and import them there.',
      'Clearing the autosave means the current project won’t be restored at the next launch.',
      'The developer options show render statistics in the viewer and the internal node ids used by the render engine.',
    ],
  },
];

const LAST_KEY = 'darkroom.prefs.lastPane';
const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

type Sheet =
  | { kind: 'help' }
  | {
      kind: 'ask';
      message: string;
      detail: string;
      ok: string;
      run: () => void;
    };

export function PrefsWindow() {
  const [tab, setTab] = useState(() => {
    try {
      const v = localStorage.getItem(LAST_KEY);
      return PANES.some((p) => p.id === v) ? v! : 'general';
    } catch {
      return 'general';
    }
  });
  const pane = PANES.find((p) => p.id === tab)!;
  const [height, setHeight] = useState<number | null>(null);
  const [switching, setSwitching] = useState(false);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [sheetH, setSheetH] = useState(0);
  const [pos, setPos] = useState(() => ({
    x: 0,
    y: Math.max(20, Math.round(window.innerHeight * 0.1)),
  }));
  const inner = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  const select = useCallback((id: string) => {
    setTab((cur) => {
      if (cur === id) return cur;
      setSwitching(true);
      setSheet(null);
      try {
        localStorage.setItem(LAST_KEY, id);
      } catch {
        /* ignore */
      }
      return id;
    });
  }, []);
  useEffect(() => {
    if (!switching) return;
    const t = setTimeout(() => setSwitching(false), 230);
    return () => clearTimeout(t);
  }, [switching, tab]);

  // the window grows/shrinks to fit the pane (content height is measured, the body's height animates)
  useLayoutEffect(() => {
    const el = inner.current!;
    const measure = () => setHeight(el.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tab]);

  // keyboard: ⌘1…⌘8 switch panes, Esc / ⌘W close
  useEffect(() => {
    const kd = (e: KeyboardEvent) => {
      if (recording.active) return;
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (mod && /^Digit[1-8]$/.test(e.code)) {
        e.preventDefault();
        select(PANES[+e.code.slice(5) - 1].id);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        if (sheet) setSheet(null);
        else closeDialog();
      } else if (mod && e.code === 'KeyW') {
        e.preventDefault();
        closeDialog();
      }
    };
    window.addEventListener('keydown', kd);
    return () => window.removeEventListener('keydown', kd);
  }, [select, sheet]);

  const ask: Ask = (message, detail, ok, run) => setSheet({ kind: 'ask', message, detail, ok, run });
  const Comp = pane.Comp;

  return (
    <div className="slp-layer" onMouseDown={(e) => e.stopPropagation()}>
      <div className="slp" role="dialog" aria-label={`Preferences — ${pane.label}`} style={{ top: pos.y, transform: `translateX(${pos.x}px)` }}>
        <div
          className="slp-head"
          onPointerDown={(e) => {
            if ((e.target as HTMLElement).closest('button')) return;
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            drag.current = { x: e.clientX, y: e.clientY, ox: pos.x, oy: pos.y };
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (d)
              setPos({
                x: d.ox + e.clientX - d.x,
                y: Math.max(0, Math.min(window.innerHeight - 40, d.oy + e.clientY - d.y)),
              });
          }}
          onPointerUp={() => (drag.current = null)}
        >
          <div className="slp-lights">
            <button type="button" className="slp-light close" title="Close" aria-label="Close" onClick={closeDialog}>
              ×
            </button>
            <button type="button" className="slp-light min" disabled aria-label="Minimize" />
            <button type="button" className="slp-light zoom" disabled aria-label="Zoom" />
          </div>
          <div className="slp-title">{pane.label}</div>
          <div className="slp-toolbar" role="tablist">
            {PANES.map((p, i) => (
              <button
                key={p.id}
                type="button"
                role="tab"
                aria-selected={p.id === tab}
                className={'slp-tool' + (p.id === tab ? ' selected' : '')}
                title={`${p.label} (${isMac ? '⌘' : 'Ctrl+'}${i + 1})`}
                onClick={() => select(p.id)}
              >
                <img src={`/icons/fatcow/32x32/${p.icon}.png`} alt="" />
                {p.label}
              </button>
            ))}
          </div>
        </div>
        <div className="slp-body" style={height !== null ? { height: Math.max(height, sheet ? sheetH + 12 : 0) } : undefined}>
          <div ref={inner} className={'slp-pane' + (switching ? ' switching' : '')} data-pane={tab}>
            <Comp ask={ask} />
            <div className="slp-foot">
              <button
                type="button"
                className="slp-help"
                title="Help"
                aria-label="Help"
                onClick={() => setSheet(sheet?.kind === 'help' ? null : { kind: 'help' })}
              >
                ?
              </button>
              <span className="grow" />
              <Button onClick={() => resetPrefs(pane.keys)}>Restore Defaults</Button>
            </div>
          </div>
          {sheet && (
            <div
              className="slp-sheet"
              role="alertdialog"
              ref={(el) => {
                if (el && el.offsetHeight !== sheetH) setSheetH(el.offsetHeight);
              }}
            >
              {sheet.kind === 'help' ? (
                <>
                  <h3>
                    <img src={`/icons/fatcow/32x32/${pane.icon}.png`} alt="" />
                    {pane.label} Preferences
                  </h3>
                  {pane.help.map((t, i) => (
                    <p key={i}>{t}</p>
                  ))}
                  <div className="slp-foot">
                    <Button primary onClick={() => setSheet(null)}>
                      OK
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <h3>
                    <img src="/icons/fatcow/32x32/error.png" alt="" />
                    {sheet.message}
                  </h3>
                  <p>{sheet.detail}</p>
                  <div className="slp-foot">
                    <Button onClick={() => setSheet(null)}>Cancel</Button>
                    <Button
                      primary
                      onClick={() => {
                        setSheet(null);
                        sheet.run();
                      }}
                    >
                      {sheet.ok}
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
