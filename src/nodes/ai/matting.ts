/**
 * High-quality background removal with BiRefNet lite (MIT), in the browser:
 *  - the matte comes from BiRefNet at 512² (the browser-sized export), and by default ("High detail")
 *    also from a 3×3 grid of overlapping 512² tiles of a 1280² version, used only in the global matte's
 *    edge band (so tiles can't add stray objects);
 *  - joint-bilateral refine against the image, threshold / softness;
 *  - `cutout`: RGBA with the matte as alpha and foreground colour decontamination: Blur-Fusion
 *    foreground estimation (Forte & Pitié, "Approximate fast foreground colour estimation", ICIP 2021),
 *    two iterations (large radius at ¼ resolution, then small radius), which removes the background's
 *    colour spill from semi-transparent hair and edges.
 */
import '../../core/ai/models-motion';
import { fingerprint, InferenceMemo, maskTex, resampleRGB, toCHW } from '../../core/ai/image';
import { BIREFNET_SIZE } from '../../core/ai/models-motion';
import { runModel, setAiTask } from '../../core/ai/runtime';
import { defineNode } from '../../core/registry';
import type { NodeDef, RawTex, ShaderPass } from '../../core/types';
import { isFlat } from './_img';
import { AI_COLOR, JBU_GLSL } from './_shared';

const RES = ['512', 'High detail (512 + 3×3 tiles)'];
const memo = new InferenceMemo<RawTex>(4);
const N = BIREFNET_SIZE;

async function birefnet(rgb: Float32Array): Promise<Float32Array> {
  const r = await runModel('birefnet-lite', { data: toCHW(rgb, N, N, [0.485, 0.456, 0.406], [0.229, 0.224, 0.225]), dims: [1, 3, N, N] });
  // the export ends in a sigmoid; guard against a logits export anyway
  let lo = Infinity;
  for (let i = 0; i < r.data.length; i += 997) lo = Math.min(lo, r.data[i]);
  if (lo < -1e-3) for (let i = 0; i < r.data.length; i++) r.data[i] = 1 / (1 + Math.exp(-r.data[i]));
  return r.data;
}

/** Bilinear resample of a single-channel map. */
function resample1(src: Float32Array, sw: number, sh: number, dw: number, dh: number): Float32Array {
  const out = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const fy = Math.min(sh - 1, Math.max(0, ((y + 0.5) * sh) / dh - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = Math.min(sw - 1, Math.max(0, ((x + 0.5) * sw) / dw - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
      const a = src[y0 * sw + x0] + (src[y0 * sw + x1] - src[y0 * sw + x0]) * tx;
      const b = src[y1 * sw + x0] + (src[y1 * sw + x1] - src[y1 * sw + x0]) * tx;
      out[y * dw + x] = a + (b - a) * ty;
    }
  }
  return out;
}

/** Edge band of a matte: 1 where a (2r+1)² neighbourhood has both background and foreground. */
function edgeBand(m: Float32Array, w: number, h: number, r: number): Float32Array {
  const lo = new Float32Array(w * h), hi = new Float32Array(w * h);
  // separable min / max
  const tmpLo = new Float32Array(w * h), tmpHi = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 1, b = 0;
    for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) {
      const v = m[y * w + k];
      if (v < a) a = v;
      if (v > b) b = v;
    }
    tmpLo[y * w + x] = a;
    tmpHi[y * w + x] = b;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 1, b = 0;
    for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) {
      if (tmpLo[k * w + x] < a) a = tmpLo[k * w + x];
      if (tmpHi[k * w + x] > b) b = tmpHi[k * w + x];
    }
    lo[y * w + x] = a;
    hi[y * w + x] = b;
  }
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const t = Math.min(1, Math.max(0, (hi[i] - lo[i] - 0.05) / 0.25));
    out[i] = t * t * (3 - 2 * t);
  }
  return out;
}

/** Tile grid of "High detail": K×K tiles of N² with 25 % overlap, covering an S² stretch of the image. */
const K = 3, STRIDE = (N * 3) / 4, S = N + (K - 1) * STRIDE, OV = N - STRIDE;

