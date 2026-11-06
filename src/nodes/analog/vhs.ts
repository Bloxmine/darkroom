import { defineNode } from '../../core/registry';
import type { NodeDef } from '../../core/types';
import { F } from './_shared';
import { rasterText } from './font5x7';

const C = '#ff8f5a';
const img = { image: { type: 'image' as const } };

/**
 * All VHS nodes measure resolution in "samples across the picture width" / "lines over the
 * height" rather than pixels: tape bandwidth is a property of the signal, not of the photo,
 * so the look is identical at any image size and render scale.
 */

const vhsChroma = defineNode({
  id: 'analog.vhsChroma',
  name: 'VHS Signal',
  category: 'Analog',
  color: C,
  description:
    'Composite/VHS signal path in YIQ: luma bandwidth limit with edge-enhancement ringing, very low chroma bandwidth that smears colour to the right, ' +
    'chroma delay, vertical line averaging and saturation.',
  tags: ['vhs', 'tape', 'video', 'chroma', 'bleed', 'ntsc', 'camcorder', 'yiq'],
  inputs: img,
  params: {
    lumaRes: { type: 'float', default: 330, min: 40, max: 1200, step: 1, label: 'Luma resolution', description: 'Horizontal luma samples across the width (VHS ≈ 240–330, S-VHS ≈ 400+).' },
    chromaRes: { type: 'float', default: 40, min: 5, max: 400, step: 1, label: 'Chroma resolution', description: 'Horizontal chroma resolution (VHS ≈ 30–40).' },
    lines: { type: 'float', default: 480, min: 100, max: 1200, step: 1, label: 'Lines', description: 'Vertical lines (NTSC 480, PAL 576).' },
    sharpen: { type: 'float', default: 0.7, min: 0, max: 3, step: 0.01, label: 'Edge enhance / ringing' },
    chromaShift: { type: 'float', default: 0.5, min: -3, max: 3, step: 0.01, label: 'Chroma delay (% width)' },
    chromaBleed: { type: 'float', default: 1, min: 0, max: 3, step: 0.01, label: 'Chroma bleed', description: 'Length of the rightward colour smear.' },
    saturation: { type: 'float', default: 1.25, min: 0, max: 3, step: 0.01, label: 'Saturation' },
  },
  passes: [
    { frag: F(`void main(){ vec4 s = texture(u_image, v_uv); fragColor = vec4(rgb2yiq(s.rgb), s.a); }`) },
    { frag: F(`
float Yat(float dx) { return texture(u_prev, v_uv + vec2(dx / u_resolution.x, 0.0)).x; }
void main() {
  float W = u_resolution.x;
  float ls = 0.5 * W / u_lumaRes;            // luma sigma (px)
  float y = 0.0, yw = 0.0, ws = 0.0, wws = 0.0;
  for (int i = -12; i <= 12; i++) {
    float t = float(i) / 4.0;                 // in sigmas
    float w = exp(-0.5 * t * t);
    y += Yat(t * ls) * w; ws += w;
  }
  y /= ws;
  for (int i = -12; i <= 12; i++) {           // wider, slightly lagging blur -> asymmetric halo/ringing
    float t = float(i) / 4.0;
    float w = exp(-0.5 * t * t);
    yw += Yat(t * ls * 2.6 - ls * 0.8) * w; wws += w;
  }
  yw /= wws;
  y = y + u_sharpen * (y - yw);
  // chroma: low-pass with a long rightward tail (colour bleeds to the right), delayed
  float cs = 0.5 * W / u_chromaRes;
  float shift = u_chromaShift * 0.01 * W;
  vec2 iq = vec2(0.0); float cws = 0.0;
  for (int i = -8; i <= 24; i++) {
    float t = float(i) / 6.0;                 // in chroma sigmas, positive = from the left
    float w = t >= 0.0 ? exp(-t / max(0.15, 0.7 * u_chromaBleed + 0.3)) : exp(-0.5 * t * t * 9.0);
    iq += texture(u_prev, v_uv + vec2((-t * cs - shift) / W, 0.0)).yz * w; cws += w;
  }
  iq /= cws;
  fragColor = vec4(y, iq, texture(u_prev, v_uv).a);
}`) },
    { frag: F(`
void main() {
  float H = u_resolution.y;
  float lp = H / u_lines;
  float ys = 0.45 * lp, cs = 1.1 * lp;
  float y = 0.0, yws = 0.0; vec2 iq = vec2(0.0); float cws = 0.0;
  for (int i = -8; i <= 8; i++) {
    float t = float(i) / 4.0;
    vec3 s = texture(u_prev, v_uv + vec2(0.0, t * cs / H)).xyz;
    float wc = exp(-0.5 * t * t);
    iq += s.yz * wc; cws += wc;
    float ty = t * cs / ys;
    float wy = exp(-0.5 * ty * ty);
    y += s.x * wy; yws += wy;
  }
  y /= yws; iq /= cws;
  vec3 rgb = yiq2rgb(vec3(y, iq * u_saturation));
  fragColor = vec4(clamp(rgb, 0.0, 1.0), texture(u_prev, v_uv).a);
}`) },
  ],
});

