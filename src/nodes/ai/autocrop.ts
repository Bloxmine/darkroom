/**
 * Smart Auto-Crop (ai.autoCrop): picks the best crop of a target aspect from a subject/saliency map
 * (U²-Net-p via ai.subjectMask's shared subjectMatte()) and faces (shared face analysis), scored in
 * autocrop-score.ts (rule of thirds, headroom, eyes on the upper third, no cut faces/subjects).
 * The crop SIZE depends only on params + input size (so `size()` can report it); the content only picks the
 * position, which travels to the shader as float32 bits in a tiny RGBA8 texture. Deterministic; cached by
 * input fingerprint.
 */
import { mpStatus } from '../../core/ai/mediapipe';
import { defineNode } from '../../core/registry';
import type { NodeDef, Params, PassContext, RawTex } from '../../core/types';
import { AI_COLOR } from './_shared';
import { bestCrop, CROP_ASPECTS, CROP_MODES, cropSize, targetAspect, type CropFace, type CropInput } from './autocrop-score';
import { analyzeFaces, texFingerprint } from './face-analysis';
import { fivePoints } from './face-geom';
import { subjectMatte } from './subject';

const aspectOf = (p: Params, W: number, H: number) => targetAspect(String(p.aspect ?? '4:5'), W, H, Number(p.customW) || 1, Number(p.customH) || 1);
const sizeOf = (p: Params, W: number, H: number) => cropSize(W, H, aspectOf(p, W, H), Number(p.zoom) || 0);

function floats(v: number[]): RawTex {
  return { width: v.length, height: 1, data: new Uint8Array(new Float32Array(v).buffer), filter: 'nearest' };
}

/** Bilinear resample of the .r of a RawTex to sw×sh. */
function gridOf(m: RawTex, sw: number, sh: number): Float32Array {
  const out = new Float32Array(sw * sh);
  const k = m.data instanceof Uint8Array ? 1 / 255 : 1;
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const fx = Math.min(m.width - 1, Math.max(0, ((x + 0.5) / sw) * m.width - 0.5));
      const fy = Math.min(m.height - 1, Math.max(0, ((y + 0.5) / sh) * m.height - 0.5));
      const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(m.width - 1, x0 + 1), y1 = Math.min(m.height - 1, y0 + 1);
      const a = fx - x0, b = fy - y0;
      const v = (xx: number, yy: number) => m.data[(yy * m.width + xx) * 4] * k;
      out[y * sw + x] = (v(x0, y0) * (1 - a) + v(x1, y0) * a) * (1 - b) + (v(x0, y1) * (1 - a) + v(x1, y1) * a) * b;
    }
  }
  return out;
}

const memo = new Map<string, Promise<[number, number]>>();

async function analyse(src: RawTex, fullW: number, fullH: number, p: Params): Promise<[number, number]> {
  const W = src.width, H = src.height;
  const [matte, A] = await Promise.all([
    subjectMatte(src, 'object').catch((e) => (console.warn('[darkroom ai] auto-crop: no saliency', e), null)),
    analyzeFaces(src, 0.5).catch((e) => (console.warn('[darkroom ai] auto-crop: no faces', e), null)),
  ]);
  const sw = W >= H ? 64 : Math.max(8, Math.round((64 * W) / H)), sh = H > W ? 64 : Math.max(8, Math.round((64 * H) / W));
  const sal = matte ? gridOf(matte, sw, sh) : new Float32Array(sw * sh);
  const faces: CropFace[] = [];
  for (const f of A?.faces ?? []) faces.push({ box: f.box, eyeY: fivePoints(f, 1, 1).slice(0, 2).reduce((s, q) => s + q[1] / 2, 0) });
  for (const e of A?.extra ?? []) faces.push({ box: e.box, eyeY: (e.kps[0][1] + e.kps[1][1]) / 2 });
  // faces are always salient (and their whole head)
  for (const f of faces) {
    const [a, b, c, d] = f.box;
    const top = b - (d - b) * 0.35;
    for (let y = Math.max(0, Math.floor(top * sh)); y < Math.min(sh, Math.ceil(d * sh)); y++)
      for (let x = Math.max(0, Math.floor(a * sw)); x < Math.min(sw, Math.ceil(c * sw)); x++) sal[y * sw + x] = 1;
  }
  const mode = String(p.mode ?? 'subject');
  if (mode === 'faces' && !faces.length) mpStatus('Smart Auto-Crop: no faces found; cropping on the subject.');
  const inp: CropInput = { sal, sw, sh, faces };
  const [cw, ch] = sizeOf(p, fullW, fullH);
  const fw = cw / fullW, fh = ch / fullH;
  const r = bestCrop(inp, fw, fh, mode === 'faces' && !faces.length ? 'subject' : mode, Number(p.padding) || 0);
  // position as a fraction of the slack, so the GPU pass can recompute the exact size at any scale
  return [fw < 1 ? r.x / (1 - fw) : 0.5, fh < 1 ? r.y / (1 - fh) : 0.5];
}

