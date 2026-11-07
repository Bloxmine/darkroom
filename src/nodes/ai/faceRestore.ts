/**
 * Face Restoration (ai.faceRestore): RestoreFormer++ (default, Apache-2.0, 74 MB) or GFPGAN v1.4 (Apache-2.0,
 * 340 MB) in-browser. Pipeline per face:
 *   faces from the shared analysis (face-analysis.ts) → 5 points (eyes, nose tip, mouth corners) →
 *   least-squares similarity to the FFHQ 512 template → bilinear warp to 512×512 → restore →
 *   GPU inverse warp + blend with a feathered face mask (traced from the landmark oval, in crop space).
 * The restored crops live in an RGBA8 atlas (alpha = blend mask); the per-face affines travel to the shader
 * as float32 bit patterns in an RGBA8 data texture (exact, unlike RGBA16F).
 */
import '../../core/ai/models-face';
import { InferenceMemo } from '../../core/ai/image';
import { mpStatus } from '../../core/ai/mediapipe';
import { runModel, setAiTask } from '../../core/ai/runtime';
import { defineNode } from '../../core/registry';
import type { NodeDef, RawTex } from '../../core/types';
import { AI_COLOR } from './_shared';
import { analyzeFaces, texFingerprint } from './face-analysis';
import { grow } from './face-draw';
import { affineScale, FACE_OVAL, FFHQ_512, fivePoints, invertAffine, lmPx, similarity, type Affine, type Pt } from './face-geom';

const S = 512;
const MODEL_OPTS = ['RestoreFormer++ (74 MB)', 'GFPGAN v1.4 (340 MB)'];
const modelId = (v: unknown) => (v === MODEL_OPTS[1] ? 'gfpgan-v1.4' : 'restoreformer-pp');
/** Faces whose eyes are closer than this (full-res px) count as small. */
const SMALL_EYES = 24;
const MAX_ATLAS = 16;

interface Restored {
  atlas: RawTex;
  meta: RawTex;
  count: number;
}

const memo = new InferenceMemo<Restored>(4);

/** Bilinear sample of an RGBA float image (edge-clamped) → rgb. */
function sample(src: RawTex, x: number, y: number, out: Float32Array, o: number) {
  const W = src.width, H = src.height, d = src.data;
  const k = d instanceof Uint8Array ? 1 / 255 : 1;
  x = Math.min(W - 1, Math.max(0, x));
  y = Math.min(H - 1, Math.max(0, y));
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  for (let c = 0; c < 3; c++) {
    const a = d[(y0 * W + x0) * 4 + c], b = d[(y0 * W + x1) * 4 + c];
    const e = d[(y1 * W + x0) * 4 + c], f = d[(y1 * W + x1) * 4 + c];
    out[o + c] = Math.min(1, Math.max(0, ((a * (1 - fx) + b * fx) * (1 - fy) + (e * (1 - fx) + f * fx) * fy) * k));
  }
}

/** Warp `src` into a 512² crop with M (src px → crop px); returns NCHW in [-1, 1]. */
function warp(src: RawTex, M: Affine): Float32Array {
  const inv = invertAffine(M);
  const n = S * S;
  const t = new Float32Array(3 * n);
  const px = new Float32Array(3);
  for (let v = 0; v < S; v++) {
    for (let u = 0; u < S; u++) {
      const cx = u + 0.5, cy = v + 0.5;
      const x = inv[0] * cx + inv[1] * cy + inv[2] - 0.5, y = inv[3] * cx + inv[4] * cy + inv[5] - 0.5;
      sample(src, x, y, px, 0);
      const i = v * S + u;
      t[i] = px[0] * 2 - 1;
      t[n + i] = px[1] * 2 - 1;
      t[2 * n + i] = px[2] * 2 - 1;
    }
  }
  return t;
}

/** Separable box blur (3 passes ≈ gaussian) of a S×S float mask, radius r. */
function blurMask(m: Float32Array, r: number) {
  const tmp = new Float32Array(m.length);
  for (let pass = 0; pass < 3; pass++) {
    for (const horiz of [true, false]) {
      const src = horiz ? m : tmp, dst = horiz ? tmp : m;
      for (let a = 0; a < S; a++) {
        let acc = 0;
        const at = (b: number) => src[horiz ? a * S + Math.min(S - 1, Math.max(0, b)) : Math.min(S - 1, Math.max(0, b)) * S + a];
        for (let b = -r; b <= r; b++) acc += at(b);
        for (let b = 0; b < S; b++) {
          dst[horiz ? a * S + b : b * S + a] = acc / (2 * r + 1);
          acc += at(b + r + 1) - at(b - r);
        }
      }
    }
  }
}

