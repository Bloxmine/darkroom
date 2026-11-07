/**
 * Model-based ControlNet preprocessors (in-browser, ONNX Runtime Web), reusing the models already in the
 * catalog wherever possible:
 *  - control.lineart: Informative Drawings, the same weights as lllyasviel's `sk_model.pth` (realistic) and
 *    `sk_model2.pth` (coarse); white lines on black (controlnet_aux `255 − line`).
 *  - control.depth: Depth Anything V2 Small or MoGe-2, min-max normalised, near = white. Or format a depth
 *    map you already have (e.g. from ai.depth) via the optional `depth` input.
 *  - control.normal: MoGe-2 normals (as ai.normals) re-encoded for ControlNet normalbae: red = LEFT,
 *    green = up, blue = towards the viewer (the ScanNet / NYU-v2 protocol). ai.normals' OpenGL map has red = right.
 *  - control.mlsd: M-LSD tiny straight lines, white on black.
 */
import '../../core/ai/models-control';
import '../../core/ai/models-img';
import '../../core/ai/models-relight';
import { fingerprint, fitDims, InferenceMemo, maskTex, normalizeMinMax, resampleRGB, toCHW } from '../../core/ai/image';
import { runModel, runModelMulti } from '../../core/ai/runtime';
import { defineNode } from '../../core/registry';
import type { NodeDef, RawTex } from '../../core/types';
import { makeCanvas } from '../ai/face-draw';
import { geometryTextures, type Geo } from '../ai/relight-math';
import { CATEGORY, CONTROL_COLOR, detectDims, greyOut, resolutionParam } from './_shared';
import { decodeMlsd, mlsdInput } from './_mlsd';

const flat = (v: number): RawTex => maskTex([v], 1, 1);
const res = (v: unknown, d = 512) => Number(v) || d;

// ---------------------------------------------------------------------------------------------- Lineart
const LINEART: Record<string, string> = {
  'Realistic (sk_model)': 'informative-drawings-anime',
  'Coarse (sk_model2)': 'informative-drawings-opensketch',
};
const lineMemo = new InferenceMemo<RawTex>(6);

const lineart = defineNode({
  id: 'control.lineart',
  name: 'Lineart (ControlNet)',
  category: CATEGORY,
  color: CONTROL_COLOR,
  heavy: true,
  description:
    'Line drawing for the ControlNet lineart models, white lines on black: the lineart_realistic / lineart_coarse preprocessors ' +
    '(Informative Drawings generators, MIT, ~17 MB, runs locally). For the stylised ink look use AI Line Art instead.',
  tags: ['controlnet', 'lineart', 'line art', 'lines', 'sketch', 'control map', 'stable diffusion', 'preprocessor'],
  inputs: { image: { type: 'image', label: 'Image' } },
  params: {
    model: { type: 'enum', default: Object.keys(LINEART)[0], options: Object.keys(LINEART), label: 'Preprocessor' },
    resolution: resolutionParam(512),
  },
  cpuReadsInputs: true,
  cpu: async (ctx) => {
    const src = ctx.readInput('image');
    if (!src) return { m: flat(0) };
    const [w, h] = detectDims(src.width, src.height, res(ctx.params.resolution));
    const rgb = resampleRGB(src.data, src.width, src.height, w, h);
    const model = LINEART[String(ctx.params.model)] ?? Object.values(LINEART)[0];
    const m = await lineMemo.get(`${model}:${w}x${h}`, fingerprint(rgb, w, h), Math.min(src.width, src.height), Math.min(w, h), async () => {
      const r = await runModel(model, { data: toCHW(rgb, w, h, [0, 0, 0], [1, 1, 1]), dims: [1, 3, h, w] });
      const [oh, ow] = r.dims.slice(-2);
      const v = new Float32Array(ow * oh);
      for (let i = 0; i < v.length; i++) v[i] = 1 - Math.min(1, Math.max(0, r.data[i]));
      return maskTex(v, ow, oh);
    });
    return { m };
  },
  passes: [{ frag: greyOut('u_m') }],
});

// ------------------------------------------------------------------------------------------------ Depth
const DEPTH_MODELS = ['Depth Anything V2 Small', 'MoGe-2 (from the normals model)'];
const depthMemo = new InferenceMemo<RawTex>(6);
const geoMemo = new InferenceMemo<Geo>(4);

