/**
 * Text-driven selection presets (Select by Text = OWLv2 + SAM). Each exposes the prompt as a knob, so the same
 * preset works on anything you can name.
 */
import { GraphBuilder } from '../core/graph';
import type { PresetDef } from '../core/types';

function textRecolor(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const sel = b.node('ai.textSelect', { prompt: 'jacket', feather: 2 }, { image: img });
  const hsl = b.node('color.hsl', { hue: 120, saturation: 0.1 }, { image: img });
  const out = b.node('composite.mix', { factor: 1 }, { a: img, b: hsl, mask: { node: sel, port: 'mask' } });
  b.output('out', out);
  b.expose('prompt', sel, 'prompt', 'What to recolour')
    .expose('hue', hsl, 'hue', 'Hue shift (°)')
    .expose('saturation', hsl, 'saturation', 'Saturation')
    .expose('lightness', hsl, 'lightness', 'Lightness')
    .expose('keep', sel, 'keep', 'Keep')
    .expose('threshold', sel, 'threshold', 'Box threshold')
    .expose('feather', sel, 'feather', 'Feather')
    .expose('amount', out, 'factor', 'Amount');
  return {
    id: 'ai.textRecolor',
    name: 'Recolour by Text (AI)',
    category: 'AI',
    tags: ['recolor', 'recolour', 'hue', 'text', 'prompt', 'select', 'object', 'ai'],
    description: 'Type an object (“jacket”, “car”, “umbrella”): it is found and traced (OWLv2 + SAM, local) and its hue is shifted. Commas select several things.',
    group: b.toGroup('Recolour by Text (AI)'),
  };
}

function textBlurBackground(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const sel = b.node('ai.textSelect', { prompt: 'person', invert: true, feather: 3, keep: 'Best match' }, { image: img });
  const blur = b.node('filter.lensBlur', { radius: 24, boost: 3 }, { image: img, amount: { node: sel, port: 'mask' } });
  b.output('out', blur);
  b.expose('prompt', sel, 'prompt', 'Subject to keep sharp')
    .expose('keep', sel, 'keep', 'Keep')
    .expose('radius', blur, 'radius', 'Blur')
    .expose('boost', blur, 'boost', 'Bokeh highlights')
    .expose('blades', blur, 'blades', 'Aperture blades')
    .expose('threshold', sel, 'threshold', 'Box threshold')
    .expose('feather', sel, 'feather', 'Edge feather');
  return {
    id: 'ai.textBlurBackground',
    name: 'Blur All But… (AI)',
    category: 'AI',
    tags: ['bokeh', 'background blur', 'portrait mode', 'depth of field', 'text', 'prompt', 'subject', 'ai'],
    description: 'Name the subject (“woman”, “dog”, “red car”): it stays sharp while everything else gets a lens blur. Uses Select by Text (OWLv2 + SAM, local), inverted.',
    group: b.toGroup('Blur All But… (AI)'),
  };
}

function textCutout(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const sel = b.node('ai.textSelect', { prompt: 'person', feather: 1 }, { image: img });
  const cut = b.node('composite.alphaFromMask', { mode: 'replace' }, { image: img, mask: { node: sel, port: 'mask' } });
  b.output('out', cut);
  b.expose('prompt', sel, 'prompt', 'What to cut out')
    .expose('keep', sel, 'keep', 'Keep')
    .expose('nth', sel, 'nth', 'N')
    .expose('threshold', sel, 'threshold', 'Box threshold')
    .expose('maskThreshold', sel, 'threshold2', 'Mask threshold')
    .expose('feather', sel, 'feather', 'Feather');
  return {
    id: 'ai.textCutout',
    name: 'Cut Out by Text (AI)',
    category: 'AI',
    tags: ['cutout', 'remove background', 'transparent', 'alpha', 'text', 'prompt', 'ai'],
    description: 'Name what to keep (“canoe”, “sunglasses”, “person, paddle”): everything else becomes transparent. Uses Select by Text (OWLv2 + SAM, local).',
    group: b.toGroup('Cut Out by Text (AI)'),
  };
}

export default (): PresetDef[] => [textRecolor(), textBlurBackground(), textCutout()];
