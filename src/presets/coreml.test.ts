import { beforeAll, describe, expect, it } from 'vitest';

// Node modules pull in the settings store, which touches the DOM on load: give it a minimal stand-in.
const el = () => ({ dataset: {}, style: { setProperty() {} }, classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, removeAttribute() {}, appendChild() {} });
const g = globalThis as Record<string, unknown>;
g.document ??= { documentElement: el(), head: el(), body: el(), createElement: () => ({ ...el(), getContext: () => null }), addEventListener() {}, querySelector: () => null };
g.window ??= Object.assign(g, { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {} });
g.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };

let M: {
  flattenGraph: typeof import('../core/graph').flattenGraph;
  getParamDefs: typeof import('../core/graph').getParamDefs;
  getNodeDef: typeof import('../core/registry').getNodeDef;
  listPresets: typeof import('../core/registry').listPresets;
  CONTROL_KINDS: readonly string[];
  STYLE_NAMES: readonly string[];
};

describe('Core ML presets', () => {
  beforeAll(async () => {
    const [graph, registry, catalog, styles, nodes] = await Promise.all([import('../core/graph'), import('../core/registry'), import('../core/sd/coreml-catalog'), import('../core/sd/styles'), import('../nodes')]);
    nodes.loadBuiltins();
    M = { flattenGraph: graph.flattenGraph, getParamDefs: graph.getParamDefs, getNodeDef: registry.getNodeDef, listPresets: registry.listPresets, CONTROL_KINDS: catalog.CONTROL_KINDS, STYLE_NAMES: styles.STYLE_NAMES };
  });
  const presets = () => M.listPresets().filter((p) => p.id.startsWith('coreml.'));

  it('covers every Core ML ControlNet kind', () => {
    const used = new Set<string>();
    for (const p of presets()) for (const n of p.group.graph.nodes) if (n.type === 'sd.generate') for (const i of [1, 2, 3]) if (n.params[`cn${i}Model`]) used.add(String(n.params[`cn${i}Model`]));
    expect([...M.CONTROL_KINDS].filter((k) => !used.has(k))).toEqual([]);
    expect(presets().length).toBeGreaterThanOrEqual(16);
  });

  it('only uses existing nodes, valid kinds, styles and exposed params', () => {
    for (const p of presets()) {
      const g = p.group.graph;
      for (const n of g.nodes) if (!n.type.startsWith('core.group')) expect(M.getNodeDef(n.type), `${p.id}: ${n.type}`).toBeTruthy();
      for (const n of g.nodes.filter((n) => n.type === 'sd.generate')) {
        for (const i of [1, 2, 3]) {
          const k = n.params[`cn${i}Model`];
          if (k) expect(M.CONTROL_KINDS, `${p.id} unit ${i}`).toContain(k);
        }
        expect(M.STYLE_NAMES, p.id).toContain(n.params.style ?? 'none');
      }
      for (const e of p.group.exposed) {
        const inner = g.nodes.find((n) => n.id === e.node);
        expect(inner, `${p.id}: exposed ${e.key}`).toBeTruthy();
        expect(Object.keys(M.getParamDefs(inner!)), `${p.id}: ${e.key} → ${inner!.type}.${e.param}`).toContain(e.param);
      }
      // the group must flatten into a connected graph feeding its output
      const flat = M.flattenGraph({ nodes: [{ id: 'P', type: 'core.group', params: {}, position: { x: 0, y: 0 }, group: p.group }], edges: [] });
      expect(flat.nodes.some((n) => n.type === 'sd.generate'), p.id).toBe(true);
    }
  });
});
