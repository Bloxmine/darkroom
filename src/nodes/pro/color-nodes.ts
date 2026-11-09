/**
 * Colour management: scene-linear tone mapping, colour-space conversion and linear-light exposure /
 * white balance. All three are per-pixel (colorOnly), so they bake into an exported .cube LUT.
 */
import { defineNode } from '../../core/registry';
import type { NodeDef, PassContext } from '../../core/types';
import { num } from '../library/shared';
import { GLSL_TONEMAP, GLSL_TRANSFER } from './color-glsl';
import { convertMatrix, SPACE_LABELS, spaceByLabel, toGlsl, TONEMAPS, TRANSFER_IDS, whiteBalanceMatrix } from './color-math';

const C = '#5b8fb9';
const img = { image: { type: 'image' as const } };

const tonemap = defineNode({
  id: 'pro.tonemap',
  name: 'Tone Map',
  category: 'Color Management',
  color: C,
  colorOnly: true,
  description:
    'Scene-referred → display tone mapping. Decodes sRGB to linear light (or takes linear HDR data as is when "Input is HDR" is on, e.g. after Merge HDR or a linear RAW), ' +
    'applies exposure in stops, then a filmic operator: AgX (Blender 4 default, with Punchy / Golden looks), ACES (Hill RRT+ODT fit or Narkowicz), Blender-style Filmic, ' +
    'Reinhard extended, Uchimura (Gran Turismo) or Hable (Uncharted 2), and encodes for display. On ordinary photos raise Exposure to taste: the operators roll highlights off smoothly instead of clipping.',
  tags: ['tonemap', 'tone mapping', 'agx', 'aces', 'filmic', 'reinhard', 'hable', 'uchimura', 'hdr', 'linear', 'highlight rolloff', 'color management'],
  inputs: img,
  params: {
    operator: { type: 'enum', default: 'AgX', options: [...TONEMAPS], label: 'Operator' },
    exposure: { type: 'float', default: 0.7, min: -6, max: 6, step: 0.01, label: 'Exposure (EV)', description: 'Stops of gain applied in linear light before the curve.' },
    look: { type: 'enum', default: 'Base', options: ['Base', 'Punchy', 'Golden'], label: 'AgX look' },
    contrast: { type: 'float', default: 1, min: 0, max: 2, step: 0.01, label: 'Filmic contrast', description: 'Filmic only: 0 low, 1 medium (Blender default-ish), 2 very high.' },
    white: { type: 'float', default: 4, min: 1, max: 32, step: 0.1, label: 'White point', description: 'Reinhard / Hable: linear value that maps to white.' },
    hdr: { type: 'bool', default: false, label: 'Input is HDR (linear)', description: 'Treat the input as scene-linear float data (no sRGB decode).' },
    amount: { type: 'float', default: 1, min: 0, max: 1, step: 0.01, label: 'Amount' },
  },
  passes: [{
    frag: /* glsl */ `
${GLSL_TONEMAP}
void main() {
  vec4 c = texture(u_image, v_uv);
  vec3 lin = (u_hdr ? max(c.rgb, 0.0) : srgbToLinear(max(c.rgb, 0.0))) * exp2(u_exposure);
  vec3 o = tonemapOp(lin, u_operator, u_look, u_contrast, u_white);
  vec3 base = u_hdr ? linearToSrgb(min(c.rgb, 1.0)) : c.rgb;
  fragColor = vec4(mix(base, o, u_amount), c.a);
}`,
  }],
});

const colorSpace = defineNode({
  id: 'pro.colorSpace',
  name: 'Colour Space Convert',
  category: 'Color Management',
  color: C,
  colorOnly: true,
  description:
    'Converts RGB values between sRGB, linear Rec.709, Display P3, Rec.2020, ProPhoto RGB, Adobe RGB (1998) and ACEScg using matrices derived from each space\'s primaries and white point ' +
    '(Bradford adaptation for D50 ProPhoto and the ACES white) and the proper transfer curves (sRGB, γ 563/256, ROMM 1.8 with linear toe, BT.1886 2.4, linear). ' +
    'Use it to interpret a file tagged in another space ("from" = its space, "to" = sRGB) or to prepare an export for a wide-gamut space. Out-of-gamut colours can be clipped or compressed.',
  tags: ['color space', 'gamut', 'display p3', 'rec2020', 'prophoto', 'adobe rgb', 'acescg', 'aces', 'icc', 'bradford', 'convert', 'wide gamut', 'color management'],
  inputs: img,
  params: {
    from: { type: 'enum', default: 'Display P3', options: SPACE_LABELS, label: 'From' },
    to: { type: 'enum', default: 'sRGB', options: SPACE_LABELS, label: 'To' },
    gamut: { type: 'enum', default: 'compress', options: ['clip', 'compress', 'none'], label: 'Out of gamut', description: 'clip = clamp channels; compress = desaturate towards the luminance until in gamut (keeps hue); none = keep negative / > 1 values (float pipeline).' },
  },
  passes: [{
    uniforms: (ctx: PassContext) => {
      const a = spaceByLabel(ctx.params.from ?? 'Display P3'), b = spaceByLabel(ctx.params.to ?? 'sRGB');
      return { u_M: toGlsl(convertMatrix(a, b)), u_dec: TRANSFER_IDS.indexOf(a.transfer), u_enc: TRANSFER_IDS.indexOf(b.transfer), u_Y: rgbY(b) };
    },
    frag: /* glsl */ `
${GLSL_TRANSFER}
uniform mat3 u_M;
uniform int u_dec;
uniform int u_enc;
uniform vec3 u_Y;
void main() {
  vec4 c = texture(u_image, v_uv);
  vec3 lin = u_M * trDecode(c.rgb, u_dec);
  if (u_gamut == 1) {
    // compress: move towards the (target-space) luminance just enough to bring every channel into 0..1
    float Y = clamp(dot(lin, u_Y), 0.0, 1.0);
    vec3 d = lin - Y;
    float t = 1.0;
    for (int i = 0; i < 3; i++) {
      if (lin[i] < 0.0) t = min(t, Y / max(Y - lin[i], 1e-6));
      if (lin[i] > 1.0) t = min(t, (1.0 - Y) / max(lin[i] - Y, 1e-6));
    }
    lin = Y + d * t;
  }
  if (u_gamut <= 1) lin = clamp(lin, 0.0, 1.0);
  fragColor = vec4(trEncode(lin, u_enc), c.a);
}`,
  }],
});

