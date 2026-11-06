/**
 * Batch processing: run the current graph over many files. The user's
 * document is never touched: each file is swapped into a CLONED graph and
 * rendered at full resolution by a separate offscreen Engine (own WebGL
 * context and cache), so the interactive preview cache survives. Assets,
 * textures and RAW decodes are released after every file.
 */
import { create } from 'zustand';
import { strToU8, Zip, ZipPassThrough } from 'fflate';
import { uid, GROUP, clone } from '../core/graph';
import { Engine } from '../core/engine';
import { loadAsset } from '../core/assets';
import { renderReady } from '../core/batch/ready';
import { defaultSourceNode, swapSourceAsset } from '../core/batch/graphInput';
import { DEFAULT_PATTERN, expandPattern, fitLongEdge, sanitizeFileName, uniqueNames } from '../core/batch/naming';
import { forgetRaw } from '../core/raw/decoder';
import { isImportableImage, isRawFile } from '../core/raw/formats';
import { loadRawAssetEphemeral } from '../core/raw/rawAsset';
import type { Asset, Graph, Project } from '../core/types';
import { outputNodeId, useDoc } from './doc';
import { engine as mainEngine } from './engine';
import { EXT, type ExportType } from './io';
import { openDialog, status } from './ui';

export type BatchStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

export interface BatchItem {
  id: string;
  file: File;
  /** Relative path for folder picks (display only). */
  path: string;
  status: BatchStatus;
  error?: string;
  outName?: string;
  /** Object URL of a small preview of the result. */
  thumb?: string;
  size?: number;
  width?: number;
  height?: number;
  ms?: number;
}

export interface BatchSettings {
  type: ExportType;
  quality: number;
  /** Long edge in px; 0 = 100 %. */
  longEdge: number;
  pattern: string;
  dest: 'zip' | 'folder';
  /** Flat id of the Image/RAW node that receives each file ('' = default). */
  input: string;
}

interface BatchState {
  items: BatchItem[];
  settings: BatchSettings;
  running: boolean;
  startedAt: number;
  finishedAt: number;
  /** Where the results went (for the summary line). */
  result: string;
}

export const useBatch = create<BatchState>(() => ({
  items: [],
  settings: { type: 'image/jpeg', quality: 0.9, longEdge: 0, pattern: DEFAULT_PATTERN, dest: 'zip', input: '' },
  running: false,
  startedAt: 0,
  finishedAt: 0,
  result: '',
}));

const patchItem = (id: string, p: Partial<BatchItem>) => useBatch.setState((s) => ({ items: s.items.map((it) => (it.id === id ? { ...it, ...p } : it)) }));

/** Add files to the batch queue (unsupported files are skipped with a message). */
export function addBatchFiles(files: File[]) {
  const ok = files.filter((f) => isImportableImage(f.name, f.type));
  const bad = files.length - ok.length;
  if (bad) status(`Skipped ${bad} file(s) that are not images or RAW photos.`, 'error');
  const s = useBatch.getState();
  if (s.running) return;
  const keep = s.finishedAt ? [] : s.items; // a finished run is cleared when new files arrive
  if (s.finishedAt) clearThumbs(s.items);
  const items = ok.map((file): BatchItem => ({ id: uid('b'), file, path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name, status: 'queued' }));
  useBatch.setState({ items: [...keep, ...items], finishedAt: 0, result: '' });
}

export function removeBatchItem(id: string) {
  if (useBatch.getState().running) return;
  useBatch.setState((s) => ({ items: s.items.filter((i) => i.id !== id) }));
}

export function clearBatch() {
  const s = useBatch.getState();
  if (s.running) return;
  clearThumbs(s.items);
  useBatch.setState({ items: [], finishedAt: 0, result: '' });
}

function clearThumbs(items: BatchItem[]) {
  for (const i of items) if (i.thumb) URL.revokeObjectURL(i.thumb);
}

export const setBatchSettings = (p: Partial<BatchSettings>) => useBatch.setState((s) => ({ settings: { ...s.settings, ...p } }));

/** Open File › Batch Process…, optionally pre-filled. */
export function openBatch(files: File[] = []) {
  if (files.length) addBatchFiles(files);
  openDialog('batch');
}

