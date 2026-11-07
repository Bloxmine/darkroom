/** Presets built on AI Denoise, Sky Mask and Sky Replace (src/nodes/ai/{denoise,sky}.ts). Models download on first use. */
import { GraphBuilder } from '../core/graph';
import type { PresetDef } from '../core/types';

function sunsetSky(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const sr = b.node('ai.skyReplace', { skyPreset: 'Sunset', relight: 0.65, edgeLight: 0.35, horizonBlend: 0.25 }, { image: img });
  b.output('out', sr);
  b.expose('clouds', sr, 'clouds', 'Clouds')
    .expose('sun', sr, 'sunX', 'Sun position')
    .expose('seed', sr, 'seed', 'Cloud seed')
    .expose('relight', sr, 'relight', 'Warm relight')
    .expose('edgeLight', sr, 'edgeLight', 'Edge lighting')
    .expose('horizonBlend', sr, 'horizonBlend', 'Horizon haze')
    .expose('threshold', sr, 'threshold', 'Mask threshold')
    .expose('showMask', sr, 'showMask', 'Show mask');
  return {
    id: 'ai.sunsetSky',
    name: 'Sunset Sky (AI)',
    category: 'AI',
    tags: ['sky replacement', 'sunset', 'golden hour', 'clouds', 'sky', 'ai'],
    description:
      'Replaces the sky with a procedural sunset (gradient, sun glow and perspective clouds) using the AI sky mask, then warms the foreground towards the new light, wraps light around the silhouette and adds a little horizon haze.',
    group: b.toGroup('Sunset Sky (AI)'),
  };
}

function dramaticSky(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const sr = b.node('ai.skyReplace', { skyPreset: 'Stormy', clouds: 0.6, relight: 0.6, edgeLight: 0.15, horizonBlend: 0.2 }, { image: img });
  // darken + add contrast to the land only (the Sky Mask analysis is shared with Sky Replace's, so it is free)
  const fg = b.node('ai.skyMask', { invert: true, feather: 2 }, { image: img });
  const dark = b.node('color.exposure', { exposure: -0.6, contrast: 0.2 }, { image: sr });
  const mix = b.node('composite.mix', { factor: 1 }, { a: sr, b: dark, mask: { node: fg, port: 'mask' } });
  b.output('out', mix);
  b.expose('clouds', sr, 'clouds', 'Clouds')
    .expose('seed', sr, 'seed', 'Cloud seed')
    .expose('darken', dark, 'exposure', 'Foreground exposure')
    .expose('contrast', dark, 'contrast', 'Foreground contrast')
    .expose('amount', mix, 'factor', 'Foreground darkening')
    .expose('relight', sr, 'relight', 'Relight')
    .expose('threshold', sr, 'threshold', 'Mask threshold');
  return {
    id: 'ai.dramaticSky',
    name: 'Dramatic Sky (AI)',
    category: 'AI',
    tags: ['sky replacement', 'storm', 'stormy', 'moody', 'dramatic', 'clouds', 'sky', 'ai'],
    description: 'A heavy stormy sky (AI sky mask + procedural clouds) with a darker, punchier foreground, relit to match the overcast light.',
    group: b.toGroup('Dramatic Sky (AI)'),
  };
}

function cleanHighIso(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const dn = b.node('ai.denoise', { strength: 1, luma: 0.9, chroma: 1, detail: 0.2 }, { image: img });
  b.output('out', dn);
  b.expose('strength', dn, 'strength', 'Strength')
    .expose('luma', dn, 'luma', 'Luminance noise')
    .expose('chroma', dn, 'chroma', 'Colour noise')
    .expose('detail', dn, 'detail', 'Detail recovery')
    .expose('model', dn, 'model', 'Model')
    .expose('tile', dn, 'tile', 'Tile size');
  return {
    id: 'ai.cleanHighIso',
    name: 'Clean High ISO (AI)',
    category: 'AI',
    tags: ['denoise', 'noise reduction', 'high iso', 'night', 'low light', 'grain removal', 'ai'],
    description:
      'Neural noise reduction (SCUNet) tuned for high-ISO shots: removes all colour blotches and most luminance noise, keeping a hint of fine grain and re-adding real texture so skin and foliage do not look plastic.',
    group: b.toGroup('Clean High ISO (AI)'),
  };
}

function gradFilter(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const sm = b.node('ai.skyMask', { horizonSoftness: 0.3, horizonOffset: 0 }, { image: img });
  const nd = b.node('color.exposure', { exposure: -1 }, { image: img });
  const tint = b.node('color.whiteBalance', { temperature: 0, tint: 0 }, { image: nd });
  const mix = b.node('composite.mix', { factor: 1 }, { a: img, b: tint, mask: { node: sm, port: 'horizon' } });
  b.output('out', mix);
  b.expose('stops', nd, 'exposure', 'ND strength (stops)')
    .expose('softness', sm, 'horizonSoftness', 'Transition softness')
    .expose('offset', sm, 'horizonOffset', 'Transition position')
    .expose('temperature', tint, 'temperature', 'Colour (warm/cool)')
    .expose('tint', tint, 'tint', 'Tint')
    .expose('amount', mix, 'factor', 'Amount');
  return {
    id: 'ai.gradFilter',
    name: 'Graduated Filter (AI)',
    category: 'AI',
    tags: ['graduated nd', 'grad filter', 'nd', 'sky', 'horizon', 'landscape', 'filter', 'ai'],
    description:
      'A physical graduated ND/colour filter whose transition sits on the horizon the AI sky model found (tilted if the horizon is): darkens and optionally tints the sky, leaving the land untouched.',
    group: b.toGroup('Graduated Filter (AI)'),
  };
}

export default (): PresetDef[] => [sunsetSky(), dramaticSky(), cleanHighIso(), gradFilter()];
