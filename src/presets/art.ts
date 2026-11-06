import { GraphBuilder } from '../core/graph';
import type { PresetDef } from '../core/types';

function oilPainting(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const k = b.node('effects.kuwahara', { radius: 8, sharpness: 8, anisotropy: 1.2, impasto: 0.6, bristles: 0.55, canvas: 0.35, saturation: 1.15 }, { image: img });
  b.output('out', k);
  b.expose('brush', k, 'radius', 'Brush size')
    .expose('sharpness', k, 'sharpness', 'Stroke crispness')
    .expose('elongation', k, 'anisotropy', 'Stroke elongation')
    .expose('impasto', k, 'impasto', 'Impasto')
    .expose('bristles', k, 'bristles', 'Bristle texture')
    .expose('canvas', k, 'canvas', 'Canvas')
    .expose('saturation', k, 'saturation', 'Saturation');
  return {
    id: 'art.oilPainting',
    name: 'Oil Painting',
    category: 'Artistic',
    tags: ['oil', 'painting', 'kuwahara', 'impasto', 'brush', 'canvas', 'painterly'],
    description: 'Anisotropic Kuwahara brush strokes that follow the image structure, then impasto relief with bristle texture lit from the top-left on canvas weave.',
    group: b.toGroup('Oil Painting'),
  };
}

function sketchbook(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const lev = b.node('color.levels', { inBlack: 0.04, inWhite: 0.95, gamma: 1.1 }, { image: img });
  const sk = b.node('effects.pencilSketch', { lineWidth: 4, lines: 1, hatching: 0.85, spacing: 5, angle: 40, brightness: 0.06, color: 0, paper: [0.96, 0.94, 0.89, 1] }, { image: lev });
  const vig = b.node('stylize.vignette', { amount: 0.12, radius: 0.8, softness: 0.9, color: [0.55, 0.5, 0.42, 1] }, { image: sk });
  b.output('out', vig);
  b.expose('lineWidth', sk, 'lineWidth', 'Line width')
    .expose('outline', sk, 'lines', 'Outline strength')
    .expose('hatching', sk, 'hatching', 'Hatching')
    .expose('spacing', sk, 'spacing', 'Hatch spacing')
    .expose('angle', sk, 'angle', 'Hatch angle')
    .expose('colour', sk, 'color', 'Coloured pencil')
    .expose('paper', sk, 'paper', 'Paper');
  return {
    id: 'art.sketchbook',
    name: 'Sketchbook (Pencil)',
    category: 'Artistic',
    tags: ['pencil', 'sketch', 'drawing', 'hatching', 'graphite', 'sketchbook'],
    description: 'Graphite sketch in a cream sketchbook: outlines from a colour-dodge, broken cross-hatching that builds up in the darks, paper tooth and a faint aged edge.',
    group: b.toGroup('Sketchbook'),
  };
}

function asciiTerminal(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const a = b.node('effects.ascii', { cellSize: 12, aspect: 0.6, charset: 'Detailed', colorMode: 'Mono', fg: [0.35, 1, 0.45, 1], bg: [0.01, 0.04, 0.02, 1], contrast: 1.5, gamma: 1.3, bold: true }, { image: img });
  const glow = b.node('stylize.bloom', { threshold: 0.55, knee: 0.3, intensity: 0.55, radius: 10, tint: [0.4, 1, 0.5, 1] }, { image: a });
  const lines = b.node('stylize.scanlines', { period: 3, intensity: 0.22 }, { image: glow });
  const vig = b.node('stylize.vignette', { amount: 0.45, radius: 0.7, softness: 0.7, roundness: 0.3 }, { image: lines });
  b.output('out', vig);
  b.expose('size', a, 'cellSize', 'Character size')
    .expose('charset', a, 'charset', 'Character set')
    .expose('contrast', a, 'contrast', 'Contrast')
    .expose('colour', a, 'fg', 'Phosphor colour')
    .expose('glow', glow, 'intensity', 'Phosphor glow')
    .expose('scanlines', lines, 'intensity', 'Scanlines');
  return {
    id: 'art.asciiTerminal',
    name: 'ASCII Terminal',
    category: 'Artistic',
    tags: ['ascii', 'terminal', 'green screen', 'phosphor', 'hacker', 'matrix', 'text', 'crt'],
    description: 'The image as text on a green-phosphor terminal: dense ASCII ramp → phosphor bloom → scanlines → tube vignette.',
    group: b.toGroup('ASCII Terminal'),
  };
}

export default (): PresetDef[] => [oilPainting(), sketchbook(), asciiTerminal()];
