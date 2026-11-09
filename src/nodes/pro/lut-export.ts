/**
 * Export the colour pipeline as a 3D LUT (.cube).
 *
 * Design: an identity lattice image (N² × N px; x = r + b·N, y = g — the same layout color.lut's atlas
 * uses) is substituted for every source node (image / RAW / video / webcam) upstream of the target, the
 * flattened graph is rendered at scale 1, and each output texel is the graded colour of its lattice
 * entry. Only per-pixel ("colour-only") nodes are representable: spatial nodes (blur, grain, distortion,
 * local adjustments, image statistics) are bypassed while baking and reported so the user can be warned.
 */
import { defineNode } from '../../core/registry';
import { getNodeDef } from '../../core/registry';
import type { Graph, GraphNode, NodeDef } from '../../core/types';
import { flattenGraph } from '../../core/graph';

export const LATTICE = 'pro.lutLattice';
export const SOURCE_TYPES = new Set(['core.image', 'core.raw', 'core.video', 'core.webcam', 'core.videoFrameOffset']);

/** Library nodes known to be per-pixel colour transforms (in addition to NodeDef.colorOnly). */
export const COLOR_ONLY_IDS = new Set([
  'color.levels', 'color.curves', 'color.hsl', 'color.exposure', 'color.colorBalance', 'color.channelMixer', 'color.whiteBalance',
  'color.temperatureKelvin', 'color.vibranceSaturation', 'color.splitToning', 'color.duotone', 'color.gradientMap', 'color.colorize',
  'color.invert', 'color.lut', 'color.selectiveColor', 'color.blackWhite', 'color.convert', 'color.threshold', 'color.falseColor',
  'stylize.posterize', 'effects.crossProcess', 'effects.toning', 'analog.filmCurve',
  'convert.brightContrast', 'convert.colorRamp', 'convert.gamma', 'convert.hueSatVal', 'convert.rgbToBw', 'convert.floatCurve',
  'convert.separateColor', 'convert.combineColor', 'convert.blackbody', 'convert.wavelength',
  'math.math', 'math.op', 'math.clamp', 'math.mapRange', 'math.remap', 'math.compare', 'mix.color',
  'util.reroute', 'core.output', 'composite.premultiply', 'composite.unpremultiply',
]);

/** Is a node type representable in a LUT? */
export function isColorOnly(type: string): boolean {
  if (type === LATTICE || COLOR_ONLY_IDS.has(type)) return true;
  return !!getNodeDef(type)?.colorOnly;
}

/** Identity lattice, RGBA float, row 0 = top: pixel (x = r + b·N, y = g) = (r, g, b)/(N − 1). */
export function latticeData(N: number): Float32Array {
  const W = N * N;
  const d = new Float32Array(W * N * 4);
  for (let g = 0; g < N; g++)
    for (let b = 0; b < N; b++)
      for (let r = 0; r < N; r++) {
        const o = (g * W + r + b * N) * 4;
        d[o] = r / (N - 1);
        d[o + 1] = g / (N - 1);
        d[o + 2] = b / (N - 1);
        d[o + 3] = 1;
      }
  return d;
}

/** Adobe .cube text from a rendered lattice (RGBA float, N² × N, same layout as latticeData). Red varies fastest. */
export function writeCube(pixels: Float32Array, N: number, title = 'Darkroom LUT', clamp = true): string {
  const W = N * N;
  const lines = [`TITLE "${title.replace(/"/g, "'")}"`, '# Exported from Darkroom', `LUT_3D_SIZE ${N}`, 'DOMAIN_MIN 0.0 0.0 0.0', 'DOMAIN_MAX 1.0 1.0 1.0'];
  const f = (v: number) => (clamp ? Math.min(1, Math.max(0, v)) : v).toFixed(6);
  for (let b = 0; b < N; b++)
    for (let g = 0; g < N; g++)
      for (let r = 0; r < N; r++) {
        const o = (g * W + r + b * N) * 4;
        lines.push(`${f(pixels[o])} ${f(pixels[o + 1])} ${f(pixels[o + 2])}`);
      }
  return lines.join('\n') + '\n';
}

export interface LutGraph {
  graph: Graph;
  /** Display names of upstream nodes that are not colour-only (they cannot be baked faithfully). */
  spatial: string[];
  /** Number of source nodes replaced by the lattice. */
  sources: number;
}

/**
 * Flatten `graph`, collect the nodes upstream of `target` (a flat id), replace their source nodes with
 * the lattice and list the non-colour nodes.
 */
export function buildLutGraph(graph: Graph, target: string, N: number): LutGraph {
  const flat = flattenGraph(graph);
  const byId = new Map(flat.nodes.map((n) => [n.id, n]));
  const up = new Set<string>();
  const stack = [target];
  while (stack.length) {
    const id = stack.pop()!;
    if (up.has(id) || !byId.has(id)) continue;
    up.add(id);
    for (const e of flat.edges) if (e.to.node === id) stack.push(e.from.node);
  }
  const spatial: string[] = [];
  let sources = 0;
  const nodes: GraphNode[] = flat.nodes.map((n) => {
    if (!up.has(n.id)) return n;
    if (SOURCE_TYPES.has(n.type)) {
      sources++;
      return { id: n.id, type: LATTICE, params: { size: N }, position: n.position };
    }
    if (!n.bypass && !isColorOnly(n.type)) {
      // bypassed while baking (its first input passes through), so the LUT holds only the colour part
      spatial.push(n.label || getNodeDef(n.type)?.name || n.type);
      return { ...n, bypass: true };
    }
    return n;
  });
  // edges into replaced sources' (now absent) inputs don't matter; outputs keep their ids
  const latticeIds = new Set(nodes.filter((n) => n.type === LATTICE).map((n) => n.id));
  const edges = flat.edges.filter((e) => !latticeIds.has(e.to.node)).map((e) => (latticeIds.has(e.from.node) ? { ...e, from: { node: e.from.node, port: 'out' } } : e));
  return { graph: { nodes, edges }, spatial: [...new Set(spatial)], sources };
}

const lattice = defineNode({
  id: LATTICE,
  name: 'LUT Lattice',
  category: 'Color Management',
  hidden: true,
  colorOnly: true,
  description: 'Identity 3D-LUT lattice image (N² × N) used by File › Export LUT.',
  inputs: {},
  params: { size: { type: 'int', default: 33, min: 2, max: 65, step: 1, label: 'Size' } },
  size: ({ params }) => {
    const N = Math.round(Number(params.size) || 33);
    return [N * N, N];
  },
  cpu: ({ params }) => {
    const N = Math.round(Number(params.size) || 33);
    return { out: { width: N * N, height: N, data: latticeData(N), filter: 'nearest' } };
  },
});

export default [lattice] satisfies NodeDef[];
