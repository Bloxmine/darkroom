/**
 * Core ML presets (Mac app, Preferences › Generation › Core ML (built-in)). They work with any backend, but are
 * tuned for the built-in engine: SD 1.5-family models with ControlNet at a fixed 512×512 (or 768×512 …) size, and
 * ControlNets referred to by kind ('canny', 'depth', …) so the variant matching the chosen model is picked
 * automatically (on ComfyUI / A1111 pick the file names under Generate instead).
 *
 * Style transfer here = a curated `style` prompt + img2img strength, held in shape by a structure ControlNet, then
 * optionally the colours of a reference image (color.matchColor) and AdaIN “style from image” (ai.styleFromImage,
 * off at mix 0) as finishing steps.
 */
import { GraphBuilder } from '../core/graph';
import type { Params, PresetDef } from '../core/types';

const CATEGORY = 'Core ML';
const NEG = 'blurry, lowres, deformed, disfigured, bad anatomy, watermark, text, signature';

function exposeGen(b: GraphBuilder, gen: string, units: { i: number; label: string }[], img2img: boolean) {
  b.expose('positive', gen, 'positive', 'Prompt')
    .expose('style', gen, 'style', 'Style')
    .expose('negative', gen, 'negative', 'Negative prompt')
    .expose('checkpoint', gen, 'checkpoint', 'Model')
    .expose('fit', gen, 'fit', 'Fit');
  if (img2img) b.expose('denoise', gen, 'denoise', 'Strength (img2img)');
  for (const u of units) b.expose(`cn${u.i}Weight`, gen, `cn${u.i}Weight`, `${u.label} weight`).expose(`cn${u.i}Model`, gen, `cn${u.i}Model`, `${u.label} ControlNet`);
  b.expose('seed', gen, 'seed', 'Seed')
    .expose('steps', gen, 'steps', 'Steps')
    .expose('cfg', gen, 'cfg', 'CFG scale')
    .expose('autoRun', gen, 'autoRun', 'Auto-run')
    .expose('run', gen, 'run', 'Run token', { hidden: true });
}

/** gen → colour of the reference (identity without one) → AdaIN style of the reference (off by default). */
function finish(b: GraphBuilder, gen: string, ref: string) {
  const color = b.node('color.matchColor', { amount: 1, luminance: 0.3 }, { image: gen, reference: ref });
  const adain = b.node('ai.styleFromImage', { mix: 0, strength: 0.6, preserveColor: true }, { image: color, style: ref });
  b.expose('colorAmount', color, 'amount', 'Colour from reference').expose('adain', adain, 'mix', 'Style from image (AdaIN, 0 = off)');
  return adain;
}

function restyle(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const ref = b.input('reference');
  const canny = b.node('control.canny', { lowThreshold: 100, highThreshold: 200 }, { image: img });
  const tile = b.node('control.tile', {}, { image: img });
  const gen = b.node(
    'sd.generate',
    {
      positive: 'a woman paddling a canoe on a turquoise mountain lake, pine forest',
      style: 'oil painting',
      negative: NEG,
      denoise: 0.7,
      steps: 20,
      cfg: 7.5,
      sampler: 'dpm++ karras',
      cn1Model: 'canny',
      cn1Weight: 0.85,
      cn2Model: 'tile',
      cn2Weight: 0,
      fit: 'letterbox',
    },
    { image: img, control1: canny, control2: tile },
  );
  b.output('out', finish(b, gen, ref));
  exposeGen(b, gen, [{ i: 1, label: 'Structure (canny)' }, { i: 2, label: 'Detail (tile, 0 = off)' }], true);
  b.expose('low', canny, 'lowThreshold', 'Canny low').expose('high', canny, 'highThreshold', 'Canny high');
  return {
    id: 'coreml.restyle',
    name: 'Restyle (Core ML)',
    category: CATEGORY,
    tags: ['core ml', 'coreml', 'neural engine', 'style transfer', 'restyle', 'stable diffusion', 'controlnet', 'canny', 'img2img', 'oil painting', 'watercolor', 'anime', 'sketch', 'pixel art'],
    description:
      'Re-paints the photo in a style on this Mac with the built-in Core ML engine: a curated Style (oil painting, watercolor, anime cel, pencil sketch, cinematic photo, pixel art, riso print…) + img2img, ' +
      'held in shape by a canny ControlNet (optionally tile for detail). Connect a reference image to take over its colours, and raise “Style from image” for AdaIN brushwork from it. ' +
      'Choose Core ML (built-in) in Preferences › Generation, download SD 1.5 + the canny ControlNet there, then select this node and press Generate.',
    group: b.toGroup('Restyle (Core ML)'),
  };
}

