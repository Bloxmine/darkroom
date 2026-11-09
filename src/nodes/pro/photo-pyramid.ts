/**
 * Multi-image pyramid blending on the GPU: Mertens exposure fusion and focus stacking.
 *
 * Both compute a per-pixel weight for each input, normalise the weights across inputs, then blend
 * Laplacian pyramids of the inputs with Gaussian pyramids of the weights (Burt & Adelson 1983) and
 * collapse — which hides seams between the sources at every scale.
 *
 * Pass layout (K = 5 inputs, LV levels): pass l·K + k = level l of input k as (rgb, weight)
 * (level 0 = the weight pass, levels 1..LV = 2× downsamples), then LV + 1 collapse passes from the
 * coarsest level up. Unconnected inputs get weight 0.
 */
import { defineNode } from '../../core/registry';
import type { NodeDef, PassContext, PortDef, ShaderPass } from '../../core/types';

const C = '#7a9a4a';
const K = 5;
const LV = 9;

const inputs: Record<string, PortDef> = {};
for (let k = 0; k < K; k++) inputs['in' + k] = { type: 'image', label: `Image ${k + 1}`, optional: k > 1 };

const CONNECTED = /* glsl */ `
bool connectedIn(int k) {
  if (k == 0) return true;
  if (k == 1) return u_in1_size.x > 1.5;
  if (k == 2) return u_in2_size.x > 1.5;
  if (k == 3) return u_in3_size.x > 1.5;
  return u_in4_size.x > 1.5;
}
vec3 inAt(int k, vec2 uv) {
  if (k == 0) return texClamp(u_in0, uv).rgb;
  if (k == 1) return texClamp(u_in1, uv).rgb;
  if (k == 2) return texClamp(u_in2, uv).rgb;
  if (k == 3) return texClamp(u_in3, uv).rgb;
  return texClamp(u_in4, uv).rgb;
}`;

/**
 * Build the passes. `weightGlsl` defines `float rawWeight(int k, vec2 uv)` (may use inAt / u_resolution / u_scale).
 */
function pyramidPasses(weightGlsl: string): ShaderPass[] {
  const passes: ShaderPass[] = [];
  const idx = (l: number, k: number) => l * K + k;
  // level 0: (rgb, normalised weight) per input
  for (let k = 0; k < K; k++)
    passes.push({
      frag: /* glsl */ `
${CONNECTED}
${weightGlsl}
void main() {
  float w[${K}]; float sum = 0.0;
  for (int i = 0; i < ${K}; i++) { w[i] = connectedIn(i) ? rawWeight(i, v_uv) + 1e-12 : 0.0; sum += w[i]; }
  fragColor = vec4(inAt(${k}, v_uv), w[${k}] / max(sum, 1e-12));
}`,
    });
  // Gaussian pyramid (rgb + weight) of every input
  for (let l = 1; l <= LV; l++)
    for (let k = 0; k < K; k++) {
      const src = idx(l - 1, k);
      passes.push({
        size: (c: PassContext) => {
          const p = c.passSizes[src];
          return [Math.max(1, Math.ceil(p.width / 2)), Math.max(1, Math.ceil(p.height / 2))];
        },
        frag: /* glsl */ `
void main() {
  vec2 px = 1.0 / u_pass${src}_size;
  fragColor = 0.25 * (texture(u_pass${src}, v_uv + vec2(-px.x, -px.y)) + texture(u_pass${src}, v_uv + vec2(px.x, -px.y))
                    + texture(u_pass${src}, v_uv + vec2(-px.x, px.y)) + texture(u_pass${src}, v_uv + vec2(px.x, px.y)));
}`,
      });
    }
  // collapse: coarsest = Σ G(w)·G(I); level l = Σ G_l(w)·(G_l(I) − up(G_{l+1}(I))) + up(result_{l+1})
  for (let l = LV; l >= 0; l--) {
    const terms: string[] = [];
    for (let k = 0; k < K; k++) {
      const here = `u_pass${idx(l, k)}`;
      if (l === LV) terms.push(`{ vec4 g = texture(${here}, v_uv); acc += g.a * g.rgb; }`);
      else terms.push(`{ vec4 g = texture(${here}, v_uv); vec3 up = texture(u_pass${idx(l + 1, k)}, v_uv).rgb; acc += g.a * (g.rgb - up); }`);
    }
    passes.push({
      size: (c: PassContext) => [c.passSizes[idx(l, 0)].width, c.passSizes[idx(l, 0)].height],
      frag: /* glsl */ `
void main() {
  vec3 acc = vec3(0.0);
  ${terms.join('\n  ')}
  ${l === LV ? '' : 'acc += texture(u_prev, v_uv).rgb;'}
  fragColor = vec4(acc, 1.0);
}`,
    });
  }
  return passes;
}

