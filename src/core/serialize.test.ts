import { describe, expect, it } from 'vitest';
import { paramToAnnotation, parseAttrs, parseColor, parseParams, stripParamUniforms } from './glslParams';
import { compareVersions, detectTier, parseDataPlugin } from './plugins';
import { deserializeNodeDef, isSerializable, NotSerializableError, parseNodeFile, serializeNodeDef, toNodeFile, validateSerializedNodeDef } from './serialize';
import type { NodeDef, PassContext, SerializedNodeDef } from './types';

const ctx = (over: Partial<PassContext> = {}): PassContext => ({ params: {}, width: 400, height: 200, scale: 0.5, inputSizes: {}, passSizes: [], ...over });

const blur: SerializedNodeDef = {
  id: 'user.twoPassBlur',
  name: 'Two-pass Blur',
  category: 'Filter',
  description: 'test',
  inputs: { image: { type: 'image' } },
  params: { radius: { type: 'float', default: 4, min: 0, max: 50, pixels: true }, steps: { type: 'int', default: 3, min: 1, max: 8 } },
  passes: [
    { frag: 'uniform float u_radius; // @param min=0 max=50 default=4 pixels\nvoid main(){ fragColor = texture(u_image, v_uv); }', size: { scale: 0.5 } },
    { frag: 'void main(){ fragColor = texture(u_prev, v_uv); }', size: { width: 100 }, filter: 'nearest', repeat: 'steps' },
  ],
};

describe('serialize', () => {
  it('round-trips exactly', () => {
    const def = deserializeNodeDef(blur);
    expect(serializeNodeDef(def)).toEqual(validateSerializedNodeDef(blur));
    expect(isSerializable(def)).toBe(true);
  });

  it('strips param uniform declarations but keeps line numbers', () => {
    const def = deserializeNodeDef(blur);
    const f = def.passes![0].frag as string;
    expect(f).not.toMatch(/uniform float u_radius/);
    expect(f.split('\n')).toHaveLength(2);
  });

  it('turns declarative size and repeat into functions', () => {
    const def = deserializeNodeDef(blur);
    expect(def.passes![0].size!(ctx())).toEqual([200, 100]);
    expect(def.passes![1].size!(ctx())).toEqual([50, 200]); // 100px full-res × scale 0.5, height = node height
    expect(def.passes![1].repeat!(ctx({ params: { steps: 5 } }))).toBe(5);
    expect(def.passes![1].repeat!(ctx())).toBe(3);
    expect(def.passes![1].filter).toBe('nearest');
  });

  it('serialises plain code-defined defs and rejects functions', () => {
    const plain: NodeDef = { id: 'x.plain', name: 'Plain', category: 'Test', inputs: {}, params: {}, passes: [{ frag: 'void main(){}' }] };
    expect(serializeNodeDef(plain).passes[0].frag).toBe('void main(){}');
    const fn: NodeDef = { ...plain, passes: [{ frag: () => 'void main(){}' }] };
    expect(() => serializeNodeDef(fn)).toThrow(NotSerializableError);
    expect(isSerializable({ ...plain, cpu: () => ({}) })).toBe(false);
  });

  it('validates', () => {
    expect(() => validateSerializedNodeDef({ ...blur, id: 'noNamespace' })).toThrow(/namespaced/);
    expect(() => validateSerializedNodeDef({ ...blur, passes: [] })).toThrow(/pass/);
    expect(() => validateSerializedNodeDef({ ...blur, inputs: { prev: { type: 'image' } } })).toThrow(/reserved/);
    expect(() => validateSerializedNodeDef({ ...blur, params: { a: { type: 'float', default: 'x' } } } as unknown as SerializedNodeDef)).toThrow(/default/);
    expect(() => validateSerializedNodeDef({ ...blur, passes: [{ frag: 'x', repeat: 'nope' }] })).toThrow(/repeat/);
  });

  it('reads and writes .drnode.json files', () => {
    const text = toNodeFile(blur);
    expect(JSON.parse(text).format).toBe('darkroom-node');
    expect(parseNodeFile(text).id).toBe('user.twoPassBlur');
    expect(parseNodeFile(JSON.stringify(blur)).id).toBe('user.twoPassBlur'); // bare
    expect(() => parseNodeFile('{')).toThrow(/JSON/);
  });
});

