import { useEffect, useRef, useState } from 'react';
import { useDoc } from '../store/doc';
import { measureOutput } from '../store/io';
import { useTimeline } from '../store/timeline';
import { closeDialog, status } from '../store/ui';
import {
  canPassAudio,
  checkVideoSupport,
  CODECS,
  downloadBlob,
  exportSize,
  exportVideo,
  measureVideoOutput,
  type QualityName,
  type VideoContainer,
  type VideoExportOptions,
} from '../store/videoExport';
import { Dialog } from './Dialogs';
import { NumField } from './NumField';
import './transport.css';

const SCALES = [1, 0.75, 0.5, 0.25];
const QUALITY_LABELS: Record<QualityName, string> = { low: 'Low', medium: 'Medium', high: 'High', 'very-high': 'Very high' };

/** File › Export Video… — offline frame-by-frame render to MP4 / WebM (store/videoExport.ts). */
export function ExportVideoDialog() {
  const tl = useTimeline.getState();
  const name = useDoc((s) => s.project.name) || 'untitled';
  const [full, setFull] = useState(() => measureOutput());
  const [o, setO] = useState<VideoExportOptions>(() => ({
    container: 'mp4',
    codec: 'avc',
    scale: 1,
    fps: tl.fps,
    duration: tl.duration,
    bitrateMbps: 0,
    quality: 'high',
    audio: canPassAudio(),
    slowMo: 1,
  }));
  const [support, setSupport] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ frame: number; frames: number; t0: number; now: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const size = exportSize(full, o.scale);
  const slow = o.slowMo ?? 1;
  const frames = Math.max(1, Math.round(o.duration * slow * o.fps));
  const audioOk = canPassAudio() && slow === 1;
  const set = (p: Partial<VideoExportOptions>) => setO((x) => ({ ...x, ...p }));

  useEffect(() => {
    void measureVideoOutput().then(setFull); // once video frames are decoded
  }, []);
  useEffect(() => {
    let live = true;
    setSupport(null);
    void checkVideoSupport(o, size.width, size.height).then((r) => live && setSupport(r ?? ''));
    return () => {
      live = false;
    };
  }, [o, size.width, size.height]);

  const busy = !!progress;
  const go = async () => {
    setError(null);
    const ac = new AbortController();
    abort.current = ac;
    const t0 = performance.now();
    setProgress({ frame: 0, frames, t0, now: t0 });
    let lastUi = 0;
    try {
      const r = await exportVideo(
        o,
        (frame, total) => {
          const now = performance.now();
          if (now - lastUi > 80 || frame === total) {
            lastUi = now;
            setProgress({ frame, frames: total, t0, now });
          }
        },
        ac.signal,
      );
      downloadBlob(r.blob, `${name}.${r.ext}`);
      const secs = r.ms / 1000;
      status(
        `Exported ${r.frames} frames ${r.width}×${r.height} (${(r.blob.size / 1024 / 1024).toFixed(1)} MB) in ${secs.toFixed(1)} s — ` +
          `${(r.frames / secs).toFixed(1)} fps, ${((r.frames / o.fps) / secs).toFixed(2)}× realtime${r.audio ? `; audio: ${r.audio}` : ''}.`,
      );
      closeDialog();
    } catch (e) {
      if ((e as Error).name === 'AbortError') status('Video export cancelled.');
      else setError((e as Error).message);
      setProgress(null);
    }
  };
  const cancel = () => {
    if (busy) abort.current?.abort();
    else closeDialog();
  };

  const pct = progress ? (progress.frame / progress.frames) * 100 : 0;
  const elapsed = progress ? (progress.now - progress.t0) / 1000 : 0;
  const rate = progress && elapsed > 0 ? progress.frame / elapsed : 0;
  const eta = rate > 0 && progress ? (progress.frames - progress.frame) / rate : 0;

  return (
    <Dialog
      title="Export Video"
      icon="film_save"
      onClose={cancel}
      width={430}
      buttons={
        <>
          <button className="btn default" disabled={busy || !full.width || !!support} onClick={() => void go()}>
            {busy ? 'Rendering…' : 'Export'}
          </button>
          <button className="btn" onClick={cancel}>
            Cancel
          </button>
        </>
      }
    >
      <fieldset className="groupbox" disabled={busy}>
        <legend>Format</legend>
        <div className="vx-grid">
          <span>Container</span>
          <span>
            {(['mp4', 'webm'] as VideoContainer[]).map((c) => (
              <label key={c} className="check" style={{ marginRight: 12 }}>
                <input type="radio" name="vx-container" checked={o.container === c} onChange={() => set({ container: c, codec: CODECS[c][0].codec })} />
                {c === 'mp4' ? 'MP4' : 'WebM'}
              </label>
            ))}
          </span>
          <label htmlFor="vx-codec">Codec</label>
          <select id="vx-codec" className="field select" value={o.codec} onChange={(e) => set({ codec: e.target.value as VideoExportOptions['codec'] })}>
            {CODECS[o.container].map((c) => (
              <option key={c.codec} value={c.codec}>
                {c.label}
              </option>
            ))}
          </select>
          <label htmlFor="vx-quality">Quality</label>
          <span className="tb-label">
            <select id="vx-quality" className="field select" value={o.quality} disabled={o.bitrateMbps > 0} onChange={(e) => set({ quality: e.target.value as QualityName })} style={{ width: 100 }}>
              {(Object.keys(QUALITY_LABELS) as QualityName[]).map((q) => (
                <option key={q} value={q}>
                  {QUALITY_LABELS[q]}
                </option>
              ))}
            </select>
            or
            <NumField value={o.bitrateMbps} onChange={(v) => set({ bitrateMbps: Math.max(0, v) })} step={0.5} width={48} /> Mbit/s
          </span>
          <span />
          <label className="check" title={audioOk ? 'Copy the audio of the first video source (no re-encode).' : 'Needs a video source with audio at speed 1.'}>
            <input type="checkbox" checked={o.audio && audioOk} disabled={!audioOk} onChange={(e) => set({ audio: e.target.checked })} />
            Include audio from the source video
          </label>
        </div>
      </fieldset>
      <fieldset className="groupbox" disabled={busy}>
        <legend>Frames</legend>
        <div className="vx-grid">
          <label htmlFor="vx-scale">Resolution</label>
          <select id="vx-scale" className="field select" value={o.scale} onChange={(e) => set({ scale: +e.target.value })}>
            {SCALES.map((s) => {
              const z = exportSize(full, s);
              return (
                <option key={s} value={s}>
                  {s === 1 ? 'Full' : `${s * 100}%`} — {z.width} × {z.height}
                </option>
              );
            })}
          </select>
          <span>Frame rate</span>
          <span className="tb-label">
            <NumField value={o.fps} onChange={(v) => set({ fps: Math.max(1, Math.min(120, v)) })} step={1} width={48} /> fps
          </span>
          <span>Duration</span>
          <span className="tb-label">
            <NumField value={o.duration} onChange={(v) => set({ duration: Math.max(0.1, Math.min(3600, v)) })} step={0.1} width={48} /> s
            <span className="muted">({frames} frames{!tl.hasVideo ? ', animated noise' : ''}{slow > 1 ? `, ${(o.duration * slow).toFixed(1)} s out` : ''})</span>
          </span>
          <label htmlFor="vx-slowmo">Slow motion</label>
          <select
            id="vx-slowmo"
            className="field select"
            value={slow}
            disabled={!tl.hasVideo}
            title="Renders in-between frames of the source video with RIFE (AI frame interpolation, ~23 MB model): the export is 2× / 4× longer and stays smooth. Slow: one AI inference per new frame."
            onChange={(e) => set({ slowMo: +e.target.value })}
          >
            <option value={1}>Off</option>
            <option value={2}>Smooth slow motion ×2 (AI frame interpolation)</option>
            <option value={4}>Smooth slow motion ×4 (AI frame interpolation)</option>
          </select>
        </div>
      </fieldset>
      {support === null && <p className="muted small">Checking encoder support…</p>}
      {!!support && <p className="vx-error">{support}</p>}
      {error && <p className="vx-error">Export failed: {error}</p>}
      {progress && (
        <>
          <div className="vx-progress sunken">
            <span style={{ width: `${pct}%` }} />
          </div>
          <div className="muted small">
            Frame {progress.frame} / {progress.frames} · {rate.toFixed(1)} fps · {eta > 0 ? `${Math.ceil(eta)} s left` : 'finishing…'}
          </div>
        </>
      )}
    </Dialog>
  );
}
