/**
 * RAW develop settings (pure, no DOM): node params → LibRaw settings,
 * white-balance maths and metadata formatting. Tested in develop.test.ts.
 */
import type { Params, RawMeta, RawTex } from '../types';

export const WB_MODES = ['as shot', 'auto', 'daylight', 'custom'] as const;
export const HIGHLIGHT_MODES = ['clip', 'unclip', 'blend', 'rebuild'] as const;
export const OUTPUT_MODES = ['16-bit linear', '8-bit sRGB'] as const;
export const DEMOSAIC_MODES = ['AHD', 'DHT', 'AAHD', 'DCB', 'PPG', 'VNG', 'Linear'] as const;
export const DENOISE_MODES = ['off', 'light', 'full'] as const;

export type WbMode = (typeof WB_MODES)[number];
export type HighlightMode = (typeof HIGHLIGHT_MODES)[number];
export type OutputMode = (typeof OUTPUT_MODES)[number];
export type DemosaicMode = (typeof DEMOSAIC_MODES)[number];
export type DenoiseMode = (typeof DENOISE_MODES)[number];

/** The subset of params that require a re-decode (everything else is applied on the GPU). */
export interface DecodeOptions {
  wb: WbMode;
  highlight: HighlightMode;
  output: OutputMode;
  demosaic: DemosaicMode;
  denoise: DenoiseMode;
  /** LibRaw half_size: 2×2 binning, no demosaic — 4× fewer pixels, much faster. */
  half: boolean;
}

/** Reference colour temperature of LibRaw's "daylight" multipliers (and of WB = custom at 0 tint). */
export const REFERENCE_KELVIN = 5500;

const pick = <T extends readonly string[]>(list: T, v: unknown, d: T[number]): T[number] => (list.includes(v as string) ? (v as T[number]) : d);

/** Should this render use a half-size decode? (preview at ≤ 50 % scale when "fast preview" is on). */
export const wantsHalfSize = (params: Params, scale: number) => params.fastPreview !== false && scale <= 0.5 + 1e-6;

export function decodeOptions(params: Params, scale: number): DecodeOptions {
  return {
    wb: pick(WB_MODES, params.whiteBalance, 'as shot'),
    highlight: pick(HIGHLIGHT_MODES, params.highlights, 'clip'),
    output: pick(OUTPUT_MODES, params.output, '16-bit linear'),
    demosaic: pick(DEMOSAIC_MODES, params.demosaic, 'AHD'),
    denoise: pick(DENOISE_MODES, params.denoise, 'off'),
    half: wantsHalfSize(params, scale),
  };
}

/** Stable cache key for a decode. Demosaic is irrelevant for half-size decodes (no interpolation). */
export function decodeKey(o: DecodeOptions): string {
  const wb = o.wb === 'custom' ? 'daylight' : o.wb; // custom = daylight decode + GPU gains
  return [wb, o.highlight, o.output, o.half ? 'half' : o.demosaic, o.denoise, o.half ? 'h' : 'f'].join('|');
}

const QUAL: Record<DemosaicMode, number> = { Linear: 0, VNG: 1, PPG: 2, AHD: 3, DCB: 4, DHT: 11, AAHD: 12 };
const HL: Record<HighlightMode, number> = { clip: 0, unclip: 1, blend: 2, rebuild: 5 };
const NR: Record<DenoiseMode, number> = { off: 0, light: 1, full: 2 };

/** LibRaw (libraw-wasm) settings object for a decode. */
export function libRawSettings(o: DecodeOptions): Record<string, unknown> {
  return {
    halfSize: o.half,
    useCameraWb: o.wb === 'as shot',
    useAutoWb: o.wb === 'auto',
    highlight: HL[o.highlight],
    outputColor: 1, // sRGB primaries
    // libraw-wasm's imageData() is always linear (gamm is ignored, 8-bit output is just linear >> 8),
    // so decode 16-bit and do the 8-bit sRGB encoding ourselves (see decoder.toRgba)
    outputBps: 16,
    gamm: [1, 1],
    noAutoBright: true, // exposure is a node param, keep decodes comparable
    userQual: QUAL[o.demosaic],
    fbddNoiserd: NR[o.denoise],
    userFlip: -1, // respect the camera's orientation tag
  };
}

