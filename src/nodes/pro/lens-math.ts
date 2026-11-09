/**
 * Pure maths of the lens nodes (unit-tested): Brown–Conrady distortion, the auto-crop zoom that removes
 * empty borders, the rotate-and-crop zoom, and horizon / vertical tilt estimation.
 */
import type { NodeDef, RawTex } from '../../core/types';

export default [] as NodeDef[];

export interface Distortion { k1: number; k2: number; k3: number; p1: number; p2: number }

/**
 * Brown–Conrady (Brown 1966; Conrady 1919) in coordinates normalised to the half-diagonal (r = 1 at the
 * corners), with the correction sign convention: the OUTPUT (corrected) point p samples the source at
 * the returned point. Radial: p·(1 − k1 r² − k2 r⁴ − k3 r⁶) — positive k1 corrects barrel distortion.
 * Tangential (decentering): + (2 p1 x y + p2 (r² + 2x²), p1 (r² + 2y²) + 2 p2 x y).
 */
export function distortPoint(x: number, y: number, d: Distortion): [number, number] {
  const r2 = x * x + y * y;
  const radial = 1 - d.k1 * r2 - d.k2 * r2 * r2 - d.k3 * r2 * r2 * r2;
  return [x * radial + 2 * d.p1 * x * y + d.p2 * (r2 + 2 * x * x), y * radial + d.p1 * (r2 + 2 * y * y) + 2 * d.p2 * x * y];
}

/**
 * Zoom z (output point p samples the source at distort(p·z)) such that every output border point maps
 * inside the source: the largest z ≤ 2 for which the image fills the frame ("auto-crop": < 1 crops in,
 * > 1 reveals more when the correction pulls the edges inward). hw, hh = half width/height / half-diagonal.
 */
export function autoCropZoom(d: Distortion, hw: number, hh: number, caMax = 0): number {
  const inside = (z: number) => {
    const n = 64;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const pts: [number, number][] = [[-hw + 2 * hw * t, -hh], [-hw + 2 * hw * t, hh], [-hw, -hh + 2 * hh * t], [hw, -hh + 2 * hh * t]];
      for (const [x, y] of pts) {
        const [sx, sy] = distortPoint(x * z, y * z, d);
        const k = 1 + Math.abs(caMax);
        if (Math.abs(sx * k) > hw * 1.0005 || Math.abs(sy * k) > hh * 1.0005) return false;
      }
    }
    return true;
  };
  let lo = 0.2, hi = 2;
  if (inside(hi)) return hi;
  if (!inside(lo)) return lo;
  for (let i = 0; i < 40; i++) {
    const m = (lo + hi) / 2;
    if (inside(m)) lo = m;
    else hi = m;
  }
  return lo;
}

/** Zoom that hides the corners of a w×h image rotated by `deg` (largest same-aspect axis-aligned crop). */
export function rotateCropZoom(deg: number, w: number, h: number): number {
  const a = Math.abs((deg * Math.PI) / 180);
  return Math.cos(a) + (Math.max(w, h) / Math.min(w, h)) * Math.sin(a);
}

// ---------------------------------------------------------------------------
// Tilt estimation
// ---------------------------------------------------------------------------
export type StraightenMode = 'level' | 'vertical' | 'auto';

export interface TiltEstimate {
  /** Dominant line angle in degrees (image coords, y down: + = clockwise). Rotate by −angle to level. */
  angle: number;
  /** 0..1: share of the oriented edge energy in the peak. */
  confidence: number;
}

/** Luma of an RGBA float texture box-downsampled so the long side is ≤ `maxSide` (fixed → scale independent). */
export function downsampleLuma(t: RawTex, maxSide = 384): { lum: Float32Array; w: number; h: number } {
  const k = Math.max(1, Math.max(t.width, t.height) / maxSide);
  const w = Math.max(1, Math.round(t.width / k)), h = Math.max(1, Math.round(t.height / k));
  const lum = new Float32Array(w * h), cnt = new Float32Array(w * h);
  for (let y = 0; y < t.height; y++) {
    const oy = Math.min(h - 1, Math.floor(y / k));
    for (let x = 0; x < t.width; x++) {
      const o = oy * w + Math.min(w - 1, Math.floor(x / k)), i = (y * t.width + x) * 4;
      lum[o] += 0.2126 * t.data[i] + 0.7152 * t.data[i + 1] + 0.0722 * t.data[i + 2];
      cnt[o]++;
    }
  }
  for (let i = 0; i < w * h; i++) lum[i] /= cnt[i] || 1;
  return { lum, w, h };
}

