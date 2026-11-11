/**
 * File browser IPC (window.darkroomNative.files, see src/native/api.ts › FilesApi).
 *
 * Security model (docs/BROWSER.md, docs/DESKTOP.md): the renderer sends paths, but every one is
 * checked by guardPath() — resolved with realpath (symlinks followed, `..` collapsed) and required
 * to be inside a granted root: a folder the user picked in the Add Folder dialog, the parent folder
 * of a file opened from Finder, or one of the default ~/Pictures, ~/Desktop, ~/Downloads.
 * Writes are limited to XMP sidecars, renames/moves/copies that never overwrite, new folders, and
 * the Trash (shell.trashItem). Image files themselves are never written.
 */
import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell, type IpcMainInvokeEvent } from 'electron';
import { createHash } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { copyFile, constants as fsc, mkdir, open, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import exifr from 'exifr';
import { IPC } from '../../src/native/api';
import { EXIFR_OPTIONS, summarizeExif } from '../../src/core/files/exif';
import { sniffDimensions } from '../../src/core/files/dims';
import { kindOf, extOfName } from '../../src/core/files/kinds';
import { isSidecarName, renamedSidecar, sidecarName, sidecarReadCandidates } from '../../src/core/files/sidecar';
import { writeXmp, type XmpData } from '../../src/core/files/xmp';
import type { FileMetaResult, FsEntry, FsRoot, RenameOutcome, RenamePair, ThumbResult } from '../../src/core/files/types';
import { checkName, guardPath } from './guard';

interface RootsState {
  granted: string[];
  /** Default locations the user removed from Favorites. */
  hiddenDefaults: string[];
}

let rootsFile = '';
let roots: RootsState = { granted: [], hiddenDefaults: [] };
let thumbDir = '';

const defaults = (): string[] =>
  process.env.DARKROOM_FILES_NO_DEFAULTS ? [] : (['pictures', 'desktop', 'downloads'] as const).map((k) => app.getPath(k));

/** Every root that grants access (granted + defaults, even hidden defaults stay readable). */
const allRoots = () => [...roots.granted, ...defaults()];

async function saveRoots() {
  try {
    await writeFile(rootsFile, JSON.stringify(roots));
  } catch (e) {
    console.error('[darkroom files] could not save roots', e);
  }
}

/** Grant a folder (folder picker, or the parent folder of a file opened from Finder). */
export function grantRoot(dir: string) {
  const p = path.resolve(dir);
  if (!roots.granted.includes(p)) {
    roots.granted = [...roots.granted, p].slice(-200);
    void saveRoots();
  }
}

function entryFrom(dir: string, name: string, st: { isDirectory(): boolean; size: number; mtimeMs: number; birthtimeMs: number }): FsEntry {
  const isDir = st.isDirectory();
  return {
    path: path.join(dir, name),
    name,
    dir: isDir,
    size: isDir ? 0 : st.size,
    mtime: Math.round(st.mtimeMs),
    btime: st.birthtimeMs ? Math.round(st.birthtimeMs) : undefined,
    ext: isDir ? '' : extOfName(name),
    kind: isDir ? 'folder' : kindOf(name),
    hidden: name.startsWith('.') || undefined,
  };
}

/** Small semaphore: QuickLook and exifr are I/O heavy, keep a few in flight. */
function limiter(n: number) {
  let active = 0;
  const q: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= n) await new Promise<void>((r) => q.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      q.shift()?.();
    }
  };
}
const thumbLimit = limiter(4);
const metaLimit = limiter(8);

const exists = (p: string) => stat(p).then(
  () => true,
  () => false,
);

async function readHead(p: string, bytes: number): Promise<Uint8Array> {
  const fh = await open(p, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
  } finally {
    await fh.close();
  }
}

async function siblingsOf(dir: string, cache?: Map<string, string[]>): Promise<string[]> {
  const c = cache?.get(dir);
  if (c) return c;
  const names = await readdir(dir).catch(() => [] as string[]);
  cache?.set(dir, names);
  return names;
}

