/** Retro digital: palette quantisation, error diffusion, LCD subpixels. */
import { defineNode } from '../../core/registry';
import type { NodeDef, PassContext, Params } from '../../core/types';
import { cellGrid, colorParam, FE, hex, num } from './_shared';

const C = '#9ae66e';
const img = { image: { type: 'image' as const } };

const H = (s: string) => s.trim().split(/\s+/).map(hex);

/** Classic system palettes (sRGB). */
export const PALETTES: Record<string, [number, number, number][]> = {
  'PICO-8': H('000000 1D2B53 7E2553 008751 AB5236 5F574F C2C3C7 FFF1E8 FF004D FFA300 FFEC27 00E436 29ADFF 83769C FF77A8 FFCCAA'),
  NES: H(`7C7C7C 0000FC 0000BC 4428BC 940084 A80020 A81000 881400 503000 007800 006800 005800 004058 000000
    BCBCBC 0078F8 0058F8 6844FC D800CC E40058 F83800 E45C10 AC7C00 00B800 00A800 00A844 008888
    F8F8F8 3CBCFC 6888FC 9878F8 F878F8 F85898 F87858 FCA044 F8B800 B8F818 58D854 58F898 00E8D8 787878
    FCFCFC A4E4FC B8B8F8 D8B8F8 F8B8F8 F8A4C0 F0D0B0 FCE0A8 F8D878 D8F878 B8F8B8 B8F8D8 00FCFC F8D8F8`),
  'C64': H('000000 FFFFFF 68372B 70A4B2 6F3D86 588D43 352879 B8C76F 6F4F25 433900 9A6759 444444 6C6C6C 9AD284 6C5EB5 959595'),
  'EGA': H('000000 0000AA 00AA00 00AAAA AA0000 AA00AA AA5500 AAAAAA 555555 5555FF 55FF55 55FFFF FF5555 FF55FF FFFF55 FFFFFF'),
  'CGA (cyan/magenta)': H('000000 55FFFF FF55FF FFFFFF'),
  'CGA (green/red/yellow)': H('000000 55FF55 FF5555 FFFF55'),
  'Mac Plus (1-bit)': H('000000 FFFFFF'),
  'Apple II hi-res': H('000000 FFFFFF 14F53C FF44FD 14CFFD FF6A3C'),
  'Apple II lo-res': H('000000 722640 40337F E434FE 0E5940 808080 1B9AFE BFB3FF 404C00 E46501 F1A6BF 1BCB01 BFCC80 8DD9BF FFFFFF'),
  'ZX Spectrum': H('000000 0000D7 D70000 D700D7 00D700 00D7D7 D7D700 D7D7D7 0000FF FF0000 FF00FF 00FF00 00FFFF FFFF00 FFFFFF'),
  'Game Boy': H('0F380F 306230 8BAC0F 9BBC0F'),
  'Teletext (8 colour)': H('000000 FF0000 00FF00 FFFF00 0000FF FF00FF 00FFFF FFFFFF'),
  'Grey (4)': H('000000 555555 AAAAAA FFFFFF'),
};
const PAL_OPTIONS = [...Object.keys(PALETTES), 'Custom 2-colour'];
const MAXPAL = 64;

function paletteUniforms(p: Params) {
  const name = String(p.palette ?? 'PICO-8');
  const pal = PALETTES[name] ?? [colorParam(p, 'colorA', [0.1, 0.1, 0.15]).slice(0, 3), colorParam(p, 'colorB', [0.95, 0.9, 0.8]).slice(0, 3)] as [number, number, number][];
  const flat: number[] = [];
  for (let i = 0; i < MAXPAL; i++) flat.push(...(pal[i] ?? [0, 0, 0]));
  // average per-channel spacing to the nearest other entry: sets ordered-dither amplitude
  let sp = 0;
  pal.forEach((a, i) => {
    let best = Infinity;
    pal.forEach((b, j) => { if (i !== j) best = Math.min(best, Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]))); });
    sp += Number.isFinite(best) ? best : 1;
  });
  sp = Math.min(1, Math.max(0.08, sp / Math.max(1, pal.length)));
  const mono = pal.every((c) => Math.abs(c[0] - c[1]) < 0.02 && Math.abs(c[1] - c[2]) < 0.02) ? 1 : 0;
  return { u_pal: flat, u_palN: pal.length, u_palSpread: sp, u_mono: mono };
}

