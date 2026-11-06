/**
 * Darkroom example CODE plugin.
 *
 * A code plugin is an ES module whose default export is a PluginDef, or a
 * function `(api) => PluginDef | Promise<PluginDef>`. It runs arbitrary
 * JavaScript, so Darkroom asks the user to trust its source before loading it.
 *
 * It is loaded from a Blob URL, so it cannot use relative `import`s — bundle
 * dependencies into this one file (or import absolute https:// URLs).
 *
 * Install: Edit › Plugins… › Install from URL → /plugins/example-code-plugin.js
 */
export default (api) => {
  const { defineNode, GraphBuilder } = api;

  /** Text Watermark: a CPU step draws text on a canvas, a shader composites it. */
  const watermark = defineNode({
    id: 'example.textWatermark',
    name: 'Text Watermark',
    category: 'Composite',
    description: 'Draws a text watermark (CPU canvas step) and composites it over the image.',
    tags: ['text', 'signature', 'copyright', 'caption'],
    color: '#b0703a',
    inputs: { image: { type: 'image' } },
    params: {
      text: { type: 'string', default: '© Darkroom 2026', label: 'Text' },
      font: { type: 'enum', options: ['sans-serif', 'serif', 'monospace', 'cursive'], default: 'sans-serif', label: 'Font' },
      bold: { type: 'bool', default: true, label: 'Bold' },
      size: { type: 'float', default: 48, min: 6, max: 400, step: 1, pixels: true, label: 'Size' },
      position: { type: 'enum', options: ['bottom-right', 'bottom-left', 'top-right', 'top-left', 'center'], default: 'bottom-right', label: 'Position' },
      margin: { type: 'float', default: 32, min: 0, max: 400, step: 1, pixels: true, label: 'Margin' },
      color: { type: 'color', default: [1, 1, 1, 1], label: 'Colour' },
      opacity: { type: 'float', default: 0.8, min: 0, max: 1, label: 'Opacity' },
      shadow: { type: 'bool', default: true, label: 'Drop shadow' },
    },
    // Runs on the CPU, cached by params + render scale. Returns textures keyed by name;
    // with passes they become samplers (`u_text` below).
    cpu: ({ params, scale, projectSize }) => {
      const w = Math.max(1, Math.round(projectSize.width * scale));
      const h = Math.max(1, Math.round(projectSize.height * scale));
      const c = new OffscreenCanvas(w, h);
      const g = c.getContext('2d');
      const px = params.size * scale;
      const m = params.margin * scale;
      g.font = `${params.bold ? 'bold ' : ''}${px}px ${params.font}`;
      const pos = String(params.position);
      g.textAlign = pos === 'center' ? 'center' : pos.endsWith('right') ? 'right' : 'left';
      g.textBaseline = pos === 'center' ? 'middle' : pos.startsWith('top') ? 'top' : 'alphabetic';
      const x = pos === 'center' ? w / 2 : pos.endsWith('right') ? w - m : m;
      const y = pos === 'center' ? h / 2 : pos.startsWith('top') ? m : h - m;
      const [r, gr, b] = params.color.map((v) => Math.round(v * 255));
      if (params.shadow) {
        g.shadowColor = 'rgba(0,0,0,0.6)';
        g.shadowBlur = px * 0.15;
        g.shadowOffsetX = g.shadowOffsetY = Math.max(1, px * 0.04);
      }
      g.fillStyle = `rgb(${r},${gr},${b})`;
      g.fillText(String(params.text), x, y);
      return { text: c };
    },
    passes: [
      {
        frag: /* glsl */ `
void main() {
  vec4 src = texture(u_image, v_uv);
  vec4 t = texture(u_text, v_uv);   // from cpu(): straight (non-premultiplied) RGBA
  fragColor = vec4(mix(src.rgb, t.rgb, t.a * u_opacity * u_color.a), src.a);
}`,
      },
    ],
  });

  /** A tiny shader-only node, written with api.nodeFromJSON + @param annotations. */
  const sepia = api.nodeFromJSON({
    id: 'example.warmSepia',
    name: 'Warm Sepia',
    category: 'Color',
    description: 'Sepia tone with a strength knob (defined from JSON inside a code plugin).',
    inputs: { image: { type: 'image' } },
    params: api.parseParams('uniform float u_amount; // @param min=0 max=1 default=0.8 label="Amount"'),
    passes: [
      {
        frag: `void main() {
  vec4 c = texture(u_image, v_uv);
  float l = luma(c.rgb);
  vec3 s = vec3(l * 1.07, l * 0.86, l * 0.62) + vec3(0.05, 0.03, 0.0);
  fragColor = vec4(mix(c.rgb, s, u_amount), c.a);
}`,
      },
    ],
  });

  return {
    id: 'example.codePlugin',
    name: 'Example Code Plugin',
    version: '1.0.0',
    author: 'Darkroom examples',
    description: `Text Watermark (CPU canvas step), Warm Sepia, and a "Signed Print" preset. Built for Darkroom ${api.version}.`,
    nodes: [watermark, sepia],
    // A function, so it runs after the nodes above are registered (GraphBuilder reads their defaults).
    presets: () => {
      const b = new GraphBuilder();
      const img = b.input('image');
      const tone = b.node('example.warmSepia', { amount: 0.65 }, { image: img });
      const vig = b.node('stylize.vignette', { amount: 0.45 }, { image: tone });
      const grain = b.node('stylize.grain', { amount: 0.25 }, { image: vig });
      const mark = b.node('example.textWatermark', { text: 'Darkroom', font: 'serif', size: 64 }, { image: grain });
      b.output('out', mark);
      b.expose('sepia', tone, 'amount', 'Sepia');
      b.expose('vignette', vig, 'amount', 'Vignette');
      b.expose('grain', grain, 'amount', 'Grain');
      b.expose('signature', mark, 'text', 'Signature');
      b.expose('opacity', mark, 'opacity', 'Signature opacity');
      return [
        {
          id: 'example.signedPrint',
          name: 'Signed Print',
          category: 'Fun',
          description: 'Warm sepia, vignette and grain with a signature watermark (example code plugin).',
          group: b.toGroup('Signed Print'),
        },
      ];
    },
  };
};
