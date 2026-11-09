/**
 * Brush-based local tools: Dodge & Burn and the Healing / Clone brush. Strokes use the shared viewer
 * brush format (src/ui/viewerTools/data.ts) and are rasterised with mask.paint's rasteriser at the render
 * resolution, so preview and export match.
 */
import { setNodeInfo } from '../../core/nodeInfo';
import { defineNode } from '../../core/registry';
import type { CpuContext, NodeDef, PassContext, RawTex, ShaderPass } from '../../core/types';
import { parseStrokes } from '../../ui/viewerTools/data';
import { rasterStrokes } from '../ai/paint';
import { num } from '../library/shared';
import { findHealSource, ringWeights } from './local-heal-math';

const C = '#c08a3e';

/** Mask texture (r = coverage) from the strokes at the project size × scale. */
function strokeMask(ctx: CpuContext, W?: number, H?: number): { tex: RawTex; acc: Float32Array | null; W: number; H: number } {
  const strokes = parseStrokes(ctx.params.strokes);
  W = W ?? Math.max(1, Math.round(ctx.projectSize.width * ctx.scale));
  H = H ?? Math.max(1, Math.round(ctx.projectSize.height * ctx.scale));
  if (!strokes.length) return { tex: { width: 1, height: 1, data: new Uint8Array([0, 0, 0, 255]) }, acc: null, W, H };
  const acc = rasterStrokes(strokes, W, H, 0);
  const data = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    data[i * 4] = Math.round(acc[i] * 255);
    data[i * 4 + 3] = 255;
  }
  return { tex: { width: W, height: H, data }, acc, W, H };
}

const dodgeBurn = defineNode({
  id: 'pro.dodgeBurn',
  name: 'Dodge & Burn',
  category: 'Local',
  color: C,
  description:
    'Paint in the viewer to dodge (lighten) or burn (darken) like in the darkroom: strength in stops of exposure, applied in linear light. ' +
    'Range limits the effect to shadows, midtones or highlights (Photoshop-style); Protect tones keeps colours from washing out or clipping. ' +
    'Use one node for dodging and another for burning. The mask output shows the painted area.',
  tags: ['dodge', 'burn', 'brush', 'paint', 'lighten', 'darken', 'retouch', 'local adjustment', 'contour'],
  inputs: { image: { type: 'image' } },
  outputs: { out: { type: 'image' }, mask: { type: 'mask', label: 'Mask' } },
  params: {
    strokes: { type: 'string', default: '', hidden: true, label: 'Strokes' },
    mode: { type: 'enum', default: 'dodge', options: ['dodge', 'burn'], label: 'Mode' },
    strength: { type: 'float', default: 0.6, min: 0, max: 3, step: 0.01, label: 'Strength (EV)' },
    range: { type: 'enum', default: 'midtones', options: ['all', 'shadows', 'midtones', 'highlights'], label: 'Range' },
    protect: { type: 'bool', default: true, label: 'Protect tones' },
  },
  viewerTool: { kind: 'brush', param: 'strokes', previewPort: 'mask', label: 'Dodge & Burn' },
  cpu: (ctx) => ({ m: strokeMask(ctx).tex }),
  passes: [
    {
      output: 'out',
      frag: /* glsl */ `
void main() {
  vec4 c = texture(u_image, v_uv);
  float m = texture(u_m, v_uv).r;
  if (m <= 0.0) { fragColor = c; return; }
  float L = luma(clamp(c.rgb, 0.0, 1.0));
  float r = 1.0;
  if (u_range == 1) r = 1.0 - smoothstep(0.1, 0.6, L);
  else if (u_range == 2) r = 1.0 - pow(abs(2.0 * L - 1.0), 1.5);
  else if (u_range == 3) r = smoothstep(0.35, 0.9, L);
  float ev = (u_mode == 0 ? 1.0 : -1.0) * u_strength * m * r;
  vec3 lin = srgbToLinear(max(c.rgb, 0.0));
  vec3 o;
  if (u_protect) {
    // scale luminance, keep chroma ratios, then roll off highlights so they don't clip to flat white
    float Y = max(dot(lin, vec3(0.2126, 0.7152, 0.0722)), 1e-6);
    o = lin * exp2(ev);
    float mx = max(o.r, max(o.g, o.b));
    if (mx > 0.8) { float mo = 0.8 + 0.2 * (1.0 - exp(-(mx - 0.8) / 0.2)); o *= mo / mx; }
    // burning keeps saturation (darkening in linear light raises it slightly): pull back a little
    float Yo = dot(o, vec3(0.2126, 0.7152, 0.0722));
    o = mix(vec3(Yo), o, ev < 0.0 ? 1.0 / (1.0 - 0.15 * ev) : 1.0);
  } else o = lin * exp2(ev);
  fragColor = vec4(linearToSrgb(o), c.a);
}`,
    },
    { output: 'mask', frag: /* glsl */ `void main() { float m = texture(u_m, v_uv).r; fragColor = vec4(m, m, m, 1.0); }` },
  ],
});

