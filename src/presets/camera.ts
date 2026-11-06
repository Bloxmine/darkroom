import { GraphBuilder } from '../core/graph';
import type { PresetDef } from '../core/types';

/** 2002 consumer digicam with a 1.3 MP CCD. */
function ccd2002(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const sensor = b.node('analog.resample', { mode: 'width', width: 1280, filter: 'smooth' }, { image: img });
  const wb = b.node('color.whiteBalance', { temperature: -0.14, tint: 0.03 }, { image: sensor });
  const fringe = b.node('analog.purpleFringe', { amount: 0.9, threshold: 0.78, radius: 2.5 }, { image: wb });
  const ccd = b.node('analog.ccdSensor', { exposure: 0.1, clipShift: 0.7, contrast: 0.45, blackCrush: 0.5, chromaNoise: 0.6, lumaNoise: 0.35, noiseSize: 1.6, fixedPattern: 0.3 }, { image: fringe });
  const smear = b.node('analog.ccdSmear', { threshold: 0.97, smear: 0.7, bloom: 0.5, bloomLength: 60 }, { image: ccd });
  const sat = b.node('color.hsl', { saturation: 0.08, vibrance: 0.1 }, { image: smear });
  const sharp = b.node('analog.edgeEnhance', { amount: 1.6, radius: 1.3, threshold: 0.008, halo: 0.55 }, { image: sat });
  const jpeg = b.node('stylize.jpeg', { quality: 55, subsampling: '4:2:0', blockSize: 8 }, { image: sharp });
  const view = b.node('analog.resample', { mode: 'reference', filter: 'smooth' }, { image: jpeg, reference: img });
  b.output('out', view);
  b.expose('resolution', sensor, 'width', 'Sensor width (px)')
    .expose('whiteBalance', wb, 'temperature', 'Auto white balance')
    .expose('exposure', ccd, 'exposure', 'Exposure')
    .expose('noise', ccd, 'chromaNoise', 'Chroma noise')
    .expose('fringing', fringe, 'amount', 'Purple fringing')
    .expose('smear', smear, 'smear', 'CCD smear')
    .expose('sharpening', sharp, 'amount', 'In-camera sharpening')
    .expose('quality', jpeg, 'quality', 'JPEG quality');
  return {
    id: 'camera.ccd2002',
    name: '2002 Digicam (1.3 MP CCD)',
    category: 'Camera',
    tags: ['digicam', 'ccd', 'y2k', '2000s', 'jpeg', 'compact', 'point and shoot'],
    description:
      'A 1.3-megapixel compact from 2002. Chain: resample to the 1280 px sensor → cool auto white balance → purple fringing from the cheap lens → ' +
      'CCD sensor (small dynamic range, hard per-channel clipping, blotchy chroma noise in shadows) → vertical CCD smear from point highlights → ' +
      'punchy saturation → heavy in-camera sharpening halos → JPEG at quality 60 with 4:2:0 chroma → scaled back to the original size for viewing.',
    group: b.toGroup('2002 Digicam'),
  };
}