const PAL_GLSL = /* glsl */ `
uniform vec3 u_pal[${MAXPAL}];
uniform int u_palN;
uniform float u_palSpread;
uniform int u_mono;
vec3 nearestPal(vec3 c, bool perceptual) {
  vec3 best = u_pal[0]; float bd = 1e9;
  vec3 lc = perceptual ? rgb2oklab(c) : c;
  for (int i = 0; i < ${MAXPAL}; i++) {
    if (i >= u_palN) break;
    vec3 p = u_pal[i];
    vec3 d = perceptual ? rgb2oklab(p) - lc : (p - c) * vec3(0.55, 0.75, 0.4);
    if (u_mono == 1) d = vec3(luma(p) - luma(c));
    float dd = dot(d, d);
    if (dd < bd) { bd = dd; best = p; }
  }
  return best;
}
vec3 adjust(vec3 c) {
  c = (c - 0.5) * u_contrast + 0.5 + u_brightness;
  float L = luma(c);
  c = mix(vec3(L), c, u_saturation);
  return clamp(c, 0.0, 1.0);
}
`;

const commonParams = {
  palette: { type: 'enum' as const, default: 'PICO-8', options: PAL_OPTIONS, label: 'Palette' },
  pixelSize: { type: 'float' as const, default: 4, min: 1, max: 64, step: 1, pixels: true, label: 'Pixel size', description: 'Size of one retro pixel in full-res px.' },
  cells: { type: 'int' as const, default: 0, min: 0, max: 2048, step: 1, label: 'Pixels across', description: 'If > 0, fixes the horizontal resolution (e.g. 128 for PICO-8, 256 for NES, 320 for C64/CGA, 512 for a Mac).' },
  brightness: { type: 'float' as const, default: 0, min: -1, max: 1, step: 0.01, label: 'Brightness' },
  contrast: { type: 'float' as const, default: 1.1, min: 0, max: 3, step: 0.01, label: 'Contrast' },
  saturation: { type: 'float' as const, default: 1.2, min: 0, max: 3, step: 0.01, label: 'Saturation' },
  colorA: { type: 'color' as const, default: [0.1, 0.1, 0.15, 1], label: 'Custom dark' },
  colorB: { type: 'color' as const, default: [0.95, 0.9, 0.8, 1], label: 'Custom light' },
};

const cellAverage = {
  filter: 'nearest' as const,
  size: (c: PassContext) => cellGrid(c),
  frag: FE(`
void main() {
  vec2 cell = 1.0 / u_resolution;
  vec2 o = v_uv - cell * 0.5;
  vec4 a = vec4(0.0);
  for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) a += texClamp(u_image, o + cell * (vec2(i, j) + 0.5) / 4.0);
  fragColor = a / 16.0;
}`),
};

