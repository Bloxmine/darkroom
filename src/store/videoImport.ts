import { createNode } from '../core/graph';
import { formatMB, loadVideoAsset, VIDEO_EMBED_LIMIT } from '../core/videoAssets';
import { uid } from '../core/graph';
import { commitGraph, setSelection, useDoc } from './doc';
import { addAsset } from './io';
import { status } from './ui';

/** Create core.video nodes for video files at the current graph level. Returns the new node ids. */
export async function importVideoFiles(files: File[], at?: { x: number; y: number }): Promise<string[]> {
  const ids: string[] = [];
  for (const [i, f] of files.entries()) {
    try {
      status(`Reading ${f.name}…`);
      const a = await loadVideoAsset(f, f.name || 'video', uid('a'));
      addAsset(a);
      const pos = at ? { x: at.x + i * 30, y: at.y + i * 30 } : importPos(i);
      const n = createNode('core.video', pos, { asset: a.id });
      n.label = a.name.replace(/\.[^.]+$/, '');
      commitGraph((g) => ({ ...g, nodes: [...g.nodes, n] }));
      ids.push(n.id);
      const big = f.size > VIDEO_EMBED_LIMIT;
      status(
        `Imported ${a.name} (${a.width}×${a.height}, ${a.duration?.toFixed(1)} s @ ${a.fps} fps)` +
          (big ? ` — ${formatMB(f.size)} is too large to embed: it is kept in this browser's storage and NOT saved inside .darkroom files.` : ''),
        big ? 'error' : 'info',
      );
    } catch (e) {
      status(`Could not import ${f.name}: ${(e as Error).message}`, 'error');
    }
  }
  if (ids.length) setSelection(ids);
  return ids;
}

function importPos(i: number) {
  const g = useDoc.getState().project.graph;
  const minX = g.nodes.length ? Math.min(...g.nodes.map((n) => n.position.x)) : 0;
  const maxY = g.nodes.length ? Math.max(...g.nodes.map((n) => n.position.y)) : -140;
  return { x: minX - 40 + i * 30, y: maxY + 140 + i * 30 };
}
