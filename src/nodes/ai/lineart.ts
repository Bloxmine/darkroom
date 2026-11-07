/** Photo → line drawing with the Informative Drawings generators (anime, contour, OpenSketch styles). */
import { fingerprint, fitDims, InferenceMemo, maskTex, resampleRGB, toCHW } from '../../core/ai/image';
import { runModel } from '../../core/ai/runtime';
import { defineNode } from '../../core/registry';
import type { NodeDef, Params, RawTex } from '../../core/types';
import { BICUBIC_GLSL, isFlat } from './_img';
import { AI_COLOR } from './_shared';

const STYLES: Record<string, string> = {
  'Fine lines (anime)': 'informative-drawings-anime',
  'Bold contours': 'informative-drawings-contour',
  'Pencil sketch (OpenSketch)': 'informative-drawings-opensketch',
};
const NAMES = Object.keys(STYLES);
const memo = new InferenceMemo<RawTex>(8);
const dimsOf = (p: Params, w: number, h: number) => fitDims(w, h, Number(p.size) || 768, 8);

const lineArt = defineNode({
  id: 'ai.lineArt',
  name: 'AI Line Art',
  category: 'AI',
  color: AI_COLOR,
  description:
    'Turns a photo into a clean line drawing with the Informative Drawings generators (Chan, Durand & Isola, CVPR 2022), locally in the browser (~17 MB per style). ' +
    'Fine lines (anime style), bold contours, or a loose pencil sketch (OpenSketch). Inference size sets the level of detail; ' +
    'line weight thickens strokes, contrast hardens them, and ink/paper colours (or invert) set the look.',
  tags: ['line art', 'lineart', 'drawing', 'sketch', 'ink', 'pencil', 'contour', 'outline', 'comic', 'manga', 'coloring book', 'ai', 'ml'],
  inputs: { image: { type: 'image', label: 'Image' } },
  params: {
    style: { type: 'enum', default: NAMES[0], options: NAMES, label: 'Style' },
    size: {
      type: 'enum',
      default: '768',
      options: ['384', '512', '768', '1024', '1280'],
      label: 'Inference size (detail)',
      description: 'Short side fed to the network: larger = more, finer lines.',
    },
    weight: { type: 'float', default: 0, min: 0, max: 6, step: 0.1, pixels: true, label: 'Line weight', description: 'Thickens strokes (px).' },
    contrast: { type: 'float', default: 0.3, min: 0, max: 0.95, step: 0.01, label: 'Contrast', description: '0 = soft as drawn, higher = crisper, darker strokes.' },
    darkness: { type: 'float', default: 1, min: 0.2, max: 3, step: 0.01, label: 'Darkness', description: 'Gamma on the ink: >1 darkens faint strokes.' },
    ink: { type: 'color', default: [0.08, 0.08, 0.1, 1], label: 'Ink colour' },
    paper: { type: 'color', default: [0.97, 0.95, 0.9, 1], label: 'Paper colour' },
    invert: { type: 'bool', default: false, label: 'Invert (light lines on dark)' },
  },
  cpuReadsInputs: true,
  cpu: async (ctx) => {
    const src = ctx.readInput('image');
    if (!src) return { lines: maskTex([1], 1, 1) };
    const [w, h] = dimsOf(ctx.params, src.width, src.height);
    const rgb = resampleRGB(src.data, src.width, src.height, w, h);
    const fp = fingerprint(rgb, w, h);
    if (isFlat(fp)) return { lines: maskTex([1], 1, 1) };
    const name = NAMES.includes(String(ctx.params.style)) ? String(ctx.params.style) : NAMES[0];
    const model = STYLES[name];
    const lines = await memo.get(`${model}:${w}x${h}`, fp, Math.min(src.width, src.height), Math.min(w, h), async () => {
      const r = await runModel(model, { data: toCHW(rgb, w, h, [0, 0, 0], [1, 1, 1]), dims: [1, 3, h, w] });
      const [oh, ow] = r.dims.slice(-2);
      return maskTex(r.data, ow, oh);
    });
    return { lines };
  },
  passes: [
    {
      frag: /* glsl */ `
${BICUBIC_GLSL}
float inkAt(vec2 uv) { return 1.0 - clamp(bicubic(u_lines, u_lines_size, uv).r, 0.0, 1.0); }
void main() {
  vec4 src = texture(u_image, v_uv);
  float k = inkAt(v_uv);
  float r = u_weight * u_scale;
  if (r > 0.25) {
    // dilate the strokes: max over two rings
    for (int i = 0; i < 12; i++) {
      float a = float(i) * 0.5235988;
      vec2 d = vec2(cos(a), sin(a)) / u_resolution;
      k = max(k, inkAt(v_uv + d * r));
      k = max(k, inkAt(v_uv + d * r * 0.5));
    }
  }
  k = clamp((k - u_contrast * 0.5) / max(1.0 - u_contrast, 0.05), 0.0, 1.0);
  k = pow(k, 1.0 / u_darkness);
  vec4 ink = u_invert ? u_paper : u_ink;
  vec4 paper = u_invert ? u_ink : u_paper;
  vec4 c = mix(paper, ink, k * ink.a);
  fragColor = vec4(c.rgb, max(paper.a, k * ink.a) * src.a);
}`,
    },
  ],
});

export default [lineArt] satisfies NodeDef[];