describe('@param annotations', () => {
  it('parses all supported kinds', () => {
    const src = [
      'uniform float u_amount; // @param min=0 max=2 default=1 label="Amount" desc="How much"',
      'uniform int u_steps; // @param min=1 max=32 default=8',
      'uniform bool u_invert; // @param default=true',
      'uniform vec2 u_center; // @param default=0.25,0.75',
      'uniform vec4 u_tint; // @param color default=#ff8000',
      'uniform int u_mode; // @param enum=add|multiply|screen default=multiply',
      'uniform float u_px; // @param pixels default=3',
      'void main(){}',
    ].join('\n');
    const r = parseParams([src]);
    expect(r.errors).toEqual([]);
    expect(r.params.amount).toEqual({ type: 'float', default: 1, min: 0, max: 2, label: 'Amount', description: 'How much' });
    expect(r.params.steps).toMatchObject({ type: 'int', default: 8, min: 1, max: 32 });
    expect(r.params.invert).toMatchObject({ type: 'bool', default: true });
    expect(r.params.center).toMatchObject({ type: 'vec2', default: [0.25, 0.75] });
    expect(r.params.tint).toMatchObject({ type: 'color', default: [1, 0.502, 0, 1] });
    expect(r.params.mode).toMatchObject({ type: 'enum', options: ['add', 'multiply', 'screen'], default: 'multiply' });
    expect(r.params.px).toMatchObject({ pixels: true, default: 3 });
    expect(r.lines.mode).toBe(6);
    expect(Object.keys(r.params)).toHaveLength(7);
  });

  it('reports errors with line numbers', () => {
    const r = parseParams(['void main(){}\nuniform vec4 u_c; // @param default=1\nuniform float u_scale; // @param\nuniform int u_e; // @param enum=a|b default=z']);
    expect(r.errors.map((e) => e.line)).toEqual([2, 3, 4]);
    expect(r.errors[1].message).toMatch(/built-in/);
  });

  it('detects conflicting declarations across passes and input collisions', () => {
    const a = 'uniform float u_k; // @param default=1';
    const b = 'uniform float u_k; // @param default=2';
    expect(parseParams([a, a]).errors).toEqual([]);
    expect(parseParams([a, b]).errors[0].message).toMatch(/differently/);
    expect(parseParams(['uniform float u_image; // @param'], { inputs: ['image'] }).errors).toHaveLength(1);
  });

  it('strips declarations for known keys only', () => {
    const s = 'uniform float u_a; // @param\nuniform float u_other;\nvoid main(){}';
    expect(stripParamUniforms(s, ['a'])).toBe('// (param u_a)\nuniform float u_other;\nvoid main(){}');
  });

  it('round-trips through paramToAnnotation', () => {
    const r = parseParams(['uniform int u_mode; // @param enum=a|b|c default=b label="My mode"\nuniform vec4 u_t; // @param color default=0.5,0.25,1,0.5']);
    const back = parseParams([[paramToAnnotation('mode', r.params.mode)!, paramToAnnotation('t', r.params.t)!].join('\n')]);
    expect(back.params).toEqual(r.params);
  });

  it('helpers', () => {
    expect(parseAttrs('min=0 label="a b" color')).toEqual({ min: '0', label: 'a b', color: true });
    expect(parseColor('#fff')).toEqual([1, 1, 1, 1]);
    expect(parseColor('0.1, 0.2, 0.3')).toEqual([0.1, 0.2, 0.3, 1]);
  });
});

describe('data plugins', () => {
  const plugin = {
    format: 'darkroom-plugin',
    id: 'test.pack',
    name: 'Test Pack',
    version: '1.2.0',
    nodes: [blur],
    presets: [{ id: 'test.preset', name: 'P', category: 'Test', group: { name: 'P', exposed: [], graph: { nodes: [{ id: 'a', type: 'user.twoPassBlur', params: {}, position: { x: 0, y: 0 } }], edges: [] } } }],
  };
  it('parses and validates', () => {
    const d = parseDataPlugin(JSON.stringify(plugin));
    expect(d.nodes[0].id).toBe('user.twoPassBlur');
    expect(d.presets[0].id).toBe('test.preset');
    expect(() => parseDataPlugin(JSON.stringify({ ...plugin, version: undefined }))).toThrow(/version/);
    expect(() => parseDataPlugin(JSON.stringify({ ...plugin, nodes: [{ ...blur, passes: [] }] }))).toThrow(/pass/);
  });
  it('detects tier and compares versions', () => {
    expect(detectTier(' {"id":1}')).toBe('data');
    expect(detectTier('export default {}')).toBe('code');
    expect(compareVersions('1.10.0', '1.9.3')).toBe(1);
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.9', '1.0')).toBe(-1);
  });
});
