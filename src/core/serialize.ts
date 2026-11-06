import { parseParams, stripParamUniforms } from './glslParams';
import type { NodeDef, ParamDef, PassContext, PortDef, SerializedNodeDef, SerializedPass, ShaderPass } from './types';

/**
 * JSON (de)serialisation of node definitions: custom nodes from the Node
 * Builder, data plugins and nodes embedded in project files.
 *
 * The serialised form has string frags and no functions. Pass size is
 * declarative ({scale} or {width,height}), `repeat` a number or param key.
 */

export const NODE_FILE_FORMAT = 'darkroom-node';
export const NODE_FILE_EXT = '.drnode.json';

/** The `.drnode.json` wrapper. */
export interface NodeFile {
  format: typeof NODE_FILE_FORMAT;
  version: 1;
  node: SerializedNodeDef;
}

export class NotSerializableError extends Error {}

/** Original serialised form of every def created by deserializeNodeDef (exact round trip). */
const origin = new WeakMap<NodeDef, SerializedNodeDef>();

const ID_RE = /^[A-Za-z][\w-]*(\.[A-Za-z_][\w-]*)+$/;
const IDENT_RE = /^[A-Za-z_]\w*$/;
const PARAM_TYPES = new Set<ParamDef['type']>(['float', 'int', 'bool', 'color', 'vec2', 'enum', 'string', 'asset', 'curve']);
const RESERVED_INPUTS = new Set(['prev', 'resolution', 'scale', 'time', 'iteration']);

export const isValidNodeId = (id: string) => ID_RE.test(id);

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

function validatePort(name: string, p: unknown, what: string): PortDef {
  if (!IDENT_RE.test(name)) throw new Error(`${what} "${name}" is not a valid identifier`);
  if (!isObj(p)) throw new Error(`${what} "${name}" must be an object`);
  if (p.type !== 'image' && p.type !== 'mask') throw new Error(`${what} "${name}": type must be "image" or "mask"`);
  const out: PortDef = { type: p.type };
  if (typeof p.label === 'string') out.label = p.label;
  if (p.optional) out.optional = true;
  if (p.fallback && ['black', 'white', 'transparent', 'gray'].includes(p.fallback as string)) out.fallback = p.fallback as PortDef['fallback'];
  return out;
}

function validateParam(key: string, p: unknown): ParamDef {
  if (!IDENT_RE.test(key)) throw new Error(`param "${key}" is not a valid identifier`);
  if (!isObj(p)) throw new Error(`param "${key}" must be an object`);
  if (!PARAM_TYPES.has(p.type as ParamDef['type'])) throw new Error(`param "${key}": unknown type "${String(p.type)}"`);
  if (!('default' in p)) throw new Error(`param "${key}": missing default`);
  const t = p.type as ParamDef['type'];
  const d = p.default;
  const bad = () => new Error(`param "${key}": default ${JSON.stringify(d)} does not fit type ${t}`);
  if ((t === 'float' || t === 'int') && typeof d !== 'number') throw bad();
  if (t === 'bool' && typeof d !== 'boolean') throw bad();
  if (t === 'color' && !(Array.isArray(d) && d.length >= 3 && d.every((x) => typeof x === 'number'))) throw bad();
  if (t === 'vec2' && !(Array.isArray(d) && d.length === 2 && d.every((x) => typeof x === 'number'))) throw bad();
  if (t === 'enum') {
    if (!Array.isArray(p.options) || !p.options.length || !p.options.every((o) => typeof o === 'string')) throw new Error(`param "${key}": enum needs string options`);
    if (!(p.options as unknown[]).includes(d)) throw bad();
  }
  if ((t === 'string' || t === 'asset') && typeof d !== 'string') throw bad();
  return structuredClone(p) as unknown as ParamDef;
}

