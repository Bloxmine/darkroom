/**
 * Sky Mask and Sky Replace.
 *
 * Analysis (CPU, cached per image by fingerprint and shared by both nodes): a dedicated sky
 * segmentation U²-Net (SkySeg, MIT) at a short side of 320–640 px gives a soft sky probability.
 * From it we also derive
 *  - a per-row mean sky colour (sky is a vertical gradient), used for colour keying and defringing;
 *  - a horizon line y = a + b·(x − ½), fitted as the lower envelope of the contiguous top-down sky.
 *
 * Refinement (GPU, full resolution):
 *  1. joint-bilateral upsampling of the probability against the image, then threshold/softness;
 *  2. a guided filter (He et al. 2010) with the image luma as guide — this is the "matting" step: in the
 *     mixed zone around branches, wires and hair the matte follows the local luma, so sky shows
 *     through between twigs instead of being one blurry blob;
 *  3. in the transition band only, a colour key against the local sky colour;
 *  4. optional feather.
 * Defringe un-mixes edge pixels (F = (I − α·S) / (1 − α), S = local sky colour, in linear light) to remove
 * the old sky's colour cast from the foreground's edges.
 */
import '../../core/ai/models-denoise';
import { fingerprint, fitDims, InferenceMemo, resampleRGB, toCHW } from '../../core/ai/image';
import { runModel } from '../../core/ai/runtime';
import { defineNode } from '../../core/registry';
import type { NodeDef, ParamDef, Params, RawTex, ShaderPass } from '../../core/types';
import { AI_COLOR, GUIDE_FRAG, JBU_GLSL } from './_shared';
import { featherPass } from './segment-shared';

interface SkyAnalysis {
  /** Low-res sky probability (r), only regions connected to the top of the frame. */
  prob: RawTex;
  /** Low-res sky probability straight from the model. */
  probAll: RawTex;
  /** 1×h: mean sky colour per low-res row (sRGB). */
  rows: RawTex;
  /** 1×1: horizon (a, b, confidence): y = a + b·(x − ½) in uv units. */
  hz: RawTex;
}

const memo = new InferenceMemo<SkyAnalysis>(6);
const short = (p: Params) => Number(p.resolution) || 512;
const lrDims = (w: number, h: number, s: number) => fitDims(w, h, s, 32);

function fitHorizon(p: Float32Array, w: number, h: number): [number, number, number] {
  const xs: number[] = [], ys: number[] = [];
  for (let x = 0; x < w; x++) {
    if (p[x] < 0.5 && p[w + x] < 0.5) continue; // column starts with foreground (or no sky at all)
    let y = 0;
    while (y < h && p[y * w + x] >= 0.5) y++;
    xs.push((x + 0.5) / w - 0.5);
    ys.push(y / h);
  }
  const n = xs.length;
  if (n < w * 0.08) return [0.38, 0, 0];
  let a = 0, b = 0;
  let wt = new Array(n).fill(1);
  for (let it = 0; it < 6; it++) {
    let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) {
      const q = wt[i];
      sw += q;
      sx += q * xs[i];
      sy += q * ys[i];
      sxx += q * xs[i] * xs[i];
      sxy += q * xs[i] * ys[i];
    }
    const det = sw * sxx - sx * sx;
    b = det > 1e-9 ? (sw * sxy - sx * sy) / det : 0;
    b = Math.max(-0.5, Math.min(0.5, b));
    a = (sy - b * sx) / Math.max(sw, 1e-9);
    const res = ys.map((y, i) => y - (a + b * xs[i]));
    const mad = res.map(Math.abs).sort((u, v) => u - v)[Math.floor(n / 2)];
    const sig = Math.max(0.015, mad * 1.5);
    // points above the line are columns where something (a head, a tree) sticks into the sky: down-weight them
    wt = res.map((r) => (r < 0 ? Math.exp(-((r / sig) ** 2)) : Math.exp(-((r / (3 * sig)) ** 2))));
  }
  return [a, b, n / w];
}

/**
 * Keep only sky connected to the top 5 % of the frame (flood fill through p > 0.35), dilated by 3 low-res
 * px so soft edges survive. Removes reflections in water and bright patches below the horizon.
 */
