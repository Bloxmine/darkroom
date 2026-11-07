/**
 * Blender-style procedural textures (Noise, Voronoi, Wave, Gradient, Magic, Brick, Checker,
 * White Noise) and coordinate / vector nodes (Texture Coordinate, Mapping, Sample by
 * Coordinates, Bump, Normal Map).
 *
 * Textures are driven by a coordinate image (`vector` input, RGB = XYZ). When it is
 * unconnected they use Generated coordinates (centred, aspect-corrected, y in -1..1, y up),
 * which depend only on v_uv → previews at any render scale match the export.
 * Noise uses Blender's Perlin noise with its Jenkins hash, so patterns match Blender's for
 * the same coordinates. Each texture outputs `color` and `fac`, like Blender.
 */
import { defineNode } from '../../core/registry';
import type { NodeDef, ParamDef, Params, PassContext, PortDef } from '../../core/types';
import { C_TEXTURE, C_VECTOR, GLSL_BASE, GLSL_COORDS, GLSL_HASH, GLSL_PERLIN, fractalLib, hasDecl, hasInputs, num } from './_shared';

const FAC_COLOR_OUT: Record<string, PortDef> = { color: { type: 'image', label: 'Color' }, fac: { type: 'mask', label: 'Fac' } };

const scaleParam = (def = 5): ParamDef => ({ type: 'float', default: def, min: 0, max: 100, step: 0.1, label: 'Scale', description: 'Features per unit of the coordinates (Generated: the image height is 2 units).' });
const enumP = (options: string[], label: string, def = options[0]): ParamDef => ({ type: 'enum', default: def, options, label });
const floatP = (def: number, min: number, max: number, label: string, step = 0.01, description?: string): ParamDef => ({ type: 'float', default: def, min, max, step, label, description });

interface TexOpts {
  id: string;
  name: string;
  description: string;
  tags: string[];
  params: Record<string, ParamDef>;
  /** Extra optional inputs (e.g. colours), after `vector`. */
  inputs?: Record<string, PortDef>;
  /** GLSL defining `vec4 tex_eval(vec3 co)` → (color.rgb, fac). May depend on params. */
  body: (p: Params) => string;
}

const timeUniforms = (ctx: PassContext) => ({ u_texScale: num(ctx.params, 'scale', 5) });

/** A texture node: pass 0 evaluates (rgb, fac) packed, then cheap passes split it into `color` and `fac`. */
function textureNode(o: TexOpts): NodeDef {
  const optional = ['vector', ...Object.keys(o.inputs ?? {})];
  const has = hasInputs(optional);
  return defineNode({
    id: o.id,
    name: o.name,
    category: 'Texture',
    description: o.description + ' Coordinates come from the optional Vector input (e.g. Texture Coordinate → Mapping), else Generated.',
    tags: [...o.tags, 'procedural', 'texture', 'blender'],
    color: C_TEXTURE,
    inputs: { vector: { type: 'image', label: 'Vector', optional: true }, ...(o.inputs ?? {}) },
    outputs: FAC_COLOR_OUT,
    params: o.params,
    passes: [
      {
        uniforms: (ctx) => ({ ...has(ctx), ...timeUniforms(ctx) }),
        frag: (p) => /* glsl */ `
${hasDecl(optional)}
uniform float u_texScale;
${GLSL_BASE}
${GLSL_COORDS}
vec3 tex_coord() { return u_hasVector > 0.5 ? texture(u_vector, v_uv).xyz : bl_generatedCoord(); }
${o.body(p)}
void main(){ fragColor = tex_eval(tex_coord()); }`,
      },
      { output: 'color', frag: `void main(){ fragColor = vec4(texture(u_pass0, v_uv).rgb, 1.0); }` },
      { output: 'fac', frag: `void main(){ float f = texture(u_pass0, v_uv).a; fragColor = vec4(f, f, f, 1.0); }` },
    ],
  });
}

// ---------------------------------------------------------------------------
// Noise
// ---------------------------------------------------------------------------

const DIMS = ['1D', '2D', '3D', '4D'];
const DIM_T: Record<string, string> = { '1D': 'float', '2D': 'vec2', '3D': 'vec3', '4D': 'vec4' };
const NOISE_TYPES = ['fBM', 'Multifractal', 'Hybrid Multifractal', 'Ridged Multifractal', 'Hetero Terrain'];
/** Blender's internal enum values (SHD_NOISE_*). */
const NOISE_TYPE_ID: Record<string, number> = { Multifractal: 0, 'Ridged Multifractal': 1, 'Hybrid Multifractal': 2, fBM: 3, 'Hetero Terrain': 4 };

/** Blender's random_<T>_offset(seed) as a GLSL expression. */
function randOffset(T: string, seed: number): string {
  const s = seed.toFixed(1);
  if (T === 'float') return `(100.0 + bl_hash_f(${s}) * 100.0)`;
  const n = T === 'vec2' ? 2 : T === 'vec3' ? 3 : 4;
  return `${T}(${Array.from({ length: n }, (_, i) => `bl_rand_off(${s}, ${i}.0)`).join(', ')})`;
}
/** Coordinate of the given dimensionality from `co` (vec3) and `w`. */
function dimCoord(T: string): string {
  return T === 'float' ? 'w' : T === 'vec2' ? 'co.xy' : T === 'vec3' ? 'co' : 'vec4(co, w)';
}

