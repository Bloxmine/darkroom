/**
 * Composite & utility nodes: layer stack, alpha from mask, (un)premultiply,
 * drop shadow, border/frame, info readout, split compare, channel viewer and
 * an RGB histogram overlay (CPU histogram drawn with canvas 2D).
 */
import { defineNode } from '../../core/registry';
import type { NodeDef, PassContext, RawTex } from '../../core/types';
import { num } from './shared';
import { BLEND_MODES } from './composite';
import { GLSL_BLUR_UV, blurPasses, blurUniforms, computeHistograms } from './extra-shared';

const C = '#e54d2e';
const U = '#8b8d98';
const img = { image: { type: 'image' as const } };
const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

/** W3C separable + non-separable blend modes, same order as composite.blend's BLEND_MODES. */
const GLSL_BLEND = /* glsl */ `
float bl_lum(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }
vec3 bl_clip(vec3 c) {
  float l = bl_lum(c), n = min(min(c.r, c.g), c.b), x = max(max(c.r, c.g), c.b);
  if (n < 0.0) c = l + (c - l) * l / max(l - n, 1e-5);
  if (x > 1.0) c = l + (c - l) * (1.0 - l) / max(x - l, 1e-5);
  return c;
}
vec3 bl_setLum(vec3 c, float l) { return bl_clip(c + (l - bl_lum(c))); }
float bl_sat(vec3 c) { return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b); }
vec3 bl_setSat(vec3 c, float s) {
  float mx = max(max(c.r, c.g), c.b), mn = min(min(c.r, c.g), c.b);
  return mx > mn ? (c - mn) * s / (mx - mn) : vec3(0.0);
}
vec3 blendFn(int mode, vec3 b, vec3 s) {
  switch (mode) {
    case 0: return s;
    case 1: return blendMultiply(b, s);
    case 2: return blendScreen(b, s);
    case 3: return blendOverlay(b, s);
    case 4: return blendSoftLight(b, s);
    case 5: return blendHardLight(b, s);
    case 6: return b + s;
    case 7: return b - s;
    case 8: return abs(b - s);
    case 9: return min(b, s);
    case 10: return max(b, s);
    case 11: return blendColorDodge(b, s);
    case 12: return blendColorBurn(b, s);
    case 13: return blendLinearLight(b, s);
    case 14: return bl_setLum(bl_setSat(s, bl_sat(b)), bl_lum(b));
    case 15: return bl_setLum(bl_setSat(b, bl_sat(s)), bl_lum(b));
    case 16: return bl_setLum(s, bl_lum(b));
    default: return bl_setLum(b, bl_lum(s));
  }
}
vec4 blendOver(vec4 B, vec4 S, int mode, float opacity) {
  float as = clamp(S.a * opacity, 0.0, 1.0), ab = clamp(B.a, 0.0, 1.0);
  vec3 mixed = mix(S.rgb, blendFn(mode, B.rgb, S.rgb), ab);
  float ao = as + ab * (1.0 - as);
  vec3 co = ao > 1e-5 ? (as * mixed + ab * (1.0 - as) * B.rgb) / ao : B.rgb;
  return vec4(co, ao);
}
`;

/** Place a CPU-drawn panel texture `u_<name>` in a corner; returns its colour (alpha 0 outside). */
const overlayGlsl = (name: string) => /* glsl */ `
vec4 ex_panel(int corner, float marginFrac) {
  vec2 px = v_uv * u_resolution;
  vec2 sz = u_${name}_size;
  float m = marginFrac * min(u_resolution.x, u_resolution.y);
  vec2 o = vec2(corner == 1 || corner == 3 ? u_resolution.x - sz.x - m : m, corner >= 2 ? u_resolution.y - sz.y - m : m);
  vec2 q = (px - o) / sz;
  if (any(lessThan(q, vec2(0.0))) || any(greaterThan(q, vec2(1.0)))) return vec4(0.0);
  return texture(u_${name}, q);
}
vec4 ex_over(vec4 B, vec4 S) {
  float ao = S.a + B.a * (1.0 - S.a);
  return vec4(ao > 1e-5 ? (S.rgb * S.a + B.rgb * B.a * (1.0 - S.a)) / ao : B.rgb, ao);
}
`;