function connectedSky(p: Float32Array, w: number, h: number): Float32Array {
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  const top = Math.max(1, Math.round(h * 0.05));
  for (let y = 0; y < top; y++) for (let x = 0; x < w; x++) if (p[y * w + x] > 0.5) (seen[y * w + x] = 1), stack.push(y * w + x);
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w, y = (i - x) / w;
    const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
    for (const j of nb) if (j >= 0 && !seen[j] && p[j] > 0.35) (seen[j] = 1), stack.push(j);
  }
  const R = 3;
  const tmp = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = 0;
    for (let k = Math.max(0, x - R); k <= Math.min(w - 1, x + R) && !m; k++) m = seen[y * w + k];
    tmp[y * w + x] = m;
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = 0;
    for (let k = Math.max(0, y - R); k <= Math.min(h - 1, y + R) && !m; k++) m = tmp[k * w + x];
    out[y * w + x] = m ? p[y * w + x] : 0;
  }
  return out;
}

const rgbaOf = (v: Float32Array, w: number, h: number): RawTex => {
  const d = new Float32Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v[i];
    d[i * 4 + 3] = 1;
  }
  return { width: w, height: h, data: d };
};

function analyse(rgb: Float32Array, raw: Float32Array, w: number, h: number): SkyAnalysis {
  const p = connectedSky(raw, w, h);
  // per-row sky colour (confident sky only), gaps filled from the nearest row with sky
  const rows = new Float32Array(h * 4);
  const has = new Array<boolean>(h).fill(false);
  for (let y = 0; y < h; y++) {
    let r = 0, g = 0, bl = 0, ws = 0;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (p[i] < 0.6) continue;
      const q = p[i] ** 4;
      r += rgb[i * 3] * q;
      g += rgb[i * 3 + 1] * q;
      bl += rgb[i * 3 + 2] * q;
      ws += q;
    }
    if (ws > 0.5) {
      rows.set([r / ws, g / ws, bl / ws, 1], y * 4);
      has[y] = true;
    }
  }
  const first = has.indexOf(true);
  if (first < 0) for (let y = 0; y < h; y++) rows.set([0.62, 0.74, 0.88, 1], y * 4);
  else {
    for (let y = 0; y < h; y++) {
      if (has[y]) continue;
      let k = y;
      while (k >= 0 && !has[k]) k--;
      if (k < 0) k = first;
      rows.set(rows.subarray(k * 4, k * 4 + 4), y * 4);
    }
  }
  const [a, b, c] = fitHorizon(p, w, h);
  return {
    prob: rgbaOf(p, w, h),
    probAll: rgbaOf(raw, w, h),
    rows: { width: 1, height: h, data: rows },
    hz: { width: 1, height: 1, data: new Float32Array([a, b, c, 1]), filter: 'nearest' },
  };
}

async function skyCpu(src: RawTex | null, params: Params): Promise<Record<string, RawTex>> {
  if (!src) {
    const one = (v: number[]) => ({ width: 1, height: 1, data: new Float32Array(v) });
    return { skyp: one([0, 0, 0, 1]), skyrow: one([0.62, 0.74, 0.88, 1]), hz: one([0.38, 0, 0, 1]) };
  }
  const s = short(params);
  const [w, h] = lrDims(src.width, src.height, s);
  const rgb = resampleRGB(src.data, src.width, src.height, w, h);
  const A = await memo.get(`skyseg:${s}`, fingerprint(rgb, w, h), Math.min(src.width, src.height), s, async () => {
    const r = await runModel('skyseg', { data: toCHW(rgb, w, h, [0.485, 0.456, 0.406], [0.229, 0.224, 0.225]), dims: [1, 3, h, w] });
    const [oh, ow] = r.dims.slice(-2);
    return analyse(oh === h && ow === w ? rgb : resampleRGB(rgb, w, h, ow, oh, 3), r.data, ow, oh);
  });
  return { skyp: params.connected === false ? A.probAll : A.prob, skyrow: A.rows, hz: A.hz };
}

// ---------------------------------------------------------------------------------------------
// shared GLSL + passes
// ---------------------------------------------------------------------------------------------

