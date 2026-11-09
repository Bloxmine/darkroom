/**
 * Optical flow (RAFT / NeuFlow v2) between two frames, in the browser.
 *
 * Multi-frame input: frame B (the current frame) is required; frame A (the earlier frame) is optional.
 * When A is unconnected the node uses its own history of B: during playback and video export the
 * engine evaluates frames in order, so the B of the previous frame (f−1, or up to f−3 when realtime
 * playback dropped frames) is A. This works with any upstream graph (a video, a webcam, a graded
 * video…) and inside presets, which only see one `image` input. For exact pairs while scrubbing, wire
 * a "Video Frame (offset)" source (core.videoFrameOffset, offset −1) into A. See docs/AI.md.
 */
import '../../core/ai/models-motion';
import { fingerprint, resampleRGB, toCHW } from '../../core/ai/image';
import { FLOW_MODELS, type FlowModelId } from '../../core/ai/models-motion';
import { runModelMulti } from '../../core/ai/runtime';
import { defineNode } from '../../core/registry';
import type { CpuContext, NodeDef, Params, RawTex } from '../../core/types';
import { AI_COLOR } from './_shared';
import { encodeFlow, hashPixels, robustMaxMagnitude, wheelTexture } from './flowMath';

const MODELS = ['NeuFlow v2 (fast)', 'RAFT (WASM only)'];
const modelOf = (p: Params): FlowModelId => (p.model === MODELS[1] || p.model === 'RAFT (accurate)' ? 'raft-sintel' : 'neuflow-v2-mixed');

const zeroFlow = (): RawTex => ({ width: 1, height: 1, data: new Float32Array([0, 0, 0, 1]) });
const WHEEL = wheelTexture();

/** Mean absolute difference of two 24×24 fingerprints. */
function fpDist(a: Uint8Array, b: Uint8Array) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

// --- history of B (previous-frame mode) --------------------------------------------------------------
interface Hist { node: string; model: FlowModelId; frame: number; fp: Uint8Array; rgb: Float32Array; hash: string }
const history: Hist[] = [];

/** The B of the latest earlier frame (≤ 3 frames back) that looks most like this one (another flow node on another clip has other content). */
function previousOf(node: string, model: FlowModelId, frame: number, fp: Uint8Array): Hist | null {
  let best: Hist | null = null;
  let bestScore = Infinity;
  for (const h of history) {
    if (h.node !== node || h.model !== model || h.frame >= frame || h.frame < frame - 3) continue;
    const score = (frame - h.frame) * 1000 + fpDist(h.fp, fp);
    if (score < bestScore) {
      bestScore = score;
      best = h;
    }
  }
  return best;
}

function remember(h: Hist) {
  // one entry per (model, frame, content)
  const i = history.findIndex((x) => x.node === h.node && x.model === h.model && x.frame === h.frame && x.hash === h.hash);
  if (i >= 0) history.splice(i, 1);
  history.unshift(h);
  if (history.length > 12) history.length = 12;
}

// --- inference memo (exact content: consecutive video frames are too similar for a fuzzy key) --------
const memo = new Map<string, Promise<Float32Array>>();
function flowMemo(key: string, run: () => Promise<Float32Array>) {
  let p = memo.get(key);
  if (!p) {
    p = run();
    p.catch(() => memo.delete(key));
    memo.set(key, p);
    while (memo.size > 8) memo.delete(memo.keys().next().value!);
  }
  return p;
}

/**
 * Flow from `a` to `b` (RGB HWC at the model size) as the `flow` encoding (RGBA float, model size).
 * Exported for other nodes (e.g. ai.frameInterp diagnostics).
 */
