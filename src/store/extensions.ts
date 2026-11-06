import { create } from 'zustand';
import * as custom from '../core/customNodes';
import * as plugins from '../core/plugins';
import { getNodeDef } from '../core/registry';
import { NODE_FILE_EXT, parseNodeFile, serializeNodeDef, toNodeFile } from '../core/serialize';
import type { Project } from '../core/types';
import { engine } from './engine';
import { status } from './ui';

/**
 * App-side glue for custom nodes and plugins: startup loading, the Node
 * Builder window state, node file import/export, project embedding hooks.
 */

interface ExtState {
  /** Node Builder window: null = closed; '' = new node; otherwise the type id being edited. */
  builder: string | null;
  /** Bumped each time the builder is (re)opened, so it reloads its form. */
  builderNonce: number;
}

export const useExt = create<ExtState>(() => ({ builder: null, builderNonce: 0 }));

export const openNodeBuilder = (typeId = '') => useExt.setState((s) => ({ builder: typeId, builderNonce: s.builderNonce + 1 }));
export const closeNodeBuilder = () => useExt.setState({ builder: null });

/** Custom / data-plugin types can be edited in the builder (as a copy for plugin nodes). */
export function canEditInBuilder(typeId: string) {
  const def = getNodeDef(typeId);
  const o = custom.getNodeOrigin(typeId);
  if (!def || !o) return false;
  try {
    serializeNodeDef(def);
    return true;
  } catch {
    return false;
  }
}

let inited = false;
/** Load the custom node library and installed plugins (after built-ins, before the project). */
export async function initExtensions() {
  // console / test hook (re-attached if main re-runs)
  const w = window as unknown as { __darkroom?: Record<string, unknown> };
  if (w.__darkroom) Object.assign(w.__darkroom, { plugins, customNodes: custom, ext: { openNodeBuilder, closeNodeBuilder, useExt, exportNodeType, importNodeFile, importNodeText } });
  if (inited) return;
  inited = true;
  if (engine) plugins.setPluginAssetSink((a) => engine.addAsset(a));
  const problems = [...(await custom.loadUserLibrary()), ...(await plugins.loadInstalledPlugins())];
  if (problems.length) {
    console.warn('[darkroom] extension problems:\n' + problems.join('\n'));
    status(problems[0] + (problems.length > 1 ? ` (+${problems.length - 1} more, see Edit › Plugins…)` : ''), 'error');
  }
}

// ---------------------------------------------------------------------------
// project hooks (called from store/io.ts)
// ---------------------------------------------------------------------------

/** Project as written to disk: embeds custom node types and plugin references. */
export const projectForSave = (p: Project): Project => custom.embedCustomNodes(p);

/** Register embedded node types of an opened project. */
export function registerProjectTypes(p: Project) {
  const r = custom.registerProjectNodes(p);
  const msgs: string[] = [];
  if (r.registered.length) msgs.push(`Registered ${r.registered.length} custom node type${r.registered.length > 1 ? 's' : ''} from the project (${r.registered.join(', ')}).`);
  if (r.differing.length) msgs.push(`Using your installed version of ${r.differing.join(', ')} (the project embeds a different one).`);
  if (r.problems.length) msgs.push(`Could not load embedded node: ${r.problems[0]}`);
  return msgs;
}

// ---------------------------------------------------------------------------
// node files
// ---------------------------------------------------------------------------

export function downloadText(text: string, name: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function exportNodeType(typeId: string) {
  const def = getNodeDef(typeId);
  if (!def) return status(`No node type ${typeId}`, 'error');
  try {
    const s = serializeNodeDef(def);
    downloadText(toNodeFile(s), `${typeId}${NODE_FILE_EXT}`);
    status(`Exported ${typeId}${NODE_FILE_EXT}`);
  } catch (e) {
    status((e as Error).message, 'error');
  }
}

/** Import `.drnode.json` text into the user library. */
export async function importNodeText(text: string, fileName = 'node file') {
  try {
    const s = parseNodeFile(text);
    const existed = !!custom.getUserNode(s.id);
    await custom.saveUserNode(s);
    status(`${existed ? 'Updated' : 'Imported'} node type “${s.name}” (${s.id}) — find it under ${s.category}.`);
    return s.id;
  } catch (e) {
    status(`Could not import ${fileName}: ${(e as Error).message}`, 'error');
    return null;
  }
}

export async function importNodeFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,.drnode.json,application/json';
  const file = await new Promise<File | undefined>((res) => {
    input.onchange = () => res(input.files?.[0]);
    input.click();
  });
  if (!file) return null;
  return importNodeText(await file.text(), file.name);
}
