/**
 * Image-level ControlNet preprocessors (GPU) and the Control Sheet:
 *  - control.shuffle: content shuffle (controlnet_aux ContentShuffleDetector: a random smooth flow field from
 *    bicubic-upsampled uniform noise, `make_noise_disk(H, W, 1, f)`, used to cv2.remap the image).
 *  - control.tile: tile_resample (area downsample by a rate, bilinear back up) or blur (ComfyUI pyrDown/pyrUp).
 *  - control.colorGrid: t2i color adapter grid (downscale by 64 → nearest-neighbour upscale).
 *  - control.inpaintMask: a mask formatted for ControlNet inpaint (binary, grown), or the masked image.
 *  - control.sheet: up to six maps side by side in a labelled grid.
 */
import { defineNode } from '../../core/registry';
import type { NodeDef, PassContext } from '../../core/types';
import { makeCanvas } from '../ai/face-draw';
import { AREA_DOWN_FRAG, CATEGORY, CONTROL_COLOR, detectDims, detectSize, gaussPass, resolutionParam } from './_shared';

// ---------------------------------------------------------------------------------------------- Shuffle
const shuffle = defineNode({
  id: 'control.shuffle',
  name: 'Content Shuffle (ControlNet)',
  category: CATEGORY,
  color: CONTROL_COLOR,
  description:
    'Content shuffle for the ControlNet shuffle model: the image is warped by a random, smooth flow field (bicubic-upsampled uniform noise, ' +
    'frequency f = 256 px at the detect resolution), exactly as the shuffle preprocessor does. Change the seed for another shuffle.',
  tags: ['controlnet', 'shuffle', 'content shuffle', 'style', 'warp', 'control map', 'stable diffusion', 'preprocessor'],
  inputs: { image: { type: 'image', label: 'Image' } },
  params: {
    resolution: resolutionParam(512),
    frequency: { type: 'int', default: 256, min: 16, max: 1024, step: 1, label: 'Frequency (f)', description: 'Noise cell size in px at the detect resolution; smaller = more scrambled.' },
    seed: { type: 'int', default: 0, min: 0, max: 99999, step: 1, label: 'Seed' },
  },
  passes: [
    { size: detectSize(), frag: AREA_DOWN_FRAG },
    {
      size: detectSize(),
      frag: /* glsl */ `
// cv2.INTER_CUBIC kernel (a = -0.75)
float cub(float x) { x = abs(x); float a = -0.75;
  return x <= 1.0 ? ((a + 2.0) * x - (a + 3.0)) * x * x + 1.0 : (x < 2.0 ? ((a * x - 5.0 * a) * x + 8.0 * a) * x - 4.0 * a : 0.0); }
float node(ivec2 q, ivec2 g, float s) { q = clamp(q, ivec2(0), g - 1); return hash12(vec2(q) + vec2(s * 17.31, s * 3.7)); }
// make_noise_disk: uniform noise on a (H//F + 2) × (W//F + 2) grid, resized to (H + 2F, W + 2F), cropped at F, min-max normalised
float noiseDisk(vec2 px, vec2 S, float F, float s) {
  ivec2 g = ivec2(floor(S / F)) + 2;
  vec2 big = S + 2.0 * F;
  vec2 sp = (px + F + 0.5) * vec2(g) / big - 0.5;
  vec2 b = floor(sp); vec2 f = sp - b;
  float acc = 0.0;
  for (int j = -1; j <= 2; j++) for (int i = -1; i <= 2; i++)
    acc += node(ivec2(b) + ivec2(i, j), g, s) * cub(float(i) - f.x) * cub(float(j) - f.y);
  // normalise by the range of the grid values (the cubic overshoot is small)
  float lo = 1.0, hi = 0.0;
  for (int j = 0; j < 16; j++) for (int i = 0; i < 16; i++) {
    if (i >= g.x || j >= g.y) continue;
    float v = node(ivec2(i, j), g, s); lo = min(lo, v); hi = max(hi, v);
  }
  return clamp((acc - lo) / max(hi - lo, 1e-5), 0.0, 1.0);
}
void main() {
  vec2 S = u_resolution;
  vec2 px = v_uv * S - 0.5;
  float F = float(u_frequency);
  float s = float(u_seed);
  vec2 flow = vec2(noiseDisk(px, S, F, s * 2.0 + 1.0) * (S.x - 1.0), noiseDisk(px, S, F, s * 2.0 + 2.0) * (S.y - 1.0));
  fragColor = vec4(texture(u_pass0, (flow + 0.5) / S).rgb, 1.0);
}`,
    },
    { frag: `void main() { fragColor = vec4(texture(u_prev, v_uv).rgb, 1.0); }` },
  ],
});

