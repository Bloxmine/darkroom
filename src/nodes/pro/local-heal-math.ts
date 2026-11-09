/**
 * Pure helpers of the healing brush: the thin boundary ring around the painted area (the Dirichlet
 * boundary of the membrane solve) and the automatic source search.
 */
import type { NodeDef, RawTex } from '../../core/types';

export default [] as NodeDef[];

/** 1 on pixels outside the mask within `r` px of it, else 0. */
export function ringWeights(mask: Float32Array, W: number, H: number, r: number): Float32Array {
  const out = new Float32Array(W * H);
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (mask[y * W + x] > 0.004) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) return out;
  const R = Math.ceil(r);
  for (let y = Math.max(0, y0 - R); y <= Math.min(H - 1, y1 + R); y++)
    for (let x = Math.max(0, x0 - R); x <= Math.min(W - 1, x1 + R); x++) {
      if (mask[y * W + x] > 0.004) continue;
      let hit = false;
      for (let dy = -R; dy <= R && !hit; dy++)
        for (let dx = -R; dx <= R; dx++) {
          if (dx * dx + dy * dy > r * r) continue;
          const xx = x + dx, yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < W && yy < H && mask[yy * W + xx] > 0.004) { hit = true; break; }
        }
      if (hit) out[y * W + x] = 1;
    }
  return out;
}

/**
 * Best source offset (fractions of width / height) for a painted mask: candidate offsets around the
 * area are scored by how well the source's surroundings match the target's boundary ring (mean-removed
 * for heal, since the membrane fixes colour/brightness) plus how similar the source interior's texture
 * is to the ring's, with a small preference for nearby sources. Works on a ≤ 256 px copy, so the
 * choice is the same at every render scale. Null if the mask is empty.
 */
export function findHealSource(img: RawTex, mask: Float32Array, heal: boolean, maxSide = 256): [number, number] | null {
  const W = img.width, H = img.height;
  const f = Math.max(1, Math.ceil(Math.max(W, H) / maxSide));
  const w = Math.ceil(W / f), h = Math.ceil(H / f);
  const rgb = new Float32Array(w * h * 3), m = new Uint8Array(w * h), cnt = new Float32Array(w * h), mk = new Float32Array(w * h);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = ((y / f) | 0) * w + ((x / f) | 0), s = (y * W + x) * 4;
      rgb[i * 3] += img.data[s];
      rgb[i * 3 + 1] += img.data[s + 1];
      rgb[i * 3 + 2] += img.data[s + 2];
      mk[i] = Math.max(mk[i], mask[y * W + x]);
      cnt[i]++;
    }
  for (let i = 0; i < w * h; i++) {
    for (let c = 0; c < 3; c++) rgb[i * 3 + c] /= cnt[i] || 1;
    m[i] = mk[i] > 0.02 ? 1 : 0;
  }
  let bx0 = w, by0 = h, bx1 = -1, by1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (m[y * w + x]) { bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); by0 = Math.min(by0, y); by1 = Math.max(by1, y); }
  if (bx1 < 0) return null;
  const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
  const rr = Math.max(2, Math.round(0.3 * Math.max(bw, bh)));
  const ring: number[] = [], inner: number[] = [];
  for (let y = Math.max(0, by0 - rr); y <= Math.min(h - 1, by1 + rr); y++)
    for (let x = Math.max(0, bx0 - rr); x <= Math.min(w - 1, bx1 + rr); x++) {
      if (m[y * w + x]) { inner.push(x, y); continue; }
      let near = false;
      for (let dy = -rr; dy <= rr && !near; dy++)
        for (let dx = -rr; dx <= rr; dx++) {
          const xx = x + dx, yy = y + dy;
          if (dx * dx + dy * dy <= rr * rr && xx >= 0 && yy >= 0 && xx < w && yy < h && m[yy * w + xx]) { near = true; break; }
        }
      if (near) ring.push(x, y);
    }
  if (!ring.length) return null;
  const at = (x: number, y: number, c: number) => rgb[(y * w + x) * 3 + c];
  // texture (mean-removed variance) of the target ring
  const variance = (pts: number[], ox: number, oy: number) => {
    let s = 0, s2 = 0;
    const n = pts.length / 2;
    for (let k = 0; k < pts.length; k += 2) for (let c = 0; c < 3; c++) { const v = at(pts[k] + ox, pts[k + 1] + oy, c); s += v; s2 += v * v; }
    const mu = s / (n * 3);
    return s2 / (n * 3) - mu * mu;
  };
  const ringVar = variance(ring, 0, 0);
  // detail energy: mean |Laplacian| of the luma (edges, hair, frames) at a set of points
  const lum = (x: number, y: number) => 0.2126 * at(x, y, 0) + 0.7152 * at(x, y, 1) + 0.0722 * at(x, y, 2);
  const detail = (pts: number[], ox: number, oy: number) => {
    let s = 0, n = 0;
    for (let k = 0; k < pts.length; k += 2) {
      const x = pts[k] + ox, y = pts[k + 1] + oy;
      if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
      s += Math.abs(4 * lum(x, y) - lum(x - 1, y) - lum(x + 1, y) - lum(x, y - 1) - lum(x, y + 1));
      n++;
    }
    return n ? s / n : 0;
  };
  const ringDetail = detail(ring, 0, 0);
  const pad = 2 * rr;
  const score = (ox: number, oy: number): number => {
    // the source area (bbox + ring) must lie inside the image and not overlap the target area
    if (bx0 - rr + ox < 0 || by0 - rr + oy < 0 || bx1 + rr + ox >= w || by1 + rr + oy >= h) return Infinity;
    if (Math.abs(ox) < bw + pad && Math.abs(oy) < bh + pad) return Infinity;
    const mean = [0, 0, 0];
    if (heal) {
      for (let k = 0; k < ring.length; k += 2) for (let c = 0; c < 3; c++) mean[c] += at(ring[k], ring[k + 1], c) - at(ring[k] + ox, ring[k + 1] + oy, c);
      for (let c = 0; c < 3; c++) mean[c] /= ring.length / 2;
    }
    let ssd = 0;
    for (let k = 0; k < ring.length; k += 2)
      for (let c = 0; c < 3; c++) {
        const d = at(ring[k], ring[k + 1], c) - at(ring[k] + ox, ring[k + 1] + oy, c) - mean[c];
        ssd += d * d;
      }
    ssd /= (ring.length / 2) * 3;
    // the source interior should carry the same kind of texture as the surroundings: no extra edges
    const tex = Math.abs(variance(inner, ox, oy) - ringVar);
    const dd = detail(inner, ox, oy) - ringDetail;
    const dist = (ox * ox + oy * oy) / (Math.max(bw, bh) ** 2);
    return ssd + 2 * tex + dd * dd * (dd > 0 ? 0.6 : 0.05) + 3e-4 * dist;
  };
  const D = Math.max(bw, bh) * 3 + pad + 6;
  const step = Math.max(1, Math.floor(D / 24));
  let best = Infinity, bo: [number, number] = [0, 0];
  for (let oy = -D; oy <= D; oy += step)
    for (let ox = -D; ox <= D; ox += step) {
      const s = score(ox, oy);
      if (s < best) { best = s; bo = [ox, oy]; }
    }
  if (!Number.isFinite(best)) return null;
  const [cx, cy] = bo;
  for (let oy = cy - step; oy <= cy + step; oy++)
    for (let ox = cx - step; ox <= cx + step; ox++) {
      const s = score(ox, oy);
      if (s < best) { best = s; bo = [ox, oy]; }
    }
  return [(bo[0] * f) / W, (bo[1] * f) / H];
}
