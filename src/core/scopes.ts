/**
 * Pure maths for the viewer's pro tools (scopes, pixel readout, compare split).
 * No DOM / GL here so everything is unit-testable (scopes.test.ts).
 *
 * Colour conventions: Rec.709 luma and Y'CbCr on the (display-referred, gamma-encoded)
 * values the viewer shows. Cb/Cr are in [-0.5, 0.5].
 */

export const KR = 0.2126;
export const KB = 0.0722;
export const KG = 1 - KR - KB;

/** Rec.709 luma of gamma-encoded RGB (0..1). */
export const luma709 = (r: number, g: number, b: number) => KR * r + KG * g + KB * b;

/** Rec.709 Y'CbCr (full range): y in 0..1, cb/cr in -0.5..0.5. */
export function rgbToYCbCr709(r: number, g: number, b: number): { y: number; cb: number; cr: number } {
  const y = luma709(r, g, b);
  return { y, cb: (b - y) / (2 * (1 - KB)), cr: (r - y) / (2 * (1 - KR)) };
}

/**
 * Vectorscope position of a colour on a square plot of `size` px (y down, centre = neutral).
 * `gain` scales the chroma (1 = the ±0.5 Cb/Cr range reaches the plot edge).
 */
export function vectorscopeXY(r: number, g: number, b: number, size: number, gain = 1): [number, number] {
  const { cb, cr } = rgbToYCbCr709(r, g, b);
  const h = size / 2;
  return [h + cb * gain * size, h - cr * gain * size];
}

/** Angle (degrees, counter-clockwise from +Cb) and magnitude of a colour on the vectorscope. */
export function vectorAngle(r: number, g: number, b: number): { deg: number; mag: number } {
  const { cb, cr } = rgbToYCbCr709(r, g, b);
  let deg = (Math.atan2(cr, cb) * 180) / Math.PI;
  if (deg < 0) deg += 360;
  return { deg, mag: Math.hypot(cb, cr) };
}

/** The skin-tone ("I") line angle on a vectorscope, degrees CCW from +Cb. */
export const SKIN_TONE_DEG = 123;

/** Colour-bar targets (R, Mg, B, Cy, G, Yl) at `amp` (0.75 = 75% bars, 1 = 100%). */
export function vectorTargets(amp = 0.75): { label: string; rgb: [number, number, number]; cb: number; cr: number }[] {
  const bars: [string, [number, number, number]][] = [
    ['R', [1, 0, 0]],
    ['Mg', [1, 0, 1]],
    ['B', [0, 0, 1]],
    ['Cy', [0, 1, 1]],
    ['G', [0, 1, 0]],
    ['Yl', [1, 1, 0]],
  ];
  return bars.map(([label, c]) => {
    const rgb = c.map((x) => x * amp) as [number, number, number];
    const { cb, cr } = rgbToYCbCr709(...rgb);
    return { label, rgb, cb, cr };
  });
}

// ---------------------------------------------------------------------------
// Histogram / waveform from 8-bit RGBA (CPU path on a ≤ 320 px GPU decimation)
// ---------------------------------------------------------------------------

export interface Histogram {
  r: Uint32Array;
  g: Uint32Array;
  b: Uint32Array;
  /** Rec.709 luma. */
  y: Uint32Array;
  /** Pixels counted (fully transparent ones are skipped). */
  count: number;
}

/** Bin of an 8-bit or 0..1 value into 256 bins (clamped). */
export const bin256 = (v: number, unit = false) => Math.max(0, Math.min(255, unit ? Math.round(v * 255) : Math.round(v)));

/** 256-bin histograms of straight RGBA bytes. Transparent pixels (a = 0) are ignored. */
export function histogram(px: Uint8Array | Uint8ClampedArray): Histogram {
  const r = new Uint32Array(256);
  const g = new Uint32Array(256);
  const b = new Uint32Array(256);
  const y = new Uint32Array(256);
  let count = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    const R = px[i], G = px[i + 1], B = px[i + 2];
    r[R]++;
    g[G]++;
    b[B]++;
    y[bin256(KR * R + KG * G + KB * B)]++;
    count++;
  }
  return { r, g, b, y, count };
}

