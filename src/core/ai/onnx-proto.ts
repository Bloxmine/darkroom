/**
 * Minimal ONNX protobuf editing for `ModelInfo.prepare` (see models-img.ts):
 *  - freeImageDims(): turns fixed spatial input/output dims (e.g. 1×3×224×224) into symbolic ones so a
 *    fully-convolutional model accepts any size, drops stale value_info shapes, and removes
 *    initializers listed as graph inputs (old exporters), which lets ORT constant-fold them;
 *  - buildZeroDce(): builds the DCE-Net graph (Zero-DCE) from the raw float32 weights of a Keras
 *    checkpoint, so only the weights file has to be downloaded.
 * Only the fields touched here are decoded; everything else is copied byte for byte.
 */

interface Field {
  f: number;
  wt: number;
  /** Whole field (tag + payload) for verbatim copies. */
  raw: Uint8Array;
  /** Payload of a length-delimited field. */
  body: Uint8Array;
  /** Value of a varint field. */
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
    } else throw new Error(`onnx-proto: unsupported wire type ${wt}`);
    out.push({ f, wt, raw: b.subarray(start, i), body, v });
  }
  return out;
}

const utf8 = new TextDecoder();
const enc = new TextEncoder();

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
const fStr = (f: number, s: string) => fLen(f, enc.encode(s));
const fMsg = (f: number, ...parts: Uint8Array[]) => fLen(f, concat(parts));

// --- freeImageDims --------------------------------------------------------------------------------

/** Rewrite a ValueInfoProto: keep name/doc, replace a rank-4 shape's H/W with symbolic dims (other ranks: unknown shape). */
function freeValueInfo(vi: Uint8Array): Uint8Array {
  const fields = parse(vi);
  const name = utf8.decode(fields.find((x) => x.f === 1)?.body ?? new Uint8Array());
  return concat(
    fields.map((x) => {
      if (x.f !== 2) return x.raw;
      // TypeProto → tensor_type (1) → { elem_type (1), shape (2) }
      const tt = parse(x.body).find((y) => y.f === 1);
      if (!tt) return x.raw;
      const tf = parse(tt.body);
      const elem = tf.find((y) => y.f === 1)?.v ?? 1;
      const shape = tf.find((y) => y.f === 2);
      const dims = shape ? parse(shape.body).filter((d) => d.f === 1) : [];
      const parts: Uint8Array[] = [fVar(1, elem)];
      if (dims.length === 4) {
        parts.push(
          fMsg(2, ...dims.map((d, k) => (k < 2 ? fLen(1, d.body) : fMsg(1, fStr(2, `${name}_${k === 2 ? 'h' : 'w'}`))))),
        );
      }
      return fMsg(2, fMsg(1, ...parts));
    }),
  );
}

