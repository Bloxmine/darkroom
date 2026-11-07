import { useEffect } from 'react';
import { frameCount, frameOf, inMotion, seek, setTimeline, togglePlay, useTimeline } from '../store/timeline';
import { useUi } from '../store/ui';
import { NumField } from './NumField';
import { ToolButton } from './Toolbar';
import { onSpaceTap } from './viewer/spaceKey';
import './transport.css';

/** mm:ss.ff (ff = frame within the second). */
function timecode(t: number, fps: number) {
  const f = frameOf(t, fps);
  const fr = Math.round(fps) || 1;
  const s = Math.floor(f / fr);
  const ff = f % fr;
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.${String(ff).padStart(2, '0')}`;
}

const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  return el.tagName === 'INPUT' && !['checkbox', 'radio', 'button'].includes((el as HTMLInputElement).type);
};

/**
 * Space *tap* = play/pause (when the project is in motion and focus isn't in a field). Holding
 * Space and dragging pans the viewer / node graph instead (see viewer/spaceKey.ts).
 */
function useTransportKeys() {
  useEffect(() => {
    const offTap = onSpaceTap(() => {
      if (useUi.getState().dialog || useUi.getState().quickAdd || isTyping(document.activeElement) || !inMotion()) return;
      togglePlay();
    });
    // ←/→ on a focused range input adjust that slider, not the timeline (commands.ts handles them otherwise)
    const guard = (e: KeyboardEvent) => {
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && (e.target as HTMLInputElement)?.type === 'range') e.stopPropagation();
    };
    window.addEventListener('keydown', guard, true);
    return () => {
      offTap();
      window.removeEventListener('keydown', guard, true);
    };
  }, []);
}

/** Compact timeline bar under the viewer; shown while the project is in motion. */
export function Transport() {
  useTransportKeys();
  const s = useTimeline();
  if (!inMotion(s)) return null;
  const n = frameCount(s);
  const f = Math.min(n - 1, frameOf(s.time, s.fps));
  const fill = `${(f / Math.max(1, n - 1)) * 100}%`;
  return (
    <div className="viewer-toolbar transport-bar" aria-label="Timeline">
      <ToolButton id="playback.start" />
      <ToolButton id="playback.prevFrame" />
      <ToolButton id="playback.toggle" />
      <ToolButton id="playback.nextFrame" />
      <ToolButton id="playback.loop" />
      <span className="tsep" />
      <input
        type="range"
        className="slider transport-scrub"
        min={0}
        max={Math.max(0, n - 1)}
        step={1}
        value={f}
        disabled={s.exporting}
        onChange={(e) => seek(+e.target.value / s.fps)}
        style={{ '--fill': fill } as React.CSSProperties}
        title="Scrub"
      />
      <span className="transport-time" title={`Frame ${f + 1} of ${n}`}>
        {timecode(s.time, s.fps)} <span className="muted">/ {timecode(s.duration, s.fps)}</span>
      </span>
      <span className="muted small transport-frame">
        #{f}
      </span>
      <span className="tsep" />
      <label className="tb-label" title="Timeline frame rate">
        fps
        <NumField value={s.fps} onChange={(v) => setTimeline({ fps: v })} step={1} width={38} />
      </label>
      <label className="tb-label" title="Timeline length in seconds (also the default export duration)">
        len
        <NumField value={s.duration} onChange={(v) => setTimeline({ duration: v })} step={0.1} width={44} />
      </label>
      <select
        className="field select transport-mode"
        value={s.realtime ? 'rt' : 'all'}
        onChange={(e) => setTimeline({ realtime: e.target.value === 'rt' })}
        title="Realtime: keep wall-clock speed, drop frames if rendering is slow. Every frame: render each frame (slower than realtime when heavy)."
      >
        <option value="rt">Realtime</option>
        <option value="all">Every frame</option>
      </select>
      <span className="muted small transport-fps" title="Measured preview frame rate">
        {s.playing ? `${s.measuredFps} fps` : s.hasLive ? 'live' : 'paused'}
      </span>
      <span className="flex1" />
      <ToolButton id="playback.animate" />
      <ToolButton id="file.exportVideo" />
    </div>
  );
}

/** Viewer-toolbar toggle for "Animate" (time runs on stills); re-renders with the timeline. */
export function AnimateButton() {
  useTimeline((s) => `${s.animate}|${s.exporting}`);
  return <ToolButton id="playback.animate" />;
}