const wParams: Record<string, ParamDef> = {
  w: floatP(0, -100, 100, 'W', 0.01, '4th coordinate (1D/4D).'),
  wSpeed: floatP(0, -10, 10, 'W speed (/s)', 0.01, 'Animates W with timeline time (no effect on stills).'),
};

const noiseNode = textureNode({
  id: 'texture.noise',
  name: 'Noise Texture',
  description: "Blender's Noise Texture (4.x, Musgrave merged in): Perlin noise in 1D–4D with fBM / Multifractal / Hybrid / Ridged / Hetero Terrain fractals, distortion, and W (animatable). Color = three decorrelated noise channels; Fac = the first.",
  tags: ['perlin', 'fbm', 'musgrave', 'fractal', 'clouds', 'noise', 'ridged', 'terrain'],
  params: {
    dimensions: enumP(DIMS, 'Dimensions', '3D'),
    noiseType: enumP(NOISE_TYPES, 'Type'),
    normalize: { type: 'bool', default: true, label: 'Normalize', description: 'fBM only: keep the result in 0..1.' },
    scale: scaleParam(5),
    detail: floatP(2, 0, 15, 'Detail', 0.1),
    roughness: floatP(0.5, 0, 1, 'Roughness'),
    lacunarity: floatP(2, 0, 10, 'Lacunarity'),
    offset: floatP(0, -10, 10, 'Offset', 0.01, 'Hybrid / Ridged / Hetero Terrain.'),
    gain: floatP(1, 0, 10, 'Gain', 0.01, 'Hybrid / Ridged.'),
    distortion: floatP(0, -10, 10, 'Distortion'),
    ...wParams,
  },
  body: (p) => {
    const T = DIM_T[String(p.dimensions)] ?? 'vec3';
    const d = T === 'float' ? 1 : T === 'vec2' ? 2 : T === 'vec3' ? 3 : 4;
    const type = NOISE_TYPE_ID[String(p.noiseType)] ?? 3;
    const F = (arg: string) => `bl_fractal_${T}(${arg}, u_detail, u_roughness, u_lacunarity, u_offset, u_gain, ${type}, u_normalize)`;
    const distort = Array.from({ length: d }, (_, i) => `bl_snoise(p + ${randOffset(T, i)}) * u_distortion`).join(', ');
    return /* glsl */ `
${GLSL_HASH}
${GLSL_PERLIN}
${fractalLib(T)}
vec4 tex_eval(vec3 co) {
  float w = u_w + u_wSpeed * u_time;
  ${T} p = ${dimCoord(T)} * u_texScale;
  if (u_distortion != 0.0) p += ${T}(${distort});
  float v = ${F('p')};
  return vec4(v, ${F(`p + ${randOffset(T, d)}`)}, ${F(`p + ${randOffset(T, d + 1)}`)}, v);
}`;
  },
});

// ---------------------------------------------------------------------------
// Voronoi
// ---------------------------------------------------------------------------

const VORONOI_FEATURES = ['F1', 'F2', 'Smooth F1', 'Distance to Edge', 'N-Sphere Radius'];
const VORONOI_METRICS = ['Euclidean', 'Manhattan', 'Chebychev', 'Minkowski'];

