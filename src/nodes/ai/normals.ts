/**
 * Surface Normals (AI): MoGe-2 ViT-S predicts per-pixel surface normals and an affine point map in one
 * pass. Outputs a normal map (OpenGL convention, see relight-math.ts), a relative depth map (near =
 * white, like ai.depth) and the model's geometry mask (≈ everything but the sky). Feeds ai.relight.
 */
import '../../core/ai/models-relight';
import { fingerprint, fitDims, InferenceMemo, maskTex, resampleRGB, toCHW } from '../../core/ai/image';
import { runModelMulti } from '../../core/ai/runtime';
import { defineNode } from '../../core/registry';
import type { NodeDef } from '../../core/types';
import { AI_COLOR, GUIDE_FRAG, JBU4_GLSL, JBU_GLSL } from './_shared';
import { geometryTextures, type Geo } from './relight-math';

const memo = new InferenceMemo<Geo>(4);
const shortSide = (v: unknown) => Number(v) || 518;
const DETAIL: Record<string, number> = { 'Fast (1200 tokens)': 1200, 'Balanced (1800 tokens)': 1800, 'Fine (2500 tokens)': 2500 };
const tokens = (v: unknown) => DETAIL[String(v)] ?? 1800;

const normals = defineNode({
  id: 'ai.normals',
  name: 'Surface Normals',
  category: 'AI',
  color: AI_COLOR,
  description:
    'Estimates surface normals (which way each surface faces) and relative depth from a single photo with MoGe-2 (Microsoft, MIT licence), running locally (WebGPU, or WASM on the CPU). ' +
    'The model (141 MB) downloads once on first use and is cached for offline use. Outputs a normal map (OpenGL convention: red = right, green = up, blue = towards you), a depth map (near = white) and a geometry mask (everything but the sky). ' +
    'Wire “normals” and “depth” into Relight for shading and shadows that follow the real shape of faces and objects. Low-res predictions are upsampled edge-aware against the image.',
  tags: ['normals', 'normal map', 'surface', 'geometry', 'shape', '3d', 'relight', 'moge', 'depth', 'ai', 'ml', 'neural'],
  inputs: { image: { type: 'image', label: 'Image' } },
  outputs: {
    normals: { type: 'image', label: 'Normals' },
    depth: { type: 'mask', label: 'Depth' },
    mask: { type: 'mask', label: 'Geometry (not sky)' },
  },
  params: {
    resolution: {
      type: 'enum',
      default: '518',
      options: ['392', '518', '672'],
      label: 'Inference size',
      description: 'Short side of the image fed to the model; its output comes back at this size before the edge-aware upsample.',
    },
    detail: {
      type: 'enum',
      default: 'Balanced (1800 tokens)',
      options: Object.keys(DETAIL),
      label: 'Detail',
      description: 'Number of ViT tokens MoGe-2 works with (its internal resolution). More = finer shape, slower.',
    },
    strength: { type: 'float', default: 1, min: 0, max: 3, step: 0.01, label: 'Normal strength', description: '< 1 flattens the surfaces, > 1 exaggerates their relief.' },
    edges: { type: 'float', default: 0.8, min: 0, max: 1, step: 0.01, label: 'Edge refine', description: 'Edge-aware upsampling: snap normal and depth edges to image edges.' },
    smoothing: { type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, label: 'Smoothing' },
    flatSky: { type: 'bool', default: true, label: 'Flat sky', description: 'Where the model sees no geometry (sky), output a flat normal facing the camera instead of noise.' },
  },
  cpuReadsInputs: true,
  cpu: async (ctx) => {
    const src = ctx.readInput('image');
    if (!src) return { lrn: { width: 1, height: 1, data: new Float32Array([0.5, 0.5, 1, 1]) }, lrd: maskTex([0.5], 1, 1) };
    const short = shortSide(ctx.params.resolution);
    const tok = tokens(ctx.params.detail);
    const [w, h] = fitDims(src.width, src.height, short, 14);
    const rgb = resampleRGB(src.data, src.width, src.height, w, h);
    const geo = await memo.get(`moge2s:${short}:${tok}`, fingerprint(rgb, w, h), Math.min(src.width, src.height), short, async () => {
      const r = await runModelMulti(
        'moge-2-vits-normal',
        { image: { data: toCHW(rgb, w, h, [0, 0, 0], [1, 1, 1]), dims: [1, 3, h, w] }, num_tokens: { data: Float32Array.of(tok), dims: [], type: 'int64' } },
        ['points', 'normal', 'mask'],
      );
      const [, oh, ow] = r.normal.dims;
      return geometryTextures(r.points.data, r.normal.data, r.mask.data, ow, oh);
    });
    return { lrn: geo.normals, lrd: geo.depth };
  },
  passes: [
    // 0: low-res guide
    { size: (c) => fitDims(c.width, c.height, shortSide(c.params.resolution), 14), frag: GUIDE_FRAG },
    // 1: normals, edge-aware upsampled (rgb = encoded normal, a = geometry mask)
    {
      output: 'normals',
      frag: /* glsl */ `
${JBU4_GLSL}
void main() {
  vec4 v = u_edges <= 0.0 && u_smoothing <= 0.0 ? texture(u_lrn, v_uv) : jbu4(u_lrn, u_lrn_size, u_pass0, u_edges, u_smoothing);
  vec3 n = v.rgb * 2.0 - 1.0;
  n.xy *= u_strength;
  n.z = max(n.z, 0.02);
  if (u_flatSky) n = mix(vec3(0.0, 0.0, 1.0), normalize(n), smoothstep(0.25, 0.75, v.a));
  n = normalize(n);
  fragColor = vec4(n * 0.5 + 0.5, 1.0);
}`,
    },
    // 2: geometry mask
    {
      output: 'mask',
      frag: /* glsl */ `
${JBU4_GLSL}
void main() {
  float m = jbu4(u_lrn, u_lrn_size, u_pass0, u_edges, u_smoothing).a;
  fragColor = vec4(vec3(clamp(m, 0.0, 1.0)), 1.0);
}`,
    },
    // 3: depth (near = white)
    {
      output: 'depth',
      frag: /* glsl */ `
${JBU_GLSL}
void main() {
  float d = u_edges <= 0.0 && u_smoothing <= 0.0 ? texture(u_lrd, v_uv).r : jbu(u_lrd, u_lrd_size, u_pass0, u_edges, u_smoothing);
  fragColor = vec4(vec3(clamp(d, 0.0, 1.0)), 1.0);
}`,
    },
  ],
});

export default [normals] satisfies NodeDef[];
