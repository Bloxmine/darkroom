/**
 * State of the Bridge-style file browser (the `browser.*` panels). Session state (current folder,
 * entries, selection, filters, metadata) plus browser preferences persisted in localStorage
 * `darkroom.browser` (favourites, recent folders, keyword list, collections, sort / view).
 */
import { create } from 'zustand';
import type { FsBackend } from '../../core/files/backend';
import { hasFilters, matchesFilters, orientedDims, type Filters } from '../../core/files/facets';
import { kindOf } from '../../core/files/kinds';
import type { ExifSummary, FsEntry, FsRoot } from '../../core/files/types';
import type { XmpData } from '../../core/files/xmp';

export type ViewMode = 'grid' | 'list' | 'strip';
export type SortKey = 'name' | 'date' | 'rating' | 'type' | 'size' | 'dims';
export const SORTS: { id: SortKey; label: string }[] = [
  { id: 'name', label: 'Filename' },
  { id: 'date', label: 'Date Created' },
  { id: 'rating', label: 'Rating' },
  { id: 'type', label: 'Document Type' },
  { id: 'size', label: 'File Size' },
  { id: 'dims', label: 'Dimensions' },
];

export interface KeywordNode {
  name: string;
  children?: KeywordNode[];
}
export interface Collection {
  id: string;
  name: string;
  paths: string[];
}
export interface SmartCollection {
  id: string;
  name: string;
  /** Folder searched. */
  folder: string;
  filters: Filters;
}

export interface ItemMeta {
  exif: ExifSummary | null;
  /** Embedded XMP merged with the sidecar (sidecar wins). */
  xmp: XmpData;
  sidecarPath: string;
  error?: string;
}

export type Source = { type: 'folder'; path: string } | { type: 'collection'; id: string } | { type: 'smart'; id: string };

interface Persisted {
  favorites: string[];
  recent: string[];
  keywords: KeywordNode[];
  collections: Collection[];
  smart: SmartCollection[];
  sortKey: SortKey;
  sortAsc: boolean;
  view: ViewMode;
  thumbSize: number;
  showHidden: boolean;
  showFolders: boolean;
  lastFolder: string | null;
  expanded: string[];
}

export type BrowserDialog =
  | { type: 'batchRename'; paths: string[] }
  | { type: 'rename'; path: string }
  | { type: 'confirm'; title: string; message: string; ok: string; icon?: string; resolve: (ok: boolean) => void }
  | { type: 'prompt'; title: string; label: string; value: string; ok: string; resolve: (v: string | null) => void };

export interface BrowserState extends Persisted {
  roots: FsRoot[];
  source: Source | null;
  /** Items of the current source (folders + browsable files). */
  entries: FsEntry[];
  /** Every name in the current folder (incl. sidecars) for conflict checks. */
  names: string[];
  loading: boolean;
  error: string | null;
  selection: string[];
  anchor: string | null;
  focus: string | null;
  filters: Filters;
  meta: Record<string, ItemMeta>;
  /** Files whose metadata is still being read. */
  metaPending: number;
  history: string[];
  historyIndex: number;
  /** Full-screen review (Space). */
  loupe: string | null;
  /** The browser panel that has focus (status bar counts). */
  activePanel: string | null;
  dialog: BrowserDialog | null;
  /** Folder tree: dir → sub-folders (undefined = not listed yet). */
  tree: Record<string, FsEntry[] | undefined>;
}

const KEY = 'darkroom.browser';

export const DEFAULT_KEYWORDS: KeywordNode[] = [
  { name: 'Events', children: [{ name: 'Birthday' }, { name: 'Graduation' }, { name: 'Wedding' }] },
  { name: 'People', children: [{ name: 'Family' }, { name: 'Friends' }] },
  { name: 'Places', children: [{ name: 'New York' }, { name: 'Paris' }, { name: 'San Francisco' }, { name: 'Tokyo' }] },
  { name: 'Other Keywords' },
];

const DEFAULTS: Persisted = {
  favorites: [],
  recent: [],
  keywords: DEFAULT_KEYWORDS,
  collections: [],
  smart: [],
  sortKey: 'name',
  sortAsc: true,
  view: 'grid',
  thumbSize: 150,
  showHidden: false,
  showFolders: true,
  lastFolder: null,
  expanded: [],
};

