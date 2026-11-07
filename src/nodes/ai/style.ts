/** Neural style transfer with the ONNX Model Zoo fast-neural-style networks (one network per style). */
import { fingerprint, fitDims, InferenceMemo, resampleRGB, toCHW } from '../../core/ai/image';
import { styleModelId, STYLE_MODELS } from '../../core/ai/models-img';
import { runModel } from '../../core/ai/runtime';
import { defineNode } from '../../core/registry';
import type { NodeDef, Params, RawTex } from '../../core/types';
import { BICUBIC_GLSL, isFlat, planesTex } from './_img';
import { AI_COLOR } from './_shared';

const STYLES = Object.keys(STYLE_MODELS);
const memo = new InferenceMemo<RawTex>(8);
const dimsOf = (p: Params, w: number, h: number) => fitDims(w, h, Number(p.size) || 512, 4);

const style = defineNode({
  id: 'ai.styleTransfer',
  name: 'Neural Style',
  category: 'AI',
  color: AI_COLOR,
  description:
    'Repaints the photo in the style of a famous painting with a fast neural style network (Johnson et al.), locally in the browser (~6.7 MB per style). ' +
    'Inference size sets the brush scale: smaller = bigger strokes and shapes, larger = finer texture. ' +
    'Preserve colour keeps the original colours and transfers only the painted luminance. Cached per image, style and size.',
  tags: ['style transfer', 'neural style', 'painting', 'art', 'mosaic', 'candy', 'udnie', 'rain princess', 'pointillism', 'ai', 'ml', 'artistic'],
  inputs: { image: { type: 'image', label: 'Image' } },
  params: {
    style: { type: 'enum', default: STYLES[0], options: STYLES, label: 'Style' },
    strength: { type: 'float', default: 1, min: 0, max: 1, step: 0.01, label: 'Strength', description: 'Mix with the original.' },
    size: {
      type: 'enum',
      default: '512',
      options: ['256', '384', '512', '768', '1024'],
      label: 'Inference size (style scale)',
      description: 'Short side fed to the network. Smaller = bolder, larger brush marks relative to the image.',
    },
    preserveColor: { type: 'bool', default: false, label: 'Preserve colour', description: 'Luminance-only transfer: keep the original colours.' },
  },
  cpuReadsInputs: true,
  cpu: async (ctx) => {
    const src = ctx.readInput('image');
    if (!src) return { styled: { width: 1, height: 1, data: new Float32Array(4) } };
    const [w, h] = dimsOf(ctx.params, src.width, src.height);
    const rgb = resampleRGB(src.data, src.width, src.height, w, h);
    const fp = fingerprint(rgb, w, h);
    if (isFlat(fp)) return { styled: { width: 1, height: 1, data: new Float32Array(4) } };
    const name = STYLES.includes(String(ctx.params.style)) ? String(ctx.params.style) : STYLES[0];
    const styled = await memo.get(`${name}:${w}x${h}`, fp, Math.min(src.width, src.height), Math.min(w, h), async () => {
      const r = await runModel(styleModelId(name), { data: toCHW(rgb, w, h, [0, 0, 0], [1, 1, 1], 1 / 255), dims: [1, 3, h, w] });
      const [oh, ow] = r.dims.slice(-2);
      for (let i = 0; i < r.data.length; i++) r.data[i] = Math.min(1, Math.max(0, r.data[i] / 255));
      return planesTex(r.data, 3, ow, oh);
    });
    return { styled };
  },
  passes: [
    {
      frag: /* glsl */ `
${BICUBIC_GLSL}
void main() {
  vec4 src = texture(u_image, v_uv);
  if (u_styled_size.x < 2.0) { fragColor = src; return; }
  vec3 s = clamp(bicubic(u_styled, u_styled_size, v_uv).rgb, 0.0, 1.0);
  if (u_preserveColor) {
    // stylised luminance + original chroma (YCbCr)
    vec3 o = rgb2ycbcr(src.rgb);
    s = clamp(ycbcr2rgb(vec3(rgb2ycbcr(s).x, o.yz)), 0.0, 1.0);
  }
  fragColor = vec4(mix(src.rgb, s, u_strength), src.a);
}`,
    },
  ],
});

export default [style] satisfies NodeDef[];
