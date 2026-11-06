import { defineNode } from '../../core/registry';
import type { NodeDef } from '../../core/types';
import { F } from './_shared';

const C = '#ffb347';
const img = { image: { type: 'image' as const } };

// ---------------------------------------------------------------------------
// Film curve
// ---------------------------------------------------------------------------
const STOCKS = ['consumer400', 'slide', 'expired', 'instant', 'portrait160', 'bw400'];

const filmCurve = defineNode({
  id: 'analog.filmCurve',
  name: 'Film Stock',
  category: 'Analog',
  color: C,
  description:
    'Film-stock tone curve and colour response. consumer400: cheap drugstore ISO 400 (warm-green cast, lifted blacks); slide: punchy, saturated reversal film; ' +
    'expired: faded, magenta shadows / cyan-green highlights; instant: creamy Polaroid-like, soft contrast, cyan shadows, warm highlights; ' +
    'portrait160: soft natural portrait negative; bw400: classic black & white. Blacks are lifted and highlights rolled off like a print.',
  tags: ['film', 'stock', 'kodak', 'fuji', 'polaroid', 'expired', 'tone curve', 'analog', 'grade'],
  inputs: img,
  params: {
    stock: { type: 'enum', default: 'consumer400', options: STOCKS, label: 'Stock' },
    strength: { type: 'float', default: 1, min: 0, max: 1.5, step: 0.01, label: 'Strength' },
    fade: { type: 'float', default: 0, min: 0, max: 1, step: 0.01, label: 'Extra fade', description: 'Additional lifted blacks.' },
    warmth: { type: 'float', default: 0, min: -1, max: 1, step: 0.01, label: 'Warmth' },
  },
  passes: [{
    frag: F(`
// per stock: lift, gain, gamma, tints; contrast/sat in vec2
const vec3 LIFT[6] = vec3[6](vec3(0.055, 0.068, 0.05), vec3(0.01, 0.012, 0.03), vec3(0.14, 0.08, 0.12), vec3(0.1, 0.1, 0.12), vec3(0.035, 0.03, 0.03), vec3(0.035));
const vec3 GAIN[6] = vec3[6](vec3(0.98, 0.97, 0.9), vec3(1.0, 1.0, 0.98), vec3(0.9, 0.93, 0.8), vec3(0.97, 0.93, 0.83), vec3(0.98, 0.96, 0.92), vec3(0.96));
const vec3 GAM[6] = vec3[6](vec3(1.0, 0.96, 1.05), vec3(1.02, 1.0, 0.97), vec3(0.95, 1.04, 1.02), vec3(0.98, 1.0, 0.96), vec3(0.97, 1.0, 1.03), vec3(1.0));
const vec3 SH[6] = vec3[6](vec3(-0.015, 0.02, 0.0), vec3(-0.01, 0.0, 0.025), vec3(0.04, -0.02, 0.035), vec3(-0.035, 0.005, 0.03), vec3(0.0, 0.005, 0.015), vec3(0.0));
const vec3 HI[6] = vec3[6](vec3(0.03, 0.01, -0.03), vec3(0.015, 0.01, -0.01), vec3(-0.035, 0.02, 0.0), vec3(0.035, 0.012, -0.03), vec3(0.02, 0.008, -0.012), vec3(0.0));
const vec2 CS[6] = vec2[6](vec2(1.25, 1.08), vec2(1.6, 1.35), vec2(0.85, 0.68), vec2(0.8, 0.8), vec2(1.05, 0.9), vec2(1.4, 0.0));
float sig(float x, float k) {
  float p = 0.45;
  x = clamp(x, 0.0, 1.0);
  return x < p ? p * pow(x / p, k) : 1.0 - (1.0 - p) * pow((1.0 - x) / (1.0 - p), k);
}
float shoulder(float x) { float s = 0.78; return x < s ? x : s + (1.0 - s) * (1.0 - exp(-(x - s) / (1.0 - s))) / (1.0 - exp(-1.0)); }
void main() {
  vec4 src = texture(u_image, v_uv);
  int i = u_stock;
  vec3 c = clamp(src.rgb, 0.0, 1.2);
  float l0 = luma(c);
  c = mix(vec3(l0), c, CS[i].y);
  c = max(c, 0.0);
  c = pow(c, GAM[i]);
  c = vec3(sig(c.r, CS[i].x), sig(c.g, CS[i].x), sig(c.b, CS[i].x));
  c = vec3(shoulder(c.r), shoulder(c.g), shoulder(c.b));
  float l = luma(c);
  c += SH[i] * (1.0 - l) * (1.0 - l) * 2.0 + HI[i] * l * l * 2.0;
  vec3 lift = LIFT[i] + u_fade * vec3(0.12, 0.11, 0.115);
  c = lift + (GAIN[i] - lift) * c;
  c *= mix(vec3(1.0), u_warmth > 0.0 ? vec3(1.06, 1.0, 0.88) : vec3(0.92, 0.99, 1.08), abs(u_warmth));
  fragColor = vec4(clamp(mix(src.rgb, c, u_strength), 0.0, 1.0), src.a);
}`),
  }],
});

