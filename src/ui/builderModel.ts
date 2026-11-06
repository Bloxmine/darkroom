import { paramToAnnotation, parseParams, type ParamParseError } from '../core/glslParams';
import type { ParamDef, PortType, SerializedNodeDef, SerializedPass } from '../core/types';

/** Editable form of a custom node type (Node Builder). */
export interface BuilderInput {
  name: string;
  type: PortType;
  optional: boolean;
}

export interface BuilderPass {
  code: string;
  sizeMode: 'same' | 'scale';
  scale: number;
  filter: 'linear' | 'nearest';
  /** '' = once; a number or an int param key. */
  repeat: string;
  /** Preserved fixed size from imported JSON (not editable here). */
  fixed?: { width?: number; height?: number };
}

export interface BuilderForm {
  id: string;
  name: string;
  category: string;
  description: string;
  inputs: BuilderInput[];
  passes: BuilderPass[];
}

export const newPass = (code: string, over: Partial<BuilderPass> = {}): BuilderPass => ({ code, sizeMode: 'same', scale: 0.5, filter: 'linear', repeat: '', ...over });

/** Parse the form's @param annotations. */
export function formParams(f: BuilderForm): { params: Record<string, ParamDef>; perPass: ParamParseError[][]; lines: Record<string, number> } {
  const r = parseParams(
    f.passes.map((p) => p.code),
    { inputs: f.inputs.map((i) => i.name) },
  );
  return { params: r.params, perPass: r.perPass, lines: r.lines };
}

/** Form → JSON node def (frags keep their annotations; they're stripped on load). */
export function formToSerialized(f: BuilderForm): SerializedNodeDef {
  const { params } = formParams(f);
  const inputs: SerializedNodeDef['inputs'] = {};
  for (const i of f.inputs) {
    const name = i.name.trim();
    if (!name) continue;
    inputs[name] = { type: i.type, ...(i.optional ? { optional: true } : {}) };
  }
  const passes: SerializedPass[] = f.passes.map((p) => {
    const sp: SerializedPass = { frag: p.code };
    if (p.sizeMode === 'scale' && p.scale > 0 && p.scale !== 1) sp.size = { scale: p.scale };
    else if (p.fixed) sp.size = { ...p.fixed };
    if (p.filter === 'nearest') sp.filter = 'nearest';
    const r = p.repeat.trim();
    if (r) sp.repeat = /^\d+$/.test(r) ? Number(r) : r;
    return sp;
  });
  const s: SerializedNodeDef = { id: f.id.trim(), name: f.name.trim(), category: f.category.trim() || 'Custom', inputs, params, passes };
  if (f.description.trim()) s.description = f.description.trim();
  return s;
}

/** JSON node def → form. Params without an annotation get one inserted at the top of pass 0. */
export function serializedToForm(s: SerializedNodeDef): BuilderForm {
  const passes = s.passes.map((p) =>
    newPass(p.frag, {
      sizeMode: p.size?.scale !== undefined ? 'scale' : 'same',
      scale: p.size?.scale ?? 0.5,
      fixed: p.size && p.size.scale === undefined ? { width: p.size.width, height: p.size.height } : undefined,
      filter: p.filter ?? 'linear',
      repeat: p.repeat !== undefined ? String(p.repeat) : '',
    }),
  );
  const annotated = parseParams(passes.map((p) => p.code)).params;
  const missing = Object.entries(s.params)
    .filter(([k]) => !annotated[k])
    .map(([k, d]) => paramToAnnotation(k, d))
    .filter((x): x is string => !!x);
  if (missing.length && passes[0]) passes[0].code = missing.join('\n') + '\n' + passes[0].code;
  return {
    id: s.id,
    name: s.name,
    category: s.category,
    description: s.description ?? '',
    inputs: Object.entries(s.inputs).map(([name, p]) => ({ name, type: p.type, optional: !!p.optional })),
    passes,
  };
}

// ---------------------------------------------------------------------------
// Starter templates
// ---------------------------------------------------------------------------

const INVERT = `// Invert — the simplest possible node.
// Declare knobs with @param annotations; the builder turns them into
// parameters and the engine declares the uniforms for you.
uniform float u_amount;   // @param min=0 max=1 default=1 label="Amount"
uniform bool  u_keepLuma; // @param default=false label="Keep luminance"

void main() {
  vec4 c = texture(u_image, v_uv);
  vec3 inv = 1.0 - c.rgb;
  if (u_keepLuma) inv += luma(c.rgb) - luma(inv);
  fragColor = vec4(mix(c.rgb, inv, u_amount), c.a);
}
`;

