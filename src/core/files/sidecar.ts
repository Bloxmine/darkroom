/**
 * Which XMP sidecar belongs to a file (pure; used by both backends).
 *
 * Adobe's convention is `<stem>.xmp` (IMG_0001.CR2 → IMG_0001.xmp). When a RAW and a JPEG
 * share a stem (RAW+JPEG shooting) they would share that sidecar, so the RAW keeps
 * `<stem>.xmp` (what Bridge/Lightroom read for it) and the other file gets `<name>.xmp`
 * (IMG_0001.JPG.xmp, the darktable/exiftool style) so rating one never rates the other.
 */
import { BROWSER_RAW_EXTS, extOfName } from './kinds';

export const stemOf = (name: string) => name.replace(/\.[^./\\]+$/, '');
export const isSidecarName = (name: string) => /\.xmp$/i.test(name);

/** Sidecar file name for `name`, given the names of the other files in the same folder. */
export function sidecarName(name: string, siblings: Iterable<string>): string {
  const stem = stemOf(name);
  if (BROWSER_RAW_EXTS.includes(extOfName(name))) return `${stem}.xmp`;
  const s = stem.toLowerCase();
  for (const o of siblings) {
    if (o === name || isSidecarName(o) || o.startsWith('.')) continue;
    if (stemOf(o).toLowerCase() === s && o.toLowerCase() !== name.toLowerCase()) return `${name}.xmp`;
  }
  return `${stem}.xmp`;
}

/** Sidecar names to try when reading, most specific first. */
export function sidecarReadCandidates(name: string, siblings: Iterable<string>): string[] {
  const primary = sidecarName(name, siblings);
  return [...new Set([primary, `${name}.xmp`])];
}

/** The renamed sidecar for a file renamed `from` → `to` (same folder), or null if `sc` isn't that file's own sidecar. */
export function renamedSidecar(sc: string, from: string, to: string): string | null {
  if (sc === `${from}.xmp`) return `${to}.xmp`;
  if (sc === `${stemOf(from)}.xmp`) return `${stemOf(to)}.xmp`;
  return null;
}
