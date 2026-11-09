/**
 * Cut one ONNX model into parts (like onnx.utils.extract_model), in the browser, for `ModelInfo.prepare`.
 * The vision-language exports (OWL-ViT / OWLv2, CLIPSeg) are single graphs that take the image and the text
 * together, so a new prompt would re-run the image encoder. Splitting them into an image part and a text part
 * (and, for CLIPSeg, a small decoder) lets the nodes encode the image once and only run the text tower per prompt.
 *
 * extractGraph(model, outputs, inputs?): keeps the nodes that `outputs` depend on, walking back until a tensor is a
 * graph input or one of the new `inputs` (cut points, given with their element type). Initializers, opsets and every
 * other field are copied byte for byte; value_info (stale intermediate shapes) is dropped. Subgraph attributes (If /
 * Loop bodies) are scanned for outer-scope references.
 */

interface Field {
  f: number;
  wt: number;
  raw: Uint8Array;
  body: Uint8Array;
  v: number;
}

function readVarint(b: Uint8Array, i: number): [number, number] {
  let r = 0;
  let mul = 1;
  for (;;) {
    const c = b[i++];
    r += (c & 0x7f) * mul;
    if (c < 0x80) return [r, i];
    mul *= 128;
  }
}

function parse(b: Uint8Array): Field[] {
  const out: Field[] = [];
  let i = 0;
  while (i < b.length) {
    const start = i;
    let tag: number;
    [tag, i] = readVarint(b, i);
    const f = Math.floor(tag / 8);
    const wt = tag & 7;
    let body = b.subarray(0, 0);
    let v = 0;
    if (wt === 0) [v, i] = readVarint(b, i);
    else if (wt === 1) i += 8;
    else if (wt === 5) i += 4;
    else if (wt === 2) {
      let len: number;
      [len, i] = readVarint(b, i);
      body = b.subarray(i, i + len);
      i += len;
    } else throw new Error(`onnx-split: unsupported wire type ${wt}`);
    out.push({ f, wt, raw: b.subarray(start, i), body, v });
  }
  return out;
}

const dec = new TextDecoder();
const enc = new TextEncoder();
const str = (b: Uint8Array) => dec.decode(b);

