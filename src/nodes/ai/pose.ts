/**
 * Pose / Body (ai.pose): MediaPipe Pose Landmarker (lite/full: 33 landmarks + person segmentation) and the
 * Selfie Multiclass segmenter (hair, body skin, face skin, clothes, accessories), in-browser.
 * Outputs: `mask` (the person), `parts` (the chosen class, e.g. hair for a recolor) and `overlay` (a skeleton
 * drawing with a motion-capture glow). Both masks are refined edge-aware against the image.
 */
import { defineNode } from '../../core/registry';
import type { NodeDef, RawTex } from '../../core/types';
import { mpStatus } from '../../core/ai/mediapipe';
import { AI_COLOR, GUIDE_FRAG, JBU_GLSL } from './_shared';
import { blur2Pass } from './face';
import { makeCanvas, rasterSize } from './face-draw';
import { POSE_CONNECTIONS } from './face-geom';
import { texFingerprint } from './face-analysis';
import { analyzeParts, analyzePose, peopleRegion, type PartsAnalysis } from './pose-analysis';

/** Friendly part → Selfie Multiclass class indices (0 bg, 1 hair, 2 body skin, 3 face skin, 4 clothes, 5 accessories). */
const PARTS: [string, number[]][] = [
  ['Hair', [1]],
  ['Skin (face + body)', [2, 3]],
  ['Face skin', [3]],
  ['Body skin', [2]],
  ['Clothes', [4]],
  ['Accessories', [5]],
  ['Person (all)', [1, 2, 3, 4, 5]],
  ['Background', [0]],
];
const SOURCES = ['Multiclass (sharper, with hair)', 'Pose segmentation'];
const STYLES = ['Motion capture', 'Left / right colours', 'Lines only', 'Joints only'];
const MODELS = ['Lite (5.8 MB)', 'Full (9.4 MB)'];

/** Confidences below this count as 0 (and above 1 − FLOOR as 1). */
const FLOOR = 0.12;
/** Mask grid (long side) the CPU masks are built on before the edge-aware upsample. */
const GRID = 768;

function gridDims(w: number, h: number): [number, number] {
  return rasterSize(w, h, GRID);
}

/** Bilinear lookup in a w×h float mask at normalised (u, v). */
function at(m: Float32Array, w: number, h: number, u: number, v: number) {
  const x = Math.min(w - 1, Math.max(0, u * w - 0.5)), y = Math.min(h - 1, Math.max(0, v * h - 0.5));
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
  const a = x - x0, b = y - y0;
  return (m[y0 * w + x0] * (1 - a) + m[y0 * w + x1] * a) * (1 - b) + (m[y1 * w + x0] * (1 - a) + m[y1 * w + x1] * a) * b;
}

/** Sum of the chosen classes of a parts analysis, on a gw×gh grid of the whole image (0 outside its region). */
function partsGrid(P: PartsAnalysis | null, classes: number[], gw: number, gh: number): Float32Array {
  const out = new Float32Array(gw * gh);
  if (!P || P.masks.length < 6) return out;
  const [rx0, ry0, rx1, ry1] = P.region;
  const isBg = classes.length === 1 && classes[0] === 0;
  for (let y = 0; y < gh; y++) {
    const v = (y + 0.5) / gh;
    for (let x = 0; x < gw; x++) {
      const u = (x + 0.5) / gw;
      if (u < rx0 || u > rx1 || v < ry0 || v > ry1) {
        out[y * gw + x] = isBg ? 1 : 0;
        continue;
      }
      const ru = (u - rx0) / (rx1 - rx0), rv = (v - ry0) / (ry1 - ry0);
      let s = 0;
      for (const c of classes) s += at(P.masks[c], P.w, P.h, ru, rv);
      // floor/ceiling: drops the low-confidence haze (and the seam at the crop region's edge)
      out[y * gw + x] = Math.min(1, Math.max(0, (s - FLOOR) / (1 - 2 * FLOOR)));
    }
  }
  return out;
}

function tex(v: Float32Array, w: number, h: number): RawTex {
  const d = new Float32Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    d[i * 4] = v[i];
    d[i * 4 + 3] = 1;
  }
  return { width: w, height: h, data: d };
}

const css = (c: number[], a = 1) => `rgba(${Math.round((c[0] ?? 1) * 255)},${Math.round((c[1] ?? 1) * 255)},${Math.round((c[2] ?? 1) * 255)},${(c[3] ?? 1) * a})`;
const LEFT = new Set([1, 2, 3, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31]);