const hex = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');

/** Text readout for util.info: size + mean colour. Exported for tests. */
export function infoText(raw: RawTex, scale: number, projectSize?: { width: number; height: number }) {
  const { width: w, height: h, data } = raw;
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 250000)));
  const s = [0, 0, 0, 0];
  let n = 0;
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
    const o = (y * w + x) * 4;
    for (let c = 0; c < 4; c++) s[c] += data[o + c];
    n++;
  }
  const m = s.map((v) => v / Math.max(n, 1));
  let fw = Math.round(w / scale), fh = Math.round(h / scale);
  // the preview size is rounded; snap to the project size when it is clearly the same image size
  if (projectSize && Math.abs(projectSize.width * scale - w) <= 1 && Math.abs(projectSize.height * scale - h) <= 1) { fw = projectSize.width; fh = projectSize.height; }
  const l = 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2];
  return {
    lines: [
      `${fw} × ${fh} px  (${((fw * fh) / 1e6).toFixed(2)} MP, ${(fw / fh).toFixed(3)}:1)`,
      `mean sRGB ${m[0].toFixed(3)} ${m[1].toFixed(3)} ${m[2].toFixed(3)}  #${hex(m[0])}${hex(m[1])}${hex(m[2])}`,
      `mean luma ${l.toFixed(3)}  alpha ${m[3].toFixed(3)}`,
    ],
    mean: m,
  };
}

/** Font size of overlay panels: proportional to the image's short side, so preview and export match. */
const panelFont = (raw: RawTex) => Math.max(5, Math.min(raw.width, raw.height) / 48);