async function fileMeta(p: string, cache: Map<string, string[]>): Promise<FileMetaResult> {
  let real = p;
  try {
    real = await guardPath(p, allRoots());
  } catch (e) {
    return { path: p, exif: null, sidecarPath: '', sidecar: null, error: (e as Error).message };
  }
  const dir = path.dirname(real);
  const name = path.basename(real);
  const sibs = await siblingsOf(dir, cache);
  const kind = kindOf(name);
  let exif: FileMetaResult['exif'] = null;
  let error: string | undefined;
  if (kind === 'image' || kind === 'raw') {
    try {
      // exifr can't open files itself inside the bundled main process: hand it the head of the file
      // (EXIF/XMP live there in JPEG/HEIC/TIFF-based RAWs); retry with more for TIFF layouts that store it further in
      const size = (await stat(real)).size;
      const parse = async (n: number) => (await exifr.parse(Buffer.from(await readHead(real, Math.min(size, n))), { ...EXIFR_OPTIONS, xmp: { parse: false } } as never).catch(() => undefined)) as Record<string, unknown> | undefined;
      let o = await parse(kind === 'raw' || /\.tiff?$/i.test(name) ? 1024 * 1024 : 256 * 1024);
      if (!o?.Make && !o?.DateTimeOriginal && size > 256 * 1024) o = (await parse(Math.min(size, 48 * 1024 * 1024))) ?? o;
      exif = summarizeExif(o ?? null, typeof o?.xmp === 'string' ? o.xmp : undefined, { raw: kind === 'raw' });
    } catch (e) {
      error = `EXIF: ${(e as Error).message}`;
    }
    if (kind === 'image' && (!exif?.width || !exif?.height)) {
      const d = sniffDimensions(await readHead(real, 256 * 1024).catch(() => new Uint8Array()));
      if (d) exif = { ...(exif ?? { source: 'exifr' }), width: d.width, height: d.height };
    }
  }
  const sidecarPath = path.join(dir, sidecarName(name, sibs));
  let sidecar: string | null = null;
  const lower = new Set(sibs);
  for (const c of sidecarReadCandidates(name, sibs)) {
    if (!lower.has(c)) continue;
    try {
      const sc = await guardPath(path.join(dir, c), allRoots());
      sidecar = await readFile(sc, 'utf8');
      break;
    } catch {
      /* unreadable / outside */
    }
  }
  return { path: p, exif, sidecarPath, sidecar, ...(error ? { error } : {}) };
}

async function thumbnail(p: string, size: number): Promise<ThumbResult | null> {
  const real = await guardPath(p, allRoots());
  const kind = kindOf(real);
  if (kind === 'project' || kind === 'other') return null;
  const st = await stat(real);
  const s = Math.max(32, Math.min(2048, Math.round(size)));
  const key = createHash('sha1').update(`${real}\0${st.mtimeMs}\0${st.size}\0${s}`).digest('hex');
  const file = path.join(thumbDir, key.slice(0, 2), key + '.jpg');
  const cached = await readFile(file).catch(() => null);
  if (cached) {
    const img = nativeImage.createFromBuffer(cached);
    const sz = img.getSize();
    return { data: new Uint8Array(cached), mime: 'image/jpeg', width: sz.width, height: sz.height };
  }
  return thumbLimit(async () => {
    if (typeof nativeImage.createThumbnailFromPath !== 'function') return null;
    let img: Electron.NativeImage;
    try {
      img = await nativeImage.createThumbnailFromPath(real, { width: s, height: s });
    } catch {
      return null; // QuickLook has no generator for this file: the renderer decodes it itself
    }
    if (img.isEmpty()) return null;
    const jpg = img.toJPEG(84);
    const sz = img.getSize();
    void mkdir(path.dirname(file), { recursive: true })
      .then(() => writeFile(file, jpg))
      .catch(() => {});
    return { data: new Uint8Array(jpg), mime: 'image/jpeg', width: sz.width, height: sz.height };
  });
}