/** Disposable film camera with flash. */
function disposable(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const scan = b.node('analog.resample', { mode: 'width', width: 1840, filter: 'smooth' }, { image: img });
  const lens = b.node('distort.lens', { k1: 0.06, k2: 0, zoom: 1.04, edge: 'clamp' }, { image: scan });
  const ca = b.node('distort.chromaticAberration', { amount: 2.5, mode: 'radial', falloff: 1.5 }, { image: lens });
  const soft = b.node('analog.lensSoftness', { softness: 5, centerBlur: 0.8, sharpArea: 0.3, smear: 0.6 }, { image: ca });
  const flash = b.node('analog.flash', { strength: 0.55, falloff: 0.6, ambient: 0.55, ambientWarmth: 0.35, subjectBoost: 0.5, contrast: 0.3 }, { image: soft });
  const film = b.node('analog.filmCurve', { stock: 'consumer400', strength: 1, fade: 0.1 }, { image: flash });
  const hal = b.node('stylize.halation', { threshold: 0.75, amount: 0.5, radius: 10 }, { image: film });
  const vig = b.node('stylize.vignette', { amount: 0.3, radius: 0.7, softness: 0.8, roundness: 0.5 }, { image: hal });
  const leak = b.node('stylize.lightLeak', { edge: 'right', position: 0.3, size: 0.24, intensity: 0.2, streaks: 0.5 }, { image: vig });
  const date = b.node('analog.dateStamp', { text: "'98 11 06" }, { image: leak });
  const grain = b.node('stylize.grain', { amount: 0.5, size: 1.8, roughness: 0.55, chroma: 0.3 }, { image: date });
  const view = b.node('analog.resample', { mode: 'reference', filter: 'smooth' }, { image: grain, reference: img });
  b.output('out', view);
  b.expose('flash', flash, 'strength', 'Flash')
    .expose('warmth', film, 'warmth', 'Warmth')
    .expose('softness', soft, 'softness', 'Lens softness')
    .expose('grain', grain, 'amount', 'Grain')
    .expose('leak', leak, 'intensity', 'Light leak')
    .expose('vignette', vig, 'amount', 'Vignette')
    .expose('date', date, 'text', 'Date text');
  return {
    id: 'camera.disposable',
    name: 'Disposable Film Camera',
    category: 'Camera',
    tags: ['film', 'disposable', 'flash', '90s', 'point and shoot', 'date stamp', 'kodak', 'fuji'],
    description:
      'A drugstore single-use camera, printed and lab-scanned. Chain: scan resolution → plastic lens (barrel distortion, chromatic aberration, soft smeared corners) → ' +
      'direct on-camera flash (hotspot, dark warm background) → cheap ISO 400 consumer film (warm/green cast, lifted blacks) → halation → vignette → ' +
      'light leak → orange LED date stamp → film grain. Clear the date text to remove the imprint; set Light leak to 0 for a clean roll.',
    group: b.toGroup('Disposable Camera'),
  };
}

/** Instant film (Polaroid-like). */
function polaroid(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const soft = b.node('analog.lensSoftness', { softness: 4, centerBlur: 1.2, sharpArea: 0.25, smear: 0.3 }, { image: img });
  const film = b.node('analog.filmCurve', { stock: 'instant', strength: 1, fade: 0.05 }, { image: soft });
  const bal = b.node('color.colorBalance', { shadows: [0.47, 0.5, 0.54, 1], midtones: [0.5, 0.5, 0.5, 1], highlights: [0.54, 0.52, 0.47, 1], preserveLuma: true }, { image: film });
  const glow = b.node('stylize.bloom', { threshold: 0.65, knee: 0.5, intensity: 0.25, radius: 40, tint: [1, 0.95, 0.85, 1] }, { image: bal });
  const vig = b.node('stylize.vignette', { amount: 0.22, radius: 0.6, softness: 1.0, roundness: 0.8, color: [0.12, 0.08, 0.1, 1] }, { image: glow });
  const grain = b.node('stylize.grain', { amount: 0.18, size: 1.3, roughness: 0.3, chroma: 0.2 }, { image: vig });
  const frame = b.node('analog.instantFrame', { enabled: true, square: true }, { image: grain });
  b.output('out', frame);
  b.expose('fade', film, 'fade', 'Fade')
    .expose('strength', film, 'strength', 'Film strength')
    .expose('softness', soft, 'softness', 'Softness')
    .expose('glow', glow, 'intensity', 'Glow')
    .expose('vignette', vig, 'amount', 'Vignette')
    .expose('frame', frame, 'enabled', 'White frame')
    .expose('square', frame, 'square', 'Square crop');
  return {
    id: 'camera.polaroid',
    name: 'Instant Film',
    category: 'Camera',
    tags: ['polaroid', 'instant', 'instax', 'creamy', 'faded', 'frame'],
    description:
      'Integral instant film: soft plastic lens → instant stock (creamy low contrast, lifted blacks, cyan shadows, warm highlights) → extra split-tone balance → ' +
      'soft highlight glow → gentle warm-dark vignette → fine grain → white frame with the thick bottom border (toggle Frame / Square crop).',
    group: b.toGroup('Instant Film'),
  };
}