// ---------------------------------------------------------------------------
// Palette quantize
// ---------------------------------------------------------------------------
const paletteQuantize = defineNode({
  id: 'effects.paletteQuantize',
  name: 'Retro Palette',
  category: 'Retro',
  color: C,
  description:
    'Reduces the image to a classic system palette — NES, PICO-8, C64, EGA, CGA, Apple II, ZX Spectrum, Mac Plus 1-bit, Game Boy, Teletext — at a chunky pixel size, ' +
    'with perceptual (OKLab) colour matching and optional ordered or blue-noise dithering scaled to the palette\'s colour spacing. (For error diffusion see Error Diffusion Dither.)',
  tags: ['palette', 'nes', 'pico-8', 'c64', 'ega', 'cga', 'apple ii', '8-bit', 'pixel art', 'retro', 'quantize', 'zx spectrum'],
  inputs: img,
  params: {
    ...commonParams,
    dither: { type: 'enum', default: 'Bayer 4×4', options: ['None', 'Bayer 2×2', 'Bayer 4×4', 'Bayer 8×8', 'Blue noise'], label: 'Dither' },
    ditherAmount: { type: 'float', default: 0.8, min: 0, max: 2, step: 0.01, label: 'Dither strength' },
    perceptual: { type: 'bool', default: true, label: 'Perceptual matching', description: 'Match colours in OKLab (off = weighted RGB).' },
  },
  passes: [
    cellAverage,
    {
      uniforms: (c) => paletteUniforms(c.params),
      frag: FE(PAL_GLSL + `
void main() {
  vec2 cell = floor(v_uv * u_pass0_size);
  vec4 s = texelFetch(u_pass0, ivec2(cell), 0);
  vec3 c = adjust(s.rgb);
  float t = 0.5;
  if (u_dither == 1) t = bayer2(cell); else if (u_dither == 2) t = bayer4(cell); else if (u_dither == 3) t = bayer8(cell); else if (u_dither == 4) t = ign(cell);
  if (u_dither > 0) c = clamp(c + (t - 0.5) * u_palSpread * u_ditherAmount, 0.0, 1.0);
  fragColor = vec4(nearestPal(c, u_perceptual), s.a);
}`),
    },
  ],
});

// ---------------------------------------------------------------------------
// Error diffusion
// ---------------------------------------------------------------------------
const KERNELS = ['Atkinson', 'Floyd–Steinberg', 'Jarvis–Judice–Ninke', 'Sierra Lite'];

type Kernel = { taps: [number, number, number][]; div: number };
const KERNEL_DEFS: Record<string, Kernel> = {
  'Atkinson': { taps: [[1, 0, 1], [2, 0, 1], [-1, 1, 1], [0, 1, 1], [1, 1, 1], [0, 2, 1]], div: 8 },
  'Floyd–Steinberg': { taps: [[1, 0, 7], [-1, 1, 3], [0, 1, 5], [1, 1, 1]], div: 16 },
  'Jarvis–Judice–Ninke': { taps: [[1, 0, 7], [2, 0, 5], [-2, 1, 3], [-1, 1, 5], [0, 1, 7], [1, 1, 5], [2, 1, 3], [-2, 2, 1], [-1, 2, 3], [0, 2, 5], [1, 2, 3], [2, 2, 1]], div: 48 },
  'Sierra Lite': { taps: [[1, 0, 2], [-1, 1, 1], [0, 1, 1]], div: 4 },
};

