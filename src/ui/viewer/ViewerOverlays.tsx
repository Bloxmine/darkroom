/**
 * DOM overlays inside the viewer host: the A/B split handle, colour-sampler markers, the pixel
 * readout chip and the eyedropper capture layer. Theme tokens only (viewerPro.css).
 */
import { useEffect, useRef, useState } from 'react';
import { hex6, luma709, rgbToHsl, splitFromPointer, to255 } from '../../core/scopes';
import { imageRect } from '../../store/engine';
import { useUi } from '../../store/ui';
import { cancelEyedropper, finishEyedropper, moveSampler, removeSampler, useViewer, type PixelSample } from '../../store/viewer';
import { Icon } from '../Icon';
import { imagePxAt, samplePixel, sideAt } from './pixels';

// ---------------------------------------------------------------------------
// Split handle
// ---------------------------------------------------------------------------

export function SplitHandle({ refName, mainName }: { refName: string; mainName: string }) {
  const compare = useUi((s) => s.compare);
  const split = useUi((s) => s.split);
  const mode = useViewer((s) => s.compareMode);
  const splitY = useViewer((s) => s.splitY);
  const swap = useViewer((s) => s.swap);
  const hold = useViewer((s) => s.hold);
  const [dragging, setDragging] = useState(false);
  if (hold)
    return (
      <div className="vx-compare-flag">
        <Icon name="compare" /> Reference: <b>{refName || '—'}</b>
      </div>
    );
  if (!compare) return null;
  if (mode === 'toggle')
    return (
      <div className="vx-compare-flag">
        Showing <b>{mainName}</b> · hold <kbd>\</kbd> for {refName || 'the reference'}
      </div>
    );
  const vert = mode === 'h';
  const pos = vert ? split : splitY;
  const [first, second] = swap ? [mainName, refName] : [refName, mainName];
  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!(e.currentTarget as Element).hasPointerCapture(e.pointerId)) return;
    e.stopPropagation();
    const host = (e.currentTarget as HTMLElement).parentElement!.getBoundingClientRect();
    const f = splitFromPointer(e.clientX - host.left, e.clientY - host.top, mode, host.width, host.height);
    if (vert) useUi.setState({ split: f });
    else useViewer.setState({ splitY: f });
  };
  const onUp = (e: React.PointerEvent) => {
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    setDragging(false);
  };
  return (
    <div
      className={'vx-split ' + (vert ? 'vx-split-h' : 'vx-split-v') + (dragging ? ' dragging' : '')}
      style={vert ? { left: `${pos * 100}%` } : { top: `${pos * 100}%` }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (vert) useUi.setState({ split: 0.5 });
        else useViewer.setState({ splitY: 0.5 });
      }}
      title="Drag to move the split · double-click to centre"
    >
      <span className="vx-split-line" />
      <span className="vx-split-knob">
        <span className="vx-split-arrows">{vert ? '◀ ▶' : '▲▼'}</span>
      </span>
      <span className="vx-split-tag first" title={first}>
        {first || '—'}
      </span>
      <span className="vx-split-tag second" title={second}>
        {second}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Readout formatting
// ---------------------------------------------------------------------------

export function fmtSample(s: PixelSample) {
  const [r, g, b, a] = s.rgba;
  const [h, sat, l] = rgbToHsl(r, g, b);
  return {
    pos: `${s.x}, ${s.y}`,
    b8: [r, g, b, a].map(to255),
    f: [r, g, b, a].map((x) => x.toFixed(3)),
    hex: hex6(r, g, b),
    luma: luma709(r, g, b),
    hsl: `${Math.round(h)}° ${Math.round(sat * 100)}% ${Math.round(l * 100)}%`,
    css: `rgb(${to255(r)},${to255(g)},${to255(b)})`,
  };
}

function ReadoutRow({ s, label, onRemove, compact }: { s: PixelSample; label: React.ReactNode; onRemove?: () => void; compact?: boolean }) {
  const f = fmtSample(s);
  return (
    <div className="vx-ro-row">
      <span className="vx-ro-label">{label}</span>
      <span className="vx-ro-swatch" style={{ background: f.css }} />
      <span className="vx-ro-pos" title="Image coordinates (full-resolution pixels)">
        {f.pos}
      </span>
      <span className="vx-ro-rgb" title="8-bit RGBA">
        <i className="r">R</i>
        {f.b8[0]} <i className="g">G</i>
        {f.b8[1]} <i className="b">B</i>
        {f.b8[2]} <i>A</i>
        {f.b8[3]}
      </span>
      {!compact && (
        <span className="vx-ro-f" title="0–1 values as rendered (float precision; may exceed 1 in HDR)">
          {f.f.slice(0, 3).join(' ')}
        </span>
      )}
      <span className="vx-ro-hex">{f.hex}</span>
      <span className="vx-ro-l" title="Rec.709 luma">
        L {f.luma.toFixed(3)}
      </span>
      {!compact && (
        <span className="vx-ro-hsl" title="Hue, saturation, lightness">
          HSL {f.hsl}
        </span>
      )}
      {onRemove && (
        <button className="vx-ro-x" onClick={onRemove} title="Remove sampler">
          ×
        </button>
      )}
    </div>
  );
}

