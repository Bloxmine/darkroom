import { defineNode } from '../../core/registry';
import type { NodeDef } from '../../core/types';
import { num } from './shared';

const C = '#4f8cff';

export default [
  defineNode({
    id: 'input.solidColor',
    name: 'Solid Color',
    category: 'Input',
    description: 'A flat colour filling the project canvas.',
    tags: ['fill', 'constant', 'colour', 'background'],
    color: C,
    inputs: {},
    params: {
      color: { type: 'color', default: [0.5, 0.5, 0.5, 1], label: 'Color' },
    },
    passes: [{ frag: `void main(){ fragColor = u_color; }` }],
  }),

  defineNode({
    id: 'input.gradient',
    name: 'Gradient',
    category: 'Input',
    description: 'Linear or radial two-colour gradient. Angle 90° runs top→bottom, 0° left→right. Radial: colour B is reached at half the longer side × scale.',
    tags: ['ramp', 'linear', 'radial', 'fill', 'vignette'],
    color: C,
    inputs: {},
    params: {
      kind: { type: 'enum', default: 'linear', options: ['linear', 'radial'], label: 'Kind' },
      colorA: { type: 'color', default: [0, 0, 0, 1], label: 'Color A' },
      colorB: { type: 'color', default: [1, 1, 1, 1], label: 'Color B' },
      angle: { type: 'float', default: 90, min: -180, max: 360, step: 1, label: 'Angle (°)', description: 'Linear direction. 0 = left→right, 90 = top→bottom.' },
      center: { type: 'vec2', default: [0.5, 0.5], min: 0, max: 1, step: 0.01, label: 'Center' },
      scale: { type: 'float', default: 1, min: 0.01, max: 10, step: 0.01, label: 'Scale' },
    },
    passes: [{
      frag: /* glsl */ `
uniform float u_gscale;
void main(){
  vec2 p = v_uv - u_center;
  float t;
  if (u_kind == 0) {
    float a = radians(u_angle);
    vec2 d = vec2(cos(a), sin(a));           // y-down: 90° points down
    float ext = abs(d.x) + abs(d.y);          // corner-to-corner extent of a unit square
    t = dot(p, d) / max(ext, 1e-4) / u_gscale + 0.5;
  } else {
    vec2 q = p * u_resolution;
    t = length(q) / (0.5 * max(u_resolution.x, u_resolution.y)) / u_gscale;
  }
  t = clamp(t, 0.0, 1.0);
  vec4 c = mix(u_colorA, u_colorB, t);
  // tiny dither against banding in 8-bit export
  c.rgb += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
  fragColor = c;
}`,
      uniforms: (ctx) => ({ u_gscale: Math.max(1e-3, num(ctx.params, 'scale', 1)) }),
    }],
  }),

  defineNode({
    id: 'input.noise',
    name: 'Noise',
    category: 'Input',
    description: 'Procedural noise: white (per-cell), value, perlin (gradient) or fractal (fbm). Scale is the feature size in pixels.',
    tags: ['random', 'perlin', 'fbm', 'clouds', 'texture', 'procedural'],
    color: C,
    inputs: {},
    params: {
      kind: { type: 'enum', default: 'fbm', options: ['white', 'value', 'perlin', 'fbm'], label: 'Kind' },
      scale: { type: 'float', default: 64, min: 1, max: 1000, step: 1, pixels: true, label: 'Feature size' },
      seed: { type: 'float', default: 0, min: 0, max: 1000, step: 1, label: 'Seed' },
      octaves: { type: 'int', default: 4, min: 1, max: 10, step: 1, label: 'Octaves', description: 'fbm only' },
      monochrome: { type: 'bool', default: true, label: 'Monochrome' },
      contrast: { type: 'float', default: 1, min: 0, max: 5, step: 0.01, label: 'Contrast' },
    },
    passes: [{
      frag: /* glsl */ `
uniform float u_feature;
float noiseAt(vec2 p, float ch) {
  p += vec2(u_seed * 17.137 + ch * 113.7, u_seed * 31.71 - ch * 71.3);
  if (u_kind == 0) return hash12(floor(p));
  if (u_kind == 1) return valueNoise(p);
  if (u_kind == 2) return gradNoise(p) * 0.5 + 0.5;
  float norm = 1.0 - pow(0.5, float(clamp(u_octaves, 1, 12)));
  return fbm(p, u_octaves) / norm;
}
void main(){
  vec2 p = pixelCoord() / max(u_feature * u_scale, 1e-3);
  vec3 v;
  if (u_monochrome) v = vec3(noiseAt(p, 0.0));
  else v = vec3(noiseAt(p, 0.0), noiseAt(p, 1.0), noiseAt(p, 2.0));
  v = (v - 0.5) * u_contrast + 0.5;
  fragColor = vec4(clamp(v, 0.0, 1.0), 1.0);
}`,
      // NB: the 'scale' param can't be read as u_scale (that is the render scale) → pass it under another name.
      uniforms: (ctx) => ({ u_feature: num(ctx.params, 'scale', 64) }),
    }],
  }),

  defineNode({
    id: 'input.text',
    name: 'Text',
    category: 'Input',
    description: 'Text rendered on a transparent, project-sized layer (canvas 2D). Position (0..1, origin top-left) anchors the baseline of a single line; multi-line blocks are shifted up proportionally so they stay on canvas. Combine with Blend to overlay.',
    tags: ['type', 'font', 'caption', 'date stamp', 'label', 'overlay'],
    color: C,
    inputs: {},
    params: {
      text: { type: 'string', default: 'Darkroom', multiline: true, label: 'Text' },
      font: { type: 'string', default: 'monospace', label: 'Font family' },
      size: { type: 'float', default: 48, min: 1, max: 1000, step: 1, pixels: true, label: 'Size' },
      color: { type: 'color', default: [1, 1, 1, 1], label: 'Color' },
      position: { type: 'vec2', default: [0.05, 0.9], min: 0, max: 1, step: 0.005, label: 'Position' },
      align: { type: 'enum', default: 'left', options: ['left', 'center', 'right'], label: 'Align' },
      weight: { type: 'enum', default: 'normal', options: ['normal', 'bold'], label: 'Weight' },
      glow: { type: 'float', default: 0, min: 0, max: 200, step: 0.5, pixels: true, label: 'Glow' },
      letterSpacing: { type: 'float', default: 0, min: -50, max: 200, step: 0.5, pixels: true, label: 'Letter spacing' },
      lineHeight: { type: 'float', default: 1.2, min: 0.5, max: 4, step: 0.05, label: 'Line height' },
    },
    cpu: ({ params, scale, projectSize }) => {
      const W = Math.max(1, Math.round(projectSize.width * scale));
      const H = Math.max(1, Math.round(projectSize.height * scale));
      const canvas = new OffscreenCanvas(W, H);
      const g = canvas.getContext('2d')!;
      const size = num(params, 'size', 48) * scale;
      const font = String(params.font ?? 'monospace') || 'monospace';
      const weight = params.weight === 'bold' ? 'bold' : 'normal';
      const col = Array.isArray(params.color) ? (params.color as number[]) : [1, 1, 1, 1];
      const pos = Array.isArray(params.position) ? (params.position as number[]) : [0.05, 0.9];
      const align = (['left', 'center', 'right'].includes(String(params.align)) ? params.align : 'left') as CanvasTextAlign;
      const glow = num(params, 'glow', 0) * scale;
      const spacing = num(params, 'letterSpacing', 0) * scale;
      const lh = num(params, 'lineHeight', 1.2);
      const css = `rgba(${Math.round(col[0] * 255)},${Math.round(col[1] * 255)},${Math.round(col[2] * 255)},${col[3] ?? 1})`;
      g.font = `${weight} ${size}px ${font}`;
      g.textAlign = align;
      g.textBaseline = 'alphabetic';
      g.fillStyle = css;
      if ('letterSpacing' in g) (g as unknown as { letterSpacing: string }).letterSpacing = `${spacing}px`;
      const lines = String(params.text ?? '').split('\n');
      // Single line: baseline at the anchor. Multi-line blocks shift up by pos.y × extra height
      // so text near the bottom edge stays on canvas.
      const y0 = pos[1] * H - pos[1] * (lines.length - 1) * size * lh;
      const draw = () => lines.forEach((l, i) => g.fillText(l, pos[0] * W, y0 + i * size * lh));
      if (glow > 0) {
        g.shadowColor = css;
        g.shadowBlur = glow;
        draw();
        g.shadowBlur = 0;
        g.shadowColor = 'transparent';
      }
      draw();
      return { out: canvas };
    },
  }),

  defineNode({
    id: 'input.checker',
    name: 'Checkerboard',
    category: 'Input',
    description: 'Two-colour checkerboard pattern (handy for testing distortions).',
    tags: ['pattern', 'grid', 'test'],
    color: C,
    inputs: {},
    params: {
      size: { type: 'float', default: 64, min: 1, max: 1000, step: 1, pixels: true, label: 'Cell size' },
      colorA: { type: 'color', default: [0.1, 0.1, 0.1, 1], label: 'Color A' },
      colorB: { type: 'color', default: [0.9, 0.9, 0.9, 1], label: 'Color B' },
    },
    passes: [{
      frag: /* glsl */ `
void main(){
  vec2 c = floor(pixelCoord() / max(u_size * u_scale, 1e-3));
  fragColor = mod(c.x + c.y, 2.0) < 1.0 ? u_colorA : u_colorB;
}` }],
  }),
] satisfies NodeDef[];