/** Skeleton drawing (transparent background). `lw` = line width in canvas px. */
function skeleton(people: Float32Array[], w: number, h: number, style: string, line: number[], joint: number[], lw: number, minVis: number) {
  const { canvas, g } = makeCanvas(w, h);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const L = [1, 0.55, 0.15, 1], R = [0.2, 0.6, 1, 1];
  for (const p of people) {
    const P = (i: number): [number, number] => [p[i * 4] * w, p[i * 4 + 1] * h];
    const vis = (i: number) => p[i * 4 + 3] >= minVis;
    if (style !== 'Joints only') {
      for (const [a, b] of POSE_CONNECTIONS) {
        if (!vis(a) || !vis(b)) continue;
        // the face connections (0-10) are drawn thinner
        const face = a <= 10 && b <= 10;
        const c = style === 'Left / right colours' ? (LEFT.has(a) && LEFT.has(b) ? L : !LEFT.has(a) && !LEFT.has(b) && a > 0 ? R : line) : line;
        g.strokeStyle = css(c);
        g.lineWidth = face ? lw * 0.5 : lw;
        g.beginPath();
        g.moveTo(...P(a));
        g.lineTo(...P(b));
        g.stroke();
      }
    }
    if (style !== 'Lines only') {
      for (let i = 0; i < 33; i++) {
        if (!vis(i) || (i > 0 && i <= 10)) continue; // head = the nose joint only
        const [x, y] = P(i);
        const r = (i === 0 ? 1.6 : 1) * lw * 0.9;
        g.fillStyle = css(joint);
        g.beginPath();
        g.arc(x, y, r, 0, Math.PI * 2);
        g.fill();
        if (style === 'Motion capture') {
          g.strokeStyle = css(line, 0.9);
          g.lineWidth = Math.max(1, lw * 0.35);
          g.beginPath();
          g.arc(x, y, r * 1.9, 0, Math.PI * 2);
          g.stroke();
        }
      }
    }
  }
  return canvas;
}

function glowPass(vertical: boolean) {
  return /* glsl */ `
vec4 rd(vec2 uv) { ${vertical ? 'return texClamp(u_prev, uv);' : 'vec4 s = texClamp(u_skel, uv); return vec4(s.rgb * s.a, s.a);'} }
void main() {
  float r = u_glowRadius * u_scale * 0.5;
  if (r < 0.5) { fragColor = rd(v_uv); return; }
  int n = int(min(ceil(r), 48.0));
  float stp = r / float(n), sig = r * 0.5;
  vec2 dir = ${vertical ? 'vec2(0.0, 1.0)' : 'vec2(1.0, 0.0)'} / u_resolution;
  vec4 acc = vec4(0.0); float ws = 0.0;
  for (int i = -48; i <= 48; i++) {
    if (i < -n || i > n) continue;
    float x = float(i) * stp;
    float w = exp(-x * x / (2.0 * sig * sig));
    acc += rd(v_uv + dir * x) * w; ws += w;
  }
  fragColor = acc / ws;
}`;
}

const half = (c: { width: number; height: number }): [number, number] => [Math.max(1, Math.ceil(c.width / 2)), Math.max(1, Math.ceil(c.height / 2))];