/** Global N² matte + K×K overlapping N² tiles of an S² stretch (linear ramps in the overlaps), merged in the edge band. */
async function tiledMatte(src: RawTex, global: Float32Array, signal: AbortSignal, step: (d: number) => void): Promise<{ data: Float32Array; size: number }> {
  const big = resampleRGB(src.data, src.width, src.height, S, S);
  const acc = new Float32Array(S * S), wsum = new Float32Array(S * S);
  let k = 0;
  const ramp = (p: number, first: boolean, last: boolean) => {
    // weight rises across the overlap on sides that have a neighbouring tile
    let w = 1;
    if (!first) w = Math.min(w, (p + 0.5) / OV);
    if (!last) w = Math.min(w, (N - p - 0.5) / OV);
    return Math.max(1e-3, Math.min(1, w));
  };
  for (let ty = 0; ty < K; ty++) for (let tx = 0; tx < K; tx++) {
    if (signal.aborted) throw new DOMException('Superseded', 'AbortError');
    const ox = tx * STRIDE, oy = ty * STRIDE;
    const tile = new Float32Array(N * N * 3);
    for (let y = 0; y < N; y++) tile.set(big.subarray(((oy + y) * S + ox) * 3, ((oy + y) * S + ox + N) * 3), y * N * 3);
    const m = await birefnet(tile);
    step(++k);
    for (let y = 0; y < N; y++) {
      const wy = ramp(y, ty === 0, ty === K - 1);
      for (let x = 0; x < N; x++) {
        const w = ramp(x, tx === 0, tx === K - 1) * wy, o = (oy + y) * S + ox + x;
        acc[o] += m[y * N + x] * w;
        wsum[o] += w;
      }
    }
  }
  const g = resample1(global, N, N, S, S);
  const band = resample1(edgeBand(global, N, N, 4), N, N, S, S);
  const out = new Float32Array(S * S);
  for (let i = 0; i < S * S; i++) out[i] = g[i] + (acc[i] / Math.max(wsum[i], 1e-6) - g[i]) * band[i];
  return { data: out, size: S };
}

/** Low-res matte (value in .r) of an RGBA float image; memoised by content. Exported for other nodes. */
export function birefnetMatte(src: RawTex, tiled: boolean, signal?: AbortSignal): Promise<RawTex> {
  const rgb = resampleRGB(src.data, src.width, src.height, N, N);
  const fp = fingerprint(rgb, N, N);
  const need = tiled ? S : N;
  return memo.get(tiled ? 'birefnet:tiled' : 'birefnet', fp, Math.min(src.width, src.height), Math.min(need, Math.min(src.width, src.height)), async (sig) => {
    const id = 'matte' + (tiled ? 'T' : '');
    const total = tiled ? 1 + K * K : 1;
    setAiTask(id, { label: 'Background Removal (BiRefNet)', done: 0, total });
    try {
      const global = await birefnet(rgb);
      setAiTask(id, { label: 'Background Removal (BiRefNet)', done: 1, total });
      if (!tiled) return maskTex(global, N, N);
      const t = await tiledMatte(src, global, sig, (d) => setAiTask(id, { label: 'Background Removal (BiRefNet)', done: 1 + d, total }));
      return maskTex(t.data, t.size, t.size);
    } finally {
      setAiTask(id, null);
    }
  }, signal);
}

// --- GPU passes ---------------------------------------------------------------------------------------
const quarter = (c: { width: number; height: number }): [number, number] => [Math.max(1, Math.ceil(c.width / 4)), Math.max(1, Math.ceil(c.height / 4))];

/**
 * Separable gaussian blur pass of premultiplied (value·weight, weight). `src` is a GLSL expression of
 * `uv` giving vec4(rgb·w, w) for the horizontal pass; the vertical pass reads u_prev.
 */