function voronoiLib(p: Params): string {
  const is3 = p.dimensions === '3D';
  const T = is3 ? 'vec3' : 'vec2';
  const feature = Math.max(0, VORONOI_FEATURES.indexOf(String(p.feature)));
  return /* glsl */ `
${GLSL_HASH}
#define T ${T}
#define DIM ${is3 ? 3 : 2}
#define FEATURE ${feature}
#define LOOP(R) for (int k = (DIM == 3 ? -R : 0); k <= (DIM == 3 ? R : 0); k++) for (int j = -R; j <= R; j++) for (int i = -R; i <= R; i++)
#define MKOFF ${is3 ? 'vec3(float(i), float(j), float(k))' : 'vec2(float(i), float(j))'}
T hashP(T c) { return ${is3 ? 'bl_hash_v3(c)' : 'bl_hash_v2(c)'}; }
vec3 hashC(T c) { return bl_hash_v3(c); }
float maxc(vec2 v) { return max(v.x, v.y); }
float maxc(vec3 v) { return max(v.x, max(v.y, v.z)); }
float vdist(T a, T b) {
  T d = abs(a - b);
  if (u_metric == 0) return length(d);
  if (u_metric == 1) return dot(d, T(1.0));
  if (u_metric == 2) return maxc(d);
  return pow(dot(pow(d, T(u_exponent)), T(1.0)), 1.0 / u_exponent);
}
struct VOut { float dist; vec3 color; T pos; };
VOut vor_f1(T coord) {
  T cellF = floor(coord), local = coord - cellF;
  float minD = BL_FLT_MAX; T tOff = T(0.0), tPos = T(0.0);
  LOOP(1) {
    T off = MKOFF; T pp = off + hashP(cellF + off) * u_randomness;
    float d = vdist(pp, local);
    if (d < minD) { tOff = off; minD = d; tPos = pp; }
  }
  return VOut(minD, hashC(cellF + tOff), tPos + cellF);
}
VOut vor_f2(T coord) {
  T cellF = floor(coord), local = coord - cellF;
  float d1 = BL_FLT_MAX, d2 = BL_FLT_MAX; T o1 = T(0.0), p1 = T(0.0), o2 = T(0.0), p2 = T(0.0);
  LOOP(1) {
    T off = MKOFF; T pp = off + hashP(cellF + off) * u_randomness;
    float d = vdist(pp, local);
    if (d < d1) { d2 = d1; o2 = o1; p2 = p1; d1 = d; o1 = off; p1 = pp; }
    else if (d < d2) { d2 = d; o2 = off; p2 = pp; }
  }
  return VOut(d2, hashC(cellF + o2), p2 + cellF);
}
VOut vor_smooth(T coord, float smoothness) {
  T cellF = floor(coord), local = coord - cellF;
  float sd = 0.0, h = -1.0; vec3 sc = vec3(0.0); T sp = T(0.0);
  LOOP(2) {
    T off = MKOFF; T pp = off + hashP(cellF + off) * u_randomness;
    float d = vdist(pp, local);
    h = h == -1.0 ? 1.0 : smoothstep(0.0, 1.0, 0.5 + 0.5 * (sd - d) / smoothness);
    float corr = smoothness * h * (1.0 - h);
    sd = mix(sd, d, h) - corr;
    corr /= 1.0 + 3.0 * smoothness;
    sc = mix(sc, hashC(cellF + off), h) - corr;
    sp = mix(sp, pp, h) - corr;
  }
  return VOut(sd, sc, cellF + sp);
}
float vor_edge(T coord) {
  T cellF = floor(coord), local = coord - cellF;
  T toClosest = T(0.0); float minD = BL_FLT_MAX;
  LOOP(1) {
    T off = MKOFF; T v = off + hashP(cellF + off) * u_randomness - local;
    float d = dot(v, v);
    if (d < minD) { minD = d; toClosest = v; }
  }
  minD = BL_FLT_MAX;
  LOOP(1) {
    T off = MKOFF; T v = off + hashP(cellF + off) * u_randomness - local;
    T perp = v - toClosest;
    if (dot(perp, perp) > 0.0001) minD = min(minD, dot((toClosest + v) / 2.0, normalize(perp)));
  }
  return minD;
}
float vor_nsphere(T coord) {
  T cellF = floor(coord), local = coord - cellF;
  T cp = T(0.0), cpo = T(0.0); float minD = BL_FLT_MAX;
  LOOP(1) {
    T off = MKOFF; T pp = off + hashP(cellF + off) * u_randomness;
    float d = distance(pp, local);
    if (d < minD) { minD = d; cp = pp; cpo = off; }
  }
  minD = BL_FLT_MAX; T cp2 = T(0.0);
  LOOP(1) {
    if (i == 0 && j == 0 && k == 0) continue;
    T off = MKOFF + cpo; T pp = off + hashP(cellF + off) * u_randomness;
    float d = distance(cp, pp);
    if (d < minD) { minD = d; cp2 = pp; }
  }
  return distance(cp2, cp) / 2.0;
}
VOut vor_octave(T coord) {
  float smoothness = clamp(u_smoothness / 2.0, 0.0, 0.5);
  if (FEATURE == 1) return vor_f2(coord);
  if (FEATURE == 2 && smoothness != 0.0) return vor_smooth(coord, smoothness);
  return vor_f1(coord);
}
/** Blender 4.x fractal Voronoi (F1 / F2 / Smooth F1); edge & n-sphere are single-octave. */
VOut voronoi(T coord) {
  if (FEATURE == 3) return VOut(vor_edge(coord), vec3(0.0), T(0.0));
  if (FEATURE == 4) return VOut(vor_nsphere(coord), vec3(0.0), T(0.0));
  float amp = 1.0, maxAmp = 0.0, sc = 1.0;
  VOut o = VOut(0.0, vec3(0.0), T(0.0));
  bool zero = u_detail == 0.0 || u_roughness == 0.0;
  for (int n = 0; n <= 15; n++) {
    if (float(n) > ceil(u_detail)) break;
    VOut oc = vor_octave(coord * sc);
    if (zero) { maxAmp = 1.0; o = oc; break; }
    if (float(n) <= u_detail) {
      maxAmp += amp; o.dist += oc.dist * amp; o.color += oc.color * amp; o.pos = mix(o.pos, oc.pos / sc, amp);
      sc *= u_lacunarity; amp *= u_roughness;
    } else {
      float rmd = u_detail - floor(u_detail);
      if (rmd != 0.0) {
        maxAmp = mix(maxAmp, maxAmp + amp, rmd);
        o.dist = mix(o.dist, o.dist + oc.dist * amp, rmd);
        o.color = mix(o.color, o.color + oc.color * amp, rmd);
        o.pos = mix(o.pos, mix(o.pos, oc.pos / sc, amp), rmd);
      }
    }
  }
  if (u_normalize) {
    float maxDist = vdist(T(0.0), T(0.5 + 0.5 * u_randomness)) * (FEATURE == 1 ? 2.0 : 1.0);
    o.dist /= maxAmp * maxDist; o.color /= maxAmp;
  }
  return o;
}
${is3 ? 'T vcoord(vec3 co, float w) { return co; }' : 'T vcoord(vec3 co, float w) { return co.xy; }'}
vec3 vpos(T p) { return ${is3 ? 'p' : 'vec3(p, 0.0)'}; }
`;
}