// ------------------------------------------------------------------------------------------------- Tile
const TILE_MODES = ['Resample (A1111 tile_resample)', 'Blur (ComfyUI pyrUp)'];
const tileSize = (c: PassContext): [number, number] => {
  const k = Math.max(1, Number(c.params.rate) || 1);
  if (c.params.mode === TILE_MODES[1]) return [c.width, c.height];
  return [Math.max(1, Math.round(c.width / k)), Math.max(1, Math.round(c.height / k))];
};
const tile = defineNode({
  id: 'control.tile',
  name: 'Tile / Blur (ControlNet)',
  category: CATEGORY,
  color: CONTROL_COLOR,
  description:
    'Control image for the ControlNet tile model: the image downsampled by a rate (tile_resample: area downsample, then bilinear back up), ' +
    'or blurred like ComfyUI’s TilePreprocessor (pyrDown/pyrUp iterations ≈ gaussian blur). The model then re-invents the lost detail.',
  tags: ['controlnet', 'tile', 'blur', 'resample', 'upscale', 'detail', 'control map', 'stable diffusion', 'preprocessor'],
  inputs: { image: { type: 'image', label: 'Image' } },
  params: {
    mode: { type: 'enum', default: TILE_MODES[0], options: TILE_MODES, label: 'Mode' },
    rate: { type: 'float', default: 2, min: 1, max: 8, step: 0.1, label: 'Down sampling rate' },
    iterations: { type: 'int', default: 3, min: 1, max: 6, step: 1, label: 'Blur iterations', description: 'Blur mode: pyrUp iterations (blur σ ≈ 2^n px at 512).' },
  },
  passes: [
    {
      size: tileSize,
      frag: /* glsl */ `
void main() {
  vec2 r = u_image_size / u_resolution;
  int n = int(clamp(ceil(max(r.x, r.y)), 1.0, 8.0));
  vec3 acc = vec3(0.0);
  for (int j = 0; j < 8; j++) for (int i = 0; i < 8; i++) {
    if (i >= n || j >= n) continue;
    vec2 o = (vec2(float(i), float(j)) + 0.5) / float(n) - 0.5;
    acc += texture(u_image, v_uv + o / u_resolution).rgb;
  }
  fragColor = vec4(acc / float(n * n), 1.0);
}`,
    },
    // blur mode: σ = 2^iterations px at a 512 short side, scale-aware
    { frag: gaussPass(false, 'u_mode == 1 ? pow(2.0, float(u_iterations)) * min(u_resolution.x, u_resolution.y) / 512.0 : 0.0') },
    { frag: gaussPass(true, 'u_mode == 1 ? pow(2.0, float(u_iterations)) * min(u_resolution.x, u_resolution.y) / 512.0 : 0.0') },
    { frag: `void main() { fragColor = vec4(texture(u_prev, v_uv).rgb, 1.0); }` },
  ],
});

// ------------------------------------------------------------------------------------------- Color grid
const colorGrid = defineNode({
  id: 'control.colorGrid',
  name: 'Color Grid (ControlNet)',
  category: CATEGORY,
  color: CONTROL_COLOR,
  description:
    'Colour palette grid for the T2I-Adapter color model (and color ControlNets): the image at the detect resolution, downscaled by 64 and ' +
    'upscaled again with nearest neighbour, i.e. one flat colour per 64-px cell.',
  tags: ['controlnet', 't2i', 'adapter', 'color', 'colour', 'palette', 'grid', 'pixelate', 'control map', 'stable diffusion', 'preprocessor'],
  inputs: { image: { type: 'image', label: 'Image' } },
  params: {
    resolution: resolutionParam(512),
    cell: { type: 'int', default: 64, min: 4, max: 256, step: 1, label: 'Cell size', description: 'px at the detect resolution (64 = the color preprocessor).' },
  },
  passes: [
    {
      size: (c) => {
        const [w, h] = detectDims(c.width, c.height, Number(c.params.resolution) || 512);
        const k = Math.max(1, Number(c.params.cell) || 64);
        return [Math.max(1, Math.floor(w / k)), Math.max(1, Math.floor(h / k))];
      },
      filter: 'nearest',
      frag: /* glsl */ `
void main() {
  vec3 acc = vec3(0.0);
  for (int j = 0; j < 8; j++) for (int i = 0; i < 8; i++) acc += texture(u_image, v_uv + ((vec2(float(i), float(j)) + 0.5) / 8.0 - 0.5) / u_resolution).rgb;
  fragColor = vec4(acc / 64.0, 1.0);
}`,
    },
    { frag: `void main() { fragColor = vec4(texelFetch(u_prev, ivec2(v_uv * u_prev_size), 0).rgb, 1.0); }` },
  ],
});