/** The file's own sidecars (Adobe `<stem>.xmp` when it owns it, `<name>.xmp`). */
async function ownSidecars(real: string): Promise<string[]> {
  const dir = path.dirname(real);
  const name = path.basename(real);
  const sibs = await siblingsOf(dir);
  const own = new Set([sidecarName(name, sibs), `${name}.xmp`]);
  return sibs.filter((s) => own.has(s) && isSidecarName(s)).map((s) => path.join(dir, s));
}

async function writeAtomic(file: string, data: string) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tmp, data, { flag: 'wx' });
  await rename(tmp, file);
}

/** Two-phase rename inside each folder: first to unique temporary names, then to the targets. Never overwrites. */
async function renameMany(pairs: RenamePair[]): Promise<RenameOutcome[]> {
  const out: RenameOutcome[] = [];
  const jobs: { from: string; to: string; tmp: string; sidecars: { from: string; to: string; tmp: string }[]; idx: number }[] = [];
  const taken = new Set<string>();
  for (const [idx, pr] of pairs.entries()) {
    try {
      const from = await guardPath(pr.from, allRoots());
      const name = checkName(pr.to);
      const to = path.join(path.dirname(from), name);
      await guardPath(to, allRoots(), { mustExist: false });
      if (to === from) {
        out[idx] = { from: pr.from, to: from, ok: true };
        continue;
      }
      const key = to.toLowerCase();
      if (taken.has(key)) throw new Error('Two files would get the same name');
      taken.add(key);
      const sidecars = [];
      for (const sc of await ownSidecars(from)) {
        const n = renamedSidecar(path.basename(sc), path.basename(from), name);
        if (n) sidecars.push({ from: sc, to: path.join(path.dirname(from), n), tmp: '' });
      }
      jobs.push({ from, to, tmp: '', sidecars, idx });
    } catch (e) {
      out[idx] = { from: pr.from, to: pr.to, ok: false, error: (e as Error).message };
    }
  }
  const leaving = new Set(jobs.flatMap((j) => [j.from, ...j.sidecars.map((s) => s.from)]).map((p) => p.toLowerCase()));
  // targets that exist and aren't being renamed away are conflicts (the case-only rename of the same file is fine)
  for (const j of jobs) {
    const clash = async (target: string, self: string) => target.toLowerCase() !== self.toLowerCase() && !leaving.has(target.toLowerCase()) && (await exists(target));
    if (await clash(j.to, j.from)) {
      out[j.idx] = { from: j.from, to: j.to, ok: false, error: `“${path.basename(j.to)}” already exists` };
      continue;
    }
    for (const s of j.sidecars) if (await clash(s.to, s.from)) s.to = ''; // keep the sidecar where it is rather than overwrite
  }
  const run = jobs.filter((j) => !out[j.idx]);
  const stamp = `${process.pid}-${Date.now()}`;
  // phase 1: everything to temporary names
  const moved: { tmp: string; from: string }[] = [];
  try {
    for (const [i, j] of run.entries()) {
      j.tmp = path.join(path.dirname(j.from), `.darkroom-rename-${stamp}-${i}${path.extname(j.from)}`);
      await rename(j.from, j.tmp);
      moved.push({ tmp: j.tmp, from: j.from });
      for (const [k, s] of j.sidecars.entries()) {
        if (!s.to) continue;
        s.tmp = path.join(path.dirname(s.from), `.darkroom-rename-${stamp}-${i}-${k}.xmp`);
        await rename(s.from, s.tmp);
        moved.push({ tmp: s.tmp, from: s.from });
      }
    }
  } catch (e) {
    for (const m of moved.reverse()) await rename(m.tmp, m.from).catch(() => {});
    for (const j of run) out[j.idx] = { from: j.from, to: j.to, ok: false, error: `Rename failed, nothing was changed: ${(e as Error).message}` };
    return out;
  }
  // phase 2: temporary → target (re-checked right before each rename: nothing existing is replaced)
  for (const j of run) {
    try {
      if (j.to.toLowerCase() !== j.from.toLowerCase() && (await exists(j.to))) throw new Error(`“${path.basename(j.to)}” appeared meanwhile`);
      await rename(j.tmp, j.to);
      out[j.idx] = { from: j.from, to: j.to, ok: true };
    } catch (e) {
      await rename(j.tmp, j.from).catch(() => {});
      out[j.idx] = { from: j.from, to: j.to, ok: false, error: (e as Error).message };
      for (const s of j.sidecars) if (s.tmp) await rename(s.tmp, s.from).catch(() => {});
      continue;
    }
    for (const s of j.sidecars) {
      if (!s.tmp) continue;
      const ok = !(await exists(s.to));
      await rename(s.tmp, ok ? s.to : s.from).catch(() => {});
    }
  }
  return out;
}

