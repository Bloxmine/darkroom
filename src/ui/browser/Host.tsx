/**
 * Browser overlays rendered once at the app root: the confirm / prompt / Batch Rename dialogs, the
 * full-screen Review (Space), and the drop handling that turns thumbnails dragged onto the node
 * graph into Image nodes and onto the viewer into the new source image.
 */
import { useEffect, useRef, useState } from 'react';
import { kindOf } from '../../core/files/kinds';
import { useUi } from '../../store/ui';
import { graphApi } from '../commands';
import { Dialog } from '../Dialogs';
import { Icon } from '../Icon';
import * as A from './actions';
import { BatchRenameDialog } from './BatchRename';
import { DND_FILES, handleItemKey, LabelChip, Stars } from './common';
import { usePreviewSrc, ZoomImage } from './Preview';
import { useBrowser, type BrowserDialog } from './store';

function PromptDialog({ d }: { d: Extract<BrowserDialog, { type: 'prompt' }> }) {
  const [v, setV] = useState(d.value);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const dot = d.value.lastIndexOf('.');
    el.setSelectionRange(0, dot > 0 ? dot : d.value.length); // like Finder: select the name, not the extension
  }, [d.value]);
  return (
    <Dialog
      title={d.title}
      icon="textfield_rename"
      onClose={() => d.resolve(null)}
      buttons={
        <>
          <button className="btn default" disabled={!v.trim()} onClick={() => d.resolve(v.trim())}>
            {d.ok}
          </button>
          <button className="btn" onClick={() => d.resolve(null)}>
            Cancel
          </button>
        </>
      }
    >
      <label className="br-prompt">
        {d.label}
        <input
          ref={ref}
          className="field text"
          value={v}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter' && v.trim()) d.resolve(v.trim());
            if (e.key === 'Escape') d.resolve(null);
          }}
        />
      </label>
    </Dialog>
  );
}

function ConfirmDialog({ d }: { d: Extract<BrowserDialog, { type: 'confirm' }> }) {
  return (
    <Dialog
      title={d.title}
      icon={d.icon ?? 'help'}
      onClose={() => d.resolve(false)}
      buttons={
        <>
          <button className="btn default" onClick={() => d.resolve(true)} autoFocus>
            {d.ok}
          </button>
          <button className="btn" onClick={() => d.resolve(false)}>
            Cancel
          </button>
        </>
      }
    >
      <div className="br-confirm">
        <Icon name={d.icon ?? 'help'} size={32} />
        <p>{d.message}</p>
      </div>
    </Dialog>
  );
}

/** Full-screen Review of one item (Space): ← → step, 0–5 / 6–9 rate and label, scroll / double-click zoom, Esc or Space closes. */
function Review({ path }: { path: string }) {
  const e = useBrowser((s) => s.entries.find((x) => x.path === path));
  const meta = useBrowser((s) => s.meta[path]);
  const src = usePreviewSrc(e);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus(), []);
  if (!e) return null;
  return (
    <div
      className="br-review"
      ref={ref}
      tabIndex={-1}
      onKeyDown={(ev) => {
        ev.stopPropagation();
        if (ev.key === 'Escape' || ev.key === ' ') return ev.preventDefault(), A.closeLoupe();
        if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') return ev.preventDefault(), A.loupeStep(1);
        if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') return ev.preventDefault(), A.loupeStep(-1);
        if (ev.key === 'Enter') return ev.preventDefault(), A.closeLoupe(), void A.openInDarkroom(path);
        if (/^[0-9]$/.test(ev.key) || ev.key === 'Delete' || ev.key === 'Backspace') {
          if (handleItemKey(ev)) ev.preventDefault();
        }
      }}
    >
      <div className="br-review-img">
        {src === undefined ? (
          <span className="br-pv-msg">
            <Icon name="hourglass" /> Loading…
          </span>
        ) : src === null ? (
          <span className="br-pv-msg">No preview for {e.name}</span>
        ) : src.video ? (
          <video src={src.url} controls autoPlay muted playsInline className="br-pv-video" />
        ) : (
          <ZoomImage src={src.url} alt={e.name} />
        )}
      </div>
      <div className="br-review-bar">
        <LabelChip label={meta?.xmp.label} />
        <span className="br-review-name">{e.name}</span>
        <Stars rating={meta?.xmp.rating} onRate={(r) => A.setRating([path], r)} />
        <span className="br-spacer" />
        <span className="muted">← → next · 0–5 rate · 6–9 label · Enter opens in Darkroom · Esc closes</span>
        <button className="tbtn small" title="Open in Darkroom" onClick={() => (A.closeLoupe(), void A.openInDarkroom(path))}>
          <Icon name="picture_go" />
        </button>
        <button className="tbtn small" title="Close (Esc)" onClick={A.closeLoupe}>
          <Icon name="cross" />
        </button>
      </div>
    </div>
  );
}

/** Thumbnails dropped on the node graph → Image nodes; on the viewer → replace the source image. */
function useDropInterceptor() {
  useEffect(() => {
    const over = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes(DND_FILES)) return;
      const t = e.target as Element | null;
      if (t?.closest?.('.flow-wrap, .viewer-panel')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
    };
    const drop = (e: DragEvent) => {
      const raw = e.dataTransfer?.getData(DND_FILES);
      if (!raw) return;
      const t = e.target as Element | null;
      const flow = t?.closest?.('.flow-wrap') as HTMLElement | null;
      const viewer = t?.closest?.('.viewer-panel');
      if (!flow && !viewer) return;
      e.preventDefault();
      e.stopPropagation();
      const paths = JSON.parse(raw) as string[];
      if (flow) {
        // the graph tracks the pointer with mousemove; give it the drop position, then ask for the flow coordinates
        flow.dispatchEvent(new MouseEvent('mousemove', { clientX: e.clientX, clientY: e.clientY, bubbles: true }));
        void A.addToGraph(paths, graphApi.mouseFlowPos() ?? undefined);
      } else {
        const p = paths.find((x) => kindOf(x) !== 'other');
        if (p) void A.openInDarkroom(p);
      }
    };
    window.addEventListener('dragover', over, true);
    window.addEventListener('drop', drop, true);
    return () => {
      window.removeEventListener('dragover', over, true);
      window.removeEventListener('drop', drop, true);
    };
  }, []);
}

export function BrowserHost() {
  const dialog = useBrowser((s) => s.dialog);
  const loupe = useBrowser((s) => s.loupe);
  useDropInterceptor();
  // the editor's global shortcuts ignore keys while one of its dialogs is open; do the same for ours
  useEffect(() => {
    if (!dialog && !loupe) return;
    const block = (e: KeyboardEvent) => {
      if (useUi.getState().dialog) return;
      const t = e.target as HTMLElement;
      if (t.closest?.('.br-review, .dialog')) return; // handled by them
      if (e.key !== 'Escape') e.stopImmediatePropagation();
    };
    window.addEventListener('keydown', block, true);
    return () => window.removeEventListener('keydown', block, true);
  }, [dialog, loupe]);
  return (
    <>
      {loupe && <Review path={loupe} />}
      {dialog && (
        // keys typed in our dialogs must not reach the editor's global shortcuts (Delete would delete nodes)
        <div className="br-dialog-host" onKeyDown={(e) => e.key !== 'Escape' && e.stopPropagation()}>
          {dialog.type === 'confirm' && <ConfirmDialog d={dialog} />}
          {dialog.type === 'prompt' && <PromptDialog d={dialog} />}
          {dialog.type === 'batchRename' && <BatchRenameDialog paths={dialog.paths} />}
        </div>
      )}
    </>
  );
}
