/**
 * Path guard for the file browser IPC (electron/files/ipc.ts). Every path that comes from the
 * renderer is resolved (`..` collapsed, symlinks followed with realpath) and must end up inside
 * one of the roots the user granted (folder picker, Finder open, or the default
 * ~/Pictures, ~/Desktop, ~/Downloads). Anything else is rejected before touching the disk.
 */
import { realpath as fsRealpath } from 'node:fs/promises';
import path from 'node:path';

export class PathDenied extends Error {
  constructor(p: unknown, why = 'outside the folders you gave Darkroom access to') {
    super(`Access denied: ${typeof p === 'string' ? p : '(invalid path)'} is ${why}`);
    this.name = 'PathDenied';
  }
}

/** True if `p` is `root` or below it (both absolute and already normalised/real). */
export function isWithin(p: string, root: string): boolean {
  const rel = path.relative(root, p);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

type Realpath = (p: string) => Promise<string>;

/** Real path of an existing path, or of its parent + basename for a path that doesn't exist (yet). */
async function realOrParent(abs: string, realpath: Realpath): Promise<{ real: string; exists: boolean }> {
  try {
    return { real: await realpath(abs), exists: true };
  } catch {
    const base = path.basename(abs);
    if (!base || base === '.' || base === '..') throw new PathDenied(abs, 'not a valid file name');
    return { real: path.join(await realpath(path.dirname(abs)), base), exists: false };
  }
}

/**
 * Validate a renderer-supplied path. Resolves to the real path, or throws PathDenied.
 * `mustExist: false` allows a not-yet-existing final component (rename/copy/mkdir targets);
 * its parent must exist and be inside a root.
 */
export async function guardPath(p: unknown, roots: Iterable<string>, opts: { mustExist?: boolean } = {}, realpath: Realpath = fsRealpath): Promise<string> {
  if (typeof p !== 'string' || !p || p.includes('\0') || !path.isAbsolute(p)) throw new PathDenied(p, 'not an absolute path');
  const abs = path.resolve(p);
  let r: { real: string; exists: boolean };
  try {
    r = await realOrParent(abs, realpath);
  } catch (e) {
    if (e instanceof PathDenied) throw e;
    throw new PathDenied(p, 'not reachable (missing parent folder)');
  }
  if (opts.mustExist !== false && !r.exists) throw new PathDenied(p, 'missing');
  const realRoots: string[] = [];
  for (const root of roots) {
    try {
      realRoots.push(await realpath(path.resolve(root)));
    } catch {
      /* a root that no longer exists grants nothing */
    }
  }
  if (!realRoots.some((root) => isWithin(r.real, root))) throw new PathDenied(p);
  return r.real;
}

/** A single new file/folder name from the renderer: no separators, no `..`, nothing hidden by accident. */
export function checkName(name: unknown): string {
  if (typeof name !== 'string') throw new Error('Invalid name');
  const n = name.trim();
  if (!n || n === '.' || n === '..' || /[/\\\0:]/.test(n) || n.length > 255) throw new Error(`Invalid file name “${String(name)}”`);
  return n;
}
