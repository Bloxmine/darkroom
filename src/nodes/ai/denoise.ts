/**
 * AI Denoise: SCUNet (Swin-Conv-UNet, blind real-world denoising), tiled with overlapping, feathered
 * seams. The network output is recombined with the original in YCbCr with separate luma/chroma amounts
 * and an optional detail-recovery high-pass.
 */
import '../../core/ai/models-denoise';
import { InferenceMemo, throwIfAborted } from '../../core/ai/image';
import { runModel } from '../../core/ai/runtime';
import { defineNode } from '../../core/registry';
import type { NodeDef, RawTex } from '../../core/types';
import { progress, rgbOf, sizedFp } from './_img';
import { AI_COLOR } from './_shared';

const MODELS: [string, string][] = [
  ['Real-world, faithful (SCUNet PSNR)', 'scunet-real-psnr'],
  ['Real-world, sharper (SCUNet GAN)', 'scunet-real-gan'],
];
const memo = new InferenceMemo<RawTex>(4);
/** Input px shared by neighbouring tiles (the outer half of it is feathered away). */
const OVERLAP = 32;

/** Tile starts along an axis of n px, tiles of exactly `t` px (or one tile of n), overlapping ≥ OVERLAP. */
function layout(n: number, t: number): [number[], number] {
  if (n <= t) return [[0], n];
  const count = Math.ceil((n - OVERLAP) / (t - OVERLAP));
  return [Array.from({ length: count }, (_, i) => Math.round((i * (n - t)) / (count - 1))), t];
}

/** SCUNet's window attention needs both sides to be a multiple of 64 (8 px windows × 8 down-sampling). */
const ALIGN = 64;
const alignUp = (n: number) => Math.ceil(n / ALIGN) * ALIGN;

/** CHW crop of `tw×th` at (x0,y0), mirror-padded on the right/bottom to `pw×ph` (≥ tw×th). */
function paddedCrop(rgb: Float32Array, W: number, H: number, x0: number, y0: number, tw: number, th: number, pw: number, ph: number): Float32Array {
  const n = pw * ph;
  const out = new Float32Array(3 * n);
  const mirror = (v: number, lo: number, len: number, max: number) => {
    let d = v - lo;
    if (d >= len) d = Math.max(0, 2 * len - 2 - d); // reflect back into the valid tile
    return Math.min(max - 1, lo + Math.max(0, d));
  };
  for (let y = 0; y < ph; y++) {
    const sy = mirror(y0 + y, y0, th, H);
    for (let x = 0; x < pw; x++) {
      const sx = mirror(x0 + x, x0, tw, W);
      const s = (sy * W + sx) * 3;
      const o = y * pw + x;
      out[o] = rgb[s];
      out[n + o] = rgb[s + 1];
      out[2 * n + o] = rgb[s + 2];
    }
  }
  return out;
}

const ramp = (t: number) => (t >= 1 ? 1 : t <= 0 ? 0 : t * t * (3 - 2 * t));

/** Run the denoiser over the image in overlapping tiles; returns RGBA float at the input size. */
async function denoiseTiled(model: string, rgb: Float32Array, W: number, H: number, tile: number, label: string, signal?: AbortSignal): Promise<RawTex> {
  const acc = new Float32Array(W * H * 3);
  const wsum = new Float32Array(W * H);
  const [xs, tw] = layout(W, tile);
  const [ys, th] = layout(H, tile);
  const total = xs.length * ys.length;
  const prog = progress(label);
  let done = 0;
  prog.step(0, total);
  try {
    for (let ty = 0; ty < ys.length; ty++) {
      for (let tx = 0; tx < xs.length; tx++) {
        const x0 = xs[tx], y0 = ys[ty];
        // tiles smaller than the tile size (small images / preview) are padded to the model's alignment
        const pw = alignUp(tw), ph = alignUp(th);
        throwIfAborted(signal);
        const r = await runModel(model, { data: paddedCrop(rgb, W, H, x0, y0, tw, th, pw, ph), dims: [1, 3, ph, pw] });
        const n = pw * ph;
        // overlap with the neighbours on each side (0 at the image border)
        const ovL = tx > 0 ? xs[tx - 1] + tw - x0 : 0;
        const ovR = tx < xs.length - 1 ? x0 + tw - xs[tx + 1] : 0;
        const ovT = ty > 0 ? ys[ty - 1] + th - y0 : 0;
        const ovB = ty < ys.length - 1 ? y0 + th - ys[ty + 1] : 0;
        // feather over the inner part of the overlap; the outer 8 px (tile-border artefacts) get ~0 weight
        const edgeW = (d: number, ov: number) => (ov ? ramp((d + 0.5 - Math.min(8, ov / 4)) / Math.max(1, ov - Math.min(8, ov / 4))) + 1e-4 : 1);
        for (let y = 0; y < th; y++) {
          const wy = Math.min(edgeW(y, ovT), edgeW(th - 1 - y, ovB));
          for (let x = 0; x < tw; x++) {
            const w = wy * Math.min(edgeW(x, ovL), edgeW(tw - 1 - x, ovR));
            const s = y * pw + x;
            const p = (y0 + y) * W + x0 + x;
            acc[p * 3] += r.data[s] * w;
            acc[p * 3 + 1] += r.data[n + s] * w;
            acc[p * 3 + 2] += r.data[2 * n + s] * w;
            wsum[p] += w;
          }
        }
        prog.step(++done, total);
      }
    }
  } finally {
    prog.end();
  }
  const out = new Float32Array(W * H * 4);
  for (let p = 0; p < W * H; p++) {
    const k = 1 / Math.max(wsum[p], 1e-6);
    out[p * 4] = acc[p * 3] * k;
    out[p * 4 + 1] = acc[p * 3 + 1] * k;
    out[p * 4 + 2] = acc[p * 3 + 2] * k;
    out[p * 4 + 3] = 1;
  }
  return { width: W, height: H, data: out };
}

