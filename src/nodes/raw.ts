import { defineNode } from '../core/registry';
import { decodeOptions, DEMOSAIC_MODES, DENOISE_MODES, HIGHLIGHT_MODES, OUTPUT_MODES, wbGains, WB_MODES } from '../core/raw/develop';
import { decodeRaw } from '../core/raw/decoder';
import { RAW, RAW_ACCEPT } from '../core/raw/formats';
import type { NodeDef } from '../core/types';

/**
 * Camera RAW input. LibRaw (WASM, in a worker) demosaics the file; the decode
 * is re-run when a decode param changes (cached per asset + params). Exposure
 * and custom white balance are applied on the GPU in linear light, then the
 * result is encoded to the engine's display-referred sRGB.
 */
const nodes: NodeDef[] = [
  defineNode({
    id: RAW,
    name: 'RAW Photo',
    category: 'Input',
    description:
      'A camera RAW file (DNG, CR2, CR3, NEF, ARW, RAF, ORF, RW2, PEF, SRW…) developed with LibRaw. Drop a RAW file onto the canvas to create one. Preview decodes at half size; export decodes at full resolution.',
    tags: ['raw', 'dng', 'cr2', 'cr3', 'nef', 'arw', 'raf', 'orf', 'rw2', 'camera', 'photo', 'develop', 'libraw', 'input'],
    color: '#2fa36b',
    inputs: {},
    params: {
      asset: { type: 'asset', default: '', label: 'RAW file', accept: RAW_ACCEPT },
      whiteBalance: {
        type: 'enum',
        default: 'as shot',
        options: [...WB_MODES],
        label: 'White balance',
        description: 'As shot = camera setting · Auto = grey-world · Daylight = camera daylight multipliers · Custom = daylight + Temperature/Tint below.',
      },
      temperature: { type: 'float', default: 5500, min: 2000, max: 12000, step: 50, label: 'Temperature (K)', description: 'Light source colour temperature (White balance = Custom). Lower = bluer result.' },
      tint: { type: 'float', default: 0, min: -100, max: 100, step: 1, label: 'Tint', description: 'Green (−) / magenta (+) correction (White balance = Custom).' },
      exposure: { type: 'float', default: 0, min: -5, max: 5, step: 0.01, label: 'Exposure (EV)', description: 'Exposure compensation in stops, applied in linear light before encoding.' },
      highlights: {
        type: 'enum',
        default: 'clip',
        options: [...HIGHLIGHT_MODES],
        label: 'Highlights',
        description: 'Highlight recovery: clip (neutral white), unclip (keep colour, may tint), blend (soft), rebuild (reconstruct from unclipped channels).',
      },
      output: {
        type: 'enum',
        default: '16-bit linear',
        options: [...OUTPUT_MODES],
        label: 'Output',
        description: '16-bit linear keeps LibRaw’s full precision as a float texture. 8-bit sRGB encodes to 8 bits per channel first: 4× less memory for very large files, but highlights above white are clipped and gradients may band.',
      },
      demosaic: {
        type: 'enum',
        default: 'AHD',
        options: [...DEMOSAIC_MODES],
        label: 'Demosaic',
        description: 'Interpolation for full-size decodes (export / zoomed-in preview). Half-size previews skip demosaicing.',
      },
      denoise: { type: 'enum', default: 'off', options: [...DENOISE_MODES], label: 'Noise reduction', description: 'LibRaw FBDD noise reduction before demosaicing.' },
      fastPreview: { type: 'bool', default: true, label: 'Fast preview', description: 'Decode at half size when the preview renders at ≤ 50 % scale. Export always decodes at full size.' },
    },
    size: ({ params, getAsset, projectSize }) => {
      const a = getAsset(String(params.asset ?? ''));
      return a?.width && a.height ? [a.width, a.height] : [projectSize.width, projectSize.height];
    },
    cpu: async ({ params, getAsset, scale }) => {
      const id = String(params.asset ?? '');
      const a = id ? getAsset(id) : undefined;
      if (!a) {
        if (id) throw new Error('RAW file not loaded.');
        // placeholder: soft gray gradient, linear light
        const w = 64, h = 64, d = new Float32Array(w * h * 4);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4, v = Math.pow((60 + ((x + y) / (w + h)) * 80) / 255, 2.2);
          d[i] = d[i + 1] = d[i + 2] = v;
          d[i + 3] = 1;
        }
        return { src: { width: w, height: h, data: d } };
      }
      if (!a.raw) throw new Error(`${a.name} is not a RAW file — use an Image node.`);
      const r = await decodeRaw(a.id, a.raw.bytes, decodeOptions(params, scale));
      return { src: { width: r.width, height: r.height, data: r.data } };
    },
    passes: [
      {
        frag: `
uniform vec3 u_gain;
void main() {
  vec3 c = texture(u_src, v_uv).rgb;
  vec3 lin = u_output == 0 ? c : srgbToLinear(c);
  lin *= u_gain * exp2(u_exposure);
  fragColor = vec4(linearToSrgb(max(lin, 0.0)), 1.0);
}`,
        uniforms: ({ params }) => ({
          u_gain: params.whiteBalance === 'custom' ? wbGains(Number(params.temperature ?? 5500), Number(params.tint ?? 0)) : [1, 1, 1],
        }),
      },
    ],
  }),
];

export default nodes;