/** Local sky colour around uv (from the low-res guide u_pass0 weighted by sky probability), else the row mean. */
const SKYCOL_GLSL = /* glsl */ `
vec3 skyCol(vec2 uv) {
  vec3 acc = vec3(0.0); float ws = 0.0;
  for (int j = -3; j <= 3; j++) for (int i = -3; i <= 3; i++) {
    vec2 q = uv + vec2(float(i), float(j)) * 1.5 / u_skyp_size;
    float p = texClamp(u_skyp, q).r;
    p = p * p * p * p;
    acc += texClamp(u_pass0, q).rgb * p; ws += p;
  }
  vec3 row = texture(u_skyrow, vec2(0.5, uv.y)).rgb;
  return ws > 1e-3 ? mix(row, acc / ws, clamp(ws / 2.0, 0.0, 1.0)) : row;
}
float horizonY(float x) {
  vec4 h = texelFetch(u_hz, ivec2(0), 0);
  return h.x + h.y * (x - 0.5);
}`;

function boxPass(vertical: boolean): ShaderPass {
  return {
    frag: /* glsl */ `
void main() {
  float r = max(1.0, u_radius * u_scale);
  int n = int(min(ceil(r), 32.0));
  float stp = r / float(n);
  vec2 dir = ${vertical ? 'vec2(0.0, 1.0)' : 'vec2(1.0, 0.0)'} / u_resolution;
  vec4 acc = vec4(0.0);
  for (int i = -32; i <= 32; i++) {
    if (i < -n || i > n) continue;
    acc += texClamp(u_prev, v_uv + dir * float(i) * stp);
  }
  fragColor = acc / float(2 * n + 1);
}`,
  };
}

/** Passes 0–9: guide, upsample + threshold, guided filter, colour key, feather. Pass 9 = α (sky = 1, not inverted). */
function maskPasses(): ShaderPass[] {
  return [
    { size: (c) => lrDims(c.width, c.height, short(c.params)), frag: GUIDE_FRAG },
    {
      frag: /* glsl */ `
${JBU_GLSL}
void main() {
  float m = jbu(u_skyp, u_skyp_size, u_pass0, 0.9, 0.1);
  float lo = max(u_threshold - u_softness * 0.5, 0.0), hi = min(u_threshold + u_softness * 0.5, 1.0);
  m = clamp((m - lo) / max(hi - lo, 1e-3), 0.0, 1.0);
  float I = luma601(clamp(texture(u_image, v_uv).rgb, 0.0, 1.0));
  fragColor = vec4(I, m, I * m, I * I);
}`,
    },
    boxPass(false),
    boxPass(true),
    {
      frag: /* glsl */ `
void main() {
  vec4 m = texture(u_prev, v_uv); // mean I, p, Ip, II
  float varI = max(m.w - m.x * m.x, 0.0);
  float cov = m.z - m.x * m.y;
  float a = cov / (varI + u_eps);
  fragColor = vec4(a, m.y - a * m.x, m.y, varI);
}`,
    },
    boxPass(false),
    boxPass(true),
    {
      frag: /* glsl */ `
${SKYCOL_GLSL}
void main() {
  vec4 ab = texture(u_prev, v_uv);
  vec4 g = texture(u_pass1, v_uv);
  float q = clamp(ab.x * g.x + ab.y, 0.0, 1.0);
  float a = mix(g.y, q, u_refine);
  // colour key in the transition band (wide blurred mask neither 0 nor 1)
  float band = clamp(4.0 * ab.z * (1.0 - ab.z), 0.0, 1.0);
  vec3 c = clamp(texture(u_image, v_uv).rgb, 0.0, 1.0);
  float d = distance(c, skyCol(v_uv));
  float key = 1.0 - smoothstep(0.05, 0.2, d);
  a = mix(a, key, u_colorKey * band);
  // sky the network missed: very close to the row's sky colour, flat (low local variance) and above the horizon
  float dr = distance(c, texture(u_skyrow, vec2(0.5, v_uv.y)).rgb);
  float flat_ = 1.0 - smoothstep(0.0003, 0.0015, ab.w);
  float above = smoothstep(0.02, -0.04, v_uv.y - horizonY(v_uv.x));
  a = max(a, (1.0 - smoothstep(0.05, 0.14, dr)) * flat_ * above * u_colorKey * 2.0);
  fragColor = vec4(vec3(a), 1.0);
}`,
    },
    { frag: featherPass(false) },
    { frag: featherPass(true, false) },
  ];
}

