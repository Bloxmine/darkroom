import { registerNodes, registerPreset } from '../core/registry';
import type { NodeDef, PresetDef } from '../core/types';

/**
 * Auto-registers every node module. Each file under src/nodes/** (except this
 * one and tests) must `export default` a NodeDef[]. Each file under src/presets
 * must `export default` a PresetDef[] (or a function returning one, so it runs
 * after all nodes are registered).
 */
const nodeMods = import.meta.glob<NodeDef[]>(['./**/*.ts', '!./index.ts', '!./**/*.test.ts'], { eager: true, import: 'default' });
const presetMods = import.meta.glob<PresetDef[] | (() => PresetDef[])>(['../presets/**/*.ts', '!../presets/**/*.test.ts'], { eager: true, import: 'default' });

let loaded = false;
export function loadBuiltins() {
  if (loaded) return;
  loaded = true;
  for (const [path, defs] of Object.entries(nodeMods)) {
    if (!Array.isArray(defs)) { console.warn(`[darkroom] ${path} has no default NodeDef[] export`); continue; }
    registerNodes(defs);
  }
  for (const [path, mod] of Object.entries(presetMods)) {
    try {
      const list = typeof mod === 'function' ? mod() : mod;
      if (!Array.isArray(list)) { console.warn(`[darkroom] ${path} has no default PresetDef[] export`); continue; }
      list.forEach((p) => registerPreset(p));
    } catch (e) {
      console.error(`[darkroom] failed to build presets in ${path}`, e);
    }
  }
}
