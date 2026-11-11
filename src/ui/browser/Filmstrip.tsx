/** Filmstrip: a horizontal strip of the Content items, synced with the selection (panel, and the Content panel's filmstrip view). */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { FsEntry } from '../../core/files/types';
import { Panel } from '../Chrome';
import { useContextMenu } from '../Menu';
import * as A from './actions';
import { focusProps, handleItemKey, itemMenu, labelCss, Stars, startItemDrag, ThumbImg } from './common';
import { useBrowser, useVisibleItems } from './store';

export function Filmstrip({ height, onMenu }: { height: number; onMenu: (ev: React.MouseEvent, path: string) => void }) {
  const items = useVisibleItems();
  const ref = useRef<HTMLDivElement>(null);
  const [vp, setVp] = useState({ w: 0, left: 0 });
  const sel = useBrowser((s) => s.selection);
  const focus = useBrowser((s) => s.focus);
  const meta = useBrowser((s) => s.meta);
  const selSet = useMemo(() => new Set(sel), [sel]);
  const cell = Math.max(48, height - 26);
  const cw = cell + 10;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const upd = () => setVp({ w: el.clientWidth, left: el.scrollLeft });
    upd();
    const ro = new ResizeObserver(upd);
    ro.observe(el);
    el.addEventListener('scroll', upd, { passive: true });
    return () => (ro.disconnect(), el.removeEventListener('scroll', upd));
  }, []);
  useEffect(() => {
    const el = ref.current;
    const i = focus ? items.findIndex((e) => e.path === focus) : -1;
    if (!el || i < 0) return;
    const x = i * cw;
    if (x < el.scrollLeft) el.scrollLeft = x - 4;
    else if (x + cw > el.scrollLeft + el.clientWidth) el.scrollLeft = x + cw - el.clientWidth + 4;
  }, [focus, items, cw]);
  const first = Math.max(0, Math.floor(vp.left / cw) - 3);
  const last = Math.min(items.length, Math.ceil((vp.left + vp.w) / cw) + 3);
  const cells: React.ReactNode[] = [];
  for (let i = first; i < last; i++) {
    const e: FsEntry = items[i];
    const m = meta[e.path];
    const lc = labelCss(m?.xmp.label);
    cells.push(
      <div
        key={e.path}
        className={'br-fcell' + (selSet.has(e.path) ? ' selected' : '') + (focus === e.path ? ' focused' : '')}
        style={{ left: 4 + i * cw, width: cell + 6, height: height - 8 }}
        data-path={e.path}
        title={e.name}
        onMouseDown={(ev) => {
          if (ev.button === 2 && selSet.has(e.path)) return;
          A.select(e.path, ev.shiftKey ? 'range' : ev.metaKey || ev.ctrlKey ? 'toggle' : 'single');
        }}
        onDoubleClick={() => void A.openInDarkroom(e.path)}
        onContextMenu={(ev) => onMenu(ev, e.path)}
        draggable
        onDragStart={(ev) => startItemDrag(ev, e.path)}
      >
        <div className="br-fcell-img" style={{ width: cell, height: cell - 4 }}>
          <ThumbImg e={e} px={cell} />
        </div>
        <div className="br-fcell-foot" style={lc ? { borderBottomColor: lc } : undefined}>
          {!e.dir && <Stars rating={m?.xmp.rating} small />}
        </div>
      </div>,
    );
  }
  return (
    <div className="br-strip" ref={ref} style={{ height }}>
      <div className="br-strip-inner" style={{ width: items.length * cw + 8, height: height - 2 }}>
        {cells}
      </div>
    </div>
  );
}

export function FilmstripPanel({ panelId }: { panelId: string }) {
  useEffect(() => void A.initBrowser(), []);
  const menu = useContextMenu();
  const box = useRef<HTMLDivElement>(null);
  const [h, setH] = useState(120);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setH(Math.max(70, Math.min(260, el.clientHeight))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <Panel title="Filmstrip" icon="film" className="br-panel">
      <div
        className="br-filmstrip-panel"
        ref={box}
        {...focusProps(panelId)}
        onKeyDown={(e) => {
          if (handleItemKey(e, { horizontal: true })) {
            e.preventDefault();
            e.stopPropagation();
          }
        }}
      >
        <Filmstrip
          height={h}
          onMenu={(ev, p) => {
            ev.preventDefault();
            ev.stopPropagation();
            const sel = useBrowser.getState().selection;
            menu.open(ev, itemMenu(sel.includes(p) ? sel : [p]));
          }}
        />
      </div>
      {menu.el}
    </Panel>
  );
}