function depthRestyle(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const ref = b.input('reference');
  const depth = b.node('control.depth', {}, { image: img });
  const gen = b.node(
    'sd.generate',
    { positive: 'a scene', style: 'watercolor', negative: NEG, denoise: 0.85, steps: 20, cfg: 7.5, sampler: 'dpm++ karras', cn1Model: 'depth', cn1Weight: 1, fit: 'letterbox' },
    { image: img, control1: depth },
  );
  b.output('out', finish(b, gen, ref));
  exposeGen(b, gen, [{ i: 1, label: 'Depth' }], true);
  return {
    id: 'coreml.depthRestyle',
    name: 'Depth Restyle (Core ML)',
    category: CATEGORY,
    tags: ['core ml', 'coreml', 'depth', 'controlnet', 'restyle', 'style transfer', 'stable diffusion', 'img2img'],
    description:
      'A looser restyle: the photo’s depth map (computed locally) keeps the space and layout while a high img2img strength lets the style change shapes and textures. ' +
      'Needs the depth ControlNet (Preferences › Generation › Core ML). Optional reference image for colours / AdaIN.',
    group: b.toGroup('Depth Restyle (Core ML)'),
  };
}

function sketchToImage(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const scribble = b.node('control.scribble', {}, { image: img });
  const gen = b.node(
    'sd.generate',
    { positive: 'a cozy cabin by a lake at dusk, detailed, warm light', style: 'cinematic photo', negative: NEG, steps: 25, cfg: 7.5, sampler: 'dpm++ karras', cn1Model: 'scribble', cn1Weight: 1, fit: 'letterbox' },
    { control1: scribble },
  );
  b.output('out', gen);
  exposeGen(b, gen, [{ i: 1, label: 'Sketch' }], false);
  b.expose('thickness', scribble, 'thickness', 'Stroke thickness');
  return {
    id: 'coreml.sketchToImage',
    name: 'Sketch to Image (Core ML)',
    category: CATEGORY,
    tags: ['core ml', 'coreml', 'scribble', 'sketch', 'drawing', 'lineart', 'controlnet', 'txt2img', 'stable diffusion'],
    description:
      'Turns a sketch, doodle or line drawing into a picture (txt2img guided by the scribble ControlNet). Describe the scene in the prompt; pick a Style. ' +
      'For clean line art set the ControlNet to “lineart”. Needs the scribble (or lineart) ControlNet.',
    group: b.toGroup('Sketch to Image (Core ML)'),
  };
}

function poseTransfer(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const pose = b.node('control.openpose', { preprocessor: 'openpose_full' }, { image: img });
  const gen = b.node(
    'sd.generate',
    { positive: 'an astronaut in a white spacesuit, studio photo', style: 'cinematic photo', negative: NEG, steps: 25, cfg: 7.5, sampler: 'dpm++ karras', cn1Model: 'openpose', cn1Weight: 1, fit: 'letterbox' },
    { control1: pose },
  );
  b.output('out', gen);
  exposeGen(b, gen, [{ i: 1, label: 'Pose' }], false);
  b.expose('poseMode', pose, 'preprocessor', 'OpenPose mode');
  return {
    id: 'coreml.poseTransfer',
    name: 'Pose Transfer (Core ML)',
    category: CATEGORY,
    tags: ['core ml', 'coreml', 'openpose', 'pose', 'controlnet', 'txt2img', 'character', 'stable diffusion'],
    description: 'A new image in the same pose: the photo’s OpenPose skeleton (computed locally) drives the OpenPose ControlNet on this Mac. Needs the OpenPose ControlNet.',
    group: b.toGroup('Pose Transfer (Core ML)'),
  };
}

