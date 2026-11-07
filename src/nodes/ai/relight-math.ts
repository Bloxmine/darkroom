/**
 * Pure maths shared by ai.normals and ai.relight (normal-map encoding, light vectors, the material
 * terms), mirrored 1:1 by the GLSL below so the unit tests cover what the shaders do, plus the light
 * rigs used by the relight presets. Exports an empty NodeDef[] for the auto-registration glob.
 *
 * Frames:
 * - Normal map (the `normals` image port): OpenGL convention, x right, y UP, z towards the viewer,
 *   encoded rgb = n · 0.5 + 0.5 (a flat wall facing the camera is (0.5, 0.5, 1), the usual lilac-blue).
 * - Shading frame (inside ai.relight): x right, y DOWN (like v_uv), z towards the viewer. A point on the
 *   image is P = (u · aspect, v, depth · depthScale), so x and y are in image heights.
 * - MoGe-2 outputs OpenCV camera space: x right, y down, z forward (away from the camera).
 */
import { maskTex } from '../../core/ai/image';
import type { NodeDef, RawTex } from '../../core/types';

export default [] as NodeDef[];

export type Vec3 = [number, number, number];

export const normalize3 = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
export const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** OpenCV camera-space normal (MoGe) → OpenGL normal-map frame. */
export const cvToGl = (n: Vec3): Vec3 => [n[0], -n[1], -n[2]];

/** Normal (OpenGL frame) → rgb in 0..1. */
export const encodeNormal = (n: Vec3): Vec3 => {
  const u = normalize3(n);
  return [u[0] * 0.5 + 0.5, u[1] * 0.5 + 0.5, u[2] * 0.5 + 0.5];
};

/**
 * Normal-map rgb → unit normal in the SHADING frame (y down). `gain` exaggerates (> 1) or flattens
 * (< 1) the surface by scaling the tangential part. Back-facing values are folded to face the viewer.
 */
export function decodeNormal(rgb: Vec3, gain = 1): Vec3 {
  const x = rgb[0] * 2 - 1, y = -(rgb[1] * 2 - 1), z = rgb[2] * 2 - 1;
  return normalize3([x * gain, y * gain, Math.max(z, 0.02)]);
}

export type LightType = 0 | 1 | 2; // point, spot, directional
export const LIGHT_TYPES = ['Point', 'Spot', 'Directional'];

/**
 * Direction from surface point P towards light i (unit) and the distance (Infinity for directional).
 * `pos` is the handle on the image (0..1, top-left), `height` is in image heights in front of the
 * nearest depth (negative = behind the subject: rim / back light).
 * Directional: the handle's offset from the image centre gives the azimuth, `height` the elevation.
 */
export function lightVector(type: LightType, pos: [number, number], height: number, P: Vec3, aspect: number, depthScale: number): { l: Vec3; dist: number } {
  if (type === 2) return { l: normalize3([(pos[0] - 0.5) * aspect, pos[1] - 0.5, height]), dist: Infinity };
  const L: Vec3 = [pos[0] * aspect, pos[1], height + depthScale];
  const d: Vec3 = [L[0] - P[0], L[1] - P[1], L[2] - P[2]];
  const dist = Math.hypot(d[0], d[1], d[2]);
  return { l: normalize3(d), dist };
}

/** Wrap lighting (skin / subsurface): (n·l + w) / (1 + w), clamped at 0. w = 0 is Lambert. */
export const wrapDiffuse = (ndl: number, wrap: number) => Math.max((ndl + wrap) / (1 + wrap), 0);

/** Blinn-Phong exponent for a perceptual roughness 0..1 (0.05 → mirror-like, 1 → very broad). */
export const blinnExponent = (roughness: number) => Math.min(2048, Math.max(2, 2 / Math.max(roughness, 0.05) ** 4 - 2));

/** Spot cone factor: 1 inside, smooth falloff to 0 at the cone edge. `cosAxis` = cos(angle off the spot axis). */
export function spotCone(cosAxis: number, angleDeg: number, softness: number) {
  const outer = Math.cos((angleDeg * Math.PI) / 180);
  const inner = Math.cos((angleDeg * (1 - 0.9 * Math.min(1, Math.max(0, softness))) * Math.PI) / 180);
  const t = Math.min(1, Math.max(0, (cosAxis - outer) / Math.max(inner - outer, 1e-4)));
  return t * t * (3 - 2 * t);
}

