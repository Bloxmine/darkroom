/**
 * The file browser's file-system interface. Two implementations:
 *   - Electron (electron.ts): window.darkroomNative.files — IPC to main, every path checked
 *     against the folders the user granted;
 *   - web (web.ts): the File System Access API (Chromium) with directory handles persisted in
 *     IndexedDB, or — in browsers without it — a read-only list of files picked with "Open files…".
 * Paths use '/' everywhere: absolute paths in the Mac app, `/<rootId>/a/b.jpg` on the web.
 */
import type { FileMetaResult, FsCaps, FsEntry, FsRoot, RenameOutcome, RenamePair, ThumbResult } from './types';
import type { XmpData } from './xmp';

export interface FsBackend {
  kind: 'electron' | 'web' | 'files';
  caps: FsCaps;
  roots(): Promise<FsRoot[]>;
  addRoot(): Promise<FsRoot | null>;
  removeRoot(path: string): Promise<void>;
  /** Web: re-request access to a remembered folder (needs a user gesture). */
  requestPermission?(root: string): Promise<boolean>;
  list(dir: string, opts?: { hidden?: boolean }): Promise<FsEntry[]>;
  stat(path: string): Promise<FsEntry | null>;
  read(path: string, range?: { start: number; length: number }): Promise<Uint8Array>;
  /** A File for the import paths (src/store/io.ts). */
  file(path: string): Promise<File>;
  /** Native thumbnail (QuickLook), when the backend has one. */
  thumb?(path: string, size: number): Promise<ThumbResult | null>;
  meta(paths: string[]): Promise<FileMetaResult[]>;
  writeXmp(path: string, data: XmpData): Promise<string>;
  rename(pairs: RenamePair[]): Promise<RenameOutcome[]>;
  transfer(paths: string[], destDir: string, mode: 'move' | 'copy'): Promise<RenameOutcome[]>;
  trash(paths: string[]): Promise<RenameOutcome[]>;
  reveal(path: string): void;
  openDefault(path: string): Promise<void>;
  mkdir(parent: string, name: string): Promise<string>;
  /** Watch a folder; `cb` gets the changed names (may be empty). Returns an unsubscribe function. */
  watch(dir: string, cb: (names: string[]) => void): () => void;
  /** Human-readable location of a path (for Copy Path / tooltips). */
  displayPath(path: string): string;
}

export const dirname = (p: string) => {
  const i = p.replace(/\/+$/, '').lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
};
export const basename = (p: string) => p.replace(/\/+$/, '').split('/').pop() ?? p;
export const joinPath = (dir: string, name: string) => (dir.endsWith('/') ? dir + name : `${dir}/${name}`);
