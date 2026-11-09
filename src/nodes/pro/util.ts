/**
 * Utility nodes: Compare Grid (A/B up to four variations with labels), Watermark (text / logo /
 * signature, placed or tiled) and Print Frame (gallery mat with bevel, 35 mm film strip with sprocket
 * holes and edge print, medium-format negative carrier). Text is drawn on a CPU canvas and composited
 * in the shader; all sizes are relative to the image so preview and export match.
 */
import { defineNode } from '../../core/registry';
import type { NodeDef, Params, PassContext } from '../../core/types';
import { num } from '../library/shared';

const C = '#6f7f8f';

/** Draw one line of text into a tight RGBA ImageData (straight alpha). */
function textImage(text: string, font: string, px: number, color = '#fff', italic = false): ImageData {
  px = Math.max(4, Math.round(px));
  const probe = new OffscreenCanvas(8, 8).getContext('2d')!;
  const f = `${italic ? 'italic ' : ''}${font.includes('px') ? font : `${px}px ${font}`}`;
  probe.font = f;
  const w = Math.max(1, Math.ceil(probe.measureText(text || ' ').width + px * 0.6));
  const h = Math.max(1, Math.ceil(px * 1.45));
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.font = f;
  g.fillStyle = color;
  g.textBaseline = 'middle';
  g.fillText(text, px * 0.3, h / 2);
  return g.getImageData(0, 0, w, h);
}

/** Stack ImageDatas vertically into one atlas (rows of equal height `rowH`, left aligned). Returns atlas + per-row widths. */
function atlas(rows: ImageData[]): { img: ImageData; widths: number[]; rowH: number } {
  const rowH = Math.max(1, ...rows.map((r) => r.height));
  const W = Math.max(1, ...rows.map((r) => r.width));
  const out = new ImageData(W, rowH * Math.max(1, rows.length));
  rows.forEach((r, i) => {
    for (let y = 0; y < r.height; y++) out.data.set(r.data.subarray(y * r.width * 4, (y + 1) * r.width * 4), ((i * rowH + y) * W) * 4);
  });
  return { img: out, widths: rows.map((r) => r.width), rowH };
}

// ---------------------------------------------------------------------------
// Compare Grid
// ---------------------------------------------------------------------------
const IN = ['a', 'b', 'c', 'd'] as const;

function gridLayout(n: number, layout: string): [number, number] {
  if (layout === 'row') return [n, 1];
  if (layout === 'column') return [1, n];
  if (layout === 'grid') return [2, Math.ceil(n / 2)];
  return n <= 2 ? [n, 1] : [2, 2];
}