// ---------------------------------------------------------------------------
// Date stamp
// ---------------------------------------------------------------------------
const DH = 64, DW = 36, T = 9, GAP = 14, PAD = 24, SLANT = 0.1;
const SEG: Record<string, string> = {
  '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc', '5': 'afgcd', '6': 'afgedc', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg',
  '-': 'g', A: 'abcefg', P: 'abefg', M: 'abcef', E: 'adefg', C: 'adef', H: 'bcefg', L: 'def', o: 'cdeg', r: 'eg',
};

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function drawSevenSeg(text: string) {
  const chars = [...text];
  const widthOf = (ch: string) => (ch === ' ' ? DW * 0.55 : ch === "'" || ch === '.' || ch === ':' ? T * 1.8 : DW) + GAP;
  const w = Math.ceil(PAD * 2 + chars.reduce((a, ch) => a + widthOf(ch), 0) + DH * SLANT);
  const h = DH + PAD * 2;
  const canvas: OffscreenCanvas | HTMLCanvasElement = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const g = canvas.getContext('2d') as Ctx2D;
  g.fillStyle = '#fff';
  const sk = (x: number, y: number): [number, number] => [x + (DH - y) * SLANT, y];
  const poly = (pts: [number, number][]) => {
    g.beginPath();
    pts.forEach(([x, y], i) => { const [sx, sy] = sk(x, y); i ? g.lineTo(PAD + sx, PAD + sy) : g.moveTo(PAD + sx, PAD + sy); });
    g.closePath();
    g.fill();
  };
  const hbar = (x0: number, x1: number, y: number) => { const t = T / 2, gg = 1.5; poly([[x0 + gg, y], [x0 + gg + t, y - t], [x1 - gg - t, y - t], [x1 - gg, y], [x1 - gg - t, y + t], [x0 + gg + t, y + t]]); };
  const vbar = (x: number, y0: number, y1: number) => { const t = T / 2, gg = 1.5; poly([[x, y0 + gg], [x + t, y0 + gg + t], [x + t, y1 - gg - t], [x, y1 - gg], [x - t, y1 - gg - t], [x - t, y0 + gg + t]]); };
  let x = 0;
  for (const ch of chars) {
    if (ch === "'") { poly([[x + T * 0.3, 0], [x + T * 1.3, 0], [x + T * 0.6, DH * 0.28], [x, DH * 0.28]].map(([a, b]) => [a, b]) as [number, number][]); }
    else if (ch === '.') { poly([[x, DH - T], [x + T, DH - T], [x + T, DH], [x, DH]]); }
    else if (ch === ':') { poly([[x, DH * 0.25], [x + T, DH * 0.25], [x + T, DH * 0.25 + T], [x, DH * 0.25 + T]]); poly([[x, DH * 0.7], [x + T, DH * 0.7], [x + T, DH * 0.7 + T], [x, DH * 0.7 + T]]); }
    else {
      const s = SEG[ch] ?? SEG[ch.toUpperCase()] ?? '';
      const t = T / 2;
      if (s.includes('a')) hbar(x, x + DW, t);
      if (s.includes('g')) hbar(x, x + DW, DH / 2);
      if (s.includes('d')) hbar(x, x + DW, DH - t);
      if (s.includes('f')) vbar(x + t, 0, DH / 2);
      if (s.includes('b')) vbar(x + DW - t, 0, DH / 2);
      if (s.includes('e')) vbar(x + t, DH / 2, DH);
      if (s.includes('c')) vbar(x + DW - t, DH / 2, DH);
    }
    x += widthOf(ch);
  }
  return canvas;
}

