/**
 * Workspace definitions (pure): the built-in workspaces, Adobe Bridge CS3 style, and the
 * create / overwrite / rename / delete operations on the user's saved ones. Saved workspaces live in
 * Preferences (`customWorkspaces`, so they travel with Preferences › Export / Import); the live,
 * possibly modified layout of each workspace is kept by the store (store.ts).
 */
import { cloneLayout, col, deserialize, row, stack, type Layout } from './layout';

export interface WorkspaceDef {
  id: string;
  name: string;
  /** Shipped with the app: can be reset, not renamed or deleted. */
  builtin?: boolean;
  icon?: string;
  layout: Layout;
}

/** What Preferences stores per custom workspace. */
export interface SavedWorkspace {
  id: string;
  name: string;
  layout: unknown;
}

const B = {
  folders: 'browser.folders',
  favorites: 'browser.favorites',
  content: 'browser.content',
  preview: 'browser.preview',
  metadata: 'browser.metadata',
  keywords: 'browser.keywords',
  filter: 'browser.filter',
  collections: 'browser.collections',
  filmstrip: 'browser.filmstrip',
};

/** Built-in layouts, built fresh on every call (ids are unique per call). */
export function builtinWorkspaces(): WorkspaceDef[] {
  return [
    {
      id: 'essentials',
      name: 'Essentials',
      icon: 'layouts_body_3_col',
      builtin: true,
      layout: { root: row([stack(['library']), col([stack(['viewer']), stack(['graph'])], [0.56, 0.44]), stack(['properties'])], [0.16, 0.62, 0.22]) },
    },
    {
      id: 'browse',
      name: 'Browse',
      icon: 'folder_explorer',
      builtin: true,
      layout: {
        root: row(
          [
            col([stack([B.folders, B.favorites, B.collections]), stack([B.filter])], [0.58, 0.42]),
            stack([B.content]),
            col([stack([B.preview]), stack([B.metadata, B.keywords])], [0.42, 0.58]),
          ],
          [0.19, 0.55, 0.26],
        ),
      },
    },
    {
      id: 'filmstrip',
      name: 'Filmstrip',
      icon: 'film',
      builtin: true,
      layout: {
        root: col([row([col([stack([B.folders, B.favorites, B.collections]), stack([B.filter])], [0.6, 0.4]), stack([B.preview])], [0.2, 0.8]), stack([B.filmstrip])], [0.74, 0.26]),
      },
    },
    {
      id: 'lightTable',
      name: 'Light Table',
      icon: 'images',
      builtin: true,
      layout: { root: stack([B.content]) },
    },
    {
      id: 'graph',
      name: 'Graph',
      icon: 'node_design',
      builtin: true,
      layout: { root: row([stack(['library']), stack(['graph']), col([stack(['viewer']), stack(['properties'])], [0.36, 0.64])], [0.17, 0.58, 0.25]) },
    },
    {
      id: 'viewer',
      name: 'Viewer',
      icon: 'monitor',
      builtin: true,
      layout: {
        root: col([row([stack(['viewer']), col([stack(['scopes']), stack(['properties'])], [0.45, 0.55])], [0.72, 0.28]), stack(['graph', 'library'], { minimized: true })], [0.8, 0.2]),
      },
    },
    {
      id: 'metadata',
      name: 'Metadata',
      icon: 'tag_blue',
      builtin: true,
      layout: {
        root: row([col([stack([B.folders, B.favorites, B.collections]), stack([B.filter])], [0.55, 0.45]), stack([B.content]), stack([B.metadata, B.keywords])], [0.18, 0.4, 0.42]),
      },
    },
  ];
}

export const BUILTIN_IDS = builtinWorkspaces().map((w) => w.id);
export const DEFAULT_WORKSPACE = 'essentials';