// ----------------------------------------------------------------------------------------- Inpaint mask
const INPAINT_OUT = ['Mask (white = inpaint)', 'Masked image (black fill)', 'Masked image (transparent)', 'Masked image (grey fill)'];
const inpaintMask = defineNode({
  id: 'control.inpaintMask',
  name: 'Inpaint Mask (ControlNet)',
  category: CATEGORY,
  color: CONTROL_COLOR,
  description:
    'Formats a mask for inpainting: binary (threshold), grown by a few pixels and optionally feathered, white = the area to regenerate — what the ' +
    'ControlNet inpaint model, A1111 img2img inpaint and ComfyUI SetLatentNoiseMask expect. Can also output the image with the masked area blanked ' +
    '(black, grey, or transparent alpha for UIs that read the mask from alpha).',
  tags: ['controlnet', 'inpaint', 'mask', 'inpainting', 'control map', 'stable diffusion', 'preprocessor'],
  inputs: { image: { type: 'image', label: 'Image' }, mask: { type: 'mask', label: 'Mask' } },
  params: {
    output: { type: 'enum', default: INPAINT_OUT[0], options: INPAINT_OUT, label: 'Output' },
    threshold: { type: 'float', default: 0.5, min: 0.01, max: 0.99, step: 0.01, label: 'Threshold' },
    grow: { type: 'float', default: 8, min: 0, max: 64, step: 0.5, pixels: true, label: 'Grow', description: 'Dilates the mask (px).' },
    feather: { type: 'float', default: 0, min: 0, max: 64, step: 0.5, pixels: true, label: 'Feather' },
    invert: { type: 'bool', default: false, label: 'Invert mask' },
  },
  passes: [
    {
      frag: /* glsl */ `
float m(vec2 uv) { float v = texClamp(u_mask, uv).r; if (u_invert) v = 1.0 - v; return v > u_threshold ? 1.0 : 0.0; }
void main() {
  float r = u_grow * u_scale;
  float v = m(v_uv);
  if (r >= 0.5 && v < 0.5) {
    for (int k = 0; k < 3; k++) for (int i = 0; i < 16; i++) {
      float a = float(i) * 0.3926991 + float(k) * 0.13;
      float rr = r * (float(k) + 1.0) / 3.0;
      v = max(v, m(v_uv + vec2(cos(a), sin(a)) * rr / u_resolution));
    }
  }
  fragColor = vec4(v, 0.0, 0.0, 1.0);
}`,
    },
    { frag: gaussPass(false, 'u_feather * u_scale * 0.5') },
    { frag: gaussPass(true, 'u_feather * u_scale * 0.5') },
    {
      frag: /* glsl */ `
void main() {
  float m = clamp(texture(u_prev, v_uv).r, 0.0, 1.0);
  vec4 c = texture(u_image, v_uv);
  if (u_output == 0) fragColor = vec4(vec3(m), 1.0);
  else if (u_output == 1) fragColor = vec4(c.rgb * (1.0 - m), 1.0);
  else if (u_output == 2) fragColor = vec4(c.rgb, c.a * (1.0 - m));
  else fragColor = vec4(mix(c.rgb, vec3(0.5), m), 1.0);
}`,
    },
  ],
});

// ------------------------------------------------------------------------------------------- Sheet
const SLOTS = ['map1', 'map2', 'map3', 'map4', 'map5', 'map6'] as const;
const LABEL_W = 512, LABEL_H = 56;

/** Grid layout of the connected inputs: [connected slot indices, cols, rows]. */
function layout(inputSizes: Record<string, { width: number; height: number }>, columns: number): [number[], number, number] {
  const on = SLOTS.map((s, i) => (inputSizes[s] ? i : -1)).filter((i) => i >= 0);
  const n = Math.max(1, on.length);
  const cols = columns > 0 ? Math.min(columns, n) : n <= 3 ? n : n === 4 ? 2 : 3;
  return [on, cols, Math.ceil(n / cols)];
}