const voronoiHas = hasInputs(['vector']);
const voronoiFrag = (pass: 'pack' | 'position') => (p: Params) => /* glsl */ `
${hasDecl(['vector'])}
uniform float u_texScale;
${GLSL_BASE}
${GLSL_COORDS}
${voronoiLib(p)}
void main(){
  vec3 co = u_hasVector > 0.5 ? texture(u_vector, v_uv).xyz : bl_generatedCoord();
  VOut o = voronoi(vcoord(co * u_texScale, 0.0));
  ${pass === 'pack' ? 'fragColor = vec4(o.color, o.dist);' : 'fragColor = vec4(u_texScale != 0.0 ? vpos(o.pos) / u_texScale : vec3(0.0), 1.0);'}
}`;

const voronoiNode = defineNode({
  id: 'texture.voronoi',
  name: 'Voronoi Texture',
  category: 'Texture',
  description: "Blender's Voronoi Texture (Worley cells), 2D or 3D: F1, F2, Smooth F1, Distance to Edge, N-Sphere Radius; Euclidean / Manhattan / Chebychev / Minkowski metrics; randomness and fractal detail. Outputs the distance, a random colour per cell and the cell's feature-point position (in input coordinates). Coordinates come from the optional Vector input, else Generated.",
  tags: ['voronoi', 'worley', 'cells', 'cellular', 'stained glass', 'crackle', 'procedural', 'texture', 'blender'],
  color: C_TEXTURE,
  inputs: { vector: { type: 'image', label: 'Vector', optional: true } },
  outputs: { distance: { type: 'mask', label: 'Distance' }, color: { type: 'image', label: 'Color' }, position: { type: 'image', label: 'Position' } },
  params: {
    dimensions: enumP(['2D', '3D'], 'Dimensions', '3D'),
    feature: enumP(VORONOI_FEATURES, 'Feature'),
    metric: enumP(VORONOI_METRICS, 'Distance metric'),
    scale: scaleParam(5),
    detail: floatP(0, 0, 15, 'Detail', 0.1),
    roughness: floatP(0.5, 0, 1, 'Roughness'),
    lacunarity: floatP(2, 0, 10, 'Lacunarity'),
    smoothness: floatP(1, 0, 1, 'Smoothness', 0.01, 'Smooth F1 only.'),
    exponent: floatP(0.5, 0.01, 32, 'Exponent', 0.01, 'Minkowski only.'),
    randomness: floatP(1, 0, 1, 'Randomness'),
    normalize: { type: 'bool', default: false, label: 'Normalize' },
  },
  passes: [
    { uniforms: (ctx) => ({ ...voronoiHas(ctx), ...timeUniforms(ctx) }), frag: voronoiFrag('pack') },
    { output: 'position', uniforms: (ctx) => ({ ...voronoiHas(ctx), ...timeUniforms(ctx) }), frag: voronoiFrag('position') },
    { output: 'distance', frag: `void main(){ float d = texture(u_pass0, v_uv).a; fragColor = vec4(d, d, d, 1.0); }` },
    { output: 'color', frag: `void main(){ fragColor = vec4(texture(u_pass0, v_uv).rgb, 1.0); }` },
  ],
});

// ---------------------------------------------------------------------------
// Wave, Gradient, Magic, Brick, Checker, White Noise
// ---------------------------------------------------------------------------

const waveNode = textureNode({
  id: 'texture.wave',
  name: 'Wave Texture',
  description: "Blender's Wave Texture: bands or rings with sine / saw / triangle profiles, distorted by fBM noise. Phase can be animated.",
  tags: ['wave', 'bands', 'rings', 'stripes', 'wood', 'marble', 'sine'],
  params: {
    waveType: enumP(['Bands', 'Rings'], 'Type'),
    bandsDirection: enumP(['X', 'Y', 'Z', 'Diagonal'], 'Bands direction'),
    ringsDirection: enumP(['X', 'Y', 'Z', 'Spherical'], 'Rings direction', 'Spherical'),
    profile: enumP(['Sine', 'Saw', 'Triangle'], 'Profile'),
    scale: scaleParam(5),
    distortion: floatP(0, -100, 100, 'Distortion', 0.1),
    detail: floatP(2, 0, 15, 'Detail', 0.1),
    detailScale: floatP(1, -100, 100, 'Detail scale', 0.01),
    detailRoughness: floatP(0.5, 0, 1, 'Detail roughness'),
    phase: floatP(0, -100, 100, 'Phase offset', 0.01),
    phaseSpeed: floatP(0, -20, 20, 'Phase speed (/s)', 0.01, 'Animates the phase with timeline time.'),
  },
  body: () => /* glsl */ `
${GLSL_HASH}
${GLSL_PERLIN}
${fractalLib('vec3')}
vec4 tex_eval(vec3 co) {
  vec3 p = co * u_texScale;
  p = (p + 0.000001) * 0.999999;
  float n;
  if (u_waveType == 0) {
    if (u_bandsDirection == 0) n = p.x * 20.0;
    else if (u_bandsDirection == 1) n = p.y * 20.0;
    else if (u_bandsDirection == 2) n = p.z * 20.0;
    else n = (p.x + p.y + p.z) * 10.0;
  } else {
    vec3 rp = p;
    if (u_ringsDirection == 0) rp *= vec3(0.0, 1.0, 1.0);
    else if (u_ringsDirection == 1) rp *= vec3(1.0, 0.0, 1.0);
    else if (u_ringsDirection == 2) rp *= vec3(1.0, 1.0, 0.0);
    n = length(rp) * 20.0;
  }
  n += u_phase + u_phaseSpeed * u_time;
  if (u_distortion != 0.0) n += u_distortion * (bl_fbm_vec3(p * u_detailScale, clamp(u_detail, 0.0, 15.0), max(u_detailRoughness, 0.0), 2.0, true) * 2.0 - 1.0);
  float f;
  if (u_profile == 0) f = 0.5 + 0.5 * sin(n - PI * 0.5);
  else if (u_profile == 1) { n /= TAU; f = n - floor(n); }
  else { n /= TAU; f = abs(n - floor(n + 0.5)) * 2.0; }
  return vec4(vec3(f), f);
}`,
});