function blurPass(vertical: boolean, src: string, radius: string, size?: ShaderPass['size']): ShaderPass {
  return {
    size,
    frag: /* glsl */ `
vec4 srcAt(vec2 uv) { return ${vertical ? 'texture(u_prev, uv)' : src}; }
void main() {
  float r = max(${radius}, 0.5);
  int n = int(min(ceil(r), 24.0));
  float stp = r / float(n), sig = r * 0.5;
  vec2 dir = ${vertical ? 'vec2(0.0, 1.0)' : 'vec2(1.0, 0.0)'} / u_resolution;
  vec4 acc = vec4(0.0);
  float ws = 0.0;
  for (int i = -24; i <= 24; i++) {
    if (i < -n || i > n) continue;
    float x = float(i) * stp;
    float w = exp(-x * x / (2.0 * sig * sig));
    acc += srcAt(v_uv + dir * x) * w; ws += w;
  }
  fragColor = acc / ws;
}`,
  };
}

/** Blur-Fusion step: from blurred (F·α, α) and (B·(1−α), 1−α), the foreground (out F) or background (out B) estimate. */
function fusePass(fPass: number, bPass: number, out: 'F' | 'B'): ShaderPass {
  return {
    frag: /* glsl */ `
void main() {
  vec3 I = texture(u_image, v_uv).rgb;
  float a = clamp(texture(u_pass1, v_uv).r, 0.0, 1.0);
  vec4 f = texture(u_pass${fPass}, v_uv), b = texture(u_pass${bPass}, v_uv);
  vec3 F = f.a > 1e-4 ? f.rgb / f.a : I;
  vec3 B = b.a > 1e-4 ? b.rgb / b.a : I;
  vec3 r = I - a * F - (1.0 - a) * B;
  vec3 o = ${out === 'F' ? 'F + a * r' : 'B + (1.0 - a) * r'};
  fragColor = vec4(clamp(o, 0.0, 1.0), 1.0);
}`,
  };
}

const ALPHA = 'clamp(texture(u_pass1, uv).r, 0.0, 1.0)';