/** Real sequential error diffusion on the CPU at the retro-pixel grid (small: a few hundred px across). */
function errorDiffuse(params: Params, src: { width: number; height: number; data: Float32Array | Uint8Array }, scale: number) {
  const { width: w, height: h, data } = src;
  const cells = num(params, 'cells', 0);
  const p = cells > 0 ? w / cells : Math.max(1, num(params, 'pixelSize', 2)) * scale;
  const GW = Math.max(1, Math.min(4096, Math.round(w / p))), GH = Math.max(1, Math.min(4096, Math.round(h / p)));
  const { u_pal, u_palN, u_mono } = paletteUniforms(params);
  const pal: number[][] = [];
  for (let i = 0; i < u_palN; i++) pal.push(u_pal.slice(i * 3, i * 3 + 3));
  const con = num(params, 'contrast', 1.1), bri = num(params, 'brightness', 0), sat = num(params, 'saturation', 1.2);
  const strength = num(params, 'strength', 1), noise = num(params, 'noise', 0.05);
  const scale8 = data instanceof Uint8Array ? 1 / 255 : 1;
  // box-average into the grid + adjustments
  const buf = new Float32Array(GW * GH * 3);
  for (let gy = 0; gy < GH; gy++) {
    const y0 = Math.floor((gy * h) / GH), y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * h) / GH));
    for (let gx = 0; gx < GW; gx++) {
      const x0 = Math.floor((gx * w) / GW), x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * w) / GW));
      let r = 0, g = 0, b = 0, n = 0;
      const sy = Math.max(1, Math.floor((y1 - y0) / 4)), sx = Math.max(1, Math.floor((x1 - x0) / 4));
      for (let y = y0; y < y1; y += sy) for (let x = x0; x < x1; x += sx) {
        const i = (y * w + x) * 4;
        r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
      }
      let c = [r / n * scale8, g / n * scale8, b / n * scale8].map((v) => (v - 0.5) * con + 0.5 + bri);
      const L = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
      c = c.map((v) => Math.min(1, Math.max(0, L + (v - L) * sat)));
      if (u_mono) { const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; c = [l, l, l]; }
      const o = (gy * GW + gx) * 3;
      buf[o] = c[0]; buf[o + 1] = c[1]; buf[o + 2] = c[2];
    }
  }
  const k = KERNEL_DEFS[String(params.kernel)] ?? KERNEL_DEFS.Atkinson;
  const serp = params.serpentine !== false;
  const out = new Float32Array(GW * GH * 4);
  let seed = 1234567;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let y = 0; y < GH; y++) {
    const rev = serp && y % 2 === 1;
    for (let xi = 0; xi < GW; xi++) {
      const x = rev ? GW - 1 - xi : xi;
      const o = (y * GW + x) * 3;
      const v = [buf[o], buf[o + 1], buf[o + 2]];
      const nz = noise ? (rnd() - 0.5) * noise : 0;
      // nearest palette entry (weighted RGB, or luma for grey palettes)
      let best = 0, bd = Infinity;
      for (let i = 0; i < pal.length; i++) {
        const q = pal[i];
        let d: number;
        if (u_mono) { const t = v[0] + nz - (0.2126 * q[0] + 0.7152 * q[1] + 0.0722 * q[2]); d = t * t; }
        else { const dr = v[0] + nz - q[0], dg = v[1] + nz - q[1], db = v[2] + nz - q[2]; d = 0.3 * dr * dr + 0.55 * dg * dg + 0.15 * db * db; }
        if (d < bd) { bd = d; best = i; }
      }
      const q = pal[best];
      const ql = u_mono ? 0.2126 * q[0] + 0.7152 * q[1] + 0.0722 * q[2] : 0;
      const e = u_mono ? [v[0] - ql, v[0] - ql, v[0] - ql] : [v[0] - q[0], v[1] - q[1], v[2] - q[2]];
      const oo = (y * GW + x) * 4;
      out[oo] = q[0]; out[oo + 1] = q[1]; out[oo + 2] = q[2]; out[oo + 3] = 1;
      for (const [dx0, dy, wt] of k.taps) {
        const dx = rev ? -dx0 : dx0;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= GW || ny >= GH) continue;
        const t = (ny * GW + nx) * 3, f = (wt / k.div) * strength;
        buf[t] = Math.min(1.6, Math.max(-0.6, buf[t] + e[0] * f));
        buf[t + 1] = Math.min(1.6, Math.max(-0.6, buf[t + 1] + e[1] * f));
        buf[t + 2] = Math.min(1.6, Math.max(-0.6, buf[t + 2] + e[2] * f));
      }
    }
  }
  return { width: GW, height: GH, data: out, filter: 'nearest' as const };
}

