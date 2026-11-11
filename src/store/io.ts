import { assetFromDataUrl, assetFromUrl, loadAsset } from '../core/assets';
import { connect, createNode, getPorts, IMAGE, OUTPUT } from '../core/graph';
import { buildNode } from './actions';
import { getPreset } from '../core/registry';
import type { Asset, Graph, Project } from '../core/types';
import { setSelection } from './doc';
import { commitGraph, commitProject, emptyProject, markSaved, outputNodeId, setProject, useDoc } from './doc';
import { engine, previewScale, requestRender, resetRenderSize, suspendRender } from './engine';
import { status, useUi } from './ui';
import { useSettings } from './settings';
import { exportBaseName } from './exportName';
import { projectForSave, registerProjectTypes } from './extensions';
import { native } from '../native/native';
import * as desktop from '../native/files';
import { IMPORT_ACCEPT, isImportableImage, isRawFile, RAW } from '../core/raw/formats';
import { embedRawAssets, scheduleRawGc } from '../core/raw/rawAsset';
import { embedVideoAssets, isVideoFile } from '../core/videoAssets';
import { importVideoFiles } from './videoImport';
import { renderReady } from '../core/batch/ready';
import { buildLutGraph, writeCube } from '../nodes/pro/lut-export';
import { flatId } from './graphPath';

const serial = (a: Asset) => ({ id: a.id, name: a.name, mime: a.mime, dataUrl: a.dataUrl });

/** Register a decoded asset with the engine and the project. */
export function addAsset(a: Asset, record = true) {
  engine?.addAsset(a);
  if (record) commitProject((p) => ({ ...p, assets: { ...p.assets, [a.id]: serial(a) } }), { silent: true });
}

/** Decode and register all assets embedded in a project. */
export async function hydrateAssets(p: Project) {
  const list = Object.values(p.assets ?? {});
  const res = await Promise.allSettled(list.map((s) => assetFromDataUrl(s)));
  res.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      engine?.addAsset(r.value);
      if (r.value.raw) list[i].dataUrl = r.value.dataUrl; // embedded RAW moved to IndexedDB: keep autosaves small
    } else console.warn('[darkroom] could not load asset', list[i].name, r.reason);
  });
}

export function validateProject(x: unknown): Project {
  const p = x as Project;
  if (!p || typeof p !== 'object' || !p.graph || !Array.isArray(p.graph.nodes) || !Array.isArray(p.graph.edges)) throw new Error('Not a Darkroom project file.');
  return { version: 1, name: p.name ?? 'Untitled', graph: p.graph, assets: p.assets ?? {}, outputNode: p.outputNode, customNodes: p.customNodes, plugins: p.plugins, timeline: p.timeline };
}

export async function loadProject(p: Project, opts: { viewed?: string | null; dirty?: boolean } = {}) {
  const typeMsgs = registerProjectTypes(p); // embedded custom node types
  await hydrateAssets(p);
  engine?.clearCache();
  resetRenderSize();
  setProject(p, opts);
  scheduleRawGc(() => Object.keys(useDoc.getState().project.assets ?? {}));
  useUi.setState({ fit: true });
  requestRender();
  if (typeMsgs.length) setTimeout(() => status(typeMsgs.join(' ')), 50); // after the caller's "Opened…"
}

export function serializeProject(): string {
  // RAW assets live in IndexedDB; embed them so the .darkroom file is self-contained
  const r = embedRawAssets(embedVideoAssets(projectForSave(useDoc.getState().project)), (id) => engine?.assets.get(id));
  if (r.missing.length) setTimeout(() => status(`Not embedded (RAW data missing): ${r.missing.join(', ')}`, 'error'), 50);
  else if (r.rawBytes > 25e6) setTimeout(() => status(`Saved with ${(r.rawBytes / 1e6).toFixed(0)} MB of embedded RAW files — the project file is large.`), 50);
  return JSON.stringify(r.project);
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

const safeName = (s: string) => s.replace(/[^\w\- ]+/g, '').trim() || 'untitled';

export function saveProjectFile() {
  if (native) return void desktop.saveProject(false); // desktop app: native dialog, overwrite in place
  const p = useDoc.getState().project;
  download(new Blob([serializeProject()], { type: 'application/json' }), `${safeName(p.name)}.darkroom`);
  markSaved();
  status(`Saved ${safeName(p.name)}.darkroom`);
}

/** Save As… (desktop: always asks for a path; browser: same as Save). */
export function saveProjectFileAs() {
  if (native) return void desktop.saveProject(true);
  saveProjectFile();
}

export function pickFiles(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = () => resolve([...(input.files ?? [])]);
    input.click();
  });
}

