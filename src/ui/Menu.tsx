import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { commands, displayKeys } from './commands';
import { Icon } from './Icon';

export type MenuItem =
  | { cmd: string; label?: string }
  | { sep: true }
  | { label: string; icon?: string; run?: () => void; submenu?: () => MenuItem[]; disabled?: boolean; checked?: boolean; keys?: string; title?: string }
  | { header: string };

function resolve(it: MenuItem) {
  if ('cmd' in it) {
    const c = commands[it.cmd];
    if (!c) return null;
    return {
      label: it.label ?? c.label,
      icon: c.icon,
      run: c.run,
      disabled: c.enabled ? !c.enabled() : false,
      checked: c.checked?.(),
      keys: c.keys,
      submenu: undefined as undefined | (() => MenuItem[]),
      title: undefined as string | undefined,
    };
  }
  if ('sep' in it || 'header' in it) return null;
  return { ...it, keys: it.keys, title: it.title };
}

/** A dropdown / context menu list (Office-2003-style icon gutter). */
export function MenuList({ items, onClose, style, level = 0 }: { items: MenuItem[]; onClose: () => void; style?: React.CSSProperties; level?: number }) {
  const [open, setOpen] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<React.CSSProperties | undefined>(style);
  const timer = useRef(0);

  // keep on screen
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !style) return;
    const r = el.getBoundingClientRect();
    const s: React.CSSProperties = { ...style };
    if (r.right > window.innerWidth - 2) s.left = Math.max(2, window.innerWidth - r.width - 2);
    if (r.bottom > window.innerHeight - 2) s.top = Math.max(2, window.innerHeight - r.height - 2);
    if (s.left !== style.left || s.top !== style.top) setPos(s);
  }, [style]);

  return (
    <div className="menu" ref={ref} style={pos ?? style} onMouseDown={(e) => e.stopPropagation()} role="menu">
      {items.map((it, i) => {
        if ('sep' in it) return <div key={i} className="menu-sep" />;
        if ('header' in it)
          return (
            <div key={i} className="menu-header">
              {it.header}
            </div>
          );
        const r = resolve(it);
        if (!r) return null;
        const sub = r.submenu;
        return (
          <div
            key={i}
            className={'menu-item' + (r.disabled ? ' disabled' : '') + (open === i ? ' open' : '')}
            title={r.title}
            role="menuitem"
            onMouseEnter={() => {
              clearTimeout(timer.current);
              timer.current = window.setTimeout(() => setOpen(sub ? i : null), sub ? 120 : 200);
            }}
            onClick={(e) => {
              e.stopPropagation();
              if (r.disabled) return;
              if (sub) {
                setOpen(i);
                return;
              }
              onClose();
              r.run?.();
            }}
          >
            <span className="menu-gutter">
              {r.checked ? <span className="menu-check">{r.icon ? <Icon name={r.icon} /> : '✓'}</span> : r.icon ? <Icon name={r.icon} /> : null}
            </span>
            <span className="menu-label">{r.label}</span>
            <span className="menu-keys">{displayKeys(r.keys)}</span>
            <span className="menu-arrow">{sub ? '▸' : ''}</span>
            {sub && open === i && <SubMenu items={sub()} onClose={onClose} level={level + 1} />}
          </div>
        );
      })}
    </div>
  );
}

function SubMenu({ items, onClose, level }: { items: MenuItem[]; onClose: () => void; level: number }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>();
  useLayoutEffect(() => {
    const host = anchor.current?.parentElement;
    if (!host) return;
    const r = host.getBoundingClientRect();
    setStyle({ position: 'fixed', left: r.right - 3, top: r.top - 3, zIndex: 1000 + level });
  }, [level]);
  return (
    <span ref={anchor}>
      {style &&
        createPortal(
          <MenuList items={items.length ? items : [{ label: '(empty)', disabled: true }]} onClose={onClose} style={style} level={level} />,
          document.body,
        )}
    </span>
  );
}

/** A context menu at a client position; closes on outside click / Escape. */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  useOutsideClose(onClose);
  return createPortal(<MenuList items={items} onClose={onClose} style={{ position: 'fixed', left: x, top: y, zIndex: 1000 }} />, document.body);
}

export function useOutsideClose(onClose: () => void) {
  useEffect(() => {
    const down = () => onClose();
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    const t = setTimeout(() => {
      window.addEventListener('mousedown', down);
      window.addEventListener('contextmenu', down);
    }, 0);
    window.addEventListener('keydown', key);
    window.addEventListener('blur', down);
    return () => {
      clearTimeout(t);
      window.removeEventListener('mousedown', down);
      window.removeEventListener('contextmenu', down);
      window.removeEventListener('keydown', key);
      window.removeEventListener('blur', down);
    };
  }, [onClose]);
}

/** Context-menu state helper. */
export function useContextMenu() {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const el: ReactNode = menu ? <ContextMenu {...menu} onClose={() => setMenu(null)} /> : null;
  return { open: (e: { clientX: number; clientY: number }, items: MenuItem[]) => setMenu({ x: e.clientX, y: e.clientY, items }), el };
}
