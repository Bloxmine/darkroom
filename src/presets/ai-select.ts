/**
 * Presets built on the AI selection / relighting nodes (Click Select, Scene Segmentation, Relight).
 * Click-select presets expose the hidden `points`/`box` params, so selecting the preset node shows the
 * point tool in the viewer; Relight exposes `light`, so its light can be dragged there too.
 */
import { GraphBuilder } from '../core/graph';
import type { PresetDef } from '../core/types';

function skySwap(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const seg = b.node('ai.sceneSegment', { class: 'Sky', refine: 0.9, softness: 0.5, feather: 1.5 }, { image: img });
  const grad = b.node('input.gradient', { kind: 'linear', angle: 90, center: [0.5, 0.25], scale: 0.5, colorA: [0.13, 0.3, 0.68, 1], colorB: [0.98, 0.74, 0.5, 1] }, {});
  // colour match: pull the new sky part-way towards the photo's own palette so it sits in the scene
  const matched = b.node('color.matchColor', { space: 'lab', luminance: 0.6 }, { image: grad, reference: img });
  const sky = b.node('composite.mix', { factor: 0.35 }, { a: grad, b: matched });
  const out = b.node('composite.mix', { factor: 1 }, { a: img, b: sky, mask: { node: seg, port: 'mask' } });
  b.output('out', out);
  b.expose('top', grad, 'colorA', 'Sky top')
    .expose('horizon', grad, 'colorB', 'Sky horizon')
    .expose('spread', grad, 'scale', 'Gradient height')
    .expose('match', sky, 'factor', 'Match to photo')
    .expose('amount', out, 'factor', 'Amount')
    .expose('threshold', seg, 'threshold', 'Mask threshold')
    .expose('softness', seg, 'softness', 'Mask softness')
    .expose('refine', seg, 'refine', 'Edge refine')
    .expose('feather', seg, 'feather', 'Feather');
  return {
    id: 'ai.skySwap',
    name: 'Sky Swap (AI)',
    category: 'AI',
    tags: ['sky replacement', 'sky', 'replace sky', 'gradient', 'sunset', 'segmentation', 'ai'],
    description:
      'Replaces the sky with a gradient: Scene Segmentation (DETR, runs in your browser) finds the sky, refined edge-aware against the image so branches and ridges stay. ' +
      'The gradient is colour-matched part-way to the photo so it blends in. Swap the gradient node for a sky photo inside the group for a real replacement.',
    group: b.toGroup('Sky Swap (AI)'),
  };
}

function selectiveColor(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const sam = b.node('ai.segmentAnything', { refine: 0.85, feather: 1 }, { image: img });
  const bw = b.node('color.blackWhite', {}, { image: img });
  const out = b.node('composite.mix', { factor: 1 }, { a: bw, b: img, mask: { node: sam, port: 'mask' } });
  b.output('out', out);
  b.expose('points', sam, 'points', 'Points')
    .expose('box', sam, 'box', 'Box')
    .expose('mask', sam, 'maskIndex', 'Mask')
    .expose('threshold', sam, 'threshold', 'Threshold')
    .expose('refine', sam, 'refine', 'Edge refine')
    .expose('feather', sam, 'feather', 'Feather')
    .expose('invert', sam, 'invert', 'Invert (colour the rest)')
    .expose('amount', out, 'factor', 'Colour amount');
  return {
    id: 'ai.selectiveColor',
    name: 'Selective Colour (AI)',
    category: 'AI',
    tags: ['selective colour', 'color splash', 'colour pop', 'black and white', 'click select', 'sam', 'ai'],
    description: 'Colour splash: select the preset, click the object in the viewer (Click Select / SAM) and it stays in colour while the rest turns black & white.',
    group: b.toGroup('Selective Colour (AI)'),
  };
}

function dramaticRelight(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const d = b.node('ai.depth', { smoothing: 0.5 }, { image: img });
  const rl = b.node(
    'ai.relight',
    { mode: 'Full relight', ambient: 0.32, intensity: 2.2, falloff: 1.2, height: 0.3, light: [0.28, 0.22], color: [1, 0.86, 0.68, 1], shadowStrength: 0.85, specular: 0.2 },
    { image: img, depth: { node: d, port: 'depth' } },
  );
  const vig = b.node('stylize.vignette', { amount: 0.25, radius: 0.75, softness: 0.8 }, { image: rl });
  b.output('out', vig);
  b.expose('light', rl, 'light', 'Light position')
    .expose('height', rl, 'height', 'Light height')
    .expose('intensity', rl, 'intensity', 'Intensity')
    .expose('color', rl, 'color', 'Light colour')
    .expose('ambient', rl, 'ambient', 'Ambient (rest)')
    .expose('falloff', rl, 'falloff', 'Falloff')
    .expose('shadows', rl, 'shadowStrength', 'Shadows')
    .expose('vignette', vig, 'amount', 'Vignette');
  return {
    id: 'ai.dramaticRelight',
    name: 'Dramatic Relight (AI)',
    category: 'AI',
    tags: ['relight', 'light', 'dramatic', 'moody', 'low key', 'depth', 'shadow', 'ai'],
    description: 'Darkens the scene and lights it again from a virtual lamp, using an AI depth map for surface shape and soft shadows. Select the preset and drag the light in the viewer.',
    group: b.toGroup('Dramatic Relight (AI)'),
  };
}

function cutout(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const sam = b.node('ai.segmentAnything', { refine: 0.9, softness: 0.2 }, { image: img });
  const alpha = b.node('composite.alphaFromMask', {}, { image: img, mask: { node: sam, port: 'mask' } });
  const shadow = b.node('composite.dropShadow', { angle: 60, distance: 14, blur: 22, opacity: 0.6 }, { image: alpha });
  const bg = b.node('input.solidColor', { color: [1, 1, 1, 0] }, {});
  const out = b.node('composite.alphaOver', {}, { under: bg, over: shadow });
  b.output('out', out);
  b.expose('points', sam, 'points', 'Points')
    .expose('box', sam, 'box', 'Box')
    .expose('mask', sam, 'maskIndex', 'Mask')
    .expose('refine', sam, 'refine', 'Edge refine')
    .expose('feather', sam, 'feather', 'Edge feather')
    .expose('angle', shadow, 'angle', 'Shadow angle')
    .expose('distance', shadow, 'distance', 'Shadow distance')
    .expose('blur', shadow, 'blur', 'Shadow blur')
    .expose('opacity', shadow, 'opacity', 'Shadow opacity')
    .expose('background', bg, 'color', 'Background (alpha 0 = transparent)');
  return {
    id: 'ai.cutout',
    name: 'Cutout + Shadow (AI)',
    category: 'AI',
    tags: ['cutout', 'cut out', 'remove background', 'sticker', 'drop shadow', 'click select', 'sam', 'transparent', 'ai'],
    description: 'Click the object in the viewer (Click Select / SAM): it is cut out with transparency and gets a soft drop shadow. Export as PNG to keep the transparency, or give it a background colour.',
    group: b.toGroup('Cutout + Shadow (AI)'),
  };
}

export default (): PresetDef[] => [skySwap(), selectiveColor(), dramaticRelight(), cutout()];