/**
 * Structure-tensor orientation histogram (cf. Lightroom Upright "Level"): Scharr gradients, a 5×5
 * smoothed structure tensor J per pixel, line orientation θ = ½·atan2(2Jxy, Jxx − Jyy) + 90°, weighted by
 * coherence ((λ1 − λ2)/(λ1 + λ2))² × √trace. Deviations from horizontal (level), vertical (vertical) or
 * either (auto: θ folded mod 90°) within ±maxAngle go into a 0.05° histogram, gaussian-smoothed; the
 * peak is refined parabolically.
 */
export function estimateTilt(lum: Float32Array, w: number, h: number, mode: StraightenMode = 'auto', maxAngle = 10): TiltEstimate {
  const gx = new Float32Array(w * h), gy = new Float32Array(w * h);
  const L = (x: number, y: number) => lum[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      // Scharr (3, 10, 3): far less orientation bias than Sobel for oblique edges
      gx[y * w + x] = 3 * (L(x + 1, y - 1) + L(x + 1, y + 1) - L(x - 1, y - 1) - L(x - 1, y + 1)) + 10 * (L(x + 1, y) - L(x - 1, y));
      gy[y * w + x] = 3 * (L(x - 1, y + 1) + L(x + 1, y + 1) - L(x - 1, y - 1) - L(x + 1, y - 1)) + 10 * (L(x, y + 1) - L(x, y - 1));
    }
  const BIN = 0.05, nb = Math.ceil((2 * maxAngle) / BIN) + 1;
  const hist = new Float64Array(nb);
  let total = 0;
  const R = 2;
  for (let y = R + 1; y < h - R - 1; y++)
    for (let x = R + 1; x < w - R - 1; x++) {
      let jxx = 0, jyy = 0, jxy = 0;
      for (let dy = -R; dy <= R; dy++)
        for (let dx = -R; dx <= R; dx++) {
          const i = (y + dy) * w + x + dx;
          jxx += gx[i] * gx[i]; jyy += gy[i] * gy[i]; jxy += gx[i] * gy[i];
        }
      const tr = jxx + jyy;
      if (tr < 1e-6) continue;
      const disc = Math.sqrt((jxx - jyy) ** 2 + 4 * jxy * jxy);
      const coh = (disc / tr) ** 2;
      const wgt = coh * Math.sqrt(tr);
      if (wgt < 1e-4) continue;
      total += wgt;
      // gradient orientation → line orientation (deg, y down), folded to (−90, 90]
      let th = (0.5 * Math.atan2(2 * jxy, jxx - jyy) * 180) / Math.PI + 90;
      th = ((th + 90) % 180 + 180) % 180 - 90;
      let dev: number;
      if (mode === 'level') dev = th;
      else if (mode === 'vertical') dev = th > 0 ? th - 90 : th + 90;
      else dev = ((th + 45) % 90 + 90) % 90 - 45;
      if (Math.abs(dev) > maxAngle) continue;
      // a vertical line leaning right at the top (y down) has the same rotation sign as a horizontal one going down to the right
      const b = (dev + maxAngle) / BIN;
      const b0 = Math.floor(b), f = b - b0;
      if (b0 >= 0 && b0 < nb) hist[b0] += wgt * (1 - f);
      if (b0 + 1 < nb) hist[b0 + 1] += wgt * f;
    }
  // gaussian smoothing (σ = 0.4°: merges near-duplicate peaks so the estimate is stable across scales)
  const s = 0.4 / BIN, K = Math.ceil(3 * s);
  const sm = new Float64Array(nb);
  for (let i = 0; i < nb; i++) {
    let a = 0;
    for (let k = -K; k <= K; k++) if (i + k >= 0 && i + k < nb) a += hist[i + k] * Math.exp((-0.5 * k * k) / (s * s));
    sm[i] = a;
  }
  let bi = 0;
  for (let i = 1; i < nb; i++) if (sm[i] > sm[bi]) bi = i;
  let off = 0;
  if (bi > 0 && bi < nb - 1) {
    const d = sm[bi - 1] - 2 * sm[bi] + sm[bi + 1];
    if (Math.abs(d) > 1e-12) off = (0.5 * (sm[bi - 1] - sm[bi + 1])) / d;
  }
  // confidence: energy within ±0.5° of the peak over all oriented energy
  let near = 0;
  for (let i = Math.max(0, bi - Math.round(0.5 / BIN)); i <= Math.min(nb - 1, bi + Math.round(0.5 / BIN)); i++) near += hist[i];
  return { angle: -maxAngle + (bi + off) * BIN, confidence: total > 0 ? Math.min(1, (near / total) * 4) : 0 };
}
