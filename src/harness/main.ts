/**
 * Headless render harness used by scripts/snap.mjs (and handy in a browser).
 *
 *   /harness.html?preset=camera.vhs&img=street
 *   /harness.html?node=color.levels&params={"gamma":1.5}&img=portrait
 *   /harness.html?graph=/some/graph.json
 *   &scale=0.5      render scale (default 1)
 *   &img2=landscape second sample connected to a node's 2nd image input
 *   &p.<key>=value  override a preset's exposed param, e.g. &p.amount=0.8
 *
 * Sets window.__result = { ok, ms, width, height, errors } when done.
 */
import { assetFromUrl } from '../core/assets';
import { Engine } from '../core/engine';
import { createGroupNode, createNode, GraphBuilder, IMAGE, OUTPUT, getPorts } from '../core/graph';
import { getNodeDef, getPreset } from '../core/registry';
import type { Graph } from '../core/types';
import { loadBuiltins } from '../nodes';

declare global { interface Window { __result?: unknown } }

async function main() {
  loadBuiltins();
  const q = new URLSearchParams(location.search);
  const img = q.get('img') ?? 'street';
  const a1 = await assetFromUrl(`/samples/${img}.jpg`, 'img1');
  const a2 = await assetFromUrl(`/samples/${q.get('img2') ?? 'landscape'}.jpg`, 'img2');

  let graph: Graph;
  if (q.get('graph')) {
    graph = await (await fetch(q.get('graph')!)).json();
  } else {
    const b = new GraphBuilder();
    const src = b.node(IMAGE, { asset: 'img1' }, {}, 'src');
    let last = src;
    if (q.get('preset')) {
      const p = getPreset(q.get('preset')!);
      if (!p) throw new Error('unknown preset ' + q.get('preset'));
      const g = createGroupNode(p.group);
      g.id = 'preset';
      for (const [k, v] of q) if (k.startsWith('p.')) g.params[k.slice(2)] = JSON.parse(v);
      b.nodes.push(g);
      b.link(src, g.id, Object.keys(getPorts(g).inputs)[0] ?? 'image');
      last = g.id;
    } else if (q.get('node')) {
      const type = q.get('node')!;
      const def = getNodeDef(type);
      if (!def) throw new Error('unknown node ' + type);
      const n = createNode(type, { x: 0, y: 0 }, JSON.parse(q.get('params') ?? '{}'));
      n.id = 'node';
      b.nodes.push(n);
      const imgInputs = Object.entries(def.inputs).filter(([, p]) => p.type === 'image');
      if (imgInputs[0]) b.link(src, n.id, imgInputs[0][0]);
      if (imgInputs[1] && !imgInputs[1][1].optional) {
        const src2 = b.node(IMAGE, { asset: 'img2' }, {}, 'src2');
        b.link(src2, n.id, imgInputs[1][0]);
      }
      last = n.id;
      if (q.get('port')) last = JSON.stringify({ node: n.id, port: q.get('port') });
    }
    const out = createNode(OUTPUT);
    out.id = 'output';
    b.nodes.push(out);
    b.link(last.startsWith('{') ? JSON.parse(last) : last, out.id, 'image');
    graph = { nodes: b.nodes, edges: b.edges };
  }

  const canvas = document.getElementById('c') as HTMLCanvasElement;
  const engine = new Engine(canvas);
  engine.addAsset(a1);
  engine.addAsset(a2);
  const scale = Number(q.get('scale') ?? 1);

  const run = () => engine.render(graph, { scale });
  let res = run();
  // let async cpu nodes settle
  for (let i = 0; i < 50 && [...engine.errors.values()].some((e) => e.startsWith('[pending]')); i++) {
    await new Promise((r) => setTimeout(r, 50));
    res = run();
  }
  canvas.width = res.width || 16;
  canvas.height = res.height || 16;
  engine.present(res.tex, { rect: { x: 0, y: 0, w: canvas.width, h: canvas.height } });
  const errors = Object.fromEntries(engine.errors);
  window.__result = { ok: !!res.tex && !Object.keys(errors).length, ms: Math.round(res.ms), width: res.width, height: res.height, errors };
}

main().catch((e) => {
  console.error(e);
  window.__result = { ok: false, errors: { fatal: String(e?.stack ?? e) } };
});