const pose = defineNode({
  id: 'ai.pose',
  name: 'Pose / Body',
  category: 'AI',
  color: AI_COLOR,
  description:
    'Finds people, their 33-point body pose and their parts, locally in your browser (MediaPipe Pose Landmarker + Selfie Multiclass, Apache-2.0, ~6–9 MB + 16 MB, downloads once). ' +
    '“mask” = the whole person; “parts” = hair, skin, face skin, body skin, clothes or accessories (e.g. wire Hair into a hue shift for a hair recolor); ' +
    '“overlay” = a glowing motion-capture skeleton over the (optionally darkened) image. Results are cached per image.',
  tags: ['pose', 'body', 'skeleton', 'person', 'people', 'hair', 'skin', 'clothes', 'segmentation', 'motion capture', 'mocap', 'mediapipe', 'ai', 'ml', 'mask'],
  inputs: { image: { type: 'image', label: 'Image' } },
  outputs: { mask: { type: 'mask', label: 'Person' }, parts: { type: 'mask', label: 'Part' }, overlay: { type: 'image', label: 'Skeleton' } },
  params: {
    part: { type: 'enum', default: PARTS[0][0], options: PARTS.map((p) => p[0]), label: 'Part', description: 'What the “parts” output selects.' },
    maskSource: { type: 'enum', default: SOURCES[0], options: SOURCES, label: 'Person mask from' },
    model: { type: 'enum', default: MODELS[0], options: MODELS, label: 'Pose model' },
    maxPeople: { type: 'int', default: 8, min: 1, max: 10, step: 1, label: 'Max people' },
    minConfidence: { type: 'float', default: 0.5, min: 0.1, max: 0.95, step: 0.05, label: 'Min confidence' },
    refine: { type: 'float', default: 0.8, min: 0, max: 1, step: 0.01, label: 'Edge refine' },
    feather: { type: 'float', default: 1, min: 0, max: 100, step: 0.5, pixels: true, label: 'Feather' },
    style: { type: 'enum', default: STYLES[0], options: STYLES, label: 'Skeleton style' },
    lineColor: { type: 'color', default: [0.1, 0.95, 1, 1], label: 'Line colour' },
    jointColor: { type: 'color', default: [1, 1, 1, 1], label: 'Joint colour' },
    thickness: { type: 'float', default: 6, min: 0.5, max: 60, step: 0.5, pixels: true, label: 'Thickness' },
    glow: { type: 'float', default: 0.8, min: 0, max: 3, step: 0.01, label: 'Glow' },
    glowRadius: { type: 'float', default: 24, min: 0, max: 200, step: 1, pixels: true, label: 'Glow radius' },
    dim: { type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, label: 'Darken background', description: 'Darkens the image under the skeleton (1 = black).' },
  },
  cpuReadsInputs: true,
  cpu: async (ctx) => {
    const src = ctx.readInput('image');
    const z = tex(new Float32Array(1), 1, 1);
    if (!src) return { pm: z, pp: z, skel: { width: 1, height: 1, data: new Float32Array(4) } };
    const p = ctx.params;
    const fp = texFingerprint(src);
    const A = await analyzePose(src, p.model === MODELS[1], Number(p.maxPeople) || 8, Number(p.minConfidence ?? 0.5), fp);
    if (!A.people.length) mpStatus('Pose / Body: no person found.');
    const region = peopleRegion(A.people);
    const P = await analyzeParts(src, region, fp).catch((e) => (console.warn('[darkroom ai] selfie multiclass failed', e), null));
    const [gw, gh] = gridDims(src.width, src.height);
    let person: Float32Array;
    if (p.maskSource === SOURCES[1]) {
      person = new Float32Array(gw * gh);
      if (A.mask) for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) person[y * gw + x] = at(A.mask, A.mw, A.mh, (x + 0.5) / gw, (y + 0.5) / gh);
    } else person = partsGrid(P, [1, 2, 3, 4, 5], gw, gh);
    const cls = (PARTS.find((q) => q[0] === p.part) ?? PARTS[0])[1];
    const [rw, rh] = rasterSize(src.width, src.height);
    const k = (rw / src.width) * ctx.scale;
    const skel = skeleton(A.people, rw, rh, String(p.style), (p.lineColor as number[]) ?? [0.1, 0.95, 1, 1], (p.jointColor as number[]) ?? [1, 1, 1, 1],
      Math.max(0.75, Number(p.thickness) * k), Number(p.minConfidence ?? 0.5));
    return { pm: tex(person, gw, gh), pp: tex(partsGrid(P, cls, gw, gh), gw, gh), skel };
  },
  passes: [
    // 0: low-res guide for the edge-aware upsample (the CPU mask grid)
    { size: (c) => gridDims(c.width, c.height), frag: GUIDE_FRAG },
    {
      frag: /* glsl */ `
${JBU_GLSL}
void main() {
  float a = u_refine <= 0.0 ? texture(u_pm, v_uv).r : jbu(u_pm, u_pm_size, u_pass0, u_refine, 0.2);
  float b = u_refine <= 0.0 ? texture(u_pp, v_uv).r : jbu(u_pp, u_pp_size, u_pass0, u_refine, 0.2);
  fragColor = vec4(clamp(a, 0.0, 1.0), clamp(b, 0.0, 1.0), 0.0, 1.0);
}`,
    },
    { frag: blur2Pass(false, 'feather') },
    { frag: blur2Pass(true, 'feather') },
    { output: 'mask', frag: `void main() { fragColor = vec4(vec3(texture(u_pass3, v_uv).r), 1.0); }` },
    { output: 'parts', frag: `void main() { fragColor = vec4(vec3(texture(u_pass3, v_uv).g), 1.0); }` },
    // 6, 7: glow of the skeleton at half resolution (premultiplied)
    { size: half, frag: glowPass(false) },
    { size: half, frag: glowPass(true) },
    {
      output: 'overlay',
      frag: /* glsl */ `
void main() {
  vec4 c = texture(u_image, v_uv);
  vec3 col = c.rgb * (1.0 - u_dim);
  vec4 g = texture(u_pass7, v_uv);
  col = 1.0 - (1.0 - col) * (1.0 - clamp(g.rgb * u_glow * 2.0, 0.0, 1.0)); // screen
  vec4 s = texture(u_skel, v_uv);
  col = mix(col, s.rgb, s.a);
  fragColor = vec4(col, c.a);
}`,
    },
  ],
});

export default [pose] satisfies NodeDef[];