const GRADIENT_TYPES = ['Linear', 'Quadratic', 'Easing', 'Diagonal', 'Spherical', 'Quadratic Sphere', 'Radial'];
const gradientNode = textureNode({
  id: 'texture.gradient',
  name: 'Gradient Texture',
  description: "Blender's Gradient Texture: Linear / Quadratic / Easing (along X), Diagonal, Spherical / Quadratic Sphere (around the origin) and Radial (angle). With Generated coordinates the origin is the image centre and X runs −aspect..aspect, so Linear rises from the centre; feed Texture Coordinate UV for a 0..1 left-to-right ramp.",
  tags: ['gradient', 'ramp', 'radial', 'spherical', 'linear'],
  params: { gradientType: enumP(GRADIENT_TYPES, 'Type') },
  body: () => /* glsl */ `
vec4 tex_eval(vec3 co) {
  float f;
  int t = u_gradientType;
  if (t == 0) f = co.x;
  else if (t == 1) { float r = max(co.x, 0.0); f = r * r; }
  else if (t == 2) { float r = min(max(co.x, 0.0), 1.0); float q = r * r; f = 3.0 * q - 2.0 * q * r; }
  else if (t == 3) f = (co.x + co.y) * 0.5;
  else if (t == 6) f = atan(co.y, co.x) / TAU + 0.5;
  else { float r = max(0.999999 - length(co), 0.0); f = t == 5 ? r * r : r; }
  f = clamp(f, 0.0, 1.0);
  return vec4(vec3(f), f);
}`,
});

const magicNode = textureNode({
  id: 'texture.magic',
  name: 'Magic Texture',
  description: "Blender's Magic Texture: psychedelic interfering sine patterns; Depth 0–10 adds iterations.",
  tags: ['magic', 'psychedelic', 'trippy', 'sine', 'interference', 'pattern'],
  params: {
    depth: { type: 'int', default: 2, min: 0, max: 10, step: 1, label: 'Depth' },
    scale: scaleParam(5),
    distortion: floatP(1, -10, 10, 'Distortion'),
  },
  body: () => /* glsl */ `
vec4 tex_eval(vec3 co) {
  vec3 p = mod(co * u_texScale, TAU);
  float dist = u_distortion; int depth = u_depth;
  float x = sin((p.x + p.y + p.z) * 5.0);
  float y = cos((-p.x + p.y - p.z) * 5.0);
  float z = -cos((-p.x - p.y + p.z) * 5.0);
  if (depth > 0) {
    x *= dist; y *= dist; z *= dist;
    y = -cos(x - y + z); y *= dist;
    if (depth > 1) { x = cos(x - y - z); x *= dist;
    if (depth > 2) { z = sin(-x - y - z); z *= dist;
    if (depth > 3) { x = -cos(-x + y - z); x *= dist;
    if (depth > 4) { y = -sin(-x + y + z); y *= dist;
    if (depth > 5) { y = -cos(-x + y + z); y *= dist;
    if (depth > 6) { x = cos(x + y + z); x *= dist;
    if (depth > 7) { z = sin(x + y - z); z *= dist;
    if (depth > 8) { x = -cos(-x - y + z); x *= dist;
    if (depth > 9) { y = -sin(x - y + z); y *= dist; } } } } } } } } }
  }
  if (dist != 0.0) { dist *= 2.0; x /= dist; y /= dist; z /= dist; }
  vec3 c = vec3(0.5 - x, 0.5 - y, 0.5 - z);
  return vec4(c, (c.x + c.y + c.z) / 3.0);
}`,
});

const colorInputs = (names: [string, string][]): Record<string, PortDef> =>
  Object.fromEntries(names.map(([k, label]) => [k, { type: 'image', label, optional: true } as PortDef]));