/** Luminance (XYZ Y row) of a space, for gamut compression. */
function rgbY(s: ReturnType<typeof spaceByLabel>): number[] {
  const M = convertMatrix(s, spaceByLabel('linsrgb'));
  // Y of the target space's RGB via sRGB's Y row
  const ys = [0.2126729, 0.7151522, 0.072175];
  return [0, 1, 2].map((c) => ys[0] * M[c] + ys[1] * M[3 + c] + ys[2] * M[6 + c]);
}

const exposureLinear = defineNode({
  id: 'pro.exposureLinear',
  name: 'Exposure & White Balance (linear)',
  category: 'Color Management',
  color: C,
  colorOnly: true,
  description:
    'Camera-style exposure and white balance in scene-linear light: exposure in stops, then a Bradford chromatic adaptation from the scene illuminant (Planckian temperature in K + tint) to daylight — ' +
    'set Temperature to the light the photo was taken under (lower = cooler result, like Lightroom). A soft highlight shoulder rolls bright values off instead of clipping (hue-preserving). ' +
    'With "Linear (HDR) in/out" it works on float data and leaves the result linear, for chaining before Tone Map.',
  tags: ['exposure', 'white balance', 'temperature', 'kelvin', 'tint', 'linear', 'stops', 'highlight', 'rolloff', 'bradford', 'raw'],
  inputs: img,
  params: {
    exposure: { type: 'float', default: 0.5, min: -6, max: 6, step: 0.01, label: 'Exposure (EV)' },
    temperature: { type: 'float', default: 6500, min: 2000, max: 15000, step: 10, label: 'Temperature (K)', description: 'Scene illuminant. 6500 = neutral; lower values cool the image (compensate warm light).' },
    tint: { type: 'float', default: 0, min: -1, max: 1, step: 0.005, label: 'Tint', description: '+ magenta, − green.' },
    rolloff: { type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, label: 'Highlight rolloff', description: '0 = hard clip, 1 = long soft shoulder.' },
    blacks: { type: 'float', default: 0, min: -0.05, max: 0.05, step: 0.0005, label: 'Black level', description: 'Linear offset subtracted (+) or added (−) before exposure.' },
    hdr: { type: 'bool', default: false, label: 'Linear (HDR) in/out' },
  },
  passes: [{
    uniforms: (ctx: PassContext) => ({ u_WB: toGlsl(whiteBalanceMatrix(num(ctx.params, 'temperature', 6500), num(ctx.params, 'tint', 0))) }),
    frag: /* glsl */ `
uniform mat3 u_WB;
void main() {
  vec4 c = texture(u_image, v_uv);
  vec3 lin = u_hdr ? c.rgb : srgbToLinear(max(c.rgb, 0.0));
  lin = (lin - u_blacks) / max(1.0 - u_blacks, 1e-3);
  lin = max(u_WB * lin, 0.0) * exp2(u_exposure);
  if (!u_hdr && u_rolloff > 0.0) {
    // hue-preserving shoulder on the max channel: linear below the knee, exponential approach to 1 above
    float knee = 1.0 - 0.6 * u_rolloff;
    float m = max(lin.r, max(lin.g, lin.b));
    if (m > knee) {
      float w = 1.0 - knee;
      float mo = knee + w * (1.0 - exp(-(m - knee) / w));
      vec3 sc = lin * (mo / m);
      // very bright values also desaturate towards white like film / sensor highlights
      float bleach = clamp((m - knee) / (4.0 * w + 1.0), 0.0, 1.0) * u_rolloff;
      lin = mix(sc, vec3(mo), bleach * bleach);
    }
  }
  fragColor = vec4(u_hdr ? lin : linearToSrgb(clamp(lin, 0.0, 1.0)), c.a);
}`,
  }],
});

export default [tonemap, colorSpace, exposureLinear] satisfies NodeDef[];
