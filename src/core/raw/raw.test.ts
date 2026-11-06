import { describe, expect, it } from 'vitest';
import { decodeKey, decodeOptions, formatShutter, kelvinToRgb, libRawSettings, linear16ToSrgb8Lut, metaRows, metaSummary, orientedSize, toRawMeta, toRgba, wbGains } from './develop';
import { extOf, IMPORT_ACCEPT, isImportableImage, isPlainImageFile, isProjectFile, isRawFile, isRawStoreRef, RAW_ACCEPT, RAW_EXTENSIONS, rawMimeFor } from './formats';

describe('RAW format detection', () => {
  it('recognises RAW extensions case-insensitively', () => {
    for (const n of ['a.dng', 'B.CR2', 'c.cr3', 'd.NEF', 'e.arw', 'f.RAF', 'g.orf', 'h.rw2', 'i.pef', 'j.srw', 'k.3fr', 'l.iiq', 'IMG_0001.CR3']) expect(isRawFile(n), n).toBe(true);
    for (const n of ['a.jpg', 'b.png', 'c.webp', 'c.tif', 'noext', 'dng', 'archive.dng.zip', '']) expect(isRawFile(n), n).toBe(false);
  });
  it('uses the MIME type when the name has no RAW extension', () => {
    expect(isRawFile('blob', 'image/x-adobe-dng')).toBe(true);
    expect(isRawFile('x', 'image/x-canon-cr2')).toBe(true);
    expect(isRawFile('x', 'image/jpeg')).toBe(false);
  });
  it('separates plain images from RAWs (DNG often arrives as image/x-adobe-dng)', () => {
    expect(isPlainImageFile('a.jpg', '')).toBe(true);
    expect(isPlainImageFile('pasted', 'image/png')).toBe(true);
    expect(isPlainImageFile('a.dng', 'image/x-adobe-dng')).toBe(false);
    expect(isPlainImageFile('a.dng', 'image/tiff')).toBe(false);
    expect(isImportableImage('a.dng')).toBe(true);
    expect(isImportableImage('a.txt', 'text/plain')).toBe(false);
    expect(isImportableImage('song.mp3', 'audio/mpeg')).toBe(false);
  });
  it('builds accept strings and MIME types', () => {
    expect(RAW_ACCEPT.split(',')).toContain('.nef');
    expect(IMPORT_ACCEPT.startsWith('image/*,')).toBe(true);
    expect(RAW_EXTENSIONS.length).toBeGreaterThan(20);
    expect(rawMimeFor('x.NEF')).toBe('image/x-nikon-nef');
    expect(rawMimeFor('x.bin', '')).toBe('image/x-raw');
    expect(extOf('a.b/c.Dng')).toBe('dng');
    expect(extOf('folder.d/file')).toBe('');
    expect(isProjectFile('My Look.darkroom')).toBe(true);
    expect(isRawStoreRef('idb:raw/a1')).toBe(true);
    expect(isRawStoreRef('data:image/png;base64,')).toBe(false);
  });
});

describe('develop settings', () => {
  it('maps params to LibRaw settings', () => {
    const o = decodeOptions({ whiteBalance: 'auto', highlights: 'rebuild', demosaic: 'DHT', denoise: 'light' }, 1);
    const s = libRawSettings(o);
    expect(s).toMatchObject({ useAutoWb: true, useCameraWb: false, highlight: 5, userQual: 11, fbddNoiserd: 1, halfSize: false, outputBps: 16, noAutoBright: true, userFlip: -1 });
    expect(libRawSettings(decodeOptions({}, 1))).toMatchObject({ useCameraWb: true, highlight: 0, userQual: 3 });
  });
  it('uses half-size decodes for previews at <= 50 % unless fast preview is off', () => {
    expect(decodeOptions({}, 0.5).half).toBe(true);
    expect(decodeOptions({}, 0.25).half).toBe(true);
    expect(decodeOptions({}, 0.625).half).toBe(false);
    expect(decodeOptions({ fastPreview: false }, 0.25).half).toBe(false);
  });
  it('shares one decode between custom WB and daylight, and ignores demosaic for half size', () => {
    const k = (p: Record<string, string>, s = 1) => decodeKey(decodeOptions(p, s));
    expect(k({ whiteBalance: 'custom' })).toBe(k({ whiteBalance: 'daylight' }));
    expect(k({ whiteBalance: 'as shot' })).not.toBe(k({ whiteBalance: 'daylight' }));
    expect(k({ demosaic: 'AHD' }, 0.25)).toBe(k({ demosaic: 'DHT' }, 0.25));
    expect(k({ demosaic: 'AHD' }, 1)).not.toBe(k({ demosaic: 'DHT' }, 1));
    expect(k({}, 0.25)).not.toBe(k({}, 1));
  });
  it('falls back to defaults for unknown enum values', () => {
    expect(decodeOptions({ whiteBalance: 'bogus', output: 7 }, 1)).toMatchObject({ wb: 'as shot', output: '16-bit linear' });
  });
});