// ---------------------------------------------------------------------------
// Healing brush: gradient-domain (Poisson-style) blending via a push–pull membrane
// ---------------------------------------------------------------------------
const LEVELS = 11;

/**
 * Passes: 0 = boundary differences (target − shifted source) premultiplied by the ring weight;
 * 1..LEVELS = push (2× downsample, premultiplied); then LEVELS pull passes back to full resolution
 * (fill each level's unknown texels from the coarser level: a smooth membrane interpolant of the
 * boundary differences, Gortler et al. 1996 push–pull); last = composite.
 */
function healPasses(): ShaderPass[] {
  const passes: ShaderPass[] = [];
  passes.push({
    frag: /* glsl */ `
void main() {
  vec2 off = texelFetch(u_off, ivec2(0), 0).rg;
  float ring = texture(u_m, v_uv).g;
  vec3 t = texture(u_image, v_uv).rgb;
  vec3 s = texClamp(u_image, v_uv + off).rgb;
  fragColor = vec4((t - s) * ring, ring);
}`,
  });
  for (let k = 1; k <= LEVELS; k++) {
    passes.push({
      size: (c: PassContext) => {
        const p = c.passSizes[k - 1];
        return [Math.max(1, Math.ceil(p.width / 2)), Math.max(1, Math.ceil(p.height / 2))];
      },
      frag: /* glsl */ `
void main() {
  // 4 bilinear taps = a 4×4 tent over the finer level (premultiplied sums average correctly)
  vec2 px = 1.0 / u_prev_size;
  vec4 a = texture(u_prev, v_uv + vec2(-px.x, -px.y)) + texture(u_prev, v_uv + vec2(px.x, -px.y))
         + texture(u_prev, v_uv + vec2(-px.x, px.y)) + texture(u_prev, v_uv + vec2(px.x, px.y));
  fragColor = a * 0.25;
}`,
    });
  }
  for (let k = LEVELS - 1; k >= 0; k--) {
    const first = k === LEVELS - 1;
    passes.push({
      size: (c: PassContext) => [c.passSizes[k].width, c.passSizes[k].height],
      frag: /* glsl */ `
void main() {
  vec4 up = texture(u_prev, v_uv);
  ${first ? 'up = vec4(up.rgb / max(up.a, 1e-6), 1.0);' : ''}
  vec4 here = texture(u_pass${k}, v_uv);
  // confidence: a texel whose footprint is (mostly) ring keeps its own value
  float a = clamp(here.a * 3.0, 0.0, 1.0);
  vec3 own = here.rgb / max(here.a, 1e-6);
  fragColor = vec4(mix(up.rgb, own, a), 1.0);
}`,
    });
  }
  passes.push({
    output: 'out',
    frag: /* glsl */ `
void main() {
  vec4 c = texture(u_image, v_uv);
  float m = texture(u_m, v_uv).r;
  if (m <= 0.0) { fragColor = c; return; }
  vec2 off = texelFetch(u_off, ivec2(0), 0).rg;
  vec3 s = texClamp(u_image, v_uv + off).rgb;
  vec3 healed = u_mode == 1 ? s + texture(u_prev, v_uv).rgb : s;
  // the brush's soft rim counts as covered (else a partly covered blemish edge would stay visible)
  fragColor = vec4(mix(c.rgb, healed, smoothstep(0.0, 0.55, m) * u_opacity), c.a);
}`,
  });
  passes.push({ output: 'mask', frag: /* glsl */ `void main() { float m = texture(u_m, v_uv).r; fragColor = vec4(m, m, m, 1.0); }` });
  return passes;
}