/** Edge un-mixing (linear light): remove the old sky colour from partially-covered foreground pixels. */
const DEFRINGE_GLSL = /* glsl */ `
vec3 defringe(vec3 I, vec3 S, float a, float amount) {
  float band = smoothstep(0.0, 0.06, a) * (1.0 - smoothstep(0.9, 1.0, a));
  vec3 F = clamp((I - a * S) / max(1.0 - a, 0.15), 0.0, 1.5);
  return mix(I, F, amount * band);
}`;

const maskParams = (): Record<string, ParamDef> => ({
  resolution: {
    type: 'enum',
    default: '512',
    options: ['320', '384', '512', '640'],
    label: 'Inference size',
    description: 'Short side fed to the sky model (trained at 320). 512 finds smaller sky gaps; 320 is fastest.',
  },
  threshold: { type: 'float', default: 0.5, min: 0.01, max: 0.99, step: 0.005, label: 'Threshold' },
  softness: { type: 'float', default: 0.4, min: 0, max: 1, step: 0.005, label: 'Softness', description: 'Width of the soft zone around the threshold (before refinement).' },
  refine: { type: 'float', default: 1, min: 0, max: 1, step: 0.01, label: 'Refine (matting)', description: 'Guided-filter matting against the image: separates sky from branches, wires and hair. 0 = plain upsampled mask.' },
  radius: { type: 'float', default: 10, min: 1, max: 60, step: 0.5, pixels: true, label: 'Refine radius', description: 'Guided-filter window (px). Larger reaches further into fine structures but can leak into flat foreground.' },
  eps: { type: 'float', default: 0.003, min: 0.0001, max: 0.05, step: 0.0001, label: 'Refine edge tolerance', description: 'Guided-filter ε: smaller follows image edges more tightly, larger is smoother.' },
  connected: { type: 'bool', default: true, label: 'Only sky touching the top', description: 'Drop sky-like regions not connected to the sky at the top of the frame (reflections in water, bright walls).' },
  colorKey: { type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, label: 'Colour key', description: 'In the edge band, pull the matte towards a key on the local sky colour.' },
  feather: { type: 'float', default: 0, min: 0, max: 100, step: 0.5, pixels: true, label: 'Feather' },
});

// ---------------------------------------------------------------------------------------------
// Sky Mask
// ---------------------------------------------------------------------------------------------