/**
 * Display normaliser for a histogram: the tallest bin ignoring the two end bins (clipped
 * pixels pile up there and would flatten everything else), unless those are all there is.
 */
export function histogramPeak(...bins: Uint32Array[]): number {
  let inner = 0;
  let all = 0;
  for (const h of bins)
    for (let i = 0; i < 256; i++) {
      if (h[i] > all) all = h[i];
      if (i > 0 && i < 255 && h[i] > inner) inner = h[i];
    }
  return inner || all || 1;
}

/** Fraction of pixels at/below `lo` (all channels) and at/above `hi` (any channel), 8-bit levels. */
export function clippedFractions(px: Uint8Array | Uint8ClampedArray, lo = 0, hi = 255): { shadows: number; highlights: number } {
  let s = 0, h = 0, n = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    n++;
    const R = px[i], G = px[i + 1], B = px[i + 2];
    if (R <= lo && G <= lo && B <= lo) s++;
    if (R >= hi || G >= hi || B >= hi) h++;
  }
  return n ? { shadows: s / n, highlights: h / n } : { shadows: 0, highlights: 0 };
}

export type WaveChannel = 'y' | 'r' | 'g' | 'b';

/**
 * Waveform accumulation: for each of `cols` output columns, a 256-level count of the
 * channel's values in the image columns that map to it. Result is cols × 256, row 0 = level 0.
 */
export function waveform(px: Uint8Array | Uint8ClampedArray, w: number, h: number, ch: WaveChannel, cols = w): Uint32Array {
  const out = new Uint32Array(cols * 256);
  const k = cols / w;
  for (let yy = 0; yy < h; yy++)
    for (let x = 0; x < w; x++) {
      const i = (yy * w + x) * 4;
      if (px[i + 3] === 0) continue;
      const v = ch === 'y' ? bin256(KR * px[i] + KG * px[i + 1] + KB * px[i + 2]) : px[i + (ch === 'r' ? 0 : ch === 'g' ? 1 : 2)];
      const c = Math.min(cols - 1, Math.floor(x * k));
      out[v * cols + c]++;
    }
  return out;
}

/** Vectorscope density on a size × size grid (row 0 = top). */
export function vectorscope(px: Uint8Array | Uint8ClampedArray, size: number, gain = 1): Uint32Array {
  const out = new Uint32Array(size * size);
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    const [x, y] = vectorscopeXY(px[i] / 255, px[i + 1] / 255, px[i + 2] / 255, size, gain);
    const xi = Math.floor(x), yi = Math.floor(y);
    if (xi < 0 || yi < 0 || xi >= size || yi >= size) continue;
    out[yi * size + xi]++;
  }
  return out;
}

/** Map an accumulation count to 0..1 brightness (soft "phosphor" response). */
export const phosphor = (count: number, density: number) => (count ? 1 - Math.exp(-count * density) : 0);

// ---------------------------------------------------------------------------
// Pixel readout
// ---------------------------------------------------------------------------

/** RGB (0..1) → HSL (h in degrees, s/l in 0..1). */
export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r = clamp01(r);
  g = clamp01(g);
  b = clamp01(b);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return [h, s, l];
}

export const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
export const to255 = (x: number) => Math.round(clamp01(x) * 255);
export const hex6 = (r: number, g: number, b: number) => '#' + [r, g, b].map((x) => to255(x).toString(16).padStart(2, '0')).join('').toUpperCase();

/** Average RGBA of a float RGBA block (n pixels). */
export function averageRgba(px: ArrayLike<number>): [number, number, number, number] {
  const n = Math.floor(px.length / 4) || 1;
  const s = [0, 0, 0, 0];
  for (let i = 0; i + 3 < px.length; i += 4) for (let c = 0; c < 4; c++) s[c] += px[i + c];
  return s.map((x) => x / n) as [number, number, number, number];
}