async function moge(src: RawTex, short: number): Promise<Geo> {
  const [w, h] = fitDims(src.width, src.height, short, 14);
  const rgb = resampleRGB(src.data, src.width, src.height, w, h);
  return geoMemo.get(`moge:${short}`, fingerprint(rgb, w, h), Math.min(src.width, src.height), short, async () => {
    const r = await runModelMulti(
      'moge-2-vits-normal',
      { image: { data: toCHW(rgb, w, h, [0, 0, 0], [1, 1, 1]), dims: [1, 3, h, w] }, num_tokens: { data: Float32Array.of(1800), dims: [], type: 'int64' } },
      ['points', 'normal', 'mask'],
    );
    const [, oh, ow] = r.normal.dims;
    return geometryTextures(r.points.data, r.normal.data, r.mask.data, ow, oh);
  });
}

/** Min-max normalise the r channel of a texture (controlnet_aux depth: (d − min) / (max − min)). */
function normTex(t: RawTex): RawTex {
  const n = t.width * t.height;
  const v = new Float32Array(n);
  const k = t.data instanceof Uint8Array ? 1 / 255 : 1;
  for (let i = 0; i < n; i++) v[i] = t.data[i * 4] * k;
  return maskTex(normalizeMinMax(v), t.width, t.height);
}

const depth = defineNode({
  id: 'control.depth',
  name: 'Depth (ControlNet)',
  category: CATEGORY,
  color: CONTROL_COLOR,
  heavy: true,
  description:
    'Depth map for the ControlNet depth models: near = white, far = black, normalised to the full range (as the depth_anything / midas preprocessors). ' +
    'Runs Depth Anything V2 Small (Apache-2.0) or MoGe-2 (MIT) locally — the same models as Depth Map / Surface Normals, so nothing new downloads. ' +
    'Connect a depth map to “depth” (e.g. from Depth Map) to just format that one instead.',
  tags: ['controlnet', 'depth', 'depth map', 'midas', 'depth anything', 'zoe', 'control map', 'stable diffusion', 'preprocessor'],
  inputs: { image: { type: 'image', label: 'Image' }, depth: { type: 'mask', label: 'Depth (optional)', optional: true } },
  params: {
    model: { type: 'enum', default: DEPTH_MODELS[0], options: DEPTH_MODELS, label: 'Model' },
    resolution: { ...resolutionParam(518), step: 14, min: 252, max: 1022, description: 'Short side fed to the model (multiple of 14; 518 = the depth_anything default).' },
    invert: { type: 'bool', default: false, label: 'Invert (near = black)' },
  },
  cpuReadsInputs: true,
  cpu: async (ctx) => {
    const given = ctx.readInput('depth');
    if (given) return { d: normTex(given) };
    const src = ctx.readInput('image');
    if (!src) return { d: flat(0) };
    const short = res(ctx.params.resolution, 518);
    if (ctx.params.model === DEPTH_MODELS[1]) {
      const g = await moge(src, short);
      return { d: normTex(g.depth) };
    }
    const [w, h] = fitDims(src.width, src.height, short, 14);
    const rgb = resampleRGB(src.data, src.width, src.height, w, h);
    const d = await depthMemo.get(`da2s:${short}`, fingerprint(rgb, w, h), Math.min(src.width, src.height), short, async () => {
      const r = await runModel('depth-anything-v2-small', { data: toCHW(rgb, w, h, [0.485, 0.456, 0.406], [0.229, 0.224, 0.225]), dims: [1, 3, h, w] });
      const [oh, ow] = r.dims.slice(-2);
      return maskTex(normalizeMinMax(r.data), ow, oh);
    });
    return { d };
  },
  passes: [{ frag: `void main() { float d = clamp(texture(u_d, v_uv).r, 0.0, 1.0); fragColor = vec4(vec3(u_invert ? 1.0 - d : d), 1.0); }` }],
});