/** Blend mask in crop space: the face oval (grown, forehead raised) or, without landmarks, a template ellipse. */
function cropMask(oval: Pt[] | null): Float32Array {
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(S, S) : Object.assign(document.createElement('canvas'), { width: S, height: S });
  const g = c.getContext('2d') as OffscreenCanvasRenderingContext2D;
  g.fillStyle = '#fff';
  g.beginPath();
  if (oval) {
    // raise the top of the oval (landmark 10 sits mid-forehead) and grow it a little
    const top = Math.min(...oval.map((p) => p[1]));
    const raised = oval.map((p): Pt => [p[0], p[1] - Math.max(0, 1 - (p[1] - top) / 120) * 28]);
    const pts = grow(raised, 1.06);
    g.moveTo(pts[0][0], pts[0][1]);
    for (const p of pts.slice(1)) g.lineTo(p[0], p[1]);
    g.closePath();
  } else g.ellipse(256, 285, 170, 225, 0, 0, Math.PI * 2);
  g.fill();
  const px = g.getImageData(0, 0, S, S).data;
  const m = new Float32Array(S * S);
  for (let i = 0; i < m.length; i++) m[i] = px[i * 4 + 3] / 255;
  // erode slightly before feathering so the blend ends inside the oval
  blurMask(m, 9);
  for (let i = 0; i < m.length; i++) m[i] = Math.min(1, Math.max(0, (m[i] - 0.35) / 0.65));
  blurMask(m, 6);
  // never reach the crop border
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) m[y * S + x] *= Math.min(1, Math.min(x, y, S - 1 - x, S - 1 - y) / 16);
  return m;
}

function packFloats(rows: number[][], width: number): RawTex {
  const h = Math.max(1, rows.length);
  const f = new Float32Array(width * h);
  rows.forEach((r, j) => r.forEach((v, i) => (f[j * width + i] = v)));
  return { width, height: h, data: new Uint8Array(f.buffer), filter: 'nearest' };
}

/**
 * Per-channel mean/std transfer (inside the blend mask) from the original crop to the restored one: the
 * restorers normalise skin tones, which shows against a graded photo.
 */
function matchColor(out: Float32Array, orig: Float32Array, mask: Float32Array) {
  const n = S * S;
  for (let c = 0; c < 3; c++) {
    let w = 0, mo = 0, mr = 0, vo = 0, vr = 0;
    for (let i = 0; i < n; i++) {
      const m = mask[i];
      if (m < 0.5) continue;
      w += m;
      mo += m * orig[c * n + i];
      mr += m * out[c * n + i];
    }
    if (w < 1) return;
    mo /= w;
    mr /= w;
    for (let i = 0; i < n; i++) {
      const m = mask[i];
      if (m < 0.5) continue;
      vo += m * (orig[c * n + i] - mo) ** 2;
      vr += m * (out[c * n + i] - mr) ** 2;
    }
    // keep the restored contrast mostly (it is the point), but follow the original's colour cast
    const k = Math.min(1.5, Math.max(0.67, Math.sqrt(vo / Math.max(vr, 1e-8))));
    const gain = 1 + (k - 1) * 0.5;
    for (let i = 0; i < n; i++) out[c * n + i] = (out[c * n + i] - mr) * gain + mo;
  }
}

async function restore(src: RawTex, scale: number, model: string, maxFaces: number, small: boolean, keepColor: boolean): Promise<Restored> {
  const A = await analyzeFaces(src, 0.5);
  const W = src.width, H = src.height;
  type Job = { pts: Pt[]; oval: Pt[] | null };
  const jobs: Job[] = [];
  for (const f of A.faces) jobs.push({ pts: fivePoints(f, W, H), oval: FACE_OVAL.map((i) => lmPx(f, i, W, H)) });
  for (const e of A.extra) jobs.push({ pts: e.kps.map(([x, y]): Pt => [x * W, y * H]), oval: null });
  const chosen = jobs
    .filter((j) => small || Math.hypot(j.pts[1][0] - j.pts[0][0], j.pts[1][1] - j.pts[0][1]) / scale >= SMALL_EYES)
    .slice(0, Math.min(MAX_ATLAS, maxFaces));
  if (!chosen.length) {
    mpStatus(jobs.length ? 'Face Restoration: only small faces found (enable “Include small faces”).' : 'Face Restoration: no faces found.');
    return { atlas: { width: 1, height: 1, data: new Uint8Array(4) }, meta: packFloats([], 8), count: 0 };
  }
  const cols = Math.min(4, chosen.length), rows = Math.ceil(chosen.length / cols);
  const AW = cols * S, AH = rows * S;
  const atlas = new Uint8Array(AW * AH * 4);
  const meta: number[][] = [];
  const task = `restore${Math.random()}`;
  try {
    for (let k = 0; k < chosen.length; k++) {
      setAiTask(task, { label: 'Restoring faces', done: k, total: chosen.length });
      const M = similarity(chosen[k].pts, FFHQ_512);
      const input = warp(src, M);
      const out = await runModel(model, { data: input.slice(), dims: [1, 3, S, S] });
      const mask = cropMask(chosen[k].oval ? chosen[k].oval!.map(([x, y]): Pt => [M[0] * x + M[1] * y + M[2], M[3] * x + M[4] * y + M[5]]) : null);
      const ox = (k % cols) * S, oy = Math.floor(k / cols) * S, n = S * S;
      if (keepColor) matchColor(out.data, input, mask);
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
          const i = y * S + x, o = ((oy + y) * AW + ox + x) * 4;
          for (let c = 0; c < 3; c++) atlas[o + c] = Math.round(Math.min(1, Math.max(0, (out.data[c * n + i] + 1) / 2)) * 255);
          atlas[o + 3] = Math.round(mask[i] * 255);
        }
      }
      // image uv → crop uv: crop_px = M · (uv · [W, H]); / 512
      meta.push([(M[0] * W) / S, (M[1] * H) / S, M[2] / S, (M[3] * W) / S, (M[4] * H) / S, M[5] / S, 1, k]);
      console.info(`[darkroom ai] face ${k + 1}: crop scale ${(1 / affineScale(M)).toFixed(2)} src px per crop px`);
    }
  } finally {
    setAiTask(task, null);
  }
  return { atlas: { width: AW, height: AH, data: atlas }, meta: packFloats(meta, 8), count: chosen.length };
}

