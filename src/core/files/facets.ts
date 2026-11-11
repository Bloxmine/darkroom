/**
 * The Filter panel (like Bridge's): facets with counts. Within a facet the ticked values are
 * OR-ed, across facets they are AND-ed. A facet's counts take every *other* facet's selection
 * into account (standard faceted search), so the numbers always say how many items ticking
 * that value would show. Pure.
 */
import { typeLabel } from './kinds';
import type { ExifSummary, FileKind } from './types';
import { LABELS, labelColor, type XmpData } from './xmp';

export type FacetId = 'rating' | 'label' | 'type' | 'keywords' | 'date' | 'camera' | 'lens' | 'iso' | 'focal' | 'orientation';

export const FACETS: { id: FacetId; title: string }[] = [
  { id: 'rating', title: 'Ratings' },
  { id: 'label', title: 'Labels' },
  { id: 'type', title: 'File Type' },
  { id: 'keywords', title: 'Keywords' },
  { id: 'date', title: 'Date Created' },
  { id: 'camera', title: 'Camera' },
  { id: 'lens', title: 'Lens' },
  { id: 'iso', title: 'ISO Speed Ratings' },
  { id: 'focal', title: 'Focal Length' },
  { id: 'orientation', title: 'Orientation' },
];

export type Filters = Partial<Record<FacetId, string[]>>;

export interface FacetItem {
  name: string;
  dir?: boolean;
  mtime: number;
  btime?: number;
  kind?: FileKind | 'folder';
  xmp?: XmpData;
  exif?: ExifSummary | null;
}

export interface FacetValue {
  value: string;
  label: string;
  count: number;
}

export const NONE = '∅';

const pad2 = (n: number) => String(n).padStart(2, '0');
/** The day an item was created: EXIF DateTimeOriginal (wall clock, stored as UTC), else the file's birth/modified time. */
export function createdDay(it: FacetItem): string {
  if (it.exif?.dateTaken !== undefined) {
    const d = new Date(it.exif.dateTaken);
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  }
  const d = new Date(it.btime || it.mtime);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function cameraName(e: ExifSummary | null | undefined): string | undefined {
  if (!e?.model) return e?.make || undefined;
  const make = (e.make ?? '').trim();
  const model = e.model.trim();
  if (!make || model.toLowerCase().startsWith(make.split(/\s/)[0].toLowerCase())) return model;
  return `${make.replace(/\s+(CORPORATION|Corporation|Co\.,? ?Ltd\.?|IMAGING CORP\.|Imaging Corp\.)$/, '')} ${model}`;
}

/** Oriented pixel size (EXIF orientation 5–8 swaps width and height). */
export function orientedDims(e: ExifSummary | null | undefined): { w: number; h: number } | null {
  if (!e?.width || !e?.height) return null;
  const swap = (e.orientation ?? 1) >= 5;
  return swap ? { w: e.height, h: e.width } : { w: e.width, h: e.height };
}

/** The values one item has for one facet ([] = it doesn't appear under that facet). */
export function facetValues(it: FacetItem, f: FacetId): string[] {
  const e = it.exif;
  switch (f) {
    case 'rating': {
      const r = it.xmp?.rating ?? 0;
      return [r < 0 ? 'reject' : String(r)];
    }
    case 'label': {
      const l = it.xmp?.label;
      if (!l) return [NONE];
      return [labelColor(l) ?? l];
    }
    case 'type':
      return [typeLabel(it.name)];
    case 'keywords': {
      const kw = it.xmp?.keywords ?? [];
      if (!kw.length) return [NONE];
      return [...new Set(kw.flatMap((k) => k.split('|')).filter(Boolean))];
    }
    case 'date':
      return [createdDay(it)];
    case 'camera': {
      const c = cameraName(e);
      return c ? [c] : [];
    }
    case 'lens':
      return e?.lens ? [e.lens] : [];
    case 'iso':
      return e?.iso ? [String(e.iso)] : [];
    case 'focal':
      return e?.focalLength ? [String(Math.round(e.focalLength * 10) / 10)] : [];
    case 'orientation': {
      const d = orientedDims(e);
      if (!d) return [];
      return [d.w > d.h ? 'landscape' : d.w < d.h ? 'portrait' : 'square'];
    }
  }
}

const active = (filters: Filters) => (Object.entries(filters) as [FacetId, string[]][]).filter(([, v]) => v && v.length);
export const hasFilters = (filters: Filters) => active(filters).length > 0;

/** Does the item pass every facet's selection (optionally ignoring one facet)? Folders only show without filters. */
export function matchesFilters(it: FacetItem, filters: Filters, except?: FacetId): boolean {
  const act = active(filters).filter(([f]) => f !== except);
  if (!act.length) return true;
  if (it.dir) return false;
  for (const [f, vals] of act) {
    const have = facetValues(it, f);
    if (!have.some((v) => vals.includes(v))) return false;
  }
  return true;
}

function valueLabel(f: FacetId, v: string): string {
  if (f === 'rating') return v === 'reject' ? 'Rejected' : v === '0' ? 'No Rating' : '★'.repeat(Number(v));
  if (f === 'label') return v === NONE ? 'No Label' : (LABELS.find((l) => l.color === v)?.name ?? v);
  if (f === 'keywords' && v === NONE) return 'No Keywords';
  if (f === 'focal') return `${v} mm`;
  if (f === 'orientation') return v[0].toUpperCase() + v.slice(1);
  if (f === 'date') {
    const [y, m, d] = v.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }
  return v;
}

function order(f: FacetId, a: string, b: string): number {
  if (f === 'rating') return (a === 'reject' ? 6 : Number(a)) - (b === 'reject' ? 6 : Number(b));
  if (f === 'label') {
    const ix = (v: string) => (v === NONE ? -1 : LABELS.findIndex((l) => l.color === v) >= 0 ? LABELS.findIndex((l) => l.color === v) : 99);
    return ix(a) - ix(b) || a.localeCompare(b);
  }
  if (f === 'keywords') return a === NONE ? -1 : b === NONE ? 1 : a.localeCompare(b, undefined, { sensitivity: 'base' });
  if (f === 'date') return b.localeCompare(a); // newest first
  if (f === 'iso' || f === 'focal') return Number(a) - Number(b);
  return a.localeCompare(b, undefined, { numeric: true });
}

/** Counts per facet value for the Filter panel. Folders are not counted. */
export function countFacets(items: FacetItem[], filters: Filters, facets: FacetId[] = FACETS.map((f) => f.id)): Record<FacetId, FacetValue[]> {
  const out = {} as Record<FacetId, FacetValue[]>;
  const files = items.filter((i) => !i.dir);
  for (const f of facets) {
    const counts = new Map<string, number>();
    for (const it of files) {
      if (!matchesFilters(it, filters, f)) continue;
      for (const v of facetValues(it, f)) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    // a ticked value stays listed (with 0) so it can be unticked
    for (const v of filters[f] ?? []) if (!counts.has(v)) counts.set(v, 0);
    out[f] = [...counts.entries()].sort((a, b) => order(f, a[0], b[0])).map(([value, count]) => ({ value, label: valueLabel(f, value), count }));
  }
  return out;
}