// ---------------------------------------------------------------------------
// White balance
// ---------------------------------------------------------------------------

/** Chromaticity (x,y) of a Planckian radiator at T kelvin (Kim et al. cubic spline, 1667–25000 K). */
export function planckianXy(T: number): [number, number] {
  T = Math.min(25000, Math.max(1667, T));
  const t = 1e3 / T, t2 = t * t, t3 = t2 * t;
  const x = T <= 4000 ? -0.2661239 * t3 - 0.2343589 * t2 + 0.8776956 * t + 0.17991 : -3.0258469 * t3 + 2.1070379 * t2 + 0.2226347 * t + 0.24039;
  const x2 = x * x, x3 = x2 * x;
  const y =
    T <= 2222
      ? -1.1063814 * x3 - 1.3481102 * x2 + 2.18555832 * x - 0.20219683
      : T <= 4000
        ? -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867
        : 3.081758 * x3 - 5.8733867 * x2 + 3.75112997 * x - 0.37001483;
  return [x, y];
}

/** Linear-sRGB colour of a white light at T kelvin, normalised to G = 1. */
export function kelvinToRgb(T: number): [number, number, number] {
  const [x, y] = planckianXy(T);
  const X = x / y, Y = 1, Z = (1 - x - y) / y;
  const r = 3.2406 * X - 1.5372 * Y - 0.4986 * Z;
  const g = -0.9689 * X + 1.8758 * Y + 0.0415 * Z;
  const b = 0.0557 * X - 0.204 * Y + 1.057 * Z;
  return [Math.max(1e-4, r / g), 1, Math.max(1e-4, b / g)];
}

/**
 * Per-channel gains (linear sRGB) that neutralise a light of `kelvin` / `tint`
 * relative to the daylight decode. Lightroom convention: a lower temperature
 * makes the image bluer; positive tint adds magenta. Normalised to luminance 1.
 */