/** Make a fixed-size image model accept any H×W (see file comment). */
export function freeImageDims(buf: ArrayBuffer): ArrayBuffer {
  const model = parse(new Uint8Array(buf));
  const ir = model.find((x) => x.f === 1)?.v ?? 0;
  const out = model.map((x) => {
    if (x.f !== 7) return x.raw;
    const graph = parse(x.body);
    const inits = new Set<string>();
    for (const g of graph) {
      if (g.f !== 5) continue;
      const nm = parse(g.body).find((t) => t.f === 8);
      if (nm) inits.add(utf8.decode(nm.body));
    }
    const parts: Uint8Array[] = [];
    for (const g of graph) {
      if (g.f === 13) continue; // value_info: stale intermediate shapes
      if (g.f === 11 || g.f === 12) {
        const nm = utf8.decode(parse(g.body).find((t) => t.f === 1)?.body ?? new Uint8Array());
        if (g.f === 11 && ir >= 4 && inits.has(nm)) continue; // initializer listed as input
        parts.push(fLen(g.f, freeValueInfo(g.body)));
      } else parts.push(g.raw);
    }
    return fLen(7, concat(parts));
  });
  const bytes = concat(out);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

// --- graph building -------------------------------------------------------------------------------

const ATTR_INT = 2;
const ATTR_INTS = 7;

function tensorF32(name: string, dims: number[], data: Float32Array): Uint8Array {
  const raw = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return concat([...dims.map((d) => fVar(1, d)), fVar(2, 1), fStr(8, name), fLen(9, raw)]);
}

function attrInts(name: string, v: number[]) {
  return concat([fStr(1, name), ...v.map((x) => fVar(8, x)), fVar(20, ATTR_INTS)]);
}

function attrInt(name: string, v: number) {
  return concat([fStr(1, name), fVar(3, v), fVar(20, ATTR_INT)]);
}

function node(op: string, inputs: string[], outputs: string[], attrs: Uint8Array[] = []) {
  return concat([...inputs.map((s) => fStr(1, s)), ...outputs.map((s) => fStr(2, s)), fStr(3, outputs[0] + '_' + op), fStr(4, op), ...attrs.map((a) => fLen(5, a))]);
}

/** ValueInfoProto for a float NCHW tensor: [1, c, h, w] with symbolic h/w. */
function imageValueInfo(name: string, c: number) {
  const dim = (p: Uint8Array) => fLen(1, p);
  const shape = concat([dim(fVar(1, 1)), dim(fVar(1, c)), dim(fStr(2, 'h')), dim(fStr(2, 'w'))]);
  return concat([fStr(1, name), fMsg(2, fMsg(1, fVar(1, 1), fLen(2, shape)))]);
}

/**
 * DCE-Net (Zero-DCE, Guo et al. CVPR 2020) as trained by the Keras example (keras-io/low-light-image-enhancement):
 * 7 conv3×3 layers (32 ch), skip concats [c4,c3] → c5, [c5,c2] → c6, [c6,c1] → c7 (24 ch, tanh).
 * `buf` is the checkpoint's variables.data: per layer an HWIO kernel then the bias, float32 LE, in order.
 * Output `curves`: 8 iterations × RGB curve parameters α ∈ [-1, 1] (x ← x + α·(x² − x)).
 */
export function buildZeroDce(buf: ArrayBuffer): ArrayBuffer {
  const shapes: [number, number][] = [[3, 32], [32, 32], [32, 32], [32, 32], [64, 32], [64, 32], [64, 24]];
  const all = new Float32Array(buf, 0, Math.floor(buf.byteLength / 4));
  const inits: Uint8Array[] = [];
  const nodes: Uint8Array[] = [];
  let off = 0;
  shapes.forEach(([ci, co], l) => {
    const k = all.subarray(off, off + 9 * ci * co);
    off += 9 * ci * co;
    const bias = all.slice(off, off + co);
    off += co;
    // HWIO → OIHW
    const w = new Float32Array(co * ci * 9);
    for (let y = 0; y < 3; y++)
      for (let x = 0; x < 3; x++)
        for (let i = 0; i < ci; i++) for (let o = 0; o < co; o++) w[((o * ci + i) * 3 + y) * 3 + x] = k[((y * 3 + x) * ci + i) * co + o];
    inits.push(fLen(5, tensorF32(`w${l}`, [co, ci, 3, 3], w)), fLen(5, tensorF32(`b${l}`, [co], bias)));
  });
  if (off * 4 > buf.byteLength) throw new Error('Zero-DCE weights file too short');
  const conv = (l: number, x: string, act: 'Relu' | 'Tanh', out = `a${l}`) => {
    nodes.push(fLen(1, node('Conv', [x, `w${l}`, `b${l}`], [`c${l}`], [attrInts('kernel_shape', [3, 3]), attrInts('pads', [1, 1, 1, 1])])));
    nodes.push(fLen(1, node(act, [`c${l}`], [out])));
    return out;
  };
  const cat = (a: string, b: string, out: string) => (nodes.push(fLen(1, node('Concat', [a, b], [out], [attrInt('axis', 1)]))), out);
  const x1 = conv(0, 'input', 'Relu');
  const x2 = conv(1, x1, 'Relu');
  const x3 = conv(2, x2, 'Relu');
  const x4 = conv(3, x3, 'Relu');
  const x5 = conv(4, cat(x4, x3, 'k1'), 'Relu');
  const x6 = conv(5, cat(x5, x2, 'k2'), 'Relu');
  conv(6, cat(x6, x1, 'k3'), 'Tanh', 'curves');
  const graph = concat([...nodes, fStr(2, 'dce_net'), ...inits, fLen(11, imageValueInfo('input', 3)), fLen(12, imageValueInfo('curves', 24))]);
  const model = concat([fVar(1, 8), fStr(2, 'darkroom'), fLen(7, graph), fMsg(8, fVar(2, 13))]);
  return model.buffer.slice(model.byteOffset, model.byteOffset + model.byteLength) as ArrayBuffer;
}