/** Solve a 4×4 linear system (Gaussian elimination, partial pivoting). Returns null if singular. */
export function solve4(M: number[][], b: number[]): number[] | null {
  const a = M.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < 4; c++) {
    let p = c;
    for (let r = c + 1; r < 4; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    if (Math.abs(a[p][c]) < 1e-9) return null;
    [a[c], a[p]] = [a[p], a[c]];
    for (let r = 0; r < 4; r++) {
      if (r === c) continue;
      const f = a[r][c] / a[c][c];
      for (let k = c; k < 5; k++) a[r][k] -= f * a[c][k];
    }
  }
  return a.map((r, i) => r[4] / r[i]);
}

/** lo/hi percentiles of `v` over the pixels where `valid` holds. */
export function robustRange(v: Float32Array, valid: (i: number) => boolean, lo = 0.01, hi = 0.99): [number, number] {
  const step = Math.max(1, Math.floor(v.length / 40000));
  const s: number[] = [];
  for (let i = 0; i < v.length; i += step) if (valid(i) && Number.isFinite(v[i])) s.push(v[i]);
  if (!s.length) return [0, 1];
  s.sort((a, b) => a - b);
  return [s[Math.floor(lo * (s.length - 1))], s[Math.ceil(hi * (s.length - 1))]];
}

export interface Geo {
  normals: RawTex;
  depth: RawTex;
}

/**
 * MoGe-2 outputs (NHWC: `points` affine point map, `normal` OpenCV camera space, `mask`) → a normal-map
 * texture (rgb = encoded OpenGL normal, a = mask) and a relative depth texture like ai.depth: disparity
 * (1 / z) spread between robust percentiles of the valid pixels, near = white, invalid (sky) = 0.
 */
export function geometryTextures(points: Float32Array, normal: Float32Array, mask: Float32Array, w: number, h: number): Geo {
  const n = w * h;
  const nt = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const e = encodeNormal(cvToGl([normal[i * 3], normal[i * 3 + 1], normal[i * 3 + 2]]));
    nt[i * 4] = e[0];
    nt[i * 4 + 1] = e[1];
    nt[i * 4 + 2] = e[2];
    nt[i * 4 + 3] = Math.min(1, Math.max(0, mask[i]));
  }
  const disp = new Float32Array(n);
  for (let i = 0; i < n; i++) disp[i] = 1 / Math.max(points[i * 3 + 2], 1e-3);
  const valid = (i: number) => mask[i] > 0.5;
  const [a, b] = robustRange(disp, valid, 0.005, 0.995);
  const d = b - a || 1;
  const dv = new Float32Array(n);
  for (let i = 0; i < n; i++) dv[i] = valid(i) ? Math.min(1, Math.max(0, (disp[i] - a) / d)) : 0;
  return { normals: { width: w, height: h, data: nt }, depth: maskTex(dv, w, h) };
}

/** GLSL twins of the functions above (shading frame), used by ai.relight. */
export const RELIGHT_MATH_GLSL = /* glsl */ `
vec3 decodeNormal(vec3 rgb, float gain) {
  vec3 n = vec3(rgb.x * 2.0 - 1.0, -(rgb.y * 2.0 - 1.0), rgb.z * 2.0 - 1.0);
  return normalize(vec3(n.xy * gain, max(n.z, 0.02)));
}
float wrapDiffuse(float ndl, float w) { return max((ndl + w) / (1.0 + w), 0.0); }
float blinnExponent(float r) { return clamp(2.0 / pow(max(r, 0.05), 4.0) - 2.0, 2.0, 2048.0); }
float spotCone(float cosAxis, float angleDeg, float softness) {
  float outer = cos(radians(angleDeg));
  float inner = cos(radians(angleDeg * (1.0 - 0.9 * clamp(softness, 0.0, 1.0))));
  return smoothstep(outer, max(inner, outer + 1e-4), cosAxis);
}
// light i: pos.xy = handle (0..1), pos.z = height, pos.w = type (0 point, 1 spot, 2 directional)
vec3 lightDir(vec4 pos, vec3 P, float aspect, float depthScale, out float dist) {
  if (pos.w > 1.5) { dist = 1e6; return normalize(vec3((pos.x - 0.5) * aspect, pos.y - 0.5, pos.z)); }
  vec3 L = vec3(pos.x * aspect, pos.y, pos.z + depthScale);
  vec3 d = L - P;
  dist = length(d);
  return d / max(dist, 1e-5);
}`;

// ---------------------------------------------------------------------------
// Light rigs (used by the relight presets in src/presets/ai-select.ts)
// ---------------------------------------------------------------------------
export interface RigLight {
  type: LightType;
  pos: [number, number];
  height: number;
  color: [number, number, number];
  intensity: number;
  size: number;
}
export interface Rig {
  name: string;
  lights: RigLight[];
  ambient: number;
  sky: [number, number, number];
  ground: [number, number, number];
  extra?: Record<string, number | string | boolean>;
}

