/**
 * Docking layout tree (pure, no DOM / React): rows and columns of sized children whose leaves are
 * tab stacks of panel ids. Every operation returns a new tree (inputs are never mutated) and the
 * result is always normalised: no empty stacks, no single-child splits, no split directly inside
 * a split of the same direction, sizes are positive fractions summing to 1.
 *
 * Used by the workspace store (src/ui/workspace/store.ts) and rendered by Dock.tsx.
 */

export type Dir = 'row' | 'col';
export type Zone = 'left' | 'right' | 'top' | 'bottom' | 'center';

export interface StackNode {
  type: 'stack';
  id: string;
  /** Panel ids, in tab order. */
  tabs: string[];
  /** The visible tab. */
  active: string;
  /** Collapsed to a slim bar (just its tabs). */
  minimized?: boolean;
}

export interface SplitNode {
  type: 'split';
  id: string;
  /** 'row': children side by side (left → right); 'col': stacked (top → bottom). */
  dir: Dir;
  children: LayoutNode[];
  /** Fractions of the split's length, one per child, summing to 1. */
  sizes: number[];
}

export type LayoutNode = StackNode | SplitNode;

export interface Layout {
  root: LayoutNode | null;
}

let seq = 0;
/** A short unique id for stacks and splits. */
export const newId = (prefix: string) => `${prefix}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// ---------------------------------------------------------------------------
// builders (for workspace definitions and tests)
// ---------------------------------------------------------------------------

export function stack(tabs: string[], opts: { active?: string; minimized?: boolean; id?: string } = {}): StackNode {
  return { type: 'stack', id: opts.id ?? newId('s'), tabs: [...tabs], active: opts.active ?? tabs[0], ...(opts.minimized ? { minimized: true } : {}) };
}

function split(dir: Dir, children: LayoutNode[], sizes?: number[], id?: string): SplitNode {
  return { type: 'split', id: id ?? newId(dir === 'row' ? 'r' : 'c'), dir, children, sizes: sizes ?? children.map(() => 1 / children.length) };
}
export const row = (children: LayoutNode[], sizes?: number[], id?: string) => split('row', children, sizes, id);
export const col = (children: LayoutNode[], sizes?: number[], id?: string) => split('col', children, sizes, id);

// ---------------------------------------------------------------------------
// queries
// ---------------------------------------------------------------------------

/** Every panel id in the tree (tab order, depth first). */
export function panelIds(n: LayoutNode | null): string[] {
  if (!n) return [];
  return n.type === 'stack' ? [...n.tabs] : n.children.flatMap(panelIds);
}

/** Panels that are on screen: the active tab of every stack that isn't minimized. */
export function visiblePanelIds(n: LayoutNode | null): string[] {
  if (!n) return [];
  if (n.type === 'stack') return n.minimized ? [] : [n.active];
  return n.children.flatMap(visiblePanelIds);
}

export function stacks(n: LayoutNode | null): StackNode[] {
  if (!n) return [];
  return n.type === 'stack' ? [n] : n.children.flatMap(stacks);
}

export function findNode(n: LayoutNode | null, id: string): LayoutNode | null {
  if (!n) return null;
  if (n.id === id) return n;
  if (n.type === 'split') for (const c of n.children) {
    const f = findNode(c, id);
    if (f) return f;
  }
  return null;
}

export function findStackOf(n: LayoutNode | null, panelId: string): StackNode | null {
  return stacks(n).find((s) => s.tabs.includes(panelId)) ?? null;
}

/** Parent split of a node, or null for the root. */
export function parentOf(n: LayoutNode | null, id: string): SplitNode | null {
  if (!n || n.type === 'stack') return null;
  for (const c of n.children) {
    if (c.id === id) return n;
    const p = parentOf(c, id);
    if (p) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------
// normalisation
// ---------------------------------------------------------------------------

function fixSizes(sizes: number[], n: number): number[] {
  const s = sizes.slice(0, n).map((x) => (Number.isFinite(x) && x > 0 ? x : 0));
  while (s.length < n) s.push(0);
  const pos = s.filter((x) => x > 0);
  const fill = pos.length ? pos.reduce((a, b) => a + b, 0) / pos.length : 1;
  const t = s.map((x) => (x > 0 ? x : fill));
  const sum = t.reduce((a, b) => a + b, 0) || 1;
  return t.map((x) => Math.max(0.0001, x / sum));
}

export function normalize(n: LayoutNode | null): LayoutNode | null {
  if (!n) return null;
  if (n.type === 'stack') {
    const tabs = [...new Set(n.tabs)];
    if (!tabs.length) return null;
    const active = tabs.includes(n.active) ? n.active : tabs[0];
    return tabs.length === n.tabs.length && active === n.active ? n : { ...n, tabs, active };
  }
  const kids: LayoutNode[] = [];
  const sizes: number[] = [];
  const src = fixSizes(n.sizes, n.children.length);
  n.children.forEach((c, i) => {
    const k = normalize(c);
    if (!k) return;
    if (k.type === 'split' && k.dir === n.dir) {
      // same direction: inline the grandchildren
      k.children.forEach((g, j) => {
        kids.push(g);
        sizes.push(src[i] * k.sizes[j]);
      });
    } else {
      kids.push(k);
      sizes.push(src[i]);
    }
  });
  if (!kids.length) return null;
  if (kids.length === 1) return kids[0];
  return { ...n, children: kids, sizes: fixSizes(sizes, kids.length) };
}

/** Replace the node with id `id` by `fn(node)` (null removes it), then normalise. */
export function mapNode(root: LayoutNode | null, id: string, fn: (n: LayoutNode) => LayoutNode | null): LayoutNode | null {
  const walk = (n: LayoutNode): LayoutNode | null => {
    if (n.id === id) return fn(n);
    if (n.type === 'stack') return n;
    let changed = false;
    const kids = n.children.map((c) => {
      const r = walk(c);
      if (r !== c) changed = true;
      return r;
    });
    if (!changed) return n;
    const keep = kids.map((k, i) => [k, n.sizes[i]] as const).filter(([k]) => k) as [LayoutNode, number][];
    return { ...n, children: keep.map(([k]) => k), sizes: keep.map(([, s]) => s) };
  };
  return normalize(root ? walk(root) : null);
}

// ---------------------------------------------------------------------------
// operations
// ---------------------------------------------------------------------------

/** Take a panel out of the layout (its stack disappears when it was the last tab). */
export function removePanel(root: LayoutNode | null, panelId: string): LayoutNode | null {
  const s = findStackOf(root, panelId);
  if (!s) return root;
  return mapNode(root, s.id, (n) => {
    const st = n as StackNode;
    const tabs = st.tabs.filter((t) => t !== panelId);
    if (!tabs.length) return null;
    const i = st.tabs.indexOf(panelId);
    return { ...st, tabs, active: st.active === panelId ? tabs[Math.min(i, tabs.length - 1)] : st.active };
  });
}

const axis = (z: Zone): Dir => (z === 'left' || z === 'right' ? 'row' : 'col');
const before = (z: Zone) => z === 'left' || z === 'top';

/**
 * Dock a panel relative to a stack: 'center' adds it as a tab, the sides split the stack's space
 * in half. The panel is moved if it is already in the layout. No-op when dropping a lone tab on
 * its own stack.
 */
export function dockPanel(root: LayoutNode | null, panelId: string, targetStackId: string, zone: Zone): LayoutNode | null {
  const target0 = findNode(root, targetStackId);
  if (!target0 || target0.type !== 'stack') return root;
  if (zone === 'center') {
    if (target0.tabs.includes(panelId)) return mapNode(root, targetStackId, (n) => ({ ...(n as StackNode), active: panelId, minimized: undefined }));
    const r = removePanel(root, panelId);
    return mapNode(r, targetStackId, (n) => ({ ...(n as StackNode), tabs: [...(n as StackNode).tabs, panelId], active: panelId, minimized: undefined }));
  }
  if (target0.tabs.length === 1 && target0.tabs[0] === panelId) return root;
  const r = removePanel(root, panelId);
  const target = findNode(r, targetStackId);
  if (!target) return r;
  const fresh = stack([panelId]);
  const dir = axis(zone);
  const parent = parentOf(r, targetStackId);
  if (parent && parent.dir === dir) {
    return mapNode(r, parent.id, (p) => {
      const sp = p as SplitNode;
      const i = sp.children.findIndex((c) => c.id === targetStackId);
      const half = sp.sizes[i] / 2;
      const children = [...sp.children];
      const sizes = [...sp.sizes];
      const at = before(zone) ? i : i + 1;
      sizes[i] = half;
      children.splice(at, 0, fresh);
      sizes.splice(at, 0, half);
      return { ...sp, children, sizes };
    });
  }
  return mapNode(r, targetStackId, (t) => split(dir, before(zone) ? [fresh, t] : [t, fresh], [0.5, 0.5]));
}

/** Dock a panel along an outer edge of the whole layout, taking `frac` of the window. */
export function dockEdge(root: LayoutNode | null, panelId: string, zone: Exclude<Zone, 'center'>, frac = 0.22): LayoutNode | null {
  const r = removePanel(root, panelId);
  const fresh = stack([panelId]);
  if (!r) return fresh;
  const dir = axis(zone);
  const kids = before(zone) ? [fresh, r] : [r, fresh];
  const sizes = before(zone) ? [frac, 1 - frac] : [1 - frac, frac];
  return normalize(split(dir, kids, sizes));
}

/**
 * Open a panel that isn't in the layout. It goes beside / into the stack of `near` when given and
 * present, else along the `edge` of the window. Already open: just brought to front.
 */
export function addPanel(root: LayoutNode | null, panelId: string, opts: { near?: string; zone?: Zone; edge?: Exclude<Zone, 'center'> } = {}): LayoutNode | null {
  const has = findStackOf(root, panelId);
  if (has) return setActive(root, has.id, panelId);
  const near = opts.near ? findStackOf(root, opts.near) : null;
  if (near) return dockPanel(root, panelId, near.id, opts.zone ?? 'center');
  return dockEdge(root, panelId, opts.edge ?? 'right');
}

export function setActive(root: LayoutNode | null, stackId: string, panelId: string): LayoutNode | null {
  return mapNode(root, stackId, (n) => (n.type === 'stack' && n.tabs.includes(panelId) ? { ...n, active: panelId } : n));
}

/** Reorder a tab within its stack. */
export function moveTab(root: LayoutNode | null, stackId: string, panelId: string, index: number): LayoutNode | null {
  return mapNode(root, stackId, (n) => {
    if (n.type !== 'stack' || !n.tabs.includes(panelId)) return n;
    const tabs = n.tabs.filter((t) => t !== panelId);
    tabs.splice(Math.max(0, Math.min(tabs.length, index)), 0, panelId);
    return { ...n, tabs, active: panelId };
  });
}

export function setMinimized(root: LayoutNode | null, stackId: string, minimized: boolean): LayoutNode | null {
  return mapNode(root, stackId, (n) => (n.type === 'stack' ? { ...n, minimized: minimized || undefined } : n));
}

/** Set a split's sizes (normalised). */
export function setSizes(root: LayoutNode | null, splitId: string, sizes: number[]): LayoutNode | null {
  return mapNode(root, splitId, (n) => (n.type === 'split' ? { ...n, sizes: fixSizes(sizes, n.children.length) } : n));
}

/**
 * Move the boundary after child `index` of a split by `delta` (a fraction of the split's length),
 * keeping both neighbours at least `min`.
 */
export function resize(root: LayoutNode | null, splitId: string, index: number, delta: number, min = 0.04): LayoutNode | null {
  const sp = findNode(root, splitId);
  if (!sp || sp.type !== 'split' || index < 0 || index >= sp.children.length - 1) return root;
  const a = sp.sizes[index];
  const b = sp.sizes[index + 1];
  const d = Math.max(min - a, Math.min(b - min, delta));
  const sizes = [...sp.sizes];
  sizes[index] = a + d;
  sizes[index + 1] = b - d;
  return setSizes(root, splitId, sizes);
}

// ---------------------------------------------------------------------------
// (de)serialisation
// ---------------------------------------------------------------------------

export const LAYOUT_VERSION = 1;

export function serialize(l: Layout): string {
  return JSON.stringify({ v: LAYOUT_VERSION, root: l.root });
}

function parseNode(x: unknown, depth = 0): LayoutNode | null {
  if (!x || typeof x !== 'object' || depth > 24) return null;
  const o = x as Record<string, unknown>;
  const id = typeof o.id === 'string' && o.id ? o.id.slice(0, 40) : newId('x');
  if (o.type === 'stack') {
    const tabs = Array.isArray(o.tabs) ? o.tabs.filter((t): t is string => typeof t === 'string' && !!t).map((t) => t.slice(0, 80)) : [];
    if (!tabs.length) return null;
    return { type: 'stack', id, tabs, active: typeof o.active === 'string' && tabs.includes(o.active) ? o.active : tabs[0], ...(o.minimized === true ? { minimized: true } : {}) };
  }
  if (o.type === 'split' && (o.dir === 'row' || o.dir === 'col') && Array.isArray(o.children)) {
    const sizes = Array.isArray(o.sizes) ? o.sizes.map((s) => (typeof s === 'number' ? s : 0)) : [];
    const pairs = o.children.map((c, i) => [parseNode(c, depth + 1), sizes[i] ?? 0] as const).filter(([c]) => c) as [LayoutNode, number][];
    return { type: 'split', id, dir: o.dir, children: pairs.map(([c]) => c), sizes: pairs.map(([, s]) => s) };
  }
  return null;
}

/** Parse a serialised layout (string or already-parsed JSON). Invalid input → null. */
export function deserialize(src: unknown): Layout | null {
  let j: unknown = src;
  if (typeof src === 'string') {
    try {
      j = JSON.parse(src);
    } catch {
      return null;
    }
  }
  if (!j || typeof j !== 'object') return null;
  const o = j as { root?: unknown };
  if (!('root' in o)) return null;
  if (o.root === null) return { root: null };
  const root = normalize(parseNode(o.root));
  if (!root) return null;
  // duplicate panel / node ids: keep the first occurrence of a panel, re-id repeated nodes
  const seen = new Set<string>();
  const ids = new Set<string>();
  const dedupe = (n: LayoutNode): LayoutNode => {
    const id = ids.has(n.id) ? newId('d') : n.id;
    ids.add(id);
    if (n.type === 'stack') {
      const tabs = n.tabs.filter((t) => !seen.has(t));
      tabs.forEach((t) => seen.add(t));
      return { ...n, id, tabs };
    }
    return { ...n, id, children: n.children.map(dedupe) };
  };
  return { root: normalize(dedupe(root)) };
}

/** A deep copy with fresh ids (so two workspaces never share node identities). */
export function cloneLayout(l: Layout): Layout {
  const walk = (n: LayoutNode): LayoutNode => (n.type === 'stack' ? { ...n, id: newId('s'), tabs: [...n.tabs] } : { ...n, id: newId(n.dir === 'row' ? 'r' : 'c'), children: n.children.map(walk), sizes: [...n.sizes] });
  return { root: l.root ? walk(l.root) : null };
}
