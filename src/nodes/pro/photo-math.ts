/**
 * Pure maths of the photography nodes (unit-tested): the Debevec–Malik hat weighting and radiance
 * merge mirrored by pro.mergeHdr's shader, and FFT phase correlation used to align brackets.
 */
import type { NodeDef, RawTex } from '../../core/types';

export default [] as NodeDef[];

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/**
 * Triangle ("hat") weight of an encoded pixel value z ∈ [0,1] (Debevec & Malik 1997, eq. 4:
 * w(z) = z − Zmin for z ≤ ½(Zmin+Zmax), Zmax − z otherwise), with Zmin/Zmax pulled in to exclude
 * clipped / noise-floor values. Normalised so w(0.5) = 1.
 */
export function hatWeight(z: number, lo = 0.02, hi = 0.98): number {
  if (z <= lo || z >= hi) return 0;
  const mid = (lo + hi) / 2;
  return z <= mid ? (z - lo) / (mid - lo) : (hi - z) / (hi - mid);
}

/**
 * Merge one channel of a bracket: E = Σ w(z_i)·lin(z_i)/2^ev_i / Σ w(z_i). When every exposure is
 * clipped or black, falls back to the darkest (if bright) / brightest (if dark) exposure.
 */
export function mergeRadiance(z: number[], ev: number[]): number {
  let num = 0, den = 0;
  for (let i = 0; i < z.length; i++) {
    const w = hatWeight(z[i]);
    num += w * (srgbToLinear(z[i]) / Math.pow(2, ev[i]));
    den += w;
  }
  if (den > 1e-6) return num / den;
  // all clipped or all black
  const bright = z.reduce((a, b) => a + b, 0) / z.length > 0.5;
  let k = 0;
  for (let i = 1; i < z.length; i++) if (bright ? ev[i] < ev[k] : ev[i] > ev[k]) k = i;
  return srgbToLinear(z[k]) / Math.pow(2, ev[k]);
}

// ---------------------------------------------------------------------------
// FFT + phase correlation
// ---------------------------------------------------------------------------
/** In-place iterative radix-2 complex FFT (n = power of two). inverse → unnormalised inverse. */
export function fft(re: Float64Array, im: Float64Array, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k], ai = im[i + k];
        const br = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci, bi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ar + br; im[i + k] = ai + bi;
        re[i + k + len / 2] = ar - br; im[i + k + len / 2] = ai - bi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}
function fft2(re: Float64Array, im: Float64Array, N: number, inverse = false) {
  const rr = new Float64Array(N), ii = new Float64Array(N);
  for (let y = 0; y < N; y++) {
    rr.set(re.subarray(y * N, y * N + N)); ii.set(im.subarray(y * N, y * N + N));
    fft(rr, ii, inverse);
    re.set(rr, y * N); im.set(ii, y * N);
  }
  for (let x = 0; x < N; x++) {
    for (let y = 0; y < N; y++) { rr[y] = re[y * N + x]; ii[y] = im[y * N + x]; }
    fft(rr, ii, inverse);
    for (let y = 0; y < N; y++) { re[y * N + x] = rr[y]; im[y * N + x] = ii[y]; }
  }
}

/**
 * N×N (power of two) alignment image of an RGBA float texture: Ward's median threshold bitmap
 * (Ward 2003, "Fast, robust image registration for compositing HDR images") — luma above / below the
 * frame's own median, which is invariant to exposure — as ±0.5 with an exclusion band around the
 * median (0 there), times a Hann window. `ev` is unused by the bitmap but kept for API symmetry.
 */
export function alignImage(t: RawTex, _ev: number, N = 256): { img: Float64Array; sx: number; sy: number } {
  const W = t.width, H = t.height;
  const k = Math.max(W, H) / N;
  const cw = Math.min(N, Math.floor(W / k)), ch = Math.min(N, Math.floor(H / k));
  const lum = new Float64Array(cw * ch);
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++) {
      // box-average the k×k footprint (reduces noise and aliasing)
      let s = 0, n = 0;
      const x0 = Math.floor(x * k), y0 = Math.floor(y * k), x1 = Math.min(W, Math.floor((x + 1) * k)), y1 = Math.min(H, Math.floor((y + 1) * k));
      for (let yy = y0; yy < y1; yy++)
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * W + xx) * 4;
          s += 0.2126 * t.data[i] + 0.7152 * t.data[i + 1] + 0.0722 * t.data[i + 2];
          n++;
        }
      lum[y * cw + x] = n ? s / n : 0;
    }
  const sorted = Float64Array.from(lum).sort();
  const med = sorted[sorted.length >> 1];
  const img = new Float64Array(N * N);
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++) {
      const v = lum[y * cw + x];
      const b = Math.abs(v - med) < 4 / 255 ? 0 : v > med ? 0.5 : -0.5;
      const wx = 0.5 - 0.5 * Math.cos((2 * Math.PI * x) / Math.max(1, cw - 1)), wy = 0.5 - 0.5 * Math.cos((2 * Math.PI * y) / Math.max(1, ch - 1));
      img[y * N + x] = b * wx * wy;
    }
  return { img, sx: k, sy: k };
}

/**
 * Translation (dx, dy) in N-grid pixels such that b(x) ≈ a(x − d), i.e. sample b at x + d to align it
 * with a. Normalised cross-power spectrum, peak + parabolic sub-pixel refinement. Kuglin & Hines 1975.
 */
export function phaseCorrelate(a: Float64Array, b: Float64Array, N: number): { dx: number; dy: number; peak: number } {
  const ar = a.slice(), ai = new Float64Array(N * N), br = b.slice(), bi = new Float64Array(N * N);
  fft2(ar, ai, N);
  fft2(br, bi, N);
  const r = new Float64Array(N * N), i2 = new Float64Array(N * N);
  for (let k = 0; k < N * N; k++) {
    // B · conj(A)
    const re = br[k] * ar[k] + bi[k] * ai[k], im = bi[k] * ar[k] - br[k] * ai[k];
    const m = Math.hypot(re, im) + 1e-12;
    r[k] = re / m;
    i2[k] = im / m;
  }
  fft2(r, i2, N, true);
  let best = -Infinity, bx = 0, by = 0;
  for (let k = 0; k < N * N; k++) if (r[k] > best) { best = r[k]; bx = k % N; by = (k / N) | 0; }
  const at = (x: number, y: number) => r[((y + N) % N) * N + ((x + N) % N)];
  const sub = (m: number, c: number, p: number) => { const d = m - 2 * c + p; return Math.abs(d) > 1e-12 ? (0.5 * (m - p)) / d : 0; };
  let dx = bx + sub(at(bx - 1, by), best, at(bx + 1, by));
  let dy = by + sub(at(bx, by - 1), best, at(bx, by + 1));
  if (dx > N / 2) dx -= N;
  if (dy > N / 2) dy -= N;
  return { dx, dy, peak: best / (N * N) };
}