const heal = defineNode({
  id: 'pro.heal',
  name: 'Heal / Clone Brush',
  category: 'Local',
  color: C,
  description:
    'Paint over a blemish, sensor dust spot, power line or stray object in the viewer. Heal copies texture from a nearby source area and blends it in the gradient domain ' +
    '(a Poisson-style membrane matches colour and brightness to the surroundings, so it is seamless on skin and sky); Clone copies the source as is. ' +
    'The source is picked automatically (best-matching surroundings near the stroke, shown under the properties) or set manually as an offset.',
  tags: ['heal', 'healing brush', 'clone', 'stamp', 'spot removal', 'blemish', 'retouch', 'dust', 'poisson', 'content aware'],
  inputs: { image: { type: 'image' } },
  outputs: { out: { type: 'image' }, mask: { type: 'mask', label: 'Mask' } },
  params: {
    strokes: { type: 'string', default: '', hidden: true, label: 'Strokes' },
    mode: { type: 'enum', default: 'heal', options: ['clone', 'heal'], label: 'Mode' },
    source: { type: 'enum', default: 'auto', options: ['auto', 'manual'], label: 'Source' },
    offset: { type: 'vec2', default: [0.06, 0], min: -0.5, max: 0.5, step: 0.001, label: 'Manual offset', description: 'Source position relative to the painted area (fractions of the width / height).' },
    opacity: { type: 'float', default: 1, min: 0, max: 1, step: 0.01, label: 'Opacity' },
  },
  viewerTool: { kind: 'brush', param: 'strokes', previewPort: 'mask', label: 'Heal / Clone' },
  cpuReadsInputs: true,
  cpu: (ctx) => {
    const auto = ctx.params.source !== 'manual';
    const img = auto && parseStrokes(ctx.params.strokes).length ? ctx.readInput('image') : null;
    const { acc, W, H } = strokeMask(ctx, img?.width, img?.height);
    const manual = Array.isArray(ctx.params.offset) ? (ctx.params.offset as number[]) : [0.06, 0];
    let off: [number, number] = [num({ v: manual[0] }, 'v', 0.06), num({ v: manual[1] }, 'v', 0)];
    if (!acc) {
      setNodeInfo(ctx.nodeId, null);
      return { m: { width: 1, height: 1, data: new Float32Array([0, 0, 0, 1]) }, off: { width: 1, height: 1, data: new Float32Array([0, 0, 0, 1]), filter: 'nearest' } };
    }
    if (img) {
      const r = findHealSource(img, acc, ctx.params.mode !== 'clone');
      if (r) off = r;
    }
    setNodeInfo(ctx.nodeId, { title: 'Heal source', text: `offset ${(off[0] * 100).toFixed(1)}% × ${(off[1] * 100).toFixed(1)}% (${auto ? 'auto' : 'manual'})`, detail: 'Fractions of the image width / height from the painted area to the source.' });
    const ring = ringWeights(acc, W, H, Math.max(1.5, 2.5 * ctx.scale));
    const data = new Float32Array(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      data[i * 4] = acc[i];
      data[i * 4 + 1] = ring[i];
      data[i * 4 + 3] = 1;
    }
    return { m: { width: W, height: H, data, filter: 'nearest' }, off: { width: 1, height: 1, data: new Float32Array([off[0], off[1], 0, 1]), filter: 'nearest' } };
  },
  passes: healPasses(),
});

export default [dodgeBurn, heal] satisfies NodeDef[];
