import { defineNode } from '../../core/registry';
import type { NodeDef, RawTex } from '../../core/types';
import { cubeToAtlas, parseCube, sampleCurve } from './shared';

const C = '#f5a524';
const img = { image: { type: 'image' as const } };
const amountParam = { type: 'float' as const, default: 1, min: 0, max: 1, step: 0.01, label: 'Amount' };

export default [
  defineNode({
    id: 'color.levels',
    name: 'Levels',
    category: 'Color',
    description: 'Input black/white points, gamma (>1 brightens midtones) and output range, per pixel on all RGB channels.',
    tags: ['contrast', 'gamma', 'black point', 'white point', 'tone'],
    color: C,
    inputs: img,
    params: {
      inBlack: { type: 'float', default: 0, min: 0, max: 1, step: 0.005, label: 'Input black' },
      inWhite: { type: 'float', default: 1, min: 0, max: 1, step: 0.005, label: 'Input white' },
      gamma: { type: 'float', default: 1, min: 0.1, max: 5, step: 0.01, label: 'Gamma' },
      outBlack: { type: 'float', default: 0, min: 0, max: 1, step: 0.005, label: 'Output black' },
      outWhite: { type: 'float', default: 1, min: 0, max: 1, step: 0.005, label: 'Output white' },
    },
    passes: [{
      frag: /* glsl */ `
void main(){
  vec4 c = texture(u_image, v_uv);
  vec3 x = clamp((c.rgb - u_inBlack) / max(u_inWhite - u_inBlack, 1e-4), 0.0, 1.0);
  x = pow(x, vec3(1.0 / max(u_gamma, 1e-3)));
  fragColor = vec4(mix(vec3(u_outBlack), vec3(u_outWhite), x), c.a);
}` }],
  }),

  defineNode({
    id: 'color.curves',
    name: 'Curves',
    category: 'Color',
    description: 'Tone curves (monotone cubic through the points). Per-channel R/G/B curves are applied first, then the master curve on the result.',
    tags: ['tone', 'contrast', 'rgb curves', 's-curve', 'grade'],
    color: C,
    inputs: img,
    params: {
      master: { type: 'curve', default: [[0, 0], [1, 1]], label: 'Master' },
      red: { type: 'curve', default: [[0, 0], [1, 1]], label: 'Red' },
      green: { type: 'curve', default: [[0, 0], [1, 1]], label: 'Green' },
      blue: { type: 'curve', default: [[0, 0], [1, 1]], label: 'Blue' },
    },
    cpu: ({ params }) => {
      const m = sampleCurve(params.master), r = sampleCurve(params.red), g = sampleCurve(params.green), b = sampleCurve(params.blue);
      const data = new Float32Array(256 * 4);
      for (let i = 0; i < 256; i++) {
        data[i * 4] = r[i]; data[i * 4 + 1] = g[i]; data[i * 4 + 2] = b[i]; data[i * 4 + 3] = m[i];
      }
      const tex: RawTex = { width: 256, height: 1, data, filter: 'linear' };
      return { curve: tex };
    },
    passes: [{
      frag: /* glsl */ `
vec4 lut(float x) { return texture(u_curve, vec2((clamp(x, 0.0, 1.0) * 255.0 + 0.5) / 256.0, 0.5)); }
void main(){
  vec4 c = texture(u_image, v_uv);
  vec3 o = vec3(lut(c.r).r, lut(c.g).g, lut(c.b).b);
  o = vec3(lut(o.r).a, lut(o.g).a, lut(o.b).a);
  fragColor = vec4(o, c.a);
}` }],
  }),

  defineNode({
    id: 'color.hsl',
    name: 'Hue / Saturation',
    category: 'Color',
    description: 'Hue rotation, saturation (−1 = greyscale), lightness (towards black/white) and vibrance (boosts muted colours more than saturated ones).',
    tags: ['hue', 'saturation', 'lightness', 'vibrance', 'desaturate', 'greyscale'],
    color: C,
    inputs: img,
    params: {
      hue: { type: 'float', default: 0, min: -180, max: 180, step: 1, label: 'Hue (°)' },
      saturation: { type: 'float', default: 0, min: -1, max: 1, step: 0.01, label: 'Saturation' },
      lightness: { type: 'float', default: 0, min: -1, max: 1, step: 0.01, label: 'Lightness' },
      vibrance: { type: 'float', default: 0, min: -1, max: 1, step: 0.01, label: 'Vibrance' },
    },
    passes: [{
      frag: /* glsl */ `
void main(){
  vec4 c = texture(u_image, v_uv);
  vec3 rgb = c.rgb;
  if (u_hue != 0.0) {
    vec3 hsv = rgb2hsv(max(rgb, 0.0));
    hsv.x = fract(hsv.x + u_hue / 360.0);
    rgb = hsv2rgb(hsv);
  }
  float l = luma(rgb);
  // vibrance: weighted by how unsaturated the pixel is
  float mx = max(max(rgb.r, rgb.g), rgb.b), mn = min(min(rgb.r, rgb.g), rgb.b);
  float sat = (mx - mn) / max(mx, 1e-4);
  float vib = 1.0 + u_vibrance * (1.0 - sat);
  rgb = mix(vec3(l), rgb, max(vib, 0.0));
  rgb = mix(vec3(luma(rgb)), rgb, 1.0 + u_saturation);
  rgb = u_lightness >= 0.0 ? mix(rgb, vec3(1.0), u_lightness) : rgb * (1.0 + u_lightness);
  fragColor = vec4(rgb, c.a);
}` }],
  }),

  defineNode({
    id: 'color.whiteBalance',
    name: 'White Balance',
    category: 'Color',
    description: 'Temperature (+ warmer / − cooler) and tint (+ magenta / − green), applied as channel gains in linear light with luminance kept constant.',
    tags: ['temperature', 'tint', 'warm', 'cool', 'wb', 'kelvin'],
    color: C,
    inputs: img,
    params: {
      temperature: { type: 'float', default: 0, min: -1, max: 1, step: 0.01, label: 'Temperature' },
      tint: { type: 'float', default: 0, min: -1, max: 1, step: 0.01, label: 'Tint' },
    },
    passes: [{
      frag: /* glsl */ `
void main(){
  vec4 c = texture(u_image, v_uv);
  vec3 lin = srgbToLinear(max(c.rgb, 0.0));
  vec3 g = vec3(1.0 + 0.35 * u_temperature, 1.0, 1.0 - 0.35 * u_temperature);
  g *= vec3(1.0 + 0.15 * u_tint, 1.0 - 0.3 * u_tint, 1.0 + 0.15 * u_tint);
  g = max(g, 0.0);
  g /= max(luma(g), 1e-4);
  fragColor = vec4(linearToSrgb(lin * g), c.a);
}` }],
  }),

  defineNode({
    id: 'color.exposure',
    name: 'Exposure / Contrast',
    category: 'Color',
    description: 'Exposure in stops (linear light), contrast around mid-grey, brightness offset and black point.',
    tags: ['exposure', 'contrast', 'brightness', 'stops', 'black point'],
    color: C,
    inputs: img,
    params: {
      exposure: { type: 'float', default: 0, min: -5, max: 5, step: 0.01, label: 'Exposure (stops)' },
      contrast: { type: 'float', default: 0, min: -1, max: 1, step: 0.01, label: 'Contrast' },
      brightness: { type: 'float', default: 0, min: -1, max: 1, step: 0.01, label: 'Brightness' },
      blackPoint: { type: 'float', default: 0, min: -0.5, max: 0.5, step: 0.005, label: 'Black point', description: '+ crushes shadows, − lifts (fades) them.' },
    },
    passes: [{
      frag: /* glsl */ `
void main(){
  vec4 c = texture(u_image, v_uv);
  vec3 lin = srgbToLinear(max(c.rgb, 0.0)) * exp2(u_exposure);
  vec3 s = linearToSrgb(lin);
  float k = u_contrast >= 0.0 ? 1.0 / (1.0 - 0.9 * u_contrast) : 1.0 + u_contrast;
  s = (s - 0.5) * k + 0.5;
  s += u_brightness;
  s = (s - u_blackPoint) / max(1.0 - u_blackPoint, 1e-3);
  fragColor = vec4(s, c.a);
}` }],
  }),

  defineNode({
    id: 'color.colorBalance',
    name: 'Color Balance',
    category: 'Color',
    description: 'Lift / gamma / gain colour grading. Each colour is neutral at 50% grey; push it towards a hue to tint shadows, midtones or highlights.',
    tags: ['grade', 'lift gamma gain', 'split toning', 'shadows', 'highlights', 'tint'],
    color: C,
    inputs: img,
    params: {
      shadows: { type: 'color', default: [0.5, 0.5, 0.5, 1], label: 'Shadows (lift)' },
      midtones: { type: 'color', default: [0.5, 0.5, 0.5, 1], label: 'Midtones (gamma)' },
      highlights: { type: 'color', default: [0.5, 0.5, 0.5, 1], label: 'Highlights (gain)' },
      preserveLuma: { type: 'bool', default: true, label: 'Preserve luminosity' },
    },
    passes: [{
      frag: /* glsl */ `
void main(){
  vec4 c = texture(u_image, v_uv);
  vec3 lift = (u_shadows.rgb - 0.5) * 0.5;
  vec3 gain = 1.0 + (u_highlights.rgb - 0.5);
  vec3 gexp = exp2(-(u_midtones.rgb - 0.5) * 2.0);
  vec3 x = clamp(c.rgb, 0.0, 1.0);
  vec3 o = gain * (x + lift * (1.0 - x));
  o = pow(max(o, 0.0), gexp);
  o += c.rgb - x; // keep out-of-range headroom
  if (u_preserveLuma) o += luma(c.rgb) - luma(o);
  fragColor = vec4(o, c.a);
}` }],
  }),

  defineNode({
    id: 'color.channelMixer',
    name: 'Channel Mixer',
    category: 'Color',
    description: 'out.r = rr·r + rg·g + rb·b (same for g, b). Monochrome outputs the red row as grey (Photoshop-style).',
    tags: ['mix', 'swap channels', 'monochrome', 'black and white', 'infrared'],
    color: C,
    inputs: img,
    params: {
      rr: { type: 'float', default: 1, min: -2, max: 2, step: 0.01, label: 'Red ← R' },
      rg: { type: 'float', default: 0, min: -2, max: 2, step: 0.01, label: 'Red ← G' },
      rb: { type: 'float', default: 0, min: -2, max: 2, step: 0.01, label: 'Red ← B' },
      gr: { type: 'float', default: 0, min: -2, max: 2, step: 0.01, label: 'Green ← R' },
      gg: { type: 'float', default: 1, min: -2, max: 2, step: 0.01, label: 'Green ← G' },
      gb: { type: 'float', default: 0, min: -2, max: 2, step: 0.01, label: 'Green ← B' },
      br: { type: 'float', default: 0, min: -2, max: 2, step: 0.01, label: 'Blue ← R' },
      bg: { type: 'float', default: 0, min: -2, max: 2, step: 0.01, label: 'Blue ← G' },
      bb: { type: 'float', default: 1, min: -2, max: 2, step: 0.01, label: 'Blue ← B' },
      monochrome: { type: 'bool', default: false, label: 'Monochrome' },
    },
    passes: [{
      frag: /* glsl */ `
void main(){
  vec4 c = texture(u_image, v_uv);
  vec3 o = vec3(dot(c.rgb, vec3(u_rr, u_rg, u_rb)), dot(c.rgb, vec3(u_gr, u_gg, u_gb)), dot(c.rgb, vec3(u_br, u_bg, u_bb)));
  if (u_monochrome) o = vec3(o.r);
  fragColor = vec4(o, c.a);
}` }],
  }),

  defineNode({
    id: 'color.gradientMap',
    name: 'Gradient Map',
    category: 'Color',
    description: 'Maps luminance onto a gradient of 2–5 evenly spaced colour stops (dark → light).',
    tags: ['duotone', 'tritone', 'colorize', 'false colour', 'thermal'],
    color: C,
    inputs: img,
    params: {
      stops: { type: 'int', default: 3, min: 2, max: 5, step: 1, label: 'Stops' },
      color0: { type: 'color', default: [0, 0, 0, 1], label: 'Stop 1 (shadows)' },
      color1: { type: 'color', default: [0.5, 0.5, 0.5, 1], label: 'Stop 2' },
      color2: { type: 'color', default: [1, 1, 1, 1], label: 'Stop 3' },
      color3: { type: 'color', default: [1, 1, 1, 1], label: 'Stop 4' },
      color4: { type: 'color', default: [1, 1, 1, 1], label: 'Stop 5' },
      amount: amountParam,
    },
    passes: [{
      frag: /* glsl */ `
vec3 stopColor(int i) {
  if (i <= 0) return u_color0.rgb;
  if (i == 1) return u_color1.rgb;
  if (i == 2) return u_color2.rgb;
  if (i == 3) return u_color3.rgb;
  return u_color4.rgb;
}
void main(){
  vec4 c = texture(u_image, v_uv);
  int n = clamp(u_stops, 2, 5);
  float t = clamp(luma(c.rgb), 0.0, 1.0) * float(n - 1);
  int i = min(int(floor(t)), n - 2);
  vec3 g = mix(stopColor(i), stopColor(i + 1), t - float(i));
  fragColor = vec4(mix(c.rgb, g, u_amount), c.a);
}` }],
  }),

  defineNode({
    id: 'color.lut',
    name: 'LUT (.cube)',
    category: 'Color',
    description: 'Applies an Adobe/Resolve .cube 3D LUT (1D LUTs are supported too) with trilinear interpolation. Passes the image through when no LUT is loaded.',
    tags: ['lut', 'cube', '3d lut', 'film emulation', 'grade', 'look'],
    color: C,
    inputs: img,
    params: {
      lut: { type: 'asset', default: '', accept: '.cube', label: 'LUT file' },
      amount: amountParam,
    },
    cpu: ({ params, getAsset }) => {
      const a = getAsset(String(params.lut ?? ''));
      if (!a) {
        return {
          lut: { width: 1, height: 1, data: new Float32Array([0, 0, 0, 1]) },
          lutDomain: { width: 2, height: 1, data: new Float32Array([0, 0, 0, 1, 1, 1, 1, 1]), filter: 'nearest' },
        };
      }
      const text = a.text ?? (a.dataUrl ? decodeDataUrl(a.dataUrl) : '');
      const lut = parseCube(text);
      return {
        lut: cubeToAtlas(lut),
        lutDomain: { width: 2, height: 1, data: new Float32Array([...lut.domainMin, 1, ...lut.domainMax, 1]), filter: 'nearest' },
      };
    },
    passes: [{
      frag: /* glsl */ `
vec3 sampleLut(vec3 c) {
  float N = u_lut_size.y;
  vec3 dmin = texelFetch(u_lutDomain, ivec2(0, 0), 0).rgb;
  vec3 dmax = texelFetch(u_lutDomain, ivec2(1, 0), 0).rgb;
  vec3 x = clamp((c - dmin) / max(dmax - dmin, vec3(1e-6)), 0.0, 1.0) * (N - 1.0);
  float b0 = floor(x.b);
  float b1 = min(b0 + 1.0, N - 1.0);
  float fb = x.b - b0;
  // within a slice: r → x (+0.5 texel centre), g → y
  vec2 inSlice = vec2(x.r + 0.5, x.g + 0.5);
  vec2 W = vec2(N * N, N);
  vec3 s0 = texture(u_lut, (inSlice + vec2(b0 * N, 0.0)) / W).rgb;
  vec3 s1 = texture(u_lut, (inSlice + vec2(b1 * N, 0.0)) / W).rgb;
  return mix(s0, s1, fb);
}
void main(){
  vec4 c = texture(u_image, v_uv);
  if (u_lut_size.x < 2.0) { fragColor = c; return; }
  fragColor = vec4(mix(c.rgb, sampleLut(c.rgb), u_amount), c.a);
}` }],
  }),

  defineNode({
    id: 'color.invert',
    name: 'Invert',
    category: 'Color',
    description: 'Negative image (1 − rgb), blended by amount.',
    tags: ['negative', 'inverse'],
    color: C,
    inputs: img,
    params: { amount: amountParam },
    passes: [{
      frag: /* glsl */ `
void main(){
  vec4 c = texture(u_image, v_uv);
  fragColor = vec4(mix(c.rgb, 1.0 - c.rgb, u_amount), c.a);
}` }],
  }),

  defineNode({
    id: 'color.channelSplit',
    name: 'Split Channels',
    category: 'Color',
    description: 'Splits an image into R, G, B and A masks.',
    tags: ['separate', 'rgba', 'channels', 'extract'],
    color: C,
    inputs: img,
    outputs: { r: { type: 'mask' }, g: { type: 'mask' }, b: { type: 'mask' }, a: { type: 'mask' } },
    params: {},
    passes: (['r', 'g', 'b', 'a'] as const).map((ch) => ({
      output: ch,
      frag: `void main(){ float v = texture(u_image, v_uv).${ch}; fragColor = vec4(v, v, v, 1.0); }`,
    })),
  }),

  defineNode({
    id: 'color.channelMerge',
    name: 'Merge Channels',
    category: 'Color',
    description: 'Builds an image from R, G, B and A masks. Unconnected R/G/B are black, unconnected A is opaque.',
    tags: ['combine', 'rgba', 'channels', 'join'],
    color: C,
    inputs: {
      r: { type: 'mask', optional: true, fallback: 'black' },
      g: { type: 'mask', optional: true, fallback: 'black' },
      b: { type: 'mask', optional: true, fallback: 'black' },
      a: { type: 'mask', optional: true, fallback: 'white' },
    },
    params: {},
    passes: [{
      frag: /* glsl */ `
void main(){
  fragColor = vec4(texture(u_r, v_uv).r, texture(u_g, v_uv).r, texture(u_b, v_uv).r, texture(u_a, v_uv).r);
}` }],
  }),

  defineNode({
    id: 'color.convert',
    name: 'Color Space Convert',
    category: 'Color',
    description: 'Converts between RGB and YIQ / YUV / HSV, or sRGB ↔ linear. Encoded values are written raw (YIQ/YUV chroma may be negative; HSV hue in R, 0..1).',
    tags: ['yiq', 'yuv', 'hsv', 'linear', 'srgb', 'gamma', 'colour space'],
    color: C,
    inputs: img,
    params: {
      mode: { type: 'enum', default: 'rgb2yiq', options: ['rgb2yiq', 'yiq2rgb', 'rgb2yuv', 'yuv2rgb', 'rgb2hsv', 'hsv2rgb', 'srgb2linear', 'linear2srgb'], label: 'Mode' },
    },
    passes: [{
      frag: /* glsl */ `
void main(){
  vec4 c = texture(u_image, v_uv);
  vec3 o = c.rgb;
  if (u_mode == 0) o = rgb2yiq(o);
  else if (u_mode == 1) o = yiq2rgb(o);
  else if (u_mode == 2) o = rgb2yuv(o);
  else if (u_mode == 3) o = yuv2rgb(o);
  else if (u_mode == 4) o = rgb2hsv(max(o, 0.0));
  else if (u_mode == 5) o = hsv2rgb(o);
  else if (u_mode == 6) o = srgbToLinear(max(o, 0.0));
  else o = linearToSrgb(o);
  fragColor = vec4(o, c.a);
}` }],
  }),

  defineNode({
    id: 'color.threshold',
    name: 'Threshold',
    category: 'Color',
    description: 'Black/white by luminance with an optional soft edge.',
    tags: ['binary', 'black and white', '1-bit', 'mask'],
    color: C,
    inputs: img,
    params: {
      level: { type: 'float', default: 0.5, min: 0, max: 1, step: 0.005, label: 'Level' },
      softness: { type: 'float', default: 0, min: 0, max: 0.5, step: 0.005, label: 'Softness' },
    },
    passes: [{
      frag: /* glsl */ `
void main(){
  vec4 c = texture(u_image, v_uv);
  float l = luma(c.rgb);
  float v = u_softness > 0.0 ? smoothstep(u_level - u_softness, u_level + u_softness, l) : step(u_level, l);
  fragColor = vec4(vec3(v), c.a);
}` }],
  }),
] satisfies NodeDef[];

function decodeDataUrl(url: string): string {
  const i = url.indexOf(',');
  if (i < 0) return '';
  const meta = url.slice(0, i), body = url.slice(i + 1);
  if (/;base64/i.test(meta)) {
    const bin = atob(body);
    const bytes = new Uint8Array(bin.length);
    for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
    return new TextDecoder().decode(bytes);
  }
  return decodeURIComponent(body);
}