const denoise = defineNode({
  id: 'ai.denoise',
  name: 'AI Denoise',
  category: 'AI',
  color: AI_COLOR,
  description:
    'Neural noise reduction with SCUNet (blind real-world denoiser, Apache-2.0, ~77 MB, downloads once), running locally in your browser. ' +
    'Removes high-ISO luminance and colour noise while keeping edges and fine texture far better than a classic filter. ' +
    'The image is processed in overlapping tiles with feathered seams; the progress toast counts tiles. The preview denoises the preview-sized image, export runs at full resolution (slow on CPU: use WebGPU for big images). ' +
    'The result is mixed back in YCbCr: separate luma/colour amounts, plus detail recovery that re-adds some original fine texture. Cached per image, so the sliders are instant.',
  tags: ['denoise', 'noise reduction', 'high iso', 'grain removal', 'chroma noise', 'luminance noise', 'scunet', 'clean', 'restore', 'ai', 'ml'],
  inputs: { image: { type: 'image', label: 'Image' } },
  params: {
    model: { type: 'enum', default: MODELS[0][0], options: MODELS.map((m) => m[0]), label: 'Model', description: 'PSNR stays faithful to the photo; GAN is crisper but may invent a little texture.' },
    strength: { type: 'float', default: 1, min: 0, max: 1, step: 0.01, label: 'Strength', description: 'Mix with the original.' },
    luma: { type: 'float', default: 1, min: 0, max: 1, step: 0.01, label: 'Luminance', description: 'How much of the brightness noise to remove. Lower keeps a fine, film-like grain.' },
    chroma: { type: 'float', default: 1, min: 0, max: 1, step: 0.01, label: 'Colour', description: 'How much of the colour noise (blotches) to remove.' },
    detail: { type: 'float', default: 0.15, min: 0, max: 1, step: 0.01, label: 'Detail recovery', description: 'Re-add some fine original luminance texture where the denoised image has structure (avoids a plastic look).' },
    tile: {
      type: 'enum',
      default: '256',
      options: ['128', '192', '256', '384', '512'],
      label: 'Tile size',
      description: 'Input pixels per tile. Larger is faster on WebGPU but needs more memory; results are the same.',
    },
  },
  cpuReadsInputs: true,
  cpu: async (ctx) => {
    const src = ctx.readInput('image');
    if (!src) return { dn: { width: 1, height: 1, data: new Float32Array([0, 0, 0, 1]) } };
    const W = src.width, H = src.height;
    const rgb = rgbOf(src);
    const { fp, size } = sizedFp(rgb, W, H);
    const model = (MODELS.find((m) => m[0] === ctx.params.model) ?? MODELS[0])[1];
    const tile = Number(ctx.params.tile) || 256;
    const dn = await memo.get(
      `${model}:${size}:${tile}`, fp, Math.min(W, H), Math.min(W, H),
      (sig) => denoiseTiled(model, rgb, W, H, tile, `AI Denoise (${W}×${H}), tile`, sig),
      ctx.signal,
    );
    return { dn };
  },
  passes: [
    {
      // small gaussian (σ≈1 px) of the original and denoised luma, for the detail high-pass
      frag: /* glsl */ `
void main() {
  ivec2 p = ivec2(floor(v_uv * u_resolution));
  ivec2 mx = ivec2(u_image_size) - 1;
  ivec2 md = ivec2(u_dn_size) - 1;
  float ao = 0.0, ad = 0.0, ws = 0.0;
  for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
    float w = exp(-float(i * i + j * j) / 2.0);
    ao += luma601(texelFetch(u_image, clamp(p + ivec2(i, j), ivec2(0), mx), 0).rgb) * w;
    ad += luma601(texelFetch(u_dn, clamp(p + ivec2(i, j), ivec2(0), md), 0).rgb) * w;
    ws += w;
  }
  fragColor = vec4(ao / ws, ad / ws, 0.0, 1.0);
}`,
    },
    {
      frag: /* glsl */ `
void main() {
  vec4 o = texture(u_image, v_uv);
  vec3 d = clamp(texture(u_dn, v_uv).rgb, 0.0, 1.0);
  vec2 bl = texture(u_pass0, v_uv).rg;
  vec3 yo = rgb2ycbcr(clamp(o.rgb, 0.0, 1.0));
  vec3 yd = rgb2ycbcr(d);
  float kl = u_strength * u_luma, kc = u_strength * u_chroma;
  float y = mix(yo.x, yd.x, kl);
  vec2 c = mix(yo.yz, yd.yz, kc);
  // fine luma lost by the denoiser, re-added mostly where the clean image has structure
  float hp = (luma601(o.rgb) - bl.r) - (luma601(d) - bl.g);
  float g = smoothstep(0.004, 0.04, abs(luma601(d) - bl.g));
  y += u_detail * kl * hp * mix(0.3, 1.0, g);
  fragColor = vec4(ycbcr2rgb(vec3(y, c)), o.a);
}`,
    },
  ],
});

export default [denoise] satisfies NodeDef[];