/** Name for the {preset} token: the first group/preset feeding the output, else the project name. */
export function presetName(p: Project): string {
  const out = outputNodeId(p);
  const byId = new Map(p.graph.nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  let frontier = out ? [out] : [];
  while (frontier.length) {
    const next: string[] = [];
    for (const id of frontier) {
      if (seen.has(id)) continue;
      seen.add(id);
      const n = byId.get(id);
      if (n?.type === GROUP) return sanitizeFileName(n.label || n.group?.name || 'preset');
      next.push(...p.graph.edges.filter((e) => e.to.node === id).map((e) => e.from.node));
    }
    frontier = next;
  }
  return sanitizeFileName(p.name || 'darkroom');
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

let abort: AbortController | null = null;
let batchEngine: Engine | null = null;

/** A separate engine on an OffscreenCanvas (own WebGL context); falls back to the main engine. */
function getBatchEngine(): { eng: Engine; shared: boolean } {
  if (!batchEngine) {
    try {
      batchEngine = new Engine(new OffscreenCanvas(1, 1));
    } catch (e) {
      console.warn('[darkroom] batch: no second WebGL context, sharing the viewer engine', e);
      return { eng: mainEngine, shared: true };
    }
  }
  return { eng: batchEngine, shared: false };
}

function disposeBatchEngine() {
  if (!batchEngine) return;
  batchEngine.dispose();
  (batchEngine.gl.gl.getExtension('WEBGL_lose_context') as { loseContext(): void } | null)?.loseContext();
  batchEngine = null;
}

export const cancelBatch = () => abort?.abort();

async function loadBatchAsset(f: File): Promise<Asset> {
  // RAWs are decoded in memory only (not written to IndexedDB like interactive imports)
  return isRawFile(f.name, f.type) ? loadRawAssetEphemeral(f, f.name, uid('ab')) : loadAsset(f, f.name, uid('ab'));
}

async function thumbOf(blob: Blob): Promise<string | undefined> {
  try {
    const bmp = await createImageBitmap(blob, { resizeHeight: 72, resizeQuality: 'medium' });
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    c.getContext('2d')!.drawImage(bmp, 0, 0);
    bmp.close();
    return URL.createObjectURL(await c.convertToBlob({ type: 'image/jpeg', quality: 0.7 }));
  } catch {
    return undefined;
  }
}

interface DirHandle {
  name: string;
  getFileHandle(name: string, o: { create: boolean }): Promise<{ createWritable(): Promise<{ write(b: Blob): Promise<void>; close(): Promise<void> }> }>;
}
export const canPickDirectory = () => typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';

export interface BatchRunResult {
  zip?: Blob;
  zipName?: string;
  done: number;
  failed: number;
}

/**
 * Process every queued item. For dest = 'folder' this must be called from a
 * user gesture (it opens the directory picker first). Resolves with the ZIP
 * (dest = 'zip'); `download` controls whether it is also downloaded.
 */
export async function runBatch(opts: { download?: boolean } = {}): Promise<BatchRunResult> {
  const st = useBatch.getState();
  if (st.running) throw new Error('A batch is already running.');
  const settings = st.settings;
  const doc = useDoc.getState();
  const project = doc.project;
  const graph: Graph = clone(project.graph); // never touch the user's document
  const outId = outputNodeId(project);
  const inputId = settings.input || defaultSourceNode(graph, outId);
  if (!outId) throw new Error('This project has no Output node.');
  if (!inputId) throw new Error('Add an Image or RAW node to the graph to use as the batch input.');

  let dir: DirHandle | null = null;
  if (settings.dest === 'folder') {
    dir = await (window as unknown as { showDirectoryPicker(o: object): Promise<DirHandle> }).showDirectoryPicker({ mode: 'readwrite', id: 'darkroom-batch' });
  }

  abort = new AbortController();
  const signal = abort.signal;
  const queue = useBatch.getState().items.filter((i) => i.status !== 'done');
  useBatch.setState((s) => ({ running: true, startedAt: Date.now(), finishedAt: 0, result: '', items: s.items.map((i) => (i.status === 'done' ? i : { ...i, status: 'queued', error: undefined })) }));

  const preset = presetName(project);
  const ext = EXT[settings.type];
  const date = new Date();
  const used: string[] = useBatch.getState().items.filter((i) => i.status === 'done' && i.outName).map((i) => i.outName!);

  // ZIP stream: entries are added as they finish so each result blob can be released
  const chunks: Uint8Array[] = [];
  let zipErr: Error | null = null;
  let zipFinal = false;
  const zip: Zip | null = dir
    ? null
    : new Zip((err, chunk, final) => {
        if (err) zipErr = err;
        else chunks.push(chunk);
        if (final) zipFinal = true;
      });

  const { eng, shared } = getBatchEngine();
  let done = 0;
  let failed = 0;
  const added: string[] = [];
  try {
    for (const [idx, item] of queue.entries()) {
      if (signal.aborted) {
        patchItem(item.id, { status: 'cancelled' });
        continue;
      }
      patchItem(item.id, { status: 'running' });
      const t0 = performance.now();
      let asset: Asset | null = null;
      try {
        asset = await loadBatchAsset(item.file);
        // the batch engine sees every project asset (LUTs, overlays…) plus this file
        if (!shared) for (const [k, a] of mainEngine?.assets ?? []) if (!eng.assets.has(k)) eng.assets.set(k, a);
        eng.assets.set(asset.id, asset);
        const g = swapSourceAsset(graph, inputId, asset.id, !!asset.raw);
        // resize: assume the output scales with the input, then correct with the measured size
        let scale = settings.longEdge && asset.width && asset.height ? fitLongEdge(asset.width, asset.height, settings.longEdge).scale : 1;
        let r = await renderReady(eng, g, { nodeId: outId, scale }, { signal });
        if (settings.longEdge && r.fullWidth) {
          const want = fitLongEdge(r.fullWidth, r.fullHeight, settings.longEdge).scale;
          if (Math.abs(want - scale) > 1e-3) {
            scale = want;
            r = await renderReady(eng, g, { nodeId: outId, scale }, { signal });
          }
        }
        if (!r.tex) throw new Error(eng.errors.size ? [...eng.errors.values()][0] : 'Nothing rendered — is the input connected to the Output?');
        const blob = await eng.export(g, { nodeId: outId, type: settings.type, quality: settings.quality, scale });
        const base = expandPattern(settings.pattern, { name: item.file.name, preset, index: idx + 1, date, width: r.width, height: r.height });
        const name = uniqueNames([...used, `${base}.${ext}`]).pop()!;
        used.push(name);
        if (dir) {
          const fh = await dir.getFileHandle(name, { create: true });
          const w = await fh.createWritable();
          await w.write(blob);
          await w.close();
        } else {
          const entry = new ZipPassThrough(name);
          entry.mtime = date;
          zip!.add(entry);
          entry.push(new Uint8Array(await blob.arrayBuffer()), true);
          added.push(name);
        }
        const thumb = await thumbOf(blob);
        patchItem(item.id, { status: 'done', outName: name, size: blob.size, width: r.width, height: r.height, ms: performance.now() - t0, thumb });
        done++;
      } catch (e) {
        const cancelled = (e as Error)?.name === 'AbortError';
        patchItem(item.id, cancelled ? { status: 'cancelled' } : { status: 'error', error: String((e as Error)?.message ?? e) });
        if (!cancelled) failed++;
      } finally {
        // keep memory bounded: drop this file's asset, its RAW decodes and every texture
        if (asset) {
          eng.assets.delete(asset.id);
          forgetRaw(asset.id);
          asset.image?.close();
        }
        if (!shared) eng.clearCache();
      }
    }
  } finally {
    if (shared) mainEngine?.clearCache();
    disposeBatchEngine();
    abort = null;
  }

  let zipBlob: Blob | undefined;
  let zipName: string | undefined;
  if (zip) {
    if (!added.length) {
      // an empty archive still needs a valid end record
      const e = new ZipPassThrough('README.txt');
      zip.add(e);
      e.push(strToU8('No files were processed.'), true);
    }
    zip.end(); // ZipPassThrough is synchronous: every chunk has been emitted now
    if (zipErr) throw zipErr;
    if (!zipFinal) throw new Error('ZIP stream did not finish.');
    zipBlob = new Blob(chunks as BlobPart[], { type: 'application/zip' });
    zipName = `${sanitizeFileName(preset)}_batch.zip`;
    if (opts.download !== false && added.length) download(zipBlob, zipName);
  }
  const where = dir ? `folder “${dir.name}”` : zipName ?? '';
  useBatch.setState({ running: false, finishedAt: Date.now(), result: added.length || dir ? `${done} file(s) → ${where}` : '' });
  status(`Batch: ${done} done${failed ? `, ${failed} failed` : ''}${signal.aborted ? ' (cancelled)' : ''}.`, failed ? 'error' : 'info');
  return { zip: zipBlob, zipName, done, failed };
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
