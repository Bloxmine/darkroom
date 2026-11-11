/** Preview panel: a large preview of the selection (zoom / pan), 2–4 selected side by side for comparing. */
import { useEffect, useRef, useState } from 'react';
import { kindOf, WEB_DECODABLE, extOfName } from '../../core/files/kinds';
import { projectPreview, requestThumb } from '../../core/files/thumbs';
import type { FsEntry } from '../../core/files/types';
import { Panel } from '../Chrome';
import { Icon } from '../Icon';
import { useContextMenu } from '../Menu';
import * as A from './actions';
import { focusProps, handleItemKey, itemMenu, KIND_ICON, LabelChip, Stars } from './common';
import { useBrowser } from './store';

interface Src {
  url: string;
  video?: boolean;
  revoke?: boolean;
}

/** Large-preview source for an entry: the file itself for browser-decodable images / video, else a 1600 px thumbnail (QuickLook / embedded preview). */
export function usePreviewSrc(e: FsEntry | undefined): Src | null | undefined {
  const [src, setSrc] = useState<Src | null | undefined>(undefined);
  useEffect(() => {
    if (!e || e.dir) return setSrc(null);
    let dead = false;
    let made: Src | null = null;
    setSrc(undefined);
    const ac = new AbortController();
    void (async () => {
      const fs = A.backend();
      const k = kindOf(e.name);
      try {
        if ((k === 'image' && WEB_DECODABLE.includes(extOfName(e.name))) || k === 'video') {
          const f = await fs.file(e.path);
          made = { url: URL.createObjectURL(f), video: k === 'video', revoke: true };
        } else if (k === 'project') {
          const u = await projectPreview(fs, e.path);
          made = u ? { url: u } : null;
        } else {
          const t = await requestThumb(fs, e, 1600, ac.signal);
          made = t ? { url: t.url } : null;
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') console.warn('[darkroom files] preview failed', e.name, (err as Error).message);
        made = null;
      }
      if (dead) {
        if (made?.revoke) URL.revokeObjectURL(made.url);
        return;
      }
      setSrc(made);
    })();
    return () => {
      dead = true;
      ac.abort();
      if (made?.revoke) URL.revokeObjectURL(made.url);
    };
  }, [e]);
  return src;
}

/** An image that fits its box, with wheel zoom around the cursor, double-click 100 %, and drag to pan. */
export function ZoomImage({ src, alt }: { src: string; alt: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [nat, setNat] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<{ z: number; x: number; y: number } | null>(null); // null = fit
  const [boxSize, setBox] = useState({ w: 1, h: 1 });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => setView(null), [src]);
  const fit = nat.w ? Math.min(1, boxSize.w / nat.w, boxSize.h / nat.h) : 1;
  const z = view?.z ?? fit;
  const x = view?.x ?? 0;
  const y = view?.y ?? 0;
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const zoomAt = (nz: number, cx: number, cy: number) => {
    const r = box.current!.getBoundingClientRect();
    const px = cx - r.left - r.width / 2 - x;
    const py = cy - r.top - r.height / 2 - y;
    const k = nz / z;
    setView(nz <= fit + 1e-6 ? null : { z: nz, x: x - px * (k - 1), y: y - py * (k - 1) });
  };
  return (
    <div
      className={'br-zoom' + (view ? ' zoomed' : '')}
      ref={box}
      onWheel={(e) => {
        if (!nat.w) return;
        e.stopPropagation();
        zoomAt(Math.max(fit, Math.min(8, z * Math.exp(-e.deltaY * 0.0025))), e.clientX, e.clientY);
      }}
      onDoubleClick={(e) => (view ? setView(null) : zoomAt(1, e.clientX, e.clientY))}
      onPointerDown={(e) => {
        if (!view || e.button !== 0) return;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, y: e.clientY, ox: x, oy: y };
      }}
      onPointerMove={(e) => drag.current && view && setView({ ...view, x: drag.current.ox + e.clientX - drag.current.x, y: drag.current.oy + e.clientY - drag.current.y })}
      onPointerUp={() => (drag.current = null)}
      title={view ? `${Math.round(z * 100)}% — double-click to fit, drag to pan` : 'Double-click or scroll to zoom'}
    >
      <img
        src={src}
        alt={alt}
        draggable={false}
        onLoad={(e) => setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
        style={nat.w ? { width: nat.w * z, height: nat.h * z, transform: `translate(${x}px, ${y}px)` } : { opacity: 0 }}
      />
      {view && <span className="br-zoom-pct">{Math.round(z * 100)}%</span>}
    </div>
  );
}

function PreviewItem({ e, compact }: { e: FsEntry; compact: boolean }) {
  const src = usePreviewSrc(e);
  const meta = useBrowser((s) => s.meta[e.path]);
  return (
    <div className="br-pv-item">
      <div className="br-pv-img">
        {src === undefined ? (
          <span className="br-pv-msg">
            <Icon name="hourglass" /> Loading…
          </span>
        ) : src === null ? (
          <span className="br-pv-msg">
            <Icon name={KIND_ICON[kindOf(e.name)] ?? 'page_white'} size={32} />
            <br />
            No preview
          </span>
        ) : src.video ? (
          <video src={src.url} controls muted playsInline className="br-pv-video" />
        ) : (
          <ZoomImage src={src.url} alt={e.name} />
        )}
      </div>
      <div className="br-pv-caption">
        <LabelChip label={meta?.xmp.label} />
        <span className="br-pv-name">{e.name}</span>
        {!compact && <Stars rating={meta?.xmp.rating} onRate={(r) => A.setRating([e.path], r)} />}
      </div>
    </div>
  );
}

export function PreviewBody({ panelId }: { panelId: string }) {
  void panelId;
  const sel = useBrowser((s) => s.selection);
  const entries = useBrowser((s) => s.entries);
  const items = sel.map((p) => entries.find((e) => e.path === p)).filter((e): e is FsEntry => !!e && !e.dir);
  if (!items.length)
    return (
      <div className="br-pv-empty muted">
        <Icon name="picture_empty" size={32} />
        <br />
        Select a photo to preview it. Select 2–4 to compare them side by side.
      </div>
    );
  const shown = items.length === 1 ? items : items.slice(0, 4);
  return (
    <div className={'br-pv-grid n' + shown.length}>
      {shown.map((e) => (
        <PreviewItem key={e.path} e={e} compact={shown.length > 2} />
      ))}
      {items.length > 4 && <div className="br-pv-more">+{items.length - 4} more selected</div>}
    </div>
  );
}

export function PreviewPanel({ panelId }: { panelId: string }) {
  useEffect(() => void A.initBrowser(), []);
  const menu = useContextMenu();
  return (
    <Panel title="Preview" icon="picture" className="br-panel">
      <div
        className="br-preview"
        {...focusProps(panelId)}
        onKeyDown={(e) => {
          if (handleItemKey(e, { horizontal: true })) {
            e.preventDefault();
            e.stopPropagation();
          }
        }}
        onContextMenu={(ev) => {
          ev.preventDefault();
          const sel = useBrowser.getState().selection;
          if (sel.length) menu.open(ev, itemMenu(sel));
        }}
      >
        <PreviewBody panelId={panelId} />
      </div>
      {menu.el}
    </Panel>
  );
}
