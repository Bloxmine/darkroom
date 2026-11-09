/**
 * Smart Sharpen (edge-masked unsharp mask / Richardson–Lucy deconvolution) and Texture (Lightroom-style
 * mid-frequency contrast).
 */
import { defineNode } from '../../core/registry';
import type { NodeDef, ShaderPass } from '../../core/types';

const C = '#7a9a4a';

/**
 * One 1-D gaussian pass. `src` is a sampler name, `sigma` a GLSL expression in CURRENT-resolution
 * pixels, `value` maps a sample to what is blurred (default the rgba). Up to 2×24+1 taps; wider
 * kernels step over texels (still a smooth gaussian thanks to bilinear sampling).
 */
export function gauss(dir: 'h' | 'v', src: string, sigma: string, value = 's'): string {
  return /* glsl */ `
void main() {
  float sigma = max(${sigma}, 0.3);
  vec2 d = ${dir === 'h' ? 'vec2(1.0, 0.0)' : 'vec2(0.0, 1.0)'} / u_resolution;
  float stepPx = max(1.0, 3.0 * sigma / 24.0);
  vec4 acc = vec4(0.0); float ws = 0.0;
  for (int i = -24; i <= 24; i++) {
    float x = float(i) * stepPx;
    if (abs(x) > 3.0 * sigma + 0.5) continue;
    float w = exp(-0.5 * x * x / (sigma * sigma));
    vec4 s = texture(${src}, v_uv + d * x);
    acc += (${value}) * w; ws += w;
  }
  fragColor = acc / ws;
}`;
}

// ---------------------------------------------------------------------------
// Smart Sharpen
// ---------------------------------------------------------------------------
const RL_ITERS = 12;