/** Built-ins first, then the saved ones (invalid saved layouts are skipped). */
export function allWorkspaces(saved: SavedWorkspace[]): WorkspaceDef[] {
  const out = builtinWorkspaces();
  for (const s of saved) {
    const layout = deserialize(s.layout);
    if (layout && !out.some((w) => w.id === s.id)) out.push({ id: s.id, name: s.name, layout });
  }
  return out;
}

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32) || 'workspace';

export class WorkspaceError extends Error {}

const builtinNamed = (name: string) => builtinWorkspaces().find((w) => w.name.toLowerCase() === name.trim().toLowerCase());

/**
 * Save a layout under a name. A saved workspace with the same name (case-insensitive) is
 * overwritten; built-in names are reserved.
 */
export function saveWorkspace(saved: SavedWorkspace[], name: string, layout: Layout): { saved: SavedWorkspace[]; id: string; overwritten: boolean } {
  const n = name.trim().slice(0, 60);
  if (!n) throw new WorkspaceError('Enter a name for the workspace.');
  if (builtinNamed(n)) throw new WorkspaceError(`“${n}” is a built-in workspace. Choose another name.`);
  const data = JSON.parse(JSON.stringify(cloneLayout(layout))) as Layout;
  const i = saved.findIndex((w) => w.name.toLowerCase() === n.toLowerCase());
  if (i >= 0) {
    const next = [...saved];
    next[i] = { ...saved[i], name: n, layout: data };
    return { saved: next, id: saved[i].id, overwritten: true };
  }
  const taken = new Set([...BUILTIN_IDS, ...saved.map((w) => w.id)]);
  let id = 'u-' + slug(n);
  for (let k = 2; taken.has(id); k++) id = `u-${slug(n)}-${k}`;
  return { saved: [...saved, { id, name: n, layout: data }], id, overwritten: false };
}

export function renameWorkspace(saved: SavedWorkspace[], id: string, name: string): SavedWorkspace[] {
  const n = name.trim().slice(0, 60);
  if (!n) throw new WorkspaceError('Enter a name for the workspace.');
  if (!saved.some((w) => w.id === id)) throw new WorkspaceError('Only your own workspaces can be renamed.');
  if (builtinNamed(n)) throw new WorkspaceError(`“${n}” is a built-in workspace. Choose another name.`);
  if (saved.some((w) => w.id !== id && w.name.toLowerCase() === n.toLowerCase())) throw new WorkspaceError(`A workspace named “${n}” already exists.`);
  return saved.map((w) => (w.id === id ? { ...w, name: n } : w));
}

/** Replace a saved workspace's layout with `layout`. */
export function overwriteWorkspace(saved: SavedWorkspace[], id: string, layout: Layout): SavedWorkspace[] {
  if (!saved.some((w) => w.id === id)) throw new WorkspaceError('Only your own workspaces can be overwritten.');
  const data = JSON.parse(JSON.stringify(cloneLayout(layout))) as Layout;
  return saved.map((w) => (w.id === id ? { ...w, layout: data } : w));
}

export function deleteWorkspace(saved: SavedWorkspace[], id: string): SavedWorkspace[] {
  if (BUILTIN_IDS.includes(id)) throw new WorkspaceError('Built-in workspaces cannot be deleted.');
  return saved.filter((w) => w.id !== id);
}

/** Validate Preferences' `customWorkspaces` value. */
export function sanitizeSaved(x: unknown): SavedWorkspace[] {
  if (!Array.isArray(x)) return [];
  const out: SavedWorkspace[] = [];
  for (const w of x) {
    if (!w || typeof w !== 'object') continue;
    const o = w as Record<string, unknown>;
    if (typeof o.id !== 'string' || typeof o.name !== 'string' || !o.id || BUILTIN_IDS.includes(o.id)) continue;
    if (!deserialize(o.layout)) continue;
    if (out.some((s) => s.id === o.id)) continue;
    out.push({ id: o.id.slice(0, 40), name: o.name.slice(0, 60), layout: o.layout });
  }
  return out.slice(0, 50);
}
