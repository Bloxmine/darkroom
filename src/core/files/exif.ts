/**
 * exifr output → ExifSummary (pure; used by the Electron main process and the web backend).
 * exifr is parsed with `translateValues: true, reviveValues: true, mergeOutput: true`.
 */
import type { ExifSummary, RawMetaLike } from './exifTypes';

export type { RawMetaLike };

/** exifr options shared by both backends (only the blocks we show; ifd1/thumbnail off). */
export const EXIFR_OPTIONS = {
  tiff: true,
  exif: true,
  gps: true,
  iptc: true,
  icc: true,
  xmp: true,
  ifd1: false,
  interop: false,
  makerNote: false,
  userComment: false,
  mergeOutput: true,
  translateKeys: true,
  translateValues: true,
  reviveValues: true,
  sanitize: true,
  multiSegment: true,
  // Node reads only the first chunks of each file; enough for EXIF in JPEG/TIFF/DNG/NEF/CR2/ARW/HEIC
  chunked: true,
  firstChunkSize: 128 * 1024,
  chunkSize: 64 * 1024,
  chunkLimit: 20,
} as const;

const str = (v: unknown): string | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') return v.replace(/\0+$/, '').trim() || undefined;
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.map(str).filter(Boolean).join(', ') || undefined;
  if (typeof v === 'object' && 'value' in (v as object)) return str((v as { value: unknown }).value);
  return undefined;
};
const num = (v: unknown): number | undefined => {
  if (Array.isArray(v)) v = v[0];
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};
const strs = (v: unknown): string[] | undefined => {
  if (v === undefined || v === null) return undefined;
  const a = (Array.isArray(v) ? v : String(v).split(/[;,]\s*/)).map(str).filter((x): x is string => !!x);
  return a.length ? a : undefined;
};

/** EXIF date (exifr revives it as a Date in local time from the wall-clock string) → ms with the wall clock as UTC fields. */
function wallClock(v: unknown): number | undefined {
  if (v instanceof Date && !isNaN(v.getTime())) return Date.UTC(v.getFullYear(), v.getMonth(), v.getDate(), v.getHours(), v.getMinutes(), v.getSeconds());
  if (typeof v === 'string') {
    const m = /^(\d{4})[:-](\d\d)[:-](\d\d)[ T](\d\d):(\d\d):?(\d\d)?/.exec(v);
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0));
  }
  return undefined;
}

const ORIENT: Record<string, number> = {
  'Horizontal (normal)': 1,
  'Mirror horizontal': 2,
  'Rotate 180': 3,
  'Mirror vertical': 4,
  'Mirror horizontal and rotate 270 CW': 5,
  'Rotate 90 CW': 6,
  'Mirror horizontal and rotate 90 CW': 7,
  'Rotate 270 CW': 8,
};

/** `raw`: the file is a camera RAW — its IFD0 ImageWidth/Height describe the embedded preview, not the photo. */
export function summarizeExif(o: Record<string, unknown> | null | undefined, xmpPacket?: string, opts: { raw?: boolean } = {}): ExifSummary | null {
  if (!o && !xmpPacket) return null;
  o ??= {};
  const s: ExifSummary = { source: 'exifr' };
  s.make = str(o.Make);
  s.model = str(o.Model);
  s.lens = str(o.LensModel) ?? str(o.Lens) ?? str(o.LensInfo && typeof o.LensInfo === 'string' ? o.LensInfo : undefined);
  s.exposureTime = num(o.ExposureTime);
  s.fNumber = num(o.FNumber) ?? num(o.ApertureValue);
  s.iso = num(o.ISO) ?? num(o.ISOSpeedRatings) ?? num(o.PhotographicSensitivity) ?? num(o['34855']);
  s.focalLength = num(o.FocalLength);
  s.focalLength35 = num(o.FocalLengthIn35mmFormat);
  s.exposureBias = num(o.ExposureCompensation) ?? num(o.ExposureBiasValue);
  s.exposureProgram = str(o.ExposureProgram);
  s.meteringMode = str(o.MeteringMode);
  s.flash = str(o.Flash);
  s.whiteBalance = str(o.WhiteBalance);
  s.dateTaken = wallClock(o.DateTimeOriginal) ?? wallClock(o['36867']) ?? wallClock(o.CreateDate) ?? wallClock(o.DateCreated) ?? wallClock(o.ModifyDate);
  const crop = Array.isArray(o.DefaultCropSize) ? (o.DefaultCropSize as number[]) : null;
  s.width = num(o.ExifImageWidth) ?? num(o.PixelXDimension) ?? (opts.raw ? num(crop?.[0]) : num(o.ImageWidth));
  s.height = num(o.ExifImageHeight) ?? num(o.PixelYDimension) ?? (opts.raw ? num(crop?.[1]) : num(o.ImageHeight));
  const ori = o.Orientation;
  s.orientation = typeof ori === 'number' ? ori : typeof ori === 'string' ? ORIENT[ori] : undefined;
  const lat = num(o.latitude);
  const lon = num(o.longitude);
  if (lat !== undefined && lon !== undefined && (lat !== 0 || lon !== 0)) s.gps = { lat, lon, alt: num(o.GPSAltitude) };
  s.colorProfile = str(o.ProfileDescription) ?? str(o.ICCProfileName);
  const cs = o.ColorSpace;
  s.colorSpace = cs === 1 || cs === 'sRGB' ? 'sRGB' : cs === 65535 || cs === 'Uncalibrated' ? 'Uncalibrated' : str(cs);
  s.software = str(o.Software);
  s.artist = str(o.Artist);
  s.copyright = str(o.Copyright);
  const iptc = {
    title: str(o.ObjectName) ?? str(o.Headline),
    description: str(o.Caption) ?? str(o['Caption-Abstract']),
    keywords: strs(o.Keywords),
    creator: str(o.Byline) ?? str(o['By-line']),
    copyright: str(o.CopyrightNotice),
    city: str(o.City),
    country: str(o.Country) ?? str(o['Country-PrimaryLocationName']),
  };
  if (Object.values(iptc).some((v) => v !== undefined)) s.iptc = iptc;
  if (xmpPacket) s.xmp = xmpPacket;
  for (const k of Object.keys(s) as (keyof ExifSummary)[]) if (s[k] === undefined) delete s[k];
  return s;
}

/** LibRaw metadata (src/core/raw: RawMeta) → ExifSummary, for RAW formats exifr can't read (CR3, RAF…). */
export function summarizeRawMeta(m: RawMetaLike): ExifSummary {
  const s: ExifSummary = {
    source: 'libraw',
    make: m.make || undefined,
    model: m.model || undefined,
    lens: m.lens || undefined,
    iso: m.iso || undefined,
    exposureTime: m.shutter || undefined,
    fNumber: m.aperture || undefined,
    focalLength: m.focalLength || undefined,
    width: m.width || undefined,
    height: m.height || undefined,
    orientation: m.flip === 3 ? 3 : m.flip === 5 ? 8 : m.flip === 6 ? 6 : 1,
  };
  if (m.timestamp) {
    // LibRaw gives a unix time computed from the camera's wall clock in local time
    const d = new Date(m.timestamp);
    s.dateTaken = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds());
  }
  for (const k of Object.keys(s) as (keyof ExifSummary)[]) if (s[k] === undefined) delete s[k];
  return s;
}
