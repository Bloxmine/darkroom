/** Restoration / creative presets on the image-to-image AI nodes (inpaint, colorize, upscale, style, low-light, line art). */
import { GraphBuilder } from '../core/graph';
import type { PresetDef } from '../core/types';

function restoreOldPhoto(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  // scratches / dust: thin bright marks = white top-hat (image − opening), thresholded
  const open = b.node('filter.minMax', { operation: 'open', radius: 1.5, shape: 'disc' }, { image: img });
  const hat = b.node('composite.blend', { mode: 'subtract' }, { base: img, blend: open });
  const marks = b.node('composite.maskFromLuma', { low: 0.12, high: 0.2 }, { image: hat });
  const heal = b.node('ai.inpaint', { dilate: 2, feather: 2, context: 0.5 }, { image: img, mask: { node: marks, port: 'out' } });
  const col = b.node('ai.colorize', { saturation: 0.9 }, { image: heal });
  const up = b.node('ai.upscale', { factor: '2×', denoise: 0.7 }, { image: col });
  b.output('out', up);
  b.expose('scratchSize', open, 'radius', 'Max scratch width (px)')
    .expose('sensitivity', marks, 'low', 'Scratch threshold (lower = more)')
    .expose('grow', heal, 'dilate', 'Grow scratch mask')
    .expose('showMask', heal, 'showMask', 'Show scratch mask')
    .expose('saturation', col, 'saturation', 'Colour saturation')
    .expose('colorAmount', col, 'amount', 'Colorize amount')
    .expose('factor', up, 'factor', 'Upscale')
    .expose('denoise', up, 'denoise', 'Upscale denoise');
  return {
    id: 'ai.restoreOldPhoto',
    name: 'Restore Old Photo (AI)',
    category: 'AI',
    tags: ['restore', 'old photo', 'scratch removal', 'dust', 'colorize', 'upscale', 'repair', 'vintage', 'ai', 'lama', 'ddcolor', 'esrgan'],
    description:
      'One-click restoration of a scanned print: thin bright scratches and dust are detected (top-hat filter) and removed with LaMa inpainting ' +
      '(a heuristic: very fine bright detail such as petals can be caught too; raise the threshold or paint your own mask), ' +
      'the photo is colorized with DDColor, then enlarged 2× with Real-ESRGAN. Open the group to feed your own scratch mask into Remove Object. ' +
      'Downloads ~230 MB of models once.',
    group: b.toGroup('Restore Old Photo (AI)'),
  };
}

function colorizeVintage(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const col = b.node('ai.colorize', { saturation: 0.85, warmth: 4 }, { image: img });
  const film = b.node('analog.filmCurve', { stock: 'expired', strength: 0.7, fade: 0.12 }, { image: col });
  const grain = b.node('stylize.grain', { amount: 0.22, size: 1.4 }, { image: film });
  b.output('out', grain);
  b.expose('saturation', col, 'saturation', 'Colour saturation')
    .expose('warmth', col, 'warmth', 'Colour warmth')
    .expose('amount', col, 'amount', 'Colorize amount')
    .expose('stock', film, 'stock', 'Film stock')
    .expose('film', film, 'strength', 'Film curve strength')
    .expose('fade', film, 'fade', 'Fade')
    .expose('grain', grain, 'amount', 'Grain');
  return {
    id: 'ai.colorizeVintage',
    name: 'Colorize Vintage (AI)',
    category: 'AI',
    tags: ['colorize', 'black and white', 'vintage', 'film', 'old photo', 'hand-tinted', 'ai', 'ddcolor'],
    description: 'Colorizes a black & white photo with DDColor, then gives it the soft palette of an old colour print: faded film curve, warm cast and fine grain.',
    group: b.toGroup('Colorize Vintage (AI)'),
  };
}

