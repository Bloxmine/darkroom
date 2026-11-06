import { GraphBuilder } from '../core/graph';
import type { PresetDef } from '../core/types';

/** Two-drum riso zine: fluorescent pink + blue, grain touch, on off-white stock. */
function risoZine(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const riso = b.node('effects.risograph', {
    layers: 2, separation: 'Auto (ink unmixing)', contrast: 1.2, brightness: 0.06, gamma: 1.12,
    screen: 'Grain touch', grainSize: 2.6, misregister: 1, spread: 0.55, uneven: 0.55, banding: 0.5,
    paper: [0.95, 0.93, 0.87, 1], paperTexture: 0.55, seed: 7,
    ink1: 'Blue', density1: 0.95, offset1X: 0, offset1Y: 0, rotate1: 0,
    ink2: 'Fluorescent Pink', density2: 1, offset2X: 6, offset2Y: -4, rotate2: 0.15,
  }, { image: img });
  b.output('out', riso);
  b.expose('misregister', riso, 'misregister', 'Misregistration')
    .expose('grain', riso, 'grainSize', 'Grain size')
    .expose('contrast', riso, 'contrast', 'Contrast')
    .expose('blue', riso, 'density1', 'Blue ink')
    .expose('pink', riso, 'density2', 'Pink ink')
    .expose('ink1', riso, 'ink1', 'Drum 1 colour')
    .expose('ink2', riso, 'ink2', 'Drum 2 colour')
    .expose('paper', riso, 'paper', 'Paper');
  return {
    id: 'print.risoZine',
    name: 'Riso Zine (Pink + Blue)',
    category: 'Print',
    tags: ['riso', 'risograph', 'zine', 'duotone', 'fluorescent pink', 'print', 'grain'],
    description:
      'A two-colour Risograph zine page: the photo is unmixed into Blue and Fluorescent Pink drums, each printed with the stochastic "grain touch" screen, ' +
      'misregistered by a few pixels, with uneven ink, roller banding and paper tooth on off-white stock. Overlaps print as a rich violet.',
    group: b.toGroup('Riso Zine'),
  };
}

/** Three-drum riso: yellow / pink / blue halftone. */
function riso3(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const riso = b.node('effects.risograph', {
    layers: 3, separation: 'Auto (ink unmixing)', contrast: 1.15, gamma: 1,
    screen: 'Halftone dots', cellSize: 6.5, misregister: 1, spread: 0.5, uneven: 0.45, banding: 0.4,
    paper: [0.96, 0.95, 0.9, 1], paperTexture: 0.45, seed: 21,
    ink1: 'Blue', angle1: 15, offset1X: 0, offset1Y: 0, rotate1: 0, density1: 0.95,
    ink2: 'Fluorescent Pink', angle2: 75, offset2X: 4, offset2Y: -3, rotate2: 0.1, density2: 1,
    ink3: 'Yellow', angle3: 0, offset3X: -3, offset3Y: 4, rotate3: -0.08, density3: 1,
  }, { image: img });
  b.output('out', riso);
  b.expose('misregister', riso, 'misregister', 'Misregistration')
    .expose('cell', riso, 'cellSize', 'Halftone size')
    .expose('screen', riso, 'screen', 'Screen')
    .expose('contrast', riso, 'contrast', 'Contrast')
    .expose('spread', riso, 'spread', 'Ink spread')
    .expose('uneven', riso, 'uneven', 'Uneven ink')
    .expose('paper', riso, 'paper', 'Paper')
    .expose('seed', riso, 'seed', 'Seed');
  return {
    id: 'print.riso3',
    name: 'Riso 3-Colour (Yellow / Pink / Blue)',
    category: 'Print',
    tags: ['riso', 'risograph', 'cmy', 'halftone', 'print', 'poster', 'fluorescent'],
    description:
      'Three-drum Risograph poster: Yellow, Fluorescent Pink and Blue separations, each halftoned at its own screen angle and printed slightly out of register, ' +
      'so you get rosettes, colour fringes at edges, and multiply overprints (pink + yellow = warm red, blue + yellow = green, all three = dark brown).',
    group: b.toGroup('Riso 3-Colour'),
  };
}

function screenprint(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const sp = b.node('effects.screenprint', { simplify: 3.5, levels: 2, saturation: 1.7, contrast: 1.35, keyThreshold: 0.26, misregister: 9, edge: 0.55, streaks: 0.4, seed: 11 }, { image: img });
  b.output('out', sp);
  b.expose('simplify', sp, 'simplify', 'Simplify')
    .expose('steps', sp, 'levels', 'Ink steps')
    .expose('pop', sp, 'saturation', 'Colour pop')
    .expose('black', sp, 'keyThreshold', 'Black layer threshold')
    .expose('misregister', sp, 'misregister', 'Misregistration')
    .expose('edges', sp, 'edge', 'Rough edges')
    .expose('paper', sp, 'paper', 'Paper')
    .expose('seed', sp, 'seed', 'Seed');
  return {
    id: 'print.screenprint',
    name: 'Pop-Art Screenprint',
    category: 'Print',
    tags: ['screenprint', 'silkscreen', 'pop art', 'warhol', 'poster', 'serigraph'],
    description: 'Silkscreen poster: simplified shapes, flat cyan/magenta/yellow stencils in a couple of ink strengths plus a black key layer, each pulled out of register with rough, pooled edges.',
    group: b.toGroup('Screenprint'),
  };
}

function photocopy(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const sharp = b.node('filter.sharpen', { amount: 1.2, radius: 2 }, { image: img });
  const pc = b.node('effects.photocopy', { threshold: 0.52, contrast: 7, generations: 4, drift: 0.7, speckle: 0.6, streaks: 0.55, patchy: 0.45, edges: 0.7, seed: 5 }, { image: sharp });
  b.output('out', pc);
  b.expose('darkness', pc, 'threshold', 'Darkness')
    .expose('generations', pc, 'generations', 'Copy generations')
    .expose('speckle', pc, 'speckle', 'Toner speckle')
    .expose('streaks', pc, 'streaks', 'Streaks')
    .expose('edges', pc, 'edges', 'Lid shadow')
    .expose('paper', pc, 'paper', 'Paper')
    .expose('seed', pc, 'seed', 'Seed');
  return {
    id: 'print.photocopy',
    name: 'Punk Zine Photocopy',
    category: 'Print',
    tags: ['xerox', 'photocopy', 'punk', 'zine', 'diy', 'flyer', 'black and white', 'toner'],
    description: 'A fourth-generation photocopy for a punk flyer: unsharp-masked original → copier threshold → repeated re-copying (fattening blacks, losing mids) → toner speckle, drum streaks, patchy solids and the black lid shadow.',
    group: b.toGroup('Punk Photocopy'),
  };
}

export default (): PresetDef[] => [risoZine(), riso3(), screenprint(), photocopy()];
