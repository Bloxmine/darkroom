/**
 * Frame interpolation with RIFE 4.25 lite (MIT), in the browser:
 *  - `ai.frameInterp` "Frame Interpolation (RIFE)": the frame at time t between two images/frames;
 *  - `ai.videoSlowMo` "Smooth Slow Motion (RIFE)": a Video source whose in-between times (speed < 1,
 *    or the export's "smooth slow motion" option, which swaps core.video for this node) are filled with
 *    interpolated frames instead of repeated ones. Decoded frames are cached, so a ×4 slow motion
 *    decodes each source frame once and runs RIFE three times per source frame.
 */
import '../../core/ai/models-motion';
import { resampleRGB } from '../../core/ai/image';
import { runModelMulti } from '../../core/ai/runtime';
import { defineNode } from '../../core/registry';
import type { NodeDef, Params, RawTex } from '../../core/types';
import { sourceTime } from '../../core/video';
import { AI_COLOR } from './_shared';
import { BICUBIC_GLSL } from './_img';
import { hashPixels } from './flowMath';
import { placeholder, privateDecoder, SAMPLE_SRC, VIDEO_PARAMS, videoSize } from './flowSource';
import { cropToRGBA8, inferenceDims, padToCHW, padUp, rifeTimestep, timestepBetween } from './interpMath';

const RES = ['Full', '1080', '720', '540'];
const maxShort = (p: Params) => (p.resolution === 'Full' || !p.resolution ? 0 : Number(p.resolution) || 0);

/** RIFE at timestep t between two RGB HWC images of w×h → RGBA8 w×h. */
export async function rife(a: Float32Array, b: Float32Array, w: number, h: number, t: number): Promise<Uint8Array> {
  const pw = padUp(w), ph = padUp(h);
  const r = await runModelMulti(
    'rife-4.25-lite',
    {
      img0: { data: padToCHW(a, w, h, pw, ph), dims: [1, 3, ph, pw] },
      img1: { data: padToCHW(b, w, h, pw, ph), dims: [1, 3, ph, pw] },
      timestep: { data: new Float32Array([t]), dims: [1, 1, 1, 1] },
    },
    ['frame'],
  );
  if (!r.frame) throw new Error('RIFE: no output');
  return cropToRGBA8(r.frame.data, pw, ph, w, h);
}

const memo = new Map<string, Promise<Uint8Array>>();
function memoRife(key: string, run: () => Promise<Uint8Array>) {
  let p = memo.get(key);
  if (!p) {
    p = run();
    p.catch(() => memo.delete(key));
    memo.set(key, p);
    while (memo.size > 6) memo.delete(memo.keys().next().value!);
  }
  return p;
}

const empty = (): RawTex => ({ width: 1, height: 1, data: new Uint8Array([0, 0, 0, 0]) });

const frameInterp = defineNode({
  id: 'ai.frameInterp',
  name: 'Frame Interpolation (RIFE)',
  category: 'AI',
  color: AI_COLOR,
  description:
    'Synthesises the in-between frame at time t between frame A (t = 0) and frame B (t = 1) with RIFE 4.25 lite (~23 MB), locally in the browser. ' +
    'Objects move along their estimated motion instead of cross-fading. For video slow motion use the Smooth Slow Motion source or File › Export Video › Smooth slow motion.',
  tags: ['frame interpolation', 'rife', 'in-between', 'tween', 'slow motion', 'morph', 'video', 'ai', 'ml'],
  inputs: { a: { type: 'image', label: 'Frame A (t = 0)' }, b: { type: 'image', label: 'Frame B (t = 1)' } },
  params: {
    t: { type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Time (t)' },
    resolution: { type: 'enum', default: '1080', options: RES, label: 'Max inference size', description: 'Short side the frames are scaled down to for RIFE (Full = no scaling).' },
  },
  cpuReadsInputs: true,
  cpu: async (ctx) => {
    const step = rifeTimestep(Number(ctx.params.t ?? 0.5));
    if (step.kind !== 'mid') return { mid: empty() };
    const A = ctx.readInput('a'), B = ctx.readInput('b');
    if (!A || !B) return { mid: empty() };
    const [w, h] = inferenceDims(A.width, A.height, maxShort(ctx.params));
    const a = resampleRGB(A.data, A.width, A.height, w, h);
    const b = resampleRGB(B.data, B.width, B.height, w, h);
    const key = `${hashPixels(a, 5)}|${hashPixels(b, 5)}|${step.t.toFixed(4)}|${w}x${h}`;
    const data = await memoRife(key, () => rife(a, b, w, h, step.t));
    return { mid: { width: w, height: h, data } satisfies RawTex };
  },
  passes: [
    {
      frag: /* glsl */ `
${BICUBIC_GLSL}
void main() {
  if (u_mid_size.x < 2.0) { fragColor = u_t < 0.5 ? texture(u_a, v_uv) : texture(u_b, v_uv); return; }
  vec2 r = u_mid_size / u_resolution;
  vec3 c = max(r.x, r.y) > 1.01 ? texture(u_mid, v_uv).rgb : clamp(bicubic(u_mid, u_mid_size, v_uv).rgb, 0.0, 1.0);
  fragColor = vec4(c, 1.0);
}`,
    },
  ],
});

// --- Smooth Slow Motion video source ------------------------------------------------------------------
interface Grab { asset: string; ts: number; dur: number; w: number; h: number; rgb: Float32Array }
const grabs: Grab[] = [];
let canvas: OffscreenCanvas | null = null;

/** Decoded frame → RGB HWC at w×h (via a 2D canvas, which also scales). */
function grab(frame: VideoFrame, asset: string, w: number, h: number, fps: number): Grab {
  if (!canvas || canvas.width !== w || canvas.height !== h) canvas = new OffscreenCanvas(w, h);
  const g = canvas.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(frame, 0, 0, w, h);
  const px = g.getImageData(0, 0, w, h).data;
  const rgb = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    rgb[i * 3] = px[i * 4] / 255;
    rgb[i * 3 + 1] = px[i * 4 + 1] / 255;
    rgb[i * 3 + 2] = px[i * 4 + 2] / 255;
  }
  const ts = frame.timestamp / 1e6;
  const dur = frame.duration ? frame.duration / 1e6 : 1 / fps;
  const e: Grab = { asset, ts, dur, w, h, rgb };
  grabs.unshift(e);
  if (grabs.length > 6) grabs.length = 6;
  return e;
}