/** Floating chip: the value under the cursor plus every colour sampler. */
export function ReadoutChip() {
  const readout = useViewer((s) => s.readout);
  const hover = useViewer((s) => s.hover);
  const samplers = useViewer((s) => s.samplers);
  const eyedrop = useViewer((s) => s.eyedrop);
  const live = samplers.filter((s) => s.value);
  if (!readout && !live.length && !eyedrop) return null;
  return (
    <div className="vx-readout" onPointerDown={(e) => e.stopPropagation()}>
      {eyedrop && (
        <div className="vx-ro-row vx-ro-hint">
          <Icon name="color_picker" /> Click the image to pick <b>{eyedrop.label}</b>
          {eyedrop.size > 1 ? ` (${eyedrop.size}×${eyedrop.size} average)` : ''} · Esc cancels
        </div>
      )}
      {(readout || eyedrop) &&
        (hover ? (
          <ReadoutRow s={hover} label={hover.side === 'ref' ? 'Ref' : <Icon name="cursor" />} />
        ) : (
          <div className="vx-ro-row vx-ro-empty muted">
            <span className="vx-ro-label">
              <Icon name="cursor" />
            </span>
            Hover the image · Shift-click to add a colour sampler
          </div>
        ))}
      {live.map((s) => (
        <ReadoutRow key={s.id} s={s.value!} label={<span className="vx-ro-num">#{s.id}</span>} onRemove={() => removeSampler(s.id)} compact />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sampler markers
// ---------------------------------------------------------------------------

/** Re-render on view changes. */
function useViewKey() {
  useUi((s) => `${s.fit}|${s.zoom}|${s.panX}|${s.panY}|${s.fullWidth}|${s.fullHeight}`);
}

export function SamplerMarkers() {
  useViewKey();
  const samplers = useViewer((s) => s.samplers);
  const drag = useRef<number | null>(null);
  if (!samplers.length) return null;
  const r = imageRect();
  const dpr = window.devicePixelRatio || 1;
  const toCss = (u: number, v: number) => ({ x: (r.x + u * r.w) / dpr, y: (r.y + v * r.h) / dpr });
  return (
    <svg className="vx-samplers">
      {samplers.map((s) => {
        const c = toCss(s.u, s.v);
        return (
          <g
            key={s.id}
            className="vx-sampler"
            transform={`translate(${c.x},${c.y})`}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.stopPropagation();
              if (e.altKey) return removeSampler(s.id);
              (e.currentTarget as Element).setPointerCapture(e.pointerId);
              drag.current = s.id;
            }}
            onPointerMove={(e) => {
              if (drag.current !== s.id) return;
              e.stopPropagation();
              const host = (e.currentTarget as SVGGElement).ownerSVGElement!.getBoundingClientRect();
              const u = ((e.clientX - host.left) * dpr - r.x) / r.w;
              const v = ((e.clientY - host.top) * dpr - r.y) / r.h;
              moveSampler(s.id, Math.min(1, Math.max(0, u)), Math.min(1, Math.max(0, v)));
            }}
            onPointerUp={() => (drag.current = null)}
          >
            <title>{`Colour sampler #${s.id} — drag to move, Alt-click to remove`}</title>
            <circle r={9} className="vx-sampler-hit" />
            <circle r={5.5} className="vx-sampler-ring" />
            <line x1={-9} x2={-3} y1={0} y2={0} />
            <line x1={3} x2={9} y1={0} y2={0} />
            <line y1={-9} y2={-3} x1={0} x2={0} />
            <line y1={3} y2={9} x1={0} x2={0} />
            <text x={8} y={-7}>
              {s.id}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Eyedropper
// ---------------------------------------------------------------------------

export function EyedropLayer() {
  const eyedrop = useViewer((s) => s.eyedrop);
  useEffect(() => {
    if (!eyedrop) return;
    const key = (e: KeyboardEvent) => e.key === 'Escape' && cancelEyedropper();
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [eyedrop]);
  if (!eyedrop) return null;
  return (
    <div
      className="vx-eyedrop"
      onPointerDown={async (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (e.button !== 0) return cancelEyedropper();
        const b = e.currentTarget.getBoundingClientRect();
        const x = e.clientX - b.left;
        const y = e.clientY - b.top;
        const px = imagePxAt(x, y);
        if (!px) return;
        const s = await samplePixel(px.x, px.y, sideAt(x, y), eyedrop.size);
        if (s) finishEyedropper(s.rgba);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        cancelEyedropper();
      }}
    />
  );
}
