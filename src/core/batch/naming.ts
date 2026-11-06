/**
 * Batch output file naming (pure). Pattern tokens:
 *   {name}    source file name without extension
 *   {preset}  preset / project name (sanitised)
 *   {n}       1-based index in the batch;  {n:3} zero-padded to 3 digits
 *   {date}    YYYY-MM-DD of the batch run
 *   {w} {h}   output size in px
 *   {ext}     source extension (e.g. "nef")
 */
export interface NameVars {
  name: string;
  preset?: string;
  index?: number;
  date?: Date;
  width?: number;
  height?: number;
  ext?: string;
}

export const DEFAULT_PATTERN = '{name}_{preset}';

/** Remove characters that are invalid in file names on common OSes. */
export function sanitizeFileName(s: string): string {
  // eslint-disable-next-line no-control-regex
  const out = s.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '_').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').replace(/[. ]+$/, '');
  return out.slice(0, 180);
}

export const stripExt = (name: string) => name.replace(/\.[^./\\]+$/, '');

const pad = (n: number, w: number) => String(n).padStart(w, '0');

/** Expand a pattern into a base name (no extension). Falls back to the source name when the result is empty. */
export function expandPattern(pattern: string, v: NameVars): string {
  const d = v.date ?? new Date();
  const base = stripExt(v.name);
  const ext = /\.([^./\\]+)$/.exec(v.name)?.[1]?.toLowerCase() ?? v.ext ?? '';
  const out = (pattern || DEFAULT_PATTERN).replace(/\{(\w+)(?::(\d+))?\}/g, (all, key: string, w?: string) => {
    switch (key) {
      case 'name':
        return base;
      case 'preset':
        return v.preset ?? '';
      case 'n':
      case 'index':
        return w ? pad(v.index ?? 1, +w) : String(v.index ?? 1);
      case 'date':
        return `${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}`;
      case 'w':
        return String(v.width ?? '');
      case 'h':
        return String(v.height ?? '');
      case 'ext':
        return ext;
      default:
        return all;
    }
  });
  // collapse separators left over by empty tokens ("name__" → "name")
  const cleaned = sanitizeFileName(out.replace(/([_\- ])\1+/g, '$1').replace(/^[_\- ]+|[_\- ]+$/g, ''));
  return cleaned || sanitizeFileName(base) || 'image';
}

/** Make names unique (case-insensitive) by appending " (2)", " (3)"… before the extension. */
export function uniqueNames(names: string[]): string[] {
  const seen = new Set<string>();
  return names.map((n) => {
    const m = /^(.*?)(\.[^.]+)?$/.exec(n)!;
    let cand = n;
    for (let i = 2; seen.has(cand.toLowerCase()); i++) cand = `${m[1]} (${i})${m[2] ?? ''}`;
    seen.add(cand.toLowerCase());
    return cand;
  });
}

/** Fit (w,h) so the long edge is at most `longEdge` (0 = unchanged). Never upscales. */
export function fitLongEdge(w: number, h: number, longEdge: number): { width: number; height: number; scale: number } {
  const L = Math.max(w, h);
  if (!longEdge || longEdge >= L || !L) return { width: w, height: h, scale: 1 };
  const s = longEdge / L;
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)), scale: s };
}

/** "1m 05s" style ETA. */
export function formatEta(sec: number): string {
  if (!isFinite(sec) || sec < 0) return '—';
  sec = Math.round(sec);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  return `${m}m ${String(sec % 60).padStart(2, '0')}s`;
}