/** Display rect of the image in the viewer (device px) — see store/engine.ts imageRect(). */
export interface ViewRect {
  x: number;
  y: number;
  w: number;
  h: number;
  fullW: number;
  fullH: number;
}

/** Canvas device px → full-resolution image px (integer), or null outside the image. */
export function canvasToImagePx(cx: number, cy: number, r: ViewRect): { x: number; y: number } | null {
  if (!r.w || !r.h || !r.fullW || !r.fullH) return null;
  const u = (cx - r.x) / r.w;
  const v = (cy - r.y) / r.h;
  if (u < 0 || v < 0 || u >= 1 || v >= 1) return null;
  return { x: Math.min(r.fullW - 1, Math.floor(u * r.fullW)), y: Math.min(r.fullH - 1, Math.floor(v * r.fullH)) };
}

/** Full-res image px → texel of a (preview-scale) texture of texW × texH. Row 0 = image top. */
export function imageToTexel(ix: number, iy: number, fullW: number, fullH: number, texW: number, texH: number): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(texW - 1, Math.floor(((ix + 0.5) / fullW) * texW))),
    y: Math.max(0, Math.min(texH - 1, Math.floor(((iy + 0.5) / fullH) * texH))),
  };
}

/** Clamp an n×n sample block centred on (x, y) to a w × h texture: [x0, y0, bw, bh]. */
export function sampleBlock(x: number, y: number, n: number, w: number, h: number): [number, number, number, number] {
  const r = Math.floor(n / 2);
  const x0 = Math.max(0, x - r), y0 = Math.max(0, y - r);
  const x1 = Math.min(w - 1, x + r), y1 = Math.min(h - 1, y + r);
  return [x0, y0, Math.max(1, x1 - x0 + 1), Math.max(1, y1 - y0 + 1)];
}

// ---------------------------------------------------------------------------
// A/B compare
// ---------------------------------------------------------------------------

/** 'h' = left / right split (vertical line), 'v' = top / bottom split (horizontal line), 'toggle' = whole frame. */
export type CompareMode = 'h' | 'v' | 'toggle';

/**
 * Is a pointer (CSS px, relative to the viewer) on the split handle?
 * `split` is the fraction of the viewer width ('h') or height ('v').
 * The whole line is grabbable within `tol` px; the knob in the middle has a larger radius.
 */
export function splitHit(px: number, py: number, mode: CompareMode, split: number, w: number, h: number, tol = 10, knob = 18): boolean {
  if (mode === 'toggle' || !w || !h) return false;
  if (mode === 'h') {
    const lx = split * w;
    if (Math.abs(px - lx) <= tol && py >= 0 && py <= h) return true;
    return Math.hypot(px - lx, py - h / 2) <= knob;
  }
  const ly = split * h;
  if (Math.abs(py - ly) <= tol && px >= 0 && px <= w) return true;
  return Math.hypot(px - w / 2, py - ly) <= knob;
}

/** New split fraction from a pointer position, clamped to [0, 1]. */
export function splitFromPointer(px: number, py: number, mode: CompareMode, w: number, h: number): number {
  return clamp01(mode === 'v' ? py / (h || 1) : px / (w || 1));
}

/**
 * Which side of the split a pointer is on: 'ref' (the comparison image) or 'main' (the viewed node).
 * The reference occupies the left / top part unless `swap`.
 */
export function splitSide(px: number, py: number, mode: CompareMode, split: number, w: number, h: number, swap = false, holding = false): 'ref' | 'main' {
  if (holding) return 'ref';
  if (mode === 'toggle') return 'main';
  const before = mode === 'h' ? px < split * w : py < split * h;
  return before !== swap ? 'ref' : 'main';
}