const skyMask = defineNode({
  id: 'ai.skyMask',
  name: 'Sky Mask',
  category: 'AI',
  color: AI_COLOR,
  description:
    'A high-quality sky selection: a dedicated sky segmentation network (SkySeg U²-Net, MIT, ~88 MB, downloads once, runs locally) plus guided-filter matting against the image, so sky shows through tree branches, wires and hair. ' +
    'Outputs: “mask” (sky = white); “horizon” — a soft gradient from a fitted horizon line (white above), ready for graduated ND/colour filters; “image” — the input with the old sky’s colour fringe removed from foreground edges (defringe). ' +
    'Inference is cached per image, so tweaking is instant.',
  tags: ['sky', 'sky mask', 'sky selection', 'sky replacement', 'horizon', 'graduated filter', 'segmentation', 'matting', 'trees', 'ai', 'ml', 'mask'],
  inputs: { image: { type: 'image', label: 'Image' } },
  outputs: { mask: { type: 'mask', label: 'Mask' }, horizon: { type: 'mask', label: 'Horizon' }, image: { type: 'image', label: 'Defringed image' } },
  params: {
    ...maskParams(),
    defringe: { type: 'float', default: 0.8, min: 0, max: 1, step: 0.01, label: 'Defringe', description: 'Remove the sky’s colour cast from foreground edges (“image” output).' },
    horizonSoftness: { type: 'float', default: 0.3, min: 0.01, max: 1, step: 0.01, label: 'Horizon softness', description: 'Height of the horizon gradient’s transition, as a fraction of the image.' },
    horizonOffset: { type: 'float', default: 0, min: -0.5, max: 0.5, step: 0.005, label: 'Horizon offset', description: 'Move the horizon gradient up (−) or down (+).' },
    invert: { type: 'bool', default: false, label: 'Invert (select foreground)' },
  },
  cpuReadsInputs: true,
  cpu: (ctx) => skyCpu(ctx.readInput('image'), ctx.params),
  passes: [
    ...maskPasses(),
    {
      output: 'mask',
      frag: /* glsl */ `
void main() {
  float a = texture(u_pass9, v_uv).r;
  fragColor = vec4(vec3(u_invert ? 1.0 - a : a), 1.0);
}`,
    },
    {
      output: 'horizon',
      frag: /* glsl */ `
${SKYCOL_GLSL}
void main() {
  float y = horizonY(v_uv.x) + u_horizonOffset;
  float s = max(u_horizonSoftness, 1e-3);
  fragColor = vec4(vec3(smoothstep(y + 0.5 * s, y - 0.5 * s, v_uv.y)), 1.0);
}`,
    },
    {
      output: 'image',
      frag: /* glsl */ `
${SKYCOL_GLSL}
${DEFRINGE_GLSL}
void main() {
  vec4 o = texture(u_image, v_uv);
  float a = texture(u_pass9, v_uv).r;
  vec3 I = srgbToLinear(clamp(o.rgb, 0.0, 1.0));
  vec3 S = srgbToLinear(skyCol(v_uv));
  fragColor = vec4(linearToSrgb(defringe(I, S, a, u_defringe)), o.a);
}`,
    },
  ],
});

// ---------------------------------------------------------------------------------------------
// Sky Replace
// ---------------------------------------------------------------------------------------------

const PRESETS = ['Sunset', 'Blue day', 'Overcast', 'Night', 'Stormy'];
const FITS = ['Fill above horizon', 'Fill frame', 'Stretch above horizon'];