const brickNode = textureNode({
  id: 'texture.brick',
  name: 'Brick Texture',
  description: "Blender's Brick Texture: rows of bricks with offset and squash per Nth row, mortar size/smoothness, and per-brick tint between Color 1 and Color 2 (bias). Fac = mortar mask. Colours can come from optional inputs.",
  tags: ['brick', 'wall', 'tiles', 'masonry', 'pattern'],
  inputs: colorInputs([['color1', 'Color 1'], ['color2', 'Color 2'], ['mortar', 'Mortar']]),
  params: {
    scale: scaleParam(5),
    color1Value: { type: 'color', default: [0.8, 0.8, 0.8, 1], label: 'Color 1' },
    color2Value: { type: 'color', default: [0.2, 0.2, 0.2, 1], label: 'Color 2' },
    mortarValue: { type: 'color', default: [0, 0, 0, 1], label: 'Mortar' },
    mortarSize: floatP(0.02, 0, 0.125, 'Mortar size', 0.001),
    mortarSmooth: floatP(0.1, 0, 1, 'Mortar smooth'),
    bias: floatP(0, -1, 1, 'Bias'),
    brickWidth: floatP(0.5, 0.01, 100, 'Brick width'),
    rowHeight: floatP(0.25, 0.01, 100, 'Row height'),
    offset: floatP(0.5, 0, 1, 'Offset'),
    offsetFrequency: { type: 'int', default: 2, min: 1, max: 99, step: 1, label: 'Offset frequency' },
    squash: floatP(1, 0, 99, 'Squash'),
    squashFrequency: { type: 'int', default: 2, min: 1, max: 99, step: 1, label: 'Squash frequency' },
  },
  body: () => /* glsl */ `
float bl_integer_noise(int n) {
  n = (n >> 13) ^ n;
  uint u = uint(n);
  uint nn = (u * (u * u * 60493u + 19990303u) + 1376312589u) & 0x7fffffffu;
  return 0.5 * (float(nn) / 1073741824.0);
}
vec2 brick(vec3 p) {
  float bw = u_brickWidth, rh = u_rowHeight, offs = 0.0;
  int rownum = int(floor(p.y / rh));
  if (u_offsetFrequency != 0 && u_squashFrequency != 0) {
    bw *= (abs(rownum) % u_squashFrequency != 0) ? 1.0 : u_squash;
    offs = (abs(rownum) % u_offsetFrequency != 0) ? 0.0 : bw * u_offset;
  }
  int bricknum = int(floor((p.x + offs) / bw));
  float x = (p.x + offs) - bw * float(bricknum);
  float y = p.y - rh * float(rownum);
  float tint = clamp(bl_integer_noise((rownum << 16) + (bricknum & 0xFFFF)) + u_bias, 0.0, 1.0);
  float md = min(min(x, y), min(bw - x, rh - y));
  if (md >= u_mortarSize) return vec2(tint, 0.0);
  if (u_mortarSmooth == 0.0) return vec2(tint, 1.0);
  md = 1.0 - md / u_mortarSize;
  return vec2(tint, smoothstep(0.0, u_mortarSmooth, md));
}
vec4 tex_eval(vec3 co) {
  vec2 f2 = brick(co * u_texScale);
  vec3 c1 = u_hasColor1 > 0.5 ? texture(u_color1, v_uv).rgb : u_color1Value.rgb;
  vec3 c2 = u_hasColor2 > 0.5 ? texture(u_color2, v_uv).rgb : u_color2Value.rgb;
  vec3 m = u_hasMortar > 0.5 ? texture(u_mortar, v_uv).rgb : u_mortarValue.rgb;
  if (f2.y != 1.0) c1 = (1.0 - f2.x) * c1 + f2.x * c2;
  return vec4(mix(c1, m, f2.y), f2.y);
}`,
});

const checkerNode = textureNode({
  id: 'texture.checker',
  name: 'Checker Texture',
  description: "Blender's Checker Texture: a 3D checkerboard driven by coordinates (unlike input.checker, which is a fixed pixel grid). Colours can come from optional inputs.",
  tags: ['checker', 'checkerboard', 'grid', 'pattern', 'test'],
  inputs: colorInputs([['color1', 'Color 1'], ['color2', 'Color 2']]),
  params: {
    scale: scaleParam(5),
    color1Value: { type: 'color', default: [0.8, 0.8, 0.8, 1], label: 'Color 1' },
    color2Value: { type: 'color', default: [0.2, 0.2, 0.2, 1], label: 'Color 2' },
  },
  body: () => /* glsl */ `
vec4 tex_eval(vec3 co) {
  vec3 p = (co * u_texScale + 0.000001) * 0.999999;
  ivec3 q = ivec3(abs(floor(p)));
  bool check = ((q.x % 2) == (q.y % 2)) == ((q.z % 2) != 0);
  vec3 c1 = u_hasColor1 > 0.5 ? texture(u_color1, v_uv).rgb : u_color1Value.rgb;
  vec3 c2 = u_hasColor2 > 0.5 ? texture(u_color2, v_uv).rgb : u_color2Value.rgb;
  float f = check ? 1.0 : 0.0;
  return vec4(check ? c1 : c2, f);
}`,
});

const whiteNoiseNode = textureNode({
  id: 'texture.whiteNoise',
  name: 'White Noise',
  description: "Blender's White Noise Texture: a hash of the coordinates (1D–4D), so every distinct coordinate gets an independent random value and colour. Per-pixel with raw coordinates (like Blender, it then depends on resolution); feed snapped coordinates (Math Snap / Floor, Vector Math Snap) for scale-independent blocks.",
  tags: ['random', 'hash', 'white noise', 'static'],
  params: { dimensions: enumP(DIMS, 'Dimensions', '3D'), ...wParams },
  body: (p) => {
    const T = DIM_T[String(p.dimensions)] ?? 'vec3';
    return /* glsl */ `
${GLSL_HASH}
vec4 tex_eval(vec3 co) {
  float w = u_w + u_wSpeed * u_time;
  ${T} k = ${dimCoord(T)};
  return vec4(bl_hash_v3(k), bl_hash_f(k));
}`;
  },
});

