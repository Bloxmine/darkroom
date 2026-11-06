/** Artistic / painterly effects. */
import { defineNode } from '../../core/registry';
import type { NodeDef } from '../../core/types';
import { blurPass, FE } from './_shared';

const C = '#e0b14a';
const img = { image: { type: 'image' as const } };

// ---------------------------------------------------------------------------
// Anisotropic Kuwahara (oil paint)
// ---------------------------------------------------------------------------
const kuwahara = defineNode({
  id: 'effects.kuwahara',
  name: 'Oil Paint (Kuwahara)',
  category: 'Artistic',
  color: C,
  description:
    'Anisotropic Kuwahara filter (Kyprianidis et al.) with polynomial sector weights: flattens texture into painterly patches whose brush shape follows the local ' +
    'image structure, keeping edges crisp. Optional impasto relief (directional bristle texture lit from the top-left) and canvas weave.',
  tags: ['oil paint', 'painting', 'kuwahara', 'painterly', 'brush', 'impasto', 'watercolor', 'smooth', 'artistic'],
  inputs: img,
  params: {
    radius: { type: 'float', default: 8, min: 1, max: 40, step: 0.5, pixels: true, label: 'Brush size', description: 'Filter radius in full-res px.' },
    sharpness: { type: 'float', default: 8, min: 1, max: 18, step: 0.1, label: 'Sharpness', description: 'How strongly low-variance sectors win (crisper strokes).' },
    anisotropy: { type: 'float', default: 1, min: 0, max: 4, step: 0.01, label: 'Stroke elongation', description: 'How much strokes stretch along edges.' },
    impasto: { type: 'float', default: 0.5, min: 0, max: 2, step: 0.01, label: 'Impasto relief' },
    bristles: { type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Bristle texture' },
    canvas: { type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, label: 'Canvas weave' },
    saturation: { type: 'float', default: 1.1, min: 0, max: 2, step: 0.01, label: 'Saturation' },
  },
  passes: [
    { // 0: structure tensor
      frag: FE(`
void main() {
  vec2 t = 1.0 / u_resolution;
  vec3 a = texClamp(u_image, v_uv + vec2(-t.x, -t.y)).rgb, b = texClamp(u_image, v_uv + vec2(0.0, -t.y)).rgb, c = texClamp(u_image, v_uv + vec2(t.x, -t.y)).rgb;
  vec3 d = texClamp(u_image, v_uv + vec2(-t.x, 0.0)).rgb, f = texClamp(u_image, v_uv + vec2(t.x, 0.0)).rgb;
  vec3 g = texClamp(u_image, v_uv + vec2(-t.x, t.y)).rgb, h = texClamp(u_image, v_uv + vec2(0.0, t.y)).rgb, i = texClamp(u_image, v_uv + vec2(t.x, t.y)).rgb;
  vec3 sx = (c + 2.0 * f + i - a - 2.0 * d - g) / 4.0;
  vec3 sy = (g + 2.0 * h + i - a - 2.0 * b - c) / 4.0;
  fragColor = vec4(dot(sx, sx), dot(sx, sy), dot(sy, sy), 1.0);
}`),
    },
    blurPass('x', '2.0 * max(u_scale, 0.35)'),
    blurPass('y', '2.0 * max(u_scale, 0.35)'),
    { // 3: anisotropic Kuwahara
      frag: FE(`
void main() {
  vec3 T = texture(u_pass2, v_uv).xyz;
  float E = T.x, F = T.y, G = T.z;
  float disc = sqrt(max((E - G) * (E - G) + 4.0 * F * F, 0.0));
  float l1 = 0.5 * (E + G + disc), l2 = 0.5 * (E + G - disc);
  vec2 tv = vec2(l1 - E, -F);
  vec2 dir = length(tv) > 1e-7 ? normalize(tv) : vec2(0.0, 1.0);
  float phi = -atan(dir.y, dir.x);
  float A = (l1 + l2 > 1e-7) ? (l1 - l2) / (l1 + l2) : 0.0;
  A *= u_anisotropy;
  float R = max(u_radius * u_scale, 1.0);
  float alpha = 1.0;
  float a = R * clamp((alpha + A) / alpha, 0.1, 2.0);
  float b = R * clamp(alpha / (alpha + A), 0.1, 2.0);
  float cp = cos(phi), sp = sin(phi);
  mat2 SR = mat2(0.5 / a, 0.0, 0.0, 0.5 / b) * mat2(cp, -sp, sp, cp);
  float maxX = sqrt(a * a * cp * cp + b * b * sp * sp);
  float maxY = sqrt(a * a * sp * sp + b * b * cp * cp);
  float stepPx = max(1.0, ceil(max(maxX, maxY) / 8.0));
  int nx = int(min(ceil(maxX / stepPx), 8.0)), ny = int(min(ceil(maxY / stepPx), 8.0));
  const float zeta = 0.1;
  const float zc = 0.58;
  float sinZ = sin(zc);
  float eta = (zeta + cos(zc)) / (sinZ * sinZ);
  vec4 m[8]; vec3 s[8];
  for (int k = 0; k < 8; k++) { m[k] = vec4(0.0); s[k] = vec3(0.0); }
  vec2 px = 1.0 / u_resolution;
  for (int y = -8; y <= 8; y++) {
    if (y < -ny || y > ny) continue;
    for (int x = -8; x <= 8; x++) {
      if (x < -nx || x > nx) continue;
      vec2 off = vec2(float(x), float(y)) * stepPx;
      vec2 v = SR * off;
      if (dot(v, v) > 0.25) continue;
      vec3 c = clamp(texClamp(u_image, v_uv + off * px).rgb, 0.0, 1.0);
      float w[8];
      float sum = 0.0, z, vxx, vyy;
      vxx = zeta - eta * v.x * v.x; vyy = zeta - eta * v.y * v.y;
      z = max(0.0, v.y + vxx); w[0] = z * z; sum += w[0];
      z = max(0.0, -v.x + vyy); w[2] = z * z; sum += w[2];
      z = max(0.0, -v.y + vxx); w[4] = z * z; sum += w[4];
      z = max(0.0, v.x + vyy); w[6] = z * z; sum += w[6];
      vec2 v2 = 0.70710678 * vec2(v.x - v.y, v.x + v.y);
      vxx = zeta - eta * v2.x * v2.x; vyy = zeta - eta * v2.y * v2.y;
      z = max(0.0, v2.y + vxx); w[1] = z * z; sum += w[1];
      z = max(0.0, -v2.x + vyy); w[3] = z * z; sum += w[3];
      z = max(0.0, -v2.y + vxx); w[5] = z * z; sum += w[5];
      z = max(0.0, v2.x + vyy); w[7] = z * z; sum += w[7];
      float g = exp(-3.125 * dot(v, v)) / max(sum, 1e-6);
      for (int k = 0; k < 8; k++) {
        float wk = w[k] * g;
        m[k] += vec4(c * wk, wk);
        s[k] += c * c * wk;
      }
    }
  }
  vec4 o = vec4(0.0);
  for (int k = 0; k < 8; k++) {
    if (m[k].w <= 1e-6) continue;
    vec3 mu = m[k].rgb / m[k].w;
    vec3 var = abs(s[k] / m[k].w - mu * mu);
    float sig = var.r + var.g + var.b;
    float wk = 1.0 / (1.0 + pow(8.0 * 1000.0 * sig, 0.5 * u_sharpness));
    o += vec4(mu * wk, wk);
  }
  vec3 col = o.w > 0.0 ? o.rgb / o.w : texture(u_image, v_uv).rgb;
  float L = luma(col);
  col = mix(vec3(L), col, u_saturation);
  fragColor = vec4(col, texture(u_image, v_uv).a);
}`),
    },
    { // 4: impasto + canvas
      frag: FE(`
float height(vec2 P, vec2 dir) {
  vec2 uv = fullToUv(P);
  float L = luma(texClamp(u_pass3, uv).rgb);
  vec2 q = vec2(dot(P, dir), dot(P, vec2(-dir.y, dir.x)));
  float br = gnoise(q / vec2(9.0, 0.9)) * 0.6 + gnoise(q / vec2(22.0, 2.2) + 13.0) * 0.4;
  return L * 1.4 + br * u_bristles * 0.35;
}
void main() {
  vec4 src = texture(u_pass3, v_uv);
  vec2 P = fullPx();
  vec3 T = texture(u_pass2, v_uv).xyz;
  float E = T.x, F = T.y, G = T.z;
  float disc = sqrt(max((E - G) * (E - G) + 4.0 * F * F, 0.0));
  float l1 = 0.5 * (E + G + disc);
  vec2 tv = vec2(l1 - E, -F);
  vec2 dir = length(tv) > 1e-7 ? normalize(tv) : vec2(1.0, 0.0);
  float e = 1.5;
  float hx = height(P + vec2(e, 0.0), dir) - height(P - vec2(e, 0.0), dir);
  float hy = height(P + vec2(0.0, e), dir) - height(P - vec2(0.0, e), dir);
  vec3 n = normalize(vec3(-hx, -hy, 2.0 * e / max(u_impasto, 1e-3)));
  vec3 Ld = normalize(vec3(-0.5, -0.6, 0.65));
  float lam = dot(n, Ld) - Ld.z;
  float spec = pow(max(dot(reflect(-Ld, n), vec3(0.0, 0.0, 1.0)), 0.0), 24.0) * 0.12;
  vec3 col = src.rgb * (1.0 + lam * 0.9 * min(u_impasto, 1.0)) + spec * min(u_impasto, 1.0);
  float weave = sin(P.x * 1.15) * sin(P.y * 1.15 + sin(P.x * 0.1) * 0.5);
  float slub = gnoise(vec2(P.x * 0.08, P.y * 1.1)) * 0.5 + gnoise(vec2(P.x * 1.1, P.y * 0.08)) * 0.5;
  col *= 1.0 + u_canvas * (0.05 * weave + 0.03 * slub);
  fragColor = vec4(clamp(col, 0.0, 1.0), src.a);
}`),
    },
  ],
});

// ---------------------------------------------------------------------------
// Pencil sketch
// ---------------------------------------------------------------------------
const pencilSketch = defineNode({
  id: 'effects.pencilSketch',
  name: 'Pencil Sketch',
  category: 'Artistic',
  color: C,
  description:
    'Graphite drawing: outline strokes from a colour-dodge of the image with its blurred negative, tonal cross-hatching in up to four directions ' +
    '(darker tones get more layers), broken, wobbly strokes with graphite grain on toothy paper. Optional coloured-pencil tint.',
  tags: ['pencil', 'sketch', 'drawing', 'hatching', 'graphite', 'charcoal', 'line art', 'artistic'],
  inputs: img,
  params: {
    lineWidth: { type: 'float', default: 4, min: 0.5, max: 30, step: 0.1, pixels: true, label: 'Line width', description: 'Outline blur radius in full-res px.' },
    lines: { type: 'float', default: 1, min: 0, max: 3, step: 0.01, label: 'Outline strength' },
    hatching: { type: 'float', default: 0.8, min: 0, max: 1.5, step: 0.01, label: 'Hatching' },
    spacing: { type: 'float', default: 5, min: 1.5, max: 30, step: 0.1, pixels: true, label: 'Hatch spacing', description: 'Distance between hatch strokes in full-res px.' },
    angle: { type: 'float', default: 40, min: -90, max: 90, step: 1, label: 'Hatch angle' },
    brightness: { type: 'float', default: 0.05, min: -0.5, max: 0.5, step: 0.01, label: 'Brightness' },
    color: { type: 'float', default: 0, min: 0, max: 1, step: 0.01, label: 'Coloured pencil' },
    graphite: { type: 'color', default: [0.17, 0.17, 0.19, 1], label: 'Graphite' },
    paper: { type: 'color', default: [0.96, 0.95, 0.91, 1], label: 'Paper' },
    seed: { type: 'int', default: 1, min: 0, max: 9999, step: 1, label: 'Seed' },
  },
  passes: [
    { frag: FE(`void main(){ vec3 c = texture(u_image, v_uv).rgb; fragColor = vec4(c, clamp(luma(c) + u_brightness, 0.0, 1.0)); }`) },
    blurPass('x', 'u_lineWidth * u_scale'),
    blurPass('y', 'u_lineWidth * u_scale'),
    {
      frag: FE(`
float hatch(vec2 P, float ang, float spacing, float sd, float tone, float th) {
  vec2 u = rot2(radians(ang)) * P;
  float row = floor(u.y / spacing);
  float segL = spacing * (8.0 + 10.0 * hash11(row + sd));
  float seg = floor((u.x + hash11(row * 1.7 + sd) * segL) / segL);
  float hs = hash12(vec2(row, seg) + sd);
  float wob = gnoise(vec2(u.x / 40.0, row + sd)) * spacing * 0.18;
  float yy = u.y + wob - (row + 0.5) * spacing + (hs - 0.5) * spacing * 0.25;
  float along = fract((u.x + hash11(row * 1.7 + sd) * segL) / segL);
  float gap = smoothstep(0.0, 0.06, along) * smoothstep(1.0, 0.9 - 0.15 * hs, along);
  float w = spacing * (0.16 + 0.1 * hs);
  float line = 1.0 - smoothstep(w * 0.5, w * 0.5 + max(0.7, 0.5 / u_scale), abs(yy));
  float present = smoothstep(th, th - 0.18, tone + (hs - 0.5) * 0.12);
  return line * gap * present * (0.55 + 0.45 * hs);
}
void main() {
  vec2 P = fullPx();
  float sd = float(u_seed);
  vec4 s = texture(u_pass0, v_uv);
  vec4 b = texture(u_pass2, v_uv);
  float y = s.a, by = b.a;
  // colour dodge with the blurred negative -> outlines
  float dodge = clamp(y / max(by, 1e-3), 0.0, 1.0);
  float line = clamp(1.0 - pow(dodge, 2.0 + 6.0 * u_lines), 0.0, 1.0);
  // tonal hatching from the blurred tone
  float tone = clamp(mix(y, by, 0.6), 0.0, 1.0);
  float sp = max(u_spacing, 1.5);
  float hsum = 0.0;
  hsum = max(hsum, hatch(P, u_angle, sp, sd, tone, 0.82));
  hsum = max(hsum, hatch(P, u_angle - 90.0 + 15.0, sp * 1.1, sd + 3.0, tone, 0.6));
  hsum = max(hsum, hatch(P, u_angle + 25.0, sp * 0.9, sd + 7.0, tone, 0.4));
  hsum = max(hsum, hatch(P, u_angle - 45.0, sp * 0.8, sd + 11.0, tone, 0.22));
  float shade = smoothstep(0.35, 0.0, tone) * 0.35; // soft smudged graphite in the darkest areas
  float g = max(line * 0.95, hsum * u_hatching);
  g = 1.0 - (1.0 - g) * (1.0 - shade * u_hatching);
  // graphite skips the paper tooth
  float tooth = gnoise(P * 0.8 + sd) * 0.6 + gnoise(P * 0.33 + sd * 2.0) * 0.4;
  g *= clamp(0.78 + 0.3 * tooth, 0.35, 1.0);
  vec3 paper = u_paper.rgb * (1.0 + 0.025 * paperTex(P, sd));
  vec3 lead = mix(u_graphite.rgb, b.rgb * 0.55, u_color);
  vec3 col = mix(paper, lead, clamp(g, 0.0, 1.0));
  col = mix(col, col * mix(vec3(1.0), clamp(b.rgb / max(luma(b.rgb), 0.05), 0.0, 2.0), 0.35 * (1.0 - g)), u_color);
  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`),
    },
  ],
});

// ---------------------------------------------------------------------------
// ASCII
// ---------------------------------------------------------------------------
const CHARSETS: Record<string, string> = {
  Standard: " .:-=+*#%@",
  Detailed: " .'`^\",:;Il!i><~+_-?][}{1)(|/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$",
  Blocks: ' ░▒▓█',
  Binary: ' 01',
  Dots: ' .·•●',
};

const ascii = defineNode({
  id: 'effects.ascii',
  name: 'ASCII Art',
  category: 'Artistic',
  color: C,
  description:
    'Renders the image as text: each cell picks the glyph whose ink coverage best matches the cell brightness (glyphs are measured and sorted automatically, ' +
    'so custom character sets work). Mono, per-glyph colour or colour-on-colour.',
  tags: ['ascii', 'text', 'terminal', 'characters', 'matrix', 'typewriter', 'retro', 'glyph'],
  inputs: img,
  params: {
    cellSize: { type: 'float', default: 14, min: 4, max: 80, step: 0.5, pixels: true, label: 'Character height', description: 'Cell height in full-res px (width = height × aspect).' },
    aspect: { type: 'float', default: 0.6, min: 0.3, max: 1.2, step: 0.01, label: 'Character aspect' },
    charset: { type: 'enum', default: 'Standard', options: [...Object.keys(CHARSETS), 'Custom'], label: 'Character set' },
    custom: { type: 'string', default: ' .oO@', label: 'Custom characters' },
    colorMode: { type: 'enum', default: 'Mono', options: ['Mono', 'Colour glyphs', 'Colour on colour'], label: 'Colour mode' },
    fg: { type: 'color', default: [0.85, 0.9, 0.85, 1], label: 'Text colour' },
    bg: { type: 'color', default: [0.04, 0.04, 0.05, 1], label: 'Background' },
    contrast: { type: 'float', default: 1.2, min: 0, max: 4, step: 0.01, label: 'Contrast' },
    gamma: { type: 'float', default: 1, min: 0.2, max: 3, step: 0.01, label: 'Gamma' },
    invert: { type: 'bool', default: false, label: 'Invert (dark text on light)' },
    bold: { type: 'bool', default: true, label: 'Bold' },
  },
  cpu: ({ params, scale }) => {
    let chars = params.charset === 'Custom' ? String(params.custom ?? '') : CHARSETS[String(params.charset)] ?? CHARSETS.Standard;
    chars = [...new Set([...chars])].join('') || ' #';
    // atlas cells at (about) the rendered cell size, so glyphs are not minified/aliased
    const cellH = (typeof params.cellSize === 'number' ? params.cellSize : 12) * scale;
    const asp = typeof params.aspect === 'number' ? params.aspect : 0.6;
    const ss = cellH < 24 ? 2 : 1;
    const gh = Math.max(8, Math.min(128, Math.round(cellH * ss)));
    const gw = Math.max(4, Math.round(gh * asp));
    const list = [...chars];
    const n = list.length;
    const mk = (w: number, h: number) => typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
    const cv = mk(gw * n, gh);
    const g = cv.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
    const family = '"DejaVu Sans Mono", Menlo, Consolas, monospace';
    const weight = params.bold ? 'bold ' : '';
    g.font = `${weight}100px ${family}`;
    const em = Math.max(1, g.measureText('M').width) / 100;
    const fs = Math.min((gw * 0.86) / em, gh * 0.82);
    // draw each glyph clipped to its own cell (no overhang into neighbours)
    const draw = (ctx: OffscreenCanvasRenderingContext2D, ch: string, slot: number) => {
      ctx.save();
      ctx.beginPath(); ctx.rect(slot * gw + 1, 0, gw - 2, gh); ctx.clip();
      ctx.fillStyle = '#fff';
      ctx.font = `${weight}${fs}px ${family}`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(ch, slot * gw + gw / 2, gh * 0.54);
      ctx.restore();
    };
    g.fillStyle = '#000'; g.fillRect(0, 0, gw * n, gh);
    list.forEach((ch, i) => draw(g, ch, i));
    // measure coverage of each glyph, then build a sorted atlas
    const data = g.getImageData(0, 0, gw * n, gh).data;
    const cov = list.map((_, i) => {
      let s = 0;
      for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) s += data[(y * gw * n + i * gw + x) * 4];
      return s / (gw * gh * 255);
    });
    const order = list.map((_, i) => i).sort((a, b) => cov[a] - cov[b]);
    const out = mk(gw * n, gh);
    const o = out.getContext('2d') as OffscreenCanvasRenderingContext2D;
    o.fillStyle = '#000'; o.fillRect(0, 0, gw * n, gh);
    order.forEach((src, dst) => draw(o, list[src], dst));
    const maxCov = Math.max(1e-3, ...cov);
    // per-glyph normalised coverage (sorted), so tone can be matched against it
    const covTex = new Float32Array(n * 4);
    order.forEach((src, dst) => { covTex[dst * 4] = cov[src] / maxCov; covTex[dst * 4 + 3] = 1; });
    return { atlas: out, cov: { width: n, height: 1, data: covTex, filter: 'nearest' } };
  },
  passes: [{
    frag: FE(`
void main() {
  vec2 P = fullPx();
  float ch = max(u_cellSize, 2.0);
  vec2 cell = vec2(ch * u_aspect, ch);
  vec2 id = floor(P / cell);
  vec2 local = fract(P / cell);
  // average the cell
  vec3 acc = vec3(0.0);
  for (int j = 0; j < 3; j++) for (int i = 0; i < 3; i++) acc += texClamp(u_image, fullToUv((id + (vec2(i, j) + 0.5) / 3.0) * cell)).rgb;
  vec3 c = acc / 9.0;
  float y = clamp((luma(c) - 0.5) * u_contrast + 0.5, 0.0, 1.0);
  y = pow(y, u_gamma);
  if (u_invert) y = 1.0 - y;
  // nearest glyph by coverage
  int n = int(u_cov_size.x);
  int best = 0; float bd = 1e9;
  for (int k = 0; k < 128; k++) {
    if (k >= n) break;
    float d = abs(texelFetch(u_cov, ivec2(k, 0), 0).r - y);
    if (d < bd) { bd = d; best = k; }
  }
  float hx = 0.5 / (u_atlas_size.x / float(n));
  vec2 auv = vec2((float(best) + clamp(local.x, hx, 1.0 - hx)) / float(n), local.y);
  float ink = textureLod(u_atlas, auv, 0.0).r; // explicit LOD: no seams where the glyph index jumps
  // antialias: when glyphs get tiny in preview, blend towards the coverage value
  float tiny = clamp(1.5 - ch * u_scale / 4.0, 0.0, 1.0);
  ink = mix(ink, texelFetch(u_cov, ivec2(best, 0), 0).r * 0.6, tiny);
  vec3 fg = u_fg.rgb, bg = u_bg.rgb;
  if (u_colorMode == 1) fg = c / max(max(c.r, max(c.g, c.b)), 0.15) * mix(0.6, 1.0, y);
  else if (u_colorMode == 2) { fg = clamp(c * 1.35 + 0.1, 0.0, 1.0); bg = c * 0.35; }
  if (u_invert && u_colorMode == 0) { vec3 t = fg; fg = bg; bg = t; }
  fragColor = vec4(mix(bg, fg, ink), 1.0);
}`),
  }],
});

