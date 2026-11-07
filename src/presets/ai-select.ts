/**
 * Presets built on the AI selection / relighting nodes (Click Select, Scene Segmentation, Relight).
 * Click-select presets expose the hidden `points`/`box` params, so selecting the preset node shows the
 * point tool in the viewer; the relight presets expose `light` (and `light2`/`light3`), so their lights can
 * be dragged there too.
 */
import { GraphBuilder } from '../core/graph';
import type { Params, PresetDef } from '../core/types';
import { RIGS, rigParams, type Rig } from '../nodes/ai/relight-math';

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

/** Surface Normals → Relight (normals + depth from the same MoGe-2 pass). Returns [builder, input, relight id]. */
function relightBase(params: Params) {
  const b = new GraphBuilder();
  const img = b.input('image');
  const nm = b.node('ai.normals', {}, { image: img });
  const rl = b.node('ai.relight', params, { image: img, normals: { node: nm, port: 'normals' }, depth: { node: nm, port: 'depth' } });
  return { b, img, nm, rl };
}

function dramaticRelight(): PresetDef {
  const { b, rl } = relightBase({
    mode: 'Replace lighting',
    ambient: 0.2,
    intensity: 2.6,
    falloff: 1.2,
    height: 0.3,
    size: 0.15,
    light: [0.14, 0.2],
    color: [1, 0.84, 0.64, 1],
    shadowStrength: 0.9,
    specular: 0.25,
    roughness: 0.4,
    delight: 0.7,
    evenOut: 0.2,
    skyColor: [0.75, 0.82, 1, 1],
    groundColor: [0.5, 0.42, 0.38, 1],
    keepBackground: 0.25,
  });
  const vig = b.node('stylize.vignette', { amount: 0.25, radius: 0.75, softness: 0.8 }, { image: rl });
  b.output('out', vig);
  b.expose('light', rl, 'light', 'Light position')
    .expose('height', rl, 'height', 'Light height')
    .expose('intensity', rl, 'intensity', 'Intensity')
    .expose('color', rl, 'color', 'Light colour')
    .expose('ambient', rl, 'ambient', 'Ambient (rest)')
    .expose('falloff', rl, 'falloff', 'Falloff')
    .expose('shadows', rl, 'shadowStrength', 'Shadows')
    .expose('softness', rl, 'size', 'Shadow softness')
    .expose('delight', rl, 'delight', 'Remove old light')
    .expose('vignette', vig, 'amount', 'Vignette');
  return {
    id: 'ai.dramaticRelight',
    name: 'Dramatic Relight (AI)',
    category: 'AI',
    tags: ['relight', 'light', 'dramatic', 'moody', 'low key', 'depth', 'normals', 'shadow', 'ai'],
    description:
      'Removes most of the existing light and relights the photo from one low, warm lamp with soft shadows, using AI surface normals and depth (MoGe-2, runs in your browser). Select the preset and drag the light in the viewer.',
    group: b.toGroup('Dramatic Relight (AI)'),
  };
}

/**
 * A relight preset from a light rig (relight-math.ts RIGS): Surface Normals → Relight with the rig's
 * lights, plus an optional finishing node. The three light positions are exposed, so every light can be
 * dragged in the viewer while the preset is selected.
 */
function rigPreset(id: string, name: string, rig: Rig, description: string, tags: string[], extra: Params = {}, finish?: (b: GraphBuilder, rl: string) => string): PresetDef {
  const { b, rl } = relightBase({ mode: 'Replace lighting', ...rigParams(rig), ...extra });
  const out = finish ? finish(b, rl) : rl;
  b.output('out', out);
  const n = rig.lights.filter((l) => l.intensity > 0).length;
  b.expose('light', rl, 'light', 'Light 1 position');
  if (n > 1) b.expose('light2', rl, 'light2', 'Light 2 position');
  if (n > 2) b.expose('light3', rl, 'light3', 'Light 3 position');
  b.expose('intensity', rl, 'intensity', 'Light 1 intensity');
  if (n > 1) b.expose('intensity2', rl, 'intensity2', 'Light 2 intensity');
  if (n > 2) b.expose('intensity3', rl, 'intensity3', 'Light 3 intensity');
  b.expose('color', rl, 'color', 'Light 1 colour');
  if (n > 1) b.expose('color2', rl, 'color2', 'Light 2 colour');
  b.expose('ambient', rl, 'ambient', 'Ambient')
    .expose('shadows', rl, 'shadowStrength', 'Shadows')
    .expose('delight', rl, 'delight', 'Remove old light')
    .expose('amount', rl, 'amount', 'Amount');
  return { id, name, category: 'AI', tags: ['relight', 'light', 'lighting', 'normals', 'shadow', 'ai', ...tags], description, group: b.toGroup(name) };
}