/** Crop size (normalised) for a pass, from params + the full-res input size. */
function cs(ctx: PassContext): [number, number] {
  const s = ctx.inputSizes.image ?? { width: ctx.width, height: ctx.height };
  const W = Math.max(1, Math.round(s.width / ctx.scale)), H = Math.max(1, Math.round(s.height / ctx.scale));
  const [cw, ch] = sizeOf(ctx.params, W, H);
  return [cw / W, ch / H];
}

const autoCrop = defineNode({
  id: 'ai.autoCrop',
  name: 'Smart Auto-Crop',
  category: 'AI',
  color: AI_COLOR,
  description:
    'Crops to an aspect ratio (4:5, 1:1, 16:9, 9:16…) where it looks best: keeps the main subject (U²-Net-p saliency) and faces whole, gives heads some headroom, ' +
    'puts eyes near the upper third, follows the rule of thirds, and avoids cutting through people. Zoom tightens the crop; padding keeps the subject away from the edges. ' +
    '“Show crop overlay” shows the chosen rectangle on the full image instead of cropping. Runs locally (models download once); deterministic and cached per image.',
  tags: ['crop', 'auto crop', 'smart crop', 'reframe', 'instagram', 'aspect', 'composition', 'rule of thirds', 'portrait', 'faces', 'ai', 'ml'],
  inputs: { image: { type: 'image', label: 'Image' } },
  params: {
    aspect: { type: 'enum', default: '4:5', options: CROP_ASPECTS, label: 'Aspect' },
    customW: { type: 'float', default: 3, min: 0.1, max: 100, step: 0.1, label: 'Custom ratio W' },
    customH: { type: 'float', default: 2, min: 0.1, max: 100, step: 0.1, label: 'Custom ratio H' },
    zoom: { type: 'float', default: 0, min: 0, max: 1, step: 0.01, label: 'Zoom', description: '0 = the largest crop of that aspect, 1 = 40 % of it (tighter).' },
    mode: { type: 'enum', default: 'subject', options: CROP_MODES, label: 'Mode', description: 'subject: keep the subject centred & whole; faces: headroom and eyes on the upper third; thirds: place the subject on a thirds point.' },
    padding: { type: 'float', default: 0.05, min: 0, max: 0.3, step: 0.01, label: 'Padding', description: 'Margin (fraction of the crop) the subject should stay out of.' },
    showOverlay: { type: 'bool', default: false, label: 'Show crop overlay' },
  },
  size: ({ params, inputSizes, projectSize }) => {
    const s = inputSizes.image ?? projectSize;
    return params.showOverlay ? [s.width, s.height] : sizeOf(params, s.width, s.height);
  },
  cpuReadsInputs: true,
  cpu: async (ctx) => {
    const src = ctx.readInput('image');
    if (!src) return { pos: floats([0.5, 0.5]) };
    const fullW = Math.round(src.width / ctx.scale), fullH = Math.round(src.height / ctx.scale);
    const fp = texFingerprint(src);
    const p = ctx.params;
    // the overlay toggle does not change the choice
    const key = [Array.from(fp).join(','), fullW, fullH, p.aspect, p.customW, p.customH, p.zoom, p.mode, p.padding].join('|');
    let r = memo.get(key);
    if (!r) {
      r = analyse(src, fullW, fullH, p);
      r.catch(() => memo.delete(key));
      memo.set(key, r);
      if (memo.size > 32) memo.delete(memo.keys().next().value!);
    }
    return { pos: floats(await r) };
  },
  passes: [
    {
      uniforms: (ctx) => ({ u_cs: cs(ctx) }),
      frag: /* glsl */ `
uniform vec2 u_cs;
float rdF(int i) {
  uvec4 b = uvec4(round(texelFetch(u_pos, ivec2(i, 0), 0) * 255.0));
  return uintBitsToFloat(b.r | (b.g << 8) | (b.b << 16) | (b.a << 24));
}
void main() {
  vec2 off = vec2(rdF(0), rdF(1)) * (1.0 - u_cs);
  if (!u_showOverlay) { fragColor = texture(u_image, off + v_uv * u_cs); return; }
  vec4 c = texture(u_image, v_uv);
  vec2 q = (v_uv - off) / u_cs;
  bool inside = all(greaterThanEqual(q, vec2(0.0))) && all(lessThanEqual(q, vec2(1.0)));
  vec3 col = inside ? c.rgb : c.rgb * 0.3;
  // rectangle border + thirds guides, in output pixels
  vec2 cropPx = u_cs * u_resolution;
  vec2 d = min(abs(q), abs(q - 1.0)) * cropPx;
  float lw = max(1.5, 3.0 * u_scale * u_resolution.x / max(u_resolution.x, 1.0));
  float border = inside ? 1.0 - smoothstep(lw - 0.5, lw + 0.5, min(d.x, d.y)) : 0.0;
  vec2 t = min(abs(q - 1.0 / 3.0), abs(q - 2.0 / 3.0)) * cropPx;
  float guide = inside ? 1.0 - smoothstep(0.5, 1.5, min(t.x, t.y)) : 0.0;
  col = mix(col, vec3(1.0), guide * 0.45);
  col = mix(col, vec3(1.0, 0.85, 0.2), border);
  fragColor = vec4(col, c.a);
}`,
    },
  ],
});

export default [autoCrop] satisfies NodeDef[];
