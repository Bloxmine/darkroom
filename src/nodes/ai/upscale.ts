/** AI super-resolution (Real-ESRGAN), tiled with feathered seams. */
import { InferenceMemo } from '../../core/ai/image';
import { runModel } from '../../core/ai/runtime';
import { defineNode } from '../../core/registry';
import type { NodeDef, Params, RawTex } from '../../core/types';
import { BICUBIC_GLSL, cropCHW, isFlat, progress, rgbOf, sizedFp } from './_img';
import { AI_COLOR } from './_shared';

const MODELS = ['General photo (Real-ESRGAN x4v3)', 'Anime / illustration (Real-ESRGAN x4plus anime)'];
const memo = new InferenceMemo<RawTex>(4);
const OVERLAP = 16; // input px shared by neighbouring tiles
const factorOf = (p: Params) => (p.factor === '2×' ? 2 : 4);
const denoiseOf = (p: Params) => Math.min(1, Math.max(0, Number(p.denoise ?? 0.5)));

/**
 * Which model outputs the denoise setting needs, and their blend weights.
 * x4v3 = denoise 1, dn50 (official 50/50 weight blend with wdn-x4v3) = 0.5; between them we blend the outputs,
 * below 0.5 we extrapolate past dn50 (≈ the weak-denoise wdn model).
 */
function mixOf(p: Params): { a: number; b: number } {
  if (p.model === MODELS[1]) return { a: 1, b: 0 };
  const s = denoiseOf(p);
  if (s >= 0.5) return { a: (s - 0.5) * 2, b: 1 - (s - 0.5) * 2 };
  const e = (0.5 - s) * 2;
  return { a: -e, b: 1 + e };
}

/** Evenly spread tiles of at most `t` px with ≥ OVERLAP px shared: [starts, tile size]. */
function layout(n: number, t: number): [number[], number] {
  if (n <= t) return [[0], n];
  const count = Math.ceil((n - OVERLAP) / (t - OVERLAP));
  const size = Math.min(t, Math.ceil((n + (count - 1) * OVERLAP) / count));
  return [Array.from({ length: count }, (_, i) => Math.min(n - size, Math.round((i * (n - size)) / (count - 1)))), size];
}

/** Run a x4 model over the image in overlapping tiles; returns RGBA8 at `factor`× (2× = 4× box-downsampled per tile). */
async function upscaleTiled(model: string, rgb: Float32Array, W: number, H: number, factor: number, tile: number, label: string): Promise<RawTex> {
  const F = factor;
  const OW = W * F, OH = H * F;
  const out = new Uint8Array(OW * OH * 4);
  const [xs, tw] = layout(W, tile);
  const [ys, th] = layout(H, tile);
  const prog = progress(label);
  const total = xs.length * ys.length;
  let done = 0;
  prog.step(0, total);
  try {
    for (let ty = 0; ty < ys.length; ty++) {
      for (let tx = 0; tx < xs.length; tx++) {
        const x0 = xs[tx], y0 = ys[ty];
        const r = await runModel(model, { data: cropCHW(rgb, W, x0, y0, tw, th), dims: [1, 3, th, tw] });
        const [mh, mw] = r.dims.slice(-2);
        const s = mw / tw; // model scale (4)
        const n = mw * mh;
        // overlap with the previous tile (left / top), in output px
        const ovx = tx > 0 ? (xs[tx - 1] + tw - x0) * F : 0;
        const ovy = ty > 0 ? (ys[ty - 1] + th - y0) * F : 0;
        const pw = tw * F, ph = th * F;
        const k = s / F; // model px per output px (2 for 2×, 1 for 4×)
        for (let y = 0; y < ph; y++) {
          const wy = ovy ? smooth((y + 0.5) / ovy) : 1;
          const oy = y0 * F + y;
          for (let x = 0; x < pw; x++) {
            const wx = ovx ? smooth((x + 0.5) / ovx) : 1;
            const w = wx * wy;
            if (w <= 0) continue;
            let rr = 0, gg = 0, bb = 0;
            // box filter over k×k model pixels
            for (let j = 0; j < k; j++) {
              const row = (y * k + j) * mw + x * k;
              for (let i = 0; i < k; i++) {
                rr += r.data[row + i];
                gg += r.data[n + row + i];
                bb += r.data[2 * n + row + i];
              }
            }
            const q = 255 / (k * k);
            const o = (oy * OW + x0 * F + x) * 4;
            const R = clamp255(rr * q), G = clamp255(gg * q), B = clamp255(bb * q);
            if (w >= 1) {
              out[o] = R;
              out[o + 1] = G;
              out[o + 2] = B;
            } else {
              out[o] = out[o] + (R - out[o]) * w + 0.5;
              out[o + 1] = out[o + 1] + (G - out[o + 1]) * w + 0.5;
              out[o + 2] = out[o + 2] + (B - out[o + 2]) * w + 0.5;
            }
            out[o + 3] = 255;
          }
        }
        prog.step(++done, total);
      }
    }
  } finally {
    prog.end();
  }
  return { width: OW, height: OH, data: out };
}

