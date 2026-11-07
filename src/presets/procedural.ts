import { GraphBuilder } from '../core/graph';
import type { PresetDef } from '../core/types';

/**
 * Showcase presets for the Blender-style procedural nodes (src/nodes/math):
 * coordinate images → textures / vector math → Sample by Coordinates.
 */

function liquify(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const coords = b.node('texture.coordinates');
  const noise = b.node('texture.noise', { scale: 1.5, detail: 3, roughness: 0.55, distortion: 1 });
  const centred = b.node('vector.math', { operation: 'Subtract', bx: 0.5, by: 0.5, bz: 0.5 }, { a: { node: noise, port: 'color' } });
  const amount = b.node('vector.math', { operation: 'Scale', scaleValue: 0.3 }, { a: centred });
  const warped = b.node('vector.math', { operation: 'Add' }, { a: amount, b: { node: coords, port: 'uv' } });
  const sample = b.node('vector.sample', { space: 'UV', extension: 'Mirror' }, { image: img, vector: warped });
  b.output('out', sample);
  b.expose('amount', amount, 'scaleValue', 'Amount', { min: 0, max: 0.5, step: 0.005 })
    .expose('scale', noise, 'scale', 'Blob size (scale)')
    .expose('detail', noise, 'detail', 'Detail')
    .expose('distortion', noise, 'distortion', 'Swirl (distortion)')
    .expose('w', noise, 'w', 'Variation (W)')
    .expose('wSpeed', noise, 'wSpeed', 'Animate (W speed)');
  return {
    id: 'procedural.liquify',
    name: 'Liquify',
    category: 'Procedural',
    tags: ['melt', 'warp', 'liquid', 'distort', 'noise', 'psychedelic', 'blender'],
    description: 'Melting / liquid warp: Texture Coordinate UV + (Noise Texture colour − 0.5) × Amount → Sample by Coordinates. Animate with W speed on the timeline.',
    group: b.toGroup('Liquify'),
  };
}

function stainedGlass(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const soft = b.node('filter.gaussianBlur', { radius: 6 }, { image: img });
  const cells = b.node('texture.voronoi', { dimensions: '2D', feature: 'F1', scale: 14, randomness: 0.9 });
  const flat = b.node('vector.sample', { space: 'Generated', extension: 'Extend' }, { image: soft, vector: { node: cells, port: 'position' } });
  const vivid = b.node('convert.hueSatVal', { saturation: 1.35, value: 1.05 }, { color: flat });
  const edges = b.node('texture.voronoi', { dimensions: '2D', feature: 'Distance to Edge', scale: 14, randomness: 0.9 });
  const lead = b.node('math.mapRange', { interpolation: 'Smooth Step', fromMinValue: 0.02, fromMaxValue: 0.06 }, { value: { node: edges, port: 'distance' } });
  const glassNoise = b.node('texture.noise', { scale: 30, detail: 4 });
  const textured = b.node('mix.color', { blendType: 'Overlay', factor: 0.25 }, { a: vivid, b: { node: glassNoise, port: 'color' } });
  const leaded = b.node('mix.color', { blendType: 'Multiply', factor: 1 }, { a: textured, b: lead });
  b.output('out', leaded);
  b.expose('cells', cells, 'scale', 'Cell density', { min: 1, max: 60 })
    .expose('cells', edges, 'scale', 'Cell density', { min: 1, max: 60 })
    .expose('randomness', cells, 'randomness', 'Irregularity')
    .expose('randomness', edges, 'randomness', 'Irregularity')
    .expose('lead', lead, 'fromMaxValue', 'Lead width', { min: 0.005, max: 0.3, step: 0.005 })
    .expose('saturation', vivid, 'saturation', 'Saturation')
    .expose('texture', textured, 'factor', 'Glass texture');
  return {
    id: 'procedural.stainedGlass',
    name: 'Stained Glass',
    category: 'Procedural',
    tags: ['stained glass', 'voronoi', 'cells', 'mosaic', 'church window', 'blender'],
    description: 'Voronoi F1 cell positions sample the (softened) photo → one flat colour per cell, saturated, with a subtle Overlay glass texture; a Voronoi Distance-to-Edge → Map Range mask multiplies in the dark lead lines.',
    group: b.toGroup('Stained Glass'),
  };
}

function marble(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const coords = b.node('texture.coordinates');
  const noise = b.node('texture.noise', { scale: 1.5, detail: 6, roughness: 0.6 });
  const warpAmt = b.node('vector.math', { operation: 'Scale', scaleValue: 0.6 }, { a: { node: noise, port: 'color' } });
  const warped = b.node('vector.math', { operation: 'Add' }, { a: warpAmt, b: { node: coords, port: 'generated' } });
  const wave = b.node('texture.wave', { bandsDirection: 'Diagonal', profile: 'Sine', scale: 1.2, distortion: 6, detail: 4, detailScale: 2, detailRoughness: 0.6 }, { vector: warped });
  const veins = b.node('convert.colorRamp', {
    interpolation: 'Ease', count: 3,
    pos0: 0, color0: [0.08, 0.09, 0.11, 1],
    pos1: 0.12, color1: [0.52, 0.51, 0.5, 1],
    pos2: 1, color2: [0.64, 0.63, 0.61, 1],
  }, { fac: { node: wave, port: 'fac' } });
  const overlay = b.node('mix.color', { blendType: 'Overlay', factor: 0.8 }, { a: img, b: { node: veins, port: 'color' } });
  b.output('out', overlay);
  b.expose('amount', overlay, 'factor', 'Amount')
    .expose('blend', overlay, 'blendType', 'Blend type')
    .expose('scale', wave, 'scale', 'Vein scale')
    .expose('turbulence', wave, 'distortion', 'Turbulence')
    .expose('warp', warpAmt, 'scaleValue', 'Warp', { min: 0, max: 3 })
    .expose('veinWidth', veins, 'pos1', 'Vein width', { min: 0.01, max: 0.5 });
  return {
    id: 'procedural.marble',
    name: 'Marble',
    category: 'Procedural',
    tags: ['marble', 'stone', 'veins', 'texture', 'overlay', 'wave', 'noise', 'blender'],
    description: 'Procedural marble (noise-warped diagonal Wave Texture → Color Ramp veins) laid over the photo with Mix Color Overlay.',
    group: b.toGroup('Marble'),
  };
}

export default (): PresetDef[] => [liquify(), stainedGlass(), marble()];
