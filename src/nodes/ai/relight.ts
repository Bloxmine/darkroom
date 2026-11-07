/**
 * Relight: up to three virtual lights (point / spot / directional) on a photo, shaded with surface
 * normals (from ai.normals, or derived edge-aware from a depth map), with soft area-light shadows
 * ray-marched through the depth field, contact shadows, depth-based ambient occlusion, a hemisphere
 * ambient, Blinn-Phong specular and wrap (subsurface) diffuse. "Replace lighting" first divides out an
 * estimate of the existing shading (a normals-based fit plus a low-frequency luminance term).
 *
 * Pure GPU (no inference): `heavy: false`, so dragging a light re-renders in real time at the viewer's
 * resolution while the upstream ai.normals / ai.depth stay cached. Old projects keep working: every
 * pre-existing param keeps its key and meaning, new params default to the old behaviour where they can.
 */
import { defineNode } from '../../core/registry';
import type { NodeDef, ParamDef, Params, PassContext, UniformValue } from '../../core/types';
import { AI_COLOR } from './_shared';
import { LIGHT_TYPES, RELIGHT_MATH_GLSL } from './relight-math';

const MODES = ['Add light', 'Multiply shade', 'Full relight', 'Replace lighting'];
const VIEWS = ['Result', 'Light only', 'Normals', 'Shadows', 'Albedo (delit)', 'Old shading'];

const light = (n: '' | '2' | '3', pos: number[], height: number, color: number[], intensity: number, on?: boolean): Record<string, ParamDef> => {
  const t = n ? ` ${n}` : ' 1';
  return {
    ...(n ? { ['on' + n]: { type: 'bool', default: !!on, label: `Light${t}` } as ParamDef } : {}),
    ['type' + n]: { type: 'enum', default: 'Point', options: LIGHT_TYPES, label: `Type${t}`, description: 'Point: a lamp at the handle. Spot: a lamp at the handle aiming straight into the scene (a pool of light). Directional: sun-like; the handle\'s offset from the image centre sets where it comes from.' },
    ['light' + n]: { type: 'vec2', default: pos, min: -0.5, max: 1.5, step: 0.001, label: `Position${t}`, description: 'On the image, 0..1 from the top-left. Drag it in the viewer.' },
    ['height' + n]: { type: 'float', default: height, min: -1, max: 2, step: 0.01, label: `Height${t}`, description: 'In front of the nearest surface, in image heights. Negative = behind the subject (rim / back light). Directional: elevation.' },
    ['color' + n]: { type: 'color', default: color, label: `Colour${t}` },
    ['intensity' + n]: { type: 'float', default: intensity, min: 0, max: 8, step: 0.01, label: `Intensity${t}` },
    ['size' + n]: { type: 'float', default: 0.15, min: 0, max: 1, step: 0.005, label: `Size${t}`, description: 'Radius of the light in image heights: bigger = softer shadows (penumbra).' },
  };
};

