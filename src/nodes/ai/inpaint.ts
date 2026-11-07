/** Object removal with LaMa: per masked region, crop with context → 512² → inpaint → feathered paste-back. */
import { InferenceMemo, resampleRGB } from '../../core/ai/image';
import { runModelMulti } from '../../core/ai/runtime';
import { defineNode } from '../../core/registry';
import type { NodeDef, RawTex } from '../../core/types';
import { isFlat, progress, rgbOf, sizedFp } from './_img';
import { AI_COLOR } from './_shared';

const S = 512; // LaMa's fixed input size
interface Patch { x: number; y: number; w: number; h: number; out: Float32Array }
const memo = new InferenceMemo<Patch[]>(6);

/** Mask (r channel) of any size → binary W×H (nearest). */
function binaryMask(m: RawTex, W: number, H: number, thr = 0.5): Uint8Array {
  const out = new Uint8Array(W * H);
  const k = m.data instanceof Uint8Array ? 255 : 1;
  for (let y = 0; y < H; y++) {
    const sy = Math.min(m.height - 1, Math.floor(((y + 0.5) * m.height) / H));
    for (let x = 0; x < W; x++) {
      const sx = Math.min(m.width - 1, Math.floor(((x + 0.5) * m.width) / W));
      out[y * W + x] = m.data[(sy * m.width + sx) * 4] / k > thr ? 1 : 0;
    }
  }
  return out;
}

/** Euclidean distance (px) to the nearest set pixel (Felzenszwalb & Huttenlocher), 0 inside. */
function distance(m: Uint8Array, W: number, H: number): Float32Array {
  const INF = 1e20;
  const f = new Float64Array(Math.max(W, H));
  const d = new Float64Array(Math.max(W, H));
  const v = new Int32Array(Math.max(W, H));
  const z = new Float64Array(Math.max(W, H) + 1);
  const g = new Float64Array(W * H);
  for (let i = 0; i < W * H; i++) g[i] = m[i] ? 0 : INF;
  const pass = (n: number) => {
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
    }
  };
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) f[y] = g[y * W + x];
    pass(H);
    for (let y = 0; y < H; y++) g[y * W + x] = d[y];
  }
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) f[x] = g[y * W + x];
    pass(W);
    for (let x = 0; x < W; x++) out[y * W + x] = Math.sqrt(d[x]);
  }
  return out;
}

/** Bounding boxes of 8-connected components. */
function components(m: Uint8Array, W: number, H: number) {
  const seen = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  const boxes: { x0: number; y0: number; x1: number; y1: number }[] = [];
  for (let i = 0; i < W * H; i++) {
    if (!m[i] || seen[i]) continue;
    let sp = 0;
    stack[sp++] = i;
    seen[i] = 1;
    const b = { x0: W, y0: H, x1: -1, y1: -1 };
    while (sp) {
      const p = stack[--sp];
      const x = p % W, y = (p - x) / W;
      if (x < b.x0) b.x0 = x;
      if (x > b.x1) b.x1 = x;
      if (y < b.y0) b.y0 = y;
      if (y > b.y1) b.y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= W) continue;
          const q = yy * W + xx;
          if (m[q] && !seen[q]) {
            seen[q] = 1;
            stack[sp++] = q;
          }
        }
      }
    }
    boxes.push(b);
  }
  return boxes;
}

interface Rect { x: number; y: number; w: number; h: number }

/** Context crop around a box: side = max(box·(1+2·pad), min(512, image)), clamped inside the image. */
function cropFor(b: { x0: number; y0: number; x1: number; y1: number }, W: number, H: number, pad: number, margin: number): Rect {
  const bw = b.x1 - b.x0 + 1 + 2 * margin, bh = b.y1 - b.y0 + 1 + 2 * margin;
  let side = Math.max(Math.max(bw, bh) * (1 + 2 * pad), Math.min(S, Math.max(W, H)));
  side = Math.round(Math.min(side, Math.max(W, H)));
  const w = Math.min(side, W), h = Math.min(side, H);
  const cx = (b.x0 + b.x1 + 1) / 2, cy = (b.y0 + b.y1 + 1) / 2;
  const x = Math.round(Math.min(W - w, Math.max(0, cx - w / 2)));
  const y = Math.round(Math.min(H - h, Math.max(0, cy - h / 2)));
  return { x, y, w, h };
}

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function hashMask(m: Uint8Array) {
  let h = 2166136261;
  for (let i = 0; i < m.length; i++) if (m[i]) h = Math.imul(h ^ i, 16777619);
  return (h >>> 0).toString(36);
}

