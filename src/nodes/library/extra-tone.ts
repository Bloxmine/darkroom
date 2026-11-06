/**
 * Tone & colour nodes: auto levels, histogram equalisation, clarity, dehaze,
 * highlights/shadows, vibrance, split toning, HSL-panel selective colour,
 * Kelvin white balance, colorize, duotone, black & white mixer, match colour,
 * false colour and gamut (clipping) warning.
 */
import { defineNode } from '../../core/registry';
import type { NodeDef, Params, PassContext, RawTex } from '../../core/types';
import { num } from './shared';
import {
  GLSL_BLUR_UV, GLSL_LAB, GLSL_OKLAB, blurPasses, blurUniforms, colorStats, computeHistograms, equalizeLut, histPercentile,
} from './extra-shared';

const C = '#f5a524';
const img = { image: { type: 'image' as const } };
const amountP = { type: 'float' as const, default: 1, min: 0, max: 1, step: 0.01, label: 'Amount' };

/** σ (render px) for a `radius`-style param (σ = radius / 2, like filter.gaussianBlur). */
const sig = (key: string, def: number) => (ctx: PassContext) => Math.max(0, num(ctx.params, key, def)) * ctx.scale * 0.5;
const lumaSrc = `vec4 ex_src(ivec2 p) { return vec4(luma(max(texelFetch(u_image, p, 0).rgb, 0.0))); }`;

/** Black/white points (and optional gamma) for color.autoLevels. Exported for tests. */
export function autoLevelsPoints(h: ReturnType<typeof computeHistograms>, p: Params) {
  const cb = Math.max(0, num(p, 'clipBlack', 0.1)) / 100, cw = Math.max(0, num(p, 'clipWhite', 0.1)) / 100;
  const perChannel = String(p.mode ?? 'per channel') === 'per channel';
  const chans = perChannel ? [h.r, h.g, h.b] : [h.l, h.l, h.l];
  const black = chans.map((c) => histPercentile(c, cb));
  const white = chans.map((c, i) => Math.max(histPercentile(c, cw, true), black[i] + 0.02));
  let gamma = 1;
  if (p.autoGamma) {
    const lb = histPercentile(h.l, cb), lw = Math.max(histPercentile(h.l, cw, true), lb + 0.02);
    const med = (histPercentile(h.l, 0.5) - lb) / (lw - lb);
    if (med > 0.02 && med < 0.98) gamma = Math.min(2.5, Math.max(0.4, Math.log(0.5) / Math.log(med)));
  }
  return { black, white, gamma };
}

/** Atmospheric light estimate (linear RGB) for dehaze: mean colour of the haziest 0.2% (highest dark channel). */
export function atmosphericLight(raw: RawTex | null): [number, number, number] {
  if (!raw) return [1, 1, 1];
  const { width: w, height: h, data } = raw;
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((Math.max(c, 0) + 0.055) / 1.055, 2.4));
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 250000)));
  const bins = 1024, hist = new Float64Array(bins);
  const darkOf = (o: number) => Math.min(1, Math.max(0, Math.min(data[o], data[o + 1], data[o + 2])));
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) hist[Math.min(bins - 1, Math.floor(darkOf((y * w + x) * 4) * bins))]++;
  const thr = histPercentile(hist, 0.002, true) - 1 / bins;
  const s = [0, 0, 0];
  let n = 0;
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
    const o = (y * w + x) * 4;
    if (darkOf(o) < thr) continue;
    s[0] += lin(data[o]); s[1] += lin(data[o + 1]); s[2] += lin(data[o + 2]); n++;
  }
  if (!n) return [1, 1, 1];
  return [Math.max(s[0] / n, 0.05), Math.max(s[1] / n, 0.05), Math.max(s[2] / n, 0.05)];
}

const RANGES = ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas'] as const;
const RANGE_LABEL = ['Reds', 'Yellows', 'Greens', 'Cyans', 'Blues', 'Magentas'];
const selectiveParams: Record<string, { type: 'float'; default: number; min: number; max: number; step: number; label: string }> = {};
RANGES.forEach((r, i) => {
  const d = r === 'blues' ? { sat: 0.15, lum: -0.35 } : { sat: 0, lum: 0 };
  selectiveParams[`${r}Hue`] = { type: 'float', default: 0, min: -1, max: 1, step: 0.01, label: `${RANGE_LABEL[i]} hue` };
  selectiveParams[`${r}Sat`] = { type: 'float', default: d.sat, min: -1, max: 1, step: 0.01, label: `${RANGE_LABEL[i]} saturation` };
  selectiveParams[`${r}Lum`] = { type: 'float', default: d.lum, min: -1, max: 1, step: 0.01, label: `${RANGE_LABEL[i]} luminance` };
});

