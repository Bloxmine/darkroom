/**
 * Arbitrary style transfer from any style image (AdaIN, Huang & Belongie 2017), in the browser.
 * VGG-19 encoder → AdaIN (content features take the per-channel mean/std of the style features) →
 * decoder. The style statistics (2 × 512 floats) are cached per style image and style scale, the
 * content features per image and size, so changing the strength only re-runs the decoder.
 */
import '../../core/ai/models-motion';
import { fingerprint, fitDims, InferenceMemo, resampleRGB, toCHW } from '../../core/ai/image';
import { runModel, setAiTask } from '../../core/ai/runtime';
import { defineNode } from '../../core/registry';
import type { NodeDef, RawTex } from '../../core/types';
import { BICUBIC_GLSL, isFlat, planesTex } from './_img';
import { AI_COLOR } from './_shared';
import { adain, featStats } from './styleImageOnnx';

type Stats = { mean: Float32Array; std: Float32Array };
const styleMemo = new InferenceMemo<Stats>(8);
const contentMemo = new InferenceMemo<{ feat: Float32Array; dims: number[] }>(2);
const outMemo = new InferenceMemo<RawTex>(6);

/** Encoder input: RGB 0..1 NCHW, H and W multiples of 8. */
async function encode(rgb: Float32Array, w: number, h: number) {
  const r = await runModel('adain-vgg-encoder', { data: toCHW(rgb, w, h, [0, 0, 0], [1, 1, 1]), dims: [1, 3, h, w] });
  return { feat: r.data, dims: r.dims };
}

const empty = (): RawTex => ({ width: 1, height: 1, data: new Float32Array(4) });

const styleFromImage = defineNode({
  id: 'ai.styleFromImage',
  name: 'Style from Image',
  category: 'AI',
  color: AI_COLOR,
  description:
    'Repaints the image in the style of any other image (a painting, a texture, a photo) with AdaIN arbitrary style transfer, locally in the browser (~94 MB download once). ' +
    'Connect the painting to `style`. Strength trades content for style; Style scale sets the size of the brush marks (the style image is resized to it); ' +
    'Preserve colour keeps the original colours. The style is analysed once per style image.',
  tags: ['style transfer', 'arbitrary style', 'adain', 'painting', 'art', 'van gogh', 'texture', 'artistic', 'ai', 'ml'],
  inputs: { image: { type: 'image', label: 'Image' }, style: { type: 'image', label: 'Style image' } },
  params: {
    strength: { type: 'float', default: 1, min: 0, max: 1, step: 0.01, label: 'Strength', description: 'AdaIN content–style trade-off (feature-space mix).' },
    styleScale: {
      type: 'enum',
      default: '512',
      options: ['256', '384', '512', '768', '1024'],
      label: 'Style scale',
      description: 'Short side the style image is resized to. Smaller = bigger, bolder strokes and patterns.',
    },
    resolution: {
      type: 'enum',
      default: '768',
      options: ['384', '512', '768', '1024'],
      label: 'Content resolution',
      description: 'Short side the image is stylised at (long side ≤ 2×). Larger = finer detail relative to the strokes, slower.',
    },
    preserveColor: { type: 'bool', default: false, label: 'Preserve colour', description: 'Keep the original colours; take only the painted luminance.' },
    mix: { type: 'float', default: 1, min: 0, max: 1, step: 0.01, label: 'Mix', description: 'Blend the result with the original image.' },
  },
  cpuReadsInputs: true,
  cpu: async (ctx) => {
    const src = ctx.readInput('image');
    const sty = ctx.readInput('style');
    if (!src || !sty) return { styled: empty() };
    const [w, h] = fitDims(src.width, src.height, Number(ctx.params.resolution) || 768, 8);
    const [sw, sh] = fitDims(sty.width, sty.height, Number(ctx.params.styleScale) || 512, 8);
    const rgb = resampleRGB(src.data, src.width, src.height, w, h);
    const srgb = resampleRGB(sty.data, sty.width, sty.height, sw, sh);
    const fp = fingerprint(rgb, w, h);
    const sfp = fingerprint(srgb, sw, sh);
    if (isFlat(fp) || isFlat(sfp)) return { styled: empty() };
    const alpha = Math.min(1, Math.max(0, Number(ctx.params.strength ?? 1)));
    const sfpKey = Array.from(sfp.subarray(0, 48)).join(',');
    const id = `ai.styleFromImage:${w}x${h}:${sw}x${sh}:${alpha.toFixed(3)}:${sfpKey}`;
    const styled = await outMemo.get(id, fp, Math.min(src.width, src.height), Math.min(w, h), async (signal) => {
      const task = `style${w}x${h}`;
      setAiTask(task, { label: 'Style from Image', done: 0, total: 3 });
      try {
        const style = await styleMemo.get(`style:${sw}x${sh}`, sfp, Math.min(sty.width, sty.height), Math.min(sw, sh), async () => {
          const f = await encode(srgb, sw, sh);
          return featStats(f.feat, f.dims[1]);
        });
        setAiTask(task, { label: 'Style from Image', done: 1, total: 3 });
        if (signal.aborted) throw new DOMException('Superseded', 'AbortError');
        const content = await contentMemo.get(`content:${w}x${h}`, fp, Math.min(src.width, src.height), Math.min(w, h), () => encode(rgb, w, h));
        setAiTask(task, { label: 'Style from Image', done: 2, total: 3 });
        const c = content.dims[1];
        const t = adain(content.feat, c, style, alpha);
        const r = await runModel('adain-decoder', { data: t, dims: content.dims });
        const [oh, ow] = r.dims.slice(-2);
        for (let i = 0; i < r.data.length; i++) r.data[i] = Math.min(1, Math.max(0, r.data[i]));
        return planesTex(r.data, 3, ow, oh);
      } finally {
        setAiTask(task, null);
      }
    }, ctx.signal);
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
    vec3 o = rgb2ycbcr(src.rgb);
    s = clamp(ycbcr2rgb(vec3(rgb2ycbcr(s).x, o.yz)), 0.0, 1.0);
  }
  fragColor = vec4(mix(src.rgb, s, u_mix), src.a);
}`,
    },
  ],
});

export default [styleFromImage] satisfies NodeDef[];