const faceRestore = defineNode({
  id: 'ai.faceRestore',
  name: 'Face Restoration',
  category: 'AI',
  color: AI_COLOR,
  description:
    'Restores blurry, noisy or low-resolution faces with a neural network, locally in your browser. Each face is found (shared Face Detection), aligned to 512×512, ' +
    'restored, warped back and blended in with a feathered face mask. Model: RestoreFormer++ (Apache-2.0, ~74 MB download) or GFPGAN v1.4 (Apache-2.0, ~340 MB). ' +
    'Large downloads, once, then cached offline. Slow on CPU (several seconds per face); results are cached per image, so strength changes are instant. ' +
    'Faces larger than 512 px lose a little fine detail: lower the strength for those.',
  tags: ['face', 'restore', 'restoration', 'enhance', 'gfpgan', 'restoreformer', 'old photo', 'blurry', 'sharpen face', 'portrait', 'ai', 'ml'],
  inputs: { image: { type: 'image', label: 'Image' } },
  params: {
    strength: { type: 'float', default: 0.8, min: 0, max: 1, step: 0.01, label: 'Strength', description: 'Mix of the restored faces with the original.' },
    maxFaces: { type: 'int', default: 8, min: 1, max: MAX_ATLAS, step: 1, label: 'Max faces', description: 'Largest faces first.' },
    small: { type: 'bool', default: false, label: 'Include small faces', description: `Also restore faces whose eyes are under ${SMALL_EYES} px apart (more invented detail).` },
    model: { type: 'enum', default: MODEL_OPTS[0], options: MODEL_OPTS, label: 'Model' },
    keepColor: { type: 'bool', default: true, label: 'Keep original colours', description: 'Matches the restored faces to the photo’s colour cast and tone.' },
    showMask: { type: 'bool', default: false, label: 'Show blend mask' },
  },
  cpuReadsInputs: true,
  cpu: async (ctx) => {
    const src = ctx.readInput('image');
    if (!src) return { atlas: { width: 1, height: 1, data: new Uint8Array(4) }, meta: packFloats([], 8) };
    const model = modelId(ctx.params.model);
    const maxFaces = Math.max(1, Number(ctx.params.maxFaces) || 8);
    const small = !!ctx.params.small;
    const keepColor = ctx.params.keepColor !== false;
    const short = Math.min(src.width, src.height);
    const r = await memo.get(`${model}:${maxFaces}:${small}:${keepColor}`, texFingerprint(src), short, Math.round(short / ctx.scale), () => restore(src, ctx.scale, model, maxFaces, small, keepColor));
    return { atlas: r.atlas, meta: r.meta };
  },
  passes: [
    {
      frag: /* glsl */ `
float rdF(int i, int row) {
  uvec4 b = uvec4(round(texelFetch(u_meta, ivec2(i, row), 0) * 255.0));
  return uintBitsToFloat(b.r | (b.g << 8) | (b.b << 16) | (b.a << 24));
}
void main() {
  vec4 c = texture(u_image, v_uv);
  vec3 col = c.rgb;
  float shown = 0.0;
  int n = int(u_meta_size.y);
  vec2 grid = u_atlas_size / 512.0;
  for (int f = 0; f < ${MAX_ATLAS}; f++) {
    if (f >= n) break;
    if (rdF(6, f) < 0.5) continue;
    vec2 cuv = vec2(rdF(0, f) * v_uv.x + rdF(1, f) * v_uv.y + rdF(2, f), rdF(3, f) * v_uv.x + rdF(4, f) * v_uv.y + rdF(5, f));
    if (any(lessThan(cuv, vec2(0.0))) || any(greaterThan(cuv, vec2(1.0)))) continue;
    float slot = rdF(7, f);
    vec2 cell = vec2(mod(slot, grid.x), floor(slot / grid.x));
    vec2 auv = (cell + clamp(cuv, vec2(0.5 / 512.0), vec2(1.0 - 0.5 / 512.0))) / grid;
    vec4 r = texture(u_atlas, auv);
    col = mix(col, r.rgb, r.a * u_strength);
    shown = max(shown, r.a);
  }
  if (u_showMask) col = mix(col * 0.35, vec3(1.0, 0.3, 0.6), shown * 0.6);
  fragColor = vec4(col, c.a);
}`,
    },
  ],
});

export default [faceRestore] satisfies NodeDef[];
