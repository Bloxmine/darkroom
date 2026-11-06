import { GraphBuilder } from '../core/graph';
import type { PresetDef } from '../core/types';

/** VHS camcorder tape played back on a VCR. */
function vhs(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const cam = b.node('analog.edgeEnhance', { amount: 0.6, radius: 2.5, halo: 0.5 }, { image: img });
  const lev = b.node('color.levels', { inBlack: 0.02, inWhite: 0.92, gamma: 1.05, outBlack: 0.055, outWhite: 0.97 }, { image: cam });
  const sig = b.node('analog.vhsChroma', { lumaRes: 300, chromaRes: 34, lines: 480, sharpen: 0.9, chromaShift: 0.55, chromaBleed: 1.1, saturation: 1.3 }, { image: lev });
  const noise = b.node('analog.vhsNoise', { luma: 0.4, chroma: 0.55, snow: 0.2 }, { image: sig });
  const track = b.node('analog.vhsTracking', { jitter: 0.5, wobble: 0.5, tracking: 0.45, bandPosition: 0.86, bandHeight: 0.05, headSwitch: 0.8, dropouts: 0.3 }, { image: noise });
  const scan = b.node('stylize.scanlines', { period: 2.2, intensity: 0.12, thickness: 0.4, beam: 0.6 }, { image: track });
  const osd = b.node('analog.osd', { topLeft: 'PLAY ▶', bottomLeft: 'AM 10:42\nNOV. 06 1998' }, { image: scan });
  b.output('out', osd);
  b.expose('tracking', track, 'tracking', 'Tracking noise')
    .expose('bandPosition', track, 'bandPosition', 'Tracking band position')
    .expose('jitter', track, 'jitter', 'Jitter')
    .expose('bleed', sig, 'chromaBleed', 'Colour bleed')
    .expose('saturation', sig, 'saturation', 'Saturation')
    .expose('noise', noise, 'luma', 'Tape noise')
    .expose('osd', osd, 'topLeft', 'OSD text')
    .expose('timestamp', osd, 'bottomLeft', 'Timestamp');
  return {
    id: 'video.vhs',
    name: 'VHS Camcorder',
    category: 'Video',
    tags: ['vhs', 'camcorder', 'tape', '90s', 'home video', 'vcr', 'analog video'],
    description:
      'A home-video tape on a tired VCR. Chain: camcorder edge enhancement → video levels (lifted black, soft white) → VHS signal path in YIQ ' +
      '(≈300-line luma with ringing, ≈34-line chroma that bleeds right and lags) → tape noise and chroma confetti → tracking (line jitter, rolling noise band, ' +
      'head-switching skew at the bottom, dropouts) → faint scanlines → VCR on-screen display. Move the tracking band or clear the OSD texts to taste.',
    group: b.toGroup('VHS Camcorder'),
  };
}

/** Super 8 home movie frame. */
function super8(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const res = b.node('analog.resample', { mode: 'width', width: 1000, filter: 'smooth' }, { image: img });
  const soft = b.node('analog.lensSoftness', { softness: 6, centerBlur: 1.5, sharpArea: 0.2, smear: 0.4 }, { image: res });
  const film = b.node('analog.filmCurve', { stock: 'slide', strength: 0.85, fade: 0.25, warmth: 0.4 }, { image: soft });
  const hal = b.node('stylize.halation', { threshold: 0.7, amount: 0.8, radius: 8 }, { image: film });
  const gate = b.node('stylize.vignette', { amount: 0.6, radius: 0.55, softness: 0.7, roundness: 0.3 }, { image: hal });
  const weave = b.node('distort.transform', { offset: [0.004, -0.006], scale: 1.03, rotate: 0.3, wrap: 'clamp' }, { image: gate });
  const gw = b.node('analog.gateWeave', { amount: 4, jitter: 0.6, rotation: 0.2, flicker: 0.08 }, { image: weave }); // motion only
  const grain = b.node('stylize.grain', { amount: 0.8, size: 2.2, roughness: 0.7, chroma: 0.35 }, { image: gw });
  const leak = b.node('stylize.lightLeak', { edge: 'top', position: 0.7, size: 0.5, intensity: 0.35, seed: 8 }, { image: grain });
  const view = b.node('analog.resample', { mode: 'reference', filter: 'smooth' }, { image: leak, reference: img });
  b.output('out', view);
  b.expose('grain', grain, 'amount', 'Grain')
    .expose('fade', film, 'fade', 'Fade')
    .expose('warmth', film, 'warmth', 'Warmth')
    .expose('gate', gate, 'amount', 'Gate vignette')
    .expose('flare', leak, 'intensity', 'Flare');
  return {
    id: 'video.super8',
    name: 'Super 8 Film',
    category: 'Video',
    tags: ['super 8', 'home movie', '8mm', 'film', '70s', 'kodachrome'],
    description:
      'A frame of 70s Super 8 reversal film: tiny frame resolution → soft lens → faded warm reversal stock → strong halation → gate vignette → frame weave → coarse grain → flare.',
    group: b.toGroup('Super 8'),
  };
}

export default (): PresetDef[] => [vhs(), super8()];