export const RIGS: Record<string, Rig> = {
  studio: {
    name: 'Studio key + fill',
    lights: [
      { type: 1, pos: [0.25, 0.18], height: 0.65, color: [1, 0.97, 0.92], intensity: 2.1, size: 0.35 },
      { type: 0, pos: [0.85, 0.45], height: 0.7, color: [0.85, 0.9, 1], intensity: 0.7, size: 0.8 },
      { type: 0, pos: [0.7, 0.05], height: -0.25, color: [1, 1, 1], intensity: 1.6, size: 0.3 },
    ],
    ambient: 0.22,
    sky: [0.9, 0.93, 1],
    ground: [0.55, 0.5, 0.48],
  },
  rim: {
    name: 'Rim light',
    lights: [
      { type: 0, pos: [0.12, 0.15], height: -0.3, color: [0.85, 0.92, 1], intensity: 4.5, size: 0.25 },
      { type: 0, pos: [0.9, 0.2], height: -0.3, color: [1, 0.85, 0.7], intensity: 3.5, size: 0.25 },
      { type: 0, pos: [0.5, 0.4], height: 0.8, color: [1, 1, 1], intensity: 0.35, size: 1 },
    ],
    ambient: 0.12,
    sky: [0.7, 0.75, 0.9],
    ground: [0.3, 0.3, 0.35],
  },
  golden: {
    name: 'Golden hour',
    lights: [
      { type: 2, pos: [0.02, 0.38], height: 0.22, color: [1, 0.68, 0.36], intensity: 2.8, size: 0.12 },
      { type: 0, pos: [0.85, 0.3], height: 0.6, color: [0.55, 0.65, 1], intensity: 0.3, size: 1 },
      { type: 0, pos: [0.5, 0.1], height: 0.3, color: [1, 1, 1], intensity: 0, size: 0.5 },
    ],
    ambient: 0.4,
    sky: [0.62, 0.7, 1],
    ground: [0.75, 0.55, 0.38],
  },
  noon: {
    name: 'Overhead noon',
    lights: [
      { type: 2, pos: [0.52, 0.0], height: 0.9, color: [1, 0.98, 0.94], intensity: 1.5, size: 0.04 },
      { type: 0, pos: [0.5, 0.5], height: 0.5, color: [1, 1, 1], intensity: 0, size: 0.5 },
      { type: 0, pos: [0.5, 0.1], height: 0.3, color: [1, 1, 1], intensity: 0, size: 0.5 },
    ],
    ambient: 0.32,
    sky: [0.7, 0.82, 1],
    ground: [0.62, 0.58, 0.5],
  },
  neon: {
    name: 'Neon two-tone',
    lights: [
      { type: 0, pos: [0.05, 0.4], height: 0.25, color: [1, 0.15, 0.7], intensity: 3.2, size: 0.3 },
      { type: 0, pos: [0.95, 0.4], height: 0.25, color: [0.1, 0.75, 1], intensity: 3.2, size: 0.3 },
      { type: 0, pos: [0.5, 0.1], height: 0.3, color: [1, 1, 1], intensity: 0, size: 0.5 },
    ],
    ambient: 0.1,
    sky: [0.45, 0.4, 0.75],
    ground: [0.25, 0.2, 0.35],
  },
  candle: {
    name: 'Candle',
    lights: [
      { type: 0, pos: [0.42, 0.85], height: 0.25, color: [1, 0.55, 0.22], intensity: 3.4, size: 0.12 },
      { type: 0, pos: [0.5, 0.5], height: 0.5, color: [1, 1, 1], intensity: 0, size: 0.5 },
      { type: 0, pos: [0.5, 0.1], height: 0.3, color: [1, 1, 1], intensity: 0, size: 0.5 },
    ],
    ambient: 0.07,
    sky: [0.35, 0.3, 0.4],
    ground: [0.5, 0.32, 0.2],
    extra: { falloff: 2.5 },
  },
};

/** Relight params for a rig (merged over the node defaults by the presets). */
export function rigParams(rig: Rig): Record<string, number | string | boolean | number[]> {
  const p: Record<string, number | string | boolean | number[]> = { ambient: rig.ambient, skyColor: [...rig.sky, 1], groundColor: [...rig.ground, 1] };
  rig.lights.forEach((l, i) => {
    const s = i === 0 ? '' : String(i + 1);
    if (i > 0) p['on' + s] = l.intensity > 0;
    p['type' + s] = LIGHT_TYPES[l.type];
    p['light' + s] = [...l.pos];
    p['height' + s] = l.height;
    p['color' + s] = [...l.color, 1];
    p['intensity' + s] = l.intensity;
    p['size' + s] = l.size;
  });
  return { ...p, ...(rig.extra ?? {}) };
}