// ---------------------------------------------------------------------------
// Pixel sort
// ---------------------------------------------------------------------------
const pixelSort = defineNode({
  id: 'effects.pixelSort',
  name: 'Pixel Sort',
  category: 'Artistic',
  color: C,
  description:
    'Glitch-art pixel sorting. Pixels whose brightness lies inside the threshold range form spans along the sort direction; each span is re-ordered by the sort key. ' +
    'GPU approximation: each pixel finds its span ends with a bounded march and picks its rank from 32 sorted samples of the span, giving the characteristic streaks.',
  tags: ['pixel sort', 'glitch', 'sort', 'streaks', 'databending', 'asendorf'],
  inputs: img,
  params: {
    angle: { type: 'float', default: 90, min: -180, max: 180, step: 1, label: 'Direction (°)', description: '0 = left→right, 90 = top→bottom.' },
    low: { type: 'float', default: 0.25, min: 0, max: 1, step: 0.01, label: 'Threshold low' },
    high: { type: 'float', default: 0.85, min: 0, max: 1, step: 0.01, label: 'Threshold high' },
    key: { type: 'enum', default: 'Brightness', options: ['Brightness', 'Hue', 'Saturation', 'Red', 'Blue'], label: 'Sort by' },
    reverse: { type: 'bool', default: false, label: 'Reverse order' },
    maxLength: { type: 'float', default: 400, min: 4, max: 2000, step: 1, pixels: true, label: 'Max span length', description: 'Longest sorted streak in full-res px.' },
    randomness: { type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, label: 'Random span breaks' },
    invertMask: { type: 'bool', default: false, label: 'Sort outside the range' },
    seed: { type: 'int', default: 1, min: 0, max: 9999, step: 1, label: 'Seed' },
  },
  passes: [{
    frag: FE(`
vec2 D, N;
float sortKey(vec3 c) {
  if (u_key == 0) return luma(c);
  if (u_key == 1) return rgb2hsv(c).x;
  if (u_key == 2) return rgb2hsv(c).y;
  if (u_key == 3) return c.r;
  return c.b;
}
bool inMask(vec2 P) {
  vec2 uv = fullToUv(P);
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return false;
  float y = luma(texture(u_image, uv).rgb);
  bool m = y >= u_low && y <= u_high;
  return u_invertMask ? !m : m;
}
float chunkOf(float along, float line) {
  float L = max(u_maxLength, 4.0) * mix(1.0, 0.25 + 0.75 * hash12(vec2(line, float(u_seed))), u_randomness);
  return floor((along + hash12(vec2(line, float(u_seed) + 3.0)) * L) / L);
}
void main() {
  vec2 P = fullPx();
  float a = radians(u_angle);
  D = vec2(cos(a), sin(a)); N = vec2(-D.y, D.x);
  vec4 src = texture(u_image, v_uv);
  if (!inMask(P)) { fragColor = src; return; }
  float along = dot(P, D), across = floor(dot(P, N));
  float chunk = chunkOf(along, across);
  float maxL = max(u_maxLength, 4.0);
  float stepPx = max(1.0, maxL / 96.0);
  // march to span start / end
  float s0 = 0.0, s1 = 0.0;
  for (int i = 1; i <= 96; i++) {
    float t = float(i) * stepPx;
    vec2 Q = P - D * t;
    if (!inMask(Q) || chunkOf(along - t, across) != chunk) break;
    s0 = t;
  }
  for (int i = 1; i <= 96; i++) {
    float t = float(i) * stepPx;
    vec2 Q = P + D * t;
    if (!inMask(Q) || chunkOf(along + t, across) != chunk) break;
    s1 = t;
  }
  float len = s0 + s1;
  if (len < 1.0) { fragColor = src; return; }
  float rank = s0 / len; // position of this pixel within its span
  if (u_reverse) rank = 1.0 - rank;
  // sample the span and select the sample with matching rank
  const int K = 32;
  vec3 cs[K]; float ks[K];
  for (int i = 0; i < K; i++) {
    float t = -s0 + (float(i) + 0.5) / float(K) * len;
    vec3 c = texture(u_image, fullToUv(P + D * t)).rgb;
    cs[i] = c; ks[i] = sortKey(c) + float(i) * 1e-5;
  }
  float target = rank * float(K - 1);
  int lo = 0; float bestD = 1e9;
  for (int i = 0; i < K; i++) {
    float r = 0.0;
    for (int j = 0; j < K; j++) r += ks[j] < ks[i] ? 1.0 : 0.0;
    float d = abs(r - target);
    if (d < bestD) { bestD = d; lo = i; }
  }
  fragColor = vec4(cs[lo], src.a);
}`),
  }],
});

