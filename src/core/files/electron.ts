/** Electron backend: a thin wrapper around window.darkroomNative.files (electron/files/ipc.ts). */
import type { FilesApi } from '../../native/api';
import type { FsBackend } from './backend';
import { MIME_BY_EXT, extOfName } from './kinds';
import { RAW_FORMATS } from '../raw/formats';
import type { FsChange } from './types';

const clean = (e: unknown) => new Error(String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));

export function electronBackend(api: FilesApi): FsBackend {
  const subs = new Map<string, Set<(names: string[]) => void>>();
  api.onChange((c: FsChange) => subs.get(c.dir)?.forEach((f) => f(c.names)));
  const call =
    <A extends unknown[], R>(f: (...a: A) => Promise<R>) =>
    async (...a: A): Promise<R> => {
      try {
        return await f(...a);
      } catch (e) {
        throw clean(e);
      }
    };
  return {
    kind: 'electron',
    caps: api.caps,
    roots: call(() => api.roots()),
    addRoot: call(() => api.addRoot()),
    removeRoot: call((p: string) => api.removeRoot(p)),
    list: call((d: string, o?: { hidden?: boolean }) => api.list(d, o)),
    stat: call((p: string) => api.stat(p)),
    read: call((p: string, r?: { start: number; length: number }) => api.read(p, r)),
    async file(p) {
      const data = await call(() => api.read(p))();
      const name = p.split('/').pop() ?? 'file';
      const ext = extOfName(name);
      return new File([data as Uint8Array<ArrayBuffer>], name, { type: MIME_BY_EXT[ext] ?? RAW_FORMATS[ext] ?? '' });
    },
    thumb: call((p: string, s: number) => api.thumb(p, s)),
    meta: call((ps: string[]) => api.meta(ps)),
    writeXmp: call((p, d) => api.writeXmp(p, d)),
    rename: call((pairs) => api.rename(pairs)),
    transfer: call((ps, d, m) => api.transfer(ps, d, m)),
    trash: call((ps) => api.trash(ps)),
    reveal: (p) => api.reveal(p),
    async openDefault(p) {
      const err = await call(() => api.openDefault(p))();
      if (err) throw new Error(err);
    },
    mkdir: call((parent, name) => api.mkdir(parent, name)),
    watch(dir, cb) {
      let set = subs.get(dir);
      if (!set) subs.set(dir, (set = new Set()));
      set.add(cb);
      let id = 0;
      let dead = false;
      void api
        .watch(dir)
        .then((i) => (dead ? api.unwatch(i) : (id = i)))
        .catch((e) => console.warn('[darkroom files] could not watch', dir, clean(e).message));
      return () => {
        dead = true;
        set!.delete(cb);
        if (id) api.unwatch(id);
      };
    },
    displayPath: (p) => p,
  };
}