function load(): Persisted {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Persisted>;
    const arr = <T>(x: unknown, d: T[]): T[] => (Array.isArray(x) ? (x as T[]) : d);
    return {
      favorites: arr<string>(raw.favorites, []).filter((x) => typeof x === 'string'),
      recent: arr<string>(raw.recent, []).filter((x) => typeof x === 'string'),
      keywords: arr<KeywordNode>(raw.keywords, DEFAULT_KEYWORDS),
      collections: arr<Collection>(raw.collections, []),
      smart: arr<SmartCollection>(raw.smart, []),
      sortKey: SORTS.some((s) => s.id === raw.sortKey) ? raw.sortKey! : 'name',
      sortAsc: raw.sortAsc !== false,
      view: (['grid', 'list', 'strip'] as const).includes(raw.view as ViewMode) ? raw.view! : 'grid',
      thumbSize: typeof raw.thumbSize === 'number' ? Math.max(64, Math.min(360, raw.thumbSize)) : 150,
      showHidden: !!raw.showHidden,
      showFolders: raw.showFolders !== false,
      lastFolder: typeof raw.lastFolder === 'string' ? raw.lastFolder : null,
      expanded: arr<string>(raw.expanded, []),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export const useBrowser = create<BrowserState>(() => ({
  ...load(),
  roots: [],
  source: null,
  entries: [],
  names: [],
  loading: false,
  error: null,
  selection: [],
  anchor: null,
  focus: null,
  filters: {},
  meta: {},
  metaPending: 0,
  history: [],
  historyIndex: -1,
  loupe: null,
  activePanel: null,
  dialog: null,
  tree: {},
}));

let saveTimer = 0;
useBrowser.subscribe((s, p) => {
  const keys = Object.keys(DEFAULTS) as (keyof Persisted)[];
  if (keys.every((k) => s[k] === p[k])) return;
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(keys.map((k) => [k, useBrowser.getState()[k]]))));
    } catch {
      /* storage full / unavailable */
    }
  }, 250);
});

/** The active file-system backend (set by src/ui/browser/backend.ts). */
export const fsRef: { current: FsBackend | null } = { current: null };

// ---------------------------------------------------------------------------
// derived: filtered + sorted items (memoised on the inputs' identities)
// ---------------------------------------------------------------------------

export const itemDate = (e: FsEntry, m?: ItemMeta) => {
  const t = m?.exif?.dateTaken;
  if (t !== undefined) return t + new Date(t).getTimezoneOffset() * 60000; // EXIF wall clock → local ms
  return e.btime || e.mtime;
};

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function compare(a: FsEntry, b: FsEntry, key: SortKey, meta: Record<string, ItemMeta>): number {
  switch (key) {
    case 'name':
      return collator.compare(a.name, b.name);
    case 'date':
      return itemDate(a, meta[a.path]) - itemDate(b, meta[b.path]);
    case 'rating':
      return (meta[a.path]?.xmp.rating ?? 0) - (meta[b.path]?.xmp.rating ?? 0);
    case 'type':
      return collator.compare(a.ext, b.ext);
    case 'size':
      return a.size - b.size;
    case 'dims': {
      const da = orientedDims(meta[a.path]?.exif);
      const db = orientedDims(meta[b.path]?.exif);
      return (da ? da.w * da.h : 0) - (db ? db.w * db.h : 0);
    }
  }
}

let memo: { entries: FsEntry[]; meta: Record<string, ItemMeta>; filters: Filters; key: SortKey; asc: boolean; folders: boolean; out: FsEntry[] } | null = null;

/** The Content panel's items: folders first, filtered by the Filter panel, sorted. */
export function visibleItems(s: BrowserState = useBrowser.getState()): FsEntry[] {
  if (memo && memo.entries === s.entries && memo.meta === s.meta && memo.filters === s.filters && memo.key === s.sortKey && memo.asc === s.sortAsc && memo.folders === s.showFolders) return memo.out;
  const filtering = hasFilters(s.filters);
  const items = s.entries.filter((e) => {
    if (e.dir) return s.showFolders && !filtering;
    if (!filtering) return true;
    const m = s.meta[e.path];
    return matchesFilters({ name: e.name, mtime: e.mtime, btime: e.btime, xmp: m?.xmp, exif: m?.exif }, s.filters);
  });
  const dir = s.sortAsc ? 1 : -1;
  items.sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    return dir * (compare(a, b, s.sortKey, s.meta) || collator.compare(a.name, b.name));
  });
  memo = { entries: s.entries, meta: s.meta, filters: s.filters, key: s.sortKey, asc: s.sortAsc, folders: s.showFolders, out: items };
  return items;
}

export const useVisibleItems = () => useBrowser((s) => visibleItems(s));

/** Facet input for the Filter panel. */
export function facetItems(s: Pick<BrowserState, 'entries' | 'meta'>) {
  return s.entries.filter((e) => !e.dir).map((e) => ({ name: e.name, mtime: e.mtime, btime: e.btime, kind: kindOf(e.name), xmp: s.meta[e.path]?.xmp, exif: s.meta[e.path]?.exif }));
}