export async function openProjectFile() {
  if (native) return desktop.openProject();
  const [f] = await pickFiles('.darkroom,.json,application/json');
  if (!f) return;
  try {
    const p = validateProject(JSON.parse(await f.text()));
    if (!p.name || p.name === 'Untitled') p.name = f.name.replace(/\.(darkroom|json)$/i, '');
    await loadProject(p);
    status(`Opened ${f.name}`);
  } catch (e) {
    status(`Could not open ${f.name}: ${(e as Error).message}`, 'error');
  }
}

/** Create core.image / core.raw nodes for image and camera RAW files at the current graph level. Returns the new node ids. */
export async function importImageFiles(files: File[], at?: { x: number; y: number }): Promise<string[]> {
  const vids = files.filter((f) => isVideoFile(f)); // video files → core.video nodes (store/videoImport.ts)
  if (vids.length) return [...(await importVideoFiles(vids, at)), ...(vids.length < files.length ? await importImageFiles(files.filter((f) => !isVideoFile(f)), at) : [])];
  const imgs = files.filter((f) => isImportableImage(f.name, f.type));
  if (!imgs.length) {
    if (files.length) status(`Not an image or RAW file: ${files.map((f) => f.name).join(', ')}`, 'error');
    return [];
  }
  const ids: string[] = [];
  for (const [i, f] of imgs.entries()) {
    try {
      const a = await loadAsset(f, f.name || 'pasted image');
      addAsset(a);
      const pos = at ? { x: at.x + i * 30, y: at.y + i * 30 } : defaultImportPos(i);
      const n = createNode(a.raw || isRawFile(f.name, f.type) ? RAW : IMAGE, pos, { asset: a.id });
      n.label = a.name.replace(/\.[^.]+$/, '');
      commitGraph((g) => ({ ...g, nodes: [...g.nodes, n] }));
      ids.push(n.id);
      status(`Imported ${a.name} (${a.width}×${a.height})`);
    } catch (e) {
      status(`Could not import ${f.name}: ${(e as Error).message}`, 'error');
    }
  }
  setSelection(ids);
  return ids;
}

function defaultImportPos(i: number) {
  const g = useDoc.getState().project.graph;
  const minX = g.nodes.length ? Math.min(...g.nodes.map((n) => n.position.x)) : 0;
  const maxY = g.nodes.length ? Math.max(...g.nodes.map((n) => n.position.y)) : -140;
  return { x: minX - 40 + i * 30, y: maxY + 140 + i * 30 };
}

export async function importImageDialog() {
  const files = native ? await desktop.pickImages() : await pickFiles(IMPORT_ACCEPT + ',video/*,.mp4,.m4v,.mov,.webm,.mkv', true);
  await importImageFiles(files);
}

/** Full-resolution size of the output (rendered at the current preview scale, so the cache survives). */
export function measureOutput(): { width: number; height: number } {
  const s = useDoc.getState();
  const id = outputNodeId(s.project);
  if (!engine || !id) return { width: 0, height: 0 };
  const r = engine.render(s.project.graph, { nodeId: id, scale: previewScale });
  requestRender();
  return { width: r.fullWidth, height: r.fullHeight };
}

export type ExportType = 'image/png' | 'image/jpeg' | 'image/webp';
export const EXT: Record<ExportType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

export async function exportBlob(type: ExportType, quality: number, scale = 1): Promise<Blob> {
  const s = useDoc.getState();
  // The export renders the output at scale 1 in the engine's main cache namespace. Viewer renders (preview scale)
  // in between would replace every async cpu node's pending run with their own scale and back — each completion
  // re-invalidating the viewer — so the export never settles and the viewer flickers (seen with sd.generate and
  // ai.styleFromImage). Like video export, keep the viewer out of the engine until the export is done.
  suspendRender(true);
  try {
    await renderReady(engine, s.project.graph, { nodeId: outputNodeId(s.project), scale: 1 }); // wait for async nodes (full-size RAW decode)
    return await engine.export(s.project.graph, { nodeId: outputNodeId(s.project), type, quality, scale });
  } finally {
    suspendRender(false);
    requestRender();
  }
}

export async function exportImage(type: ExportType, quality: number) {
  const t0 = performance.now();
  const blob = await exportBlob(type, quality, useSettings.getState().exportScale); // scale + name: Preferences › Export
  const name = `${exportBaseName()}.${EXT[type]}`;
  if (!native) download(blob, name);
  else if (!(await desktop.saveBlob(blob, name, EXT[type]))) return; // cancelled
  status(`Exported ${(blob.size / 1024).toFixed(0)} KB in ${Math.round(performance.now() - t0)} ms.`);
}