const smooth = (t: number) => (t >= 1 ? 1 : t <= 0 ? 0 : t * t * (3 - 2 * t));
const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

const upscale = defineNode({
  id: 'ai.upscale',
  name: 'AI Upscale',
  category: 'AI',
  color: AI_COLOR,
  description:
    'Super-resolution with Real-ESRGAN, running locally in the browser: enlarges 2× or 4× and reconstructs detail instead of just interpolating. ' +
    'Large images are processed in overlapping tiles with feathered seams; the progress toast counts tiles. ' +
    'The preview upscales the preview-sized image (fast); export runs at full resolution. ' +
    'General x4v3 (~2.4–4.9 MB) for photos with a denoise control; anime 6B (~9–18 MB) for drawings. Results are cached per image, size and model.',
  tags: ['upscale', 'super resolution', 'enlarge', 'esrgan', 'real-esrgan', 'resize', 'ai', 'ml', 'enhance', 'sharpen', '2x', '4x'],
  inputs: { image: { type: 'image', label: 'Image' } },
  params: {
    model: { type: 'enum', default: MODELS[0], options: MODELS, label: 'Model' },
    factor: { type: 'enum', default: '4×', options: ['2×', '4×'], label: 'Scale', description: '2× runs the 4× model and downsamples (sharper than a native 2× model).' },
    denoise: {
      type: 'float',
      default: 0.5,
      min: 0,
      max: 1,
      step: 0.01,
      label: 'Denoise',
      description:
        'General model only. 1 = strong denoise (x4v3), 0.5 = official default (x4v3/wdn blend), lower keeps more grain and texture. Values other than 0.5 and 1 run both models.',
    },
    amount: { type: 'float', default: 1, min: 0, max: 1, step: 0.01, label: 'Amount', description: 'Blend with a plain bicubic enlargement.' },
    tile: {
      type: 'enum',
      default: '256',
      options: ['128', '192', '256', '384', '512'],
      label: 'Tile size',
      description: 'Input pixels per tile. Larger is faster on WebGPU but needs more memory.',
    },
  },
  size: ({ params, inputSizes, projectSize }) => {
    const s = inputSizes.image ?? projectSize;
    const f = factorOf(params);
    return [s.width * f, s.height * f];
  },
  cpuReadsInputs: true,
  cpu: async (ctx) => {
    const src = ctx.readInput('image');
    const one = { width: 1, height: 1, data: new Uint8Array([0, 0, 0, 255]) };
    if (!src) return { upA: one, upB: one };
    const W = src.width, H = src.height;
    const rgb = rgbOf(src);
    const { fp, size } = sizedFp(rgb, W, H);
    if (isFlat(fp)) return { upA: one, upB: one }; // nothing to reconstruct (or upstream still pending)
    const F = factorOf(ctx.params);
    const tile = Number(ctx.params.tile) || 256;
    const mix = mixOf(ctx.params);
    const anime = ctx.params.model === MODELS[1];
    const run = (model: string) =>
      memo.get(`${model}:${size}:${F}x:${tile}`, fp, Math.min(W, H), Math.min(W, H), () =>
        upscaleTiled(model, rgb, W, H, F, tile, `AI Upscale ${F}× (${W}×${H}), tile`),
      );
    const a = mix.a !== 0 ? await run(anime ? 'realesrgan-x4plus-anime' : 'realesr-general-x4v3') : one;
    const b = mix.b !== 0 ? await run('realesr-general-x4v3-dn50') : one;
    return { upA: a, upB: b };
  },
  passes: [
    {
      uniforms: (c) => {
        const m = mixOf(c.params);
        return { u_wA: m.a, u_wB: m.b };
      },
      frag: /* glsl */ `
uniform float u_wA;
uniform float u_wB;
${BICUBIC_GLSL}
void main() {
  vec4 base = bicubic(u_image, u_image_size, v_uv);
  vec3 ai = vec3(0.0);
  if (u_wA != 0.0) ai += texture(u_upA, v_uv).rgb * u_wA;
  if (u_wB != 0.0) ai += texture(u_upB, v_uv).rgb * u_wB;
  vec3 c = mix(clamp(base.rgb, 0.0, 1.0), clamp(ai, 0.0, 1.0), u_amount);
  fragColor = vec4(c, clamp(base.a, 0.0, 1.0));
}`,
    },
  ],
});

export default [upscale] satisfies NodeDef[];