// ---------------------------------------------------------------------------
// Coordinates & vectors
// ---------------------------------------------------------------------------

const coordinatesNode = defineNode({
  id: 'texture.coordinates',
  name: 'Texture Coordinate',
  category: 'Texture',
  description: 'Coordinate images for textures and Sample by Coordinates. UV: 0..1 with origin bottom-left (Blender convention). Generated: centred, y −1..1 bottom→top, x scaled by the aspect ratio. Pixel: full-resolution pixel position / 1000 (origin bottom-left). Coordinates are plain images, so math nodes can distort them before they feed a texture.',
  tags: ['uv', 'coordinates', 'generated', 'vector', 'position', 'blender', 'texcoord'],
  color: C_VECTOR,
  inputs: {},
  outputs: { uv: { type: 'image', label: 'UV' }, generated: { type: 'image', label: 'Generated' }, pixel: { type: 'image', label: 'Pixel' } },
  params: {},
  passes: [
    { output: 'uv', frag: `${GLSL_COORDS}\nvoid main(){ fragColor = vec4(bl_uvCoord(), 1.0); }` },
    { output: 'generated', frag: `${GLSL_COORDS}\nvoid main(){ fragColor = vec4(bl_generatedCoord(), 1.0); }` },
    { output: 'pixel', frag: `${GLSL_COORDS}\nvoid main(){ fragColor = vec4(bl_pixelCoord(), 1.0); }` },
  ],
});

const xyz = (prefix: string, label: string, def: number, min: number, max: number, step: number): Record<string, ParamDef> =>
  Object.fromEntries(['X', 'Y', 'Z'].map((a) => [prefix + a, { type: 'float', default: def, min, max, step, label: `${label} ${a}` } as ParamDef]));

const mappingNode = defineNode({
  id: 'vector.mapping',
  name: 'Mapping',
  category: 'Vector',
  description: "Blender's Mapping node: transforms a coordinate image. Point: rotate(v·scale) + location; Texture: the inverse (moves the texture the intuitive way); Vector: no translation; Normal: inverse-scaled, normalised. Rotation is Euler XYZ in degrees. Unconnected Vector = Generated coordinates.",
  tags: ['transform', 'rotate', 'scale', 'translate', 'coordinates', 'uv', 'blender'],
  color: C_VECTOR,
  inputs: { vector: { type: 'image', label: 'Vector', optional: true } },
  params: {
    mappingType: enumP(['Point', 'Texture', 'Vector', 'Normal'], 'Type'),
    ...xyz('loc', 'Location', 0, -10, 10, 0.01),
    ...xyz('rot', 'Rotation (°)', 0, -360, 360, 0.5),
    ...xyz('size', 'Scale', 1, -10, 10, 0.01),
  },
  passes: [{
    uniforms: hasInputs(['vector']),
    frag: /* glsl */ `
${hasDecl(['vector'])}
${GLSL_BASE}
${GLSL_COORDS}
mat3 bl_euler(vec3 e) {
  float cx = cos(e.x), cy = cos(e.y), cz = cos(e.z), sx = sin(e.x), sy = sin(e.y), sz = sin(e.z);
  mat3 m;
  m[0][0] = cy * cz; m[0][1] = cy * sz; m[0][2] = -sy;
  m[1][0] = sy * sx * cz - cx * sz; m[1][1] = sy * sx * sz + cx * cz; m[1][2] = cy * sx;
  m[2][0] = sy * cx * cz + sx * sz; m[2][1] = sy * cx * sz - sx * cz; m[2][2] = cy * cx;
  return m;
}
void main(){
  vec4 V = u_hasVector > 0.5 ? texture(u_vector, v_uv) : vec4(bl_generatedCoord(), 1.0);
  vec3 v = V.xyz, L = vec3(u_locX, u_locY, u_locZ), S = vec3(u_sizeX, u_sizeY, u_sizeZ);
  mat3 R = bl_euler(radians(vec3(u_rotX, u_rotY, u_rotZ)));
  vec3 o;
  if (u_mappingType == 0) o = R * (v * S) + L;
  else if (u_mappingType == 1) o = bl_safe_div(transpose(R) * (v - L), S);
  else if (u_mappingType == 2) o = R * (v * S);
  else o = bl_safe_normalize(R * bl_safe_div(v, S));
  fragColor = vec4(o, V.a);
}` }],
});

