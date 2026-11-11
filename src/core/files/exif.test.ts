import { describe, expect, it } from 'vitest';
import { largestEmbeddedJpeg, sniffDimensions } from './dims';
import { summarizeExif, summarizeRawMeta } from './exif';

describe('EXIF summary', () => {
  it('normalises exifr output', () => {
    const s = summarizeExif(
      { Make: 'Canon', Model: 'Canon EOS R5', LensModel: 'RF24-70mm', ExposureTime: 0.004, FNumber: 4, ISO: 100, FocalLength: 35, DateTimeOriginal: new Date(2024, 6, 9, 18, 5, 7), Orientation: 'Rotate 90 CW', latitude: 52.37, longitude: 4.89, ColorSpace: 1, ImageWidth: 6000, ImageHeight: 4000 },
      '<x:xmpmeta/>',
    )!;
    expect(s).toMatchObject({ make: 'Canon', model: 'Canon EOS R5', lens: 'RF24-70mm', exposureTime: 0.004, fNumber: 4, iso: 100, focalLength: 35, orientation: 6, gps: { lat: 52.37, lon: 4.89 }, colorSpace: 'sRGB', width: 6000, height: 4000, xmp: '<x:xmpmeta/>' });
    expect(new Date(s.dateTaken!).toISOString()).toBe('2024-07-09T18:05:07.000Z'); // wall clock kept as UTC fields
  });

  it('ignores the preview size of RAW files and reads TIFF-EP tags', () => {
    const s = summarizeExif({ ImageWidth: 320, ImageHeight: 240, '36867': '2018:07:08 10:30:28', DefaultCropSize: [3920, 2638] }, undefined, { raw: true })!;
    expect([s.width, s.height]).toEqual([3920, 2638]);
    expect(new Date(s.dateTaken!).toISOString()).toBe('2018-07-08T10:30:28.000Z');
  });

  it('maps LibRaw metadata', () => {
    const s = summarizeRawMeta({ make: 'Fujifilm', model: 'X-T4', iso: 640, shutter: 0.01, aperture: 2.8, focalLength: 23, width: 6240, height: 4160, flip: 6 });
    expect(s).toMatchObject({ source: 'libraw', make: 'Fujifilm', model: 'X-T4', iso: 640, orientation: 6 });
  });
});

describe('dimension sniffing', () => {
  it('reads PNG, GIF and JPEG headers', () => {
    const png = new Uint8Array(32);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 2, 0, 0, 0, 1, 0]);
    expect(sniffDimensions(png)).toEqual({ width: 512, height: 256 });
    const gif = new Uint8Array(32);
    gif.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 120, 0, 90, 0]);
    expect(sniffDimensions(gif)).toEqual({ width: 120, height: 90 });
    // SOI, APP0 (len 16), SOF0 with 300×200
    const jpg = new Uint8Array(64);
    jpg.set([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
    jpg.set([0xff, 0xc0, 0, 17, 8, 0, 200, 1, 44, 3], 2 + 2 + 16);
    expect(sniffDimensions(jpg)).toEqual({ width: 300, height: 200 });
  });

  it('finds the largest embedded JPEG', () => {
    const mk = (n: number) => [0xff, 0xd8, 0xff, 0xda, 0, 2, ...new Array(n).fill(0x11), 0xff, 0xd9];
    const buf = new Uint8Array([1, 2, 3, ...mk(10), 9, 9, ...mk(40), 7]);
    const j = largestEmbeddedJpeg(buf, 0)!;
    expect(j.length).toBe(48);
    expect([j[0], j[1], j[j.length - 2], j[j.length - 1]]).toEqual([0xff, 0xd8, 0xff, 0xd9]);
  });
});