const sheet = defineNode({
  id: 'control.sheet',
  name: 'Control Sheet',
  category: CATEGORY,
  color: CONTROL_COLOR,
  description: 'Lays out up to six control maps in a labelled grid, to compare several preprocessors at once. Cells keep the aspect ratio of the first connected map.',
  tags: ['controlnet', 'sheet', 'contact sheet', 'grid', 'compare', 'preview', 'montage'],
  inputs: Object.fromEntries(SLOTS.map((s, i) => [s, { type: 'image' as const, label: `Map ${i + 1}`, optional: true }])),
  params: {
    ...Object.fromEntries(SLOTS.map((_, i) => [`label${i + 1}`, { type: 'string' as const, default: '', label: `Label ${i + 1}` }])),
    columns: { type: 'int', default: 0, min: 0, max: 6, step: 1, label: 'Columns', description: '0 = automatic.' },
    cellWidth: { type: 'int', default: 768, min: 128, max: 2048, step: 16, label: 'Cell width', description: 'Full-resolution px.' },
    gap: { type: 'int', default: 8, min: 0, max: 64, step: 1, label: 'Gap' },
    showLabels: { type: 'bool', default: true, label: 'Labels' },
  },
  size: ({ params, inputSizes }) => {
    const [on, cols, rows] = layout(inputSizes, Number(params.columns) || 0);
    const first = on.length ? inputSizes[SLOTS[on[0]]] : { width: 4, height: 3 };
    const cw = Number(params.cellWidth) || 768, gap = Number(params.gap) || 0;
    const ch = Math.round((cw * first.height) / first.width) + (params.showLabels !== false ? Math.round((cw * LABEL_H) / LABEL_W) : 0);
    return [cols * cw + (cols + 1) * gap, rows * ch + (rows + 1) * gap];
  },
  cpu: (ctx) => {
    const { canvas, g } = makeCanvas(LABEL_W, LABEL_H * SLOTS.length);
    g.clearRect(0, 0, LABEL_W, LABEL_H * SLOTS.length);
    g.font = '600 30px -apple-system, "Helvetica Neue", Arial, sans-serif';
    g.textBaseline = 'middle';
    g.fillStyle = '#fff';
    SLOTS.forEach((_, i) => {
      const t = String(ctx.params[`label${i + 1}`] ?? '') || `Map ${i + 1}`;
      g.fillText(t, 14, LABEL_H * i + LABEL_H / 2, LABEL_W - 28);
    });
    return { labels: canvas };
  },
  passes: [
    {
      uniforms: (c) => {
        const [on, cols, rows] = layout(c.inputSizes, Number(c.params.columns) || 0);
        const slot = [0, 1, 2, 3, 4, 5].map((k) => (k < on.length ? on[k] : -1));
        return { u_cols: cols, u_rows: rows, u_count: on.length, u_slot0: slot[0], u_slot1: slot[1], u_slot2: slot[2], u_slot3: slot[3], u_slot4: slot[4], u_slot5: slot[5] };
      },
      frag: /* glsl */ `
uniform int u_cols; uniform int u_rows; uniform int u_count;
uniform int u_slot0; uniform int u_slot1; uniform int u_slot2; uniform int u_slot3; uniform int u_slot4; uniform int u_slot5;
vec3 mapAt(int s, vec2 uv) {
  if (s == 0) return texture(u_map1, uv).rgb;
  if (s == 1) return texture(u_map2, uv).rgb;
  if (s == 2) return texture(u_map3, uv).rgb;
  if (s == 3) return texture(u_map4, uv).rgb;
  if (s == 4) return texture(u_map5, uv).rgb;
  return texture(u_map6, uv).rgb;
}
void main() {
  vec2 px = v_uv * u_resolution;
  float gap = float(u_gap) * u_scale;
  vec2 cell = (u_resolution - gap * (vec2(float(u_cols), float(u_rows)) + 1.0)) / vec2(float(u_cols), float(u_rows));
  vec2 q = (px - gap) / (cell + gap);
  ivec2 ci = ivec2(floor(q));
  vec2 f = (px - gap - vec2(ci) * (cell + gap)) / cell;
  vec3 bg = vec3(0.13);
  int k = ci.y * u_cols + ci.x;
  if (u_count == 0 || ci.x < 0 || ci.y < 0 || ci.x >= u_cols || ci.y >= u_rows || f.x > 1.0 || f.y > 1.0 || k >= u_count) { fragColor = vec4(bg, 1.0); return; }
  int s = k == 0 ? u_slot0 : k == 1 ? u_slot1 : k == 2 ? u_slot2 : k == 3 ? u_slot3 : k == 4 ? u_slot4 : u_slot5;
  float lh = u_showLabels ? cell.x * ${LABEL_H.toFixed(1)} / ${LABEL_W.toFixed(1)} : 0.0;
  float imgH = cell.y - lh;
  float y = f.y * cell.y;
  if (y < imgH) { fragColor = vec4(mapAt(s, vec2(f.x, y / imgH)), 1.0); return; }
  vec2 luv = vec2(f.x, (float(s) + (y - imgH) / max(lh, 1.0)) / 6.0);
  vec4 t = texture(u_labels, luv);
  fragColor = vec4(mix(vec3(0.07), vec3(1.0), t.a), 1.0);
}`,
    },
  ],
});

export default [shuffle, tile, colorGrid, inpaintMask, sheet] satisfies NodeDef[];