function sharpenPasses(): ShaderPass[] {
  const p: ShaderPass[] = [];
  const sig = 'u_radius * u_scale';
  // 0,1: gaussian of the image (unsharp mask base / the blurred observation model)
  p.push({ frag: gauss('h', 'u_image', sig) }, { frag: gauss('v', 'u_prev', sig) });
  // 2,3: wider luma blur for the edge mask (gradient of a denoised image)
  p.push({ frag: gauss('h', 'u_image', `max(${sig}, 1.0) * 1.5`, 'vec4(vec3(luma(s.rgb)), 1.0)') }, { frag: gauss('v', 'u_prev', `max(${sig}, 1.0) * 1.5`) });
  // Richardson–Lucy, each iteration t (estimate E_t; E_0 = observation):
  //   B = K ⊗ E_t ;  C = K ⊗ (obs / B) ;  E_{t+1} = E_t · C      (Richardson 1972, Lucy 1974; K symmetric)
  // done in linear light, 4 separable passes per iteration; iterations beyond u_iterations pass E through.
  let est = -1; // -1 = the input image itself
  const estTex = (i: number) => (i < 0 ? 'u_image' : `u_pass${i}`);
  const lin = (t: string) => `vec4(srgbToLinear(max(texture(${t}, uv).rgb, 0.0)), 1.0)`;
  for (let t = 0; t < RL_ITERS; t++) {
    const E = estTex(est);
    const base = p.length;
    // H(E)
    p.push({ frag: gauss('h', E, sig, est < 0 ? 'vec4(srgbToLinear(max(s.rgb, 0.0)), 1.0)' : 's') });
    // V → B
    p.push({ frag: gauss('v', `u_pass${base}`, sig) });
    // H(obs / B)
    p.push({
      frag: /* glsl */ `
void main() {
  float sigma = max(${sig}, 0.3);
  vec2 d = vec2(1.0, 0.0) / u_resolution;
  float stepPx = max(1.0, 3.0 * sigma / 24.0);
  vec4 acc = vec4(0.0); float ws = 0.0;
  for (int i = -24; i <= 24; i++) {
    float x = float(i) * stepPx;
    if (abs(x) > 3.0 * sigma + 0.5) continue;
    float w = exp(-0.5 * x * x / (sigma * sigma));
    vec2 uv = v_uv + d * x;
    vec4 o = ${lin('u_image')};
    vec4 b = texture(u_pass${base + 1}, uv);
    acc += vec4(o.rgb / max(b.rgb, 1e-4), 1.0) * w; ws += w;
  }
  fragColor = acc / ws;
}`,
    });
    // V → C ; update E
    p.push({
      frag: /* glsl */ `
void main() {
  vec2 uv = v_uv;
  vec4 e = ${est < 0 ? lin('u_image') : `texture(${E}, uv)`};
  if (${t} >= u_iterations || u_mode == 0) { fragColor = e; return; }
  float sigma = max(${sig}, 0.3);
  vec2 d = vec2(0.0, 1.0) / u_resolution;
  float stepPx = max(1.0, 3.0 * sigma / 24.0);
  vec4 acc = vec4(0.0); float ws = 0.0;
  for (int i = -24; i <= 24; i++) {
    float x = float(i) * stepPx;
    if (abs(x) > 3.0 * sigma + 0.5) continue;
    float w = exp(-0.5 * x * x / (sigma * sigma));
    acc += texture(u_pass${base + 2}, v_uv + d * x) * w; ws += w;
  }
  vec3 c = acc.rgb / ws;
  // damping: limit each multiplicative step to avoid ringing / noise blow-up
  c = clamp(c, 1.0 - u_damping, 1.0 + u_damping);
  fragColor = vec4(max(e.rgb * c, 0.0), 1.0);
}`,
    });
    est = base + 3;
  }
  // in plain sharpen mode the deconvolution passes are skipped (and in lens-blur mode, iterations past
  // u_iterations): early-out before the blur loops
  for (let i = 4; i < p.length; i++) {
    const it = Math.floor((i - 4) / 4);
    const f = p[i].frag as string;
    if ((i - 4) % 4 !== 3) p[i] = { ...p[i], frag: f.replace('void main() {', `void main() {\n  if (u_mode == 0 || ${it} >= u_iterations) { fragColor = vec4(1.0); return; }`) };
  }
  const blurIdx = 1, edgeIdx = 3;
  p.push({
    frag: /* glsl */ `
void main() {
  vec4 c = texture(u_image, v_uv);
  vec2 px = 1.0 / u_resolution;
  // edge mask: gradient magnitude of the smoothed luma (Masking slider: 0 = sharpen everything)
  float gx = texture(u_pass${edgeIdx}, v_uv + vec2(px.x, 0.0)).r - texture(u_pass${edgeIdx}, v_uv - vec2(px.x, 0.0)).r;
  float gy = texture(u_pass${edgeIdx}, v_uv + vec2(0.0, px.y)).r - texture(u_pass${edgeIdx}, v_uv - vec2(0.0, px.y)).r;
  float g = length(vec2(gx, gy)) / max(u_scale, 0.05) * 0.5; // per full-res pixel
  float mask = mix(1.0, smoothstep(0.004, 0.004 + 0.06 * u_masking, g), step(0.001, u_masking));
  vec3 o;
  if (u_mode == 0) {
    // unsharp mask on luminance with a soft threshold
    float d = luma(c.rgb) - luma(texture(u_pass${blurIdx}, v_uv).rgb);
    float th = u_threshold / 255.0;
    d *= smoothstep(th, th * 2.0 + 1e-4, abs(d));
    o = c.rgb + vec3(d) * u_amount * mask;
  } else {
    vec3 dec = linearToSrgb(texture(u_prev, v_uv).rgb);
    o = c.rgb + (dec - c.rgb) * u_amount * mask;
  }
  // Detail (halo control): clamp overshoot to the local 3×3 range, expanded by detail
  vec3 mn = c.rgb, mx = c.rgb;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec3 s = texture(u_image, v_uv + vec2(float(x), float(y)) * px).rgb;
    mn = min(mn, s); mx = max(mx, s);
  }
  float slack = 0.02 + 0.5 * u_detail;
  vec3 lo = mn - (mx - mn) * slack - 0.01 * u_detail, hi = mx + (mx - mn) * slack + 0.01 * u_detail;
  o = mix(clamp(o, lo, hi), o, u_detail * u_detail);
  fragColor = vec4(o, c.a);
}`,
  });
  return p;
}