/** Low-light 2005 webcam. */
function webcam(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const sensor = b.node('analog.resample', { mode: 'width', width: 640, filter: 'smooth' }, { image: img });
  const dark = b.node('color.exposure', { exposure: -0.3, contrast: -0.1 }, { image: sensor });
  const wb = b.node('color.whiteBalance', { temperature: 0.3, tint: -0.15 }, { image: dark });
  const ccd = b.node('analog.ccdSensor', { exposure: 0.9, clipShift: 0.4, contrast: 0.3, blackCrush: 0.2, chromaNoise: 1.2, lumaNoise: 0.9, noiseSize: 1.5, fixedPattern: 0.7 }, { image: wb });
  const smooth = b.node('filter.gaussianBlur', { radius: 0.9, direction: 'both' }, { image: ccd });
  const sat = b.node('color.hsl', { saturation: -0.35 }, { image: smooth });
  const sharp = b.node('analog.edgeEnhance', { amount: 1.0, radius: 1.2, halo: 0.4 }, { image: sat });
  const jpeg = b.node('stylize.jpeg', { quality: 35, subsampling: '4:2:0' }, { image: sharp });
  const view = b.node('analog.resample', { mode: 'reference', filter: 'smooth' }, { image: jpeg, reference: img });
  b.output('out', view);
  b.expose('resolution', sensor, 'width', 'Resolution (px)')
    .expose('gain', ccd, 'exposure', 'Sensor gain')
    .expose('noise', ccd, 'chromaNoise', 'Noise')
    .expose('tint', wb, 'temperature', 'Indoor colour cast')
    .expose('quality', jpeg, 'quality', 'Compression quality');
  return {
    id: 'camera.webcam2005',
    name: '2005 Webcam',
    category: 'Camera',
    tags: ['webcam', 'msn', 'low light', 'noise', '640x480', 'y2k'],
    description:
      'A VGA webcam in a dim bedroom: 640 px sensor → underexposed, cranked sensor gain with heavy chroma and fixed-pattern noise and an orange-green indoor cast → ' +
      'smeary noise reduction, washed-out colour → crude sharpening → harsh JPEG.',
    group: b.toGroup('2005 Webcam'),
  };
}

/** Toy camera / lomo. */
function lomo(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const soft = b.node('analog.lensSoftness', { softness: 12, centerBlur: 0.5, sharpArea: 0.2, smear: 0.8, distortion: 0.05, chromatic: 4 }, { image: img });
  const film = b.node('analog.filmCurve', { stock: 'slide', strength: 1 }, { image: soft });
  const xpro = b.node('color.colorBalance', { shadows: [0.45, 0.5, 0.6, 1], midtones: [0.5, 0.52, 0.47, 1], highlights: [0.55, 0.54, 0.42, 1], preserveLuma: true }, { image: film });
  const vig = b.node('stylize.vignette', { amount: 0.75, radius: 0.45, softness: 0.9, roundness: 1 }, { image: xpro });
  const leak = b.node('stylize.lightLeak', { edge: 'left', position: 0.6, size: 0.35, intensity: 0.5, seed: 11 }, { image: vig });
  const grain = b.node('stylize.grain', { amount: 0.45, size: 2, roughness: 0.6, chroma: 0.25 }, { image: leak });
  b.output('out', grain);
  b.expose('vignette', vig, 'amount', 'Vignette')
    .expose('softness', soft, 'softness', 'Corner blur')
    .expose('crossProcess', xpro, 'highlights', 'Highlight tint')
    .expose('leak', leak, 'intensity', 'Light leak')
    .expose('grain', grain, 'amount', 'Grain');
  return {
    id: 'camera.lomo',
    name: 'Toy Camera (Lomo)',
    category: 'Camera',
    tags: ['lomo', 'holga', 'diana', 'toy camera', 'cross process', 'vignette'],
    description:
      'Plastic toy camera, cross-processed: smeared astigmatic corners with fringing → punchy slide stock → cross-process tint (blue shadows, yellow highlights) → ' +
      'heavy tunnel vignette → light leak → grain.',
    group: b.toGroup('Toy Camera'),
  };
}

export default (): PresetDef[] => [ccd2002(), disposable(), polaroid(), webcam(), lomo()];