function validatePass(p: unknown, i: number, paramKeys: Set<string>): SerializedPass {
  if (!isObj(p)) throw new Error(`pass ${i} must be an object`);
  if (typeof p.frag !== 'string' || !p.frag.trim()) throw new Error(`pass ${i}: frag must be a non-empty GLSL string`);
  const out: SerializedPass = { frag: p.frag };
  if (p.size !== undefined) {
    if (!isObj(p.size)) throw new Error(`pass ${i}: size must be {scale} or {width,height}`);
    const s: SerializedPass['size'] = {};
    for (const k of ['scale', 'width', 'height'] as const) {
      const v = p.size[k];
      if (v === undefined) continue;
      if (typeof v !== 'number' || !(v > 0)) throw new Error(`pass ${i}: size.${k} must be a positive number`);
      s[k] = v;
    }
    out.size = s;
  }
  if (p.filter !== undefined) {
    if (p.filter !== 'linear' && p.filter !== 'nearest') throw new Error(`pass ${i}: filter must be linear|nearest`);
    out.filter = p.filter;
  }
  if (p.output !== undefined) {
    if (typeof p.output !== 'string') throw new Error(`pass ${i}: output must be a string`);
    out.output = p.output;
  }
  if (p.repeat !== undefined) {
    if (typeof p.repeat === 'number') {
      if (!(p.repeat >= 1)) throw new Error(`pass ${i}: repeat must be ≥ 1`);
    } else if (typeof p.repeat !== 'string' || !paramKeys.has(p.repeat)) throw new Error(`pass ${i}: repeat must be a number or a param key`);
    out.repeat = p.repeat;
  }
  return out;
}

/** Validate untrusted JSON as a SerializedNodeDef. Throws an Error describing the first problem. */
export function validateSerializedNodeDef(x: unknown): SerializedNodeDef {
  if (!isObj(x)) throw new Error('node definition must be an object');
  const id = x.id;
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error(`invalid node id ${JSON.stringify(id)} (use a namespaced id like "user.myEffect")`);
  const at = (e: unknown) => new Error(`${id}: ${(e as Error).message}`);
  try {
    if (typeof x.name !== 'string' || !x.name.trim()) throw new Error('name is required');
    if (typeof x.category !== 'string' || !x.category.trim()) throw new Error('category is required');
    if (!isObj(x.inputs)) throw new Error('inputs must be an object');
    if (!isObj(x.params)) throw new Error('params must be an object');
    if (!Array.isArray(x.passes) || !x.passes.length) throw new Error('at least one pass is required');
    const inputs: Record<string, PortDef> = {};
    for (const [k, v] of Object.entries(x.inputs)) {
      if (RESERVED_INPUTS.has(k) || /^pass\d+$/.test(k)) throw new Error(`input name "${k}" is reserved`);
      inputs[k] = validatePort(k, v, 'input');
    }
    const params: Record<string, ParamDef> = {};
    for (const [k, v] of Object.entries(x.params)) {
      if (k in inputs) throw new Error(`param "${k}" has the same name as an input`);
      params[k] = validateParam(k, v);
    }
    // `@param` annotations in the GLSL fill in params the JSON doesn't list (explicit params win)
    const annotated = parseParams(
      x.passes.map((p) => (isObj(p) && typeof p.frag === 'string' ? p.frag : '')),
      { inputs: Object.keys(inputs) },
    );
    for (const [k, d] of Object.entries(annotated.params)) if (!(k in params)) params[k] = d;
    const keys = new Set(Object.keys(params));
    const out: SerializedNodeDef = {
      id,
      name: x.name,
      category: x.category,
      inputs,
      params,
      passes: x.passes.map((p, i) => validatePass(p, i, keys)),
    };
    if (x.outputs !== undefined) {
      if (!isObj(x.outputs) || !Object.keys(x.outputs).length) throw new Error('outputs must be a non-empty object');
      out.outputs = Object.fromEntries(Object.entries(x.outputs).map(([k, v]) => [k, validatePort(k, v, 'output')]));
    }
    if (typeof x.description === 'string') out.description = x.description;
    if (Array.isArray(x.tags)) out.tags = x.tags.filter((t): t is string => typeof t === 'string');
    if (typeof x.color === 'string') out.color = x.color;
    if (x.hidden === true) out.hidden = true;
    return out;
  } catch (e) {
    throw at(e);
  }
}

function passSize(s: NonNullable<SerializedPass['size']>) {
  return (ctx: PassContext): [number, number] => {
    if (s.scale !== undefined) return [Math.max(1, Math.round(ctx.width * s.scale)), Math.max(1, Math.round(ctx.height * s.scale))];
    const w = s.width !== undefined ? s.width * ctx.scale : ctx.width;
    const h = s.height !== undefined ? s.height * ctx.scale : ctx.height;
    return [Math.max(1, Math.round(w)), Math.max(1, Math.round(h))];
  };
}

