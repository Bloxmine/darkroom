/**
 * Web backends for the file browser.
 *
 * `webBackend()` — the File System Access API (Chromium: Chrome, Edge, Arc, Opera). Folders are
 * picked with showDirectoryPicker(); their handles are remembered in IndexedDB and permission is
 * re-requested (with a click) on the next visit. Paths are virtual: `/<rootId>/sub/file.jpg`.
 * Reading works everywhere the API exists. Sidecars are written next to the files when the
 * browser grants write access, otherwise kept in IndexedDB. Rename / move need
 * FileSystemHandle.move() (recent Chromium); the Trash isn't reachable from a web page (the API
 * can only delete permanently), so Move to Trash is a Mac-app feature.
 *
 * `filesBackend()` — browsers without the API (Safari, Firefox): a read-only list of files picked
 * with "Open files…" (an <input type=file>); ratings and keywords are kept in IndexedDB.
 */
import type { FsBackend } from './backend';
import { basename, dirname, joinPath } from './backend';
import { EXIFR_OPTIONS, summarizeExif } from './exif';
import { sniffDimensions } from './dims';
import { idbDel, idbGet, idbPut, idbAll } from './idb';
import { extOfName, kindOf, MIME_BY_EXT } from './kinds';
import { RAW_FORMATS } from '../raw/formats';
import { isSidecarName, renamedSidecar, sidecarName, sidecarReadCandidates } from './sidecar';
import type { ExifSummary, FileMetaResult, FsCaps, FsEntry, FsRoot, RenameOutcome } from './types';
import { writeXmp, type XmpData } from './xmp';

// --- minimal typings for the parts of the File System Access API we use -------------------------
type Perm = 'granted' | 'denied' | 'prompt';
interface FsHandle {
  kind: 'file' | 'directory';
  name: string;
  queryPermission?(o: { mode: 'read' | 'readwrite' }): Promise<Perm>;
  requestPermission?(o: { mode: 'read' | 'readwrite' }): Promise<Perm>;
  isSameEntry(o: FsHandle): Promise<boolean>;
  move?(a: FsDir | string, b?: string): Promise<void>;
}
interface FsFile extends FsHandle {
  kind: 'file';
  getFile(): Promise<File>;
  createWritable(o?: { keepExistingData?: boolean }): Promise<{ write(d: BlobPart): Promise<void>; close(): Promise<void> }>;
}
interface FsDir extends FsHandle {
  kind: 'directory';
  entries(): AsyncIterable<[string, FsFile | FsDir]>;
  getDirectoryHandle(n: string, o?: { create?: boolean }): Promise<FsDir>;
  getFileHandle(n: string, o?: { create?: boolean }): Promise<FsFile>;
}
type PickerWindow = Window & { showDirectoryPicker?: (o?: { id?: string; mode?: 'read' | 'readwrite' }) => Promise<FsDir> };

export const hasFsAccess = () => typeof window !== 'undefined' && typeof (window as PickerWindow).showDirectoryPicker === 'function';
const canMove = () => typeof FileSystemHandle !== 'undefined' && 'move' in FileSystemHandle.prototype;

const fileType = (name: string) => MIME_BY_EXT[extOfName(name)] ?? RAW_FORMATS[extOfName(name)] ?? '';

function entryOf(dir: string, name: string, f: File | null, isDir: boolean): FsEntry {
  return {
    path: joinPath(dir, name),
    name,
    dir: isDir,
    size: f?.size ?? 0,
    mtime: f?.lastModified ?? 0,
    ext: isDir ? '' : extOfName(name),
    kind: isDir ? 'folder' : kindOf(name),
    hidden: name.startsWith('.') || undefined,
  };
}

/** EXIF + embedded XMP from a File (exifr reads Blobs in chunks). */
export async function exifFromFile(f: File): Promise<ExifSummary | null> {
  const k = kindOf(f.name);
  let exif: ExifSummary | null = null;
  if (k === 'image' || k === 'raw') {
    const exifr = (await import('exifr')).default;
    const o = (await exifr.parse(f, { ...EXIFR_OPTIONS, xmp: { parse: false } } as never).catch(() => null)) as Record<string, unknown> | null;
    exif = summarizeExif(o, typeof o?.xmp === 'string' ? o.xmp : undefined, { raw: k === 'raw' });
    if (k === 'image' && (!exif?.width || !exif?.height)) {
      const d = sniffDimensions(new Uint8Array(await f.slice(0, 256 * 1024).arrayBuffer()));
      if (d) exif = { ...(exif ?? { source: 'exifr' }), width: d.width, height: d.height };
    }
  }
  return exif;
}

// ---------------------------------------------------------------------------
// File System Access API backend
// ---------------------------------------------------------------------------

interface RootRec {
  id: string;
  name: string;
  handle: FsDir;
  added: number;
}

