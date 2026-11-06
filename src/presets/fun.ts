import { GraphBuilder } from '../core/graph';
import type { PresetDef } from '../core/types';

function gameboy(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const lev = b.node('color.levels', { inBlack: 0.03, inWhite: 0.95, gamma: 1.0 }, { image: img });
  const mono = b.node('color.channelMixer', { monochrome: true, rr: 0.4, rg: 0.45, rb: 0.15 }, { image: lev });
  const dith = b.node('stylize.dither', { palette: 'gameboy', method: 'bayer4', cells: 128, spread: 1, contrast: 1.15, brightness: -0.03, sharpen: 0.8 }, { image: mono });
  const lcd = b.node('stylize.vignette', { amount: 0.15, radius: 0.8, softness: 0.8, roundness: 0, color: [0.06, 0.2, 0.06, 1] }, { image: dith });
  b.output('out', lcd);
  b.expose('cells', dith, 'cells', 'Resolution (pixels across)')
    .expose('contrast', dith, 'contrast', 'Contrast')
    .expose('brightness', dith, 'brightness', 'Brightness')
    .expose('edge', dith, 'sharpen', 'Edge enhance')
    .expose('palette', dith, 'palette', 'Palette')
    .expose('method', dith, 'method', 'Dither');
  return {
    id: 'fun.gameboy',
    name: 'Game Boy Camera',
    category: 'Fun',
    tags: ['gameboy', 'game boy camera', 'dither', '4 colours', 'green', 'pixel', 'retro'],
    description:
      'The 1998 Game Boy Camera: levels → black-and-white sensor mix → 128-pixel-wide image with hardware-style edge enhancement and 4×4 Bayer dithering ' +
      'into four Game Boy greens (palette dmg = original pea-soup screen), nearest-neighbour enlarged → faint LCD edge shading.',
    group: b.toGroup('Game Boy Camera'),
  };
}

function crt(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const sat = b.node('color.hsl', { saturation: 0.15, vibrance: 0.1 }, { image: img });
  const comp = b.node('analog.vhsChroma', { lumaRes: 640, chromaRes: 160, lines: 480, sharpen: 0.35, chromaShift: 0.15, chromaBleed: 0.5, saturation: 1.1 }, { image: sat });
  const tube = b.node('stylize.crt', { curvature: 0.12, lines: 300, scanlineStrength: 0.8, mask: 'aperture', maskSize: 4, maskStrength: 0.45, glow: 0.25, brightness: 1.25 }, { image: comp });
  const bloom = b.node('stylize.bloom', { threshold: 0.6, intensity: 0.3, radius: 30 }, { image: tube });
  b.output('out', bloom);
  b.expose('curvature', tube, 'curvature', 'Curvature')
    .expose('lines', tube, 'lines', 'Scanlines')
    .expose('mask', tube, 'mask', 'Phosphor mask')
    .expose('maskStrength', tube, 'maskStrength', 'Mask strength')
    .expose('glow', tube, 'glow', 'Glow')
    .expose('brightness', tube, 'brightness', 'Brightness');
  return {
    id: 'fun.crt',
    name: 'CRT Monitor',
    category: 'Fun',
    tags: ['crt', 'tv', 'monitor', 'arcade', 'scanlines', 'retro'],
    description:
      'An old TV / arcade monitor: slight saturation → composite-video softness → curved tube with beam scanlines, aperture-grille phosphors, glow and rounded corners → bloom.',
    group: b.toGroup('CRT Monitor'),
  };
}