const compareGrid = defineNode({
  id: 'pro.compareGrid',
  name: 'Compare Grid',
  category: 'Utility',
  color: C,
  description:
    'Shows 2–4 variations side by side (or in a 2×2 grid) with labels, for A/B-ing grades, presets or settings. Every cell has the size of input A; other inputs are fitted into it. ' +
    'Connect the same source through different branches, then export the sheet or view it.',
  tags: ['compare', 'a/b', 'side by side', 'grid', 'contact sheet', 'before after', 'variations', 'split'],
  inputs: {
    a: { type: 'image', label: 'A' },
    b: { type: 'image', label: 'B' },
    c: { type: 'image', label: 'C', optional: true },
    d: { type: 'image', label: 'D', optional: true },
  },
  params: {
    layout: { type: 'enum', default: 'auto', options: ['auto', 'row', 'column', 'grid'], label: 'Layout' },
    labels: { type: 'bool', default: true, label: 'Show labels' },
    labelA: { type: 'string', default: 'A', label: 'Label A' },
    labelB: { type: 'string', default: 'B', label: 'Label B' },
    labelC: { type: 'string', default: 'C', label: 'Label C' },
    labelD: { type: 'string', default: 'D', label: 'Label D' },
    labelSize: { type: 'float', default: 5, min: 1, max: 12, step: 0.1, label: 'Label size (%)', description: 'Percent of the cell height.' },
    gap: { type: 'float', default: 16, min: 0, max: 200, step: 1, pixels: true, label: 'Gap' },
    background: { type: 'color', default: [0.08, 0.08, 0.09, 1], label: 'Background' },
  },
  size: ({ params, inputSizes, projectSize }) => {
    const a = inputSizes.a ?? projectSize;
    const n = Math.max(2, IN.filter((k) => inputSizes[k]).length);
    const [cols, rows] = gridLayout(n, String(params.layout));
    const g = Math.max(0, num(params, 'gap', 16));
    return [Math.round(cols * a.width + (cols + 1) * g), Math.round(rows * a.height + (rows + 1) * g)];
  },
  cpu: ({ params, scale, projectSize }) => {
    const px = Math.max(10, (num(params, 'labelSize', 5) / 100) * projectSize.height * scale * 1.6);
    const at = atlas(['labelA', 'labelB', 'labelC', 'labelD'].map((k, i) => textImage(String(params[k] ?? 'ABCD'[i]), `600 ${Math.round(px)}px system-ui, sans-serif`, px)));
    return { labelsTex: at.img, labelW: { width: 4, height: 1, data: new Float32Array(at.widths.flatMap((w) => [w, at.rowH, 0, 1])), filter: 'nearest' } };
  },
  passes: [{
    uniforms: (ctx: PassContext) => {
      const n = Math.max(2, IN.filter((k) => ctx.inputSizes[k]).length);
      const [cols, rows] = gridLayout(n, String(ctx.params.layout));
      return { u_grid: [cols, rows], u_n: n };
    },
    frag: /* glsl */ `
uniform vec2 u_grid;
uniform int u_n;
vec4 cellTex(int k, vec2 uv) {
  if (k == 0) return texture(u_a, uv);
  if (k == 1) return texture(u_b, uv);
  if (k == 2) return texture(u_c, uv);
  return texture(u_d, uv);
}
vec2 sizeOf(int k) { return k == 0 ? u_a_size : k == 1 ? u_b_size : k == 2 ? u_c_size : u_d_size; }
void main() {
  vec2 p = v_uv * u_resolution;
  float g = u_gap * u_scale;
  vec2 cell = (u_resolution - (u_grid + 1.0) * g) / u_grid;
  vec2 ij = floor((p - g * 0.5) / (cell + g));
  ij = clamp(ij, vec2(0.0), u_grid - 1.0);
  vec2 o = g + ij * (cell + g);
  vec2 q = (p - o) / cell; // 0..1 inside the cell
  int k = int(ij.y * u_grid.x + ij.x);
  vec4 col = u_background;
  if (k < u_n && all(greaterThanEqual(q, vec2(0.0))) && all(lessThanEqual(q, vec2(1.0)))) {
    // fit the input into the cell (letterbox), keeping its aspect ratio
    vec2 s = sizeOf(k);
    float ar = (s.x / s.y) / (cell.x / cell.y);
    vec2 uv = q;
    if (ar > 1.0) uv.y = (q.y - 0.5) * ar + 0.5; else uv.x = (q.x - 0.5) / ar + 0.5;
    if (all(greaterThanEqual(uv, vec2(0.0))) && all(lessThanEqual(uv, vec2(1.0)))) {
      vec4 c = cellTex(k, uv);
      col = vec4(mix(u_background.rgb, c.rgb, c.a), 1.0);
    }
    if (u_labels) {
      // label pill in the top-left corner of the cell
      vec4 lw = texelFetch(u_labelW, ivec2(k, 0), 0);
      float h = u_labelSize / 100.0 * cell.y * 1.45;
      float sc = h / lw.y;
      vec2 lp = (p - o - vec2(h * 0.35)) / sc; // label texture px
      if (lw.x > 1.0 && lp.x >= -lw.y * 0.25 && lp.y >= -lw.y * 0.1 && lp.x <= lw.x + lw.y * 0.1 && lp.y <= lw.y * 1.1) {
        col.rgb = mix(col.rgb, vec3(0.0), 0.55);
        if (lp.x >= 0.0 && lp.y >= 0.0 && lp.x < lw.x && lp.y < lw.y) {
          float a = texture(u_labelsTex, (vec2(lp.x, lp.y + float(k) * lw.y)) / u_labelsTex_size).a;
          col.rgb = mix(col.rgb, vec3(1.0), a);
        }
      }
    }
  }
  fragColor = col;
}`,
  }],
});