export function computeFlow(model: FlowModelId, a: Float32Array, b: Float32Array): Promise<Float32Array> {
  const m = FLOW_MODELS[model];
  const key = `${model}:${hashPixels(a, 7)}:${hashPixels(b, 7)}`;
  return flowMemo(key, async () => {
    const t = (rgb: Float32Array) => ({ data: toCHW(rgb, m.w, m.h, [0, 0, 0], [1, 1, 1], 1 / m.range), dims: [1, 3, m.h, m.w] });
    // image1 = B, image2 = A: the network's flow tells where each pixel of B was in A
    const r = await runModelMulti(model, { [m.inputs[0]]: t(b), [m.inputs[1]]: t(a) }, [m.output]);
    const out = r[m.output];
    if (!out) throw new Error('optical flow: no output');
    return encodeFlow(out.data, m.w, m.h);
  });
}

async function flowCpu(ctx: CpuContext) {
  const B = ctx.readInput('b');
  if (!B) return { flowLr: zeroFlow(), stats: { width: 1, height: 1, data: new Float32Array([1, 0, 0, 1]) }, wheel: WHEEL };
  const model = modelOf(ctx.params);
  const m = FLOW_MODELS[model];
  const b = resampleRGB(B.data, B.width, B.height, m.w, m.h);
  const A = ctx.readInput('a');
  let a: Float32Array | null = null;
  if (A) a = resampleRGB(A.data, A.width, A.height, m.w, m.h);
  else {
    const frame = ctx.frame ?? 0;
    const fp = fingerprint(b, m.w, m.h);
    // CpuContext.nodeId (newer engines) keeps two flow nodes apart; the content match does it otherwise
    const node = (ctx as { nodeId?: string }).nodeId ?? '';
    const prev = frame > 0 ? previousOf(node, model, frame, fp) : null;
    remember({ node, model, frame, fp, rgb: b, hash: hashPixels(b, 7) });
    a = prev?.rgb ?? null;
  }
  const full = { w: B.width / (ctx.scale || 1), h: B.height / (ctx.scale || 1) };
  if (!a) return { flowLr: zeroFlow(), stats: { width: 1, height: 1, data: new Float32Array([1, 0, 0, 1]) }, wheel: WHEEL };
  const flow = await computeFlow(model, a, b);
  const maxPx = robustMaxMagnitude(flow, full.w, full.h, 0.995) * 1.1;
  return {
    flowLr: { width: m.w, height: m.h, data: flow } satisfies RawTex,
    stats: { width: 1, height: 1, data: new Float32Array([maxPx, 0, 0, 1]) } satisfies RawTex,
    wheel: WHEEL,
  };
}

/** GLSL: Middlebury colour of a flow vector already divided by the normalising magnitude (u_wheel = 55×1 table). */
export const FLOW_COLOR_GLSL = /* glsl */ `
vec3 flowColor(vec2 f) {
  float n = 55.0;
  float rad = length(f);
  if (rad < 1e-6) return vec3(1.0); // atan(0, 0) is undefined in GLSL
  float a = atan(0.0 - f.y, 0.0 - f.x) / PI;
  float fk = (a + 1.0) * 0.5 * (n - 1.0);
  float k0 = floor(fk);
  float k1 = k0 + 1.0 >= n ? 0.0 : k0 + 1.0;
  float t = fk - k0;
  vec3 c = mix(texelFetch(u_wheel, ivec2(int(k0), 0), 0).rgb, texelFetch(u_wheel, ivec2(int(k1), 0), 0).rgb, t);
  return rad <= 1.0 ? 1.0 - rad * (1.0 - c) : c * 0.75;
}`;

