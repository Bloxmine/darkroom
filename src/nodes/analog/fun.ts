import { defineNode } from '../../core/registry';
import type { NodeDef } from '../../core/types';
import { F } from './_shared';

const C = '#7cf29c';
const img = { image: { type: 'image' as const } };

const glitch = defineNode({
  id: 'analog.glitch',
  name: 'Digital Glitch',
  category: 'Analog',
  color: C,
  description:
    'Broken digital video / datamosh: horizontal slice tearing, macroblocks displaced along bogus motion vectors, blocks melting downwards, ' +
    'corrupted chroma (green/magenta) blocks and an RGB split.',
  tags: ['glitch', 'datamosh', 'corrupt', 'blocks', 'rgb split', 'digital', 'error'],
  inputs: img,
  params: {
    amount: { type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Amount' },
    blockSize: { type: 'float', default: 16, min: 4, max: 256, step: 1, pixels: true, label: 'Macroblock size' },
    slices: { type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, label: 'Slice tearing' },
    displace: { type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, label: 'Block displacement' },
    melt: { type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Datamosh melt' },
    corrupt: { type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Colour corruption' },
    rgbSplit: { type: 'float', default: 8, min: 0, max: 100, step: 0.5, pixels: true, label: 'RGB split' },
    seed: { type: 'int', default: 42, min: 0, max: 9999, step: 1, label: 'Seed' },
  },
  passes: [{
    frag: F(`
void main() {
  vec2 px = pixelCoord();
  float bs = max(u_blockSize * u_scale, 2.0);
  float sd = float(u_seed) * 1.618;
  float A = u_amount;
  vec2 uv = v_uv;
  float glitched = 0.0;
  // slice tearing at two scales
  for (int k = 0; k < 2; k++) {
    float rows = k == 0 ? 9.0 : 41.0;
    float id = floor(v_uv.y * rows + hash11(sd + float(k)) * 3.0);
    float h = hash12(vec2(id, sd + float(k) * 7.0));
    if (h < A * u_slices * (k == 0 ? 0.35 : 0.25)) {
      uv.x += (hash12(vec2(id, sd + 3.0)) - 0.5) * (k == 0 ? 0.25 : 0.08);
      glitched = 1.0;
    }
  }
  // macroblocks (groups of 2..4 blocks) with bogus motion vectors
  vec2 mb = floor(px / (bs * 2.0));
  float hm = hash12(mb + sd * 3.1);
  vec2 cell = floor(px / bs);
  if (hm < A * u_displace * 0.3) {
    vec2 mv = floor((hash22(mb + sd) - 0.5) * 8.0) * bs;
    uv += mv / u_resolution;
    glitched = 1.0;
  }
  // melt: blocks repeat their top row downward (missing residuals)
  vec2 mcol = vec2(floor(px.x / bs), floor(px.y / (bs * 6.0)));
  if (hash12(mcol + sd * 5.3) < A * u_melt * 0.25) {
    float top = mcol.y * bs * 6.0 + hash12(mcol + sd) * bs;
    uv.y = mix(uv.y, top / u_resolution.y, 0.92);
    glitched = 1.0;
  }
  float split = u_rgbSplit * u_scale * (0.4 + glitched) * A / u_resolution.x;
  vec3 c = vec3(texClamp(u_image, uv + vec2(split, 0.0)).r, texClamp(u_image, uv).g, texClamp(u_image, uv - vec2(split, 0.0)).b);
  // colour corruption: flat blocks with broken chroma
  float hc = hash12(cell + sd * 9.7);
  if (hash12(floor(cell / 3.0) + sd * 4.1) < A * u_corrupt * 0.12 && hc < 0.7) {
    vec3 flatc = texClamp(u_image, (cell + 0.5) * bs / u_resolution).rgb;
    vec3 y = rgb2ycbcr(flatc);
    float mode = hash12(cell + sd);
    if (mode < 0.4) y.yz = vec2(0.25, 0.2);          // green slime
    else if (mode < 0.75) y.yz = vec2(0.75, 0.8);    // magenta
    else y.yz = y.zy;                                // swapped chroma
    c = ycbcr2rgb(y);
  }
  // occasional row of digital noise
  float nr = floor(px.y / max(bs * 0.25, 1.0));
  if (hash12(vec2(nr, sd + 77.0)) < A * 0.006) c = hash32(floor(px / max(bs * 0.25, 1.0)) + sd);
  fragColor = vec4(clamp(c, 0.0, 1.0), texture(u_image, v_uv).a);
}`),
  }],
});

const thermal = defineNode({
  id: 'analog.thermal',
  name: 'Thermal Camera',
  category: 'Analog',
  color: C,
  description:
    'Maps a fake “temperature” to a thermal-camera palette. Temperature is estimated from brightness, with skin/warm colours biased hotter and blue sky colder. ' +
    'Optional HUD with crosshair and colour bar.',
  tags: ['thermal', 'flir', 'infrared', 'heat', 'ironbow', 'predator', 'false colour'],
  inputs: img,
  params: {
    palette: { type: 'enum', default: 'ironbow', options: ['ironbow', 'rainbow', 'whiteHot', 'blackHot', 'arctic'], label: 'Palette' },
    low: { type: 'float', default: 0.05, min: 0, max: 1, step: 0.01, label: 'Range low' },
    high: { type: 'float', default: 0.9, min: 0, max: 1, step: 0.01, label: 'Range high' },
    gamma: { type: 'float', default: 1, min: 0.2, max: 4, step: 0.01, label: 'Gamma' },
    warmBias: { type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Warm-colour bias', description: 'Treat skin/warm hues as hotter and blue as colder.' },
    skyCold: { type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, label: 'Bright sky is cold', description: 'Very bright, non-skin areas (sky, white walls) read as cold, like a real thermal camera.' },
    hud: { type: 'bool', default: true, label: 'HUD' },
  },
  passes: [{
    frag: F(`
vec3 ramp(float t, int p) {
  t = clamp(t, 0.0, 1.0);
  vec3 s[7];
  if (p == 0) { s = vec3[7](vec3(0.0, 0.0, 0.03), vec3(0.15, 0.0, 0.4), vec3(0.5, 0.0, 0.55), vec3(0.85, 0.12, 0.25), vec3(1.0, 0.45, 0.0), vec3(1.0, 0.8, 0.1), vec3(1.0, 1.0, 0.92)); }
  else if (p == 1) { s = vec3[7](vec3(0.0, 0.0, 0.1), vec3(0.0, 0.1, 0.9), vec3(0.0, 0.8, 0.9), vec3(0.1, 0.9, 0.1), vec3(1.0, 0.95, 0.0), vec3(1.0, 0.2, 0.0), vec3(1.0, 1.0, 1.0)); }
  else if (p == 4) { s = vec3[7](vec3(0.0, 0.0, 0.05), vec3(0.0, 0.05, 0.3), vec3(0.0, 0.25, 0.65), vec3(0.1, 0.55, 0.85), vec3(0.4, 0.8, 0.95), vec3(0.75, 0.95, 1.0), vec3(1.0)); }
  else { float g = p == 3 ? 1.0 - t : t; return vec3(g); }
  float x = t * 6.0; int i = int(min(floor(x), 5.0));
  return mix(s[i], s[i + 1], smoothstep(0.0, 1.0, x - float(i)));
}
void main() {
  vec4 src = texture(u_image, v_uv);
  vec3 c = clamp(src.rgb, 0.0, 1.0);
  float l = luma(c);
  float skin = smoothstep(0.02, 0.08, c.r - c.g) * smoothstep(0.01, 0.06, c.g - c.b) * (1.0 - smoothstep(0.3, 0.45, c.r - c.b)) * smoothstep(0.08, 0.25, l) * (1.0 - smoothstep(0.85, 0.97, l));
  float blue = smoothstep(0.0, 0.2, c.b - c.r);
  float heat = mix(l, 0.2 + 0.45 * l, u_warmBias);
  heat += u_warmBias * 0.65 * skin;
  heat -= u_warmBias * 0.3 * blue;
  heat -= u_skyCold * 0.45 * smoothstep(0.7, 0.98, l) * (1.0 - skin);
  float t = pow(clamp((heat - u_low) / max(u_high - u_low, 1e-3), 0.0, 1.0), u_gamma);
  vec3 o = ramp(t, u_palette);
  if (u_hud) {
    vec2 px = pixelCoord();
    float s = u_resolution.y / 600.0;
    vec2 d = abs(px - u_resolution * 0.5);
    float cross_ = (d.x < 1.0 * s && d.y < 18.0 * s && d.y > 5.0 * s) || (d.y < 1.0 * s && d.x < 18.0 * s && d.x > 5.0 * s) ? 1.0 : 0.0;
    o = mix(o, vec3(1.0), cross_);
    // colour bar on the right
    vec2 b0 = vec2(u_resolution.x - 40.0 * s, u_resolution.y * 0.2);
    vec2 b1 = vec2(u_resolution.x - 28.0 * s, u_resolution.y * 0.8);
    if (px.x > b0.x && px.x < b1.x && px.y > b0.y && px.y < b1.y) o = ramp(1.0 - (px.y - b0.y) / (b1.y - b0.y), u_palette);
    if (px.x > b0.x - 2.0 * s && px.x < b1.x + 2.0 * s && px.y > b0.y - 2.0 * s && px.y < b1.y + 2.0 * s && !(px.x > b0.x && px.x < b1.x && px.y > b0.y && px.y < b1.y)) o = vec3(1.0);
  }
  fragColor = vec4(o, src.a);
}`),
  }],
});

export default [glitch, thermal] satisfies NodeDef[];
