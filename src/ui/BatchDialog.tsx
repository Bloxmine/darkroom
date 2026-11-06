import { useMemo, useRef, useState } from 'react';
import './batch.css';
import { sourceNodes } from '../core/batch/graphInput';
import { expandPattern, formatEta } from '../core/batch/naming';
import { IMPORT_ACCEPT, isRawFile, RAW } from '../core/raw/formats';
import { canPickDirectory, cancelBatch, clearBatch, addBatchFiles, presetName, removeBatchItem, runBatch, setBatchSettings, useBatch } from '../store/batch';
import { outputNodeId, useDoc } from '../store/doc';
import { EXT, pickFiles, type ExportType } from '../store/io';
import { closeDialog, status } from '../store/ui';
import { Dialog } from './Dialogs';
import { Icon } from './Icon';

/** Folder picker via <input webkitdirectory> (all browsers with folder upload). */
function pickFolder(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    (input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true;
    input.multiple = true;
    input.onchange = () => resolve([...(input.files ?? [])]);
    input.click();
  });
}

/** Files from a drop, descending into dropped folders where supported. */
async function filesFromDrop(dt: DataTransfer): Promise<File[]> {
  type Entry = { isFile: boolean; isDirectory: boolean; name: string; file?: (cb: (f: File) => void, err: (e: unknown) => void) => void; createReader?: () => { readEntries: (cb: (e: Entry[]) => void, err: (e: unknown) => void) => void } };
  const entries = [...dt.items].map((i) => (i as DataTransferItem & { webkitGetAsEntry?: () => Entry | null }).webkitGetAsEntry?.()).filter(Boolean) as Entry[];
  if (!entries.length || !entries.some((e) => e.isDirectory)) return [...dt.files];
  const out: File[] = [];
  const walk = async (e: Entry): Promise<void> => {
    if (e.isFile && e.file) out.push(await new Promise<File>((res, rej) => e.file!(res, rej)));
    else if (e.isDirectory && e.createReader) {
      const r = e.createReader();
      for (;;) {
        const batch = await new Promise<Entry[]>((res, rej) => r.readEntries(res, rej));
        if (!batch.length) break;
        for (const c of batch) await walk(c);
      }
    }
  };
  for (const e of entries) await walk(e);
  return out;
}

const STATUS_LABEL = { queued: 'queued', running: 'processing…', done: 'done', error: 'failed', cancelled: 'cancelled' } as const;