// ---------------------------------------------------------------------------
// Voronoi mosaic / stained glass
// ---------------------------------------------------------------------------
const mosaic = defineNode({
  id: 'effects.mosaic',
  name: 'Mosaic / Stained Glass',
  category: 'Artistic',
  color: C,
  description:
    'Voronoi cells filled with the local colour. Stained glass: saturated glass panes with internal mottling and thick lead came. ' +
    'Tiles: square-ish tesserae with light grout and bevelled edges. Crystallize: plain flat cells.',
  tags: ['mosaic', 'stained glass', 'voronoi', 'cells', 'crystallize', 'tiles', 'church', 'tesserae'],
  inputs: img,
  params: {
    style: { type: 'enum', default: 'Stained glass', options: ['Stained glass', 'Tiles', 'Crystallize'], label: 'Style' },
    cellSize: { type: 'float', default: 36, min: 4, max: 300, step: 0.5, pixels: true, label: 'Cell size' },
    jitter: { type: 'float', default: 0.9, min: 0, max: 1, step: 0.01, label: 'Irregularity' },
    edgeWidth: { type: 'float', default: 4, min: 0, max: 40, step: 0.1, pixels: true, label: 'Lead / grout width' },
    edgeColor: { type: 'color', default: [0.06, 0.06, 0.06, 1], label: 'Lead / grout colour' },
    saturation: { type: 'float', default: 1.4, min: 0, max: 3, step: 0.01, label: 'Saturation' },
    texture: { type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Glass / tile texture' },
    bevel: { type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Bevel' },
    seed: { type: 'int', default: 1, min: 0, max: 9999, step: 1, label: 'Seed' },
  },
  passes: [{
    frag: FE(`
vec2 site(vec2 cellId) {
  vec2 h = hash22(cellId + float(u_seed) * 17.0);
  float j = u_style == 1 ? u_jitter * 0.35 : u_jitter;
  return cellId + 0.5 + (h - 0.5) * j;
}
void main() {
  vec2 P = fullPx();
  float cs = max(u_cellSize, 2.0);
  vec2 x = P / cs;
  vec2 n = floor(x);
  // pass 1: nearest site
  vec2 mg, mr; float md = 1e9;
  for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
    vec2 g = n + vec2(i, j);
    vec2 r = site(g) - x;
    float d = dot(r, r);
    if (d < md) { md = d; mr = r; mg = g; }
  }
  // pass 2: distance to the closest edge (iq)
  float ed = 1e9;
  for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
    vec2 g = n + vec2(i, j);
    if (g == mg) continue;
    vec2 r = site(g) - x;
    if (dot(mr - r, mr - r) > 1e-6) ed = min(ed, dot(0.5 * (mr + r), normalize(r - mr)));
  }
  float edgePx = ed * cs;
  // cell colour: average a few samples around the site
  vec2 sp = site(mg) * cs;
  vec3 c = vec3(0.0);
  for (int k = 0; k < 7; k++) {
    float a = float(k) * 2.39996;
    vec2 o = k == 0 ? vec2(0.0) : vec2(cos(a), sin(a)) * cs * 0.22 * sqrt(float(k) / 6.0);
    c += texClamp(u_image, fullToUv(sp + o)).rgb;
  }
  c /= 7.0;
  float L = luma(c);
  c = clamp(mix(vec3(L), c, u_saturation), 0.0, 1.0);
  float h = hash12(mg + float(u_seed));
  vec3 col = c;
  float w = u_edgeWidth;
  float aa = max(0.75, 0.75 / u_scale);
  if (u_style == 0) {
    // glass: mottled density, light transmitted brighter in the centre, darker near the lead
    float mott = fbm(P / (cs * 0.25) + h * 50.0, 4) - 0.5;
    float seeds = smoothstep(0.75, 0.95, valueNoise(P / 3.0 + h * 31.0)) * 0.15;
    col = c * (1.0 + u_texture * (mott * 0.5 - seeds)) ;
    col *= mix(1.0, 0.65 + 0.45 * smoothstep(0.0, cs * 0.45, edgePx - w * 0.5), u_bevel);
    col = mix(col, col * col * 1.4, 0.15);
  } else if (u_style == 1) {
    float rough = gnoise(P * 0.3 + h * 9.0) * 0.5 + gnoise(P * 0.07 + h * 3.0) * 0.5;
    col = c * (1.0 + u_texture * 0.08 * rough) * (0.94 + 0.12 * h);
    float bev = smoothstep(w * 0.5, w * 0.5 + cs * 0.12, edgePx);
    vec2 toSite = normalize(-mr + 1e-5);
    float lit = dot(toSite, normalize(vec2(1.0, 1.0)));
    col *= 1.0 + u_bevel * (1.0 - bev) * lit * 0.35;
  }
  float lead = 1.0 - smoothstep(w * 0.5 - aa, w * 0.5 + aa, edgePx);
  vec3 leadCol = u_edgeColor.rgb;
  if (u_style == 0) leadCol *= 1.0 + 0.6 * u_bevel * smoothstep(w * 0.5, 0.0, abs(edgePx - w * 0.15)) ; // came highlight
  if (u_style == 1) leadCol *= 1.0 + 0.05 * gnoise(P * 0.8);
  col = mix(col, leadCol, w > 0.0 ? lead : 0.0);
  fragColor = vec4(clamp(col, 0.0, 1.0), texture(u_image, v_uv).a);
}`),
  }],
});

// ---------------------------------------------------------------------------
// Emboss
// ---------------------------------------------------------------------------
const emboss = defineNode({
  id: 'effects.emboss',
  name: 'Emboss',
  category: 'Artistic',
  color: C,
  description: 'Relief / embossing from the image brightness, lit from a chosen direction. Grey relief, colour relief, or metal (lit bump with a metallic tint).',
  tags: ['emboss', 'relief', 'bump', 'stamp', 'metal', 'engrave', 'height'],
  inputs: img,
  params: {
    mode: { type: 'enum', default: 'Grey', options: ['Grey', 'Colour', 'Metal'], label: 'Mode' },
    angle: { type: 'float', default: 135, min: -180, max: 180, step: 1, label: 'Light angle' },
    height: { type: 'float', default: 3, min: 0, max: 20, step: 0.01, label: 'Height' },
    distance: { type: 'float', default: 1.5, min: 0.5, max: 20, step: 0.1, pixels: true, label: 'Distance', description: 'Sampling distance in full-res px (thicker relief).' },
    mix: { type: 'float', default: 1, min: 0, max: 1, step: 0.01, label: 'Mix' },
    tint: { type: 'color', default: [0.83, 0.69, 0.42, 1], label: 'Metal tint' },
  },
  passes: [{
    frag: FE(`
void main() {
  vec4 src = texture(u_image, v_uv);
  vec2 d = vec2(max(u_distance * u_scale, 0.5)) / u_resolution;
  float l = luma(texClamp(u_image, v_uv - vec2(d.x, 0.0)).rgb), r = luma(texClamp(u_image, v_uv + vec2(d.x, 0.0)).rgb);
  float t = luma(texClamp(u_image, v_uv - vec2(0.0, d.y)).rgb), b = luma(texClamp(u_image, v_uv + vec2(0.0, d.y)).rgb);
  vec3 n = normalize(vec3((l - r) * u_height, (t - b) * u_height, 1.0));
  float a = radians(u_angle);
  vec3 L = normalize(vec3(cos(a), -sin(a), 0.8));
  float lam = dot(n, L);
  float flat0 = L.z;
  vec3 o;
  if (u_mode == 0) o = vec3(0.5 + (lam - flat0) * 1.2);
  else if (u_mode == 1) o = src.rgb * (1.0 + (lam - flat0) * 2.0);
  else {
    float spec = pow(max(dot(reflect(-L, n), vec3(0, 0, 1)), 0.0), 16.0);
    float base = 0.35 + 0.65 * luma(src.rgb);
    o = u_tint.rgb * (0.25 + base * 0.5 + (lam - flat0) * 1.6) + spec * 0.6;
  }
  fragColor = vec4(mix(src.rgb, clamp(o, 0.0, 1.0), u_mix), src.a);
}`),
  }],
});

export default [kuwahara, pencilSketch, ascii, pixelSort, mosaic, emboss] satisfies NodeDef[];