const flow = defineNode({
  id: 'ai.opticalFlow',
  name: 'Optical Flow',
  category: 'AI',
  color: AI_COLOR,
  description:
    'Estimates per-pixel motion between two frames with NeuFlow v2 (42 MB, WebGPU) or RAFT (64 MB, runs on the CPU), locally in the browser. ' +
    'Frame A (earlier) is optional: leave it unconnected on a video and the previous frame is used during playback and export. ' +
    '`flow` holds the motion A → B (R = dx / width, G = dy / height, float) for the Motion nodes (Flow Motion Blur, Flow Warp, Datamosh); ' +
    '`viz` is the standard Middlebury colour wheel (hue = direction, saturation = speed).',
  tags: ['optical flow', 'motion', 'raft', 'neuflow', 'video', 'motion vectors', 'flow', 'ai', 'ml'],
  inputs: {
    a: { type: 'image', label: 'Frame A (earlier)', optional: true },
    b: { type: 'image', label: 'Frame B (current)' },
  },
  outputs: { flow: { type: 'image', label: 'Flow' }, viz: { type: 'image', label: 'Visualisation' } },
  params: {
    model: {
      type: 'enum',
      default: MODELS[0],
      options: MODELS,
      label: 'Model',
      description: 'NeuFlow v2 (768×432; WebGPU or CPU) or RAFT (Sintel, 480×360; always on the CPU: wrong results on WebGPU with ONNX Runtime 1.31).',
    },
    refine: { type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Edge refine', description: 'Snap motion boundaries to the edges of frame B when upsampling.' },
    vizMax: { type: 'float', default: 0, min: 0, max: 200, step: 0.5, pixels: true, label: 'Viz max motion (px)', description: 'Motion shown fully saturated; 0 = auto (99th percentile).' },
  },
  size: ({ inputSizes, projectSize }) => {
    const s = inputSizes.b ?? inputSizes.a ?? projectSize;
    return [s.width, s.height];
  },
  volatile: 'time',
  cpuReadsInputs: true,
  cpu: flowCpu,
  passes: [
    // 0: guide = B at the flow resolution
    {
      size: (c) => [Math.min(c.width, 768), Math.min(c.height, 432)],
      frag: /* glsl */ `
void main() {
  vec3 acc = vec3(0.0);
  for (int j = 0; j < 3; j++) for (int i = 0; i < 3; i++) acc += texture(u_b, v_uv + (vec2(float(i), float(j)) - 1.0) / (u_resolution * 3.0)).rgb;
  fragColor = vec4(acc / 9.0, 1.0);
}`,
    },
    // 1: flow at full size, joint-bilateral upsampled against B
    {
      output: 'flow',
      frag: /* glsl */ `
void main() {
  if (u_flowLr_size.x < 2.0) { fragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  vec2 p = v_uv * u_flowLr_size - 0.5;
  vec2 b = floor(p);
  vec3 g = texture(u_b, v_uv).rgb;
  float sigR = mix(0.6, 0.06, clamp(u_refine, 0.0, 1.0));
  vec2 acc = vec2(0.0), accS = vec2(0.0);
  float ws = 0.0, wsS = 0.0;
  for (int j = -1; j <= 2; j++) for (int i = -1; i <= 2; i++) {
    vec2 q = clamp(b + vec2(float(i), float(j)), vec2(0.0), u_flowLr_size - 1.0);
    vec2 uvq = (q + 0.5) / u_flowLr_size;
    vec2 v = texture(u_flowLr, uvq).rg;
    vec3 gq = texture(u_pass0, uvq).rgb;
    vec2 d = p - q;
    float wS = exp(-dot(d, d) / 1.2);
    vec3 dg = g - gq;
    float wR = exp(-dot(dg, dg) / (2.0 * sigR * sigR));
    acc += v * wS * wR; ws += wS * wR;
    accS += v * wS; wsS += wS;
  }
  vec2 spatial = accS / max(wsS, 1e-6);
  vec2 f = u_refine <= 0.0 ? texture(u_flowLr, v_uv).rg : (ws > 1e-4 ? mix(spatial, acc / ws, clamp(ws * 20.0, 0.0, 1.0)) : spatial);
  fragColor = vec4(f, 0.0, 1.0);
}`,
    },
    // 2: Middlebury visualisation
    {
      output: 'viz',
      frag: /* glsl */ `
${FLOW_COLOR_GLSL}
void main() {
  vec2 full = u_resolution / max(u_scale, 1e-6);
  vec2 px = texture(u_pass1, v_uv).rg * full;
  float mx = u_vizMax > 0.0 ? u_vizMax : texelFetch(u_stats, ivec2(0), 0).r;
  fragColor = vec4(flowColor(px / max(mx, 1e-3)), 1.0);
}`,
    },
  ],
});

export default [flow] satisfies NodeDef[];