/**
 * File › Export LUT (.cube): bake the colour pipeline from the source image to the selected node (or the
 * output) into an N³ 3D LUT. The source image(s) upstream are replaced by an identity lattice (see
 * src/nodes/pro/lut-export.ts) and the graph is rendered at full resolution; spatial nodes (blur, grain,
 * distortion, local adjustments) can't be represented and are listed in a warning.
 * Resolves to the .cube text (null if nothing was exported).
 */
export async function exportLut(size = 33, opts: { save?: boolean } = {}): Promise<string | null> {
  const s = useDoc.getState();
  const out = outputNodeId(s.project);
  let target = s.selection.length === 1 ? flatId(s.path, s.selection[0]) : out;
  if (!target) return status('Export LUT: select a node or add an Output node.', 'error'), null;
  let lg = buildLutGraph(s.project.graph, target, size);
  if (!lg.graph.nodes.some((n) => n.id === target) && out) lg = buildLutGraph(s.project.graph, (target = out), size); // e.g. a group node selected
  if (!lg.sources) return status('Export LUT: no image source feeds the selected node.', 'error'), null;
  let text: string;
  try {
    const res = await renderReady(engine, lg.graph, { nodeId: target, scale: 1, cacheTag: 'lut' });
    if (!res.tex) throw new Error(engine.errors.get(target) ?? 'nothing rendered');
    if (res.tex.width !== size * size || res.tex.height !== size) throw new Error('the graph changes the image size (crop / border / resize nodes cannot be baked into a LUT)');
    text = writeCube(engine.gl.readFloat(res.tex), size, `${s.project.name || 'Darkroom'} LUT`);
  } catch (e) {
    status(`Export LUT failed: ${(e as Error).message}`, 'error');
    return null;
  } finally {
    engine.dropCache('lut');
    requestRender();
  }
  if (opts.save !== false) {
    const name = `${exportBaseName()}.cube`;
    const blob = new Blob([text], { type: 'text/plain' });
    if (!native) download(blob, name);
    else if (!(await desktop.saveBlob(blob, name, 'cube', 'Cube LUT'))) return text; // cancelled
  }
  const warn = lg.spatial.length ? ` — not colour-only, NOT in the LUT: ${lg.spatial.join(', ')}` : '';
  status(`Exported ${size}³ LUT${lg.sources > 1 ? ` (${lg.sources} sources replaced)` : ''}${warn}`, warn ? 'error' : undefined);
  return text;
}

/** The starter project: Image → (VHS / disposable preset) → Output. */
export async function starterProject(): Promise<Project> {
  const p = emptyProject();
  p.name = 'Untitled';
  const g: Graph = p.graph;
  const img = createNode(IMAGE, { x: 0, y: 0 });
  try {
    const a = await assetFromUrl('/samples/street.jpg', 'a_street');
    engine?.addAsset(a);
    p.assets[a.id] = serial(a);
    img.params.asset = a.id;
    img.label = 'street';
  } catch (e) {
    console.warn('[darkroom] sample image unavailable', e);
  }
  g.nodes.push(img);
  let last = img.id;
  let lastPort = 'out';
  const preset = getPreset('video.vhs') ?? getPreset('camera.disposable');
  if (preset) {
    const pn = buildNode({ kind: 'preset', id: preset.id }, { x: 260, y: 0 })!;
    g.nodes.push(pn);
    const inPort = Object.keys(getPorts(pn).inputs)[0] ?? 'image';
    Object.assign(g, connect(g, { node: last, port: lastPort }, { node: pn.id, port: inPort }));
    last = pn.id;
    lastPort = Object.keys(getPorts(pn).outputs)[0] ?? 'out';
  }
  const out = createNode(OUTPUT, { x: preset ? 520 : 260, y: 0 });
  g.nodes.push(out);
  Object.assign(g, connect(g, { node: last, port: lastPort }, { node: out.id, port: 'image' }));
  p.outputNode = out.id;
  return p;
}

export async function newProject() {
  const p = emptyProject();
  const out = createNode(OUTPUT, { x: 300, y: 0 });
  p.graph.nodes.push(out);
  p.outputNode = out.id;
  await loadProject(p);
  if (native) desktop.setDocPath(null);
  status('New project.');
}

export function renameProject(name: string) {
  commitProject((p) => ({ ...p, name }));
}