const ditherDiffusion = defineNode({
  id: 'effects.ditherDiffusion',
  name: 'Error Diffusion Dither',
  category: 'Retro',
  color: C,
  description:
    'True error-diffusion dithering (Atkinson, Floyd–Steinberg, Jarvis–Judice–Ninke, Sierra Lite; serpentine scan) to any retro palette, computed on the CPU ' +
    'at the retro-pixel grid. Atkinson (MacPaint / early Mac) discards 1/4 of the error, giving crisp highlights, deep blacks and the classic stippled look.',
  tags: ['dither', 'atkinson', 'floyd steinberg', 'error diffusion', '1-bit', 'mac', 'macpaint', 'retro', 'newsletter'],
  inputs: img,
  params: {
    ...commonParams,
    palette: { type: 'enum', default: 'Mac Plus (1-bit)', options: PAL_OPTIONS, label: 'Palette' },
    pixelSize: { ...commonParams.pixelSize, default: 2 },
    kernel: { type: 'enum', default: 'Atkinson', options: KERNELS, label: 'Kernel' },
    strength: { type: 'float', default: 1, min: 0, max: 1.2, step: 0.01, label: 'Error strength' },
    serpentine: { type: 'bool', default: true, label: 'Serpentine scan' },
    noise: { type: 'float', default: 0.04, min: 0, max: 0.5, step: 0.01, label: 'Threshold noise', description: 'Breaks up regular patterns in flat areas.' },
  },
  cpuReadsInputs: true,
  cpu: ({ params, scale, readInput }) => {
    const src = readInput('image');
    if (!src) return { dith: { width: 1, height: 1, data: new Float32Array([0, 0, 0, 1]), filter: 'nearest' } };
    return { dith: errorDiffuse(params, src, scale) };
  },
  passes: [{
    frag: FE(`
void main() {
  vec4 c = texelFetch(u_dith, ivec2(min(floor(v_uv * u_dith_size), u_dith_size - 1.0)), 0);
  fragColor = vec4(c.rgb, texture(u_image, v_uv).a);
}`),
  }],
});