const relightPresets = (): PresetDef[] => [
  rigPreset(
    'ai.studioPortrait',
    'Studio Portrait Light (AI)',
    RIGS.studio,
    'Classic studio lighting on any photo: a soft key light (spot) from the upper left, a cool fill from the right and a rim light from behind, with soft shadows from AI surface normals and depth. Drag the three lights in the viewer.',
    ['studio', 'portrait', 'key light', 'fill light', 'rim light', 'three-point', 'headshot'],
    { specular: 0.25, roughness: 0.4, wrap: 0.35 },
  ),
  rigPreset(
    'ai.rimLight',
    'Rim Light (AI)',
    RIGS.rim,
    'Two back lights outline the subject with cool and warm rims, the front stays dark: AI surface normals tell which edges face the lights. Drag the lights in the viewer.',
    ['rim', 'back light', 'edge light', 'silhouette', 'kicker', 'moody'],
    { specular: 0.1, wrap: 0.1, delight: 0.75 },
  ),
  rigPreset(
    'ai.goldenHourRelight',
    'Golden Hour Relight (AI)',
    RIGS.golden,
    'A low, warm sun from the side (directional) with long soft shadows and a cool sky fill. Drag the sun handle around the image to change where it comes from.',
    ['golden hour', 'sunset', 'sun', 'warm', 'sunlight', 'long shadows'],
    { wrap: 0.3, shadowStrength: 0.85, contact: 0.6, keepBackground: 0.55 },
    (b, rl) => b.node('color.vibranceSaturation', { vibrance: 0.15 }, { image: rl }),
  ),
  rigPreset(
    'ai.overheadNoon',
    'Overhead Noon Light (AI)',
    RIGS.noon,
    'Hard midday sun from almost straight above: short crisp shadows under brows, nose and chin, and a bright blue-sky ambient.',
    ['noon', 'midday', 'harsh light', 'overhead', 'sun', 'summer'],
    { shadowStrength: 0.9, contact: 0.8, specular: 0.2, roughness: 0.35, keepBackground: 0.85 },
  ),
  rigPreset(
    'ai.neonRelight',
    'Neon Two-Tone (AI)',
    RIGS.neon,
    'Magenta and cyan neon tubes left and right, the classic two-tone night-portrait look, on a dark ambient. Drag the two lights in the viewer and pick their colours.',
    ['neon', 'two-tone', 'cyberpunk', 'magenta', 'cyan', 'night', 'club', 'colour gel'],
    { specular: 0.35, roughness: 0.3, wrap: 0.25, delight: 0.8 },
  ),
  rigPreset(
    'ai.candleRelight',
    'Candlelight (AI)',
    RIGS.candle,
    'One warm, small candle-like light low in front with a fast falloff, everything else falls into darkness. Drag the flame in the viewer.',
    ['candle', 'candlelight', 'fire', 'warm', 'low key', 'night', 'chiaroscuro'],
    { wrap: 0.4, delight: 0.8, specular: 0.15 },
    (b, rl) => b.node('stylize.vignette', { amount: 0.35, radius: 0.7, softness: 0.85 }, { image: rl }),
  ),
];

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

export default (): PresetDef[] => [skySwap(), selectiveColor(), dramaticRelight(), cutout(), ...relightPresets()];