const BW_DEFAULTS = { reds: 0.4, yellows: 0.6, greens: 0.4, cyans: 0.6, blues: 0.2, magentas: 0.8 };

/** Turbo colormap (Google, polynomial approximation). */
const GLSL_TURBO = /* glsl */ `
vec3 ex_turbo(float x) {
  x = clamp(x, 0.0, 1.0);
  vec4 v4 = vec4(1.0, x, x * x, x * x * x);
  vec2 v2 = v4.zw * v4.z;
  return vec3(
    dot(v4, vec4(0.13572138, 4.61539260, -42.66032258, 132.13108234)) + dot(v2, vec2(-152.94239396, 59.28637943)),
    dot(v4, vec4(0.09140261, 2.19418839, 4.84296658, -14.18503333)) + dot(v2, vec2(4.27729857, 2.82956604)),
    dot(v4, vec4(0.10667330, 12.64194608, -60.58204836, 110.36276771)) + dot(v2, vec2(-89.90310912, 27.34824973)));
}
`;

export default [
  defineNode({
    id: 'color.autoLevels',
    name: 'Auto Levels',
    category: 'Color',
    description: 'Measures the histogram and stretches it to full range, clipping the given % of pixels at each end. "per channel" also neutralises colour casts (Photoshop Auto Color-style); "luma" keeps the colour balance. Optional auto gamma puts the median at mid-grey.',
    tags: ['auto contrast', 'auto tone', 'stretch', 'normalize', 'histogram', 'auto color'],
    color: C,
    inputs: img,
    cpuReadsInputs: true,
    params: {
      mode: { type: 'enum', default: 'per channel', options: ['per channel', 'luma'], label: 'Mode' },
      clipBlack: { type: 'float', default: 0.1, min: 0, max: 10, step: 0.01, label: 'Clip shadows (%)' },
      clipWhite: { type: 'float', default: 0.1, min: 0, max: 10, step: 0.01, label: 'Clip highlights (%)' },
      autoGamma: { type: 'bool', default: false, label: 'Auto gamma (median → 50%)' },
      amount: amountP,
    },
    cpu: ({ params, readInput }) => {
      const raw = readInput('image');
      const data = new Float32Array(12);
      if (!raw) { data.set([0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1]); return { levels: { width: 3, height: 1, data, filter: 'nearest' } }; }
      const { black, white, gamma } = autoLevelsPoints(computeHistograms(raw.data, raw.width, raw.height), params);
      data.set([black[0], black[1], black[2], 1, white[0], white[1], white[2], 1, gamma, gamma, gamma, 1]);
      return { levels: { width: 3, height: 1, data, filter: 'nearest' } };
    },
    passes: [{
      frag: /* glsl */ `
void main(){
  vec4 c = texture(u_image, v_uv);
  vec3 b = texelFetch(u_levels, ivec2(0, 0), 0).rgb;
  vec3 w = texelFetch(u_levels, ivec2(1, 0), 0).rgb;
  float g = texelFetch(u_levels, ivec2(2, 0), 0).r;
  vec3 x = (c.rgb - b) / max(w - b, vec3(1e-3));
  x = sign(x) * pow(abs(x), vec3(g));
  fragColor = vec4(mix(c.rgb, x, u_amount), c.a);
}`,
    }],
  }),

  defineNode({
    id: 'color.histogramEqualize',
    name: 'Histogram Equalize',
    category: 'Color',
    description: 'Global histogram equalisation: maps tones through the image\'s own cumulative histogram (baked on the CPU into a curve) so all levels are used equally. "luma" keeps colours; "per channel" also stretches each channel.',
    tags: ['equalize', 'histogram', 'cdf', 'contrast', 'normalize', 'tone mapping'],
    color: C,
    inputs: img,
    cpuReadsInputs: true,
    params: {
      mode: { type: 'enum', default: 'luma', options: ['luma', 'per channel'], label: 'Mode' },
      amount: { ...amountP, default: 0.7 },
    },
    cpu: ({ readInput }) => {
      const raw = readInput('image');
      const n = 256;
      const data = new Float32Array(n * 4);
      if (!raw) { for (let i = 0; i < n; i++) data.fill(i / (n - 1), i * 4, i * 4 + 4); return { lut: { width: n, height: 1, data, filter: 'linear' } }; }
      const h = computeHistograms(raw.data, raw.width, raw.height, n);
      const r = equalizeLut(h.r), g = equalizeLut(h.g), b = equalizeLut(h.b), l = equalizeLut(h.l);
      for (let i = 0; i < n; i++) { data[i * 4] = r[i]; data[i * 4 + 1] = g[i]; data[i * 4 + 2] = b[i]; data[i * 4 + 3] = l[i]; }
      return { lut: { width: n, height: 1, data, filter: 'linear' } };
    },
    passes: [{
      frag: /* glsl */ `
vec4 lut(float x) { return texture(u_lut, vec2((clamp(x, 0.0, 1.0) * 255.0 + 0.5) / 256.0, 0.5)); }
void main(){
  vec4 c = texture(u_image, v_uv);
  vec3 o;
  if (u_mode == 0) { float l = luma(c.rgb); o = c.rgb + (lut(l).a - l); }
  else o = vec3(lut(c.r).r, lut(c.g).g, lut(c.b).b);
  fragColor = vec4(mix(c.rgb, o, u_amount), c.a);
}`,
    }],
  }),

  defineNode({
    id: 'color.clarity',
    name: 'Clarity',
    category: 'Color',
    description: 'Local (midtone) contrast: a large-radius unsharp mask on luminance, weighted towards midtones so highlights and shadows don\'t clip. Negative values soften (glow / skin).',
    tags: ['local contrast', 'texture', 'punch', 'structure', 'detail', 'unsharp'],
    color: C,
    inputs: img,
    params: {
      amount: { type: 'float', default: 0.5, min: -1, max: 2, step: 0.01, label: 'Amount' },
      radius: { type: 'float', default: 60, min: 2, max: 400, step: 1, pixels: true, label: 'Radius' },
      midtones: { type: 'float', default: 0.7, min: 0, max: 1, step: 0.01, label: 'Midtone focus', description: 'How strongly the effect is limited to midtones.' },
    },
    passes: [
      ...blurPasses(0, sig('radius', 60), lumaSrc),
      {
        uniforms: (ctx) => blurUniforms(sig('radius', 60)(ctx)),
        frag: /* glsl */ `
uniform float u_bd;
${GLSL_BLUR_UV}
void main(){
  vec4 c = texture(u_image, v_uv);
  float L = luma(max(c.rgb, 0.0));
  float B = texture(u_pass2, ex_blurUV(v_uv, u_bd, u_pass2_size)).r;
  float d = L - B;
  d = d / (1.0 + 2.0 * abs(d)); // soft-limit to tame halos at hard edges
  float w = mix(1.0, clamp(4.0 * L * (1.0 - L), 0.0, 1.0), u_midtones);
  fragColor = vec4(max(c.rgb + u_amount * 1.5 * d * w, 0.0), c.a);
}` },
    ],
  }),

  defineNode({
    id: 'color.dehaze',
    name: 'Dehaze',
    category: 'Color',
    description: 'Dark-channel-prior haze removal (He et al., simplified): the atmospheric light is measured from the haziest pixels, transmission comes from a min-filtered dark channel smoothed by a gaussian. Negative amount adds haze. Linear light.',
    tags: ['haze', 'fog', 'mist', 'atmosphere', 'contrast', 'dark channel'],
    color: C,
    inputs: img,
    cpuReadsInputs: true,
    params: {
      amount: { type: 'float', default: 0.6, min: -1, max: 1, step: 0.01, label: 'Amount' },
      patch: { type: 'float', default: 15, min: 1, max: 60, step: 1, pixels: true, label: 'Patch radius' },
      minTransmission: { type: 'float', default: 0.15, min: 0.02, max: 0.8, step: 0.01, label: 'Min transmission' },
    },
    cpu: ({ readInput }) => {
      const A = atmosphericLight(readInput('image'));
      return { air: { width: 1, height: 1, data: new Float32Array([A[0], A[1], A[2], 1]), filter: 'nearest' } };
    },
    passes: [
      { frag: `void main(){ vec3 A = texelFetch(u_air, ivec2(0), 0).rgb; vec3 l = srgbToLinear(max(texture(u_image, v_uv).rgb, 0.0)) / A; fragColor = vec4(min(min(l.r, l.g), l.b)); }` },
      {
        uniforms: (ctx) => ({ u_R: Math.max(0, Math.round(num(ctx.params, 'patch', 15) * ctx.scale)) }),
        frag: `uniform float u_R; void main(){ int R = int(u_R); ivec2 p = ivec2(floor(v_uv * u_resolution)); float m = 1e9; for (int i = -64; i <= 64; i++) { if (abs(i) > R) continue; m = min(m, texel(u_pass0, p + ivec2(i, 0)).r); } fragColor = vec4(m); }`,
      },
      {
        uniforms: (ctx) => ({ u_R: Math.max(0, Math.round(num(ctx.params, 'patch', 15) * ctx.scale)) }),
        frag: `uniform float u_R; void main(){ int R = int(u_R); ivec2 p = ivec2(floor(v_uv * u_resolution)); float m = 1e9; for (int i = -64; i <= 64; i++) { if (abs(i) > R) continue; m = min(m, texel(u_pass1, p + ivec2(0, i)).r); } fragColor = vec4(m); }`,
      },
      ...blurPasses(3, (ctx) => Math.max(1, num(ctx.params, 'patch', 15)) * ctx.scale, `vec4 ex_src(ivec2 p) { return texelFetch(u_pass2, p, 0); }`),
      {
        uniforms: (ctx) => blurUniforms(Math.max(1, num(ctx.params, 'patch', 15)) * ctx.scale),
        frag: /* glsl */ `
uniform float u_bd;
${GLSL_BLUR_UV}
void main(){
  vec4 c = texture(u_image, v_uv);
  vec3 A = texelFetch(u_air, ivec2(0), 0).rgb;
  vec3 I = srgbToLinear(max(c.rgb, 0.0));
  // dark channel of the coarse map vs. the pixel itself: take the smaller to limit halos
  float dc = texture(u_pass5, ex_blurUV(v_uv, u_bd, u_pass5_size)).r;
  vec3 ln = I / A;
  dc = min(dc, min(min(ln.r, ln.g), ln.b) + 0.05);
  vec3 J;
  if (u_amount >= 0.0) {
    float t = max(1.0 - 0.95 * u_amount * dc, u_minTransmission);
    J = (I - A) / t + A;
  } else {
    float t = 1.0 + 0.7 * u_amount * (1.0 - 0.5 * dc);
    J = I * t + A * (1.0 - t);
  }
  fragColor = vec4(linearToSrgb(max(J, 0.0)), c.a);
}` },
    ],
  }),

  defineNode({
    id: 'color.highlightsShadows',
    name: 'Highlights / Shadows',
    category: 'Color',
    description: 'Tone recovery: lifts shadows and pulls down highlights based on a blurred (local) luminance, so detail is kept. Gains are applied in linear light (stops), preserving hue. Larger radius = more natural, smaller = more HDR-ish.',
    tags: ['shadow recovery', 'highlight recovery', 'tone', 'hdr', 'lift shadows', 'fill light'],
    color: C,
    inputs: img,
    params: {
      shadows: { type: 'float', default: 0.5, min: -1, max: 1, step: 0.01, label: 'Shadows' },
      highlights: { type: 'float', default: -0.5, min: -1, max: 1, step: 0.01, label: 'Highlights' },
      radius: { type: 'float', default: 40, min: 0, max: 400, step: 1, pixels: true, label: 'Radius' },
      tonalWidth: { type: 'float', default: 0.5, min: 0.1, max: 1, step: 0.01, label: 'Tonal width' },
    },
    passes: [
      ...blurPasses(0, sig('radius', 40), lumaSrc),
      {
        uniforms: (ctx) => blurUniforms(sig('radius', 40)(ctx)),
        frag: /* glsl */ `
uniform float u_bd;
${GLSL_BLUR_UV}
void main(){
  vec4 c = texture(u_image, v_uv);
  float L = luma(max(c.rgb, 0.0));
  float B = texture(u_pass2, ex_blurUV(v_uv, u_bd, u_pass2_size)).r;
  float base = mix(B, L, 0.3);
  float tw = u_tonalWidth;
  float ws = 1.0 - smoothstep(0.0, tw, base);
  float wh = smoothstep(1.0 - tw, 1.0, base);
  float stops = 1.6 * (u_shadows * ws * ws + u_highlights * wh);
  vec3 lin = srgbToLinear(max(c.rgb, 0.0)) * exp2(stops);
  fragColor = vec4(linearToSrgb(lin), c.a);
}` },
    ],
  }),

  defineNode({
    id: 'color.vibranceSaturation',
    name: 'Vibrance / Saturation',
    category: 'Color',
    description: 'Perceptual (Oklab) chroma control. Vibrance boosts muted colours more than saturated ones and, with skin protection, spares orange skin tones; saturation scales all chroma equally. Lightness is untouched.',
    tags: ['vibrance', 'saturation', 'chroma', 'oklab', 'skin tones', 'colourful'],
    color: C,
    inputs: img,
    params: {
      vibrance: { type: 'float', default: 0.5, min: -1, max: 1, step: 0.01, label: 'Vibrance' },
      saturation: { type: 'float', default: 0, min: -1, max: 1, step: 0.01, label: 'Saturation' },
      protectSkin: { type: 'bool', default: true, label: 'Protect skin tones' },
    },
    passes: [{
      frag: /* glsl */ `
${GLSL_OKLAB}
void main(){
  vec4 c = texture(u_image, v_uv);
  vec3 lab = ex_srgb2oklab(c.rgb);
  float C = length(lab.yz);
  float hue = degrees(atan(lab.z, lab.y));
  float skin = u_protectSkin ? exp(-pow((hue - 60.0) / 22.0, 2.0)) : 0.0;
  float v = u_vibrance * (1.0 - smoothstep(0.0, 0.22, C)) * (1.0 - 0.75 * skin);
  float k = max(0.0, (1.0 + v) * (1.0 + u_saturation));
  lab.yz *= k;
  fragColor = vec4(ex_oklab2srgb(lab), c.a);
}`,
    }],
  }),

  defineNode({
    id: 'color.splitToning',
    name: 'Split Toning',
    category: 'Color',
    description: 'Tints highlights and shadows with separate hues (Lightroom split toning / colour grading). Tints are added in Oklab so lightness is preserved; balance moves the split point (+ favours highlights).',
    tags: ['split tone', 'teal and orange', 'grade', 'tint', 'color grading', 'cinematic'],
    color: C,
    inputs: img,
    params: {
      highlightHue: { type: 'float', default: 40, min: 0, max: 360, step: 1, label: 'Highlight hue (°)' },
      highlightSat: { type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, label: 'Highlight saturation' },
      shadowHue: { type: 'float', default: 200, min: 0, max: 360, step: 1, label: 'Shadow hue (°)' },
      shadowSat: { type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, label: 'Shadow saturation' },
      balance: { type: 'float', default: 0, min: -1, max: 1, step: 0.01, label: 'Balance' },
      amount: amountP,
    },
    passes: [{
      frag: /* glsl */ `
${GLSL_OKLAB}
void main(){
  vec4 c = texture(u_image, v_uv);
  vec3 lab = ex_srgb2oklab(c.rgb);
  float l = luma(clamp(c.rgb, 0.0, 1.0));
  float pivot = 0.5 - 0.4 * u_balance;
  float hw = smoothstep(pivot - 0.4, pivot + 0.4, l);
  float fade = smoothstep(0.0, 0.08, lab.x);
  vec2 t = ex_hueDir(u_highlightHue) * u_highlightSat * hw + ex_hueDir(u_shadowHue) * u_shadowSat * (1.0 - hw);
  lab.yz += 0.1 * t * fade * u_amount;
  fragColor = vec4(ex_oklab2srgb(lab), c.a);
}`,
    }],
  }),

  defineNode({
    id: 'color.selectiveColor',
    name: 'HSL / Selective Color',
    category: 'Color',
    description: 'Lightroom HSL panel: shift hue (±30°), saturation and luminance of six colour ranges (reds, yellows, greens, cyans, blues, magentas). Ranges blend smoothly (triangular, 60° wide); greys are left alone. Luminance is a linear-light gain so hue is kept. Default darkens blue skies.',
    tags: ['hsl', 'selective color', 'color range', 'sky', 'foliage', 'targeted', 'color mixer'],
    color: C,
    inputs: img,
    params: {
      ...selectiveParams,
      amount: amountP,
    },
    passes: [{
      uniforms: (ctx) => {
        const g = (s: string) => RANGES.map((r) => num(ctx.params, r + s, (selectiveParams[r + s].default)));
        return { u_hueA: g('Hue'), u_satA: g('Sat'), u_lumA: g('Lum') };
      },
      frag: /* glsl */ `
uniform float u_hueA[6];
uniform float u_satA[6];
uniform float u_lumA[6];
void main(){
  vec4 c = texture(u_image, v_uv);
  vec3 hsv = rgb2hsv(max(c.rgb, 0.0));
  float h = hsv.x * 360.0;
  float dh = 0.0, ds = 0.0, dl = 0.0;
  for (int i = 0; i < 6; i++) {
    float d = abs(h - float(i) * 60.0);
    d = min(d, 360.0 - d);
    float w = max(0.0, 1.0 - d / 60.0);
    dh += w * u_hueA[i]; ds += w * u_satA[i]; dl += w * u_lumA[i];
  }
  float sw = smoothstep(0.02, 0.2, hsv.y) * u_amount;
  hsv.x = fract(hsv.x + dh * sw * 30.0 / 360.0);
  float s = ds * sw;
  hsv.y = clamp(s >= 0.0 ? hsv.y + s * hsv.y * (1.0 - hsv.y) * 2.0 : hsv.y * (1.0 + s), 0.0, 1.0);
  vec3 rgb = hsv2rgb(hsv);
  vec3 lin = srgbToLinear(rgb) * exp2(1.2 * dl * sw);
  fragColor = vec4(linearToSrgb(lin), c.a);
}`,
    }],
  }),

  defineNode({
    id: 'color.temperatureKelvin',
    name: 'Color Temperature (K)',
    category: 'Color',
    description: 'White balance in Kelvin: re-lights the image from a source illuminant to a target one (von Kries-style channel gains in linear light, luminance kept). Target lower than source = warmer, higher = cooler. Tint: + magenta / − green.',
    tags: ['kelvin', 'white balance', 'temperature', 'warm', 'cool', 'tungsten', 'daylight', 'cct'],
    color: C,
    inputs: img,
    params: {
      source: { type: 'float', default: 6500, min: 1500, max: 15000, step: 50, label: 'Source light (K)' },
      target: { type: 'float', default: 4800, min: 1500, max: 15000, step: 50, label: 'Target light (K)' },
      tint: { type: 'float', default: 0, min: -1, max: 1, step: 0.01, label: 'Tint' },
      amount: amountP,
    },
    passes: [{
      frag: /* glsl */ `
void main(){
  vec4 c = texture(u_image, v_uv);
  vec3 s = srgbToLinear(kelvinToRgb(u_source)), t = srgbToLinear(kelvinToRgb(u_target));
  vec3 g = t / max(s, vec3(1e-4));
  g *= vec3(1.0 + 0.15 * u_tint, 1.0 - 0.3 * u_tint, 1.0 + 0.15 * u_tint);
  g /= max(luma(g), 1e-4);
  g = mix(vec3(1.0), g, u_amount);
  fragColor = vec4(linearToSrgb(srgbToLinear(max(c.rgb, 0.0)) * g), c.a);
}`,
    }],
  }),

  defineNode({
    id: 'color.colorize',
    name: 'Colorize',
    category: 'Color',
    description: 'Photoshop-style colorize: replaces hue and saturation, keeping each pixel\'s luminance (as HSL lightness). Good for sepia/cyanotype monochromes.',
    tags: ['colorize', 'sepia', 'tint', 'monochrome', 'cyanotype', 'tone'],
    color: C,
    inputs: img,
    params: {
      hue: { type: 'float', default: 30, min: 0, max: 360, step: 1, label: 'Hue (°)' },
      saturation: { type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, label: 'Saturation' },
      lightness: { type: 'float', default: 0, min: -1, max: 1, step: 0.01, label: 'Lightness' },
      amount: amountP,
    },
    passes: [{
      frag: /* glsl */ `
void main(){
  vec4 c = texture(u_image, v_uv);
  float l = clamp(luma(c.rgb), 0.0, 1.0);
  l = u_lightness >= 0.0 ? mix(l, 1.0, u_lightness) : l * (1.0 + u_lightness);
  vec3 o = hsl2rgb(vec3(u_hue / 360.0, u_saturation, l));
  fragColor = vec4(mix(c.rgb, o, u_amount), c.a);
}`,
    }],
  }),

  defineNode({
    id: 'color.duotone',
    name: 'Duotone',
    category: 'Color',
    description: 'Maps luminance onto a two-colour ramp (shadow colour → highlight colour), mixed in linear light. Contrast steepens the ramp.',
    tags: ['duotone', 'two tone', 'poster', 'spotify', 'gradient map', 'monochrome'],
    color: C,
    inputs: img,
    params: {
      shadow: { type: 'color', default: [0.1, 0.12, 0.38, 1], label: 'Shadow colour' },
      highlight: { type: 'color', default: [1, 0.78, 0.45, 1], label: 'Highlight colour' },
      contrast: { type: 'float', default: 0, min: -1, max: 1, step: 0.01, label: 'Contrast' },
      amount: amountP,
    },
    passes: [{
      frag: /* glsl */ `
void main(){
  vec4 c = texture(u_image, v_uv);
  float t = clamp(luma(c.rgb), 0.0, 1.0);
  float k = u_contrast >= 0.0 ? 1.0 / (1.0 - 0.9 * u_contrast) : 1.0 + u_contrast;
  t = clamp((t - 0.5) * k + 0.5, 0.0, 1.0);
  vec3 o = linearToSrgb(mix(srgbToLinear(u_shadow.rgb), srgbToLinear(u_highlight.rgb), srgbToLinear(vec3(t)).r));
  fragColor = vec4(mix(c.rgb, o, u_amount), c.a);
}`,
    }],
  }),

  defineNode({
    id: 'color.blackWhite',
    name: 'Black & White',
    category: 'Color',
    description: 'Photoshop Black & White mixer: grey = min + (max − mid)·primary weight + (mid − min)·secondary weight, with weights for reds, yellows, greens, cyans, blues and magentas (defaults 40/60/40/60/20/80%). Optional tint keeps luminance.',
    tags: ['black and white', 'monochrome', 'greyscale', 'bw', 'channel mixer', 'filter', 'tint'],
    color: C,
    inputs: img,
    params: {
      reds: { type: 'float', default: BW_DEFAULTS.reds, min: -2, max: 3, step: 0.01, label: 'Reds' },
      yellows: { type: 'float', default: BW_DEFAULTS.yellows, min: -2, max: 3, step: 0.01, label: 'Yellows' },
      greens: { type: 'float', default: BW_DEFAULTS.greens, min: -2, max: 3, step: 0.01, label: 'Greens' },
      cyans: { type: 'float', default: BW_DEFAULTS.cyans, min: -2, max: 3, step: 0.01, label: 'Cyans' },
      blues: { type: 'float', default: BW_DEFAULTS.blues, min: -2, max: 3, step: 0.01, label: 'Blues' },
      magentas: { type: 'float', default: BW_DEFAULTS.magentas, min: -2, max: 3, step: 0.01, label: 'Magentas' },
      tint: { type: 'bool', default: false, label: 'Tint' },
      tintHue: { type: 'float', default: 35, min: 0, max: 360, step: 1, label: 'Tint hue (°)' },
      tintSat: { type: 'float', default: 0.25, min: 0, max: 1, step: 0.01, label: 'Tint saturation' },
    },
    passes: [{
      frag: /* glsl */ `
${GLSL_OKLAB}
void main(){
  vec4 c = texture(u_image, v_uv);
  vec3 x = clamp(c.rgb, 0.0, 1.0);
  float mn = min(min(x.r, x.g), x.b), mx = max(max(x.r, x.g), x.b), mid = x.r + x.g + x.b - mn - mx;
  float wp, ws;
  if (x.r >= x.g && x.r >= x.b) { wp = u_reds; ws = x.g >= x.b ? u_yellows : u_magentas; }
  else if (x.g >= x.b) { wp = u_greens; ws = x.r >= x.b ? u_yellows : u_cyans; }
  else { wp = u_blues; ws = x.r >= x.g ? u_magentas : u_cyans; }
  float g = max(mn + (mx - mid) * wp + (mid - mn) * ws, 0.0);
  vec3 o = vec3(g);
  if (u_tint) {
    vec3 lab = ex_srgb2oklab(o);
    lab.yz = ex_hueDir(u_tintHue) * u_tintSat * 0.12 * smoothstep(0.0, 0.1, lab.x);
    o = ex_oklab2srgb(lab);
  }
  fragColor = vec4(o, c.a);
}`,
    }],
  }),

  defineNode({
    id: 'color.matchColor',
    name: 'Match Color',
    category: 'Color',
    description: 'Transfers the colour mood of a reference image (Reinhard et al.): each channel\'s mean and standard deviation are matched in CIELAB or YCbCr. Statistics are measured on the CPU. Luminance controls how much brightness/contrast is matched too.',
    tags: ['color transfer', 'match', 'reference', 'grade', 'reinhard', 'look', 'mood'],
    color: C,
    inputs: {
      image: { type: 'image', label: 'Image' },
      reference: { type: 'image', label: 'Reference' },
    },
    cpuReadsInputs: true,
    params: {
      space: { type: 'enum', default: 'lab', options: ['lab', 'ycbcr'], label: 'Colour space' },
      amount: amountP,
      luminance: { type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Match luminance' },
    },
    cpu: ({ params, readInput }) => {
      const space = params.space === 'ycbcr' ? 'ycbcr' : 'lab';
      const a = readInput('image'), b = readInput('reference');
      const sa = a ? colorStats(a.data, a.width, a.height, space) : { mean: [0, 0, 0], std: [1, 1, 1] };
      const sb = b ? colorStats(b.data, b.width, b.height, space) : sa;
      const data = new Float32Array([...sa.mean, 1, ...sa.std, 1, ...sb.mean, 1, ...sb.std, 1]);
      return { stats: { width: 4, height: 1, data, filter: 'nearest' } };
    },
    passes: [{
      frag: /* glsl */ `
${GLSL_LAB}
void main(){
  vec4 c = texture(u_image, v_uv);
  vec3 ms = texelFetch(u_stats, ivec2(0, 0), 0).rgb, ss = texelFetch(u_stats, ivec2(1, 0), 0).rgb;
  vec3 mr = texelFetch(u_stats, ivec2(2, 0), 0).rgb, sr = texelFetch(u_stats, ivec2(3, 0), 0).rgb;
  vec3 v = u_space == 0 ? ex_rgb2lab(c.rgb) : rgb2ycbcr(c.rgb);
  vec3 k = clamp(sr / max(ss, vec3(1e-3)), 0.2, 5.0);
  vec3 m = (v - ms) * k + mr;
  vec3 amt = vec3(u_luminance, 1.0, 1.0) * u_amount;
  v = mix(v, m, amt);
  vec3 o = u_space == 0 ? ex_lab2rgb(v) : ycbcr2rgb(v);
  fragColor = vec4(max(o, 0.0), c.a);
}`,
    }],
  }),

  defineNode({
    id: 'color.falseColor',
    name: 'False Color',
    category: 'Color',
    description: 'Exposure-check display. "exposure bands": cinema-monitor style — purple/blue crushed blacks, green ≈ 18% grey (38–42 IRE), pink ≈ skin +1 stop (52–56), yellow near clip, red clipped, grey elsewhere. "heatmap": luma through the Turbo colormap. "zones": Ansel Adams zones 0–X. A legend strip can be drawn along the bottom.',
    tags: ['false color', 'exposure', 'ire', 'monitor', 'zones', 'heatmap', 'analysis', 'scope'],
    color: C,
    inputs: img,
    params: {
      mode: { type: 'enum', default: 'exposure bands', options: ['exposure bands', 'heatmap', 'zones'], label: 'Mode' },
      legend: { type: 'bool', default: true, label: 'Legend' },
    },
    passes: [{
      frag: /* glsl */ `
${GLSL_TURBO}
vec3 fc(float y) {
  float ire = y * 100.0;
  if (u_mode == 1) return ex_turbo(y);
  if (u_mode == 2) {
    float z = clamp(floor(y * 11.0), 0.0, 10.0);
    return ex_turbo((z + 0.5) / 11.0);
  }
  if (ire > 100.0) return vec3(1.0, 0.0, 0.0);
  if (ire >= 97.0) return vec3(1.0, 0.95, 0.0);
  if (ire >= 52.0 && ire <= 56.0) return vec3(1.0, 0.45, 0.75);
  if (ire >= 38.0 && ire <= 42.0) return vec3(0.1, 0.85, 0.2);
  if (ire < 2.5) return vec3(0.45, 0.0, 0.6);
  if (ire < 10.0) return vec3(0.0, 0.3, 1.0);
  return vec3(y * 0.85);
}
void main(){
  vec4 c = texture(u_image, v_uv);
  float y = luma(c.rgb);
  vec3 o = fc(y);
  if (u_legend) {
    float h = 0.045;
    if (v_uv.y > 1.0 - h) {
      float t = v_uv.x * 1.02 - 0.01;
      o = fc(t * (u_mode == 0 ? 1.02 : 1.0));
      // ticks every 10%
      float px = abs(fract(t * 10.0 + 0.5) - 0.5) * u_resolution.x / 10.0;
      if (px < 1.0 && v_uv.y > 1.0 - h * 0.45) o = vec3(0.0);
      if (v_uv.y < 1.0 - h + 1.5 / u_resolution.y) o = vec3(0.0);
    }
  }
  fragColor = vec4(o, c.a);
}`,
    }],
  }),

  defineNode({
    id: 'color.gamutWarning',
    name: 'Clipping Warning',
    category: 'Color',
    description: 'Zebra / clipping overlay: marks highlights at or above `high` and shadows at or below `low` (any channel, all channels, or luma). Values outside 0..1 (float headroom, out-of-gamut) are flagged in magenta.',
    tags: ['zebra', 'clipping', 'gamut', 'overexposure', 'blown highlights', 'crushed blacks', 'warning'],
    color: C,
    inputs: img,
    params: {
      high: { type: 'float', default: 0.98, min: 0.5, max: 1, step: 0.001, label: 'Highlight threshold' },
      low: { type: 'float', default: 0.02, min: 0, max: 0.5, step: 0.001, label: 'Shadow threshold' },
      test: { type: 'enum', default: 'any channel', options: ['any channel', 'all channels', 'luma'], label: 'Test' },
      highColor: { type: 'color', default: [1, 0, 0, 1], label: 'Highlight colour' },
      lowColor: { type: 'color', default: [0, 0.4, 1, 1], label: 'Shadow colour' },
      outOfGamut: { type: 'bool', default: true, label: 'Flag out-of-range' },
      zebra: { type: 'bool', default: true, label: 'Zebra stripes' },
      stripe: { type: 'float', default: 8, min: 2, max: 64, step: 1, pixels: true, label: 'Stripe width' },
    },
    passes: [{
      frag: /* glsl */ `
void main(){
  vec4 c = texture(u_image, v_uv);
  float mx = max(max(c.r, c.g), c.b), mn = min(min(c.r, c.g), c.b), l = luma(c.rgb);
  float hv = u_test == 0 ? mx : (u_test == 1 ? mn : l);
  float lv = u_test == 0 ? mn : (u_test == 1 ? mx : l);
  vec2 p = pixelCoord() / max(u_scale, 1e-4);
  float z = u_zebra ? step(0.5, fract((p.x + p.y) / (2.0 * u_stripe))) : 1.0;
  vec3 o = c.rgb;
  if (hv >= u_high) o = mix(o, u_highColor.rgb, z);
  else if (lv <= u_low) o = mix(o, u_lowColor.rgb, z);
  if (u_outOfGamut && (mx > 1.001 || mn < -0.001)) o = mix(o, vec3(1.0, 0.0, 1.0), 1.0 - z * 0.5);
  fragColor = vec4(clamp(o, 0.0, 1.0), c.a);
}`,
    }],
  }),
] satisfies NodeDef[];