// ---------------------------------------------------------------------------
// Watermark
// ---------------------------------------------------------------------------
const FONTS: Record<string, string> = {
  'sans-serif': '600 PX system-ui, "Helvetica Neue", Arial, sans-serif',
  serif: '500 PX Georgia, "Times New Roman", serif',
  monospace: '500 PX ui-monospace, Menlo, monospace',
  signature: 'italic 400 PX "Snell Roundhand", "Segoe Script", "Brush Script MT", "Apple Chancery", cursive',
};

const watermark = defineNode({
  id: 'pro.watermark',
  name: 'Watermark',
  category: 'Utility',
  color: C,
  description:
    'Adds a text or logo watermark: placed in a corner / edge / centre with a margin, or tiled diagonally across the image (stock-photo style). Size is relative to the image, so it looks the same at any resolution. ' +
    'Text styles: plain, © copyright, and a handwritten signature with an underline flourish. Logo mode uses a PNG with transparency. Optional soft shadow for legibility on busy backgrounds.',
  tags: ['watermark', 'copyright', 'signature', 'logo', 'text', 'branding', 'tile', 'protect', 'credit'],
  inputs: { image: { type: 'image' } },
  params: {
    kind: { type: 'enum', default: 'text', options: ['text', 'image'], label: 'Type' },
    text: { type: 'string', default: 'Your Name', label: 'Text' },
    style: { type: 'enum', default: 'copyright', options: ['plain', 'copyright', 'signature'], label: 'Text style' },
    font: { type: 'enum', default: 'sans-serif', options: ['sans-serif', 'serif', 'monospace'], label: 'Font', description: 'Ignored for the signature style (script font).' },
    logo: { type: 'asset', default: '', accept: 'image/png,image/*', label: 'Logo image' },
    position: { type: 'enum', default: 'bottom-right', options: ['bottom-right', 'bottom-left', 'top-right', 'top-left', 'bottom', 'top', 'center', 'tiled'], label: 'Position' },
    size: { type: 'float', default: 4, min: 0.5, max: 40, step: 0.1, label: 'Size (%)', description: 'Height of the mark as a percentage of the image\'s smin side.' },
    margin: { type: 'float', default: 3, min: 0, max: 30, step: 0.1, label: 'Margin (%)' },
    opacity: { type: 'float', default: 0.75, min: 0, max: 1, step: 0.01, label: 'Opacity' },
    color: { type: 'color', default: [1, 1, 1, 1], label: 'Colour' },
    shadow: { type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Shadow' },
    tileAngle: { type: 'float', default: -30, min: -90, max: 90, step: 1, label: 'Tile angle (°)' },
    tileSpacing: { type: 'float', default: 2.2, min: 1, max: 6, step: 0.05, label: 'Tile spacing', description: 'Distance between tiles in mark sizes.' },
  },
  cpu: ({ params, scale, projectSize, getAsset }) => {
    if (params.kind === 'image') {
      const a = getAsset(String(params.logo ?? ''));
      if (a?.image) {
        const cv = new OffscreenCanvas(a.image.width, a.image.height);
        const g = cv.getContext('2d', { willReadFrequently: true })!;
        g.drawImage(a.image, 0, 0);
        return { mark: g.getImageData(0, 0, cv.width, cv.height) };
      }
      return { mark: new ImageData(1, 1) };
    }
    const smin = Math.min(projectSize.width, projectSize.height) * scale;
    const px = Math.max(12, (num(params, 'size', 4) / 100) * smin * 1.4);
    const style = String(params.style ?? 'copyright');
    let text = String(params.text ?? 'Your Name');
    if (style === 'copyright' && !text.startsWith('©')) text = `© ${text}`;
    const font = (style === 'signature' ? FONTS.signature : FONTS[String(params.font)] ?? FONTS['sans-serif']).replace('PX', `${Math.round(px)}px`);
    const t = textImage(text, font, px);
    if (style !== 'signature') return { mark: t };
    // signature: add a tapered underline flourish below the text
    const c = new OffscreenCanvas(t.width, Math.round(t.height * 1.25));
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.putImageData(t, 0, 0);
    g.strokeStyle = '#fff';
    g.lineCap = 'round';
    const y = t.height * 0.98, x0 = px * 0.4, x1 = t.width - px * 0.2;
    for (let i = 0; i < 24; i++) {
      const a = i / 24, b = (i + 1) / 24;
      g.lineWidth = Math.max(1, px * 0.06 * Math.sin(Math.PI * (a + 0.02)));
      g.beginPath();
      g.moveTo(x0 + (x1 - x0) * a, y - Math.sin(a * Math.PI) * px * 0.12 + a * px * 0.1);
      g.lineTo(x0 + (x1 - x0) * b, y - Math.sin(b * Math.PI) * px * 0.12 + b * px * 0.1);
      g.stroke();
    }
    return { mark: g.getImageData(0, 0, c.width, c.height) };
  },
  passes: [{
    frag: /* glsl */ `
float markAlpha(vec2 mp, vec2 msz) {
  if (any(lessThan(mp, vec2(0.0))) || any(greaterThan(mp, msz))) return 0.0;
  return texture(u_mark, mp / msz).a;
}
void main() {
  vec4 src = texture(u_image, v_uv);
  vec2 p = v_uv * u_resolution;
  float smin = min(u_resolution.x, u_resolution.y);
  float mh = u_size / 100.0 * smin;
  vec2 msz = vec2(mh * u_mark_size.x / u_mark_size.y, mh);
  float m = u_margin / 100.0 * smin;
  vec2 mp; // position inside the mark (px)
  int pos = u_position;
  if (pos == 7) {
    // tiled: rotate the plane, repeat on a staggered grid
    float a = radians(u_tileAngle);
    vec2 c = p - u_resolution * 0.5;
    vec2 r = vec2(cos(a) * c.x + sin(a) * c.y, -sin(a) * c.x + cos(a) * c.y);
    vec2 cellSz = vec2(msz.x + mh * (u_tileSpacing - 1.0) * 1.5, mh * u_tileSpacing);
    float row = floor(r.y / cellSz.y);
    r.x += mod(row, 2.0) * cellSz.x * 0.5;
    mp = mod(r, cellSz) - (cellSz - msz) * 0.5;
  } else {
    vec2 o;
    o.x = (pos == 0 || pos == 2) ? u_resolution.x - m - msz.x : (pos == 1 || pos == 3) ? m : (u_resolution.x - msz.x) * 0.5;
    o.y = (pos == 2 || pos == 3 || pos == 5) ? m : (pos == 6) ? (u_resolution.y - msz.y) * 0.5 : u_resolution.y - m - msz.y;
    mp = p - o;
  }
  float a = markAlpha(mp, msz);
  // soft shadow: blurred alpha offset down-right
  float sh = 0.0;
  if (u_shadow > 0.0) {
    vec2 so = vec2(0.04, 0.06) * mh;
    float r = 0.05 * mh;
    for (int i = 0; i < 8; i++) {
      float t = float(i) * TAU / 8.0;
      sh += markAlpha(mp - so + vec2(cos(t), sin(t)) * r, msz);
    }
    sh = sh / 8.0 * u_shadow * 0.7;
  }
  vec3 col = u_kind == 1 ? texture(u_mark, clamp(mp / msz, 0.0, 1.0)).rgb : u_color.rgb;
  vec3 o = mix(src.rgb, src.rgb * 0.25, sh * u_opacity * (1.0 - a));
  o = mix(o, col, a * u_opacity);
  fragColor = vec4(o, src.a);
}`,
  }],
});

// ---------------------------------------------------------------------------
// Print Frame
// ---------------------------------------------------------------------------
type Frame = { L: number; T: number; R: number; B: number; vertical: boolean };

/** Border sizes (full-res px) per style, from the image size. */
function frameGeom(style: string, w: number, h: number, params: Params): Frame {
  const smin = Math.min(w, h);
  if (style === 'film strip (35mm)') {
    // 24×36 mm frame on 35 mm film: 5.5 mm margins (perforations) across, ~2 mm gaps between frames
    const vertical = h > w;
    const across = vertical ? w : h; // image size across the film = 24 mm
    const mm = across / 24;
    const m = 5.5 * mm, g = 2.2 * mm;
    return vertical ? { L: m, R: m, T: g, B: g, vertical } : { L: g, R: g, T: m, B: m, vertical };
  }
  if (style === 'negative carrier (filed)') {
    const b = smin * 0.045;
    return { L: b, R: b, T: b, B: b * 1.6, vertical: false };
  }
  // gallery mat: mat width as % of the smin side, slightly heavier bottom (optical centring)
  const mat = (num(params, 'matWidth', 12) / 100) * smin;
  const moulding = (num(params, 'moulding', 1.6) / 100) * smin;
  return { L: mat + moulding, R: mat + moulding, T: mat + moulding, B: mat * 1.15 + moulding, vertical: false };
}

const frame = defineNode({
  id: 'pro.frame',
  name: 'Print Frame',
  category: 'Utility',
  color: C,
  description:
    'Presentation borders that enlarge the canvas: a gallery mat with a 45° bevel-cut window and an optional frame moulding; a 35 mm film strip with sprocket holes, frame gaps and edge print (frame number and your text); ' +
    'or a filed-out negative-carrier black border with rough edges. Optional rounded corners on the photo. (For instant-film frames use Instant Frame; for plain colour borders, Border / Frame.)',
  tags: ['frame', 'mat', 'passe-partout', 'bevel', 'film strip', 'sprocket', 'negative', 'border', 'print', 'gallery', 'rounded corners', 'presentation'],
  inputs: { image: { type: 'image' } },
  params: {
    style: { type: 'enum', default: 'gallery mat', options: ['gallery mat', 'film strip (35mm)', 'negative carrier (filed)'], label: 'Style' },
    matWidth: { type: 'float', default: 12, min: 2, max: 40, step: 0.5, label: 'Mat width (%)' },
    matColor: { type: 'color', default: [0.95, 0.94, 0.91, 1], label: 'Mat colour' },
    bevel: { type: 'float', default: 0.8, min: 0, max: 2, step: 0.05, label: 'Bevel (%)' },
    moulding: { type: 'float', default: 1.6, min: 0, max: 8, step: 0.1, label: 'Moulding (%)', description: 'Outer frame width (0 = mat only).' },
    mouldingColor: { type: 'color', default: [0.08, 0.07, 0.06, 1], label: 'Moulding colour' },
    edgeText: { type: 'string', default: 'DARKROOM 400', label: 'Edge print' },
    frameNumber: { type: 'int', default: 12, min: 0, max: 99, step: 1, label: 'Frame number' },
    cornerRadius: { type: 'float', default: 0, min: 0, max: 20, step: 0.1, label: 'Photo corner radius (%)' },
    seed: { type: 'int', default: 3, min: 0, max: 999, step: 1, label: 'Seed' },
  },
  size: ({ params, inputSizes, projectSize }) => {
    const s = inputSizes.image ?? projectSize;
    const f = frameGeom(String(params.style), s.width, s.height, params);
    return [Math.round(s.width + f.L + f.R), Math.round(s.height + f.T + f.B)];
  },
  cpu: ({ params, scale, projectSize }) => {
    // edge print: "<text>   ▸12   12A" in the film's orange-ish edge-code colour
    const across = Math.min(projectSize.width, projectSize.height) * scale;
    const px = Math.max(8, (across / 24) * 1.25 * 1.6);
    const n = Math.round(num(params, 'frameNumber', 12));
    const t = textImage(`${String(params.edgeText ?? 'DARKROOM 400')}     ▸${n}     ${n}A`, `600 ${Math.round(px)}px ui-monospace, Menlo, monospace`, px, '#fff');
    return { edge: t };
  },
  passes: [{
    uniforms: (ctx: PassContext) => {
      const s = ctx.inputSizes.image ?? { width: ctx.width, height: ctx.height };
      const f = frameGeom(String(ctx.params.style), s.width / ctx.scale, s.height / ctx.scale, ctx.params);
      return { u_border: [f.L * ctx.scale, f.T * ctx.scale, f.R * ctx.scale, f.B * ctx.scale], u_vertical: f.vertical ? 1 : 0 };
    },
    frag: /* glsl */ `
uniform vec4 u_border; // L T R B (current px)
uniform int u_vertical;
float sdRoundBox(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
void main() {
  vec2 p = v_uv * u_resolution;
  vec2 imgO = u_border.xy, imgS = u_resolution - u_border.xy - u_border.zw;
  vec2 q = (p - imgO) / imgS;
  float smin = min(imgS.x, imgS.y);
  vec4 photo = texture(u_image, clamp(q, 0.0, 1.0));
  float rr = u_cornerRadius / 100.0 * smin;
  float dImg = sdRoundBox(p - (imgO + imgS * 0.5), imgS * 0.5, rr);
  float inImg = 1.0 - smoothstep(-0.5, 0.5, dImg);
  vec3 col;
  if (u_style == 0) {
    // gallery mat: moulding outside, mat, bevel-cut window
    float mould = u_moulding / 100.0 * smin;
    vec2 d2 = min(p, u_resolution - p);
    float dOut = min(d2.x, d2.y);
    vec3 mat = u_matColor.rgb * (0.97 + 0.03 * valueNoise(p * 0.35 + float(u_seed)));
    col = mat;
    float bev = u_bevel / 100.0 * smin;
    // bevel: band around the window; lit from the top-left
    float dWin = sdRoundBox(p - (imgO + imgS * 0.5), imgS * 0.5, 0.0);
    if (dWin > 0.0 && dWin < bev) {
      vec2 rel = p - (imgO + imgS * 0.5);
      vec2 nrm = abs(rel.x) / imgS.x > abs(rel.y) / imgS.y ? vec2(sign(rel.x), 0.0) : vec2(0.0, sign(rel.y));
      float light = dot(nrm, normalize(vec2(-1.0, -1.2)));
      col = vec3(0.97, 0.96, 0.93) * (0.9 + 0.12 * light);
    }
    // soft shadow of the mat on the photo (window edge)
    if (dOut < mould) {
      float t = dOut / max(mould, 1.0);
      col = u_mouldingColor.rgb * (0.8 + 0.4 * t) + 0.04 * valueNoise(p * vec2(0.02, 0.6));
    } else if (dOut < mould + 0.004 * smin) col *= 0.7; // inner edge of the moulding
    float shade = smoothstep(0.0, 0.012 * smin, -dWin);
    photo.rgb *= mix(0.82, 1.0, shade);
  } else if (u_style == 1) {
    // film strip: black base, sprocket holes (KS: 2.8 × 1.98 mm, pitch 4.75 mm), edge print
    vec2 fp = u_vertical == 1 ? vec2(p.y, p.x) : p;          // along, across
    vec2 fs = u_vertical == 1 ? u_resolution.yx : u_resolution;
    float across = u_vertical == 1 ? imgS.x : imgS.y;
    float mm = across / 24.0;
    col = vec3(0.045, 0.04, 0.035) + 0.02 * valueNoise(p * 0.05);
    float centre = fs.x * 0.5;
    float along = fp.x - centre + 2.375 * mm;
    float k = mod(along, 4.75 * mm) - 2.375 * mm;
    for (int side = 0; side < 2; side++) {
      float cy = side == 0 ? 2.0 * mm : fs.y - 2.0 * mm;
      float hole = sdRoundBox(vec2(k, fp.y - cy), vec2(1.4, 0.99) * mm, 0.35 * mm);
      if (hole < 0.0) col = vec3(0.92);
      else if (hole < 0.12 * mm) col = mix(vec3(0.2), col, hole / (0.12 * mm));
    }
    // edge print in the band between holes and the image (bottom / right side)
    float bandY = fs.y - 4.3 * mm;
    vec2 tp = vec2(fp.x - 6.0 * mm, fp.y - (bandY - 0.65 * mm));
    float th = 1.3 * mm;
    vec2 tuv = tp / vec2(th * u_edge_size.x / u_edge_size.y, th);
    if (all(greaterThanEqual(tuv, vec2(0.0))) && all(lessThanEqual(tuv, vec2(1.0)))) {
      float a = texture(u_edge, tuv).a;
      col = mix(col, vec3(0.95, 0.55, 0.15), a * 0.9);
    }
  } else {
    // negative carrier: black with a rough, filed transition into the photo
    col = vec3(0.02);
    float rough = (valueNoise(p * 0.08 + float(u_seed)) - 0.5) * 0.012 * smin + (valueNoise(p * 0.6) - 0.5) * 0.002 * smin;
    float dWin = sdRoundBox(p - (imgO + imgS * 0.5), imgS * 0.5 + 0.006 * smin, 0.004 * smin) + rough;
    inImg = 1.0 - smoothstep(-0.8, 0.8, dWin);
    photo = texture(u_image, clamp(q, 0.0, 1.0));
  }
  fragColor = vec4(mix(col, photo.rgb, inImg * photo.a), 1.0);
}`,
  }],
});

export default [compareGrid, watermark, frame] satisfies NodeDef[];