// ---------------------------------------------------------------------------
// LCD
// ---------------------------------------------------------------------------
const lcd = defineNode({
  id: 'effects.lcd',
  name: 'LCD Screen',
  category: 'Retro',
  color: C,
  description:
    'Close-up of an LCD: each image pixel becomes a cell of red/green/blue subpixels (stripe or delta layout) separated by the black matrix, with a slight glow. ' +
    'GBA mode adds the original Game Boy Advance\'s dark, desaturated unlit-reflective colour response; DMG mode mimics the green Game Boy screen whose dark pixels cast shadows.',
  tags: ['lcd', 'subpixel', 'screen', 'gba', 'game boy', 'handheld', 'pixel grid', 'display', 'monitor'],
  inputs: img,
  params: {
    layout: { type: 'enum', default: 'RGB stripe', options: ['RGB stripe', 'BGR stripe', 'Delta (triad)', 'GBA', 'Game Boy (DMG)'], label: 'Layout' },
    pixelSize: { type: 'float', default: 6, min: 2, max: 64, step: 0.5, pixels: true, label: 'Pixel size', description: 'One LCD pixel in full-res px.' },
    cells: { type: 'int', default: 0, min: 0, max: 2048, step: 1, label: 'Pixels across', description: 'If > 0, fixes the screen resolution across (240 = GBA, 160 = Game Boy).' },
    gap: { type: 'float', default: 0.25, min: 0, max: 0.8, step: 0.01, label: 'Grid gap' },
    subpixels: { type: 'float', default: 1, min: 0, max: 1, step: 0.01, label: 'Subpixel visibility' },
    glow: { type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, label: 'Glow / diffusion' },
    brightness: { type: 'float', default: 1.5, min: 0.2, max: 3, step: 0.01, label: 'Brightness' },
  },
  passes: [
    { ...cellAverage, size: (c: PassContext) => cellGrid(c) },
    {
      frag: FE(`
float box(float x, float g) { return smoothstep(g * 0.5 - 0.06, g * 0.5 + 0.06, x) * smoothstep(g * 0.5 - 0.06, g * 0.5 + 0.06, 1.0 - x); }
void main() {
  vec2 grid = u_pass0_size;
  vec2 cp = v_uv * grid;
  bool delta = u_layout == 2;
  if (delta && mod(floor(cp.y), 2.0) >= 1.0) cp.x += 0.5;
  vec2 id = floor(cp), local = fract(cp);
  vec3 c = texel(u_pass0, ivec2(id)).rgb;
  // glow: soft blend of neighbouring cells
  vec3 soft = texture(u_pass0, v_uv).rgb;
  float pxOut = u_resolution.x / grid.x;                // output px per LCD pixel
  float resolve = clamp(pxOut / 3.0 - 0.6, 0.0, 1.0);   // can the preview resolve subpixels?
  vec3 o;
  if (u_layout == 4) {
    // DMG: 4 green shades, dark pixels with drop shadow on a light reflector
    const vec3 S0 = vec3(0.059, 0.22, 0.059), S3 = vec3(0.61, 0.737, 0.059);
    float y = clamp(luma(c) * 1.1, 0.0, 1.0);
    float q = floor(y * 3.999) / 3.0;
    float dark = 1.0 - q;
    float cellMask = box(local.x, u_gap * 0.6) * box(local.y, u_gap * 0.6);
    // each dark pixel casts a faint shadow onto the reflector below-right
    vec2 sp = cp - vec2(0.15, 0.18);
    float shMask = box(fract(sp.x), u_gap * 0.6) * box(fract(sp.y), u_gap * 0.6);
    float dsh = 1.0 - floor(clamp(luma(texel(u_pass0, ivec2(floor(sp))).rgb) * 1.1, 0.0, 1.0) * 3.999) / 3.0;
    vec3 bg = S3 * (1.0 - shMask * dsh * 0.22);
    vec3 px = mix(S3, S0, dark);
    o = mix(bg, px, cellMask);
    o = mix(o, px, 1.0 - resolve);
    fragColor = vec4(o, 1.0);
    return;
  }
  if (u_layout == 3) {
    // GBA: unlit reflective TFT — gamma-darkened, cross-talk desaturated
    vec3 l = pow(clamp(c, 0.0, 1.0), vec3(1.0));
    l = mat3(0.80, 0.10, 0.10,  0.24, 0.66, 0.10,  0.04, 0.24, 0.72) * l;
    l = pow(l, vec3(1.25)) * 0.95 + vec3(0.03, 0.035, 0.04);
    c = l;
    soft = c;
  }
  vec3 stripe;
  float sx = local.x * 3.0;
  int sub = int(min(floor(sx), 2.0));
  if (u_layout == 1) sub = 2 - sub;
  float m = box(fract(sx), u_gap) * box(local.y, u_gap * 0.6);
  vec3 chan = sub == 0 ? vec3(1.0, 0.0, 0.0) : sub == 1 ? vec3(0.0, 1.0, 0.0) : vec3(0.0, 0.0, 1.0);
  // work in linear light so the spatial average of the subpixels equals the flat colour
  vec3 cl = srgbToLinear(clamp(c, 0.0, 1.0)), sl = srgbToLinear(clamp(soft, 0.0, 1.0));
  // energy-preserving subpixels: a saturated subpixel spills its excess into the cell (like a camera's bloom)
  vec3 v = cl * u_brightness * m;
  vec3 vOwn = v * (1.0 + 2.0 * u_subpixels), vOth = v * (1.0 - u_subpixels);
  vec3 spill = max(vOwn - 1.0, 0.0) * 0.5;
  vec3 lit = chan * min(vOwn, 1.0) + (1.0 - chan) * min(vOth + spill, 1.0);
  float avgM = clamp(1.0 - u_gap, 0.0, 1.0) * clamp(1.0 - u_gap * 0.6, 0.0, 1.0);
  lit = mix(lit, min(sl * u_brightness * avgM, 1.0), u_glow * 0.3);
  // when the preview can't resolve subpixels, show their average (same overall light as export)
  vec3 flatL = mix(min(cl * u_brightness * avgM, 1.0), min(sl * u_brightness * avgM, 1.0), u_glow * 0.3);
  o = linearToSrgb(mix(flatL, lit, resolve));
  fragColor = vec4(clamp(o, 0.0, 1.5), 1.0);
}`),
    },
  ],
});

export default [paletteQuantize, ditherDiffusion, lcd] satisfies NodeDef[];