function inpaint(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const mask = b.input('mask', 'mask');
  const m = b.node('control.inpaintMask', { grow: 8, feather: 4 }, { image: img, mask });
  const gen = b.node(
    'sd.generate',
    { positive: 'a small wooden rowing boat', negative: NEG, denoise: 1, steps: 25, cfg: 7.5, sampler: 'dpm++ karras', cn1Model: 'inpaint', cn1Weight: 1, fit: 'letterbox' },
    { image: img, mask: m, control1: img },
  );
  b.output('out', gen);
  exposeGen(b, gen, [{ i: 1, label: 'Inpaint' }], true);
  b.expose('grow', m, 'grow', 'Grow mask').expose('feather', m, 'feather', 'Feather mask');
  return {
    id: 'coreml.inpaint',
    name: 'Inpaint (Core ML)',
    category: CATEGORY,
    tags: ['core ml', 'coreml', 'inpaint', 'inpainting', 'mask', 'remove', 'replace', 'controlnet', 'stable diffusion'],
    description:
      'Replaces the masked area (white = regenerate) with what the prompt describes, blended into the photo: latent-mask inpainting guided by the inpaint ControlNet; pixels outside the mask are kept exactly. ' +
      'Connect a mask (e.g. from Select Subject or a painted mask). Needs the inpaint ControlNet; set its weight to 0 to inpaint without it.',
    group: b.toGroup('Inpaint (Core ML)'),
  };
}

/** Shared shape for the per-ControlNet presets below. */
interface Spec {
  id: string;
  name: string;
  tags: string[];
  description: string;
  /** img2img strength; undefined = txt2img (the control maps alone drive the picture). */
  denoise?: number;
  positive: string;
  style: string;
  /** Up to 3 ControlNet units: preprocessor node (+ params) fed from `src`, the ControlNet kind and its weight. */
  units: { label: string; pre: string | null; params?: Params; src?: 'image' | 'reference'; kind: string; weight: number; expose?: [string, string, string][] }[];
  /** Take colours / AdaIN from the reference input at the end (adds the `reference` input). */
  finishWithReference?: boolean;
  cfg?: number;
  steps?: number;
}

function controlPreset(sp: Spec): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const needsRef = sp.finishWithReference || sp.units.some((u) => u.src === 'reference');
  const ref = needsRef ? b.input('reference') : null;
  const controls: Record<string, string> = {};
  const preNodes: string[] = [];
  sp.units.forEach((u, i) => {
    const from = u.src === 'reference' ? ref! : img;
    const node = u.pre ? b.node(u.pre, u.params ?? {}, { image: from }) : from; // pre = null: the image itself is the control (ip2p)
    controls[`control${i + 1}`] = node;
    preNodes.push(node);
  });
  const params: Params = { positive: sp.positive, style: sp.style, negative: NEG, steps: sp.steps ?? 22, cfg: sp.cfg ?? 7.5, sampler: 'dpm++ karras', fit: 'letterbox' };
  sp.units.forEach((u, i) => {
    params[`cn${i + 1}Model`] = u.kind;
    params[`cn${i + 1}Weight`] = u.weight;
  });
  if (sp.denoise !== undefined) params.denoise = sp.denoise;
  const gen = b.node('sd.generate', params, { ...(sp.denoise !== undefined ? { image: img } : {}), ...controls });
  b.output('out', sp.finishWithReference && ref ? finish(b, gen, ref) : gen);
  exposeGen(b, gen, sp.units.map((u, i) => ({ i: i + 1, label: u.label })), sp.denoise !== undefined);
  sp.units.forEach((u, i) => u.expose?.forEach(([key, param, label]) => b.expose(key, preNodes[i], param, label)));
  return { id: sp.id, name: sp.name, category: CATEGORY, tags: ['core ml', 'coreml', 'controlnet', 'stable diffusion', ...sp.tags], description: sp.description, group: b.toGroup(sp.name) };
}

const NEEDS = (kinds: string) => ` Needs the ${kinds} ControlNet${kinds.includes(' + ') ? 's' : ''} (Preferences › Generation › Core ML). Select the node and press Generate.`;

