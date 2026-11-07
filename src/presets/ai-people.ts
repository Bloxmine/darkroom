/** Presets built on the people AI nodes (ai.faces, ai.faceRestore, ai.pose, ai.autoCrop). Models download on first use. */
import { GraphBuilder } from '../core/graph';
import type { PresetDef } from '../core/types';

/** Frequency-separation skin smoothing inside the face-skin mask (eyes, brows and lips stay sharp). */
function beautyRetouch(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const faces = b.node('ai.faces', { region: 'Face skin', feather: 6, dilate: -2 }, { image: img });
  const fs = b.node('filter.frequencySeparation', { radius: 5 }, { image: img });
  const smooth = b.node('filter.surfaceBlur', { radius: 12, threshold: 28 }, { image: { node: fs, port: 'low' } });
  // texture (high) back over the smoothed tones (linear light at 100 % = exact reconstruction), slightly softened
  const tex = b.node('composite.blend', { mode: 'linearLight', opacity: 0.85 }, { base: smooth, blend: { node: fs, port: 'high' } });
  const mix = b.node('composite.mix', { factor: 0.65 }, { a: img, b: tex, mask: { node: faces, port: 'features' } });
  b.output('out', mix);
  b.expose('amount', mix, 'factor', 'Amount')
    .expose('smoothing', smooth, 'radius', 'Smoothing radius')
    .expose('threshold', smooth, 'threshold', 'Edge threshold')
    .expose('texture', tex, 'opacity', 'Keep texture')
    .expose('detail', fs, 'radius', 'Detail size')
    .expose('feather', faces, 'feather', 'Mask feather')
    .expose('maxFaces', faces, 'maxFaces', 'Max faces');
  return {
    id: 'ai.beautyRetouch',
    name: 'Beauty Retouch (AI)',
    category: 'AI',
    tags: ['beauty', 'retouch', 'skin', 'smooth skin', 'frequency separation', 'portrait', 'face', 'ai'],
    description:
      'Skin retouch on every face: AI face landmarks (MediaPipe) select the face skin without eyes, brows and lips; inside it, frequency separation smooths blotchy tones ' +
      'with an edge-preserving surface blur and puts the pore texture back, at reduced strength so skin still looks like skin.',
    group: b.toGroup('Beauty Retouch (AI)'),
  };
}

/** Hair mask (Selfie Multiclass) → hue / saturation / lightness shift. */
function hairRecolor(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const pose = b.node('ai.pose', { part: 'Hair', feather: 2, refine: 0.85 }, { image: img });
  const hsl = b.node('color.hsl', { hue: -40, saturation: 0.35, lightness: 0 }, { image: img });
  const mix = b.node('composite.mix', { factor: 1 }, { a: img, b: hsl, mask: { node: pose, port: 'parts' } });
  b.output('out', mix);
  b.expose('hue', hsl, 'hue', 'Hue shift (°)')
    .expose('saturation', hsl, 'saturation', 'Saturation')
    .expose('lightness', hsl, 'lightness', 'Lightness')
    .expose('amount', mix, 'factor', 'Amount')
    .expose('feather', pose, 'feather', 'Mask feather')
    .expose('refine', pose, 'refine', 'Edge refine')
    .expose('part', pose, 'part', 'Recolor (part)');
  return {
    id: 'ai.hairRecolor',
    name: 'Hair Recolor (AI)',
    category: 'AI',
    tags: ['hair', 'hair color', 'recolor', 'dye', 'hue', 'portrait', 'ai'],
    description:
      'Changes hair colour: an AI segmenter (MediaPipe Selfie Multiclass) finds the hair, refined against the image edges, and a hue / saturation / lightness shift is applied only there. ' +
      'Switch the part to clothes or skin to recolor those instead.',
    group: b.toGroup('Hair Recolor (AI)'),
  };
}

