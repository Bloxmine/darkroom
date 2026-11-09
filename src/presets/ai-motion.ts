/**
 * Presets built on the motion / style / matting AI nodes (src/nodes/ai/{flow,flowEffects,styleImage,matting}.ts).
 * Models download on first use (consent prompt above the size limit). The flow presets need a moving
 * image (a Video or Webcam node): on a still, frame 0, they pass the image through.
 */
import { GraphBuilder } from '../core/graph';
import type { PresetDef } from '../core/types';

function datamoshVideo(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const flow = b.node('ai.opticalFlow', { model: 'NeuFlow v2 (fast)', refine: 0 }, { b: img });
  const mosh = b.node('effects.datamosh', { keyframe: 0, block: 16, gain: 1, bleed: 0.02 }, { image: img, flow: { node: flow, port: 'flow' } });
  b.output('out', mosh);
  b.expose('keyframe', mosh, 'keyframe', 'I-frame every (frames)')
    .expose('block', mosh, 'block', 'Macroblock (px)')
    .expose('gain', mosh, 'gain', 'Motion gain')
    .expose('bleed', mosh, 'bleed', 'Bleed (real frame)')
    .expose('mix', mosh, 'mix', 'Mix')
    .expose('model', flow, 'model', 'Flow model');
  return {
    id: 'ai.datamoshVideo',
    name: 'Datamosh (AI flow)',
    category: 'AI',
    tags: ['datamosh', 'glitch', 'mosh', 'i-frame', 'video', 'optical flow', 'melt', 'motion'],
    description:
      'The I-frame-removal glitch on a video: AI optical flow (NeuFlow v2) drives a P-frame smear of the previous output, in macroblocks, so the picture melts into the motion. ' +
      'Play the timeline (Every frame for best results) or export a video; a still passes through. Set an I-frame interval to snap back periodically.',
    group: b.toGroup('Datamosh (AI flow)'),
  };
}

function motionBlurFlow(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const flow = b.node('ai.opticalFlow', { model: 'NeuFlow v2 (fast)', refine: 0.6 }, { b: img });
  const blur = b.node('effects.flowMotionBlur', { shutter: 180, amount: 1, samples: 24 }, { image: img, flow: { node: flow, port: 'flow' } });
  b.output('out', blur);
  b.expose('shutter', blur, 'shutter', 'Shutter angle (°)')
    .expose('amount', blur, 'amount', 'Motion scale')
    .expose('maxBlur', blur, 'maxBlur', 'Max blur (px)')
    .expose('samples', blur, 'samples', 'Samples')
    .expose('centered', blur, 'centered', 'Centred')
    .expose('model', flow, 'model', 'Flow model')
    .expose('refine', flow, 'refine', 'Edge refine');
  return {
    id: 'ai.motionBlurFlow',
    name: 'Motion Blur (AI flow)',
    category: 'AI',
    tags: ['motion blur', 'shutter', 'optical flow', 'video', 'cinematic', 'speed', 'raft', 'neuflow'],
    description:
      'Real per-pixel motion blur for video: AI optical flow (NeuFlow v2, or RAFT) between consecutive frames, then a directional blur along each motion vector with a film-camera shutter angle (180° = natural). ' +
      'Turn up Motion scale for a long-exposure smear. Needs a moving image; a still passes through.',
    group: b.toGroup('Motion Blur (AI flow)'),
  };
}

function paintingFromImage(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const style = b.input('style');
  const st = b.node('ai.styleFromImage', { strength: 0.85, styleScale: '512', resolution: '768' }, { image: img, style });
  const vib = b.node('color.vibranceSaturation', { vibrance: 0.15, saturation: 0 }, { image: st });
  const grain = b.node('stylize.grain', { amount: 0.06, size: 1.4 }, { image: vib });
  b.output('out', grain);
  b.expose('strength', st, 'strength', 'Style strength')
    .expose('styleScale', st, 'styleScale', 'Brush scale (style size)')
    .expose('resolution', st, 'resolution', 'Detail (content size)')
    .expose('preserveColor', st, 'preserveColor', 'Keep photo colours')
    .expose('mix', st, 'mix', 'Mix with photo')
    .expose('vibrance', vib, 'vibrance', 'Vibrance')
    .expose('grain', grain, 'amount', 'Canvas grain');
  return {
    id: 'ai.paintingFromImage',
    name: 'Painting from Image (AI)',
    category: 'AI',
    tags: ['style transfer', 'painting', 'arbitrary style', 'adain', 'van gogh', 'art', 'artistic'],
    description:
      'Repaints the photo in the style of any painting you connect to the `style` input (AdaIN arbitrary style transfer), with a touch of vibrance and canvas grain. ' +
      'Brush scale resizes the style image: smaller = bigger strokes.',
    group: b.toGroup('Painting from Image (AI)'),
  };
}

function hairCutout(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const m = b.node('ai.matte', { resolution: 'High detail (512 + 3×3 tiles)', refine: 0.3, decontaminate: 1 }, { image: img });
  const bg = b.node('input.solidColor', { color: [1, 1, 1, 0] }, {});
  const out = b.node('composite.alphaOver', {}, { under: bg, over: { node: m, port: 'cutout' } });
  b.output('out', out);
  b.expose('resolution', m, 'resolution', 'Resolution')
    .expose('refine', m, 'refine', 'Edge refine')
    .expose('threshold', m, 'threshold', 'Threshold')
    .expose('softness', m, 'softness', 'Softness')
    .expose('decontaminate', m, 'decontaminate', 'Colour decontamination')
    .expose('spillRadius', m, 'spillRadius', 'Decontamination radius')
    .expose('background', bg, 'color', 'Background (alpha 0 = transparent)');
  return {
    id: 'ai.hairCutout',
    name: 'Hair-Detail Cutout (AI)',
    category: 'AI',
    tags: ['background removal', 'cutout', 'hair', 'matting', 'birefnet', 'transparent', 'portrait', 'product'],
    description:
      'Removes the background with BiRefNet in high-detail mode (global pass + edge tiles) and decontaminates the edge colours, so hair and fur keep their strands without a halo of the old background. ' +
      'Pick a background colour, or leave its alpha at 0 for a transparent PNG.',
    group: b.toGroup('Hair-Detail Cutout (AI)'),
  };
}

export default (): PresetDef[] => [datamoshVideo(), motionBlurFlow(), paintingFromImage(), hairCutout()];