const smartSharpen = defineNode({
  id: 'pro.smartSharpen',
  name: 'Smart Sharpen',
  category: 'Photo',
  color: C,
  description:
    'Capture / output sharpening that leaves flat areas and noise alone. Sharpen mode is an unsharp mask on luminance with a threshold and an edge mask ' +
    '(Masking: 0 = everywhere, 1 = only strong edges). Lens blur removal mode deconvolves a gaussian blur of the given Radius with Richardson–Lucy iterations ' +
    '(in linear light, damped) — it recovers real detail from slightly soft or mis-focused shots. Detail controls halos: low values clamp overshoot to the local range.',
  tags: ['sharpen', 'unsharp mask', 'usm', 'deconvolution', 'richardson lucy', 'deblur', 'lens blur', 'capture sharpening', 'detail', 'masking'],
  inputs: { image: { type: 'image' } },
  params: {
    mode: { type: 'enum', default: 'sharpen', options: ['sharpen', 'lens blur removal'], label: 'Mode' },
    amount: { type: 'float', default: 1.2, min: 0, max: 4, step: 0.01, label: 'Amount' },
    radius: { type: 'float', default: 1.2, min: 0.3, max: 8, step: 0.05, pixels: true, label: 'Radius', description: 'Unsharp-mask radius, or the σ of the blur to remove (full-res px).' },
    threshold: { type: 'float', default: 2, min: 0, max: 40, step: 0.5, label: 'Threshold (levels)', description: 'Sharpen mode: ignore luminance differences smaller than this (0–255 levels).' },
    masking: { type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, label: 'Masking', description: 'Restrict sharpening to edges (protects skies, skin and noise).' },
    detail: { type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, label: 'Detail', description: 'Halo control: 0 clamps overshoot to the local range, 1 lets it through.' },
    iterations: { type: 'int', default: 8, min: 1, max: RL_ITERS, step: 1, label: 'Iterations', description: 'Lens blur removal: Richardson–Lucy iterations.' },
    damping: { type: 'float', default: 0.35, min: 0.05, max: 1, step: 0.01, label: 'Damping', description: 'Lens blur removal: max change per iteration (lower = fewer artefacts).' },
  },
  passes: sharpenPasses(),
});

// ---------------------------------------------------------------------------
// Texture
// ---------------------------------------------------------------------------
const texture = defineNode({
  id: 'pro.texture',
  name: 'Texture',
  category: 'Photo',
  color: C,
  description:
    'Lightroom-style Texture: boosts or smooths medium-fine detail (skin pores, foliage, fabric, rock) — a luminance band-pass between ~1.5 and ~6 px — ' +
    'without touching fine noise much or large-scale contrast (that is Clarity). Negative values smooth skin while edges stay crisp (strong edges are excluded).',
  tags: ['texture', 'detail', 'band pass', 'skin smoothing', 'micro contrast', 'lightroom', 'structure'],
  inputs: { image: { type: 'image' } },
  params: {
    amount: { type: 'float', default: 0.6, min: -1, max: 1, step: 0.01, label: 'Texture' },
    size: { type: 'float', default: 1, min: 0.5, max: 3, step: 0.05, label: 'Detail size', description: 'Scales the band (1 = ~1.5–6 px at full resolution).' },
  },
  passes: [
    { frag: gauss('h', 'u_image', '1.5 * u_size * u_scale', 'vec4(vec3(luma(s.rgb)), 1.0)') },
    { frag: gauss('v', 'u_prev', '1.5 * u_size * u_scale') },
    { frag: gauss('h', 'u_image', '6.0 * u_size * u_scale', 'vec4(vec3(luma(s.rgb)), 1.0)') },
    { frag: gauss('v', 'u_prev', '6.0 * u_size * u_scale') },
    {
      frag: /* glsl */ `
void main() {
  vec4 c = texture(u_image, v_uv);
  float L = luma(c.rgb);
  float b1 = texture(u_pass1, v_uv).r, b2 = texture(u_pass3, v_uv).r;
  float band = b1 - b2;
  // edge stop: large band values are edges, not texture (prevents halos / keeps edges when smoothing)
  float e = abs(band) / 0.06;
  float keep = 1.0 / (1.0 + e * e);
  float fine = L - b1; // finer than the band: noise / pores
  float d;
  if (u_amount >= 0.0) d = band * keep * u_amount * 1.6 + fine * u_amount * 0.25;
  else d = (band * keep + fine * 0.5 * keep) * u_amount * 0.9;
  // apply as a luminance change, keeping colour ratios
  vec3 o = c.rgb + vec3(d);
  fragColor = vec4(o, c.a);
}`,
    },
  ],
});

export default [smartSharpen, texture] satisfies NodeDef[];
