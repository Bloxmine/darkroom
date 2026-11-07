/**
 * Face Detection & Landmarks (ai.faces): MediaPipe Face Landmarker (478 points incl. irises), in-browser.
 * Outputs a feathered face-oval mask from the landmark silhouette, a selectable feature mask (eyes, irises,
 * lips, brows, nose, face skin) and a landmark overlay. Detection is shared with ai.faceRestore and
 * ai.autoCrop through the analysis cache in face-analysis.ts (keyed by an input fingerprint).
 */
import { mpStatus, vision } from '../../core/ai/mediapipe';
import { defineNode } from '../../core/registry';
import type { NodeDef, RawTex } from '../../core/types';
import { AI_COLOR } from './_shared';
import { analyzeFaces } from './face-analysis';
import { faceOverlay, OVERLAY_STYLES, rasterSize, regionMask, REGIONS } from './face-draw';

const black: RawTex = { width: 1, height: 1, data: new Float32Array([0, 0, 0, 1]) };
const clear: RawTex = { width: 1, height: 1, data: new Float32Array([0, 0, 0, 0]) };

let tessCache: [number, number][] | null = null;
async function tesselation() {
  if (!tessCache) {
    const v = await vision();
    tessCache = v.FaceLandmarker.FACE_LANDMARKS_TESSELATION.map((c) => [c.start, c.end] as [number, number]);
  }
  return tessCache;
}

/**
 * Separable max (dilate, r > 0) / min (erode, r < 0) of the .r of two samplers `a`, `b` (or .rg of u_prev
 * when `fromPrev`), radius `u_<param>` px (scale-aware). Writes vec4(a, b, 0, 1).
 */
export function morphPass(vertical: boolean, param: string, a: string, b: string, fromPrev: boolean) {
  const read = fromPrev ? `texClamp(u_prev, uv).rg` : `vec2(texClamp(${a}, uv).r, texClamp(${b}, uv).r)`;
  return /* glsl */ `
vec2 rd(vec2 uv) { return ${read}; }
void main() {
  float r = u_${param} * u_scale;
  vec2 v = rd(v_uv);
  if (abs(r) >= 0.5) {
    int n = int(min(ceil(abs(r)), 64.0));
    float stp = abs(r) / float(n);
    vec2 dir = ${vertical ? 'vec2(0.0, 1.0)' : 'vec2(1.0, 0.0)'} / u_resolution;
    for (int i = -64; i <= 64; i++) {
      if (i < -n || i > n) continue;
      vec2 s = rd(v_uv + dir * float(i) * stp);
      v = r > 0.0 ? max(v, s) : min(v, s);
    }
  }
  fragColor = vec4(v, 0.0, 1.0);
}`;
}

/** Separable gaussian of u_prev.rg with radius `u_<param>` px (scale-aware). */
export function blur2Pass(vertical: boolean, param: string) {
  return /* glsl */ `
void main() {
  float r = u_${param} * u_scale;
  vec2 m;
  if (r < 0.5) m = texture(u_prev, v_uv).rg;
  else {
    int n = int(min(ceil(r), 48.0));
    float stp = r / float(n), sig = r * 0.5;
    vec2 dir = ${vertical ? 'vec2(0.0, 1.0)' : 'vec2(1.0, 0.0)'} / u_resolution;
    vec2 acc = vec2(0.0); float ws = 0.0;
    for (int i = -48; i <= 48; i++) {
      if (i < -n || i > n) continue;
      float x = float(i) * stp;
      float w = exp(-x * x / (2.0 * sig * sig));
      acc += texClamp(u_prev, v_uv + dir * x).rg * w; ws += w;
    }
    m = acc / ws;
  }
  fragColor = vec4(m, 0.0, 1.0);
}`;
}