const dateStamp = defineNode({
  id: 'analog.dateStamp',
  name: 'Date Stamp',
  category: 'Analog',
  color: C,
  description:
    'The orange LED date imprint of 90s compact film cameras: slanted 7-segment digits exposed from behind through the film, slightly blurred with a warm glow. ' +
    'Supports digits, space, apostrophe, dash, colon and dot.',
  tags: ['date', 'timestamp', 'film', 'point and shoot', 'disposable', '90s', 'text', '7-segment'],
  inputs: img,
  params: {
    text: { type: 'string', default: "'98 11 06", label: 'Date text' },
    position: { type: 'vec2', default: [0.93, 0.92], min: 0, max: 1, step: 0.005, label: 'Position (bottom-right corner)' },
    size: { type: 'float', default: 0.035, min: 0.005, max: 0.2, step: 0.001, label: 'Digit height', description: 'Fraction of image height.' },
    color: { type: 'color', default: [1, 0.48, 0.1, 1], label: 'Colour' },
    intensity: { type: 'float', default: 1, min: 0, max: 3, step: 0.01, label: 'Intensity' },
    glow: { type: 'float', default: 0.7, min: 0, max: 3, step: 0.01, label: 'Glow' },
    softness: { type: 'float', default: 0.4, min: 0, max: 2, step: 0.01, label: 'Softness' },
  },
  cpu: ({ params }) => ({ stamp: drawSevenSeg(String(params.text ?? '')) }),
  passes: [{
    frag: F(`
const float DH = ${DH.toFixed(1)}, PAD = ${PAD.toFixed(1)};
vec2 tuv(vec2 px) {
  float k = u_size * u_resolution.y / DH; // output px per stamp px
  vec2 ext = u_stamp_size * k;
  vec2 origin = u_position * u_resolution - ext + PAD * k;
  return (px - origin) / ext;
}
float st(vec2 uv) { return (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) ? 0.0 : texture(u_stamp, uv).a; }
void main() {
  vec4 src = texture(u_image, v_uv);
  vec2 uv = tuv(pixelCoord());
  vec2 sp = 1.0 / u_stamp_size; // one stamp pixel in uv
  float soft = 1.0 + u_softness * 4.0;
  float core = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) core += st(uv + sp * vec2(i, j) * soft) * (i == 0 && j == 0 ? 4.0 : (i == 0 || j == 0 ? 2.0 : 1.0));
  core /= 16.0;
  float glow = 0.0;
  for (int i = 0; i < 16; i++) {
    float a = float(i) * 2.39996;
    float r = sqrt((float(i) + 0.5) / 16.0) * 16.0;
    glow += st(uv + sp * vec2(cos(a), sin(a)) * r);
  }
  glow /= 16.0;
  vec3 col = toLin(u_color.rgb);
  vec3 hot = mix(col, vec3(1.0, 0.85, 0.55), 0.45);
  vec3 lin = toLin(src.rgb);
  lin += (hot * core * 1.6 + col * glow * u_glow * 0.5) * u_intensity;
  fragColor = vec4(toSrgb(lin), src.a);
}`),
  }],
});