const BLEND = `// Two-input blend with an optional mask.
uniform int   u_mode;    // @param enum=normal|multiply|screen|overlay|softLight|difference default=overlay label="Mode"
uniform float u_opacity; // @param min=0 max=1 default=1 label="Opacity"
uniform vec2  u_offset;  // @param default=0,0 step=0.005 label="Offset"
uniform vec4  u_tint;    // @param color default=#ffffff label="Tint"

void main() {
  vec4 a = texture(u_base, v_uv);
  vec4 b = texClamp(u_blend, v_uv - u_offset) * u_tint;
  vec3 r = b.rgb;
  if (u_mode == 1) r = blendMultiply(a.rgb, b.rgb);
  else if (u_mode == 2) r = blendScreen(a.rgb, b.rgb);
  else if (u_mode == 3) r = blendOverlay(a.rgb, b.rgb);
  else if (u_mode == 4) r = blendSoftLight(a.rgb, b.rgb);
  else if (u_mode == 5) r = abs(a.rgb - b.rgb);
  float m = texture(u_mask, v_uv).r * b.a * u_opacity; // unconnected mask = white
  fragColor = vec4(mix(a.rgb, r, m), a.a);
}
`;

const BLUR_H = `// Pass 0: horizontal gaussian at half resolution (see Size).
uniform float u_radius; // @param min=0 max=150 default=16 pixels label="Radius"
uniform float u_glow;   // @param min=0 max=2 default=0 label="Glow"

void main() {
  float r = max(u_radius * u_scale, 0.5);   // pixels at the current render scale
  float sigma = r * 0.5;
  vec2 dir = vec2(1.0 / u_image_size.x, 0.0);
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  for (int i = -24; i <= 24; i++) {
    float x = float(i) * r / 24.0;
    float w = exp(-0.5 * x * x / (sigma * sigma));
    acc += texture(u_image, v_uv + dir * x) * w;
    wsum += w;
  }
  fragColor = acc / wsum;
}
`;

const BLUR_V = `// Pass 1: vertical, reading the previous pass (u_prev = u_pass0).
// Params are available in every pass without re-declaring them.
void main() {
  float r = max(u_radius * u_scale, 0.5);
  float sigma = r * 0.5;
  vec2 dir = vec2(0.0, 1.0 / u_resolution.y);
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  for (int i = -24; i <= 24; i++) {
    float x = float(i) * r / 24.0;
    float w = exp(-0.5 * x * x / (sigma * sigma));
    acc += texture(u_prev, v_uv + dir * x) * w;
    wsum += w;
  }
  vec4 blurred = acc / wsum;
  vec4 src = texture(u_image, v_uv);
  // optional "glow": screen the blur over the original
  fragColor = mix(blurred, vec4(blendScreen(src.rgb, blurred.rgb * u_glow), src.a), step(0.001, u_glow));
}
`;

export const TEMPLATES: { id: string; label: string; form: () => BuilderForm }[] = [
  {
    id: 'invert',
    label: 'Invert',
    form: () => ({
      id: 'user.invert',
      name: 'My Invert',
      category: 'Custom',
      description: 'Inverts colours, optionally keeping luminance.',
      inputs: [{ name: 'image', type: 'image', optional: false }],
      passes: [newPass(INVERT)],
    }),
  },
  {
    id: 'blend',
    label: 'Two-input blend',
    form: () => ({
      id: 'user.blend',
      name: 'My Blend',
      category: 'Custom',
      description: 'Blends two images with a mode, opacity, offset and optional mask.',
      inputs: [
        { name: 'base', type: 'image', optional: false },
        { name: 'blend', type: 'image', optional: false },
        { name: 'mask', type: 'mask', optional: true },
      ],
      passes: [newPass(BLEND)],
    }),
  },
  {
    id: 'blur',
    label: 'Two-pass blur',
    form: () => ({
      id: 'user.softBlur',
      name: 'Soft Blur',
      category: 'Custom',
      description: 'Separable gaussian: a half-resolution horizontal pass, then a vertical pass.',
      inputs: [{ name: 'image', type: 'image', optional: false }],
      passes: [newPass(BLUR_H, { sizeMode: 'scale', scale: 0.5 }), newPass(BLUR_V)],
    }),
  },
];

/** Parse "ERROR: 0:12: 'foo' : undeclared identifier" style logs → line + message. */
export function parseCompileLog(log: string): { line: number; message: string }[] {
  const out: { line: number; message: string }[] = [];
  for (const raw of log.split('\n')) {
    const m = /^\s*(?:ERROR|WARNING):\s*\d+:(\d+):\s*(.*)$/.exec(raw);
    if (m) out.push({ line: Number(m[1]), message: m[2].trim() });
    else if (raw.trim() && !/^\s*$/.test(raw)) out.push({ line: 0, message: raw.trim() });
  }
  return out;
}