const faces = defineNode({
  id: 'ai.faces',
  name: 'Face Detection & Landmarks',
  category: 'AI',
  color: AI_COLOR,
  description:
    'Finds faces and 478 facial landmarks (MediaPipe Face Landmarker, Apache-2.0, ~3.8 MB + an 11 MB runtime, downloads once) locally in your browser. ' +
    '“mask” = every face as a feathered oval traced from the landmark silhouette; “features” = the chosen region (face skin without eyes/brows/mouth, eyes, irises, brows, nose, lips, mouth); ' +
    '“overlay” = the image with the mesh, contours, points or boxes drawn on top. Small faces in group photos are found by also scanning overlapping tiles. ' +
    'The detection is cached per image and shared with Face Restoration and Smart Auto-Crop.',
  tags: ['face', 'faces', 'landmarks', 'face mesh', 'detect', 'detection', 'eyes', 'lips', 'mouth', 'skin', 'portrait', 'retouch', 'mediapipe', 'ai', 'ml', 'mask'],
  inputs: { image: { type: 'image', label: 'Image' } },
  outputs: { mask: { type: 'mask', label: 'Faces' }, features: { type: 'mask', label: 'Features' }, overlay: { type: 'image', label: 'Overlay' } },
  params: {
    maxFaces: { type: 'int', default: 32, min: 1, max: 64, step: 1, label: 'Max faces', description: 'Keeps the largest faces.' },
    minConfidence: { type: 'float', default: 0.5, min: 0.1, max: 0.95, step: 0.05, label: 'Min confidence' },
    region: { type: 'enum', default: REGIONS[0], options: REGIONS, label: 'Features region', description: 'What the “features” output selects.' },
    feather: { type: 'float', default: 4, min: 0, max: 100, step: 0.5, pixels: true, label: 'Feather' },
    dilate: { type: 'float', default: 0, min: -50, max: 50, step: 0.5, pixels: true, label: 'Grow / shrink', description: '+ grows the masks, − shrinks them (px).' },
    style: { type: 'enum', default: OVERLAY_STYLES[0], options: OVERLAY_STYLES, label: 'Overlay style' },
    color: { type: 'color', default: [0.25, 1, 0.65, 1], label: 'Overlay colour' },
    lineWidth: { type: 'float', default: 2, min: 0.5, max: 20, step: 0.5, pixels: true, label: 'Line width' },
  },
  cpuReadsInputs: true,
  cpu: async (ctx) => {
    const src = ctx.readInput('image');
    if (!src) return { fm: black, ft: black, ov: clear };
    const A = await analyzeFaces(src, Number(ctx.params.minConfidence ?? 0.5));
    const list = A.faces.slice(0, Math.max(1, Number(ctx.params.maxFaces) || 32));
    const extra = A.extra.slice(0, Math.max(0, (Number(ctx.params.maxFaces) || 32) - list.length));
    if (!list.length && !extra.length) mpStatus('Face Detection: no faces found.');
    const [rw, rh] = rasterSize(src.width, src.height);
    const style = String(ctx.params.style);
    const k = (rw / src.width) * ctx.scale; // raster px per full-res px
    const color = (ctx.params.color as number[]) ?? [0.25, 1, 0.65, 1];
    return {
      fm: regionMask(list, rw, rh, 'Whole face', extra),
      ft: regionMask(list, rw, rh, String(ctx.params.region)),
      ov: faceOverlay(list, rw, rh, style, color, Math.max(0.5, Number(ctx.params.lineWidth) * k), style.startsWith('Mesh') ? await tesselation() : null, extra),
    };
  },
  passes: [
    { frag: morphPass(false, 'dilate', 'u_fm', 'u_ft', false) },
    { frag: morphPass(true, 'dilate', '', '', true) },
    { frag: blur2Pass(false, 'feather') },
    { frag: blur2Pass(true, 'feather') },
    { output: 'mask', frag: `void main() { fragColor = vec4(vec3(texture(u_pass3, v_uv).r), 1.0); }` },
    { output: 'features', frag: `void main() { fragColor = vec4(vec3(texture(u_pass3, v_uv).g), 1.0); }` },
    {
      output: 'overlay',
      frag: /* glsl */ `
void main() {
  vec4 c = texture(u_image, v_uv);
  vec4 o = texture(u_ov, v_uv);
  fragColor = vec4(mix(c.rgb, o.rgb, o.a), c.a);
}`,
    },
  ],
});

export default [faces] satisfies NodeDef[];