export function BatchDialog() {
  const items = useBatch((s) => s.items);
  const settings = useBatch((s) => s.settings);
  const running = useBatch((s) => s.running);
  const startedAt = useBatch((s) => s.startedAt);
  const result = useBatch((s) => s.result);
  const project = useDoc((s) => s.project);
  const [over, setOver] = useState(false);
  const stripRef = useRef<HTMLDivElement>(null);

  const sources = useMemo(() => sourceNodes(project.graph, outputNodeId(project)), [project]);
  const preset = useMemo(() => presetName(project), [project]);
  const input = settings.input && sources.some((s) => s.id === settings.input) ? settings.input : (sources[0]?.id ?? '');
  const lossy = settings.type !== 'image/png';
  const done = items.filter((i) => i.status === 'done');
  const finished = items.filter((i) => i.status === 'done' || i.status === 'error' || i.status === 'cancelled').length;
  const errors = items.filter((i) => i.status === 'error');
  const pct = items.length ? (finished / items.length) * 100 : 0;
  const avg = done.length ? done.reduce((s, i) => s + (i.ms ?? 0), 0) / done.length / 1000 : (Date.now() - startedAt) / 1000 / Math.max(1, finished);
  const eta = running ? formatEta(avg * (items.length - finished)) : '';
  const example = expandPattern(settings.pattern, { name: items[0]?.file.name ?? 'IMG_0001.dng', preset, index: 1 }) + '.' + EXT[settings.type];
  const queued = items.filter((i) => i.status !== 'done').length;

  const start = async () => {
    try {
      setBatchSettings({ input });
      await runBatch();
      stripRef.current?.scrollTo({ left: 1e6 });
    } catch (e) {
      if ((e as Error).name === 'AbortError') return; // directory picker dismissed
      status(`Batch failed: ${(e as Error).message}`, 'error');
    }
  };

  const label = (s: (typeof sources)[number]) => {
    const n = s.node;
    const kind = n.type === RAW ? 'RAW' : 'Image';
    const where = s.id.includes('/') ? ' (in group)' : '';
    return `${n.label || kind} — ${kind}${where}${s.feedsOutput ? '' : ' · not connected to Output'}`;
  };

  return (
    <Dialog
      title="Batch Process"
      icon="images"
      width={560}
      onClose={() => (running ? cancelBatch() : closeDialog())}
      buttons={
        <>
          {running ? (
            <button className="btn default" onClick={cancelBatch}>
              Cancel batch
            </button>
          ) : (
            <button className="btn default" disabled={!queued || !input} onClick={() => void start()}>
              {settings.dest === 'folder' ? 'Process to folder…' : `Process ${queued} file${queued === 1 ? '' : 's'}`}
            </button>
          )}
          <button className="btn" disabled={running} onClick={closeDialog}>
            Close
          </button>
        </>
      }
    >
      <fieldset className="groupbox" disabled={running}>
        <legend>Files ({items.length})</legend>
        <div
          className={'batch-drop' + (over ? ' over' : '')}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={async (e) => {
            e.preventDefault();
            e.stopPropagation();
            setOver(false);
            addBatchFiles(await filesFromDrop(e.dataTransfer));
          }}
        >
          {items.length === 0 ? (
            <div className="empty">Drop photos or folders here (JPEG, PNG, WebP, DNG, CR2, CR3, NEF, ARW, RAF…)</div>
          ) : (
            <ul className="batch-files">
              {items.map((it) => (
                <li key={it.id} className={it.status}>
                  <Icon name={isRawFile(it.file.name, it.file.type) ? 'camera' : 'picture'} />
                  <span className="bname" title={it.path}>
                    {it.path}
                  </span>
                  <span className="bstat" title={it.error}>
                    {it.status === 'done' && it.outName ? `→ ${it.outName} (${Math.round((it.size ?? 0) / 1024)} KB)` : STATUS_LABEL[it.status]}
                  </span>
                  {!running && (
                    <button className="bx" title="Remove" onClick={() => removeBatchItem(it.id)}>
                      ✕
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="batch-tools">
          <button className="btn" onClick={async () => addBatchFiles(await pickFiles(IMPORT_ACCEPT, true))}>
            <Icon name="images" /> Add files…
          </button>
          <button className="btn" onClick={async () => addBatchFiles(await pickFolder())}>
            <Icon name="folder" /> Add folder…
          </button>
          <button className="btn" disabled={!items.length} onClick={clearBatch}>
            Clear
          </button>
        </div>
      </fieldset>

      <fieldset className="groupbox" disabled={running}>
        <legend>Processing</legend>
        <div className="batch-row">
          <label htmlFor="batch-input">Batch input:</label>
          {sources.length ? (
            <select id="batch-input" className="field select" value={input} onChange={(e) => setBatchSettings({ input: e.target.value })}>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {label(s)}
                </option>
              ))}
            </select>
          ) : (
            <span style={{ color: 'var(--error)' }}>Add an Image or RAW node to the graph first.</span>
          )}
        </div>
        <div className="batch-row">
          <label htmlFor="batch-fmt">Format:</label>
          <span className="batch-inline">
            <select id="batch-fmt" className="field select" value={settings.type} onChange={(e) => setBatchSettings({ type: e.target.value as ExportType })}>
              <option value="image/jpeg">JPEG</option>
              <option value="image/png">PNG</option>
              <option value="image/webp">WebP</option>
            </select>
            <span className="muted" style={{ opacity: lossy ? 1 : 0.5 }}>
              Quality
            </span>
            <input
              type="range"
              className="slider"
              disabled={!lossy}
              min={0.1}
              max={1}
              step={0.01}
              value={settings.quality}
              onChange={(e) => setBatchSettings({ quality: +e.target.value })}
              style={{ width: 140, '--fill': `${((settings.quality - 0.1) / 0.9) * 100}%` } as React.CSSProperties}
            />
            <span className="field num readonly">{Math.round(settings.quality * 100)}</span>
          </span>
        </div>
        <div className="batch-row">
          <label htmlFor="batch-size">Size:</label>
          <span className="batch-inline">
            <select
              id="batch-size"
              className="field select"
              value={settings.longEdge ? 'edge' : 'full'}
              onChange={(e) => setBatchSettings({ longEdge: e.target.value === 'full' ? 0 : settings.longEdge || 2048 })}
            >
              <option value="full">100 % (full resolution)</option>
              <option value="edge">Long edge…</option>
            </select>
            {settings.longEdge > 0 && (
              <>
                <input
                  className="field num"
                  type="number"
                  min={16}
                  max={32768}
                  value={settings.longEdge}
                  onChange={(e) => setBatchSettings({ longEdge: Math.max(16, Math.min(32768, Math.round(+e.target.value) || 2048)) })}
                />
                <span className="muted">px (never upscales)</span>
              </>
            )}
          </span>
        </div>
        <div className="batch-row">
          <label htmlFor="batch-pattern">File names:</label>
          <input id="batch-pattern" className="field text" value={settings.pattern} onChange={(e) => setBatchSettings({ pattern: e.target.value })} spellCheck={false} />
        </div>
        <div className="batch-row">
          <span />
          <span className="muted small">
            e.g. <code>{example}</code> · tokens: {'{name} {preset} {n} {n:3} {date} {w} {h} {ext}'}
          </span>
        </div>
        <div className="batch-row">
          <span>Save to:</span>
          <span className="batch-inline">
            <label className="radio">
              <input type="radio" name="batch-dest" checked={settings.dest === 'zip'} onChange={() => setBatchSettings({ dest: 'zip' })} /> ZIP download
            </label>
            <label className="radio" title={canPickDirectory() ? '' : 'Needs the File System Access API (Chrome / Edge)'}>
              <input type="radio" name="batch-dest" disabled={!canPickDirectory()} checked={settings.dest === 'folder'} onChange={() => setBatchSettings({ dest: 'folder' })} /> Folder…
            </label>
          </span>
        </div>
      </fieldset>

      <fieldset className="groupbox">
        <legend>Progress</legend>
        <div className="batch-progress sunken" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
          <div style={{ width: `${pct}%` }} />
        </div>
        <div className="batch-meta">
          <span>
            {finished} / {items.length}
            {errors.length ? ` · ${errors.length} failed` : ''}
          </span>
          <span>{running ? `ETA ${eta}` : result}</span>
        </div>
        <div className="batch-strip" ref={stripRef}>
          {items.map((it) => (
            <div key={it.id} className={'batch-thumb ' + it.status} title={`${it.path}${it.error ? ` — ${it.error}` : ''}`}>
              {it.thumb ? <img src={it.thumb} alt={it.outName} /> : <span>{it.status === 'running' ? '…' : it.status === 'error' ? '✕' : it.file.name.slice(0, 10)}</span>}
            </div>
          ))}
        </div>
        {errors.length > 0 && (
          <ul className="batch-errors">
            {errors.map((it) => (
              <li key={it.id}>
                <b>{it.path}</b>: {it.error}
              </li>
            ))}
          </ul>
        )}
      </fieldset>
    </Dialog>
  );
}
