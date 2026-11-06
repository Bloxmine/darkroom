/**
 * Shared helpers for the creative effect nodes (src/nodes/effects).
 * Exports an empty NodeDef[] as default so the auto-registration glob is satisfied.
 */
import type { NodeDef, Params, PassContext } from '../../core/types';
import { A_GLSL, num } from '../analog/_shared';

export default [] as NodeDef[];

export { num, blurPass } from '../analog/_shared';

/** Extra GLSL on top of the analog helpers. */
export const E_GLSL = /* glsl */ `
// Full-resolution pixel coordinate: noise/patterns defined here look identical at any render scale.
vec2 fullPx() { return pixelCoord() / u_scale; }
vec2 fullToUv(vec2 p) { return p * u_scale / u_resolution; }
// Simple OKLab (for perceptual palette matching).
vec3 rgb2oklab(vec3 c) {
  c = srgbToLinear(clamp(c, 0.0, 1.0));
  float l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
  float m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
  float s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;
  l = pow(l, 1.0 / 3.0); m = pow(m, 1.0 / 3.0); s = pow(s, 1.0 / 3.0);
  return vec3(0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
              1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
              0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s);
}
// Paper: fibrous, slightly mottled multiplier around 1 (p in full-res px).
float paperTex(vec2 p, float seed) {
  float fib = gnoise(vec2(p.x * 0.9, p.y * 0.12) + seed) * 0.5 + gnoise(vec2(p.x * 0.15, p.y * 0.8) + seed * 2.0) * 0.5;
  float mott = fbm(p / 90.0 + seed, 4) - 0.5;
  float tooth = gnoise(p * 0.7 + seed * 3.0);
  return fib * 0.35 + mott * 0.9 + tooth * 0.25;
}
`;

/** Prepend analog + effect helpers to a fragment body. */
export const FE = (body: string) => A_GLSL + E_GLSL + body;

/** Output size of a "cell grid" pass: one texel per cell of `px` full-res pixels, or `cells` across. */
export function cellGrid(c: PassContext, pxKey = 'pixelSize', cellsKey = 'cells'): [number, number] {
  const cells = num(c.params, cellsKey, 0);
  let p: number;
  if (cells > 0) p = (c.width / c.scale) / cells * c.scale;
  else p = Math.max(1, num(c.params, pxKey, 1)) * c.scale;
  p = Math.max(p, 1e-3);
  return [Math.max(1, Math.round(c.width / p)), Math.max(1, Math.round(c.height / p))];
}

export const hex = (h: string): [number, number, number] => {
  const v = parseInt(h.replace('#', ''), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
};

export function colorParam(params: Params, key: string, def: number[]): number[] {
  const v = params[key];
  return Array.isArray(v) && v.length >= 3 ? (v as number[]) : def;
}
