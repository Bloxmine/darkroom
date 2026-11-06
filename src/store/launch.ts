/**
 * Files arriving from outside the editor: the PWA share target (POST
 * /share-target, stashed by public/share-target-sw.js), OS file handlers
 * (`window.launchQueue`) and the Electron shell. One photo is imported into
 * the current graph in place of the current input; several open the Batch
 * dialog pre-filled; .darkroom files open as projects.
 */
import { connect, OUTPUT } from '../core/graph';
import { defaultSourceNode } from '../core/batch/graphInput';
import { isImportableImage, isProjectFile } from '../core/raw/formats';
import { commitGraph, outputNodeId, setPath, setViewed, useDoc } from './doc';
import { importImageFiles, loadProject, validateProject } from './io';
import { openBatch } from './batch';
import { status } from './ui';

/**
 * Import one photo into the root graph and wire it like the starter project:
 * it takes over the outgoing connections of the current input image (or feeds
 * the Output directly when there is none).
 */
export async function importAndWire(file: File): Promise<string | undefined> {
  setPath([]);
  const before = useDoc.getState().project;
  const prev = defaultSourceNode(before.graph, outputNodeId(before));
  const [id] = await importImageFiles([file]);
  if (!id) return undefined;
  const out = outputNodeId(useDoc.getState().project);
  commitGraph((g) => {
    const old = prev && !prev.includes('/') ? g.nodes.find((n) => n.id === prev) : undefined;
    if (old) {
      // take over the old input's connections and its place on the canvas; the old input is removed (undoable)
      const nodes = g.nodes.filter((n) => n.id !== old.id).map((n) => (n.id === id ? { ...n, position: { ...old.position } } : n));
      let ng = { ...g, nodes, edges: g.edges.filter((e) => e.to.node !== old.id) };
      for (const e of g.edges.filter((e) => e.from.node === old.id)) ng = connect(ng, { node: id, port: e.from.port }, e.to);
      ng = { ...ng, edges: ng.edges.filter((e) => e.from.node !== old.id) };
      return ng;
    }
    const o = g.nodes.find((n) => n.id === out) ?? g.nodes.find((n) => n.type === OUTPUT);
    return o ? connect(g, { node: id, port: 'out' }, { node: o.id, port: 'image' }) : g;
  });
  setViewed(null);
  return id;
}

/** Route a set of incoming files: project → open; 1 image → import & wire; many → Batch dialog. */
export async function handleIncomingFiles(files: File[], source = 'shared') {
  const proj = files.find((f) => isProjectFile(f.name));
  if (proj) {
    try {
      const p = validateProject(JSON.parse(await proj.text()));
      if (!p.name || p.name === 'Untitled') p.name = proj.name.replace(/\.(darkroom|json)$/i, '');
      await loadProject(p);
      status(`Opened ${proj.name}`);
    } catch (e) {
      status(`Could not open ${proj.name}: ${(e as Error).message}`, 'error');
    }
  }
  const imgs = files.filter((f) => isImportableImage(f.name, f.type));
  const skipped = files.filter((f) => f !== proj && !imgs.includes(f));
  if (skipped.length) status(`Ignored ${skipped.length} unsupported ${source} file(s): ${skipped.map((f) => f.name).join(', ')}`, 'error');
  if (imgs.length === 1) await importAndWire(imgs[0]);
  else if (imgs.length > 1) openBatch(imgs);
}

// ---------------------------------------------------------------------------
// PWA entry points
// ---------------------------------------------------------------------------

/** Cache Storage bucket written by public/share-target-sw.js. */
export const SHARE_CACHE = 'darkroom-share-target';

/** Files stashed by the service worker for a POST /share-target (removed once read). */
export async function takeSharedFiles(): Promise<File[]> {
  if (typeof caches === 'undefined') return [];
  const cache = await caches.open(SHARE_CACHE);
  const reqs = await cache.keys();
  const files: File[] = [];
  for (const req of [...reqs].sort((a, b) => a.url.localeCompare(b.url, undefined, { numeric: true }))) {
    const res = await cache.match(req);
    await cache.delete(req);
    if (!res) continue;
    const name = decodeURIComponent(res.headers.get('x-file-name') ?? '') || req.url.split('/').pop() || 'shared';
    files.push(new File([await res.blob()], name, { type: res.headers.get('content-type') ?? '', lastModified: Number(res.headers.get('x-last-modified')) || Date.now() }));
  }
  return files;
}

interface LaunchParams {
  files?: { kind: string; getFile(): Promise<File> }[];
}

let launchInited = false;
/** Wire the share target (`/?share-target=1`) and OS file handlers (`window.launchQueue`). Call once at startup. */
export function initLaunch(booted: Promise<unknown>) {
  if (launchInited) return;
  launchInited = true;
  const lq = (window as unknown as { launchQueue?: { setConsumer(cb: (p: LaunchParams) => void): void } }).launchQueue;
  lq?.setConsumer((params) => {
    if (!params.files?.length) return;
    void (async () => {
      await booted;
      const files = await Promise.all(params.files!.filter((h) => h.kind !== 'directory').map((h) => h.getFile()));
      await handleIncomingFiles(files, 'opened');
    })();
  });
  const q = new URLSearchParams(location.search);
  if (q.has('share-target')) {
    const failed = q.get('share-target') === 'error';
    history.replaceState(history.state, '', location.pathname + location.hash);
    void booted.then(async () => {
      if (failed) return status('Sharing to Darkroom failed — the files could not be received.', 'error');
      const files = await takeSharedFiles();
      if (!files.length) return status('Nothing was shared (no files received).', 'error');
      await handleIncomingFiles(files, 'shared');
    });
  }
}