const PARAMS: Record<string, ParamDef> = {
  mode: {
    type: 'enum',
    default: 'Replace lighting',
    options: MODES,
    label: 'Blend',
    description:
      'Add light: brightens what faces the lights. Multiply shade: only darkens what they miss. Full relight: the photo × (ambient + lights). Replace lighting: divides out an estimate of the existing light first, then applies the new one.',
  },
  ...light('', [0.3, 0.25], 0.35, [1, 0.9, 0.75, 1], 1.2),
  ...light('2', [0.82, 0.4], 0.5, [0.75, 0.85, 1, 1], 0.6, false),
  ...light('3', [0.55, 0.05], -0.2, [1, 1, 1, 1], 1.2, false),
  falloff: { type: 'float', default: 1, min: 0, max: 10, step: 0.01, label: 'Falloff', description: 'Inverse-square falloff strength of point and spot lights (0 = none).' },
  spotAngle: { type: 'float', default: 35, min: 5, max: 89, step: 0.5, label: 'Spot angle', description: 'Half-angle of spot lights, degrees.' },
  spotSoftness: { type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Spot edge softness' },
  ambient: { type: 'float', default: 0.55, min: 0, max: 1.5, step: 0.01, label: 'Ambient / rest', description: 'Brightness of what the lights do not reach (1 = unchanged).' },
  skyColor: { type: 'color', default: [1, 1, 1, 1], label: 'Ambient from above', description: 'Environment colour reaching surfaces that face up.' },
  groundColor: { type: 'color', default: [1, 1, 1, 1], label: 'Ambient from below', description: 'Environment colour reaching surfaces that face down (bounce light).' },
  occlusion: { type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, label: 'Ambient occlusion', description: 'Darkens creases and corners in the ambient light (from the depth).' },
  delight: { type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, label: 'Remove old light', description: 'Replace lighting: how much of the existing directional shading (fitted to the normals) is divided out.' },
  evenOut: { type: 'float', default: 0.15, min: 0, max: 1, step: 0.01, label: 'Even out', description: 'Replace lighting: flattens broad, low-frequency brightness differences (existing shadows and light falloff) before relighting.' },
  shadows: { type: 'bool', default: true, label: 'Shadows' },
  shadowStrength: { type: 'float', default: 0.8, min: 0, max: 1, step: 0.01, label: 'Shadow strength' },
  shadowSoftness: { type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Shadow softness', description: 'Scales every light\'s size (0.5 = as set).' },
  contact: { type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Contact shadows', description: 'Short, crisp shadows where surfaces meet.' },
  thickness: { type: 'float', default: 0.15, min: 0.01, max: 1, step: 0.01, label: 'Object thickness', description: 'How deep (0..1 of the depth range) an object is assumed to be behind its visible surface. Small values stop foreground objects from casting shadows onto a distant background or the sky.' },
  edgeSlope: { type: 'float', default: 40, min: 5, max: 400, step: 1, label: 'Silhouette cut-off', description: 'Depth slopes steeper than this (depth range per image height) count as object outlines: they never cast shadows. Lower it if dark slivers hug silhouettes; raise it if steep surfaces lose their shadows.' },
  background: { type: 'float', default: 4, min: 0, max: 10, step: 0.05, label: 'Background distance', description: 'Extra distance (image heights) of the far background (depth near 0) from point and spot lights, so a lamp near the subject does not light a distant background. It never receives cast shadows either. 0 = plain depth.' },
  keepBackground: { type: 'float', default: 0, min: 0, max: 1, step: 0.01, label: 'Keep far background', description: 'How much the far background (depth near 0: sky, distant scenery) keeps its original look instead of being relit. The sky is a light source, not a lit surface.' },
  depthScale: { type: 'float', default: 0.3, min: 0, max: 2, step: 0.01, label: 'Depth range', description: 'Scene depth (near − far) in image heights; for falloff and shadows.' },
  strength: { type: 'float', default: 2.5, min: 0, max: 30, step: 0.1, label: 'Depth normal strength', description: 'Without a normals input: how strongly depth slopes turn surfaces.' },
  radius: { type: 'float', default: 6, min: 1, max: 30, step: 0.5, pixels: true, label: 'Depth normal smoothing', description: 'Without a normals input: gradient distance, px (also used at 2× and 4×).' },
  shape: { type: 'float', default: 1, min: 0, max: 3, step: 0.01, label: 'Surface relief', description: '< 1 flattens the normals, > 1 exaggerates them.' },
  specular: { type: 'float', default: 0.15, min: 0, max: 2, step: 0.01, label: 'Specular' },
  roughness: { type: 'float', default: 0.45, min: 0.05, max: 1, step: 0.01, label: 'Roughness', description: 'Specular highlight spread (Blinn-Phong).' },
  wrap: { type: 'float', default: 0.2, min: 0, max: 1, step: 0.01, label: 'Wrap (subsurface)', description: 'Light wraps past the terminator, like skin.' },
  subsurface: { type: 'color', default: [1, 0.55, 0.45, 1], label: 'Subsurface tint', description: 'Colour of the wrapped light (white = no tint).' },
  exposure: { type: 'float', default: 0, min: -4, max: 4, step: 0.01, label: 'Exposure', description: 'EV applied to the relit result.' },
  amount: { type: 'float', default: 1, min: 0, max: 1, step: 0.01, label: 'Amount', description: 'Mix with the original photo.' },
  view: { type: 'enum', default: 'Result', options: VIEWS, label: 'View', description: 'Debug views: the light alone, the normals in use, the shadow/occlusion buffer, the delit albedo or the removed shading.' },
  showLight: { type: 'bool', default: false, label: 'Show light only', hidden: true },
};

const num = (p: Params, k: string) => {
  const v = p[k] ?? PARAMS[k].default;
  return typeof v === 'number' ? v : Number(v) || 0;
};
const arr = (p: Params, k: string) => {
  const v = p[k];
  return Array.isArray(v) ? (v as number[]) : (PARAMS[k].default as number[]);
};
const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** Per-light uniforms: u_Lp = (x, y, height, type), u_Lc = (linear colour × intensity, on), u_Lx = (size, …). */
export function lightUniforms(p: Params): Record<string, UniformValue> {
  const Lp: number[] = [], Lc: number[] = [], Lx: number[] = [];
  const soft = num(p, 'shadowSoftness') * 2;
  for (const s of ['', '2', '3']) {
    const on = s === '' ? true : !!(p['on' + s] ?? PARAMS['on' + s].default);
    const pos = arr(p, 'light' + s);
    const type = Math.max(0, LIGHT_TYPES.indexOf(String(p['type' + s] ?? 'Point')));
    const c = arr(p, 'color' + s);
    const I = num(p, 'intensity' + s);
    Lp.push(pos[0], pos[1], num(p, 'height' + s), type);
    Lc.push(lin(c[0]) * I, lin(c[1]) * I, lin(c[2]) * I, on && I > 0 ? 1 : 0);
    Lx.push(num(p, 'size' + s) * soft, 0, 0, 0);
  }
  return { u_Lp: Lp, u_Lc: Lc, u_Lx: Lx };
}

const hasInputs = (c: PassContext) => ({ u_hasNormals: c.inputSizes.normals ? 1 : 0 });
const LIGHTS_GLSL = `uniform vec4 u_Lp[3];\nuniform vec4 u_Lc[3];\nuniform vec4 u_Lx[3];\n`;
const capDims = (w: number, h: number, max: number): [number, number] => {
  const s = Math.min(1, max / Math.max(w, h));
  return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
};

const relight = defineNode({
  id: 'ai.relight',
  name: 'Relight',
  category: 'AI',
  color: AI_COLOR,
  description:
    'Relights a photo with up to three virtual lights (point, spot or directional) and soft shadows. Connect Surface Normals (AI) to “normals” and its depth (or a Depth Map) to “depth”. ' +
    'Without normals, surfaces are derived from the depth map. Select the node and drag the lights in the viewer. ' +
    '“Replace lighting” estimates and removes the existing light first; “Add light” only adds. Shadows are ray-marched through the depth (area lights → soft penumbras), plus contact shadows and ambient occlusion. Pure GPU: dragging a light is real-time.',
  tags: ['relight', 'light', 'lighting', 'lamp', 'spotlight', 'shadow', 'normals', 'depth', '3d', 'ai', 'dramatic', 'studio', 'rim light', 'golden hour', 'neon'],
  heavy: false,
  inputs: {
    image: { type: 'image', label: 'Image' },
    normals: { type: 'image', label: 'Normals (optional)', optional: true },
    depth: { type: 'mask', label: 'Depth (near = white)', fallback: 'gray', optional: true },
  },
  params: PARAMS,
  viewerTool: {
    kind: 'points',
    single: true,
    vec2Param: 'light',
    handles: [
      { param: 'light', label: '1', colorParam: 'color' },
      { param: 'light2', label: '2', colorParam: 'color2', enabledBy: 'on2' },
      { param: 'light3', label: '3', colorParam: 'color3', enabledBy: 'on3' },
    ],
    label: 'Relight',
  },
  passes: [
    // 0: geometry: rgb = shading-frame normal (y down) · 0.5 + 0.5, a = depth
    {
      uniforms: hasInputs,
      frag: /* glsl */ `
uniform bool u_hasNormals;
${RELIGHT_MATH_GLSL}
float D(vec2 uv) { return texClamp(u_depth, uv).r; }
float mabs(float a, float b) { return abs(a) < abs(b) ? a : b; }
// edge-aware slope: per axis the one-sided difference with the smaller magnitude, so a depth step
// (an object's outline) never tilts the pixels on either side of it (no rim)
vec2 slope(vec2 uv, float px) {
  vec2 e = vec2(px) / u_resolution;
  float c = D(uv);
  float gx = mabs(D(uv + vec2(e.x, 0.0)) - c, c - D(uv - vec2(e.x, 0.0)));
  float gy = mabs(D(uv + vec2(0.0, e.y)) - c, c - D(uv - vec2(0.0, e.y)));
  return vec2(gx, gy) / e.y; // Δdepth per image height (e.x in image heights == e.y)
}
void main() {
  float d = D(v_uv);
  vec3 n;
  if (u_hasNormals) n = decodeNormal(texture(u_normals, v_uv).rgb, u_shape);
  else {
    float r = max(u_radius * u_scale, 1.0);
    vec2 g = slope(v_uv, r) * 0.5 + slope(v_uv, 2.0 * r) * 0.3 + slope(v_uv, 4.0 * r) * 0.2;
    g *= u_strength * 0.02 * u_shape;
    float gl = length(g);
    g *= 1.0 / (1.0 + max(gl - 0.6, 0.0) * 1.5);
    n = normalize(vec3(-g, 1.0));
  }
  fragColor = vec4(n * 0.5 + 0.5, d);
}`,
    },
    // 1: statistics on a 40×40 grid for the existing-shading fit. Texels 0..3: rows of Σ w·b·bᵀ with
    //    b = (1, n); texel 4: Σ w·Y·b; texel 5: (Σ w·log Y, Σ w, Σ w·Y, count)
    {
      size: () => [6, 1],
      frag: /* glsl */ `
void main() {
  int k = int(floor(v_uv.x * 6.0));
  vec4 acc = vec4(0.0);
  for (int j = 0; j < 40; j++) for (int i = 0; i < 40; i++) {
    vec2 uv = (vec2(float(i), float(j)) + 0.5) / 40.0;
    vec3 n = texture(u_pass0, uv).rgb * 2.0 - 1.0;
    float Y = luma(srgbToLinear(clamp(texture(u_image, uv).rgb, 0.0, 1.0)));
    float w = smoothstep(0.003, 0.02, Y) * (1.0 - smoothstep(0.85, 0.98, Y)) * smoothstep(0.01, 0.04, texture(u_pass0, uv).a);
    vec4 b = vec4(1.0, n);
    if (k < 4) acc += w * b[k] * b;
    else if (k == 4) acc += w * Y * b;
    else acc += vec4(w * log(Y + 0.01), w, w * Y, 1.0);
  }
  fragColor = acc;
}`,
    },
    // 2: solve the ridge-regularised 4×4 system: texel 0 = (c0, cx, cy, cz) with Y ≈ c0 + c·n,
    //    texel 1 = (mean log Y, mean Y, Σw, 0)
    {
      size: () => [2, 1],
      frag: /* glsl */ `
void main() {
  vec4 s = texelFetch(u_pass1, ivec2(5, 0), 0);
  float W = max(s.y, 1e-3);
  if (v_uv.x > 0.5) { fragColor = vec4(s.x / W, s.z / W, W, 0.0); return; }
  if (s.y < 20.0) { fragColor = vec4(1.0, 0.0, 0.0, 0.0); return; } // too few samples: no fit
  float a[20];
  vec4 rhs = texelFetch(u_pass1, ivec2(4, 0), 0);
  for (int r = 0; r < 4; r++) {
    vec4 row = texelFetch(u_pass1, ivec2(r, 0), 0);
    for (int c = 0; c < 4; c++) a[r * 5 + c] = row[c] + (r == c ? (r == 0 ? 1e-4 : 0.08) * W : 0.0);
    a[r * 5 + 4] = rhs[r];
  }
  for (int c = 0; c < 4; c++) {
    float piv = a[c * 5 + c];
    if (abs(piv) < 1e-8) piv = 1e-8;
    for (int r = 0; r < 4; r++) {
      if (r == c) continue;
      float f = a[r * 5 + c] / piv;
      for (int k = 0; k < 5; k++) a[r * 5 + k] -= f * a[c * 5 + k];
    }
  }
  vec4 x;
  for (int r = 0; r < 4; r++) x[r] = a[r * 5 + 4] / (abs(a[r * 5 + r]) < 1e-8 ? 1e-8 : a[r * 5 + r]);
  fragColor = x;
}`,
    },
    // 3: low-res log luminance (long side 96)
    {
      size: (c) => capDims(c.width, c.height, 96),
      frag: /* glsl */ `
void main() {
  float acc = 0.0;
  for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) {
    vec2 uv = v_uv + ((vec2(float(i), float(j)) + 0.5) / 4.0 - 0.5) / u_resolution;
    acc += log(luma(srgbToLinear(clamp(texture(u_image, uv).rgb, 0.0, 1.0))) + 0.01);
  }
  fragColor = vec4(vec3(acc / 16.0), 1.0);
}`,
    },
    // 4: edge-aware (bilateral in log space) blur of it, three times: the low-frequency "existing light"
    {
      size: (c) => capDims(c.width, c.height, 96),
      repeat: () => 3,
      frag: /* glsl */ `
void main() {
  float c = texture(u_prev, v_uv).r;
  float acc = 0.0, ws = 0.0;
  for (int j = -3; j <= 3; j++) for (int i = -3; i <= 3; i++) {
    float v = texture(u_prev, v_uv + vec2(float(i), float(j)) / u_resolution).r;
    float w = exp(-float(i * i + j * j) / 8.0) * exp(-(v - c) * (v - c) / 0.5);
    acc += v * w; ws += w;
  }
  fragColor = vec4(vec3(acc / ws), 1.0);
}`,
    },
    // 5: occluder depth: the depth, except on the steep ramps that upsampling leaves at object outlines
    //    (a few px blending subject and background depth), which would otherwise cast a dark sliver
    //    right next to every silhouette. Those pixels never occlude.
    {
      size: (c) => capDims(c.width, c.height, 1280),
      frag: /* glsl */ `
void main() {
  float px = 1.5 / u_resolution.y;
  vec2 e = vec2(px * u_resolution.y / u_resolution.x, px);
  float d = texture(u_pass0, v_uv).a;
  float sx = abs(texture(u_pass0, v_uv + vec2(e.x, 0.0)).a - texture(u_pass0, v_uv - vec2(e.x, 0.0)).a);
  float sy = abs(texture(u_pass0, v_uv + vec2(0.0, e.y)).a - texture(u_pass0, v_uv - vec2(0.0, e.y)).a);
  float slope = max(sx, sy) / (2.0 * px); // depth range per image height
  fragColor = vec4(slope > u_edgeSlope ? -10.0 : d, slope, 0.0, 1.0);
}`,
    },
    // 6: shadows (rgb = visibility of lights 1..3) + ambient occlusion (a), long side ≤ 1280
    {
      size: (c) => capDims(c.width, c.height, 1280),
      uniforms: (c) => lightUniforms(c.params),
      frag: /* glsl */ `
${LIGHTS_GLSL}
${RELIGHT_MATH_GLSL}
float D(vec2 uv) { return texture(u_pass5, uv).r; } // occluder depth (silhouette ramps removed)
// march from P along dir·t (t from t0 to tMax, quadratic spacing: dense near the start)
float march(vec3 P, vec3 dir, float t0, float tMax, float jit, float thick, float bias, float soft, int K) {
  float aspect = u_resolution.x / u_resolution.y;
  float vis = 1.0;
  float lxy = length(dir.xy);
  for (int k = 0; k < 16; k++) {
    if (k >= K) break;
    float s = (float(k) + jit) / float(K);
    float t = mix(t0, tMax, s * s);
    vec3 Q = P + dir * t;
    vec2 uv = vec2(Q.x / aspect, Q.y);
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) break;
    if (Q.z > u_depthScale * 1.001 + 1e-4) break; // above every surface
    float h = D(uv) * u_depthScale - Q.z;
    // occluded only by a surface above the ray that is not too far above it: objects have a finite
    // thickness, so a person never shadows the sky or a far background through "solid" depth
    if (h > bias && h < thick) vis = min(vis, clamp(1.0 - (h - bias) / (soft * lxy * t + 0.004 * u_depthScale + 1e-5), 0.0, 1.0));
  }
  return vis;
}
void main() {
  vec4 geo = texture(u_pass0, v_uv);
  vec3 n = normalize(geo.rgb * 2.0 - 1.0);
  float aspect = u_resolution.x / u_resolution.y;
  float ds = max(u_depthScale, 1e-4);
  vec3 P = vec3(v_uv.x * aspect, v_uv.y, geo.a * ds);
  float px = 1.0 / u_resolution.y; // one pixel in image heights
  float j1 = hash12(pixelCoord()), j2 = hash12(pixelCoord() + 17.3), j3 = hash12(pixelCoord() * 1.7 + 3.1);
  float thick = u_thickness * ds;
  vec3 vis = vec3(1.0);
  // the far background (depth ≈ 0: sky, distant scenery) is treated as infinitely far: no cast shadows, no AO
  float farBg = smoothstep(0.01, 0.03, geo.a);
  if (farBg <= 0.0) { fragColor = vec4(1.0); return; }
  if (u_shadows) for (int i = 0; i < 3; i++) {
    if (u_Lc[i].w < 0.5) continue;
    vec4 lp = u_Lp[i];
    float dist;
    vec3 l = lightDir(lp, P, aspect, ds, dist);
    if (dot(n, l) < -0.2) { vis[i] = 0.0; continue; } // faces away: the diffuse term is 0 anyway
    float size = u_Lx[i].x;
    // area light: 4 jittered rays to points on a disc of radius "size" (soft penumbra)
    float acc = 0.0;
    for (int r = 0; r < 4; r++) {
      float a = TAU * (float(r) + j1) / 4.0;
      vec2 off = vec2(cos(a), sin(a)) * size * sqrt((float(r) + j2) / 4.0);
      vec3 dir;
      float tMax;
      if (lp.w > 1.5) {
        vec3 ld = normalize(l + vec3(off, 0.0));
        dir = ld / max(length(ld.xy), 1e-3) * 0.5; // reach 0.5 image heights
        tMax = 1.0;
      } else {
        dir = vec3(lp.x * aspect, lp.y, lp.z + ds) + vec3(off, 0.0) - P;
        tMax = min(1.0, 0.6 / max(length(dir.xy), 1e-4));
      }
      float t0 = min(0.5 * tMax, 2.5 * px / max(length(dir.xy), 1e-4));
      acc += march(P, dir, t0, tMax, j3, thick, 0.01 * ds, 0.04, 12);
    }
    float v = acc / 4.0;
    // contact shadow: short, crisp march along the central ray
    if (u_contact > 0.0) {
      vec3 dir = l / max(length(l.xy), 1e-3);
      float reach = 0.03; // image heights
      float c = march(P, dir * reach, 1.5 * px / reach, 1.0, j3, min(thick, 0.06 * ds), 0.003 * ds, 0.01, 8);
      v = min(v, mix(1.0, c, u_contact));
    }
    vis[i] = v;
  }
  // ambient occlusion: how much nearby depth rises above this point (8 rotated taps at 2 radii)
  float occ = 0.0;
  if (u_occlusion > 0.0) {
    for (int k = 0; k < 8; k++) {
      float a = TAU * (float(k) + j1) / 8.0;
      float rr = (k < 4 ? 0.012 : 0.035) * (0.6 + 0.8 * j2);
      vec2 q = v_uv + vec2(cos(a) / aspect, sin(a)) * rr;
      float h = (D(q) - geo.a) * ds;
      if (h > 0.002 * ds && h < thick) occ += clamp(h / rr, 0.0, 1.0) * (1.0 - smoothstep(0.5 * thick, thick, h));
    }
    occ = clamp(occ / 8.0 * 1.6, 0.0, 1.0);
  }
  fragColor = mix(vec4(1.0), vec4(vis, 1.0 - occ), farBg);
}`,
    },
    // 7: depth-aware 5×5 blur of the shadow buffer (removes the jitter noise, keeps contact edges)
    {
      size: (c) => capDims(c.width, c.height, 1280),
      frag: /* glsl */ `
void main() {
  float d0 = texture(u_pass0, v_uv).a;
  vec4 acc = vec4(0.0);
  float ws = 0.0;
  for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
    vec2 q = v_uv + vec2(float(i), float(j)) / u_resolution;
    float dq = texture(u_pass0, q).a;
    float dd = (dq - d0) * 30.0;
    float w = exp(-float(i * i + j * j) / 4.5) * exp(-dd * dd);
    acc += texture(u_pass6, q) * w; ws += w;
  }
  fragColor = acc / ws;
}`,
    },
    // 8: shading
    {
      uniforms: (c) => lightUniforms(c.params),
      frag: /* glsl */ `
${LIGHTS_GLSL}
${RELIGHT_MATH_GLSL}
void main() {
  vec4 src = texture(u_image, v_uv);
  vec3 base = srgbToLinear(max(src.rgb, 0.0));
  vec4 geo = texture(u_pass0, v_uv);
  vec3 n = normalize(geo.rgb * 2.0 - 1.0);
  float aspect = u_resolution.x / u_resolution.y;
  float ds = max(u_depthScale, 1e-4);
  vec3 P = vec3(v_uv.x * aspect, v_uv.y, geo.a * ds);
  vec4 sb = texture(u_pass7, v_uv);
  vec3 vis = mix(vec3(1.0), sb.rgb, u_shadowStrength);
  float ao = mix(1.0, sb.a, u_occlusion);

  // environment: hemisphere ambient (sky colour from above, ground bounce from below)
  vec3 env = u_ambient * mix(srgbToLinear(u_groundColor.rgb), srgbToLinear(u_skyColor.rgb), clamp(-n.y * 0.5 + 0.5, 0.0, 1.0)) * ao;
  vec3 lit = vec3(0.0), spec = vec3(0.0), shade = vec3(0.0);
  float e = blinnExponent(u_roughness);
  vec3 sss = srgbToLinear(u_subsurface.rgb);
  for (int i = 0; i < 3; i++) {
    if (u_Lc[i].w < 0.5) continue;
    vec4 lp = u_Lp[i];
    float dist;
    vec3 l = lightDir(lp, P, aspect, ds, dist);
    float ndl = dot(n, l);
    float plain = max(ndl, 0.0);
    float wrapped = wrapDiffuse(ndl, u_wrap);
    vec3 diff = vec3(plain) + (wrapped - plain) * sss; // the wrapped part is tinted (subsurface)
    float att = 1.0;
    if (lp.w < 1.5) {
      // distance for the falloff: the far background is pushed back by "background distance"
      float far = 1.0 - smoothstep(0.0, 0.2, geo.a);
      vec3 Pa = vec3(P.xy, P.z - u_background * far * far);
      float da = length(vec3(lp.x * aspect, lp.y, lp.z + ds) - Pa);
      att = 1.0 / (1.0 + u_falloff * da * da * 4.0);
    }
    if (lp.w > 0.5 && lp.w < 1.5) att *= spotCone(l.z, u_spotAngle, u_spotSoftness); // spot aims straight into the scene
    float v = vis[i];
    vec3 c = u_Lc[i].rgb * att;
    lit += c * diff * v;
    float cm = max(max(u_Lc[i].r, u_Lc[i].g), max(u_Lc[i].b, 1e-4));
    shade += u_Lc[i].rgb / cm * plain * att * v;
    vec3 h = normalize(l + vec3(0.0, 0.0, 1.0));
    spec += c * pow(max(dot(n, h), 0.0), e) * plain * v;
  }
  spec *= u_specular;

  // existing shading estimate (Replace lighting): a linear fit of luminance against the normals
  // (the dominant old light direction) and the low-frequency, edge-aware luminance
  float oldS = 1.0;
  if (u_mode == 3 || u_view >= 4) {
    vec4 cf = texelFetch(u_pass2, ivec2(0, 0), 0);
    vec4 st = texelFetch(u_pass2, ivec2(1, 0), 0);
    float sFit = clamp((cf.x + dot(cf.yzw, n)) / max(cf.x + cf.w, 1e-3), 0.4, 2.5);
    float sLf = clamp(exp(texture(u_pass4, v_uv).r - st.x), 0.5, 2.0);
    oldS = pow(sFit, u_delight) * pow(sLf, u_evenOut);
    // near-black areas carry no usable shading information (dividing them only amplifies noise and
    // dark albedo, e.g. a forest in shade): fade the delighting out there
    oldS = mix(1.0, oldS, smoothstep(0.004, 0.06, luma(base)));
  }
  vec3 albedo = min(base / oldS, vec3(1.5));

  vec3 col;
  if (u_mode == 0) col = base * env + base * lit + spec * 0.5;
  else if (u_mode == 1) col = base * mix(env, vec3(1.0), clamp(shade, 0.0, 1.0));
  else if (u_mode == 2) col = base * (env + lit) + spec;
  else col = albedo * (env + lit) + spec;
  col *= exp2(u_exposure);
  col = mix(col, base, (1.0 - smoothstep(0.01, 0.05, geo.a)) * u_keepBackground);
  col = mix(base, col, u_amount);

  int view = u_showLight ? 1 : u_view;
  if (view == 1) col = env + lit + spec;
  else if (view == 2) { fragColor = vec4(vec3(n.x, -n.y, n.z) * 0.5 + 0.5, 1.0); return; }
  else if (view == 3) { fragColor = vec4(vis * ao, 1.0); return; }
  else if (view == 4) col = albedo;
  else if (view == 5) { fragColor = vec4(linearToSrgb(vec3(oldS * 0.5)), 1.0); return; }
  fragColor = vec4(linearToSrgb(max(col, 0.0)), src.a);
}`,
    },
  ],
});

export default [relight] satisfies NodeDef[];