describe('white balance', () => {
  it('kelvinToRgb: warm lights are red, cool lights are blue', () => {
    const warm = kelvinToRgb(2700), d65 = kelvinToRgb(6504), cool = kelvinToRgb(10000);
    expect(warm[0]).toBeGreaterThan(warm[2]);
    expect(cool[2]).toBeGreaterThan(cool[0]);
    // a 6504 K Planckian light is close to neutral in sRGB (D65 sits slightly off the Planckian locus)
    expect(Math.abs(d65[0] - 1)).toBeLessThan(0.1);
    expect(Math.abs(d65[2] - 1)).toBeLessThan(0.1);
  });
  it('wbGains: reference temperature is neutral; tungsten correction adds blue', () => {
    const n = wbGains(5500, 0);
    expect(n[0]).toBeCloseTo(1, 5);
    expect(n[1]).toBeCloseTo(1, 5);
    expect(n[2]).toBeCloseTo(1, 5);
    const t = wbGains(3200, 0);
    expect(t[2]).toBeGreaterThan(t[0]);
    const m = wbGains(5500, 50);
    expect(m[1]).toBeLessThan(m[0]); // magenta tint = less green
    const lum = (g: number[]) => 0.2126 * g[0] + 0.7152 * g[1] + 0.0722 * g[2];
    expect(lum(t)).toBeCloseTo(1, 5);
  });
});

describe('metadata', () => {
  const meta = toRawMeta({ camera_make: 'Canon', camera_model: 'PowerShot A410', iso_speed: 50, shutter: 0.002356, aperture: 5.5, focal_len: 9.8, width: 2088, height: 1552, flip: 6, timestamp: new Date('2017-04-09T14:00:37Z') });
  it('normalises and orients', () => {
    expect(meta).toMatchObject({ make: 'Canon', iso: 50, flip: 6, width: 2088 });
    expect(orientedSize(2088, 1552, 6)).toEqual([1552, 2088]);
    expect(orientedSize(2088, 1552, 3)).toEqual([2088, 1552]);
  });
  it('formats', () => {
    expect(formatShutter(0.002356)).toBe('1/424 s');
    expect(formatShutter(2)).toBe('2 s');
    expect(metaSummary(meta)).toBe('Canon PowerShot A410 · ISO 50 · 1/424 s · f/5.5 · 9.8 mm');
    expect(metaRows(meta).find(([k]) => k === 'Sensor')?.[1]).toBe('1552 × 2088 px (3.2 MP)');
    expect(metaSummary(toRawMeta({ camera_make: 'NIKON CORPORATION', camera_model: 'NIKON CORPORATION NIKON 1 J1' }))).toBe('NIKON CORPORATION NIKON 1 J1');
  });
});

describe('pixel conversion', () => {
  it('converts 16-bit RGB to Float32 RGBA and 8-bit sRGB', () => {
    const img = { width: 2, height: 1, colors: 3, bits: 16, data: new Uint16Array([0, 65535, 32768, 65535, 0, 3000]) };
    const f = toRgba(img);
    expect(f.data).toBeInstanceOf(Float32Array);
    expect([...f.data].map((v) => +v.toFixed(3))).toEqual([0, 1, 0.5, 1, 1, 0, 0.046, 1]);
    const b = toRgba(img, true);
    expect(b.data).toBeInstanceOf(Uint8Array);
    expect([...b.data]).toEqual([0, 255, 188, 255, 255, 0, 60, 255]);
    expect(linear16ToSrgb8Lut()[65535]).toBe(255);
  });
  it('expands monochrome', () => {
    const f = toRgba({ width: 1, height: 1, colors: 1, bits: 16, data: new Uint16Array([65535]) });
    expect([...f.data]).toEqual([1, 1, 1, 1]);
  });
});