const matte = defineNode({
  id: 'ai.matte',
  name: 'Background Removal (BiRefNet)',
  category: 'AI',
  color: AI_COLOR,
  description:
    'Cuts out the main subject with BiRefNet lite (dichotomous segmentation, MIT, ~98 MB download once), locally in the browser. ' +
    '`mask` is a soft matte with hair-level detail; `cutout` is the image with that matte as alpha and the background colour removed from semi-transparent edges (decontamination). ' +
    'High detail adds a 3×3 grid of 512² tiles (a 1280² pass) along the edges (10× the work).',
  tags: ['background removal', 'remove background', 'cutout', 'matte', 'matting', 'birefnet', 'hair', 'segmentation', 'transparent', 'ai', 'ml', 'mask'],
  inputs: { image: { type: 'image', label: 'Image' } },
  outputs: { mask: { type: 'mask', label: 'Mask' }, cutout: { type: 'image', label: 'Cutout (RGBA)' } },
  params: {
    resolution: { type: 'enum', default: RES[0], options: RES, label: 'Resolution', description: 'BiRefNet runs at 512²; High detail adds 3×3 tiles of a 1280² version, used along the edges of the 512² matte.' },
    refine: { type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, label: 'Edge refine', description: 'Edge-aware upsampling against the image.' },
    threshold: { type: 'float', default: 0.5, min: 0, max: 1, step: 0.005, label: 'Threshold' },
    softness: { type: 'float', default: 1, min: 0, max: 1, step: 0.005, label: 'Softness', description: '1 = keep the soft matte, 0 = hard cut at the threshold.' },
    decontaminate: { type: 'float', default: 1, min: 0, max: 1, step: 0.01, label: 'Colour decontamination', description: 'Replace edge colours by the estimated foreground colour (removes background spill).' },
    spillRadius: { type: 'float', default: 90, min: 10, max: 300, step: 1, pixels: true, label: 'Decontamination radius (px)' },
    invert: { type: 'bool', default: false, label: 'Invert mask', description: 'Mask output only: select the background.' },
  },
  cpuReadsInputs: true,
  cpu: async (ctx) => {
    const src = ctx.readInput('image');
    if (!src) return { matte: maskTex([1], 1, 1) };
    const fp = fingerprint(resampleRGB(src.data, src.width, src.height, 64, 64), 64, 64);
    if (isFlat(fp)) return { matte: maskTex([1], 1, 1) };
    return { matte: await birefnetMatte(src, ctx.params.resolution === RES[1], ctx.signal) };
  },
  passes: [
    // 0: guide at the matte resolution
    {
      size: (c) => [Math.min(c.width, 1280), Math.min(c.height, 1280)],
      frag: /* glsl */ `
void main() {
  vec3 acc = vec3(0.0);
  for (int j = 0; j < 3; j++) for (int i = 0; i < 3; i++) acc += texture(u_image, v_uv + (vec2(float(i), float(j)) - 1.0) / (u_resolution * 3.0)).rgb;
  fragColor = vec4(acc / 9.0, 1.0);
}`,
    },
    // 1: alpha (refine + threshold/softness)
    {
      frag: /* glsl */ `
${JBU_GLSL}
void main() {
  float m = u_refine <= 0.0 ? texture(u_matte, v_uv).r : jbu(u_matte, u_matte_size, u_pass0, u_refine, 0.1);
  float lo = u_threshold - u_softness * 0.5, hi = u_threshold + u_softness * 0.5;
  m = clamp((m - lo) / max(hi - lo, 1e-3), 0.0, 1.0);
  fragColor = vec4(vec3(m), 1.0);
}`,
    },
    // 2: mask output
    { output: 'mask', frag: `void main(){ float m = texture(u_pass1, v_uv).r; if (u_invert) m = 1.0 - m; fragColor = vec4(vec3(m), 1.0); }` },
    // 3–7: Blur-Fusion iteration 1 (large radius, ¼ resolution)
    blurPass(false, `vec4(texture(u_image, uv).rgb * ${ALPHA}, ${ALPHA})`, 'u_spillRadius * u_scale * 0.25', quarter),
    blurPass(true, '', 'u_spillRadius * u_scale * 0.25', quarter),
    blurPass(false, `vec4(texture(u_image, uv).rgb * (1.0 - ${ALPHA}), 1.0 - ${ALPHA})`, 'u_spillRadius * u_scale * 0.25', quarter),
    blurPass(true, '', 'u_spillRadius * u_scale * 0.25', quarter),
    fusePass(4, 6, 'F'), // 7: F1
    fusePass(4, 6, 'B'), // 8: B1
    // 9–12: iteration 2 (small radius, full resolution) on F1 / B1
    blurPass(false, `vec4(texture(u_pass7, uv).rgb * ${ALPHA}, ${ALPHA})`, 'max(6.0 * u_scale, 1.0)'),
    blurPass(true, '', 'max(6.0 * u_scale, 1.0)'),
    blurPass(false, `vec4(texture(u_pass8, uv).rgb * (1.0 - ${ALPHA}), 1.0 - ${ALPHA})`, 'max(6.0 * u_scale, 1.0)'),
    blurPass(true, '', 'max(6.0 * u_scale, 1.0)'),
    // 13: cutout
    {
      output: 'cutout',
      frag: /* glsl */ `
void main() {
  vec3 I = texture(u_image, v_uv).rgb;
  float a = clamp(texture(u_pass1, v_uv).r, 0.0, 1.0);
  vec4 f = texture(u_pass10, v_uv), b = texture(u_pass12, v_uv);
  vec3 F = f.a > 1e-4 ? f.rgb / f.a : I;
  vec3 B = b.a > 1e-4 ? b.rgb / b.a : I;
  vec3 fg = clamp(F + a * (I - a * F - (1.0 - a) * B), 0.0, 1.0);
  fragColor = vec4(mix(I, fg, u_decontaminate), a);
}`,
    },
  ],
});

export default [matte] satisfies NodeDef[];