async function inpaintRegions(rgb: Float32Array, hole: Uint8Array, W: number, H: number, pad: number, margin: number): Promise<Patch[]> {
  // crops per component, merged while they overlap
  let rects = components(hole, W, H).map((b) => ({ b, r: cropFor(b, W, H, pad, margin) }));
  for (let merged = true; merged && rects.length > 1; ) {
    merged = false;
    outer: for (let i = 0; i < rects.length; i++)
      for (let j = i + 1; j < rects.length; j++) {
        if (!overlaps(rects[i].r, rects[j].r)) continue;
        const a = rects[i].b, c = rects[j].b;
        const b = { x0: Math.min(a.x0, c.x0), y0: Math.min(a.y0, c.y0), x1: Math.max(a.x1, c.x1), y1: Math.max(a.y1, c.y1) };
        rects.splice(j, 1);
        rects[i] = { b, r: cropFor(b, W, H, pad, margin) };
        merged = true;
        break outer;
      }
  }
  const prog = progress(`Remove Object (LaMa), region`);
  const patches: Patch[] = [];
  try {
    for (const [n, { r }] of rects.entries()) {
      prog.step(n, rects.length);
      const crop = new Float32Array(r.w * r.h * 3);
      const mcrop = new Float32Array(r.w * r.h * 3);
      for (let y = 0; y < r.h; y++) {
        crop.set(rgb.subarray(((r.y + y) * W + r.x) * 3, ((r.y + y) * W + r.x + r.w) * 3), y * r.w * 3);
        for (let x = 0; x < r.w; x++) mcrop[(y * r.w + x) * 3] = hole[(r.y + y) * W + r.x + x];
      }
      const img = resampleRGB(crop, r.w, r.h, S, S, 3);
      const msk = resampleRGB(mcrop, r.w, r.h, S, S, 3);
      const image = new Float32Array(3 * S * S);
      const mask = new Float32Array(S * S);
      for (let i = 0; i < S * S; i++) {
        image[i] = img[i * 3];
        image[S * S + i] = img[i * 3 + 1];
        image[2 * S * S + i] = img[i * 3 + 2];
        mask[i] = msk[i * 3] > 0.01 ? 1 : 0; // any coverage → fill
      }
      const res = await runModelMulti('lama', { image: { data: image, dims: [1, 3, S, S] }, mask: { data: mask, dims: [1, 1, S, S] } });
      const out = Object.values(res)[0].data;
      let mx = 0;
      for (let i = 0; i < out.length; i += 97) mx = Math.max(mx, out[i]);
      const k = mx > 2 ? 1 / 255 : 1; // the ports output 0..255
      for (let i = 0; i < out.length; i++) out[i] *= k;
      patches.push({ ...r, out });
    }
  } finally {
    prog.end();
  }
  return patches;
}