const MORE: Spec[] = [
  {
    id: 'coreml.softEdgeRestyle',
    name: 'Soft Edge Restyle (Core ML)',
    tags: ['softedge', 'hed', 'pidinet', 'restyle', 'painterly', 'img2img'],
    description:
      'A painterly restyle that follows the photo’s soft outlines (HED-style edges) instead of hard Canny lines: shapes stay recognisable while brushwork and texture are free to change. Good for impressionist / watercolour looks.' +
      NEEDS('softedge'),
    denoise: 0.75,
    positive: 'a scene',
    style: 'impressionist',
    units: [{ label: 'Soft edge', pre: 'control.softEdge', params: { detail: 0.4 }, kind: 'softedge', weight: 0.9, expose: [['edgeDetail', 'detail', 'Edge detail']] }],
    finishWithReference: true,
  },
  {
    id: 'coreml.lineartIllustration',
    name: 'Line Art Illustration (Core ML)',
    tags: ['lineart', 'line art', 'illustration', 'comic', 'ink', 'drawing'],
    description:
      'Traces the photo into clean line art (Informative Drawings, computed locally) and redraws it as an illustration that keeps every contour. Try the “ink comic”, “ukiyo-e” or “watercolor” styles.' + NEEDS('lineart'),
    denoise: 0.8,
    positive: 'detailed illustration',
    style: 'ink comic',
    units: [{ label: 'Line art', pre: 'control.lineart', params: { model: 'Realistic (sk_model)' }, kind: 'lineart', weight: 1, expose: [['lineModel', 'model', 'Line extractor']] }],
  },
  {
    id: 'coreml.animeFromPhoto',
    name: 'Anime From Photo (Core ML)',
    tags: ['anime', 'lineart_anime', 'manga', 'cel', 'cartoon', 'character'],
    description:
      'Turns a photo into an anime key visual: the photo’s line art drives the anime line-art ControlNet, with cel shading and flat colours from the “anime cel” style. Works best with an anime-style SD 1.5 model, but the base model is fine too.' +
      NEEDS('lineart_anime'),
    denoise: 0.8,
    positive: 'anime girl, detailed eyes, vibrant colours',
    style: 'anime cel',
    units: [{ label: 'Anime line art', pre: 'control.lineart', params: { model: 'Realistic (sk_model)' }, kind: 'lineart_anime', weight: 1 }],
  },
  {
    id: 'coreml.interiorRedesign',
    name: 'Interior / Architecture Redesign (Core ML)',
    tags: ['mlsd', 'straight lines', 'architecture', 'interior', 'room', 'building', 'redesign', 'depth'],
    description:
      'Keeps the straight lines of a room or building (M-LSD) and its depth, and redesigns everything else from the prompt: furniture, materials, era, lighting. Describe the new design in the prompt.' + NEEDS('mlsd + depth'),
    positive: 'bright scandinavian living room, light oak floor, white walls, linen sofa, plants, soft daylight, architectural photography',
    style: 'cinematic photo',
    units: [
      { label: 'Straight lines', pre: 'control.mlsd', kind: 'mlsd', weight: 1, expose: [['lineThreshold', 'scoreThreshold', 'Line threshold']] },
      { label: 'Depth', pre: 'control.depth', kind: 'depth', weight: 0.5 },
    ],
  },
  {
    id: 'coreml.materialSwap',
    name: 'Material Swap (Core ML)',
    tags: ['normalbae', 'normal map', 'material', 'statue', 'marble', 'bronze', 'surface', '3d'],
    description:
      'Keeps the 3D surface shape of everything (a normal map, computed locally) and changes what it is made of — marble, bronze, porcelain, wood, ice… Describe the material in the prompt.' + NEEDS('normalbae'),
    positive: 'a carved white marble sculpture, polished stone, museum lighting',
    style: 'none',
    units: [{ label: 'Surface normals', pre: 'control.normal', kind: 'normalbae', weight: 1 }],
  },
  {
    id: 'coreml.sceneRemix',
    name: 'Scene Remix (Segmentation) (Core ML)',
    tags: ['seg', 'segmentation', 'ade20k', 'layout', 'remix', 'landscape', 'fantasy'],
    description:
      'Keeps the layout of the scene — where the sky, water, trees, people and buildings are (semantic segmentation, computed locally) — and reimagines all of it from the prompt.' + NEEDS('seg'),
    positive: 'an alien planet, purple bioluminescent forest, two moons, glowing lake, science fiction concept art',
    style: 'cinematic photo',
    units: [{ label: 'Layout (segmentation)', pre: 'control.seg', kind: 'seg', weight: 1 }],
  },
  {
    id: 'coreml.styleFromReference',
    name: 'Style From Reference (Shuffle) (Core ML)',
    tags: ['shuffle', 'reference', 'style transfer', 'colours', 'mood', 'canny', 'img2img'],
    description:
      'Style transfer from a picture: connect a painting or photo to “reference”. The shuffle ControlNet takes over its colours, textures and mood, while a Canny ControlNet keeps the shapes of your photo. Raise the shuffle weight for more of the reference.' +
      NEEDS('shuffle + canny'),
    denoise: 0.7,
    positive: 'a painting',
    style: 'none',
    units: [
      { label: 'Reference style (shuffle)', pre: 'control.shuffle', src: 'reference', kind: 'shuffle', weight: 0.8, expose: [['shuffleFrequency', 'frequency', 'Shuffle cell size']] },
      { label: 'Structure (canny)', pre: 'control.canny', kind: 'canny', weight: 0.75 },
    ],
  },
  {
    id: 'coreml.instructEdit',
    name: 'Instruct Edit (Pix2Pix) (Core ML)',
    tags: ['ip2p', 'instruct', 'pix2pix', 'edit', 'instruction', 'season', 'weather'],
    description:
      'Edit with an instruction: write what should change as the prompt (“make it winter”, “turn it into a night scene”, “make it look like an old photograph”). The photo itself is the Instruct-Pix2Pix ControlNet input.' +
      NEEDS('ip2p'),
    positive: 'make it winter, snow on the trees and the canoe',
    style: 'none',
    cfg: 7,
    units: [{ label: 'Instruction', pre: null, kind: 'ip2p', weight: 1 }],
  },
  {
    id: 'coreml.faithfulRestyle',
    name: 'Faithful Restyle (Canny + Depth) (Core ML)',
    tags: ['canny', 'depth', 'faithful', 'restyle', 'style transfer', 'img2img'],
    description:
      'The most faithful restyle: Canny keeps the outlines and depth keeps the space, so you can push the img2img strength high for a strong style without losing the composition.' + NEEDS('canny + depth'),
    denoise: 0.85,
    positive: 'a scene',
    style: 'watercolor',
    units: [
      { label: 'Outlines (canny)', pre: 'control.canny', kind: 'canny', weight: 0.7 },
      { label: 'Depth', pre: 'control.depth', kind: 'depth', weight: 0.6 },
    ],
    finishWithReference: true,
  },
  {
    id: 'coreml.characterSwap',
    name: 'Character Swap (Pose + Depth) (Core ML)',
    tags: ['openpose', 'depth', 'character', 'costume', 'person', 'swap', 'txt2img'],
    description:
      'Replaces the person with someone or something else in exactly the same pose and place: OpenPose fixes the body, depth fixes the scene around it. Describe the new character in the prompt.' + NEEDS('openpose + depth'),
    positive: 'a medieval knight in shining plate armour, red cape',
    style: 'cinematic photo',
    units: [
      { label: 'Pose', pre: 'control.openpose', params: { preprocessor: 'openpose_full' }, kind: 'openpose', weight: 1 },
      { label: 'Depth', pre: 'control.depth', kind: 'depth', weight: 0.55 },
    ],
  },
  {
    id: 'coreml.colorizeDrawing',
    name: 'Colour a Drawing (Core ML)',
    tags: ['lineart', 'drawing', 'colouring', 'coloring', 'sketch', 'manga', 'reference'],
    description:
      'Colours in a line drawing or manga page: the coarse line extractor follows your strokes and the prompt / style choose the colouring. Connect a reference image to borrow its palette.' + NEEDS('lineart'),
    positive: 'beautifully coloured illustration, soft shading',
    style: 'watercolor',
    units: [{ label: 'Drawing lines', pre: 'control.lineart', params: { model: 'Coarse (sk_model2)' }, kind: 'lineart', weight: 1.1 }],
    finishWithReference: true,
  },
];

export default (): PresetDef[] => [restyle(), depthRestyle(), sketchToImage(), poseTransfer(), inpaint(), ...MORE.map(controlPreset)];