const toRaw = (g: Grab): RawTex => {
  const d = new Uint8Array(g.w * g.h * 4);
  for (let i = 0; i < g.w * g.h; i++) {
    d[i * 4] = Math.round(g.rgb[i * 3] * 255);
    d[i * 4 + 1] = Math.round(g.rgb[i * 3 + 1] * 255);
    d[i * 4 + 2] = Math.round(g.rgb[i * 3 + 2] * 255);
    d[i * 4 + 3] = 255;
  }
  return { width: g.w, height: g.h, data: d };
};

/** Statistics for tests / the export report. */
export const slowMoStats = { decoded: 0, interpolated: 0, exact: 0 };

const slowMo = defineNode({
  id: 'ai.videoSlowMo',
  name: 'Smooth Slow Motion (RIFE)',
  category: 'Input',
  color: AI_COLOR,
  description:
    'A Video source for slow motion: with Speed below 1 the in-between times are filled with frames synthesised by RIFE (frame interpolation) instead of repeated frames. ' +
    'Speed 0.5 = ×2 slow motion, 0.25 = ×4. Each interpolated frame takes one RIFE run (≈0.1–0.5 s on WebGPU), so play with Every frame or export. ' +
    'File › Export Video › Smooth slow motion uses this source automatically.',
  tags: ['slow motion', 'slowmo', 'frame interpolation', 'rife', 'video', 'smooth', 'fps', 'input', 'ai'],
  inputs: {},
  params: {
    ...VIDEO_PARAMS,
    speed: { ...VIDEO_PARAMS.speed, default: 0.5 },
    resolution: { type: 'enum', default: 'Full', options: RES, label: 'Max inference size', description: 'Short side for RIFE (lower = faster, softer).' },
  },
  volatile: 'time',
  size: videoSize,
  cpu: async ({ params, getAsset, time }) => {
    const a = getAsset(String(params.asset ?? ''));
    const dec = privateDecoder(a, 'slowmo');
    if (!dec || !a?.width || !a.height) return { src: placeholder() };
    const fps = a.fps || 30;
    const [w, h] = inferenceDims(a.width, a.height, maxShort(params));
    const s = sourceTime(params, a, time ?? 0);
    const covers = (g: Grab) => g.asset === a.id && g.w === w && g.h === h && g.ts <= s + 1e-6 && s < g.ts + g.dur - 1e-6;
    let f0 = grabs.find(covers);
    if (!f0) {
      const fr = await dec.frameAt(s);
      if (!fr) return { src: placeholder() };
      f0 = grab(fr, a.id, w, h, fps);
      slowMoStats.decoded++;
    }
    const step = rifeTimestep(timestepBetween(s, f0.ts, f0.dur, fps));
    if (step.kind === 'a') {
      slowMoStats.exact++;
      return { src: toRaw(f0) };
    }
    const next = f0.ts + f0.dur;
    let f1 = grabs.find((g) => g.asset === a.id && g.w === w && g.h === h && Math.abs(g.ts - next) < f0.dur * 0.5);
    if (!f1) {
      const fr = await dec.frameAt(next + 1e-4);
      if (fr && fr.timestamp / 1e6 > f0.ts + 1e-6) {
        f1 = grab(fr, a.id, w, h, fps);
        slowMoStats.decoded++;
      }
    }
    if (!f1) return { src: toRaw(f0) }; // end of the clip
    if (step.kind === 'b') return { src: toRaw(f1) };
    const key = `${a.id}|${f0.ts.toFixed(5)}|${step.t.toFixed(4)}|${w}x${h}`;
    const g0 = f0, g1 = f1;
    const data = await memoRife(key, () => rife(g0.rgb, g1.rgb, w, h, step.t));
    slowMoStats.interpolated++;
    return { src: { width: w, height: h, data } satisfies RawTex };
  },
  passes: [{ frag: SAMPLE_SRC + `void main(){ fragColor = vec4(sampleSrc(v_uv).rgb, 1.0); }` }],
});

export default [frameInterp, slowMo] satisfies NodeDef[];
