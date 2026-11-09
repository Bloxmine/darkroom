/**
 * Pro workflow presets built from the pro.* nodes (see docs/FILTERS.md): a cinematic grade, a landscape
 * polish with a draggable sky gradient, a portrait retouch with a draggable spotlight, and a
 * single-image exposure-fusion "natural HDR". Handles of exposed vec2 params stay draggable in the viewer.
 */
import { GraphBuilder } from '../core/graph';
import type { PresetDef } from '../core/types';

function cinematic(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const tm = b.node('pro.tonemap', { operator: 'AgX', look: 'Punchy', exposure: 0.6 }, { image: img });
  const look = b.node('pro.look', { look: 'Teal & Orange', amount: 0.8 }, { image: tm });
  const vig = b.node('stylize.vignette', { amount: 0.35 }, { image: look });
  const grain = b.node('stylize.grain', { amount: 0.2, size: 1.4 }, { image: vig });
  b.output('out', grain);
  b.expose('look', look, 'look', 'Look')
    .expose('lookAmount', look, 'amount', 'Look amount')
    .expose('exposure', tm, 'exposure', 'Exposure (EV)')
    .expose('vignette', vig, 'amount', 'Vignette')
    .expose('grain', grain, 'amount', 'Grain');
  return {
    id: 'pro.cinematicGrade',
    name: 'Cinematic Grade',
    category: 'Pro',
    tags: ['cinematic', 'film look', 'teal orange', 'agx', 'grade', 'movie'],
    description: 'AgX Punchy tone mapping → a Look (Teal & Orange by default; pick any of the pack) → soft vignette → fine grain. A one-node film grade.',
    group: b.toGroup('Cinematic Grade'),
  };
}

function landscape(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const sky = b.node('pro.gradFilter', { exposure: -0.8, saturation: 0.2, highlights: -0.4, clarity: 0.15 }, { image: img });
  const tex = b.node('pro.texture', { amount: 0.4 }, { image: sky });
  const sh = b.node('pro.smartSharpen', { amount: 0.8, radius: 1, masking: 0.6 }, { image: tex });
  b.output('out', sh);
  b.expose('start', sky, 'start', 'Sky gradient start')
    .expose('end', sky, 'end', 'Sky gradient end')
    .expose('skyExposure', sky, 'exposure', 'Sky exposure')
    .expose('skySat', sky, 'saturation', 'Sky saturation')
    .expose('texture', tex, 'amount', 'Texture')
    .expose('sharpen', sh, 'amount', 'Sharpening');
  return {
    id: 'pro.landscapePolish',
    name: 'Landscape Polish',
    category: 'Pro',
    tags: ['landscape', 'sky', 'graduated filter', 'texture', 'sharpen', 'nd grad'],
    description: 'Graduated filter darkening the sky (drag its Start/End handles in the viewer) → Texture for rock and foliage detail → edge-masked Smart Sharpen.',
    group: b.toGroup('Landscape Polish'),
  };
}

function portrait(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const skin = b.node('pro.texture', { amount: -0.55 }, { image: img });
  const spot = b.node('pro.radialFilter', { exposure: 0.35, clarity: 0.1, saturation: 0.05, feather: 0.8, roundness: 1.4 }, { image: skin });
  const sh = b.node('pro.smartSharpen', { amount: 0.7, radius: 0.9, masking: 0.85 }, { image: spot });
  b.output('out', sh);
  b.expose('skin', skin, 'amount', 'Skin texture (− smooths)')
    .expose('center', spot, 'center', 'Spotlight centre')
    .expose('edge', spot, 'edge', 'Spotlight edge')
    .expose('spot', spot, 'exposure', 'Spotlight exposure')
    .expose('sharpen', sh, 'amount', 'Sharpening (edges only)');
  return {
    id: 'pro.portraitRetouch',
    name: 'Portrait Retouch',
    category: 'Pro',
    tags: ['portrait', 'skin', 'retouch', 'smooth skin', 'spotlight', 'beauty'],
    description: 'Negative Texture smooths skin without blurring edges → a feathered radial spotlight on the face (drag Centre/Edge in the viewer) → Smart Sharpen restricted to strong edges (eyes, lashes, hair).',
    group: b.toGroup('Portrait Retouch'),
  };
}

function naturalHdr(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const lo = b.node('color.exposure', { exposure: -1.5 }, { image: img });
  const loC = b.node('math.clamp', {}, { value: lo });
  const hi = b.node('color.exposure', { exposure: 1.5 }, { image: img });
  const hiC = b.node('math.clamp', {}, { value: hi });
  const fuse = b.node('pro.exposureFusion', {}, { in0: loC, in1: img, in2: hiC });
  b.output('out', fuse);
  b.expose('shadows', hi, 'exposure', 'Shadow lift (EV)')
    .expose('highlights', lo, 'exposure', 'Highlight recovery (EV)')
    .expose('contrast', fuse, 'contrast', 'Local contrast weight')
    .expose('saturation', fuse, 'saturation', 'Saturation weight');
  return {
    id: 'pro.naturalHdr',
    name: 'Natural HDR (single image)',
    category: 'Pro',
    tags: ['hdr', 'exposure fusion', 'mertens', 'shadows', 'highlights', 'dynamic range'],
    description: 'Pseudo-bracketing: the photo darkened and brightened, then Mertens exposure fusion picks the best-exposed parts of each — opens shadows and holds highlights with a natural, halo-free look.',
    group: b.toGroup('Natural HDR'),
  };
}

export default (): PresetDef[] => [cinematic(), landscape(), portrait(), naturalHdr()];