export function wbGains(kelvin: number, tint: number): [number, number, number] {
  const ref = kelvinToRgb(REFERENCE_KELVIN);
  const src = kelvinToRgb(kelvin);
  const g = [ref[0] / src[0], 1, ref[2] / src[2]];
  g[1] *= Math.pow(2, -Math.max(-150, Math.min(150, tint)) / 150);
  const lum = 0.2126 * g[0] + 0.7152 * g[1] + 0.0722 * g[2];
  return [g[0] / lum, g[1] / lum, g[2] / lum];
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

/** EXIF-style orientation: LibRaw flip 5/6 rotate by 90°, swapping width and height. */
export function orientedSize(width: number, height: number, flip: number): [number, number] {
  return flip === 5 || flip === 6 ? [height, width] : [width, height];
}

export function formatShutter(s: number): string {
  if (!s || !isFinite(s)) return '';
  if (s >= 0.3) return `${Math.round(s * 10) / 10} s`;
  return `1/${Math.round(1 / s)} s`;
}

/** Normalise the libraw-wasm metadata object into RawMeta. */
export function toRawMeta(m: Record<string, unknown>): RawMeta {
  const n = (k: string) => (typeof m[k] === 'number' && isFinite(m[k] as number) ? (m[k] as number) : 0);
  const s = (k: string) => (typeof m[k] === 'string' ? String(m[k]).trim() : '');
  const ts = m.timestamp;
  const t = ts instanceof Date ? ts.getTime() : typeof ts === 'number' ? ts * 1000 : typeof ts === 'string' ? Date.parse(ts) : NaN;
  const lens = (m.lens as Record<string, unknown> | undefined)?.Lens;
  return {
    make: s('camera_make'),
    model: s('camera_model'),
    iso: n('iso_speed'),
    shutter: n('shutter'),
    aperture: n('aperture'),
    focalLength: n('focal_len'),
    lens: typeof lens === 'string' ? lens.trim() : undefined,
    timestamp: isFinite(t) && t > 0 ? t : undefined,
    width: n('width'),
    height: n('height'),
    flip: n('flip'),
  };
}

/** Human-readable metadata rows. */
export function metaRows(m: RawMeta): [string, string][] {
  const rows: [string, string][] = [];
  const cam = [m.make, m.model.startsWith(m.make) ? m.model.slice(m.make.length).trim() : m.model].filter(Boolean).join(' ');
  if (cam) rows.push(['Camera', cam]);
  if (m.lens) rows.push(['Lens', m.lens]);
  const exp = [m.iso ? `ISO ${Math.round(m.iso)}` : '', formatShutter(m.shutter), m.aperture ? `f/${Math.round(m.aperture * 10) / 10}` : '', m.focalLength ? `${Math.round(m.focalLength * 10) / 10} mm` : '']
    .filter(Boolean)
    .join(' · ');
  if (exp) rows.push(['Exposure', exp]);
  if (m.width) {
    const [w, h] = orientedSize(m.width, m.height, m.flip);
    rows.push(['Sensor', `${w} × ${h} px (${((w * h) / 1e6).toFixed(1)} MP)`]);
  }
  if (m.timestamp) rows.push(['Taken', new Date(m.timestamp).toISOString().replace('T', ' ').slice(0, 16)]);
  return rows;
}

/** One-line summary, e.g. "Canon PowerShot A410 · ISO 50 · 1/424 s · f/5.5 · 9.8 mm". */
export const metaSummary = (m: RawMeta) =>
  metaRows(m)
    .filter(([k]) => k === 'Camera' || k === 'Exposure')
    .map(([, v]) => v)
    .join(' · ');

/** 65536-entry LUT: 16-bit linear → 8-bit sRGB-encoded. */
let srgbLut: Uint8Array | null = null;
export function linear16ToSrgb8Lut(): Uint8Array {
  if (srgbLut) return srgbLut;
  srgbLut = new Uint8Array(65536);
  for (let i = 0; i < 65536; i++) {
    const c = i / 65535;
    const v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    srgbLut[i] = Math.round(Math.min(1, Math.max(0, v)) * 255);
  }
  return srgbLut;
}

/**
 * Convert LibRaw's packed linear RGB (or mono) output to an RGBA RawTex:
 * Float32 linear (full precision, RGBA16F on the GPU) or, with `srgb8`,
 * 8-bit sRGB-encoded (4× less memory; the shader linearises it again).
 */
export function toRgba(img: { width: number; height: number; colors: number; bits: number; data: Uint8Array | Uint16Array }, srgb8 = false): RawTex {
  const { width, height, colors } = img;
  const n = width * height;
  const src = img.data;
  if (img.bits === 16 || src instanceof Uint16Array) {
    const s = src instanceof Uint16Array ? src : new Uint16Array(src.buffer, src.byteOffset, src.byteLength >> 1);
    if (srgb8) {
      const lut = linear16ToSrgb8Lut();
      const out = new Uint8Array(n * 4);
      for (let i = 0, j = 0, o = 0; i < n; i++, j += colors, o += 4) {
        out[o] = lut[s[j]];
        out[o + 1] = lut[s[colors >= 3 ? j + 1 : j]];
        out[o + 2] = lut[s[colors >= 3 ? j + 2 : j]];
        out[o + 3] = 255;
      }
      return { width, height, data: out };
    }
    const out = new Float32Array(n * 4);
    const k = 1 / 65535;
    if (colors >= 3) for (let i = 0, j = 0, o = 0; i < n; i++, j += colors, o += 4) {
      out[o] = s[j] * k;
      out[o + 1] = s[j + 1] * k;
      out[o + 2] = s[j + 2] * k;
      out[o + 3] = 1;
    }
    else
      for (let i = 0, o = 0; i < n; i++, o += 4) {
        out[o] = out[o + 1] = out[o + 2] = s[i * colors] * k;
        out[o + 3] = 1;
      }
    return { width, height, data: out };
  }
  const out = new Uint8Array(n * 4);
  const s = src as Uint8Array;
  for (let i = 0, j = 0, o = 0; i < n; i++, j += colors, o += 4) {
    out[o] = s[j];
    out[o + 1] = s[colors >= 3 ? j + 1 : j];
    out[o + 2] = s[colors >= 3 ? j + 2 : j];
    out[o + 3] = 255;
  }
  return { width, height, data: out };
}

