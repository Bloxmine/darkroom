import { GraphBuilder } from '../core/graph';
import type { PresetDef } from '../core/types';

function pico8(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const p = b.node('effects.paletteQuantize', { palette: 'PICO-8', cells: 128, dither: 'Bayer 4×4', ditherAmount: 0.6, contrast: 1.15, saturation: 1.3, brightness: 0.02, perceptual: true }, { image: img });
  b.output('out', p);
  b.expose('pixels', p, 'cells', 'Pixels across')
    .expose('dither', p, 'dither', 'Dither')
    .expose('ditherAmount', p, 'ditherAmount', 'Dither strength')
    .expose('brightness', p, 'brightness', 'Brightness')
    .expose('contrast', p, 'contrast', 'Contrast')
    .expose('saturation', p, 'saturation', 'Saturation');
  return {
    id: 'fun.pico8',
    name: 'PICO-8',
    category: 'Fun',
    tags: ['pico-8', 'pixel art', 'fantasy console', '16 colours', 'retro', 'game'],
    description: 'The PICO-8 fantasy console: 128 pixels across, its fixed 16-colour palette matched perceptually, light Bayer dithering.',
    group: b.toGroup('PICO-8'),
  };
}

function macPaint(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const sharp = b.node('filter.sharpen', { amount: 0.8, radius: 1.5 }, { image: img });
  const d = b.node('effects.ditherDiffusion', { palette: 'Mac Plus (1-bit)', cells: 512, kernel: 'Atkinson', strength: 1, contrast: 1.15, brightness: 0.03, serpentine: true, noise: 0.03 }, { image: sharp });
  b.output('out', d);
  b.expose('pixels', d, 'cells', 'Pixels across')
    .expose('kernel', d, 'kernel', 'Dither kernel')
    .expose('brightness', d, 'brightness', 'Brightness')
    .expose('contrast', d, 'contrast', 'Contrast')
    .expose('strength', d, 'strength', 'Error strength');
  return {
    id: 'fun.macPaint',
    name: 'MacPaint (1-bit Mac Plus)',
    category: 'Fun',
    tags: ['mac', 'macintosh', 'macpaint', '1-bit', 'atkinson', 'dither', '1984', 'black and white'],
    description: 'A 1984 Macintosh screen: 512 pixels across, pure black & white, Bill Atkinson\'s error diffusion (crisp highlights, deep shadows) after a touch of sharpening.',
    group: b.toGroup('MacPaint'),
  };
}

function miniature(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const sharp = b.node('filter.sharpen', { amount: 0.6, radius: 1.5 }, { image: img });
  const ts = b.node('effects.tiltShift', { center: 0.62, angle: 0, width: 0.1, falloff: 0.32, blur: 20, bokeh: 0.6, saturation: 1.45, contrast: 1.15 }, { image: sharp });
  const vig = b.node('stylize.vignette', { amount: 0.18, radius: 0.8, softness: 0.8 }, { image: ts });
  b.output('out', vig);
  b.expose('focus', ts, 'center', 'Focus position')
    .expose('angle', ts, 'angle', 'Band angle')
    .expose('width', ts, 'width', 'Sharp band')
    .expose('blur', ts, 'blur', 'Blur')
    .expose('saturation', ts, 'saturation', 'Toy colours')
    .expose('bokeh', ts, 'bokeh', 'Bokeh');
  return {
    id: 'fun.miniature',
    name: 'Miniature (Tilt-Shift)',
    category: 'Fun',
    tags: ['tilt shift', 'miniature', 'toy town', 'diorama', 'model'],
    description: 'Makes a real scene look like a toy model: crisp focus band, strong lens blur above and below, punchy toy colours. Works best on scenes shot from above.',
    group: b.toGroup('Miniature'),
  };
}

function glasses3d(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const a = b.node('effects.anaglyph', { depthMode: 'Depth guess', separation: 26, focus: 0.45, verticalCue: 0.6, encoding: 'Colour' }, { image: img });
  b.output('out', a);
  b.expose('separation', a, 'separation', '3D strength')
    .expose('focus', a, 'focus', 'Screen depth')
    .expose('depth', a, 'depthMode', 'Depth')
    .expose('ground', a, 'verticalCue', 'Ground-plane cue')
    .expose('encoding', a, 'encoding', 'Encoding');
  return {
    id: 'fun.3dGlasses',
    name: '3D Glasses (Anaglyph)',
    category: 'Fun',
    tags: ['anaglyph', '3d', 'red cyan', 'stereo', 'glasses', '50s'],
    description: 'Red/cyan anaglyph from a single photo: a depth guess (lower and brighter = nearer) drives a horizontal stereo shift; put on red/cyan glasses.',
    group: b.toGroup('3D Glasses'),
  };
}

export default (): PresetDef[] => [pico8(), macPaint(), miniature(), glasses3d()];
