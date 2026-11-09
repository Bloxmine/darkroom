/**
 * Effects driven by an optical-flow field (the `flow` output of ai.opticalFlow; see flowMath.ts for
 * the encoding): motion blur along the flow, warping by the flow, and datamosh (P-frame smearing).
 * Category "Motion".
 */
import { fingerprint, resampleRGB } from '../../core/ai/image';
import { defineNode } from '../../core/registry';
import type { CpuContext, NodeDef, RawTex } from '../../core/types';
import { blockFlow, warpByFlow } from './flowMath';

const MOTION_COLOR = '#d98b4a';

const motionBlur = defineNode({
  id: 'effects.flowMotionBlur',
  name: 'Flow Motion Blur',
  category: 'Motion',
  color: MOTION_COLOR,
  description:
    'Directional blur along per-pixel motion vectors (connect the `flow` output of Optical Flow). ' +
    'Shutter angle sets the blur length as a fraction of the frame-to-frame motion (180° = half, like a film camera; 360° = the full path).',
  tags: ['motion blur', 'optical flow', 'shutter', 'video', 'smear', 'speed'],
  inputs: { image: { type: 'image', label: 'Image' }, flow: { type: 'image', label: 'Flow', optional: true } },
  params: {
    shutter: { type: 'float', default: 180, min: 0, max: 720, step: 1, label: 'Shutter angle (°)' },
    amount: { type: 'float', default: 1, min: 0, max: 8, step: 0.01, label: 'Motion scale', description: 'Multiplies the motion vectors (exaggerate slow motion).' },
    maxBlur: { type: 'float', default: 200, min: 1, max: 1000, step: 1, pixels: true, label: 'Max blur (px)' },
    samples: { type: 'int', default: 24, min: 4, max: 64, step: 1, label: 'Samples' },
    centered: { type: 'bool', default: true, label: 'Centred', description: 'Blur around each pixel (on) or trailing behind it (off).' },
  },
  passes: [
    {
      frag: /* glsl */ `
void main() {
  vec2 m = texture(u_flow, v_uv).rg * u_amount * (u_shutter / 360.0);
  // clamp the blur length (in output px)
  vec2 px = m * u_resolution;
  float len = length(px), mx = u_maxBlur * u_scale;
  if (len > mx) m *= mx / len;
  int n = clamp(u_samples, 2, 64);
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 64; i++) {
    if (i >= n) break;
    float t = float(i) / float(n - 1);
    t = u_centered ? t - 0.5 : -t;
    acc += texture(u_image, v_uv + m * t);
  }
  fragColor = acc / float(n);
}`,
    },
  ],
});

const warp = defineNode({
  id: 'effects.flowWarp',
  name: 'Flow Warp',
  category: 'Motion',
  color: MOTION_COLOR,
  description:
    'Moves the image along per-pixel motion vectors × amount (connect the `flow` output of Optical Flow). ' +
    'With frame A as the image and amount 1 this predicts frame B; 0.5 lands half-way; larger amounts exaggerate the motion into a liquid smear.',
  tags: ['warp', 'optical flow', 'displace', 'motion', 'liquify', 'video'],
  inputs: { image: { type: 'image', label: 'Image' }, flow: { type: 'image', label: 'Flow', optional: true } },
  params: {
    amount: { type: 'float', default: 1, min: -8, max: 8, step: 0.01, label: 'Amount' },
    steps: { type: 'int', default: 1, min: 1, max: 16, step: 1, label: 'Steps', description: 'Follow the flow in several short steps (smoother for large amounts).' },
  },
  passes: [
    {
      frag: /* glsl */ `
void main() {
  // backward warp: out(uv) = image(uv − amount·flow), optionally integrated along the field
  int n = clamp(u_steps, 1, 16);
  vec2 uv = v_uv;
  float k = u_amount / float(n);
  for (int i = 0; i < 16; i++) {
    if (i >= n) break;
    uv -= k * texture(u_flow, uv).rg;
  }
  fragColor = texture(u_image, uv);
}`,
    },
  ],
});

// --- datamosh -------------------------------------------------------------------------------------------
/** Accumulated P-frame state per (output size, content): keyed by frame so a re-evaluation of the same frame recomputes from the previous one. */
interface Mosh { node: string; frame: number; w: number; h: number; fp: Uint8Array; out: Float32Array }
const states: Mosh[] = [];
const MAX_SIDE = 1280;

function fpDist(a: Uint8Array, b: Uint8Array) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

/** RGBA float resample (bilinear-ish via the RGB resampler; alpha 1). */
function toRGBA(src: RawTex, w: number, h: number): Float32Array {
  const rgb = src.width === w && src.height === h && src.data instanceof Float32Array ? null : resampleRGB(src.data, src.width, src.height, w, h);
  const out = new Float32Array(w * h * 4);
  if (!rgb) {
    out.set(src.data as Float32Array);
    for (let i = 3; i < out.length; i += 4) out[i] = 1;
    return out;
  }
  for (let i = 0; i < w * h; i++) {
    out[i * 4] = rgb[i * 3];
    out[i * 4 + 1] = rgb[i * 3 + 1];
    out[i * 4 + 2] = rgb[i * 3 + 2];
    out[i * 4 + 3] = 1;
  }
  return out;
}