function varint(n: number): number[] {
  const out: number[] = [];
  while (n >= 128) {
    out.push((n % 128) | 128);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
}

function concat(parts: (Uint8Array | number[])[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
const fVar = (f: number, v: number) => Uint8Array.from([...varint(f * 8), ...varint(v)]);
const fLen = (f: number, body: Uint8Array) => concat([varint(f * 8 + 2), varint(body.length), body]);

/** ONNX TensorProto.DataType codes. */
export const DT = { float: 1, uint8: 2, int8: 3, int32: 6, int64: 7, bool: 9, float16: 10 } as const;

/** ValueInfoProto with an element type and no shape (unknown rank). */
function valueInfo(name: string, elem: number) {
  return concat([fLen(1, enc.encode(name)), fLen(2, fLen(1, fVar(1, elem)))]);
}

interface NodeInfo {
  raw: Field;
  inputs: string[];
  outputs: string[];
}

/** Names a node's subgraphs read from the enclosing scope. */
function outerRefs(node: Uint8Array): string[] {
  const refs: string[] = [];
  for (const a of parse(node)) {
    if (a.f !== 5) continue;
    for (const af of parse(a.body)) {
      if (af.f !== 6 && af.f !== 11) continue; // g / graphs
      const local = new Set<string>();
      const nodes = parse(af.body).filter((g) => g.f === 1);
      for (const g of parse(af.body)) if (g.f === 5 || g.f === 11) local.add(str(parse(g.body).find((x) => x.f === (g.f === 5 ? 8 : 1))?.body ?? new Uint8Array()));
      for (const n of nodes) for (const x of parse(n.body)) if (x.f === 2) local.add(str(x.body));
      for (const n of nodes) {
        for (const x of parse(n.body)) if (x.f === 1 && x.body.length && !local.has(str(x.body))) refs.push(str(x.body));
        refs.push(...outerRefs(n.body).filter((r) => !local.has(r)));
      }
    }
  }
  return refs;
}

export interface CutInput {
  name: string;
  /** ONNX element type (DT.*). */
  type: number;
}

/** Extract the sub-model computing `outputs` (see the file comment). A new output is float unless given with its type. */
export function extractGraph(buf: ArrayBuffer, outs: (string | CutInput)[], inputs: CutInput[] = []): ArrayBuffer {
  const outputs = outs.map((o) => (typeof o === 'string' ? o : o.name));
  const outType = new Map(outs.map((o) => (typeof o === 'string' ? [o, DT.float as number] : [o.name, o.type])));
  const model = parse(new Uint8Array(buf));
  const parts = model.map((x) => {
    if (x.f !== 7) return x.raw;
    const graph = parse(x.body);
    const nodes: NodeInfo[] = [];
    const byField = new Map<Field, NodeInfo>();
    for (const g of graph) {
      if (g.f !== 1) continue;
      const fs = parse(g.body);
      const ins = fs.filter((y) => y.f === 1).map((y) => str(y.body));
      const n = { raw: g, inputs: [...ins, ...outerRefs(g.body)], outputs: fs.filter((y) => y.f === 2).map((y) => str(y.body)) };
      nodes.push(n);
      byField.set(g, n);
    }
    const cut = new Set(inputs.map((i) => i.name));
    const need = new Set(outputs);
    const keep = new Set<NodeInfo>();
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if (!n.outputs.some((o) => need.has(o) && !cut.has(o))) continue;
      keep.add(n);
      for (const s of n.inputs) if (s && !cut.has(s)) need.add(s);
    }
    const nameOf = (g: Field, nameField: number) => str(parse(g.body).find((y) => y.f === nameField)?.body ?? new Uint8Array());
    const origOut = new Map(graph.filter((g) => g.f === 12).map((g) => [nameOf(g, 1), g.raw]));
    const out: Uint8Array[] = [];
    for (const g of graph) {
      if (g.f === 1) {
        if (keep.has(byField.get(g)!)) out.push(g.raw);
      } else if (g.f === 5) {
        if (need.has(nameOf(g, 8))) out.push(g.raw);
      } else if (g.f === 15) {
        // sparse initializer: values (1) is a TensorProto whose name is the initializer name
        const values = parse(g.body).find((y) => y.f === 1);
        if (values && need.has(nameOf(values, 8))) out.push(g.raw);
      } else if (g.f === 11) {
        const nm = nameOf(g, 1);
        if (need.has(nm) && !cut.has(nm)) out.push(g.raw);
      } else if (g.f === 12 || g.f === 13) continue;
      else out.push(g.raw);
    }
    for (const c of inputs) out.push(fLen(11, valueInfo(c.name, c.type)));
    for (const o of outputs) out.push(origOut.get(o) ?? fLen(12, valueInfo(o, outType.get(o) ?? DT.float)));
    return fLen(7, concat(out));
  });
  const bytes = concat(parts);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * Re-type graph inputs: input `name` becomes a `from`-typed input of the same name, followed by a Cast to its old type
 * `to` under the original tensor name (e.g. a bool flag fed as float, which the session host can send).
 */
export function castInputs(buf: ArrayBuffer, casts: { name: string; from: number; to: number }[]): ArrayBuffer {
  const model = parse(new Uint8Array(buf));
  const parts = model.map((x) => {
    if (x.f !== 7) return x.raw;
    const graph = parse(x.body);
    const pre: Uint8Array[] = [];
    const out: Uint8Array[] = [];
    for (const c of casts) {
      const inner = `${c.name}__cast`;
      const attr = concat([fLen(1, enc.encode('to')), fVar(3, c.to), fVar(20, 2)]);
      pre.push(fLen(1, concat([fLen(1, enc.encode(c.name)), fLen(2, enc.encode(inner)), fLen(3, enc.encode(inner + '_node')), fLen(4, enc.encode('Cast')), fLen(5, attr)])));
    }
    const renamed = new Map(casts.map((c) => [c.name, `${c.name}__cast`]));
    let first = true;
    for (const g of graph) {
      if (g.f === 1) {
        if (first) out.push(...pre);
        first = false;
        // point consumers (and subgraph references) at the cast output
        out.push(fLen(1, renameRefs(g.body, renamed)));
      } else if (g.f === 11 && casts.some((c) => c.name === str(parse(g.body).find((y) => y.f === 1)?.body ?? new Uint8Array()))) {
        const c = casts.find((c) => c.name === str(parse(g.body).find((y) => y.f === 1)!.body))!;
        out.push(fLen(11, valueInfo(c.name, c.from)));
      } else out.push(g.raw);
    }
    return fLen(7, concat(out));
  });
  const bytes = concat(parts);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** NodeProto with every input name in `map` renamed, recursing into subgraph attributes. */
function renameRefs(node: Uint8Array, map: Map<string, string>): Uint8Array {
  return concat(
    parse(node).map((x) => {
      if (x.f === 1 && map.has(str(x.body))) return fLen(1, enc.encode(map.get(str(x.body))!));
      if (x.f !== 5) return x.raw;
      return fLen(
        5,
        concat(
          parse(x.body).map((a) => {
            if (a.f !== 6 && a.f !== 11) return a.raw;
            return fLen(a.f, concat(parse(a.body).map((g) => (g.f === 1 ? fLen(1, renameRefs(g.body, map)) : g.raw))));
          }),
        ),
      );
    }),
  );
}