export default [
  defineNode({
    id: 'composite.layerStack',
    name: 'Layer Stack',
    category: 'Composite',
    description: 'Up to four layers over a base, each with its own blend mode and opacity (bottom to top: layer 1 … layer 4). Unconnected layers are skipped. Saves chaining Blend nodes.',
    tags: ['layers', 'stack', 'blend', 'composite', 'photoshop layers', 'merge'],
    color: C,
    inputs: {
      base: { type: 'image', label: 'Base' },
      layer1: { type: 'image', optional: true, fallback: 'transparent', label: 'Layer 1' },
      layer2: { type: 'image', optional: true, fallback: 'transparent', label: 'Layer 2' },
      layer3: { type: 'image', optional: true, fallback: 'transparent', label: 'Layer 3' },
      layer4: { type: 'image', optional: true, fallback: 'transparent', label: 'Layer 4' },
    },
    params: Object.fromEntries([1, 2, 3, 4].flatMap((i) => [
      [`mode${i}`, { type: 'enum' as const, default: 'normal', options: BLEND_MODES, label: `Layer ${i} mode` }],
      [`opacity${i}`, { type: 'float' as const, default: 1, min: 0, max: 1, step: 0.01, label: `Layer ${i} opacity` }],
    ])),
    passes: [{
      frag: /* glsl */ `
${GLSL_BLEND}
void main(){
  vec4 c = texture(u_base, v_uv);
  c = blendOver(c, texture(u_layer1, v_uv), u_mode1, u_opacity1);
  c = blendOver(c, texture(u_layer2, v_uv), u_mode2, u_opacity2);
  c = blendOver(c, texture(u_layer3, v_uv), u_mode3, u_opacity3);
  c = blendOver(c, texture(u_layer4, v_uv), u_mode4, u_opacity4);
  fragColor = c;
}`,
    }],
  }),

  defineNode({
    id: 'composite.alphaFromMask',
    name: 'Alpha from Mask',
    category: 'Composite',
    description: 'Sets the image\'s alpha from a mask (replace), or multiplies the existing alpha by it — cut-outs for Alpha Over / Layer Stack.',
    tags: ['alpha', 'mask', 'cutout', 'transparency', 'matte', 'set alpha'],
    color: C,
    inputs: {
      image: { type: 'image', label: 'Image' },
      mask: { type: 'mask', label: 'Mask' },
    },
    params: {
      mode: { type: 'enum', default: 'replace', options: ['replace', 'multiply'], label: 'Mode' },
      invert: { type: 'bool', default: false, label: 'Invert mask' },
    },
    passes: [{
      frag: /* glsl */ `
void main(){
  vec4 c = texture(u_image, v_uv);
  float m = clamp(texture(u_mask, v_uv).r, 0.0, 1.0);
  if (u_invert) m = 1.0 - m;
  fragColor = vec4(c.rgb, u_mode == 0 ? m : c.a * m);
}`,
    }],
  }),

  defineNode({
    id: 'composite.premultiply',
    name: 'Premultiply',
    category: 'Composite',
    description: 'rgb × alpha (alpha unchanged). For exporting to tools that expect premultiplied colour, or before maths that should ignore transparent colour.',
    tags: ['premultiply', 'alpha', 'associated alpha'],
    color: C,
    inputs: img,
    params: {},
    passes: [{ frag: `void main(){ vec4 c = texture(u_image, v_uv); fragColor = vec4(c.rgb * c.a, c.a); }` }],
  }),

  defineNode({
    id: 'composite.unpremultiply',
    name: 'Unpremultiply',
    category: 'Composite',
    description: 'rgb ÷ alpha (fully transparent pixels become black). Converts premultiplied colour back to Darkroom\'s straight-alpha convention.',
    tags: ['unpremultiply', 'divide alpha', 'straight alpha'],
    color: C,
    inputs: img,
    params: {},
    passes: [{ frag: `void main(){ vec4 c = texture(u_image, v_uv); fragColor = vec4(c.a > 1e-5 ? c.rgb / c.a : vec3(0.0), c.a); }` }],
  }),

  defineNode({
    id: 'composite.dropShadow',
    name: 'Drop Shadow',
    category: 'Composite',
    description: 'Adds a soft shadow behind a layer with transparency (text, logos, cut-outs): the alpha is offset, spread, blurred and tinted, and the layer is placed over it. The result keeps transparency, so put it over a photo with Alpha Over.',
    tags: ['shadow', 'drop shadow', 'text', 'logo', 'depth', 'outer glow'],
    color: C,
    inputs: img,
    params: {
      angle: { type: 'float', default: 45, min: -180, max: 180, step: 1, label: 'Angle (°)', description: 'Direction the shadow falls: 0 = right, 90 = down.' },
      distance: { type: 'float', default: 12, min: 0, max: 500, step: 0.5, pixels: true, label: 'Distance' },
      blur: { type: 'float', default: 16, min: 0, max: 300, step: 0.5, pixels: true, label: 'Blur' },
      spread: { type: 'float', default: 0, min: 0, max: 0.95, step: 0.01, label: 'Spread' },
      color: { type: 'color', default: [0, 0, 0, 1], label: 'Colour' },
      opacity: { type: 'float', default: 0.75, min: 0, max: 1, step: 0.01, label: 'Opacity' },
      knockout: { type: 'bool', default: false, label: 'Shadow only' },
    },
    passes: [
      ...blurPasses(0, (ctx) => Math.max(0, num(ctx.params, 'blur', 16)) * ctx.scale * 0.5, /* glsl */ `
uniform vec2 u_off;
vec4 ex_src(ivec2 p) {
  ivec2 q = p - ivec2(round(u_off));
  ivec2 s = textureSize(u_image, 0);
  if (q.x < 0 || q.y < 0 || q.x >= s.x || q.y >= s.y) return vec4(0.0);
  return vec4(texelFetch(u_image, q, 0).a);
}`, (ctx) => {
        const a = (num(ctx.params, 'angle', 45) * Math.PI) / 180, d = num(ctx.params, 'distance', 12) * ctx.scale;
        return { u_off: [Math.cos(a) * d, Math.sin(a) * d] };
      }),
      {
        uniforms: (ctx: PassContext) => blurUniforms(Math.max(0, num(ctx.params, 'blur', 16)) * ctx.scale * 0.5),
        frag: /* glsl */ `
uniform float u_bd;
${GLSL_BLUR_UV}
void main(){
  vec4 c = texture(u_image, v_uv);
  float a = texture(u_pass2, ex_blurUV(v_uv, u_bd, u_pass2_size)).r;
  a = clamp(a / (1.0 - u_spread), 0.0, 1.0) * u_opacity * u_color.a;
  vec4 sh = vec4(u_color.rgb, a);
  if (u_knockout) { fragColor = vec4(sh.rgb, sh.a * (1.0 - c.a)); return; }
  float ao = c.a + sh.a * (1.0 - c.a);
  fragColor = vec4(ao > 1e-5 ? (c.rgb * c.a + sh.rgb * sh.a * (1.0 - c.a)) / ao : vec3(0.0), ao);
}` },
    ],
  }),

  defineNode({
    id: 'composite.border',
    name: 'Border / Frame',
    category: 'Composite',
    description: 'Adds a coloured frame: "outside" grows the canvas by the width on every side, "inside" paints over the image edge. Inner radius rounds the photo\'s corners, outer radius rounds the frame (outside becomes transparent).',
    tags: ['border', 'frame', 'mat', 'passe-partout', 'rounded corners', 'stroke', 'polaroid'],
    color: C,
    inputs: img,
    params: {
      mode: { type: 'enum', default: 'outside', options: ['outside', 'inside'], label: 'Placement' },
      width: { type: 'float', default: 40, min: 0, max: 2000, step: 1, pixels: true, label: 'Width' },
      bottomExtra: { type: 'float', default: 0, min: 0, max: 4000, step: 1, pixels: true, label: 'Extra bottom', description: 'Extra space at the bottom (gallery / instant-print style).' },
      color: { type: 'color', default: [1, 1, 1, 1], label: 'Colour' },
      innerRadius: { type: 'float', default: 0, min: 0, max: 2000, step: 1, pixels: true, label: 'Inner radius' },
      outerRadius: { type: 'float', default: 0, min: 0, max: 2000, step: 1, pixels: true, label: 'Outer radius' },
    },
    size: ({ params, inputSizes, projectSize }) => {
      const s = inputSizes.image ?? projectSize;
      if (params.mode === 'inside') return [s.width, s.height];
      const w = Math.max(0, num(params, 'width', 40));
      return [Math.round(s.width + 2 * w), Math.round(s.height + 2 * w + Math.max(0, num(params, 'bottomExtra', 0)))];
    },
    passes: [{
      uniforms: (ctx) => {
        const s = ctx.inputSizes.image ?? { width: ctx.width, height: ctx.height };
        const W = s.width / ctx.scale, H = s.height / ctx.scale;
        const w = Math.max(0, num(ctx.params, 'width', 40)), b = Math.max(0, num(ctx.params, 'bottomExtra', 0));
        const inside = ctx.params.mode === 'inside';
        // image rect (full-res px, in output coords) and the opening of the frame
        const img = inside ? [0, 0, W, H] : [w, w, W, H];
        const hole = inside ? [w, w, W - 2 * w, H - 2 * w - b] : [w, w, W, H];
        return { u_img: img, u_hole: hole, u_outFull: [ctx.width / ctx.scale, ctx.height / ctx.scale] };
      },
      frag: /* glsl */ `
uniform vec4 u_img, u_hole;
uniform vec2 u_outFull;
float sdRound(vec2 p, vec4 r, float rad) {
  vec2 c = r.xy + r.zw * 0.5, he = r.zw * 0.5;
  rad = min(rad, min(he.x, he.y));
  vec2 q = abs(p - c) - he + rad;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - rad;
}
void main(){
  vec2 P = v_uv * u_outFull;
  float aa = 1.0 / max(u_scale, 1e-4);
  vec2 uv = (P - u_img.xy) / u_img.zw;
  vec4 c = texture(u_image, clamp(uv, 0.0, 1.0));
  float inHole = 1.0 - smoothstep(-0.5 * aa, 0.5 * aa, sdRound(P, u_hole, u_innerRadius));
  float inFrame = 1.0 - smoothstep(-0.5 * aa, 0.5 * aa, sdRound(P, vec4(0.0, 0.0, u_outFull), u_outerRadius));
  // photo over frame colour inside the hole; frame colour elsewhere
  vec4 f = u_color;
  float a = c.a * inHole;
  float ao = a + f.a * (1.0 - a);
  vec4 o = vec4(ao > 1e-5 ? (c.rgb * a + f.rgb * f.a * (1.0 - a)) / ao : f.rgb, ao);
  fragColor = vec4(o.rgb, o.a * inFrame);
}`,
    }],
  }),

  defineNode({
    id: 'util.info',
    name: 'Info',
    category: 'Utility',
    description: 'Passes the image through and (optionally) overlays a readout of its full-resolution size, megapixels, aspect, mean colour (sRGB + hex) and mean luma/alpha. Measured on the CPU.',
    tags: ['info', 'size', 'dimensions', 'mean', 'average colour', 'debug', 'inspect'],
    color: U,
    inputs: img,
    cpuReadsInputs: true,
    params: {
      overlay: { type: 'bool', default: true, label: 'Show overlay' },
      corner: { type: 'enum', default: 'top-left', options: CORNERS, label: 'Corner' },
    },
    cpu: ({ readInput, scale, projectSize }) => {
      const raw = readInput('image');
      if (!raw) return { label: { width: 1, height: 1, data: new Uint8Array(4) } };
      const { lines, mean } = infoText(raw, scale, projectSize);
      const fs = panelFont(raw);
      const pad = fs * 0.6, sw = fs * 1.4;
      const cv = new OffscreenCanvas(1, 1);
      let g = cv.getContext('2d')!;
      g.font = `${fs}px ui-monospace, monospace`;
      const tw = Math.max(...lines.map((l) => g.measureText(l).width));
      cv.width = Math.ceil(tw + pad * 3 + sw); cv.height = Math.ceil(lines.length * fs * 1.35 + pad * 2);
      g = cv.getContext('2d')!;
      g.fillStyle = 'rgba(10,10,12,0.78)';
      g.fillRect(0, 0, cv.width, cv.height);
      g.fillStyle = `rgb(${mean.slice(0, 3).map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255)).join(',')})`;
      g.fillRect(pad, pad, sw, cv.height - 2 * pad);
      g.strokeStyle = 'rgba(255,255,255,0.6)';
      g.lineWidth = Math.max(1, fs / 14);
      g.strokeRect(pad, pad, sw, cv.height - 2 * pad);
      g.font = `${fs}px ui-monospace, monospace`;
      g.fillStyle = '#f2f2f2';
      g.textBaseline = 'top';
      lines.forEach((l, i) => g.fillText(l, pad * 2 + sw, pad + i * fs * 1.35));
      return { label: cv };
    },
    passes: [{
      frag: /* glsl */ `
${overlayGlsl('label')}
void main(){
  vec4 c = texture(u_image, v_uv);
  fragColor = u_overlay ? ex_over(c, ex_panel(u_corner, 0.02)) : c;
}`,
    }],
  }),

  defineNode({
    id: 'util.splitCompare',
    name: 'Split Compare',
    category: 'Utility',
    description: 'Before/after wipe: `before` on one side of a line, `after` on the other. Position 0..1 across the image, angle rotates the divider (0 = vertical). `after` is stretched to the before image\'s size.',
    tags: ['before after', 'compare', 'wipe', 'split', 'a/b', 'diff'],
    color: U,
    inputs: {
      before: { type: 'image', label: 'Before' },
      after: { type: 'image', label: 'After' },
    },
    params: {
      position: { type: 'float', default: 0.5, min: 0, max: 1, step: 0.001, label: 'Position' },
      angle: { type: 'float', default: 0, min: -90, max: 90, step: 0.5, label: 'Angle (°)' },
      lineWidth: { type: 'float', default: 3, min: 0, max: 50, step: 0.5, pixels: true, label: 'Line width' },
      lineColor: { type: 'color', default: [1, 1, 1, 1], label: 'Line colour' },
    },
    passes: [{
      frag: /* glsl */ `
void main(){
  vec2 p = v_uv * u_resolution;
  float a = radians(u_angle);
  vec2 n = vec2(cos(a), sin(a));   // line normal (0° → vertical line)
  vec2 o = vec2(u_position, 0.5) * u_resolution;
  float d = dot(p - o, n);
  vec4 c = d < 0.0 ? texture(u_before, v_uv) : texture(u_after, v_uv);
  float w = u_lineWidth * u_scale * 0.5;
  float line = w > 0.0 ? 1.0 - smoothstep(w - 0.5, w + 0.5, abs(d)) : 0.0;
  fragColor = vec4(mix(c.rgb, u_lineColor.rgb, line * u_lineColor.a), max(c.a, line));
}`,
    }],
  }),

  defineNode({
    id: 'util.channelView',
    name: 'Channel Viewer',
    category: 'Utility',
    description: 'Shows a single channel (R, G, B, alpha, Rec.709 luma) as greyscale or tinted, or a 2×2 grid of R / G / B / luma for side-by-side inspection.',
    tags: ['channels', 'red', 'green', 'blue', 'alpha', 'luma', 'inspect', 'debug'],
    color: U,
    inputs: img,
    params: {
      channel: { type: 'enum', default: 'grid', options: ['red', 'green', 'blue', 'alpha', 'luma', 'grid'], label: 'Channel' },
      tinted: { type: 'bool', default: false, label: 'Tint R/G/B' },
    },
    passes: [{
      frag: /* glsl */ `
vec3 show(vec4 c, int ch) {
  float v = ch == 0 ? c.r : ch == 1 ? c.g : ch == 2 ? c.b : ch == 3 ? c.a : luma(c.rgb);
  if (u_tinted && ch < 3) { vec3 t = vec3(0.0); t[ch] = v; return t; }
  return vec3(v);
}
void main(){
  if (u_channel == 5) {
    vec2 g = v_uv * 2.0;
    vec2 cell = floor(g);
    int ch = int(cell.x + 2.0 * cell.y);
    vec3 o = show(texture(u_image, fract(g)), ch == 3 ? 4 : ch);
    vec2 e = abs(g - 1.0) * u_resolution * 0.5;
    if (min(e.x, e.y) < 1.0) o = vec3(0.15);
    fragColor = vec4(o, 1.0);
    return;
  }
  fragColor = vec4(show(texture(u_image, v_uv), u_channel), 1.0);
}`,
    }],
  }),

  defineNode({
    id: 'util.histogramOverlay',
    name: 'Histogram Overlay',
    category: 'Utility',
    description: 'Draws an RGB (+ luma) histogram panel onto the image, computed on the CPU from the input. Additive channel fills (overlaps read yellow/cyan/magenta/white), quarter gridlines, 0–255 axis and clip percentages. Linear or log counts.',
    tags: ['histogram', 'scope', 'levels', 'exposure', 'analysis', 'academic', 'graph'],
    color: U,
    inputs: img,
    cpuReadsInputs: true,
    params: {
      corner: { type: 'enum', default: 'bottom-right', options: CORNERS, label: 'Corner' },
      size: { type: 'float', default: 0.38, min: 0.1, max: 1, step: 0.01, label: 'Width (of image)' },
      channels: { type: 'enum', default: 'rgb + luma', options: ['rgb + luma', 'rgb', 'luma'], label: 'Channels' },
      log: { type: 'bool', default: false, label: 'Log scale' },
      opacity: { type: 'float', default: 1, min: 0, max: 1, step: 0.01, label: 'Opacity' },
    },
    cpu: ({ params, readInput }) => {
      const raw = readInput('image');
      if (!raw) return { panel: { width: 1, height: 1, data: new Uint8Array(4) } };
      return { panel: drawHistogram(raw, params.channels as string, !!params.log, num(params, 'size', 0.38)) };
    },
    passes: [{
      frag: /* glsl */ `
${overlayGlsl('panel')}
void main(){
  vec4 c = texture(u_image, v_uv);
  vec4 p = ex_panel(u_corner, 0.025);
  p.a *= u_opacity;
  fragColor = ex_over(c, p);
}`,
    }],
  }),
] satisfies NodeDef[];

