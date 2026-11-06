/** Presets built on the in-browser AI nodes (src/nodes/ai). Models download on first use. */
import { GraphBuilder } from '../core/graph';
import type { PresetDef } from '../core/types';

function portraitBokeh(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const subj = b.node('ai.subjectMask', { invert: true, refine: 0.85, feather: 1.5 }, { image: img });
  const blur = b.node('filter.lensBlur', { radius: 22, boost: 2.5, threshold: 0.7 }, { image: img, amount: { node: subj, port: 'mask' } });
  const vig = b.node('stylize.vignette', { amount: 0.2, radius: 0.8, softness: 0.8 }, { image: blur });
  b.output('out', vig);
  b.expose('blur', blur, 'radius', 'Background blur')
    .expose('bokeh', blur, 'boost', 'Bokeh highlights')
    .expose('blades', blur, 'blades', 'Aperture blades (0 = round)')
    .expose('model', subj, 'model', 'Subject model')
    .expose('threshold', subj, 'threshold', 'Mask threshold')
    .expose('softness', subj, 'softness', 'Mask softness')
    .expose('feather', subj, 'feather', 'Mask feather')
    .expose('vignette', vig, 'amount', 'Vignette');
  return {
    id: 'ai.portraitBokeh',
    name: 'Portrait Bokeh (AI)',
    category: 'AI',
    tags: ['portrait mode', 'bokeh', 'background blur', 'depth of field', 'ai', 'subject', 'phone'],
    description:
      'Phone-style portrait mode: an AI subject mask (MODNet, runs in your browser) keeps the person sharp while the background gets a lens blur with bokeh highlights, plus a subtle vignette. ' +
      'Switch the model to Object for non-human subjects.',
    group: b.toGroup('Portrait Bokeh (AI)'),
  };
}

function trueMiniature(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const d = b.node('ai.depth', {}, { image: img });
  const ts = b.node('effects.tiltShift', { focusDepth: 0.82, width: 0.2, falloff: 0.25, blur: 16, saturation: 1.4, contrast: 1.12 }, { image: img, depth: { node: d, port: 'depth' } });
  b.output('out', ts);
  b.expose('focus', ts, 'focusDepth', 'Focus depth (near = 1)')
    .expose('width', ts, 'width', 'In-focus depth range')
    .expose('falloff', ts, 'falloff', 'Falloff')
    .expose('blur', ts, 'blur', 'Max blur')
    .expose('saturation', ts, 'saturation', 'Saturation')
    .expose('showMask', ts, 'showMask', 'Show focus mask')
    .expose('resolution', d, 'resolution', 'Depth inference size');
  return {
    id: 'ai.trueMiniature',
    name: 'True Miniature (AI)',
    category: 'AI',
    tags: ['tilt shift', 'miniature', 'diorama', 'toy', 'depth', 'ai'],
    description:
      'Tilt-shift miniature driven by a real AI depth map (Depth Anything V2) instead of a straight band: everything at the focus depth stays sharp, nearer and farther things blur, so buildings and people keep their shapes.',
    group: b.toGroup('True Miniature (AI)'),
  };
}

function depth3d(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const d = b.node('ai.depth', { smoothing: 0.6 }, { image: img });
  const ana = b.node('effects.anaglyph', { encoding: 'Dubois', separation: 18, focus: 0.45 }, { image: img, depth: { node: d, port: 'depth' } });
  b.output('out', ana);
  b.expose('separation', ana, 'separation', 'Depth strength')
    .expose('focus', ana, 'focus', 'Screen plane depth')
    .expose('encoding', ana, 'encoding', 'Encoding')
    .expose('gamma', d, 'gamma', 'Depth gamma')
    .expose('showDepth', ana, 'showDepth', 'Show depth map');
  return {
    id: 'ai.depth3d',
    name: 'Real 3D Anaglyph (AI)',
    category: 'AI',
    tags: ['anaglyph', '3d', 'stereo', 'red cyan', 'depth', 'ai'],
    description: 'Red/cyan 3D from a real AI depth map (Depth Anything V2) instead of a guess: each eye view is shifted by true scene depth. Put on the glasses.',
    group: b.toGroup('Real 3D Anaglyph (AI)'),
  };
}

function foggyMorning(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const d = b.node('ai.depth', {}, { image: img });
  const fog = b.node('ai.depthFog', { density: 0.55, start: 0.12, curve: 1.6, color: [0.9, 0.88, 0.84, 1], soften: 5, desaturate: 0.45 }, { image: img, depth: { node: d, port: 'depth' } });
  const glow = b.node('filter.glow', { radius: 70, intensity: 0.35, threshold: 0.45, mode: 'screen', tint: [1, 0.93, 0.8, 1] }, { image: fog });
  const wb = b.node('color.whiteBalance', { temperature: 0.1 }, { image: glow });
  b.output('out', wb);
  b.expose('density', fog, 'density', 'Fog density')
    .expose('start', fog, 'start', 'Fog start')
    .expose('curve', fog, 'curve', 'Falloff curve')
    .expose('color', fog, 'color', 'Fog colour')
    .expose('soften', fog, 'soften', 'Soften far')
    .expose('glow', glow, 'intensity', 'Soft light')
    .expose('warmth', wb, 'temperature', 'Warmth');
  return {
    id: 'ai.foggyMorning',
    name: 'Foggy Morning (AI)',
    category: 'AI',
    tags: ['fog', 'mist', 'haze', 'morning', 'atmosphere', 'depth', 'ai', 'soft light'],
    description: 'Morning mist that thickens with real distance (AI depth map → depth fog), then a warm soft glow over the highlights.',
    group: b.toGroup('Foggy Morning (AI)'),
  };
}

export default (): PresetDef[] => [portraitBokeh(), trueMiniature(), depth3d(), foggyMorning()];