const inpaint = defineNode({
  id: 'ai.inpaint',
  name: 'Remove Object (LaMa)',
  category: 'AI',
  color: AI_COLOR,
  description:
    'Removes whatever the mask covers (white = remove) and fills it with plausible background, using the LaMa inpainting network locally in the browser (~93 MB, downloads once). ' +
    'Connect any mask: Paint Mask, Segment Anything / scene segmentation, Shape, Luma Range… Each separate region is cropped with surrounding context, inpainted at 512×512 and pasted back with a feathered edge. ' +
    'Results are cached per image + mask, so feather changes are instant.',
  tags: ['inpaint', 'inpainting', 'remove', 'object removal', 'eraser', 'heal', 'clone', 'content aware fill', 'lama', 'ai', 'retouch', 'scratch', 'blemish'],
  inputs: {
    image: { type: 'image', label: 'Image' },
    mask: { type: 'mask', label: 'Mask (white = remove)', optional: true, fallback: 'black' },
  },
  params: {
    dilate: { type: 'float', default: 6, min: 0, max: 64, step: 0.5, pixels: true, label: 'Grow mask', description: 'Expand the mask (px) so edges and shadows of the object go too.' },
    feather: { type: 'float', default: 4, min: 0, max: 64, step: 0.5, pixels: true, label: 'Feather', description: 'Soft blend (px) between the fill and the original around the mask.' },
    context: {
      type: 'float',
      default: 0.6,
      min: 0.1,
      max: 2,
      step: 0.05,
      label: 'Context',
      description: 'Crop padding around each region (× its size). More context helps big holes; less keeps more detail (the crop is processed at 512 px).',
    },
    threshold: { type: 'float', default: 0.5, min: 0.01, max: 0.99, step: 0.01, label: 'Mask threshold' },
    showMask: { type: 'bool', default: false, label: 'Show mask' },
  },
  cpuReadsInputs: true,
  cpu: async (ctx) => {
    const none = { fill: { width: 1, height: 1, data: new Uint8Array(4) } };
    const src = ctx.readInput('image');
    const mk = ctx.readInput('mask');
    if (!src || !mk) return none;
    const W = src.width, H = src.height;
    const bin = binaryMask(mk, W, H, Number(ctx.params.threshold ?? 0.5));
    if (!bin.some((v) => v)) return none;
    const dist = distance(bin, W, H);
    const dil = Math.max(0, Number(ctx.params.dilate ?? 6) * ctx.scale);
    const fea = Math.max(0.75, Number(ctx.params.feather ?? 4) * ctx.scale);
    const hole = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) hole[i] = dist[i] <= dil + 0.5 ? 1 : 0;
    const rgb = rgbOf(src);
    const { fp, size } = sizedFp(rgb, W, H);
    if (isFlat(fp)) return none;
    const pad = Number(ctx.params.context ?? 0.6);
    const margin = Math.ceil(fea);
    const patches = await memo.get(`lama:${size}:${pad}:${margin}:${hashMask(hole)}`, fp, Math.min(W, H), Math.min(W, H), () =>
      inpaintRegions(rgb, hole, W, H, pad, margin),
    );
    // compose: fill colour + blend alpha (1 inside the grown mask, feathered outside)
    const fill = new Uint8Array(W * H * 4);
    for (const p of patches) {
      const sx = S / p.w, sy = S / p.h;
      for (let y = p.y; y < p.y + p.h; y++) {
        for (let x = p.x; x < p.x + p.w; x++) {
          const i = y * W + x;
          const a = Math.min(1, Math.max(0, 1 - (dist[i] - dil) / fea));
          if (a <= 0 || a * 255 < fill[i * 4 + 3]) continue;
          // bilinear sample of the 512² result
          const fx = Math.min(S - 1, Math.max(0, (x - p.x + 0.5) * sx - 0.5));
          const fy = Math.min(S - 1, Math.max(0, (y - p.y + 0.5) * sy - 0.5));
          const x0 = Math.floor(fx), y0 = Math.floor(fy);
          const x1 = Math.min(S - 1, x0 + 1), y1 = Math.min(S - 1, y0 + 1);
          const tx = fx - x0, ty = fy - y0;
          for (let c = 0; c < 3; c++) {
            const o = c * S * S;
            const v =
              (p.out[o + y0 * S + x0] * (1 - tx) + p.out[o + y0 * S + x1] * tx) * (1 - ty) + (p.out[o + y1 * S + x0] * (1 - tx) + p.out[o + y1 * S + x1] * tx) * ty;
            fill[i * 4 + c] = Math.round(Math.min(1, Math.max(0, v)) * 255);
          }
          fill[i * 4 + 3] = Math.round(a * 255);
        }
      }
    }
    return { fill: { width: W, height: H, data: fill } };
  },
  passes: [
    {
      frag: /* glsl */ `
void main() {
  vec4 src = texture(u_image, v_uv);
  vec4 f = u_fill_size.x > 1.0 ? texture(u_fill, v_uv) : vec4(0.0);
  vec3 c = mix(src.rgb, f.rgb, f.a);
  if (u_showMask) c = mix(c, vec3(1.0, 0.1, 0.2), 0.45 * f.a);
  fragColor = vec4(c, src.a);
}`,
    },
  ],
});

export default [inpaint] satisfies NodeDef[];
