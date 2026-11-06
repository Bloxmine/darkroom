import type { ParamDef, ParamValue } from './types';

/**
 * `@param` annotations: declare node parameters right in the GLSL.
 *
 *   uniform float u_amount;  // @param min=0 max=2 default=1 label="Amount"
 *   uniform int   u_steps;   // @param min=1 max=32 default=8
 *   uniform bool  u_invert;  // @param default=false
 *   uniform vec2  u_center;  // @param default=0.5,0.5
 *   uniform vec4  u_tint;    // @param color default=#ff8800
 *   uniform int   u_mode;    // @param enum=add|multiply|screen default=multiply
 *
 * The engine header already declares `u_<param>` for every param, so the
 * annotated uniform lines are replaced by blank comments (line numbers stay the same).
 */

export interface ParamParseError {
  /** 1-based line in the source. */
  line: number;
  message: string;
}

export interface ParsedParams {
  params: Record<string, ParamDef>;
  /** Param key → 1-based line of its declaration. */
  lines: Record<string, number>;
  errors: ParamParseError[];
}

/** Names the engine already declares (`u_<name>`); params may not use them. */
export const RESERVED_PARAM_NAMES = ['resolution', 'scale', 'time', 'iteration', 'prev'];

const DECL = /^\s*uniform\s+(?:(?:lowp|mediump|highp)\s+)?(float|int|bool|vec2|vec3|vec4)\s+u_(\w+)\s*;\s*\/\/\s*@param\b(.*)$/;
/** Any `uniform <type> u_<key>;` line (used to strip declarations of known params). */
const ANY_UNIFORM = /^\s*uniform\s+(?:(?:lowp|mediump|highp)\s+)?\w+\s+u_(\w+)\s*;.*$/;

/** Tokenise `key=value key="quoted value" flag`. */
export function parseAttrs(s: string): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  const re = /([A-Za-z_][\w-]*)(?:\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const v = m[2];
    out[m[1]] = v === undefined ? true : /^["']/.test(v) ? v.slice(1, -1).replace(/\\(.)/g, '$1') : v;
  }
  return out;
}

const num = (v: string | true | undefined, what: string): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (v === true || !Number.isFinite(n)) throw new Error(`${what} must be a number`);
  return n;
};

const nums = (v: string, n: number, what: string): number[] => {
  const parts = v
    .replace(/^\w*\(|\)$/g, '')
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number);
  if (parts.length === 1 && n > 1) while (parts.length < n) parts.push(parts[0]);
  if (parts.length < n || parts.some((x) => !Number.isFinite(x))) throw new Error(`${what} needs ${n} numbers`);
  return parts.slice(0, n);
};

/** '#rgb', '#rrggbb', '#rrggbbaa' or 'r,g,b[,a]' (0..1) → [r,g,b,a]. */
export function parseColor(v: string): number[] {
  const h = v.trim();
  if (h.startsWith('#')) {
    let x = h.slice(1);
    if (x.length === 3 || x.length === 4) x = [...x].map((c) => c + c).join('');
    if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(x)) throw new Error(`bad colour "${v}"`);
    const c = [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16) / 255);
    c.push(x.length === 8 ? parseInt(x.slice(6, 8), 16) / 255 : 1);
    return c.map((n) => Math.round(n * 1000) / 1000);
  }
  const p = nums(h, 3, 'colour');
  const parts = h.replace(/^\w*\(|\)$/g, '').split(/[\s,]+/).filter(Boolean).map(Number);
  return [p[0], p[1], p[2], parts.length >= 4 && Number.isFinite(parts[3]) ? parts[3] : 1];
}

function buildDef(glslType: string, a: Record<string, string | true>): ParamDef {
  const common: Partial<ParamDef> = {};
  if (typeof a.label === 'string') common.label = a.label;
  const desc = a.desc ?? a.description;
  if (typeof desc === 'string') common.description = desc;
  if (a.hidden) common.hidden = true;
  if (a.pixels || a.px) common.pixels = true;
  const def = a.default;
  if (def === true) throw new Error('default= needs a value');

  if (a.enum !== undefined) {
    if (glslType !== 'int') throw new Error('enum params must be declared as int');
    if (a.enum === true) throw new Error('enum= needs options, e.g. enum=a|b|c');
    const options = a.enum.split('|').map((s) => s.trim()).filter(Boolean);
    if (!options.length) throw new Error('enum needs at least one option');
    let d = options[0];
    if (def !== undefined) {
      if (options.includes(def)) d = def;
      else if (/^\d+$/.test(def) && options[+def] !== undefined) d = options[+def];
      else throw new Error(`default "${def}" is not one of ${options.join('|')}`);
    }
    return { ...common, type: 'enum', options, default: d };
  }
  if (a.color || glslType === 'vec3') {
    if (glslType !== 'vec4') throw new Error('color params must be declared as vec4 (the engine passes RGBA)');
    return { ...common, type: 'color', default: def !== undefined ? parseColor(def) : [1, 1, 1, 1] };
  }
  switch (glslType) {
    case 'float':
    case 'int': {
      const int = glslType === 'int';
      const min = num(a.min, 'min');
      const max = num(a.max, 'max');
      const step = num(a.step, 'step');
      let d = num(def, 'default') ?? (min !== undefined && min > 0 ? min : 0);
      if (int) d = Math.round(d);
      const p: ParamDef = { ...common, type: glslType, default: d };
      if (min !== undefined) p.min = min;
      if (max !== undefined) p.max = max;
      if (step !== undefined) p.step = step;
      if (min !== undefined && max !== undefined && min > max) throw new Error('min is greater than max');
      return p;
    }
    case 'bool': {
      let d = false;
      if (def !== undefined) {
        if (/^(true|1|on|yes)$/i.test(def)) d = true;
        else if (/^(false|0|off|no)$/i.test(def)) d = false;
        else throw new Error(`bool default must be true/false, got "${def}"`);
      }
      return { ...common, type: 'bool', default: d };
    }
    case 'vec2': {
      const p: ParamDef = { ...common, type: 'vec2', default: def !== undefined ? nums(def, 2, 'vec2 default') : [0, 0] };
      const step = num(a.step, 'step');
      if (step !== undefined) p.step = step;
      return p;
    }
    case 'vec4':
      throw new Error('vec4 params must be marked "@param color"');
  }
  throw new Error(`unsupported type ${glslType}`);
}