function paintingStyles(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const st = b.node('ai.styleTransfer', { style: 'Udnie', size: '512', strength: 0.9 }, { image: img });
  const sat = b.node('color.vibranceSaturation', { vibrance: 0.15, saturation: 0 }, { image: st });
  const canvas = b.node('stylize.grain', { amount: 0.12, size: 2.2, chroma: 0 }, { image: sat });
  b.output('out', canvas);
  b.expose('style', st, 'style', 'Painting style')
    .expose('strength', st, 'strength', 'Style strength')
    .expose('size', st, 'size', 'Brush scale (inference size)')
    .expose('preserveColor', st, 'preserveColor', 'Keep photo colours')
    .expose('vibrance', sat, 'vibrance', 'Vibrance')
    .expose('canvas', canvas, 'amount', 'Canvas texture');
  return {
    id: 'ai.paintingStyles',
    name: 'Painting Styles (AI)',
    category: 'AI',
    tags: ['style transfer', 'painting', 'art', 'mosaic', 'candy', 'udnie', 'rain princess', 'pointillism', 'neural style', 'ai'],
    description:
      'Repaints the photo with a fast neural style network (Mosaic, Candy, Rain Princess, Udnie, Pointillism). Brush scale sets the stroke size; ' +
      'keep photo colours for a luminance-only transfer; a touch of canvas texture on top.',
    group: b.toGroup('Painting Styles (AI)'),
  };
}

function nightRescue(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const ll = b.node('ai.lowLight', { strength: 0.9, saturation: 0.8, exposure: -0.15 }, { image: img });
  const dn = b.node('filter.denoise', { luma: 0.55, chroma: 0.85, radius: 3, detail: 0.25 }, { image: ll });
  const grain = b.node('stylize.grain', { amount: 0.12, size: 1.3, chroma: 0.1 }, { image: dn });
  b.output('out', grain);
  b.expose('strength', ll, 'strength', 'Brighten')
    .expose('exposure', ll, 'exposure', 'Exposure (EV)')
    .expose('saturation', ll, 'saturation', 'Saturation')
    .expose('noise', dn, 'luma', 'Noise reduction')
    .expose('colorNoise', dn, 'chroma', 'Colour noise reduction')
    .expose('detail', dn, 'detail', 'Keep detail')
    .expose('grain', grain, 'amount', 'Grain');
  return {
    id: 'ai.nightRescue',
    name: 'Night Rescue (AI)',
    category: 'AI',
    tags: ['night', 'low light', 'dark', 'underexposed', 'brighten', 'denoise', 'zero-dce', 'ai'],
    description:
      'Rescues a dark or underexposed shot: Zero-DCE estimates per-pixel brightening curves, then noise reduction cleans the lifted shadows and a fine grain keeps it natural.',
    group: b.toGroup('Night Rescue (AI)'),
  };
}

function inkDrawing(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const la = b.node('ai.lineArt', { style: 'Fine lines (anime)', size: '768', weight: 0.6, contrast: 0.45, darkness: 1.3 }, { image: img });
  const paper = b.node('stylize.grain', { amount: 0.18, size: 2.5, chroma: 0, roughness: 0.8 }, { image: la });
  const vig = b.node('stylize.vignette', { amount: 0.12, radius: 0.9, softness: 0.8 }, { image: paper });
  b.output('out', vig);
  b.expose('style', la, 'style', 'Line style')
    .expose('detail', la, 'size', 'Detail (inference size)')
    .expose('weight', la, 'weight', 'Line weight')
    .expose('contrast', la, 'contrast', 'Line contrast')
    .expose('ink', la, 'ink', 'Ink colour')
    .expose('paper', la, 'paper', 'Paper colour')
    .expose('invert', la, 'invert', 'Invert (chalkboard)')
    .expose('texture', paper, 'amount', 'Paper texture');
  return {
    id: 'ai.inkDrawing',
    name: 'Ink Drawing (AI)',
    category: 'AI',
    tags: ['line art', 'ink', 'drawing', 'sketch', 'pen', 'comic', 'coloring page', 'informative drawings', 'ai'],
    description: 'Turns the photo into a pen-and-ink drawing on paper (Informative Drawings line generator), with paper texture and a soft vignette.',
    group: b.toGroup('Ink Drawing (AI)'),
  };
}

export default (): PresetDef[] => [restoreOldPhoto(), colorizeVintage(), paintingStyles(), nightRescue(), inkDrawing()];
