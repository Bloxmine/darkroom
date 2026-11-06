import { GraphBuilder } from '../core/graph';
import type { PresetDef } from '../core/types';

function cyanotype(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const soft = b.node('filter.gaussianBlur', { radius: 0.8 }, { image: img });
  const cy = b.node('effects.cyanotype', { exposure: 0, contrast: 1.3, coating: 0.6, brushEdges: 0.75, stain: 0.3, paperTexture: 0.6, seed: 2 }, { image: soft });
  b.output('out', cy);
  b.expose('exposure', cy, 'exposure', 'Exposure')
    .expose('contrast', cy, 'contrast', 'Contrast')
    .expose('brush', cy, 'brushEdges', 'Brushed border')
    .expose('coating', cy, 'coating', 'Uneven coating')
    .expose('stain', cy, 'stain', 'Staining')
    .expose('blue', cy, 'blue', 'Prussian blue')
    .expose('paper', cy, 'paper', 'Paper')
    .expose('seed', cy, 'seed', 'Seed');
  return {
    id: 'process.cyanotype',
    name: 'Cyanotype',
    category: 'Process',
    tags: ['cyanotype', 'blueprint', 'sun print', 'alternative process', 'contact print'],
    description: 'Contact-printed cyanotype on watercolour paper: slight contact-print softness → Prussian-blue iron print with a hand-brushed, fully exposed blue border, uneven coating and faint staining.',
    group: b.toGroup('Cyanotype'),
  };
}

function tintype(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const plate = b.node('effects.wetPlate', { exposure: -0.3, contrast: 1.45, blueSensitivity: 1, plate: 'Tintype', softness: 7, vignette: 0.7, pour: 0.75, scratches: 0.5, seed: 4 }, { image: img });
  const grain = b.node('stylize.grain', { amount: 0.18, size: 1.4, roughness: 0.3, chroma: 0, response: 0.6 }, { image: plate });
  b.output('out', grain);
  b.expose('exposure', plate, 'exposure', 'Exposure')
    .expose('contrast', plate, 'contrast', 'Contrast')
    .expose('blue', plate, 'blueSensitivity', 'Blue sensitivity')
    .expose('plate', plate, 'plate', 'Plate')
    .expose('softness', plate, 'softness', 'Petzval softness')
    .expose('pour', plate, 'pour', 'Pour marks')
    .expose('scratches', plate, 'scratches', 'Scratches & dust')
    .expose('seed', plate, 'seed', 'Seed');
  return {
    id: 'process.tintype',
    name: 'Tintype (Wet Collodion)',
    category: 'Process',
    tags: ['tintype', 'wet plate', 'collodion', 'victorian', '1860s', 'antique', 'ambrotype'],
    description: 'An 1860s tintype: blue-only-sensitive collodion (red lips and skin go dark, skies blow out), swirly Petzval edges, silvery highlights on black japanned iron, irregular pour edges, comets and scratches, fine grain.',
    group: b.toGroup('Tintype'),
  };
}

function aerochrome(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const ir = b.node('effects.infrared', { mode: 'Aerochrome', foliage: 1.1, irLuma: 0.9, skyDarken: 0.8, hueShift: 0, saturation: 1.2, contrast: 1.1 }, { image: img });
  const hal = b.node('stylize.halation', { threshold: 0.82, amount: 0.25, radius: 16 }, { image: ir });
  const vig = b.node('stylize.vignette', { amount: 0.25, radius: 0.75, softness: 0.8 }, { image: hal });
  const grain = b.node('stylize.grain', { amount: 0.35, size: 1.8, roughness: 0.5, chroma: 0.35 }, { image: vig });
  b.output('out', grain);
  b.expose('foliage', ir, 'foliage', 'Foliage response')
    .expose('hue', ir, 'hueShift', 'Red ↔ magenta')
    .expose('saturation', ir, 'saturation', 'Saturation')
    .expose('contrast', ir, 'contrast', 'Contrast')
    .expose('glow', hal, 'amount', 'IR glow')
    .expose('grain', grain, 'amount', 'Grain');
  return {
    id: 'process.aerochrome',
    name: 'Aerochrome (Colour Infrared)',
    category: 'Process',
    tags: ['aerochrome', 'infrared', 'false colour', 'kodak', 'pink foliage', 'psychedelic', 'eir'],
    description: 'Kodak Aerochrome colour-infrared slide film: foliage turns red-pink, skies deep blue, reds go yellow → halation glow from the IR-bright highlights → vignette → film grain.',
    group: b.toGroup('Aerochrome'),
  };
}

export default (): PresetDef[] => [cyanotype(), tintype(), aerochrome()];
