import { memo, useEffect, useRef, useState } from 'react';
import { getPorts, GROUP_INPUT } from '../core/graph';
import type { GraphNode } from '../core/types';
import * as A from '../store/actions';
import { useDoc } from '../store/doc';
import { flatId } from '../store/graphPath';
import { subscribeThumb, THUMB_H, THUMB_W } from './thumbs';

/** Fit (w, h) into the thumbnail box, keeping the aspect ratio. */
function fit(w: number, h: number) {
  const k = Math.min(THUMB_W / w, THUMB_H / h);
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

/**
 * Live output thumbnail strip inside a graph node. Pixels come from the shared
 * thumbnail scheduler (./thumbs) and are drawn straight into this <canvas>.
 */
function NodeThumbImpl({ node }: { node: GraphNode }) {
  const path = useDoc((s) => s.path);
  const flat = flatId(path, node.id);
  const outs = Object.entries(getPorts(node).outputs);
  const [port, setPort] = useState('');
  const cur = outs.some(([k]) => k === port) ? port : (outs[0]?.[0] ?? '');
  const canvas = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<'empty' | 'ok'>('empty');
  const [box, setBox] = useState(() => fit(16, 10));
  const down = useRef<{ x: number; y: number } | null>(null);

  useEffect(
    () =>
      subscribeThumb(flat, cur, (img) => {
        const c = canvas.current;
        if (!c) return;
        if (!img) {
          setState('empty');
          return;
        }
        if (c.width !== img.width || c.height !== img.height) {
          c.width = img.width;
          c.height = img.height;
        }
        c.getContext('2d')!.putImageData(img, 0, 0);
        setBox((b) => {
          const n = fit(img.width, img.height);
          return n.width === b.width && n.height === b.height ? b : n;
        });
        setState('ok');
      }),
    [flat, cur],
  );

  if (node.type === GROUP_INPUT) return null;
  return (
    <div
      className={'dn-thumb' + (state === 'empty' ? ' empty' : '')}
      title="Click to show this node in the Viewer"
      onPointerDown={(e) => (down.current = { x: e.clientX, y: e.clientY })}
      onClick={(e) => {
        const d = down.current;
        if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return; // was a drag
        A.viewNode(node.id);
      }}
    >
      <canvas ref={canvas} style={{ width: box.width, height: box.height }} />
      {state === 'empty' && <span className="dn-thumb-empty">no preview</span>}
      {outs.length > 1 && (
        <div className="dn-thumb-ports">
          {outs.map(([k, p]) => (
            <button
              key={k}
              className={'dn-thumb-port' + (k === cur ? ' on' : '')}
              title={`Show output “${p.label ?? k}”`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                setPort(k);
              }}
            >
              {p.label ?? k}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export const NodeThumb = memo(NodeThumbImpl);