function drawHistogram(raw: RawTex, channels: string, log: boolean, sizeFrac: number): OffscreenCanvas {
  const bins = 256;
  const h = computeHistograms(raw.data, raw.width, raw.height, bins);
  const W = Math.max(60, Math.round(raw.width * sizeFrac));
  const fs = Math.max(5, W / 36);
  const H = Math.round(W * 0.42 + fs * 3.2);
  const cv = new OffscreenCanvas(W, H);
  const g = cv.getContext('2d')!;
  const pad = Math.round(fs * 0.8);
  const top = Math.round(fs * 1.9), bottom = H - Math.round(fs * 1.7);
  const left = pad, right = W - pad;
  const gw = right - left, gh = bottom - top;
  g.fillStyle = 'rgba(12,12,15,0.82)';
  g.fillRect(0, 0, W, H);
  // title
  g.font = `${fs}px ui-monospace, monospace`;
  g.textBaseline = 'alphabetic';
  g.fillStyle = '#e8e8e8';
  const clipLo = (h.l[0] / Math.max(h.total, 1)) * 100, clipHi = (h.l[bins - 1] / Math.max(h.total, 1)) * 100;
  g.fillText(`Histogram  n=${h.total.toLocaleString('en-US')}`, left, top - fs * 0.6);
  g.textAlign = 'right';
  g.fillStyle = '#9a9aa3';
  const clipTxt = `clip ${clipLo.toFixed(1)}% / ${clipHi.toFixed(1)}%${log ? '  log' : ''}`;
  if (g.measureText(`Histogram  n=${h.total.toLocaleString('en-US')}`).width + g.measureText(clipTxt).width + fs < gw) g.fillText(clipTxt, right, top - fs * 0.6);
  g.textAlign = 'left';
  // scale: robust max (ignore the extreme end bins, which often spike from clipping)
  const tf = (v: number) => (log ? Math.log1p(v) : v);
  const sets = channels === 'luma' ? [] : [h.r, h.g, h.b];
  let mx = 1;
  for (const s of [...sets, h.l]) for (let i = 1; i < bins - 1; i++) mx = Math.max(mx, tf(s[i]));
  // grid
  g.strokeStyle = 'rgba(255,255,255,0.14)';
  g.lineWidth = 1;
  for (let k = 0; k <= 4; k++) {
    const x = Math.round(left + (gw * k) / 4) + 0.5;
    g.beginPath(); g.moveTo(x, top); g.lineTo(x, bottom); g.stroke();
  }
  for (let k = 1; k < 4; k++) {
    const y = Math.round(top + (gh * k) / 4) + 0.5;
    g.beginPath(); g.moveTo(left, y); g.lineTo(right, y); g.stroke();
  }
  const path = (s: Float64Array) => {
    g.beginPath();
    g.moveTo(left, bottom);
    for (let i = 0; i < bins; i++) {
      const x = left + ((i + 0.5) / bins) * gw;
      g.lineTo(x, bottom - Math.min(1, tf(s[i]) / mx) * gh);
    }
    g.lineTo(right, bottom);
    g.closePath();
  };
  g.globalCompositeOperation = 'lighter';
  const cols = ['rgba(255,60,60,0.62)', 'rgba(60,220,80,0.62)', 'rgba(70,120,255,0.62)'];
  sets.forEach((s, i) => { path(s); g.fillStyle = cols[i]; g.fill(); });
  g.globalCompositeOperation = 'source-over';
  if (channels !== 'rgb') {
    path(h.l);
    if (channels === 'luma') { g.fillStyle = 'rgba(220,220,220,0.5)'; g.fill(); }
    g.strokeStyle = 'rgba(255,255,255,0.9)';
    g.lineWidth = Math.max(1, fs / 10);
    g.stroke();
  }
  // axes
  g.strokeStyle = 'rgba(255,255,255,0.55)';
  g.lineWidth = 1;
  g.beginPath(); g.moveTo(left, bottom + 0.5); g.lineTo(right, bottom + 0.5); g.stroke();
  g.fillStyle = '#b8b8c0';
  g.font = `${Math.round(fs * 0.85)}px ui-monospace, monospace`;
  g.textBaseline = 'top';
  [0, 64, 128, 192, 255].forEach((v, k) => {
    g.textAlign = k === 0 ? 'left' : k === 4 ? 'right' : 'center';
    g.fillText(String(v), left + (gw * k) / 4, bottom + fs * 0.35);
  });
  return cv;
}
