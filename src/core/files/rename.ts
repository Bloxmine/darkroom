/**
 * Batch Rename (like Bridge's Tools › Batch Rename): a new name is built from a list of
 * parts — text, sequence number/letter, date, original name, folder name, EXIF fields —
 * and the extension is kept. `planRenames` previews every new name and flags conflicts;
 * nothing is renamed if any item has a problem. Pure (no DOM, no fs).
 */
import type { ExifSummary } from './types';
import { stemOf } from './sidecar';
import { extOfName } from './kinds';
import type { XmpData } from './xmp';

export type MetaField = 'make' | 'model' | 'lens' | 'iso' | 'focal' | 'aperture' | 'shutter' | 'width' | 'height' | 'rating' | 'label';

export type RenamePart =
  | { type: 'text'; text: string }
  | { type: 'name'; case?: 'keep' | 'upper' | 'lower' }
  | { type: 'seq'; start?: number; digits?: number }
  | { type: 'letter'; upper?: boolean }
  | { type: 'date'; source?: 'taken' | 'modified' | 'created'; format?: string }
  | { type: 'meta'; field: MetaField }
  | { type: 'folder' };

export interface RenameOptions {
  ext?: 'keep' | 'lower' | 'upper';
}

export interface RenameFile {
  path: string;
  name: string;
  /** Path of the containing folder (conflicts are checked per folder). */
  dir: string;
  mtime: number;
  btime?: number;
  exif?: ExifSummary | null;
  xmp?: XmpData;
}

export interface PlannedRename {
  path: string;
  from: string;
  to: string;
  /** Unchanged name (skipped, not an error). */
  same?: boolean;
  problem?: string;
}

export const META_LABELS: Record<MetaField, string> = {
  make: 'Camera make',
  model: 'Camera model',
  lens: 'Lens',
  iso: 'ISO',
  focal: 'Focal length',
  aperture: 'Aperture',
  shutter: 'Shutter speed',
  width: 'Width (px)',
  height: 'Height (px)',
  rating: 'Rating',
  label: 'Label',
};