// ----------------------------------------------------------------------------------------------- Normal
const normal = defineNode({
  id: 'control.normal',
  name: 'Normal Map (ControlNet)',
  category: CATEGORY,
  color: CONTROL_COLOR,
  heavy: true,
  description:
    'Normal map in the ControlNet normalbae convention (ScanNet / NYU-v2 protocol): red = surface faces LEFT, green = up, blue = towards the viewer; ' +
    'a wall facing the camera is lilac (128,128,255). Uses MoGe-2 (MIT, as Surface Normals) locally. ' +
    'Connect an OpenGL normal map (e.g. Surface Normals → normals: red = right) to “normals” to convert that instead (the red channel is flipped).',
  tags: ['controlnet', 'normal', 'normal map', 'normalbae', 'bae', 'surface', 'control map', 'stable diffusion', 'preprocessor'],
  inputs: { image: { type: 'image', label: 'Image' }, normals: { type: 'image', label: 'OpenGL normals (optional)', optional: true } },
  params: {
    resolution: { ...resolutionParam(518), step: 14, min: 392, max: 672, description: 'Short side fed to MoGe-2.' },
    flatBackground: { type: 'bool', default: true, label: 'Flat sky', description: 'Where the model sees no geometry (sky), output a normal facing the camera.' },
  },
  cpuReadsInputs: true,
  cpu: async (ctx) => {
    const given = ctx.readInput('normals');
    if (given) {
      const d = new Float32Array(given.data.length);
      const k = given.data instanceof Uint8Array ? 1 / 255 : 1;
      for (let i = 0; i < d.length; i++) d[i] = (i & 3) === 3 ? 1 : given.data[i] * k;
      return { n: { width: given.width, height: given.height, data: d } };
    }
    const src = ctx.readInput('image');
    if (!src) return { n: { width: 1, height: 1, data: new Float32Array([0.5, 0.5, 1, 1]) } };
    const g = await moge(src, res(ctx.params.resolution, 518));
    return { n: g.normals };
  },
  passes: [
    {
      frag: /* glsl */ `
void main() {
  vec4 t = texture(u_n, v_uv);
  vec3 n = t.rgb * 2.0 - 1.0;          // OpenGL: x right, y up, z towards the viewer
  if (u_flatBackground) n = mix(vec3(0.0, 0.0, 1.0), n, smoothstep(0.25, 0.75, t.a));
  n = normalize(vec3(-n.x, n.y, max(n.z, 0.0)));   // normalbae: red = left
  fragColor = vec4(n * 0.5 + 0.5, 1.0);
}`,
    },
  ],
});

// ------------------------------------------------------------------------------------------------- MLSD
const mlsdMemo = new InferenceMemo<number[][]>(6);

const mlsd = defineNode({
  id: 'control.mlsd',
  name: 'M-LSD Lines (ControlNet)',
  category: CATEGORY,
  color: CONTROL_COLOR,
  heavy: true,
  description:
    'Straight line segments for the ControlNet mlsd model (architecture, interiors): white lines on black. ' +
    'M-LSD tiny (Apache-2.0, 2.6 MB) runs locally; lines are decoded exactly like the mlsd preprocessor (value / distance thresholds) and drawn at the detect resolution.',
  tags: ['controlnet', 'mlsd', 'm-lsd', 'lines', 'straight lines', 'architecture', 'control map', 'stable diffusion', 'preprocessor'],
  inputs: { image: { type: 'image', label: 'Image' } },
  params: {
    resolution: resolutionParam(512),
    scoreThreshold: { type: 'float', default: 0.1, min: 0.01, max: 2, step: 0.01, label: 'Value threshold', description: 'thr_v: minimum line-centre confidence.' },
    distanceThreshold: { type: 'float', default: 0.1, min: 0.01, max: 20, step: 0.01, label: 'Distance threshold', description: 'thr_d: minimum segment length (model grid px).' },
    thickness: { type: 'float', default: 1, min: 0.5, max: 12, step: 0.5, label: 'Thickness', description: 'Line width in px at the detect resolution (1 = standard).' },
  },
  cpuReadsInputs: true,
  cpu: async (ctx) => {
    const src = ctx.readInput('image');
    if (!src) return { m: flat(0) };
    const rgb = resampleRGB(src.data, src.width, src.height, 512, 512);
    const segs = await mlsdMemo.get('mlsd-tiny', fingerprint(rgb, 512, 512), Math.min(src.width, src.height), 512, async () => {
      const r = await runModel('mlsd-tiny', { data: mlsdInput(rgb, 512, 512), dims: [1, 4, 512, 512] });
      const [gh, gw] = r.dims.slice(-2);
      // keep everything above a tiny floor; the node's thresholds filter later (cheap)
      return decodeMlsd(r.data, gw, gh, 0.01, 0.01);
    });
    const [w, h] = detectDims(src.width, src.height, res(ctx.params.resolution));
    const { canvas, g } = makeCanvas(w, h);
    g.fillStyle = '#000';
    g.fillRect(0, 0, w, h);
    g.strokeStyle = '#fff';
    g.lineWidth = Number(ctx.params.thickness) || 1;
    g.lineCap = 'butt';
    const thrV = Number(ctx.params.scoreThreshold ?? 0.1), thrD = Number(ctx.params.distanceThreshold ?? 0.1);
    const kx = w / 512, ky = h / 512;
    g.beginPath();
    for (const [x0, y0, x1, y1, score, dist] of segs) {
      if (score <= thrV || dist <= thrD) continue;
      g.moveTo(x0 * kx, y0 * ky);
      g.lineTo(x1 * kx, y1 * ky);
    }
    g.stroke();
    return { m: canvas };
  },
  passes: [{ frag: greyOut('u_m') }],
});

export default [lineart, depth, normal, mlsd] satisfies NodeDef[];