// ---------------------------------------------------------------------------
// Instant film frame
// ---------------------------------------------------------------------------
const frameGeom = (params: Record<string, unknown>, w: number, h: number) => {
  const sq = params.square !== false;
  const b = Number(params.border ?? 0.06), bot = Number(params.bottom ?? 0.24);
  const ih = sq ? Math.min(w, h) : h, iw = sq ? ih : w;
  return { W: iw + 2 * b * ih, H: ih * (1 + b + bot) };
};

const instantFrame = defineNode({
  id: 'analog.instantFrame',
  name: 'Instant Frame',
  category: 'Analog',
  color: C,
  description: 'Puts the picture in an instant-film frame: (optionally square-cropped) image, thin borders and the thick bottom “chin”, with a faint paper texture and an inset edge shadow. Enlarges the output.',
  tags: ['polaroid', 'instax', 'frame', 'border', 'instant'],
  inputs: img,
  params: {
    enabled: { type: 'bool', default: true, label: 'Frame' },
    square: { type: 'bool', default: true, label: 'Square crop' },
    border: { type: 'float', default: 0.06, min: 0, max: 0.4, step: 0.005, label: 'Border', description: 'Relative to picture height.' },
    bottom: { type: 'float', default: 0.24, min: 0, max: 1, step: 0.005, label: 'Bottom border' },
    color: { type: 'color', default: [0.95, 0.94, 0.91, 1], label: 'Frame colour' },
  },
  size: ({ params, inputSizes, projectSize }) => {
    const s = inputSizes.image ?? projectSize;
    if (params.enabled === false) return [s.width, s.height];
    const g = frameGeom(params, s.width, s.height);
    return [Math.round(g.W), Math.round(g.H)];
  },
  passes: [{
    frag: F(`
void main() {
  if (!u_enabled) { fragColor = texture(u_image, v_uv); return; }
  float iw = u_image_size.x, ih = u_image_size.y;
  float A = u_square ? 1.0 : iw / ih;
  float W = A + 2.0 * u_border, H = 1.0 + u_border + u_bottom;
  vec2 p = v_uv * vec2(W, H) - vec2(u_border); // inner-picture units (height = 1)
  vec2 q = vec2(p.x / A, p.y);
  float px = H / u_resolution.y;
  vec3 paper = u_color.rgb * (0.985 + 0.015 * fbm(v_uv * vec2(W, H) * 40.0, 3)) ;
  // subtle darkening of the frame towards the bottom edge, like a slightly curled print
  paper *= 1.0 - 0.03 * v_uv.y;
  if (q.x < 0.0 || q.y < 0.0 || q.x > 1.0 || q.y > 1.0) {
    // soft shadow just outside the picture (the window is slightly recessed)
    vec2 d = max(max(-q, q - 1.0) * vec2(A, 1.0), 0.0);
    float sh = exp(-length(d) / (0.006)) * 0.12;
    fragColor = vec4(paper * (1.0 - sh), 1.0);
    return;
  }
  vec2 uv = q;
  if (u_square) {
    if (iw > ih) uv.x = 0.5 + (q.x - 0.5) * ih / iw;
    else uv.y = 0.5 + (q.y - 0.5) * iw / ih;
  }
  vec3 c = texture(u_image, uv).rgb;
  // inset shadow along the picture edge
  vec2 e = min(q, 1.0 - q) * vec2(A, 1.0);
  float ed = min(e.x, e.y);
  c *= 1.0 - 0.18 * exp(-ed / 0.008);
  fragColor = vec4(c, 1.0);
}`),
  }],
});

export default [filmCurve, dateStamp, instantFrame] satisfies NodeDef[];
