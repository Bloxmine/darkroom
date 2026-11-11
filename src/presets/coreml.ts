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
import type { PresetDef } from '../core/types';

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

export default (): PresetDef[] => [restyle(), depthRestyle(), sketchToImage(), poseTransfer(), inpaint()];
