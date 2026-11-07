/** AI subject / background mask (MODNet portrait matting or U²-Net-p salient object), in-browser. */
import { fingerprint, fitDims, InferenceMemo, maskTex, normalizeMinMax, resampleRGB, toCHW } from '../../core/ai/image';
import { runModel } from '../../core/ai/runtime';
import { defineNode } from '../../core/registry';
import type { NodeDef, Params, RawTex } from '../../core/types';
import { AI_COLOR, GUIDE_FRAG, JBU_GLSL } from './_shared';

const MODELS = ['Portrait (MODNet)', 'Object (U²-Net-p)'];
const memo = new InferenceMemo<RawTex>(6);

/** Model input dims for an image of w×h. */
function dims(params: Params, w: number, h: number): [number, number] {
  if (params.model === MODELS[1]) return [320, 320];
  return fitDims(w, h, Number(params.resolution) || 512, 32);
}

/**
 * Low-res subject matte (RawTex, value in .r) of an RGBA float image: MODNet portrait matte or U²-Net-p
 * salient-object map. Memoised by content fingerprint; shared with other nodes (e.g. ai.autoCrop).
 */
export async function subjectMatte(src: RawTex, model: 'portrait' | 'object', resolution = 512): Promise<RawTex> {
  const u2 = model === 'object';
  const [w, h] = dims({ model: u2 ? MODELS[1] : MODELS[0], resolution }, src.width, src.height);
  const rgb = resampleRGB(src.data, src.width, src.height, w, h);
  const key = u2 ? 'u2netp' : `modnet:${w}x${h}`;
  return memo.get(key, fingerprint(rgb, w, h), Math.min(src.width, src.height), Math.min(w, h), async () => {
    if (u2) {
      // rembg preprocessing: divide by the image max, then ImageNet mean/std
      let mx = 1e-6;
      for (let i = 0; i < rgb.length; i++) if (rgb[i] > mx) mx = rgb[i];
      const r = await runModel('u2netp', { data: toCHW(rgb, w, h, [0.485, 0.456, 0.406], [0.229, 0.224, 0.225], mx), dims: [1, 3, h, w] });
      const [oh, ow] = r.dims.slice(-2);
      return maskTex(normalizeMinMax(r.data), ow, oh);
    }
    const r = await runModel('modnet', { data: toCHW(rgb, w, h, [0.5, 0.5, 0.5], [0.5, 0.5, 0.5]), dims: [1, 3, h, w] });
    const [oh, ow] = r.dims.slice(-2);
    return maskTex(r.data, ow, oh);
  });
}

const subject = defineNode({
  id: 'ai.subjectMask',
  name: 'Subject Mask',
  category: 'AI',
  color: AI_COLOR,
  description:
    'Separates the subject from the background with a neural network running locally in the browser. ' +
    'Portrait (MODNet, ~26 MB) gives a soft alpha matte with hair detail for people; Object (U²-Net-p, ~4.6 MB) finds the main salient object of any kind. ' +
    'Output mask: subject = white. Edge-aware refine snaps the matte to image edges; threshold/softness harden it, feather blurs it. ' +
    'Downloads once, then cached offline. Inference is cached per image, so tweaking the params is instant.',
  tags: ['subject', 'background removal', 'remove background', 'cutout', 'matte', 'matting', 'segmentation', 'person', 'portrait', 'ai', 'ml', 'mask', 'salient'],
  inputs: { image: { type: 'image', label: 'Image' } },
  outputs: { mask: { type: 'mask', label: 'Mask' } },
  params: {
    model: { type: 'enum', default: MODELS[0], options: MODELS, label: 'Model', description: 'Portrait: people (best hair). Object: any main subject.' },
    resolution: { type: 'enum', default: '512', options: ['256', '384', '512', '768'], label: 'Inference size', description: 'Short side fed to MODNet (U²-Net-p always uses 320×320).' },
    refine: { type: 'float', default: 0.8, min: 0, max: 1, step: 0.01, label: 'Edge refine', description: 'Edge-aware upsampling against the image.' },
    threshold: { type: 'float', default: 0.5, min: 0, max: 1, step: 0.005, label: 'Threshold' },
    softness: { type: 'float', default: 1, min: 0, max: 1, step: 0.005, label: 'Softness', description: '1 = keep the soft matte, 0 = hard cut at the threshold.' },
    feather: { type: 'float', default: 0, min: 0, max: 100, step: 0.5, pixels: true, label: 'Feather' },
    invert: { type: 'bool', default: false, label: 'Invert (select background)' },
  },
  cpuReadsInputs: true,
  cpu: async (ctx) => {
    const src = ctx.readInput('image');
    if (!src) return { matte: maskTex([1], 1, 1) };
    const tex = await subjectMatte(src, ctx.params.model === MODELS[1] ? 'object' : 'portrait', Number(ctx.params.resolution) || 512);
    return { matte: tex };
  },
  passes: [
    { size: (c) => dims(c.params, c.width, c.height), frag: GUIDE_FRAG },
    {
      frag: /* glsl */ `
${JBU_GLSL}
void main() {
  float m = u_refine <= 0.0 ? texture(u_matte, v_uv).r : jbu(u_matte, u_matte_size, u_pass0, u_refine, 0.15);
  float lo = u_threshold - u_softness * 0.5, hi = u_threshold + u_softness * 0.5;
  m = clamp((m - lo) / max(hi - lo, 1e-3), 0.0, 1.0);
  fragColor = vec4(vec3(m), 1.0);
}`,
    },
    { frag: blur(false) },
    { frag: blur(true) },
  ],
});

function blur(vertical: boolean) {
  return /* glsl */ `
void main() {
  float r = u_feather * u_scale;
  float m;
  if (r < 0.5) m = texture(u_prev, v_uv).r;
  else {
    int n = int(min(ceil(r), 48.0));
    float stp = r / float(n), sig = r * 0.5;
    vec2 dir = ${vertical ? 'vec2(0.0, 1.0)' : 'vec2(1.0, 0.0)'} / u_resolution;
    float acc = 0.0, ws = 0.0;
    for (int i = -48; i <= 48; i++) {
      if (i < -n || i > n) continue;
      float x = float(i) * stp;
      float w = exp(-x * x / (2.0 * sig * sig));
      acc += texClamp(u_prev, v_uv + dir * x).r * w; ws += w;
    }
    m = acc / ws;
  }
  ${vertical ? 'if (u_invert) m = 1.0 - m;' : ''}
  fragColor = vec4(vec3(m), 1.0);
}`;
}

export default [subject] satisfies NodeDef[];