async function transfer(paths: string[], destDir: string, mode: 'move' | 'copy'): Promise<RenameOutcome[]> {
  const dest = await guardPath(destDir, allRoots());
  if (!(await stat(dest)).isDirectory()) throw new Error('Destination is not a folder');
  const out: RenameOutcome[] = [];
  for (const p of paths) {
    try {
      const from = await guardPath(p, allRoots());
      if ((await stat(from)).isDirectory() && mode === 'copy') throw new Error('Copying folders is not supported');
      const items = [from, ...(await ownSidecars(from))];
      const targets = items.map((f) => path.join(dest, path.basename(f)));
      for (const t of targets) await guardPath(t, allRoots(), { mustExist: false });
      if (path.dirname(from) === dest) throw new Error('Already in that folder');
      if (dest === from || dest.startsWith(from + path.sep)) throw new Error('Cannot move a folder into itself');
      if (await exists(targets[0])) throw new Error(`“${path.basename(from)}” already exists in the destination`);
      for (const [i, f] of items.entries()) {
        const t = targets[i];
        if (i > 0 && (await exists(t))) continue; // never overwrite a sidecar there
        if (mode === 'copy') await copyFile(f, t, fsc.COPYFILE_EXCL);
        else {
          try {
            await rename(f, t);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
            // other volume: copy, then put the original in the Trash (never unlinked)
            await copyFile(f, t, fsc.COPYFILE_EXCL);
            await shell.trashItem(f);
          }
        }
      }
      out.push({ from: p, to: targets[0], ok: true });
    } catch (e) {
      out.push({ from: p, to: '', ok: false, error: (e as Error).message });
    }
  }
  return out;
}

// --- watching ---------------------------------------------------------------
const watchers = new Map<number, { w: FSWatcher; sender: Electron.WebContents }>();
let watchSeq = 0;

/** IPC errors arrive in the renderer as "Error invoking remote method …: Error: <message>". */
const wrap =
  <A extends unknown[], R>(f: (...a: A) => Promise<R>) =>
  async (_e: IpcMainInvokeEvent, ...a: A): Promise<R> => {
    try {
      return await f(...a);
    } catch (err) {
      throw new Error((err as Error)?.message ?? String(err));
    }
  };

const rootInfo = (p: string, source: FsRoot['source']): FsRoot => ({ path: p, name: path.basename(p) || p, source });

