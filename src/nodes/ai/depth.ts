/** AI depth estimation (Depth Anything V2 Small, in-browser via ONNX Runtime Web). */
import { fingerprint, fitDims, InferenceMemo, maskTex, normalizeRobust, resampleRGB, toCHW } from '../../core/ai/image';
import { runModel } from '../../core/ai/runtime';
import { defineNode } from '../../core/registry';
import type { NodeDef, RawTex } from '../../core/types';
import { AI_COLOR, GUIDE_FRAG, JBU_GLSL } from './_shared';

const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
const memo = new InferenceMemo<RawTex>(6);
const shortSide = (v: unknown) => Number(v) || 392;

const depth = defineNode({
  id: 'ai.depth',
  name: 'Depth Map',
  category: 'AI',
  color: AI_COLOR,
  description:
    'Estimates a depth map from a single photo with Depth Anything V2 Small, running locally in the browser (WebGPU, or WASM on the CPU). ' +
    'Output is a mask, near = white. The model (~27–50 MB) downloads once on first use and is cached for offline use. ' +
    'The low-res prediction is upsampled edge-aware against the image so depth edges stay crisp. ' +
    'Inference is cached per image content and resolution: changing the remap/refine params, or the preview scale, does not re-run the model.',
  tags: ['depth', 'ai', 'ml', 'depth anything', 'z', 'distance', 'monocular', '3d', 'dof', 'mask', 'neural'],
  inputs: { image: { type: 'image', label: 'Image' } },
  outputs: { depth: { type: 'mask', label: 'Depth' } },
  params: {
    model: { type: 'enum', default: 'Depth Anything V2 Small', options: ['Depth Anything V2 Small'], label: 'Model' },
    resolution: {
      type: 'enum',
      default: '392',
      options: ['252', '392', '518'],
      label: 'Inference size',
      description: 'Short side of the image fed to the model (multiple of 14). 518 = most detail, 252 = fastest.',
    },
    near: { type: 'float', default: 1, min: 0, max: 1, step: 0.005, label: 'Near level', description: 'Raw depth value mapped to white.' },
    far: { type: 'float', default: 0, min: 0, max: 1, step: 0.005, label: 'Far level', description: 'Raw depth value mapped to black.' },
    gamma: { type: 'float', default: 1, min: 0.2, max: 5, step: 0.01, label: 'Gamma', description: '>1 pushes mid-depths away, <1 pulls them nearer.' },
    edges: { type: 'float', default: 0.85, min: 0, max: 1, step: 0.01, label: 'Edge refine', description: 'Edge-aware upsampling: snap depth edges to image edges.' },
    smoothing: { type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, label: 'Smoothing' },
    invert: { type: 'bool', default: false, label: 'Invert (far = white)' },
  },
  cpuReadsInputs: true,
  cpu: async (ctx) => {
    const src = ctx.readInput('image');
    if (!src) return { lr: maskTex([0.5], 1, 1) };
    const short = shortSide(ctx.params.resolution);
    const [w, h] = fitDims(src.width, src.height, short, 14);
    const rgb = resampleRGB(src.data, src.width, src.height, w, h);
    const tex = await memo.get(`da2s:${short}`, fingerprint(rgb, w, h), Math.min(src.width, src.height), short, async () => {
      const r = await runModel('depth-anything-v2-small', { data: toCHW(rgb, w, h, MEAN, STD), dims: [1, 3, h, w] });
      const [oh, ow] = r.dims.slice(-2);
      return maskTex(normalizeRobust(r.data), ow, oh);
    });
    return { lr: tex };
  },
  passes: [
    { size: (c) => fitDims(c.width, c.height, shortSide(c.params.resolution), 14), frag: GUIDE_FRAG },
    {
      frag: /* glsl */ `
${JBU_GLSL}
void main() {
  float d = u_edges <= 0.0 && u_smoothing <= 0.0 ? texture(u_lr, v_uv).r : jbu(u_lr, u_lr_size, u_pass0, u_edges, u_smoothing);
  float span = u_near - u_far;
  d = clamp((d - u_far) / (abs(span) < 1e-4 ? 1e-4 : span), 0.0, 1.0);
  d = pow(d, u_gamma);
  if (u_invert) d = 1.0 - d;
  fragColor = vec4(vec3(d), 1.0);
}`,
    },
  ],
});

export default [depth] satisfies NodeDef[];