function thermal(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const sensor = b.node('analog.resample', { mode: 'width', width: 320, filter: 'smooth' }, { image: img });
  const blur = b.node('filter.gaussianBlur', { radius: 1.2, direction: 'both' }, { image: sensor });
  const up = b.node('analog.resample', { mode: 'reference', filter: 'bicubic' }, { image: blur, reference: img });
  const map = b.node('analog.thermal', { palette: 'ironbow', low: 0.08, high: 0.92, warmBias: 0.6, skyCold: 0.6, hud: true }, { image: up });
  const noise = b.node('stylize.grain', { amount: 0.12, size: 3, roughness: 0.1, chroma: 0, response: 0.3 }, { image: map });
  b.output('out', noise);
  b.expose('palette', map, 'palette', 'Palette')
    .expose('low', map, 'low', 'Range low')
    .expose('high', map, 'high', 'Range high')
    .expose('warm', map, 'warmBias', 'Skin is hot')
    .expose('hud', map, 'hud', 'HUD')
    .expose('noise', noise, 'amount', 'Sensor noise');
  return {
    id: 'fun.thermal',
    name: 'Thermal Camera',
    category: 'Fun',
    tags: ['thermal', 'flir', 'infrared', 'heat', 'ironbow', 'predator'],
    description:
      'A 320-pixel microbolometer: low sensor resolution → optical blur → smooth upscale → fake temperature (brightness, skin is hot, sky is cold) mapped to the ironbow palette with HUD → sensor noise.',
    group: b.toGroup('Thermal Camera'),
  };
}

function glitch(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const jpeg = b.node('stylize.jpeg', { quality: 18, subsampling: '4:2:0', blockSize: 12 }, { image: img });
  const g = b.node('analog.glitch', { amount: 0.55, blockSize: 24, slices: 0.6, displace: 0.6, melt: 0.5, corrupt: 0.5, rgbSplit: 10, seed: 42 }, { image: jpeg });
  const ca = b.node('distort.chromaticAberration', { amount: 5, mode: 'linear', angle: 0, falloff: 1 }, { image: g });
  const sat = b.node('color.hsl', { saturation: 0.2 }, { image: ca });
  const lines = b.node('stylize.scanlines', { period: 4, intensity: 0.15 }, { image: sat });
  b.output('out', lines);
  b.expose('amount', g, 'amount', 'Amount')
    .expose('seed', g, 'seed', 'Seed')
    .expose('blockSize', g, 'blockSize', 'Block size')
    .expose('melt', g, 'melt', 'Datamosh melt')
    .expose('split', g, 'rgbSplit', 'RGB split')
    .expose('quality', jpeg, 'quality', 'Compression');
  return {
    id: 'fun.glitch',
    name: 'Digital Glitch',
    category: 'Fun',
    tags: ['glitch', 'datamosh', 'corrupt', 'rgb split', 'digital'],
    description:
      'A corrupted video stream: heavy JPEG macroblocking → slice tearing, displaced and melting macroblocks, broken-chroma blocks → RGB split → chromatic shift → saturation → faint lines. Change Seed for a new glitch.',
    group: b.toGroup('Digital Glitch'),
  };
}

function newspaper(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const mono = b.node('color.channelMixer', { monochrome: true, rr: 0.3, rg: 0.55, rb: 0.15 }, { image: img });
  const lev = b.node('color.levels', { inBlack: 0.05, inWhite: 0.92, gamma: 1.1 }, { image: mono });
  const sharp = b.node('filter.sharpen', { amount: 0.8, radius: 2 }, { image: lev });
  const ht = b.node('stylize.halftone', { mode: 'mono', cellSize: 7, angle: 0, softness: 0.25, paper: [0.93, 0.91, 0.85, 1], ink: [0.12, 0.12, 0.13, 1] }, { image: sharp });
  const paper = b.node('stylize.grain', { amount: 0.2, size: 3, roughness: 0.2, chroma: 0, response: 0 }, { image: ht });
  b.output('out', paper);
  b.expose('cell', ht, 'cellSize', 'Screen size')
    .expose('angle', ht, 'angle', 'Screen angle')
    .expose('paper', ht, 'paper', 'Paper')
    .expose('ink', ht, 'ink', 'Ink')
    .expose('contrast', lev, 'gamma', 'Midtones');
  return {
    id: 'print.newspaper',
    name: 'Newspaper Print',
    category: 'Print',
    tags: ['halftone', 'newspaper', 'print', 'dots', 'press'],
    description: 'Black-and-white newsprint: mono conversion → levels → unsharp mask → 45° halftone screen on off-white paper → paper texture.',
    group: b.toGroup('Newspaper'),
  };
}

export default (): PresetDef[] => [gameboy(), crt(), thermal(), glitch(), newspaper()];
