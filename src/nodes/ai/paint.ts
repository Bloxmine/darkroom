/**
 * Paint Mask: brush strokes painted in the viewer, stored as normalised polylines (radius as a fraction
 * of the image height, hardness, paint/erase) and rasterised at the render resolution, so the mask is
 * resolution-independent (preview and export match).
 */
import { defineNode } from '../../core/registry';
import type { NodeDef, RawTex } from '../../core/types';
import { parseStrokes, type Stroke } from '../../ui/viewerTools/data';
import { featherPass } from './segment-shared';

/** Rasterise strokes into a W×H coverage buffer (0..1). Paint = max, erase = multiply by (1 − coverage). */
export function rasterStrokes(strokes: Stroke[], W: number, H: number, base = 0): Float32Array {
  const acc = new Float32Array(W * H).fill(base);
  const cov = new Float32Array(W * H);
  for (const s of strokes) {
    const R = Math.max(0.5, s.r * H);
    const soft = Math.max(0.75, R * (1 - Math.min(1, Math.max(0, s.h))));
    const inner = R - soft;
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    const pts = s.p;
    const n = pts.length >> 1;
    for (let k = 0; k < Math.max(1, n - 1); k++) {
      const ax = pts[k * 2] * W, ay = pts[k * 2 + 1] * H;
      const bx = n > 1 ? pts[k * 2 + 2] * W : ax, by = n > 1 ? pts[k * 2 + 3] * H : ay;
      const sx0 = Math.max(0, Math.floor(Math.min(ax, bx) - R)), sx1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx) + R));
      const sy0 = Math.max(0, Math.floor(Math.min(ay, by) - R)), sy1 = Math.min(H - 1, Math.ceil(Math.max(ay, by) + R));
      if (sx0 > sx1 || sy0 > sy1) continue;
      x0 = Math.min(x0, sx0); y0 = Math.min(y0, sy0); x1 = Math.max(x1, sx1); y1 = Math.max(y1, sy1);
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      for (let y = sy0; y <= sy1; y++) {
        const py = y + 0.5 - ay;
        for (let x = sx0; x <= sx1; x++) {
          const px = x + 0.5 - ax;
          const t = len2 > 0 ? Math.min(1, Math.max(0, (px * dx + py * dy) / len2)) : 0;
          const ex = px - t * dx, ey = py - t * dy;
          const d = Math.sqrt(ex * ex + ey * ey);
          if (d >= R) continue;
          let c = d <= inner ? 1 : 1 - (d - inner) / soft;
          c = c * c * (3 - 2 * c); // smoothstep falloff
          const i = y * W + x;
          if (c > cov[i]) cov[i] = c;
        }
      }
    }
    if (x1 < 0) continue;
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const i = y * W + x;
        const c = cov[i];
        if (!c) continue;
        acc[i] = s.e ? acc[i] * (1 - c) : Math.max(acc[i], c);
        cov[i] = 0;
      }
  }
  return acc;
}

const paint = defineNode({
  id: 'mask.paint',
  name: 'Paint Mask',
  category: 'Mask',
  description:
    'Paint a mask with a brush directly in the viewer: select this node, then paint (white) or erase. Strokes are stored resolution-independently ' +
    '(normalised positions; size relative to the image height), so preview and export match. The optional image input only sets the size. ' +
    'Combine with AI masks (Mask Combine / math) to fix up a selection by hand.',
  tags: ['paint', 'brush', 'mask', 'draw', 'manual', 'selection', 'retouch', 'local adjustment'],
  inputs: { image: { type: 'image', label: 'Size from', optional: true } },
  outputs: { mask: { type: 'mask', label: 'Mask' } },
  params: {
    strokes: { type: 'string', default: '', hidden: true, label: 'Strokes', description: 'JSON [{r,h,e,p:[x,y,…]}] (normalised). Paint in the viewer.' },
    fill: { type: 'bool', default: false, label: 'Start white', description: 'Start from a full mask and paint/erase holes into it.' },
    feather: { type: 'float', default: 0, min: 0, max: 200, step: 0.5, pixels: true, label: 'Feather' },
    invert: { type: 'bool', default: false, label: 'Invert' },
  },
  viewerTool: { kind: 'brush', param: 'strokes', previewPort: 'mask' },
  cpu: (ctx) => {
    const strokes = parseStrokes(ctx.params.strokes);
    const base = ctx.params.fill ? 1 : 0;
    if (!strokes.length) return { m: { width: 1, height: 1, data: new Uint8Array([base * 255, 0, 0, 255]) } satisfies RawTex };
    // aspect from the project size (the usual case: the photo); positions are normalised either way
    const W = Math.max(1, Math.round(ctx.projectSize.width * ctx.scale));
    const H = Math.max(1, Math.round(ctx.projectSize.height * ctx.scale));
    const acc = rasterStrokes(strokes, W, H, base);
    const data = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      data[i * 4] = Math.round(acc[i] * 255);
      data[i * 4 + 3] = 255;
    }
    return { m: { width: W, height: H, data } satisfies RawTex };
  },
  passes: [
    { frag: /* glsl */ `void main() { fragColor = vec4(vec3(texture(u_m, v_uv).r), 1.0); }` },
    { frag: featherPass(false) },
    { frag: featherPass(true) },
  ],
});

export default [paint] satisfies NodeDef[];