/** Characters macOS / Windows / the FS APIs won't take in a name. */
const clean = (s: string) => s.replace(/[/\\:*?"<>|\0]+/g, '-').replace(/\s+/g, ' ');

const pad = (n: number, d: number) => (n < 0 ? '-' : '') + String(Math.abs(Math.trunc(n))).padStart(d, '0');

/** a, b, … z, aa, ab … (spreadsheet columns). */
export function seqLetter(i: number): string {
  let s = '';
  let n = i + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(97 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Format a timestamp with YYYY YY MM DD hh mm ss tokens. Dates from EXIF are wall-clock (UTC fields). */
export function formatDate(ms: number, format = 'YYYYMMDD', utc = false): string {
  const d = new Date(ms);
  const g = utc
    ? { Y: d.getUTCFullYear(), M: d.getUTCMonth() + 1, D: d.getUTCDate(), h: d.getUTCHours(), m: d.getUTCMinutes(), s: d.getUTCSeconds() }
    : { Y: d.getFullYear(), M: d.getMonth() + 1, D: d.getDate(), h: d.getHours(), m: d.getMinutes(), s: d.getSeconds() };
  return format.replace(/YYYY|YY|MM|DD|hh|mm|ss/g, (t) =>
    t === 'YYYY' ? String(g.Y) : t === 'YY' ? pad(g.Y % 100, 2) : t === 'MM' ? pad(g.M, 2) : t === 'DD' ? pad(g.D, 2) : t === 'hh' ? pad(g.h, 2) : t === 'mm' ? pad(g.m, 2) : pad(g.s, 2),
  );
}

export function shutterText(s: number | undefined): string {
  if (!s || !Number.isFinite(s)) return '';
  if (s >= 0.3) return `${Math.round(s * 10) / 10}s`;
  return `1/${Math.round(1 / s)}`;
}

function metaValue(f: RenameFile, field: MetaField): string {
  const e = f.exif ?? {};
  switch (field) {
    case 'make':
      return e.make ?? '';
    case 'model':
      return e.model ?? '';
    case 'lens':
      return e.lens ?? '';
    case 'iso':
      return e.iso ? `ISO${e.iso}` : '';
    case 'focal':
      return e.focalLength ? `${Math.round(e.focalLength)}mm` : '';
    case 'aperture':
      return e.fNumber ? `f${Math.round(e.fNumber * 10) / 10}` : '';
    case 'shutter':
      return shutterText(e.exposureTime).replace('/', '-');
    case 'width':
      return e.width ? String(e.width) : '';
    case 'height':
      return e.height ? String(e.height) : '';
    case 'rating':
      return f.xmp?.rating === -1 ? 'reject' : f.xmp?.rating ? `${f.xmp.rating}star` : '';
    case 'label':
      return f.xmp?.label ?? '';
  }
}

/** The new name for file #`index` of the batch (extension kept). */
export function buildName(parts: RenamePart[], f: RenameFile, index: number, opts: RenameOptions = {}): string {
  let stem = '';
  for (const p of parts) {
    switch (p.type) {
      case 'text':
        stem += p.text;
        break;
      case 'name': {
        const n = stemOf(f.name);
        stem += p.case === 'upper' ? n.toUpperCase() : p.case === 'lower' ? n.toLowerCase() : n;
        break;
      }
      case 'seq':
        stem += pad((p.start ?? 1) + index, Math.max(1, Math.min(10, p.digits ?? 3)));
        break;
      case 'letter': {
        const l = seqLetter(index);
        stem += p.upper ? l.toUpperCase() : l;
        break;
      }
      case 'date': {
        const src = p.source ?? 'taken';
        const exifDate = src === 'taken' ? f.exif?.dateTaken : undefined;
        const ms = exifDate ?? (src === 'created' ? (f.btime ?? f.mtime) : src === 'taken' ? (f.btime ?? f.mtime) : f.mtime);
        stem += formatDate(ms, p.format || 'YYYYMMDD', exifDate !== undefined);
        break;
      }
      case 'meta':
        stem += metaValue(f, p.field);
        break;
      case 'folder':
        stem += f.dir.split(/[\\/]/).filter(Boolean).pop() ?? '';
        break;
    }
  }
  stem = clean(stem).trim();
  const ext = extOfName(f.name);
  const e = opts.ext === 'lower' ? ext.toLowerCase() : opts.ext === 'upper' ? ext.toUpperCase() : (/\.([^./\\]+)$/.exec(f.name)?.[1] ?? '');
  return ext ? `${stem}.${e}` : stem;
}

/**
 * Preview a batch rename. `siblings(dir)` lists the names currently in a folder.
 * Problems: empty/hidden names, two files getting the same name (case-insensitive, like the
 * default macOS file system), and names that already exist and are not being renamed away.
 */
export function planRenames(files: RenameFile[], parts: RenamePart[], opts: RenameOptions, siblings: (dir: string) => Iterable<string>): PlannedRename[] {
  const plan: PlannedRename[] = files.map((f, i) => {
    const to = buildName(parts, f, i, opts);
    return { path: f.path, from: f.name, to, same: to === f.name };
  });
  const byDir = new Map<string, number[]>();
  files.forEach((f, i) => byDir.set(f.dir, [...(byDir.get(f.dir) ?? []), i]));
  for (const [dir, idx] of byDir) {
    const leaving = new Set(idx.filter((i) => !plan[i].same).map((i) => files[i].name.toLowerCase()));
    const staying = new Set([...siblings(dir)].map((n) => n.toLowerCase()).filter((n) => !leaving.has(n)));
    const counts = new Map<string, number>();
    for (const i of idx) counts.set(plan[i].to.toLowerCase(), (counts.get(plan[i].to.toLowerCase()) ?? 0) + 1);
    for (const i of idx) {
      const p = plan[i];
      const key = p.to.toLowerCase();
      if (!stemOf(p.to).trim() || p.to.startsWith('.')) p.problem = 'Empty or hidden name';
      else if (p.to.length > 255) p.problem = 'Name too long';
      else if ((counts.get(key) ?? 0) > 1) p.problem = 'Duplicate name in this batch';
      else if (!p.same && staying.has(key) && key !== files[i].name.toLowerCase()) p.problem = 'A file with this name already exists';
    }
  }
  return plan;
}

export const DEFAULT_RENAME_PARTS: RenamePart[] = [
  { type: 'text', text: 'Photo_' },
  { type: 'date', source: 'taken', format: 'YYYYMMDD' },
  { type: 'text', text: '_' },
  { type: 'seq', start: 1, digits: 3 },
];