const sampleNode = defineNode({
  id: 'vector.sample',
  name: 'Sample by Coordinates',
  category: 'Vector',
  description: "Samples Image at the coordinates held in the Vector image (the image-editor equivalent of Blender's Image Texture with a Vector input). Chains like Texture Coordinate → math / noise → Sample warp photos. Space says how to read the vector: UV (0..1, origin bottom-left), Generated (as Texture Coordinate), or Pixel (/1000). Unconnected Vector = identity.",
  tags: ['sample', 'lookup', 'warp', 'distort', 'uv', 'displace', 'image texture', 'remap', 'st map'],
  color: C_VECTOR,
  inputs: { image: { type: 'image', label: 'Image' }, vector: { type: 'image', label: 'Vector', optional: true } },
  params: {
    space: enumP(['UV', 'Generated', 'Pixel'], 'Coordinate space'),
    extension: enumP(['Repeat', 'Extend', 'Clip', 'Mirror'], 'Extension', 'Extend'),
    interpolation: enumP(['Linear', 'Closest'], 'Interpolation'),
  },
  passes: [{
    uniforms: hasInputs(['vector']),
    frag: /* glsl */ `
${hasDecl(['vector'])}
void main(){
  vec2 uv = v_uv;
  if (u_hasVector > 0.5) {
    vec3 c = texture(u_vector, v_uv).xyz;
    vec2 st;   // 0..1, origin bottom-left
    if (u_space == 0) st = c.xy;
    else if (u_space == 1) { float aspect = u_image_size.x / max(u_image_size.y, 1.0); st = vec2((c.x / aspect + 1.0) * 0.5, (c.y + 1.0) * 0.5); }
    else st = c.xy * 1000.0 * max(u_scale, 1e-6) / u_image_size;
    uv = vec2(st.x, 1.0 - st.y);
  }
  if (u_extension == 2 && (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0)) { fragColor = vec4(0.0); return; }
  if (u_extension == 0) uv = fract(uv);
  else if (u_extension == 3) uv = 1.0 - abs(mod(uv, 2.0) - 1.0);
  uv = clamp(uv, 0.0, 1.0);
  if (u_interpolation == 1) {
    ivec2 sz = textureSize(u_image, 0);
    fragColor = texelFetch(u_image, clamp(ivec2(floor(uv * vec2(sz))), ivec2(0), sz - 1), 0);
  } else fragColor = texture(u_image, uv);
}` }],
});

const bumpNode = defineNode({
  id: 'vector.bump',
  name: 'Bump',
  category: 'Vector',
  description: "Blender's Bump node for a flat image: turns a height image (luminance) into a normal (perturbed from the optional Normal input, else +Z facing the viewer). The gradient is measured in Generated units (image height = 2), so the result is resolution-independent. Output is the raw −1..1 vector or an RGB normal-map colour.",
  tags: ['normal', 'height', 'bump map', 'emboss', 'relief', 'normal map', 'blender'],
  color: C_VECTOR,
  inputs: { height: { type: 'mask', label: 'Height' }, normal: { type: 'image', label: 'Normal', optional: true } },
  outputs: { out: { type: 'image', label: 'Normal' } },
  params: {
    strength: floatP(1, 0, 1, 'Strength'),
    distance: floatP(1, 0, 10, 'Distance', 0.001),
    invert: { type: 'bool', default: false, label: 'Invert' },
    encoding: enumP(['Vector (-1..1)', 'Normal map color (0..1)'], 'Output'),
  },
  passes: [{
    uniforms: hasInputs(['normal']),
    frag: /* glsl */ `
${hasDecl(['normal'])}
${GLSL_BASE}
float H(vec2 o) { return bl_float(texture(u_height, v_uv + o / u_resolution)); }
void main(){
  float unitsPerPx = 2.0 / max(u_resolution.y, 1.0);
  float gx = (H(vec2(1.0, 0.0)) - H(vec2(-1.0, 0.0))) / (2.0 * unitsPerPx);
  float gy = (H(vec2(0.0, -1.0)) - H(vec2(0.0, 1.0))) / (2.0 * unitsPerPx);   // y up
  vec3 N = u_hasNormal > 0.5 ? bl_safe_normalize(texture(u_normal, v_uv).xyz) : vec3(0.0, 0.0, 1.0);
  float d = u_invert ? -u_distance : u_distance;
  vec3 perturbed = bl_safe_normalize(N - d * vec3(gx, gy, 0.0));
  vec3 n = bl_safe_normalize(mix(N, perturbed, max(u_strength, 0.0)));
  fragColor = vec4(u_encoding == 1 ? n * 0.5 + 0.5 : n, 1.0);
}` }],
});

const normalMapNode = defineNode({
  id: 'vector.normalMap',
  name: 'Normal Map',
  category: 'Vector',
  description: "Blender's Normal Map node (tangent space, flat image): decodes a normal-map colour (0..1) to a −1..1 normal and blends it with +Z by Strength.",
  tags: ['normal', 'tangent', 'decode', 'blender'],
  color: C_VECTOR,
  inputs: { color: { type: 'image', label: 'Color' } },
  outputs: { out: { type: 'image', label: 'Normal' } },
  params: { strength: floatP(1, 0, 10, 'Strength') },
  passes: [{
    frag: /* glsl */ `
${GLSL_BASE}
void main(){
  vec3 n = texture(u_color, v_uv).rgb * 2.0 - 1.0;
  fragColor = vec4(bl_safe_normalize(mix(vec3(0.0, 0.0, 1.0), n, max(u_strength, 0.0))), 1.0);
}` }],
});

export default [
  coordinatesNode, mappingNode, sampleNode, bumpNode, normalMapNode,
  noiseNode, voronoiNode, waveNode, gradientNode, magicNode, brickNode, checkerNode, whiteNoiseNode,
] satisfies NodeDef[];
