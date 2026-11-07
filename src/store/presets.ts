/** "Save as Preset…" and the My Presets library actions (rename / delete / export / import). */
import { getPorts, GROUP, GROUP_OUTPUT } from '../core/graph';
import type { Graph } from '../core/types';
import * as UP from '../core/userPresets';
import { groupSelection } from './actions';
import { currentGraph, useDoc } from './doc';
import { engine } from './engine';
import { downloadText } from './extensions';
import { graphAt } from './graphPath';
import { useGraphUi } from './graphUi';
import { pickFiles } from './io';
import { status } from './ui';

export const presetsReady = UP.loadUserPresets().then((p) => {
  if (p.length) status(p.join(' '), 'error');
});

/** Open the Save as Preset dialog for the selected group (grouping a multi-node selection first). */
export function savePresetFromSelection() {
  const s = useDoc.getState();
  const g = currentGraph(s);
  const sel = g.nodes.filter((n) => s.selection.includes(n.id));
  if (!sel.length) return status('Select a group (or some nodes) to save as a preset.', 'error');
  let gid = sel.length === 1 && sel[0].type === GROUP ? sel[0].id : '';
  if (!gid) {
    groupSelection();
    const after = useDoc.getState();
    const n = currentGraph(after).nodes.find((x) => x.id === after.selection[0]);
    if (!n || n.type !== GROUP) return;
    gid = n.id;
  }
  useGraphUi.setState({ dialog: { kind: 'savePreset', groupId: gid } });
}

/** Flat engine id + port of what a node at the current level displays (groups → the inner node feeding their output). */
function flatTarget(root: Graph, path: string[], id: string, depth = 0): { id: string; port: string } | null {
  const g = graphAt(root, path);
  const n = g?.nodes.find((x) => x.id === id);
  if (!g || !n || depth > 16) return null;
  if (n.type !== GROUP) return { id: [...path, id].join('/'), port: Object.keys(getPorts(n).outputs)[0] ?? 'out' };
  const out = n.group?.graph.nodes.find((x) => x.type === GROUP_OUTPUT);
  const e = out && n.group!.graph.edges.find((x) => x.to.node === out.id);
  if (!e) return null;
  const inner = flatTarget(root, [...path, id], e.from.node, depth + 1);
  return inner && { ...inner, port: e.from.port };
}

/** Render the group's output and return a small PNG data URL (null when the engine can't). */
export async function captureGroupThumb(groupId: string, size = 128): Promise<string | null> {
  if (!engine) return null;
  const s = useDoc.getState();
  const graph = s.project.graph;
  const t = flatTarget(graph, s.path, groupId);
  if (!t) return null;
  try {
    if (!engine.isCached(t.id, graph)) engine.render(graph, { nodeId: t.id, port: t.port, maxSize: 512, cacheTag: 'thumb' });
    const img = await engine.thumbnail(t.id, t.port, size, { graph });
    if (!img) return null;
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    c.getContext('2d')!.putImageData(img, 0, 0);
    return c.toDataURL('image/png');
  } catch (e) {
    console.warn('[darkroom] preset thumbnail failed', e);
    return null;
  }
}

export async function saveGroupAsPreset(groupId: string, meta: { name: string; category: string; description?: string; thumb?: string | null }) {
  const n = currentGraph().nodes.find((x) => x.id === groupId);
  if (!n?.group) return status('That group no longer exists.', 'error');
  // the group node's current exposed values become the preset's values
  const group = structuredClone(n.group);
  for (const ex of group.exposed) {
    const inner = group.graph.nodes.find((x) => x.id === ex.node);
    if (inner && ex.key in n.params) inner.params = { ...inner.params, [ex.param]: structuredClone(n.params[ex.key]) };
  }
  const p = await UP.saveUserPreset({
    id: UP.newPresetId(meta.name),
    name: meta.name,
    category: meta.category || 'My Presets',
    description: meta.description || undefined,
    group,
    thumb: meta.thumb ?? undefined,
  });
  status(`Saved preset “${p.name}” — find it in the Node Library under My Presets.`);
  return p.id;
}

export function exportPreset(id: string) {
  try {
    const p = UP.getUserPreset(id)!;
    downloadText(UP.presetToFile(id), `${p.name.replace(/[^\w\- ]+/g, '').trim() || 'preset'}${UP.PRESET_FILE_EXT}`);
    status(`Exported preset “${p.name}”.`);
  } catch (e) {
    status((e as Error).message, 'error');
  }
}

export async function importPresetText(text: string, fileName = 'preset file') {
  try {
    const p = await UP.saveUserPreset(UP.parsePresetFile(text));
    status(`Imported preset “${p.name}”.`);
    return p.id;
  } catch (e) {
    status(`Could not import ${fileName}: ${(e as Error).message}`, 'error');
    return null;
  }
}

export async function importPresetFiles() {
  const files = await pickFiles('.json,application/json', true);
  for (const f of files) await importPresetText(await f.text(), f.name);
}

export async function deletePreset(id: string) {
  const p = UP.getUserPreset(id);
  await UP.deleteUserPreset(id);
  if (p) status(`Deleted preset “${p.name}”. Groups already added to projects are unaffected.`);
}
