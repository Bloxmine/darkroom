/**
 * The docking workspace: renders the current workspace's layout tree (layout.ts) as splits and
 * tab stacks, re-parents each panel's persistent element (mounts.ts) into its stack, and handles
 * tab drag & drop (dock left / right / top / bottom of a stack, into its tabs, or along a window
 * edge), splitters, maximise (double-click a tab), minimise and close.
 */
import { Component, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { Splitter } from '../Chrome';
import { Icon } from '../Icon';
import { ContextMenu, type MenuItem } from '../Menu';
import * as L from './layout';
import { DockCtx, panelElement, usePlacement } from './mounts';
import { getPanel, listPanels, panelTitle, usePanels } from './panels';
import { closePanel, currentLayout, resetWorkspace, stackMin, toggleMaximize, updateLayout, useWorkspaceStore } from './store';
import './workspace.css';

// ---------------------------------------------------------------------------
// drag & drop state
// ---------------------------------------------------------------------------

type Target = { kind: 'stack'; stackId: string; zone: L.Zone; index?: number; rect: DOMRect } | { kind: 'edge'; zone: Exclude<L.Zone, 'center'>; rect: DOMRect };

interface DragState {
  panel: string | null;
  x: number;
  y: number;
  target: Target | null;
}
export const useDockDrag = create<DragState>(() => ({ panel: null, x: 0, y: 0, target: null }));

const EDGE_PX = 26;

function rectOf(l: number, t: number, w: number, h: number) {
  return new DOMRect(l, t, w, h);
}

function computeTarget(x: number, y: number, panel: string): Target | null {
  const rootEl = document.querySelector<HTMLElement>('.dock-root');
  if (!rootEl) return null;
  const R = rootEl.getBoundingClientRect();
  if (x < R.left || x > R.right || y < R.top || y > R.bottom) return null;
  const root = currentLayout().root;
  const maximized = useWorkspaceStore.getState().maximized;
  // window edges
  if (!maximized) {
    const edge: Exclude<L.Zone, 'center'> | null = x - R.left < EDGE_PX ? 'left' : R.right - x < EDGE_PX ? 'right' : y - R.top < EDGE_PX ? 'top' : R.bottom - y < EDGE_PX ? 'bottom' : null;
    if (edge && L.panelIds(root).length > 1) {
      const fw = R.width * 0.22;
      const fh = R.height * 0.25;
      const rect = edge === 'left' ? rectOf(R.left, R.top, fw, R.height) : edge === 'right' ? rectOf(R.right - fw, R.top, fw, R.height) : edge === 'top' ? rectOf(R.left, R.top, R.width, fh) : rectOf(R.left, R.bottom - fh, R.width, fh);
      return { kind: 'edge', zone: edge, rect };
    }
  }
  for (const el of rootEl.querySelectorAll<HTMLElement>('[data-stack-id]')) {
    const r = el.getBoundingClientRect();
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
    const stackId = el.dataset.stackId!;
    const st = L.findNode(root, stackId);
    if (!st || st.type !== 'stack') return null;
    const lone = st.tabs.length === 1 && st.tabs[0] === panel;
    const bar = el.querySelector<HTMLElement>('.dock-tabbar');
    const br = bar?.getBoundingClientRect();
    if (br && y <= br.bottom) {
      // over the tab bar: into the tabs, at the pointer's position
      if (lone) return null;
      const tabs = [...el.querySelectorAll<HTMLElement>('.dock-tab')];
      let index = tabs.length;
      tabs.forEach((t, i) => {
        const tr = t.getBoundingClientRect();
        if (index === tabs.length && x < tr.left + tr.width / 2) index = i;
      });
      return { kind: 'stack', stackId, zone: 'center', index, rect: r };
    }
    if (lone || st.minimized) return null;
    const rx = (x - r.left) / r.width;
    const ry = (y - r.top) / r.height;
    const d = { left: rx, right: 1 - rx, top: ry, bottom: 1 - ry };
    const [zone, m] = (Object.entries(d) as [Exclude<L.Zone, 'center'>, number][]).sort((a, b) => a[1] - b[1])[0];
    if (m > 0.28) return { kind: 'stack', stackId, zone: 'center', rect: r };
    const rect =
      zone === 'left' ? rectOf(r.left, r.top, r.width / 2, r.height) : zone === 'right' ? rectOf(r.left + r.width / 2, r.top, r.width / 2, r.height) : zone === 'top' ? rectOf(r.left, r.top, r.width, r.height / 2) : rectOf(r.left, r.top + r.height / 2, r.width, r.height / 2);
    return { kind: 'stack', stackId, zone, rect };
  }
  return null;
}

function applyDrop(panel: string, t: Target) {
  useWorkspaceStore.setState({ maximized: null });
  updateLayout((root) => {
    if (t.kind === 'edge') return L.dockEdge(root, panel, t.zone);
    let r = L.dockPanel(root, panel, t.stackId, t.zone);
    if (t.zone === 'center' && t.index !== undefined) {
      const st = L.findNode(root, t.stackId);
      // index counted the dragged tab itself when reordering within one stack
      const own = st?.type === 'stack' ? st.tabs.indexOf(panel) : -1;
      r = L.moveTab(r, t.stackId, panel, own >= 0 && own < t.index ? t.index - 1 : t.index);
    }
    return r;
  });
}

/** Pointer-down on a tab: becomes a drag after a few px of movement. */
function startTabDrag(e: React.PointerEvent, panel: string) {
  if (e.button !== 0) return;
  const sx = e.clientX;
  const sy = e.clientY;
  let dragging = false;
  const move = (ev: PointerEvent) => {
    if (!dragging && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
    if (!dragging) {
      dragging = true;
      document.body.classList.add('dock-dragging');
    }
    useDockDrag.setState({ panel, x: ev.clientX, y: ev.clientY, target: computeTarget(ev.clientX, ev.clientY, panel) });
  };
  const end = (ev: PointerEvent | KeyboardEvent) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('keydown', esc, true);
    document.body.classList.remove('dock-dragging');
    const t = useDockDrag.getState().target;
    useDockDrag.setState({ panel: null, target: null });
    if (dragging && ev.type === 'pointerup' && t) applyDrop(panel, t);
  };
  const esc = (ev: KeyboardEvent) => {
    if (ev.key !== 'Escape') return;
    ev.preventDefault();
    ev.stopPropagation();
    useDockDrag.setState({ target: null });
    end(ev);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end);
  window.addEventListener('keydown', esc, true);
}

function DragOverlay() {
  const d = useDockDrag();
  if (!d.panel) return null;
  const t = d.target;
  return createPortal(
    <>
      {t && (
        <div
          className={'dock-drop' + (t.kind === 'edge' ? ' edge' : '') + (t.kind === 'stack' && t.zone === 'center' ? ' center' : '')}
          style={{ left: t.rect.left, top: t.rect.top, width: t.rect.width, height: t.rect.height }}
        />
      )}
      <div className="dock-ghost" style={{ left: d.x + 12, top: d.y + 10 }}>
        <Icon name={getPanel(d.panel)?.icon ?? 'application'} /> {panelTitle(d.panel)}
      </div>
    </>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// panel menu
// ---------------------------------------------------------------------------

function stackMenu(st: L.StackNode, panelId: string): MenuItem[] {
  const ws = useWorkspaceStore.getState();
  const max = ws.maximized === st.id;
  const open = new Set(L.panelIds(currentLayout().root));
  const panels = [...new Map([...openOrRegistered()].map((p) => [p.id, p])).values()];
  const editor = panels.filter((p) => p.group !== 'browser');
  const browser = panels.filter((p) => p.group === 'browser');
  const addItems = (list: typeof panels): MenuItem[] =>
    list.map((p) => ({
      label: p.title,
      icon: p.icon,
      checked: st.tabs.includes(p.id),
      title: open.has(p.id) && !st.tabs.includes(p.id) ? 'Move it into this tab group' : undefined,
      run: () => updateLayout((root) => L.dockPanel(root, p.id, st.id, 'center')),
    }));
  return [
    { label: max ? 'Restore Panel' : 'Maximize Panel', icon: max ? 'arrow_in' : 'arrow_out', run: () => toggleMaximize(st.id) },
    { label: st.minimized ? 'Expand Panel Group' : 'Minimize Panel Group', icon: 'application_side_contract', run: () => updateLayout((root) => L.setMinimized(root, st.id, !st.minimized)), disabled: max },
    { sep: true },
    { label: `Close ${panelTitle(panelId)}`, icon: 'tab_delete', run: () => closePanel(panelId) },
    { label: 'Close Tab Group', icon: 'cross', run: () => updateLayout((root) => L.mapNode(root, st.id, () => null)) },
    { sep: true },
    { label: 'Add Panel Here', icon: 'tab_add', submenu: () => [...addItems(editor), ...(browser.length ? [{ sep: true } as MenuItem, ...addItems(browser)] : [])] },
    { sep: true },
    { label: 'Reset Workspace', icon: 'arrow_refresh', run: () => resetWorkspace() },
  ];
}

/** Registered panels plus unregistered ones referenced by the layout (shown as placeholders). */
function openOrRegistered() {
  const reg = listPanels();
  const ids = L.panelIds(currentLayout().root).filter((id) => !reg.some((p) => p.id === id));
  return [...reg, ...ids.map((id) => ({ id, title: panelTitle(id), icon: 'application', group: id.startsWith('browser.') ? ('browser' as const) : ('editor' as const) }))];
}

// ---------------------------------------------------------------------------
// stacks & splits
// ---------------------------------------------------------------------------

function Stack({ node, slim }: { node: L.StackNode; slim?: 'h' | 'v' }) {
  usePanels(); // titles / icons of panels registered later
  const body = useRef<HTMLDivElement>(null);
  const [tools, setTools] = useState<HTMLSpanElement | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const maximized = useWorkspaceStore((s) => s.maximized === node.id);
  const minimized = !!node.minimized && !maximized;

  // adopt the panels' persistent elements; only the active one is displayed
  useLayoutEffect(() => {
    const b = body.current!;
    for (const id of node.tabs) {
      const el = panelElement(id);
      if (el.parentElement !== b) b.appendChild(el);
      el.style.display = id === node.active ? '' : 'none';
    }
    usePlacement.setState(Object.fromEntries(node.tabs.map((id) => [id, { tools: id === node.active && !minimized ? tools : null, active: id === node.active && !minimized }])));
  }, [node.tabs, node.active, tools, minimized]);

  const openMenu = (e: React.MouseEvent, panelId = node.active) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items: stackMenu(node, panelId) });
  };
  const restore = () => updateLayout((root) => L.setMinimized(root, node.id, false));

  return (
    <div className={'dock-stack' + (minimized ? ' minimized slim-' + (slim ?? 'h') : '') + (maximized ? ' maximized' : '')} data-stack-id={node.id}>
      <div className="dock-tabbar panel-title" onDoubleClick={(e) => e.target === e.currentTarget && toggleMaximize(node.id)} onContextMenu={(e) => openMenu(e)}>
        <div className="dock-tabs" role="tablist">
          {node.tabs.map((id) => {
            const def = getPanel(id);
            const active = id === node.active;
            return (
              <div
                key={id}
                role="tab"
                aria-selected={active}
                className={'dock-tab' + (active ? ' active' : '') + (def ? '' : ' missing')}
                data-tab={id}
                title={minimized ? `${panelTitle(id)} (click to expand)` : `${panelTitle(id)} — drag to dock, double-click to maximize`}
                onPointerDown={(e) => {
                  if ((e.target as HTMLElement).closest('.dock-tab-close')) return;
                  startTabDrag(e, id);
                }}
                onClick={() => {
                  if (minimized) restore();
                  if (!active) updateLayout((root) => L.setActive(root, node.id, id), false);
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  toggleMaximize(node.id);
                }}
                onAuxClick={(e) => e.button === 1 && closePanel(id)}
                onContextMenu={(e) => openMenu(e, id)}
              >
                <Icon name={def?.icon ?? 'application'} />
                <span className="dock-tab-label">{panelTitle(id)}</span>
                {!minimized && (
                  <span
                    className="dock-tab-close"
                    title={`Close ${panelTitle(id)}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      closePanel(id);
                    }}
                  >
                    ×
                  </span>
                )}
              </div>
            );
          })}
        </div>
        <span className="dock-tools" ref={setTools} />
        {!minimized && maximized && (
          <button className="dock-btn" title="Restore (double-click the tab)" onClick={() => toggleMaximize(node.id)}>
            <Icon name="arrow_in" />
          </button>
        )}
        <button className="dock-btn dock-menu-btn" title="Panel menu" onClick={(e) => openMenu(e)} onPointerDown={(e) => e.stopPropagation()}>
          <span className="dock-menu-glyph">▾≡</span>
        </button>
      </div>
      <div className="dock-body" ref={body} style={minimized ? { display: 'none' } : undefined} />
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}

const SLIM = 24;

function Split({ node }: { node: L.SplitNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const start = useRef<{ sizes: number[]; len: number }>({ sizes: [], len: 1 });
  const isMin = (c: L.LayoutNode) => c.type === 'stack' && !!c.minimized;
  const allMin = node.children.every(isMin);
  const out: ReactNode[] = [];
  node.children.forEach((c, i) => {
    if (i > 0) {
      const a = node.children[i - 1];
      const fixed = !allMin && (isMin(a) || isMin(c));
      out.push(
        fixed ? (
          <div key={'g' + i} className={'dock-gap ' + (node.dir === 'row' ? 'v' : 'h')} />
        ) : (
          <Splitter
            key={'s' + i}
            dir={node.dir === 'row' ? 'v' : 'h'}
            onStart={() => {
              const el = ref.current!;
              start.current = { sizes: [...node.sizes], len: Math.max(1, node.dir === 'row' ? el.clientWidth : el.clientHeight) };
            }}
            onDrag={(d) => {
              const { sizes, len } = start.current;
              const minOf = (n: L.LayoutNode) => Math.min(0.45, (n.type === 'stack' ? stackMin(n, node.dir) : 60) / len);
              const df = Math.max(minOf(a) - sizes[i - 1], Math.min(sizes[i] - minOf(c), d / len));
              const next = [...sizes];
              next[i - 1] += df;
              next[i] -= df;
              updateLayout((root) => L.setSizes(root, node.id, next), false);
            }}
          />
        ),
      );
    }
    const min = !allMin && isMin(c);
    out.push(
      <div key={c.id} className="dock-cell" style={min ? { flex: `0 0 ${SLIM}px` } : { flex: `${node.sizes[i] * 100} 1 0px` }}>
        <NodeView node={c} slim={node.dir === 'row' ? 'v' : 'h'} />
      </div>,
    );
  });
  return (
    <div ref={ref} className={'dock-split ' + node.dir}>
      {out}
    </div>
  );
}

function NodeView({ node, slim }: { node: L.LayoutNode; slim?: 'h' | 'v' }) {
  return node.type === 'stack' ? <Stack node={node} slim={slim} /> : <Split node={node} />;
}

// ---------------------------------------------------------------------------
// panel host: every panel of the layout, rendered once into its persistent element
// ---------------------------------------------------------------------------

class PanelBoundary extends Component<{ id: string; children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: unknown) {
    return { error: String((e as Error)?.message ?? e) };
  }
  render() {
    if (this.state.error)
      return (
        <div className="dock-placeholder">
          <Icon name="error" size={32} />
          <b>{panelTitle(this.props.id)} failed</b>
          <span className="muted">{this.state.error}</span>
          <button className="btn" onClick={() => this.setState({ error: null })}>
            Retry
          </button>
        </div>
      );
    return this.props.children;
  }
}

function Placeholder({ panelId }: { panelId: string }) {
  return (
    <div className="dock-placeholder">
      <Icon name="application_error" size={32} />
      <b>Panel not available</b>
      <span className="muted">
        “{panelTitle(panelId)}” (<code>{panelId}</code>) isn’t part of this build.
      </span>
    </div>
  );
}

function PanelHost() {
  const ids = useWorkspaceStore((s) => L.panelIds(currentLayout(s).root).join('\n'));
  const panels = usePanels();
  const placement = usePlacement();
  const list = useMemo(() => (ids ? ids.split('\n') : []), [ids]);
  // panels that left the layout: detach their elements
  useEffect(() => {
    const keep = new Set(list);
    document.querySelectorAll<HTMLElement>('.dock-panel').forEach((el) => {
      if (!keep.has(el.dataset.panel ?? '')) el.remove();
    });
  }, [list]);
  return (
    <>
      {list.map((id) => {
        const def = panels.find((p) => p.id === id);
        const Comp = def?.component ?? Placeholder;
        const pl = placement[id] ?? { tools: null, active: false };
        return createPortal(
          <DockCtx.Provider value={{ panelId: id, title: def?.title ?? panelTitle(id), tools: pl.tools, active: pl.active }}>
            <PanelBoundary id={id}>
              <Comp panelId={id} />
            </PanelBoundary>
          </DockCtx.Provider>,
          panelElement(id),
          id,
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------------------

export function DockRoot() {
  const root = useWorkspaceStore((s) => currentLayout(s).root);
  const maximized = useWorkspaceStore((s) => s.maximized);
  const shown = maximized ? (L.findNode(root, maximized) ?? root) : root;
  return (
    <div className="workspace dock-root">
      {shown ? (
        <NodeView node={shown} />
      ) : (
        <div className="dock-empty">
          <Icon name="layouts" size={32} />
          <span>This workspace has no panels.</span>
          <button className="btn" onClick={() => resetWorkspace()}>
            Reset Workspace
          </button>
        </div>
      )}
      <PanelHost />
      <DragOverlay />
    </div>
  );
}