export function registerFiles() {
  const userData = app.getPath('userData');
  rootsFile = path.join(userData, 'file-roots.json');
  // ~/Library/Caches/darkroom-thumbs (or inside DARKROOM_USER_DATA for isolated test profiles)
  thumbDir = process.env.DARKROOM_USER_DATA
    ? path.join(userData, 'darkroom-thumbs')
    : process.platform === 'darwin'
      ? path.join(app.getPath('home'), 'Library', 'Caches', 'darkroom-thumbs')
      : path.join(app.getPath('temp'), 'darkroom-thumbs');
  void readFile(rootsFile, 'utf8')
    .then((t) => {
      const r = JSON.parse(t) as Partial<RootsState>;
      roots = { granted: [...new Set([...(r.granted ?? []).filter((x) => typeof x === 'string'), ...roots.granted])], hiddenDefaults: (r.hiddenDefaults ?? []).filter((x) => typeof x === 'string') };
    })
    .catch(() => {});

  ipcMain.handle(
    IPC.filesRoots,
    wrap(async () => {
      const g = roots.granted.map((p) => rootInfo(p, 'granted'));
      const d = defaults()
        .filter((p) => !roots.hiddenDefaults.includes(p) && !roots.granted.includes(p))
        .map((p) => rootInfo(p, 'default'));
      return [...d, ...g];
    }),
  );
  ipcMain.handle(
    IPC.filesAddRoot,
    wrap(async () => {
      const forced = process.env.DARKROOM_TEST_DIALOG_PATH?.split(path.delimiter).filter(Boolean)[0]; // test hook, like main's
      const w = BrowserWindow.getFocusedWindow();
      const opts: Electron.OpenDialogOptions = { title: 'Add Folder to Darkroom', buttonLabel: 'Add Folder', properties: ['openDirectory', 'createDirectory'] };
      const r = forced ? { canceled: false, filePaths: [forced] } : w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts);
      if (r.canceled || !r.filePaths[0]) return null;
      const p = path.resolve(r.filePaths[0]);
      if (!(await stat(p)).isDirectory()) throw new Error('Not a folder');
      grantRoot(p);
      roots.hiddenDefaults = roots.hiddenDefaults.filter((x) => x !== p);
      return rootInfo(p, 'granted');
    }),
  );
  ipcMain.handle(
    IPC.filesRemoveRoot,
    wrap(async (p: string) => {
      if (typeof p !== 'string') return;
      roots.granted = roots.granted.filter((x) => x !== p);
      if (defaults().includes(p) && !roots.hiddenDefaults.includes(p)) roots.hiddenDefaults.push(p);
      await saveRoots();
    }),
  );
  ipcMain.handle(
    IPC.filesList,
    wrap(async (dir: string, opts?: { hidden?: boolean }) => {
      const real = await guardPath(dir, allRoots());
      const ents = await readdir(real, { withFileTypes: true });
      const show = ents.filter((d) => (opts?.hidden || !d.name.startsWith('.')) && d.name !== 'Icon\r');
      const out: FsEntry[] = [];
      const CH = 64;
      for (let i = 0; i < show.length; i += CH) {
        const part = await Promise.all(
          show.slice(i, i + CH).map(async (d) => {
            try {
              return entryFrom(dir, d.name, await stat(path.join(real, d.name)));
            } catch {
              return null; // broken symlink, permission
            }
          }),
        );
        for (const e of part) if (e) out.push(e);
      }
      return out;
    }),
  );
  ipcMain.handle(
    IPC.filesStat,
    wrap(async (p: string) => {
      const real = await guardPath(p, allRoots()).catch(() => null);
      if (!real) return null;
      return entryFrom(path.dirname(p), path.basename(p), await stat(real));
    }),
  );
  ipcMain.handle(
    IPC.filesRead,
    wrap(async (p: string, range?: { start: number; length: number }) => {
      const real = await guardPath(p, allRoots());
      if (!range) return new Uint8Array(await readFile(real));
      const fh = await open(real, 'r');
      try {
        const len = Math.max(0, Math.min(Number(range.length) || 0, 512 * 1024 * 1024));
        const buf = Buffer.alloc(len);
        const { bytesRead } = await fh.read(buf, 0, len, Math.max(0, Number(range.start) || 0));
        return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
      } finally {
        await fh.close();
      }
    }),
  );
  ipcMain.handle(IPC.filesThumb, wrap((p: string, size: number) => thumbnail(p, Number(size) || 256)));
  ipcMain.handle(
    IPC.filesMeta,
    wrap(async (paths: string[]) => {
      if (!Array.isArray(paths)) throw new Error('bad paths');
      const cache = new Map<string, string[]>();
      return Promise.all(paths.slice(0, 2000).map((p) => metaLimit(() => fileMeta(String(p), cache))));
    }),
  );
  ipcMain.handle(
    IPC.filesWriteXmp,
    wrap(async (p: string, data: XmpData) => {
      const real = await guardPath(p, allRoots());
      if (isSidecarName(real)) throw new Error('Not an image');
      const dir = path.dirname(real);
      const name = path.basename(real);
      const sibs = await siblingsOf(dir);
      const target = await guardPath(path.join(dir, sidecarName(name, sibs)), allRoots(), { mustExist: false });
      const existing = await readFile(target, 'utf8').catch(() => null);
      const clean: XmpData = {
        rating: typeof data?.rating === 'number' ? data.rating : undefined,
        label: typeof data?.label === 'string' ? data.label : undefined,
        keywords: Array.isArray(data?.keywords) ? data.keywords.filter((k) => typeof k === 'string').slice(0, 500) : undefined,
        title: typeof data?.title === 'string' ? data.title : undefined,
        description: typeof data?.description === 'string' ? data.description : undefined,
        creator: typeof data?.creator === 'string' ? data.creator : undefined,
        copyright: typeof data?.copyright === 'string' ? data.copyright : undefined,
      };
      await writeAtomic(target, writeXmp(existing, clean));
      return target;
    }),
  );
  ipcMain.handle(IPC.filesRename, wrap((pairs: RenamePair[]) => renameMany(Array.isArray(pairs) ? pairs : [])));
  ipcMain.handle(IPC.filesTransfer, wrap((paths: string[], dest: string, mode: 'move' | 'copy') => transfer(Array.isArray(paths) ? paths : [], dest, mode === 'copy' ? 'copy' : 'move')));
  ipcMain.handle(
    IPC.filesTrash,
    wrap(async (paths: string[]) => {
      const out: RenameOutcome[] = [];
      for (const p of Array.isArray(paths) ? paths : []) {
        try {
          const real = await guardPath(p, allRoots());
          if (allRoots().some((r) => path.resolve(r) === real)) throw new Error('A favourite root folder can’t be moved to the Trash here');
          const sc = await ownSidecars(real);
          await shell.trashItem(real);
          for (const s of sc) await shell.trashItem(s).catch(() => {});
          out.push({ from: p, to: '', ok: true });
        } catch (e) {
          out.push({ from: p, to: '', ok: false, error: (e as Error).message });
        }
      }
      return out;
    }),
  );
  ipcMain.on(IPC.filesReveal, (_e, p: string) => {
    void guardPath(p, allRoots())
      .then((real) => shell.showItemInFolder(real))
      .catch((e) => console.warn('[darkroom files] reveal refused', (e as Error).message));
  });
  ipcMain.handle(
    IPC.filesOpenDefault,
    wrap(async (p: string) => {
      const real = await guardPath(p, allRoots());
      return shell.openPath(real); // '' on success, else an error string
    }),
  );
  ipcMain.handle(
    IPC.filesMkdir,
    wrap(async (parent: string, name: string) => {
      const dir = await guardPath(parent, allRoots());
      const target = await guardPath(path.join(dir, checkName(name)), allRoots(), { mustExist: false });
      await mkdir(target); // fails if it exists
      return path.join(parent, path.basename(target));
    }),
  );
  ipcMain.handle(IPC.filesWatch, async (ev, dir: string) => {
    try {
      const real = await guardPath(dir, allRoots());
      const e = ev.sender;
      const id = ++watchSeq;
      let timer: NodeJS.Timeout | undefined;
      let names = new Set<string>();
      const w = watch(real, { persistent: false }, (_ev, file) => {
        if (file) names.add(String(file));
        clearTimeout(timer);
        timer = setTimeout(() => {
          const n = [...names];
          names = new Set();
          const rec = watchers.get(id);
          if (rec && !rec.sender.isDestroyed()) rec.sender.send(IPC.filesChanged, { dir, names: n });
        }, 350);
      });
      w.on('error', () => {
        w.close();
        watchers.delete(id);
      });
      watchers.set(id, { w, sender: e });
      e.once('destroyed', () => {
        w.close();
        watchers.delete(id);
      });
      return id;
    } catch (err) {
      throw new Error((err as Error)?.message ?? String(err));
    }
  });
  ipcMain.on(IPC.filesUnwatch, (_e, id: number) => {
    watchers.get(id)?.w.close();
    watchers.delete(id);
  });
}