const vhsTracking = defineNode({
  id: 'analog.vhsTracking',
  name: 'VHS Tracking',
  category: 'Analog',
  color: C,
  description:
    'Tape transport errors: per-line horizontal jitter and wobble, a rolling tracking-noise band (move it with Band position), ' +
    'head-switching skew in the bottom lines and sparse white dropout streaks.',
  tags: ['vhs', 'tape', 'jitter', 'tracking', 'glitch', 'head switching', 'dropout'],
  inputs: img,
  params: {
    jitter: { type: 'float', default: 0.4, min: 0, max: 3, step: 0.01, label: 'Line jitter' },
    wobble: { type: 'float', default: 0.4, min: 0, max: 3, step: 0.01, label: 'Wobble' },
    tracking: { type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Tracking noise' },
    bandPosition: { type: 'float', default: 0.82, min: -0.2, max: 1.2, step: 0.005, label: 'Band position' },
    bandHeight: { type: 'float', default: 0.06, min: 0.005, max: 0.5, step: 0.005, label: 'Band height' },
    headSwitch: { type: 'float', default: 0.7, min: 0, max: 2, step: 0.01, label: 'Head switching' },
    headSwitchHeight: { type: 'float', default: 0.022, min: 0, max: 0.15, step: 0.001, label: 'Head switch height' },
    dropouts: { type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, label: 'Dropouts' },
    lines: { type: 'float', default: 480, min: 100, max: 1200, step: 1, label: 'Lines' },
    seed: { type: 'int', default: 7, min: 0, max: 9999, step: 1, label: 'Seed' },
  },
  passes: [{
    frag: F(`
void main() {
  float L = u_lines;
  float line = floor(v_uv.y * L);
  float sd = float(u_seed) * 13.17;
  float dx = (valueNoise(vec2(line * 0.035, sd)) - 0.5) * 2.0 * u_wobble * 0.004
           + gaussRand(vec2(line, sd)) * u_jitter * 0.0009;
  // tracking band
  float bd = (v_uv.y - u_bandPosition) / u_bandHeight;
  float band = exp(-bd * bd * 3.0) * u_tracking;
  float lr = hash12(vec2(line, sd + 3.1));
  dx += band * (lr * lr - 0.15) * 0.05;
  // head switching
  float hs = max(u_headSwitchHeight, 1e-4);
  float hy = (v_uv.y - (1.0 - hs)) / hs;
  float inHS = step(0.0, hy) * u_headSwitch;
  if (hy > 0.0) dx += u_headSwitch * (pow(hy, 1.4) * 0.05 + (hash12(vec2(line, sd + 5.0)) - 0.3) * 0.012);
  vec2 suv = vec2(v_uv.x - dx, v_uv.y);
  vec3 c = texture(u_image, suv).rgb;
  float outside = (suv.x < 0.0 || suv.x > 1.0) ? 1.0 : 0.0;
  c = mix(c, vec3(0.03), outside);
  // band: brighter, desaturated, streaked
  c = mix(c, vec3(luma(c)), band * 0.6) + band * 0.05;
  float segN = 6.0 + 30.0 * hash12(vec2(line, sd + 9.0));
  float sx = v_uv.x * segN + hash12(vec2(line, sd + 11.0)) * 10.0;
  float h = hash12(vec2(floor(sx), line + sd));
  float on = step(1.0 - band * 0.55, h);
  float ramp = smoothstep(0.0, 0.25, fract(sx)) * (1.0 - smoothstep(0.55, 1.0, fract(sx)));
  float snow = hash12(vec2(floor(v_uv.x * 900.0), line + sd * 2.0));
  c = mix(c, vec3(0.85 + 0.15 * snow), on * ramp * (0.6 + 0.4 * snow));
  // head switching noise line + darker skewed lines
  if (hy > 0.0) {
    float edge = exp(-pow((hy - 0.08) * 12.0, 2.0));
    float n = hash12(vec2(floor(v_uv.x * 500.0), line + sd));
    c = mix(c, vec3(n), edge * 0.7 * min(inHS, 1.0));
    c = mix(c, vec3(luma(c)), 0.4 * min(inHS, 1.0));
  }
  // dropouts: short white streaks with a decaying tail
  float dr = hash12(vec2(line * 1.37, sd + 21.0));
  if (dr < u_dropouts * 0.025) {
    float x0 = hash12(vec2(line, sd + 23.0));
    float len = 0.015 + 0.09 * hash12(vec2(line, sd + 29.0));
    float t = (v_uv.x - x0) / len;
    float d = (t > 0.0 && t < 1.0) ? (1.0 - t) * smoothstep(0.0, 0.05, t) : 0.0;
    c = mix(c, vec3(0.95), d);
  }
  fragColor = vec4(c, texture(u_image, v_uv).a);
}`),
  }],
});

const vhsNoise = defineNode({
  id: 'analog.vhsNoise',
  name: 'VHS Noise',
  category: 'Analog',
  color: C,
  description: 'Tape noise: horizontally streaky luma snow and low-resolution chroma noise blotches (the coloured “confetti” of worn tapes).',
  tags: ['vhs', 'snow', 'noise', 'tape', 'video'],
  inputs: img,
  params: {
    luma: { type: 'float', default: 0.35, min: 0, max: 2, step: 0.01, label: 'Luma noise' },
    chroma: { type: 'float', default: 0.45, min: 0, max: 2, step: 0.01, label: 'Chroma noise' },
    snow: { type: 'float', default: 0.2, min: 0, max: 1, step: 0.01, label: 'Snow specks' },
    lumaRes: { type: 'float', default: 330, min: 40, max: 1200, step: 1, label: 'Luma resolution' },
    chromaRes: { type: 'float', default: 50, min: 5, max: 400, step: 1, label: 'Chroma resolution' },
    lines: { type: 'float', default: 480, min: 100, max: 1200, step: 1, label: 'Lines' },
    seed: { type: 'int', default: 11, min: 0, max: 9999, step: 1, label: 'Seed' },
  },
  passes: [{
    frag: F(`
void main() {
  vec4 s = texture(u_image, v_uv);
  vec3 yiq = rgb2yiq(s.rgb);
  float line = floor(v_uv.y * u_lines);
  float sd = float(u_seed) * 7.31;
  float dark = 1.0 - 0.5 * smoothstep(0.2, 0.9, yiq.x);
  float n = gnoiseX(v_uv.x * u_lumaRes, line + sd) * 0.7 + gnoiseX(v_uv.x * u_lumaRes * 2.0, line + sd + 500.0) * 0.3;
  yiq.x += n * u_luma * 0.05 * dark;
  float ni = gnoiseX(v_uv.x * u_chromaRes, line * 0.5 + sd + 1000.0);
  float nq = gnoiseX(v_uv.x * u_chromaRes, line * 0.5 + sd + 2000.0);
  // chroma noise is blotchy: slowly modulated in strength along the picture
  float blot = 0.4 + 1.2 * valueNoise(vec2(v_uv.x * 6.0, line * 0.02) + sd);
  yiq.yz += vec2(ni, nq) * u_chroma * 0.035 * blot * dark;
  // snow: rare bright/dark streak specks
  float sx = v_uv.x * u_lumaRes * 0.25;
  float h = hash12(vec2(floor(sx), line + sd * 3.0));
  float sp = step(1.0 - u_snow * 0.012, h) * (1.0 - abs(fract(sx) * 2.0 - 1.0));
  yiq.x = mix(yiq.x, 0.9, sp * 0.8);
  fragColor = vec4(yiq2rgb(yiq), s.a);
}`),
  }],
});

const osd = defineNode({
  id: 'analog.osd',
  name: 'VCR OSD',
  category: 'Analog',
  color: C,
  description: 'On-screen display text in a blocky 5×7 character-generator font (like a VCR / camcorder), placed in the four corners of the TV safe area.',
  tags: ['vhs', 'text', 'overlay', 'play', 'rec', 'timestamp', 'camcorder', 'vcr'],
  inputs: img,
  params: {
    topLeft: { type: 'string', default: 'PLAY ▶', label: 'Top left', multiline: true },
    topRight: { type: 'string', default: '', label: 'Top right', multiline: true },
    bottomLeft: { type: 'string', default: 'AM 10:42\nNOV. 06 1998', label: 'Bottom left', multiline: true },
    bottomRight: { type: 'string', default: '', label: 'Bottom right', multiline: true },
    size: { type: 'float', default: 0.05, min: 0.01, max: 0.2, step: 0.001, label: 'Text size', description: 'Character height as a fraction of the shorter image side.' },
    margin: { type: 'vec2', default: [0.07, 0.08], min: 0, max: 0.4, step: 0.005, label: 'Safe-area margin' },
    color: { type: 'color', default: [0.96, 0.96, 0.96, 1], label: 'Colour' },
    shadow: { type: 'float', default: 0.85, min: 0, max: 1, step: 0.01, label: 'Shadow' },
    opacity: { type: 'float', default: 1, min: 0, max: 1, step: 0.01, label: 'Opacity' },
  },
  cpu: ({ params }) => ({
    tl: rasterText(String(params.topLeft ?? '')),
    tr: rasterText(String(params.topRight ?? '')),
    bl: rasterText(String(params.bottomLeft ?? '')),
    br: rasterText(String(params.bottomRight ?? '')),
  }),
  passes: [{
    frag: F(`
// one font pixel, in uv-y (char cell = 9 px, glyph = 7); sized relative to the shorter image side
float px() { return u_size / 9.0 * 1.25 * min(u_resolution.x, u_resolution.y) / u_resolution.y; }
float ink(sampler2D t, vec2 sz, vec2 origin, vec2 uv) {
  float aspect = u_resolution.x / u_resolution.y;
  vec2 p = (uv - origin) / vec2(px() / aspect, px());
  if (p.x < 0.0 || p.y < 0.0 || p.x >= sz.x || p.y >= sz.y) return 0.0;
  return texelFetch(t, ivec2(p), 0).a;
}
vec2 orig(vec2 sz, int corner) {
  float aspect = u_resolution.x / u_resolution.y;
  vec2 ext = sz * vec2(px() / aspect, px());
  vec2 o = u_margin;
  if (corner == 1 || corner == 3) o.x = 1.0 - u_margin.x - ext.x;
  if (corner >= 2) o.y = 1.0 - u_margin.y - ext.y;
  return o;
}
float all_(vec2 uv) {
  float a = ink(u_tl, u_tl_size, orig(u_tl_size, 0), uv);
  a = max(a, ink(u_tr, u_tr_size, orig(u_tr_size, 1), uv));
  a = max(a, ink(u_bl, u_bl_size, orig(u_bl_size, 2), uv));
  a = max(a, ink(u_br, u_br_size, orig(u_br_size, 3), uv));
  return a;
}
void main() {
  vec4 s = texture(u_image, v_uv);
  float aspect = u_resolution.x / u_resolution.y;
  vec2 o = vec2(px() / aspect, px()) * 0.8;
  float a = all_(v_uv);
  float sh = max(all_(v_uv - o), all_(v_uv - vec2(o.x, 0.0)));
  vec3 c = mix(s.rgb, s.rgb * 0.15, sh * u_shadow * u_opacity);
  c = mix(c, u_color.rgb, a * u_opacity);
  fragColor = vec4(c, s.a);
}`),
  }],
});

export default [vhsChroma, vhsTracking, vhsNoise, osd] satisfies NodeDef[];