/** Procedural sky: gradient presets + perspective fbm clouds. */
const PROC_GLSL = /* glsl */ `
vec3 procSky(vec2 uv, float yh) {
  float t = clamp(uv.y / max(yh, 0.05), 0.0, 1.0);
  vec3 top, mid, hor, lit, dark, sunC;
  float cover, darkK, sunK;
  if (u_skyPreset == 0) { top = vec3(0.09, 0.10, 0.28); mid = vec3(0.55, 0.30, 0.45); hor = vec3(1.0, 0.60, 0.28); lit = vec3(1.0, 0.62, 0.38); dark = vec3(0.32, 0.17, 0.27); sunC = vec3(1.0, 0.75, 0.4); cover = 0.45; darkK = 0.75; sunK = 1.0; }
  else if (u_skyPreset == 1) { top = vec3(0.10, 0.28, 0.66); mid = vec3(0.30, 0.54, 0.86); hor = vec3(0.70, 0.83, 0.96); lit = vec3(1.0); dark = vec3(0.68, 0.73, 0.80); sunC = vec3(1.0, 0.98, 0.9); cover = 0.32; darkK = 0.4; sunK = 0.35; }
  else if (u_skyPreset == 2) { top = vec3(0.58, 0.61, 0.65); mid = vec3(0.70, 0.72, 0.75); hor = vec3(0.83, 0.84, 0.86); lit = vec3(0.86, 0.87, 0.89); dark = vec3(0.48, 0.50, 0.54); sunC = vec3(1.0); cover = 0.85; darkK = 0.6; sunK = 0.0; }
  else if (u_skyPreset == 3) { top = vec3(0.004, 0.008, 0.03); mid = vec3(0.015, 0.03, 0.075); hor = vec3(0.07, 0.09, 0.17); lit = vec3(0.13, 0.14, 0.2); dark = vec3(0.015, 0.02, 0.035); sunC = vec3(0.9, 0.92, 1.0); cover = 0.28; darkK = 0.5; sunK = 0.0; }
  else { top = vec3(0.13, 0.15, 0.19); mid = vec3(0.25, 0.27, 0.31); hor = vec3(0.50, 0.51, 0.51); lit = vec3(0.56, 0.57, 0.6); dark = vec3(0.08, 0.09, 0.11); sunC = vec3(1.0); cover = 0.78; darkK = 1.0; sunK = 0.0; }
  vec3 col = mix(top, mid, smoothstep(0.0, 0.65, t));
  col = mix(col, hor, smoothstep(0.45, 1.0, t));
  float asp = u_resolution.x / u_resolution.y;
  // sun / glow just above the horizon
  vec2 sp = vec2(u_sunX, yh - 0.04);
  vec2 dv = (uv - sp) * vec2(asp, 1.0);
  float dist = length(dv);
  col += sunC * sunK * (0.55 * exp(-dist * 5.0) + 0.6 * exp(-dist * 40.0) + smoothstep(0.022, 0.016, dist));
  // clouds on a plane above the camera: perspective squeezes them towards the horizon
  float h = max(yh - uv.y, 0.0);
  float depth = 1.0 / (h + 0.22);
  vec2 cp = vec2((uv.x - 0.5) * asp * depth, depth * 1.3) * 1.7 + vec2(float(u_seed) * 7.31, float(u_seed) * 3.17);
  // domain warp → billowy shapes instead of plain value-noise blobs
  vec2 wv = vec2(fbm(cp * 0.7 + 3.1, 4), fbm(cp * 0.7 + 7.7, 4)) - 0.5;
  float n = fbm(cp + wv * 1.8, 6);
  float cov = clamp(cover + (u_clouds - 0.5), 0.0, 1.0);
  float thr = mix(0.66, 0.34, cov);
  float c = smoothstep(thr - 0.04, thr + 0.16, n);
  float dense = smoothstep(thr, thr + 0.45, fbm(cp * 0.5 + wv, 5) * 0.5 + n * 0.5);
  vec3 cloud = mix(lit, dark, dense * darkK);
  // clouds near the sun are lit
  cloud += sunC * sunK * 0.35 * exp(-dist * 4.0);
  c *= mix(1.0, 0.55, smoothstep(0.8, 1.0, t));
  col = mix(col, cloud, c);
  if (u_skyPreset == 3) {
    vec2 px = floor(uv * u_resolution / 1.5);
    float st = step(0.996, hash12(px + float(u_seed))) * hash12(px * 1.7 + 3.0);
    col += vec3(st) * (1.0 - c) * (1.0 - t * 0.7);
  }
  return col;
}`;