export function webBackend(): FsBackend {
  const rootsById = new Map<string, RootRec>();
  const dirCache = new Map<string, FsDir>();
  let loaded: Promise<void> | null = null;
  const load = () =>
    (loaded ??= idbAll<RootRec>('roots')
      .then((all) => all.forEach(({ value }) => value?.handle && rootsById.set(value.id, value)))
      .catch((e) => console.warn('[darkroom files] could not read remembered folders', e)));

  const rootOf = (p: string) => {
    const id = p.split('/')[1];
    const r = rootsById.get(id);
    if (!r) throw new Error('This folder is no longer available — add it again.');
    return r;
  };

  async function dirHandle(p: string, create = false): Promise<FsDir> {
    const c = dirCache.get(p);
    if (c) return c;
    await load();
    const parts = p.split('/').filter(Boolean);
    let h: FsDir = rootOf(p).handle;
    for (const seg of parts.slice(1)) h = await h.getDirectoryHandle(seg, { create });
    dirCache.set(p, h);
    return h;
  }
  const fileHandle = async (p: string) => (await dirHandle(dirname(p))).getFileHandle(basename(p));
  const getFile = async (p: string) => (await fileHandle(p)).getFile();

  async function names(dir: string): Promise<string[]> {
    const out: string[] = [];
    for await (const [n] of (await dirHandle(dir)).entries()) out.push(n);
    return out;
  }

  async function canWrite(p: string, ask: boolean): Promise<boolean> {
    const h = rootOf(p).handle;
    const q = (await h.queryPermission?.({ mode: 'readwrite' })) ?? 'granted';
    if (q === 'granted') return true;
    if (!ask || q === 'denied') return false;
    try {
      return (await h.requestPermission?.({ mode: 'readwrite' })) === 'granted';
    } catch {
      return false; // no user activation: fall back to IndexedDB
    }
  }

  const caps: FsCaps = {
    rename: canMove(),
    move: canMove(),
    copy: true,
    trash: false,
    reveal: false,
    openDefault: false,
    mkdir: true,
    sidecarOnDisk: true,
    watch: false,
    why: canMove()
      ? 'A web page can’t move files to the Trash or show them in Finder — use the Darkroom Mac app or your file manager.'
      : 'This browser can’t rename, move or trash files from a web page — use the Darkroom Mac app or your file manager.',
  };

  async function exists(dir: FsDir, name: string) {
    for await (const [n] of dir.entries()) if (n.toLowerCase() === name.toLowerCase()) return true;
    return false;
  }

  return {
    kind: 'web',
    caps,
    async roots() {
      await load();
      const out: FsRoot[] = [];
      for (const r of [...rootsById.values()].sort((a, b) => a.added - b.added)) {
        const q = (await r.handle.queryPermission?.({ mode: 'read' }).catch(() => 'prompt' as Perm)) ?? 'granted';
        out.push({ path: `/${r.id}`, name: r.name, source: 'granted', needsPermission: q !== 'granted' });
      }
      return out;
    },
    async addRoot() {
      await load();
      let h: FsDir;
      try {
        h = await (window as PickerWindow).showDirectoryPicker!({ id: 'darkroom-browse', mode: 'read' });
      } catch (e) {
        if ((e as Error).name === 'AbortError') return null;
        throw e;
      }
      for (const r of rootsById.values()) if (await r.handle.isSameEntry(h).catch(() => false)) return { path: `/${r.id}`, name: r.name, source: 'granted' };
      const rec: RootRec = { id: 'r' + Math.random().toString(36).slice(2, 9), name: h.name, handle: h, added: Date.now() };
      rootsById.set(rec.id, rec);
      await idbPut('roots', rec.id, rec).catch((e) => console.warn('[darkroom files] could not remember the folder', e));
      return { path: `/${rec.id}`, name: rec.name, source: 'granted' };
    },
    async removeRoot(p) {
      const id = p.split('/')[1];
      rootsById.delete(id);
      for (const k of [...dirCache.keys()]) if (k === p || k.startsWith(p + '/')) dirCache.delete(k);
      await idbDel('roots', id).catch(() => {});
    },
    async requestPermission(p) {
      await load();
      const r = rootOf(p);
      try {
        return (await r.handle.requestPermission?.({ mode: 'read' })) === 'granted';
      } catch {
        return false;
      }
    },
    async list(dir, opts) {
      const h = await dirHandle(dir);
      const items: [string, FsFile | FsDir][] = [];
      for await (const e of h.entries()) if (opts?.hidden || !e[0].startsWith('.')) items.push(e);
      const out: FsEntry[] = [];
      const CH = 32;
      for (let i = 0; i < items.length; i += CH) {
        const part = await Promise.all(
          items.slice(i, i + CH).map(async ([n, eh]) => {
            if (eh.kind === 'directory') {
              dirCache.set(joinPath(dir, n), eh as FsDir);
              return entryOf(dir, n, null, true);
            }
            // sidecars and other non-browsable files only need their names
            const f = isSidecarName(n) || kindOf(n) === 'other' ? null : await (eh as FsFile).getFile().catch(() => null);
            return entryOf(dir, n, f, false);
          }),
        );
        out.push(...part);
      }
      return out;
    },
    async stat(p) {
      try {
        if (p.split('/').filter(Boolean).length === 1) return { ...entryOf('/', rootOf(p).name, null, true), path: p };
        const d = await dirHandle(dirname(p));
        try {
          const f = await (await d.getFileHandle(basename(p))).getFile();
          return entryOf(dirname(p), basename(p), f, false);
        } catch {
          await d.getDirectoryHandle(basename(p));
          return entryOf(dirname(p), basename(p), null, true);
        }
      } catch {
        return null;
      }
    },
    async read(p, range) {
      const f = await getFile(p);
      const b = range ? f.slice(range.start, range.start + range.length) : f;
      return new Uint8Array(await b.arrayBuffer());
    },
    async file(p) {
      const f = await getFile(p);
      return f.type ? f : new File([f], f.name, { type: fileType(f.name), lastModified: f.lastModified });
    },
    async meta(paths) {
      const sibs = new Map<string, string[]>();
      const out: FileMetaResult[] = [];
      for (const p of paths) {
        const dir = dirname(p);
        const name = basename(p);
        try {
          if (!sibs.has(dir)) sibs.set(dir, await names(dir));
          const s = sibs.get(dir)!;
          const exif = await exifFromFile(await getFile(p));
          const scName = sidecarName(name, s);
          let sidecar: string | null = (await idbGet<string>('sidecars', joinPath(dir, scName)).catch(() => undefined)) ?? null;
          if (sidecar === null)
            for (const c of sidecarReadCandidates(name, s))
              if (s.includes(c)) {
                sidecar = await (await getFile(joinPath(dir, c))).text().catch(() => null);
                if (sidecar !== null) break;
              }
          out.push({ path: p, exif, sidecarPath: joinPath(dir, scName), sidecar });
        } catch (e) {
          out.push({ path: p, exif: null, sidecarPath: '', sidecar: null, error: (e as Error).message });
        }
      }
      return out;
    },
    async writeXmp(p, data) {
      const dir = dirname(p);
      const sc = sidecarName(basename(p), await names(dir));
      const scPath = joinPath(dir, sc);
      const d = await dirHandle(dir);
      const idbText = await idbGet<string>('sidecars', scPath).catch(() => undefined);
      if (await canWrite(p, true)) {
        let existing: string | null = null;
        try {
          existing = await (await (await d.getFileHandle(sc)).getFile()).text();
        } catch {
          /* new sidecar */
        }
        const text = writeXmp(existing ?? idbText ?? null, data);
        const fh = await d.getFileHandle(sc, { create: true });
        const w = await fh.createWritable();
        await w.write(text);
        await w.close();
        if (idbText !== undefined) await idbDel('sidecars', scPath).catch(() => {});
        return scPath;
      }
      let existing = idbText ?? null;
      if (existing === null) existing = await (await (await d.getFileHandle(sc)).getFile()).text().catch(() => null);
      await idbPut('sidecars', scPath, writeXmp(existing, data));
      return 'idb:' + scPath;
    },
    async rename(pairs) {
      if (!canMove()) throw new Error(caps.why);
      const out: RenameOutcome[] = [];
      for (const pr of pairs) {
        const dir = dirname(pr.from);
        try {
          if (!(await canWrite(pr.from, true))) throw new Error('Write access to this folder was not granted');
          const d = await dirHandle(dir);
          if (/[/\\:]/.test(pr.to) || !pr.to.trim()) throw new Error('Invalid name');
          if (pr.to.toLowerCase() !== basename(pr.from).toLowerCase() && (await exists(d, pr.to))) throw new Error(`“${pr.to}” already exists`);
          const sibs = await names(dir);
          const sc = sidecarReadCandidates(basename(pr.from), sibs).filter((c) => sibs.includes(c));
          await (await d.getFileHandle(basename(pr.from))).move!(pr.to);
          for (const c of sc) {
            const n = renamedSidecar(c, basename(pr.from), pr.to);
            if (n && !(await exists(d, n))) await (await d.getFileHandle(c)).move!(n).catch(() => {});
          }
          out.push({ from: pr.from, to: joinPath(dir, pr.to), ok: true });
        } catch (e) {
          out.push({ from: pr.from, to: pr.to, ok: false, error: (e as Error).message });
        }
      }
      return out;
    },
    async transfer(paths, destDir, mode) {
      const dest = await dirHandle(destDir);
      const out: RenameOutcome[] = [];
      for (const p of paths) {
        try {
          if (!(await canWrite(destDir, true))) throw new Error('Write access to the destination was not granted');
          if (dirname(p) === destDir) throw new Error('Already in that folder');
          const name = basename(p);
          if (await exists(dest, name)) throw new Error(`“${name}” already exists in the destination`);
          if (mode === 'move') {
            if (!canMove()) throw new Error(caps.why);
            if (!(await canWrite(p, true))) throw new Error('Write access was not granted');
            await (await fileHandle(p)).move!(dest);
          } else {
            const f = await getFile(p);
            const w = await (await dest.getFileHandle(name, { create: true })).createWritable();
            await w.write(f);
            await w.close();
          }
          out.push({ from: p, to: joinPath(destDir, name), ok: true });
        } catch (e) {
          out.push({ from: p, to: '', ok: false, error: (e as Error).message });
        }
      }
      return out;
    },
    async trash() {
      throw new Error(caps.why);
    },
    reveal() {},
    async openDefault() {
      throw new Error(caps.why);
    },
    async mkdir(parent, name) {
      if (!(await canWrite(parent, true))) throw new Error('Write access to this folder was not granted');
      const d = await dirHandle(parent);
      if (await exists(d, name)) throw new Error(`“${name}” already exists`);
      await d.getDirectoryHandle(name, { create: true });
      return joinPath(parent, name);
    },
    watch: () => () => {},
    displayPath(p) {
      try {
        const parts = p.split('/').filter(Boolean);
        return [rootOf(p).name, ...parts.slice(1)].join('/');
      } catch {
        return p;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Fallback for browsers without the API: files picked with <input type=file>
// ---------------------------------------------------------------------------

export const OPENED_ROOT = '/opened';
const opened = new Map<string, File>();

/** Add picked files to the "Opened Files" location; returns their paths. */
export function addOpenedFiles(files: File[]): string[] {
  return files.map((f) => {
    let name = f.name;
    for (let i = 2; opened.has(joinPath(OPENED_ROOT, name)); i++) name = f.name.replace(/(\.[^.]*)?$/, ` ${i}$1`);
    const p = joinPath(OPENED_ROOT, name);
    opened.set(p, f);
    return p;
  });
}

export function filesBackend(): FsBackend {
  const caps: FsCaps = {
    rename: false,
    move: false,
    copy: false,
    trash: false,
    reveal: false,
    openDefault: false,
    mkdir: false,
    sidecarOnDisk: false,
    watch: false,
    why: 'This browser can’t browse folders (no File System Access API). Ratings and keywords are kept in this browser; use Chrome / Edge or the Darkroom Mac app to work on folders.',
  };
  const get = (p: string) => {
    const f = opened.get(p);
    if (!f) throw new Error('File no longer available — open it again');
    return f;
  };
  const no = async (): Promise<never> => {
    throw new Error(caps.why);
  };
  return {
    kind: 'files',
    caps,
    roots: async () => [{ path: OPENED_ROOT, name: 'Opened Files', source: 'granted' }],
    addRoot: async () => null,
    removeRoot: async () => {},
    async list(dir) {
      if (dir !== OPENED_ROOT) return [];
      return [...opened.entries()].map(([p, f]) => ({ ...entryOf(OPENED_ROOT, basename(p), f, false), path: p }));
    },
    async stat(p) {
      const f = opened.get(p);
      return f ? entryOf(OPENED_ROOT, basename(p), f, false) : null;
    },
    async read(p, range) {
      const f = get(p);
      return new Uint8Array(await (range ? f.slice(range.start, range.start + range.length) : f).arrayBuffer());
    },
    async file(p) {
      const f = get(p);
      return f.type ? f : new File([f], f.name, { type: fileType(f.name) });
    },
    async meta(paths) {
      const out: FileMetaResult[] = [];
      for (const p of paths) {
        try {
          const sc = `${p}.xmp`;
          out.push({ path: p, exif: await exifFromFile(get(p)), sidecarPath: sc, sidecar: (await idbGet<string>('sidecars', sc).catch(() => undefined)) ?? null });
        } catch (e) {
          out.push({ path: p, exif: null, sidecarPath: '', sidecar: null, error: (e as Error).message });
        }
      }
      return out;
    },
    async writeXmp(p, data: XmpData) {
      const sc = `${p}.xmp`;
      const existing = (await idbGet<string>('sidecars', sc).catch(() => undefined)) ?? null;
      await idbPut('sidecars', sc, writeXmp(existing, data));
      return 'idb:' + sc;
    },
    rename: no,
    transfer: no,
    trash: no,
    reveal() {},
    openDefault: no,
    mkdir: no,
    watch: () => () => {},
    displayPath: (p) => basename(p),
  };
}
