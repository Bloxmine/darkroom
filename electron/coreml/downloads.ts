/**
 * Core ML model downloads (Electron main): only curated catalog items (src/core/sd/coreml-catalog.ts), only after
 * the renderer confirms the user accepted the licence, into Darkroom's own models folder. Runs in main, so Hugging
 * Face's CORS rules don't matter; progress goes to the renderer as `download` events. Resumable (see zipfetch.ts).
 */
import path from 'node:path';
import { catalogInstallPath, catalogItem, catalogSelect, hfResolve } from '../../src/core/sd/coreml-catalog';
import type { CoreMLEvent } from '../../src/native/api';
import { extractZip } from './zipfetch';

export class CoreMLDownloads {
  private active = new Map<string, AbortController>();

  constructor(
    private modelsDir: string,
    private emit: (e: CoreMLEvent) => void,
  ) {}

  isActive(id: string) {
    return this.active.has(id);
  }

  async download(id: string, licenseAccepted: unknown): Promise<void> {
    const item = catalogItem(String(id));
    if (!item) throw new Error(`Unknown Core ML download “${id}”.`);
    if (licenseAccepted !== true) throw new Error(`Accept the ${item.license} licence to download this model.`);
    if (this.active.has(item.id)) throw new Error('This model is already downloading.');
    const ctl = new AbortController();
    this.active.set(item.id, ctl);
    const dest = path.join(this.modelsDir, catalogInstallPath(item));
    let last = { done: 0, total: item.bytes };
    try {
      this.emit({ type: 'download', id: item.id, state: 'downloading', done: 0, total: item.bytes });
      await extractZip({
        url: hfResolve(item),
        dest,
        select: catalogSelect(item),
        signal: ctl.signal,
        onProgress: (done, total, file) => {
          last = { done, total };
          this.emit({ type: 'download', id: item.id, state: 'downloading', done, total, file });
        },
      });
      this.emit({ type: 'download', id: item.id, state: 'done', ...last, done: last.total });
    } catch (e) {
      const cancelled = ctl.signal.aborted;
      this.emit({ type: 'download', id: item.id, state: cancelled ? 'cancelled' : 'error', ...last, error: cancelled ? undefined : String((e as Error)?.message ?? e) });
      throw cancelled ? new Error('Download cancelled (it resumes where it stopped next time).') : e;
    } finally {
      this.active.delete(item.id);
    }
  }

  cancel(id: string) {
    this.active.get(String(id))?.abort();
  }

  cancelAll() {
    for (const c of this.active.values()) c.abort();
  }
}