const skyReplace = defineNode({
  id: 'ai.skyReplace',
  name: 'Sky Replace',
  category: 'AI',
  color: AI_COLOR,
  description:
    'Replaces the sky using the AI Sky Mask analysis (SkySeg + guided-filter matting; cached and shared with Sky Mask). ' +
    'Connect any image to “sky” (a photo, a gradient…) or leave it empty for a procedural sky: sunset, blue day, overcast, night or stormy, with fbm clouds in perspective. ' +
    'The foreground is colour-matched towards the new sky (relight), edges are defringed and lit by the new sky, and a horizon blend adds atmospheric haze where land meets sky.',
  tags: ['sky', 'sky replacement', 'replace sky', 'sunset', 'clouds', 'dramatic sky', 'stormy', 'relight', 'composite', 'ai', 'ml'],
  inputs: { image: { type: 'image', label: 'Image' }, sky: { type: 'image', label: 'Sky', optional: true } },
  params: {
    skyPreset: { type: 'enum', default: PRESETS[0], options: PRESETS, label: 'Procedural sky', description: 'Used when nothing is connected to “sky”.' },
    clouds: { type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Clouds', description: 'Cloud cover of the procedural sky (0.5 = the preset’s own).' },
    sunX: { type: 'float', default: 0.62, min: -0.2, max: 1.2, step: 0.01, label: 'Sun position', description: 'Horizontal position of the sun/glow (procedural sky).' },
    seed: { type: 'int', default: 3, min: 0, max: 9999, step: 1, label: 'Cloud seed' },
    skyFit: { type: 'enum', default: FITS[0], options: FITS, label: 'Sky fit', description: 'How a connected sky image is placed: cover the area above the horizon (its bottom on the horizon), cover the whole frame, or stretch.' },
    skyScale: { type: 'float', default: 1, min: 0.5, max: 4, step: 0.01, label: 'Sky scale' },
    skyOffset: { type: 'vec2', default: [0, 0], min: -1, max: 1, step: 0.005, label: 'Sky offset' },
    skyBlur: { type: 'float', default: 0, min: 0, max: 60, step: 0.5, pixels: true, label: 'Sky blur', description: 'Defocus the new sky to match a shallow depth of field.' },
    relight: { type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Foreground relight', description: 'Colour-match the foreground towards the new sky’s average colour and brightness.' },
    edgeLight: { type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, label: 'Edge lighting', description: 'Wrap a little of the new sky’s light around foreground edges.' },
    defringe: { type: 'float', default: 0.8, min: 0, max: 1, step: 0.01, label: 'Defringe', description: 'Remove the old sky’s colour from foreground edges.' },
    horizonBlend: { type: 'float', default: 0.2, min: 0, max: 1, step: 0.01, label: 'Horizon blend', description: 'Atmospheric haze in the new sky’s horizon colour just below the horizon.' },
    ...maskParams(),
    showMask: { type: 'bool', default: false, label: 'Show mask' },
  },
  cpuReadsInputs: true,
  cpu: (ctx) => skyCpu(ctx.readInput('image'), ctx.params),
  passes: [
    ...maskPasses(),
    // 10: new sky layer
    {
      frag: /* glsl */ `
${SKYCOL_GLSL}
${PROC_GLSL}
void main() {
  float yh = horizonY(v_uv.x);
  if (u_sky_size.x < 1.5 && u_sky_size.y < 1.5) { fragColor = vec4(procSky(v_uv, yh), 1.0); return; }
  // lowest horizon point across the frame = bottom of the sky area
  float top = clamp(max(horizonY(0.0), horizonY(1.0)) + 0.02, 0.1, 1.0);
  vec2 uvs;
  if (u_skyFit == 2) uvs = vec2(v_uv.x, v_uv.y / top);
  else {
    float rh = (u_skyFit == 1 ? 1.0 : top) * u_resolution.y;
    float s = max(u_resolution.x / u_sky_size.x, rh / u_sky_size.y) * u_skyScale;
    vec2 D = u_sky_size * s;
    vec2 o = vec2((u_resolution.x - D.x) * 0.5, rh - D.y) + u_skyOffset * u_resolution;
    uvs = (v_uv * u_resolution - o) / D;
  }
  if (u_skyFit == 2) uvs = (uvs - 0.5) / u_skyScale + 0.5 - u_skyOffset;
  fragColor = vec4(texClamp(u_sky, uvs).rgb, 1.0);
}`,
    },
    // 11, 12: sky blur
    { frag: blurRgb(false) },
    { frag: blurRgb(true) },
    // 13: new sky stats (Σ linear sky·α, Σα) on a 16×16 grid
    { size: () => [16, 16], frag: statsFrag('srgbToLinear(clamp(texture(u_pass12, q).rgb, 0.0, 1.0))') },
    // 14: old sky stats
    { size: () => [16, 16], frag: statsFrag('srgbToLinear(clamp(texture(u_image, q).rgb, 0.0, 1.0))') },
    // 15: (0,0) = mean new sky, (1,0) = mean old sky (linear)
    {
      size: () => [2, 1],
      frag: /* glsl */ `
void main() {
  int k = int(floor(v_uv.x * 2.0));
  vec4 acc = vec4(0.0);
  for (int j = 0; j < 16; j++) for (int i = 0; i < 16; i++) acc += k == 0 ? texelFetch(u_pass13, ivec2(i, j), 0) : texelFetch(u_pass14, ivec2(i, j), 0);
  fragColor = vec4(acc.a > 1e-3 ? acc.rgb / acc.a : vec3(k == 0 ? 0.4 : 0.5), 1.0);
}`,
    },
    // 16: composite
    {
      frag: /* glsl */ `
${SKYCOL_GLSL}
${DEFRINGE_GLSL}
void main() {
  vec4 o = texture(u_image, v_uv);
  float a = texture(u_pass9, v_uv).r;
  if (u_showMask) { fragColor = vec4(vec3(a), 1.0); return; }
  vec3 I = srgbToLinear(clamp(o.rgb, 0.0, 1.0));
  vec3 Sn = srgbToLinear(clamp(texture(u_pass12, v_uv).rgb, 0.0, 1.5));
  vec3 F = defringe(I, srgbToLinear(skyCol(v_uv)), a, u_defringe);
  // relight: move the foreground's colour balance and level towards the new sky's
  vec3 nA = texelFetch(u_pass15, ivec2(0, 0), 0).rgb, oA = texelFetch(u_pass15, ivec2(1, 0), 0).rgb;
  float ln = luma(nA) + 0.01, lo = luma(oA) + 0.01;
  vec3 tint = ((nA + 0.01) / ln) / ((oA + 0.01) / lo);
  tint = clamp(tint, 0.3, 3.0);
  float gain = clamp(pow(ln / lo, 0.5), 0.35, 1.6);
  F *= mix(vec3(1.0), pow(tint, vec3(0.6)) * gain, u_relight);
  // edge lighting: the new sky's light wraps around the silhouette (wide blurred mask, foreground side)
  float mp = texture(u_pass6, v_uv).z;
  float halo = smoothstep(0.0, 0.6, mp) * (1.0 - a);
  F = mix(F, 1.0 - (1.0 - F) * (1.0 - Sn * 0.8), u_edgeLight * halo);
  // horizon haze below the horizon line
  float d = v_uv.y - horizonY(v_uv.x);
  // only distant land: pixels with sky a short way above them (not a subject in front of the horizon)
  float near = 0.0, nw = 0.0;
  for (int k = 1; k <= 12; k++) { float w = 1.0 - float(k) / 13.0; near += texClamp(u_skyp, v_uv - vec2(0.0, float(k) * 0.006)).r * w; nw += w; }
  near = smoothstep(0.0, 0.5, near / nw);
  float hb = u_horizonBlend * exp(-max(d, 0.0) / 0.05) * smoothstep(-0.03, 0.0, d) * 0.6 * near;
  vec3 hzC = srgbToLinear(clamp(texture(u_pass12, vec2(v_uv.x, clamp(horizonY(v_uv.x) - 0.01, 0.0, 1.0))).rgb, 0.0, 1.5));
  F = mix(F, hzC, hb * (1.0 - a));
  vec3 c = mix(F, Sn, a);
  fragColor = vec4(linearToSrgb(max(c, 0.0)), o.a);
}`,
    },
  ],
});

function statsFrag(sample: string) {
  return /* glsl */ `
void main() {
  vec4 acc = vec4(0.0);
  for (int j = 0; j < 8; j++) for (int i = 0; i < 8; i++) {
    vec2 q = (floor(v_uv * 16.0) + (vec2(float(i), float(j)) + 0.5) / 8.0) / 16.0;
    float a = texture(u_pass9, q).r;
    acc += vec4(${sample} * a, a);
  }
  fragColor = acc;
}`;
}

function blurRgb(vertical: boolean) {
  return /* glsl */ `
void main() {
  float r = u_skyBlur * u_scale;
  if (r < 0.5) { fragColor = texture(u_prev, v_uv); return; }
  int n = int(min(ceil(r), 48.0));
  float stp = r / float(n), sig = r * 0.5;
  vec2 dir = ${vertical ? 'vec2(0.0, 1.0)' : 'vec2(1.0, 0.0)'} / u_resolution;
  vec4 acc = vec4(0.0); float ws = 0.0;
  for (int i = -48; i <= 48; i++) {
    if (i < -n || i > n) continue;
    float x = float(i) * stp;
    float w = exp(-x * x / (2.0 * sig * sig));
    acc += texClamp(u_prev, v_uv + dir * x) * w; ws += w;
  }
  fragColor = acc / ws;
}`;
}

export default [skyMask, skyReplace] satisfies NodeDef[];
