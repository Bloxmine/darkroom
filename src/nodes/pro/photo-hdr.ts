/**
 * Merge HDR: bracketed exposures → one scene-linear radiance image (Debevec & Malik 1997 hat
 * weighting), with optional phase-correlation alignment and reference-based deghosting.
 */
import { setNodeInfo } from '../../core/nodeInfo';
import { defineNode } from '../../core/registry';
import type { NodeDef, PortDef } from '../../core/types';
import { num } from '../library/shared';
import { alignImage, phaseCorrelate } from './photo-math';

const C = '#7a9a4a';
const N_IN = 5;
const EV_DEFAULTS = [0, -2, 2, -4, 4];

const inputs: Record<string, PortDef> = {};
for (let i = 0; i < N_IN; i++) inputs['img' + i] = { type: 'image', label: i === 0 ? 'Reference (ev0)' : `Exposure ${i + 1}`, optional: i > 0 };

const params: NodeDef['params'] = {};
for (let i = 0; i < N_IN; i++) params['ev' + i] = { type: 'float', default: EV_DEFAULTS[i], min: -10, max: 10, step: 0.1, label: `EV ${i === 0 ? 'reference' : 'input ' + (i + 1)}`, description: 'Exposure of this frame relative to the scene (e.g. −2, 0, +2).' };

/** Per-input radiance + weight, shared by the merge pass. */
const MERGE = /* glsl */ `
float hatW(float z) { const float lo = 0.02, hi = 0.98; return z <= lo || z >= hi ? 0.0 : (z <= 0.5 ? (z - lo) / (0.5 - lo) : (hi - z) / (hi - 0.5)); }
vec4 fetchIn(int i, vec2 uv) {
  if (i == 0) return texClamp(u_img0, uv);
  if (i == 1) return texClamp(u_img1, uv);
  if (i == 2) return texClamp(u_img2, uv);
  if (i == 3) return texClamp(u_img3, uv);
  return texClamp(u_img4, uv);
}
bool connected(int i) {
  if (i == 0) return true;
  if (i == 1) return u_img1_size.x > 1.5;
  if (i == 2) return u_img2_size.x > 1.5;
  if (i == 3) return u_img3_size.x > 1.5;
  return u_img4_size.x > 1.5;
}
float evOf(int i) { return i == 0 ? u_ev0 : i == 1 ? u_ev1 : i == 2 ? u_ev2 : i == 3 ? u_ev3 : u_ev4; }
`;

const mergeHdr = defineNode({
  id: 'pro.mergeHdr',
  name: 'Merge HDR',
  category: 'Photo',
  color: C,
  description:
    'Merges 2–5 bracketed exposures (set each input\'s EV, e.g. −2 / 0 / +2) into one scene-linear HDR image: every frame is linearised and divided by its exposure, ' +
    'then averaged with a triangle weight that ignores clipped and noisy values (Debevec & Malik). Align corrects small hand-held shifts (phase correlation); ' +
    'Deghost uses the reference frame where the frames disagree (moving people, leaves). The output is LINEAR float data — follow it with Tone Map (Input is HDR on) or Exposure & White Balance (linear).',
  tags: ['hdr', 'merge', 'bracket', 'bracketing', 'exposure', 'debevec', 'radiance', 'deghost', 'align'],
  inputs,
  params: {
    ...params,
    align: { type: 'bool', default: true, label: 'Align frames' },
    deghost: { type: 'bool', default: true, label: 'Deghost' },
    ghostThreshold: { type: 'float', default: 0.6, min: 0.1, max: 3, step: 0.05, label: 'Ghost threshold (stops)', description: 'How much (in stops) a frame may disagree with the reference before it is ignored there.' },
  },
  cpuReadsInputs: true,
  cpu: (ctx) => {
    const shifts = new Float32Array(N_IN * 4);
    if (ctx.params.align !== false) {
      const N = 512;
      const ref = ctx.readInput('img0');
      if (ref) {
        const a = alignImage(ref, num(ctx.params, 'ev0', 0), N);
        const lines: string[] = [];
        for (let i = 1; i < N_IN; i++) {
          const t = ctx.readInput('img' + i);
          if (!t || t.width < 2) continue;
          const b = alignImage(t, num(ctx.params, 'ev' + i, EV_DEFAULTS[i]), N);
          const r = phaseCorrelate(a.img, b.img, N);
          // ignore weak peaks (no reliable match) and implausible shifts (> 8 % of the frame)
          const dx = (r.dx * a.sx) / ref.width, dy = (r.dy * a.sy) / ref.height;
          if (r.peak > 0.08 && Math.abs(dx) < 0.08 && Math.abs(dy) < 0.08) {
            shifts[i * 4] = dx;
            shifts[i * 4 + 1] = dy;
          }
          lines.push(`input ${i + 1}: ${(shifts[i * 4] * ref.width / ctx.scale).toFixed(1)}, ${(shifts[i * 4 + 1] * ref.height / ctx.scale).toFixed(1)} px`);
        }
        setNodeInfo(ctx.nodeId, { title: 'Alignment', text: lines.join('\n') || 'single frame', detail: 'Shift of each frame relative to the reference (full-resolution pixels).' });
      }
    } else setNodeInfo(ctx.nodeId, null);
    return { shiftTex: { width: N_IN, height: 1, data: shifts, filter: 'nearest' } };
  },
  passes: [{
    frag: /* glsl */ `
${MERGE}
void main() {
  vec2 sh[5];
  for (int i = 0; i < 5; i++) sh[i] = texelFetch(u_shiftTex, ivec2(i, 0), 0).rg;
  vec3 rad[5]; vec3 w[5];
  float n = 0.0;
  // reference radiance (for deghosting)
  for (int i = 0; i < 5; i++) {
    rad[i] = vec3(0.0); w[i] = vec3(0.0);
    if (!connected(i)) continue;
    vec3 z = clamp(fetchIn(i, v_uv + sh[i]).rgb, 0.0, 1.0);
    rad[i] = srgbToLinear(z) / exp2(evOf(i));
    w[i] = vec3(hatW(z.r), hatW(z.g), hatW(z.b));
    n += 1.0;
  }
  float lr = luma(rad[0]);
  float wr = min(w[0].r, min(w[0].g, w[0].b));
  vec3 num = vec3(0.0), den = vec3(0.0);
  for (int i = 0; i < 5; i++) {
    vec3 wi = w[i];
    if (u_deghost && i > 0 && wr > 0.05) {
      float wm = min(wi.r, min(wi.g, wi.b));
      float d = abs(log2(max(luma(rad[i]), 1e-5) / max(lr, 1e-5)));
      if (wm > 0.05 && d > u_ghostThreshold) wi = vec3(0.0);
    }
    num += wi * rad[i]; den += wi;
  }
  vec3 o;
  for (int c = 0; c < 3; c++) {
    if (den[c] > 1e-4) { o[c] = num[c] / den[c]; continue; }
    // every frame clipped (bright) or black: darkest / brightest connected frame
    bool bright = false; float sum = 0.0;
    for (int i = 0; i < 5; i++) if (connected(i)) sum += rad[i][c] * exp2(evOf(i)) > 0.2 ? 1.0 : 0.0;
    bright = sum > 0.0;
    int k = 0; float best = evOf(0);
    for (int i = 1; i < 5; i++) if (connected(i) && (bright ? evOf(i) < best : evOf(i) > best)) { best = evOf(i); k = i; }
    o[c] = rad[k][c];
  }
  fragColor = vec4(o, 1.0);
}`,
  }],
});

export default [mergeHdr] satisfies NodeDef[];