/** Face restoration + a touch of grain so the restored faces sit in the photo. */
function restorePortrait(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const fr = b.node('ai.faceRestore', { strength: 0.8 }, { image: img });
  const grain = b.node('stylize.grain', { amount: 0.12, size: 1.4, roughness: 0.4, chroma: 0.1 }, { image: fr });
  b.output('out', grain);
  b.expose('strength', fr, 'strength', 'Restoration strength')
    .expose('maxFaces', fr, 'maxFaces', 'Max faces')
    .expose('small', fr, 'small', 'Include small faces')
    .expose('model', fr, 'model', 'Model')
    .expose('grain', grain, 'amount', 'Grain')
    .expose('grainSize', grain, 'size', 'Grain size');
  return {
    id: 'ai.restorePortrait',
    name: 'Restore Portrait (AI)',
    category: 'AI',
    tags: ['restore', 'old photo', 'face restoration', 'enhance', 'blurry face', 'restoreformer', 'gfpgan', 'ai'],
    description:
      'Brings blurry, small or compressed faces back: each face is restored by RestoreFormer++ (or GFPGAN) and blended in, then a subtle film grain ties the cleaner faces to the rest of the photo. ' +
      'Large one-time download (74 MB); fast on WebGPU, several seconds per face on CPU.',
    group: b.toGroup('Restore Portrait (AI)'),
  };
}

/** Darkened photo + glowing pose skeleton. */
function motionCapture(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const pose = b.node('ai.pose', { style: 'Motion capture', dim: 0.82, glow: 1.4, glowRadius: 30, thickness: 7, lineColor: [0.15, 0.95, 1, 1], jointColor: [1, 1, 1, 1] }, { image: img });
  const bloom = b.node('stylize.bloom', { threshold: 0.6, intensity: 0.5, radius: 50, tint: [0.6, 0.95, 1, 1] }, { image: { node: pose, port: 'overlay' } });
  b.output('out', bloom);
  b.expose('dim', pose, 'dim', 'Darken background')
    .expose('lineColor', pose, 'lineColor', 'Line colour')
    .expose('jointColor', pose, 'jointColor', 'Joint colour')
    .expose('thickness', pose, 'thickness', 'Thickness')
    .expose('glow', pose, 'glow', 'Glow')
    .expose('bloom', bloom, 'intensity', 'Bloom')
    .expose('style', pose, 'style', 'Skeleton style')
    .expose('maxPeople', pose, 'maxPeople', 'Max people');
  return {
    id: 'ai.motionCapture',
    name: 'Motion Capture (AI)',
    category: 'AI',
    tags: ['pose', 'skeleton', 'motion capture', 'mocap', 'neon', 'body', 'tron', 'ai'],
    description: 'A motion-capture look: AI pose estimation (MediaPipe) draws a glowing skeleton over every person on a darkened copy of the photo, with a cool bloom.',
    group: b.toGroup('Motion Capture (AI)'),
  };
}

/** Smart crop to Instagram portrait (4:5). */
function instagramCrop(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const crop = b.node('ai.autoCrop', { aspect: '4:5', mode: 'faces', padding: 0.05 }, { image: img });
  b.output('out', crop);
  b.expose('aspect', crop, 'aspect', 'Aspect')
    .expose('mode', crop, 'mode', 'Mode')
    .expose('zoom', crop, 'zoom', 'Zoom')
    .expose('padding', crop, 'padding', 'Padding')
    .expose('showOverlay', crop, 'showOverlay', 'Show crop overlay');
  return {
    id: 'ai.instagramCrop',
    name: 'Instagram Crop 4:5 (AI)',
    category: 'AI',
    tags: ['instagram', 'crop', 'auto crop', 'smart crop', '4:5', 'social', 'portrait', 'ai'],
    description: 'Crops to Instagram’s 4:5 portrait format where it looks best: faces kept whole with headroom, eyes near the upper third, the subject never cut in half.',
    group: b.toGroup('Instagram Crop 4:5 (AI)'),
  };
}

export default (): PresetDef[] => [beautyRetouch(), hairRecolor(), restorePortrait(), motionCapture(), instagramCrop()];