/** One datamosh step (exported for tests): warp `prev` by the block-quantised flow and bleed in `cur`. */
export function moshStep(prev: Float32Array, cur: Float32Array, w: number, h: number, flow: Float32Array, fw: number, fh: number, block: number, gain: number, bleed: number): Float32Array {
  const bf = blockFlow(flow, fw, fh, w, h, block);
  const out = warpByFlow(prev, w, h, bf, w, h, gain);
  if (bleed > 0) for (let i = 0; i < out.length; i++) out[i] += (cur[i] - out[i]) * bleed;
  return out;
}

function moshCpu(ctx: CpuContext) {
  const img = ctx.readInput('image');
  if (!img) return { mosh: { width: 1, height: 1, data: new Float32Array([0, 0, 0, 0]) } satisfies RawTex };
  const s = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * s)), h = Math.max(1, Math.round(img.height * s));
  const cur = toRGBA(img, w, h);
  const rgbSmall = resampleRGB(cur, w, h, 32, 32, 4);
  const fp = fingerprint(rgbSmall, 32, 32);
  const f = ctx.frame ?? 0;
  const p = ctx.params;
  const node = (ctx as { nodeId?: string }).nodeId ?? '';
  const key = Math.max(0, Math.round(Number(p.keyframe) || 0));
  // the latest earlier state (≤ 3 frames back: realtime playback may drop frames) of similar content
  let prev: Mosh | null = null;
  let best = Infinity;
  for (const st of states) {
    if (st.node !== node || st.w !== w || st.h !== h || st.frame >= f || st.frame < f - 3) continue;
    const score = (f - st.frame) * 1000 + fpDist(st.fp, fp);
    if (score < best) {
      best = score;
      prev = st;
    }
  }
  let out: Float32Array;
  if (f <= 0 || !prev || (key > 0 && f % key === 0)) out = cur; // I-frame
  else {
    const fl = ctx.readInput('flow');
    const flow = fl && fl.data instanceof Float32Array ? fl : { width: 1, height: 1, data: new Float32Array([0, 0, 0, 1]) };
    const block = Math.max(1, (Number(p.block) || 16) * (ctx.scale || 1) * s);
    out = moshStep(prev.out, cur, w, h, flow.data as Float32Array, flow.width, flow.height, block, Number(p.gain ?? 1), Number(p.bleed ?? 0));
  }
  const i = states.findIndex((x) => x.node === node && x.frame === f && x.w === w && x.h === h && fpDist(x.fp, fp) < 0.5);
  if (i >= 0) states.splice(i, 1);
  states.unshift({ node, frame: f, w, h, fp, out });
  if (states.length > 8) states.length = 8;
  return { mosh: { width: w, height: h, data: out } satisfies RawTex };
}

const datamosh = defineNode({
  id: 'effects.datamosh',
  name: 'Datamosh',
  category: 'Motion',
  color: MOTION_COLOR,
  description:
    'The classic I-frame-removal glitch: instead of showing each new frame, the previous output is dragged along the motion vectors ' +
    '(connect the `flow` output of Optical Flow), in macroblocks, so the old picture smears into the movement of the new one. ' +
    'Accumulates over frames during playback and video export; a still (frame 0) is passed through. A new I-frame every N frames resets it.',
  tags: ['datamosh', 'glitch', 'mosh', 'i-frame', 'p-frame', 'compression', 'optical flow', 'video', 'melt'],
  inputs: { image: { type: 'image', label: 'Image' }, flow: { type: 'image', label: 'Flow', optional: true } },
  params: {
    keyframe: { type: 'int', default: 0, min: 0, max: 600, step: 1, label: 'I-frame every (frames)', description: '0 = only at the start (and after a jump in time).' },
    block: { type: 'float', default: 16, min: 1, max: 64, step: 1, pixels: true, label: 'Macroblock (px)' },
    gain: { type: 'float', default: 1, min: 0, max: 4, step: 0.01, label: 'Motion gain' },
    bleed: { type: 'float', default: 0.02, min: 0, max: 1, step: 0.005, label: 'Bleed', description: 'How much of the real frame leaks in each frame (0 = pure mosh).' },
    mix: { type: 'float', default: 1, min: 0, max: 1, step: 0.01, label: 'Mix' },
  },
  volatile: 'time',
  cpuReadsInputs: true,
  cpu: moshCpu,
  passes: [
    {
      frag: /* glsl */ `
void main() {
  vec4 src = texture(u_image, v_uv);
  if (u_mosh_size.x < 2.0) { fragColor = src; return; }
  fragColor = vec4(mix(src.rgb, texture(u_mosh, v_uv).rgb, u_mix), src.a);
}`,
    },
  ],
});

export default [motionBlur, warp, datamosh] satisfies NodeDef[];