const fusion = defineNode({
  id: 'pro.exposureFusion',
  name: 'Exposure Fusion',
  category: 'Photo',
  color: C,
  description:
    'Mertens–Kautz–Van Reeth exposure fusion: blends 2–5 bracketed exposures directly into a natural-looking image — no HDR merge or tone mapping needed. ' +
    'Each pixel of each frame is weighted by contrast (|Laplacian|), saturation (RGB standard deviation) and well-exposedness (gaussian around mid-grey, σ = 0.2), ' +
    'and the frames are blended with Laplacian pyramids so there are no halos or seams. Works best with aligned (tripod) brackets.',
  tags: ['exposure fusion', 'mertens', 'hdr', 'bracket', 'enfuse', 'blend', 'natural hdr', 'pyramid'],
  inputs,
  params: {
    contrast: { type: 'float', default: 1, min: 0, max: 3, step: 0.05, label: 'Contrast weight', description: 'Exponent ωc of the contrast measure.' },
    saturation: { type: 'float', default: 1, min: 0, max: 3, step: 0.05, label: 'Saturation weight', description: 'Exponent ωs.' },
    exposedness: { type: 'float', default: 1, min: 0, max: 3, step: 0.05, label: 'Exposedness weight', description: 'Exponent ωe.' },
    sigma: { type: 'float', default: 0.2, min: 0.05, max: 0.5, step: 0.01, label: 'Exposedness σ' },
  },
  passes: pyramidPasses(/* glsl */ `
float rawWeight(int k, vec2 uv) {
  vec2 px = 1.0 / u_resolution;
  vec3 c = clamp(inAt(k, uv), 0.0, 1.0);
  // contrast: |Laplacian| of the grey image (Mertens et al. 2007, §3.1)
  float g = luma(c);
  float lap = abs(4.0 * g - luma(inAt(k, uv + vec2(px.x, 0.0))) - luma(inAt(k, uv - vec2(px.x, 0.0)))
                          - luma(inAt(k, uv + vec2(0.0, px.y))) - luma(inAt(k, uv - vec2(0.0, px.y))));
  // saturation: standard deviation of R, G, B
  float mu = (c.r + c.g + c.b) / 3.0;
  float sat = sqrt(((c.r - mu) * (c.r - mu) + (c.g - mu) * (c.g - mu) + (c.b - mu) * (c.b - mu)) / 3.0);
  // well-exposedness: Π_c exp(−(i − 0.5)² / 2σ²)
  vec3 e3 = exp(-(c - 0.5) * (c - 0.5) / (2.0 * u_sigma * u_sigma));
  float expo = e3.r * e3.g * e3.b;
  return pow(lap + 1e-3, u_contrast) * pow(sat + 1e-3, u_saturation) * pow(expo + 1e-6, u_exposedness);
}`),
});

const focus = defineNode({
  id: 'pro.focusStack',
  name: 'Focus Stack',
  category: 'Photo',
  color: C,
  description:
    'Combines 2–5 photos focused at different distances into one sharp image (macro, product, landscape). The sharpness of each frame is measured as local Laplacian energy, ' +
    'smoothed over Radius; Selectivity sharpens the choice (soft-max), and the frames are blended with Laplacian pyramids to avoid halos and seams. Frames must be aligned.',
  tags: ['focus stack', 'focus stacking', 'depth of field', 'macro', 'sharpness', 'helicon', 'blend', 'pyramid'],
  inputs,
  params: {
    radius: { type: 'float', default: 6, min: 1, max: 40, step: 0.5, pixels: true, label: 'Radius', description: 'Neighbourhood over which sharpness is measured (full-res px).' },
    selectivity: { type: 'float', default: 4, min: 1, max: 12, step: 0.1, label: 'Selectivity', description: 'Power applied to the sharpness: higher = pick the sharpest frame more decisively.' },
  },
  passes: pyramidPasses(/* glsl */ `
float lapAt(int k, vec2 uv, vec2 px) {
  float g = luma(inAt(k, uv));
  return 4.0 * g - luma(inAt(k, uv + vec2(px.x, 0.0))) - luma(inAt(k, uv - vec2(px.x, 0.0)))
                 - luma(inAt(k, uv + vec2(0.0, px.y))) - luma(inAt(k, uv - vec2(0.0, px.y)));
}
float rawWeight(int k, vec2 uv) {
  vec2 px = 1.0 / u_resolution;
  // Laplacian energy averaged over a disc of the given radius (scale independent: 7×7 taps spread over it)
  float r = max(u_radius * u_scale, 1.0);
  float e = 0.0, n = 0.0;
  for (int y = -3; y <= 3; y++)
    for (int x = -3; x <= 3; x++) {
      vec2 o = vec2(float(x), float(y)) / 3.0;
      if (dot(o, o) > 1.0) continue;
      float l = lapAt(k, uv + o * r * px, px);
      e += l * l; n += 1.0;
    }
  e = sqrt(e / n);
  return pow(e + 1e-4, u_selectivity);
}`),
});

export default [fusion, focus] satisfies NodeDef[];
