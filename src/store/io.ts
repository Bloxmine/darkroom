import { assetFromDataUrl, assetFromUrl, loadAsset } from '../core/assets';
import { connect, createNode, getPorts, IMAGE, OUTPUT } from '../core/graph';
import { buildNode } from './actions';
import { getPreset } from '../core/registry';
import type { Asset, Graph, Project } from '../core/types';
import { setSelection } from './doc';
import { commitGraph, commitProject, emptyProject, markSaved, outputNodeId, setProject, useDoc } from './doc';
import { engine, previewScale, requestRender, resetRenderSize } from './engine';
import { status, useUi } from './ui';

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
    if (r.status === 'fulfilled') engine?.addAsset(r.value);
    else console.warn('[darkroom] could not load asset', list[i].name, r.reason);
  });
}

export function validateProject(x: unknown): Project {
  const p = x as Project;
  if (!p || typeof p !== 'object' || !p.graph || !Array.isArray(p.graph.nodes) || !Array.isArray(p.graph.edges)) throw new Error('Not a Darkroom project file.');
  return { version: 1, name: p.name ?? 'Untitled', graph: p.graph, assets: p.assets ?? {}, outputNode: p.outputNode };
}

export async function loadProject(p: Project, opts: { viewed?: string | null; dirty?: boolean } = {}) {
  await hydrateAssets(p);
  engine?.clearCache();
  resetRenderSize();
  setProject(p, opts);
  useUi.setState({ fit: true });
  requestRender();
}

export function serializeProject(): string {
  return JSON.stringify(useDoc.getState().project);
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
  const p = useDoc.getState().project;
  download(new Blob([serializeProject()], { type: 'application/json' }), `${safeName(p.name)}.darkroom`);
  markSaved();
  status(`Saved ${safeName(p.name)}.darkroom`);
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

/** Create core.image nodes for image files at the current graph level. */
export async function importImageFiles(files: File[], at?: { x: number; y: number }) {
  const imgs = files.filter((f) => f.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name));
  if (!imgs.length) return;
  const ids: string[] = [];
  for (const [i, f] of imgs.entries()) {
    try {
      const a = await loadAsset(f, f.name || 'pasted image');
      addAsset(a);
      const pos = at ? { x: at.x + i * 30, y: at.y + i * 30 } : defaultImportPos(i);
      const n = createNode(IMAGE, pos, { asset: a.id });
      n.label = a.name.replace(/\.[^.]+$/, '');
      commitGraph((g) => ({ ...g, nodes: [...g.nodes, n] }));
      ids.push(n.id);
      status(`Imported ${a.name} (${a.width}×${a.height})`);
    } catch (e) {
      status(`Could not import ${f.name}: ${(e as Error).message}`, 'error');
    }
  }
  setSelection(ids);
}

function defaultImportPos(i: number) {
  const g = useDoc.getState().project.graph;
  const minX = g.nodes.length ? Math.min(...g.nodes.map((n) => n.position.x)) : 0;
  const maxY = g.nodes.length ? Math.max(...g.nodes.map((n) => n.position.y)) : -140;
  return { x: minX - 40 + i * 30, y: maxY + 140 + i * 30 };
}

export async function importImageDialog() {
  const files = await pickFiles('image/*', true);
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

export async function exportBlob(type: ExportType, quality: number): Promise<Blob> {
  const s = useDoc.getState();
  const blob = await engine.export(s.project.graph, { nodeId: outputNodeId(s.project), type, quality });
  requestRender();
  return blob;
}

export async function exportImage(type: ExportType, quality: number) {
  const t0 = performance.now();
  const blob = await exportBlob(type, quality);
  download(blob, `${safeName(useDoc.getState().project.name)}.${EXT[type]}`);
  status(`Exported ${(blob.size / 1024).toFixed(0)} KB in ${Math.round(performance.now() - t0)} ms.`);
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
  status('New project.');
}

export function renameProject(name: string) {
  commitProject((p) => ({ ...p, name }));
}