/**
 * Parse every `@param` annotation in `sources` (one string per pass).
 * The same param may be declared in several passes if the declarations agree.
 */
export function parseParams(sources: string[], opts: { inputs?: string[] } = {}): ParsedParams & { perPass: ParamParseError[][] } {
  const params: Record<string, ParamDef> = {};
  const lines: Record<string, number> = {};
  const errors: ParamParseError[] = [];
  const perPass: ParamParseError[][] = [];
  const taken = new Set((opts.inputs ?? []).map((n) => n));
  sources.forEach((src) => {
    const pe: ParamParseError[] = [];
    src.split('\n').forEach((text, i) => {
      const m = DECL.exec(text);
      if (!m) {
        if (/@param\b/.test(text) && /^\s*uniform\b/.test(text)) pe.push({ line: i + 1, message: 'could not parse this @param line (expected: uniform <type> u_<name>; // @param …)' });
        return;
      }
      const [, type, key, rest] = m;
      try {
        if (RESERVED_PARAM_NAMES.includes(key)) throw new Error(`u_${key} is a built-in uniform; pick another name`);
        if (taken.has(key) || /^pass\d+$/.test(key)) throw new Error(`u_${key} collides with an input or pass sampler`);
        const def = buildDef(type, parseAttrs(rest));
        if (params[key] && JSON.stringify(params[key]) !== JSON.stringify(def)) throw new Error(`u_${key} is declared differently in another pass`);
        if (!params[key]) {
          params[key] = def;
          lines[key] = i + 1;
        }
      } catch (e) {
        pe.push({ line: i + 1, message: `u_${key}: ${(e as Error).message}` });
      }
    });
    perPass.push(pe);
    errors.push(...pe);
  });
  return { params, lines, errors, perPass };
}

/**
 * Remove `uniform … u_<key>;` lines for the given param keys (annotated or not),
 * keeping the line count so compiler line numbers still match the user's code.
 */
export function stripParamUniforms(src: string, keys: Iterable<string>): string {
  const set = new Set(keys);
  return src
    .split('\n')
    .map((l) => {
      const m = ANY_UNIFORM.exec(l);
      return m && set.has(m[1]) ? `// (param u_${m[1]})` : l;
    })
    .join('\n');
}

const fmt = (n: number) => String(Math.round(n * 10000) / 10000);
const q = (s: string) => (/^[\w.#-]+$/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`);

/** Inverse of parseParams for one param: the annotated uniform line. */
export function paramToAnnotation(key: string, p: ParamDef): string | null {
  const a: string[] = [];
  let glsl: string;
  const d: ParamValue = p.default;
  switch (p.type) {
    case 'float':
    case 'int':
      glsl = p.type;
      if (p.min !== undefined) a.push(`min=${fmt(p.min)}`);
      if (p.max !== undefined) a.push(`max=${fmt(p.max)}`);
      if (p.step !== undefined) a.push(`step=${fmt(p.step)}`);
      a.push(`default=${fmt(Number(d ?? 0))}`);
      break;
    case 'bool':
      glsl = 'bool';
      a.push(`default=${d ? 'true' : 'false'}`);
      break;
    case 'vec2':
      glsl = 'vec2';
      a.push(`default=${((d as number[]) ?? [0, 0]).map(fmt).join(',')}`);
      if (p.step !== undefined) a.push(`step=${fmt(p.step)}`);
      break;
    case 'color':
      glsl = 'vec4';
      a.unshift('color');
      a.push(`default=${((d as number[]) ?? [1, 1, 1, 1]).map(fmt).join(',')}`);
      break;
    case 'enum':
      glsl = 'int';
      a.push(`enum=${(p.options ?? []).join('|')}`);
      a.push(`default=${q(String(d))}`);
      break;
    default:
      return null;
  }
  if (p.pixels) a.push('pixels');
  if (p.hidden) a.push('hidden');
  if (p.label) a.push(`label=${q(p.label)}`);
  if (p.description) a.push(`desc=${q(p.description)}`);
  return `uniform ${glsl} u_${key}; // @param ${a.join(' ')}`;
}