/** Turn a (validated) serialised def into a runtime NodeDef. */
export function deserializeNodeDef(input: SerializedNodeDef): NodeDef {
  const s = validateSerializedNodeDef(input);
  const keys = Object.keys(s.params);
  const passes: ShaderPass[] = s.passes.map((p) => {
    const pass: ShaderPass = { frag: stripParamUniforms(p.frag, keys) };
    if (p.size && Object.keys(p.size).length) pass.size = passSize(p.size);
    if (p.filter) pass.filter = p.filter;
    if (p.output) pass.output = p.output;
    if (p.repeat !== undefined) {
      const r = p.repeat;
      pass.repeat =
        typeof r === 'number'
          ? () => Math.min(256, r)
          : (ctx) => Math.max(1, Math.min(256, Math.round(Number(ctx.params[r] ?? s.params[r]?.default ?? 1))));
    }
    return pass;
  });
  const def: NodeDef = {
    id: s.id,
    name: s.name,
    category: s.category,
    inputs: s.inputs,
    params: s.params,
    passes,
  };
  if (s.outputs) def.outputs = s.outputs;
  if (s.description) def.description = s.description;
  if (s.tags) def.tags = s.tags;
  if (s.color) def.color = s.color;
  if (s.hidden) def.hidden = true;
  origin.set(def, s);
  return def;
}

/** True if `def` can be written to JSON (it came from JSON, or has no functions). */
export function isSerializable(def: NodeDef): boolean {
  if (origin.has(def)) return true;
  try {
    serializeNodeDef(def);
    return true;
  } catch {
    return false;
  }
}

/** NodeDef → JSON form. Throws NotSerializableError for code-defined behaviour (cpu, size functions…). */
export function serializeNodeDef(def: NodeDef): SerializedNodeDef {
  const o = origin.get(def);
  if (o) return structuredClone(o);
  const fail = (why: string) => {
    throw new NotSerializableError(`${def.id} cannot be saved as JSON: ${why}`);
  };
  if (def.cpu) fail('it has a CPU step');
  if (def.size) fail('it has a size function');
  if (!def.passes?.length) fail('it has no passes');
  const passes: SerializedPass[] = def.passes!.map((p, i) => {
    if (typeof p.frag !== 'string') fail(`pass ${i} frag is a function`);
    if (p.size || p.uniforms || p.repeat) fail(`pass ${i} uses size/uniforms/repeat functions`);
    const sp: SerializedPass = { frag: p.frag as string };
    if (p.filter) sp.filter = p.filter;
    if (p.output) sp.output = p.output;
    return sp;
  });
  const out: SerializedNodeDef = {
    id: def.id,
    name: def.name,
    category: def.category,
    inputs: structuredClone(def.inputs),
    params: structuredClone(def.params),
    passes,
  };
  if (def.outputs) out.outputs = structuredClone(def.outputs);
  if (def.description) out.description = def.description;
  if (def.tags) out.tags = [...def.tags];
  if (def.color) out.color = def.color;
  if (def.hidden) out.hidden = true;
  return validateSerializedNodeDef(out);
}

/** Wrap for a `.drnode.json` file. */
export function toNodeFile(s: SerializedNodeDef): string {
  const f: NodeFile = { format: NODE_FILE_FORMAT, version: 1, node: s };
  return JSON.stringify(f, null, 2);
}

/** Parse a `.drnode.json` file (wrapped or bare). */
export function parseNodeFile(text: string): SerializedNodeDef {
  let x: unknown;
  try {
    x = JSON.parse(text);
  } catch {
    throw new Error('not valid JSON');
  }
  if (isObj(x) && x.format === NODE_FILE_FORMAT) {
    if (x.version !== 1) throw new Error(`unsupported node file version ${String(x.version)}`);
    return validateSerializedNodeDef(x.node);
  }
  return validateSerializedNodeDef(x);
}

/** Stable comparison of two serialised defs. */
export const sameSerialized = (a: SerializedNodeDef, b: SerializedNodeDef) => JSON.stringify(a) === JSON.stringify(b);
