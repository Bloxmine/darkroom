/**
 * AdaIN (Huang & Belongie, ICCV 2017; PyTorch port naoto0804/pytorch-AdaIN, MIT) as ONNX graphs built in
 * the browser from the published PyTorch weight files, so only those have to be downloaded:
 *  - buildAdainEncoder(): normalised VGG-19 up to relu4_1, from `vgg_normalised.pth` (legacy torch format);
 *  - buildAdainDecoder(): the mirrored decoder, from `decoder_final.pth` (torch zip format, stored).
 * The weight files are pinned to a commit (models-motion.ts), so each tensor's byte offset is fixed; the
 * offsets were found by matching every tensor's bytes in the files (scratch script, checked against
 * PyTorch: see docs/AI.md). Both graphs are fully convolutional with symbolic H×W (multiples of 8).
 * AdaIN itself (feature mean/std matching) runs in JS between the two, so the style statistics can be
 * cached per style image. No imports: also loaded by Node for validation.
 * Exports an empty NodeDef[] for the auto-registration glob.
 */
import type { NodeDef } from '../../core/types';

export default [] as NodeDef[];

// --- minimal protobuf writer ------------------------------------------------------------------------
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
const enc = new TextEncoder();
const fVar = (f: number, v: number) => Uint8Array.from([...varint(f * 8), ...varint(v)]);
const fLen = (f: number, body: Uint8Array) => concat([varint(f * 8 + 2), varint(body.length), body]);
const fStr = (f: number, s: string) => fLen(f, enc.encode(s));

const FLOAT = 1;
const INT64 = 7;
function tensor(name: string, dims: number[], type: number, raw: Uint8Array) {
  return concat([...dims.map((d) => fVar(1, d)), fVar(2, type), fStr(8, name), fLen(9, raw)]);
}
const f32Tensor = (name: string, dims: number[], d: Float32Array) => tensor(name, dims, FLOAT, new Uint8Array(d.buffer, d.byteOffset, d.byteLength));
function i64Tensor(name: string, v: number[]) {
  const b = new BigInt64Array(v.map((x) => BigInt(x)));
  return tensor(name, [v.length], INT64, new Uint8Array(b.buffer));
}
const attrInts = (name: string, v: number[]) => concat([fStr(1, name), ...v.map((x) => fVar(8, x)), fVar(20, 7)]);
const attrStr = (name: string, v: string) => concat([fStr(1, name), fStr(4, v), fVar(20, 3)]);
let nodeSeq = 0;
function node(op: string, inputs: string[], outputs: string[], attrs: Uint8Array[] = []) {
  return concat([...inputs.map((s) => fStr(1, s)), ...outputs.map((s) => fStr(2, s)), fStr(3, `${op}_${++nodeSeq}`), fStr(4, op), ...attrs.map((a) => fLen(5, a))]);
}
function valueInfo(name: string, c: number) {
  const dim = (p: Uint8Array) => fLen(1, p);
  const shape = concat([dim(fVar(1, 1)), dim(fVar(1, c)), dim(fStr(2, 'h')), dim(fStr(2, 'w'))]);
  return concat([fStr(1, name), fLen(2, fLen(1, concat([fVar(1, FLOAT), fLen(2, shape)])))]);
}
function model(graphParts: Uint8Array[], name: string): ArrayBuffer {
  const graph = concat([...graphParts.slice(0, -2), fStr(2, name), ...graphParts.slice(-2)]);
  const m = concat([fVar(1, 8), fStr(2, 'darkroom'), fLen(7, graph), fLen(8, concat([fStr(1, ''), fVar(2, 13)]))]);
  return m.buffer.slice(m.byteOffset, m.byteOffset + m.byteLength) as ArrayBuffer;
}

// --- weight tables: [layer index, weight offset, bias offset, out ch, in ch, kernel] -------------
type Layer = [number, number, number, number, number, number];

export const ADAIN_VGG_BYTES = 80102481;
/** vgg_normalised.pth: conv layers 0 (1×1) … 29 (relu4_1). Identical bytes to the naoto0804 v0.0.0 release. */
export const VGG_LAYERS: Layer[] = [
  [0, 80102425, 80102469, 3, 3, 1],
  [2, 79505673, 79505409, 64, 3, 3],
  [5, 79063025, 79062761, 64, 64, 3],
  [9, 79210489, 79062241, 128, 64, 3],
  [12, 79512593, 79061721, 128, 128, 3],
  [16, 77882065, 73162425, 256, 128, 3],
  [19, 73163457, 73161393, 256, 256, 3],
  [22, 75522761, 73160361, 256, 256, 3],
  [25, 61356665, 63715969, 256, 256, 3],
  [29, 47198817, 63717001, 512, 256, 3],
];
export const ADAIN_DEC_BYTES = 14027664;
export const DEC_LAYERS: Layer[] = [
  [1, 2688, 4721408, 256, 512, 3],
  [5, 5763712, 8123136, 256, 256, 3],
  [8, 8124288, 10483712, 256, 256, 3],
  [11, 10484864, 12844288, 256, 256, 3],
  [14, 12845440, 14025216, 128, 256, 3],
  [18, 4722560, 5312512, 128, 128, 3],
  [21, 5313152, 5608192, 64, 128, 3],
  [25, 5608576, 5756160, 64, 64, 3],
  [28, 5756544, 5763584, 3, 64, 3],
];

/** float32 LE at an arbitrary (possibly unaligned) byte offset. */
function readF32(bytes: Uint8Array, off: number, n: number): Float32Array {
  if (off + n * 4 > bytes.length) throw new Error('AdaIN weights file is too short');
  const copy = bytes.slice(off, off + n * 4);
  const out = new Float32Array(copy.buffer);
  for (let i = 0; i < Math.min(n, 64); i++) if (!Number.isFinite(out[i])) throw new Error('AdaIN weights look corrupt');
  return out;
}

function convInits(bytes: Uint8Array, layers: Layer[], prefix: string) {
  const inits: Uint8Array[] = [];
  for (const [k, wo, bo, co, ci, ks] of layers) {
    inits.push(fLen(5, f32Tensor(`${prefix}${k}.w`, [co, ci, ks, ks], readF32(bytes, wo, co * ci * ks * ks))));
    inits.push(fLen(5, f32Tensor(`${prefix}${k}.b`, [co], readF32(bytes, bo, co))));
  }
  return inits;
}

function checkSize(buf: ArrayBuffer, expected: number, what: string) {
  if (buf.byteLength !== expected) throw new Error(`${what}: unexpected file size ${buf.byteLength} (expected ${expected})`);
}

/** VGG encoder: input `image` [1,3,H,W] RGB 0..1 (H, W multiples of 8) → `feat` [1,512,H/8,W/8] (relu4_1). */
export function buildAdainEncoder(buf: ArrayBuffer): ArrayBuffer {
  checkSize(buf, ADAIN_VGG_BYTES, 'vgg_normalised.pth');
  const bytes = new Uint8Array(buf);
  const nodes: Uint8Array[] = [];
  const inits = [...convInits(bytes, VGG_LAYERS, 'e'), fLen(5, i64Tensor('pads1', [0, 0, 1, 1, 0, 0, 1, 1]))];
  let x = 'image';
  const push = (n: Uint8Array) => nodes.push(fLen(1, n));
  push(node('Conv', [x, 'e0.w', 'e0.b'], ['e0'], [attrInts('kernel_shape', [1, 1])]));
  x = 'e0';
  const conv = (k: number, out?: string) => {
    push(node('Pad', [x, 'pads1'], [`p${k}`], [attrStr('mode', 'reflect')]));
    push(node('Conv', [`p${k}`, `e${k}.w`, `e${k}.b`], [`c${k}`], [attrInts('kernel_shape', [3, 3])]));
    push(node('Relu', [`c${k}`], [out ?? `r${k}`]));
    x = out ?? `r${k}`;
  };
  const pool = (k: number) => {
    // ceil_mode is irrelevant for sizes divisible by 8 (and the WebGPU EP lacks it)
    push(node('MaxPool', [x], [`m${k}`], [attrInts('kernel_shape', [2, 2]), attrInts('strides', [2, 2])]));
    x = `m${k}`;
  };
  conv(2); conv(5); pool(1);
  conv(9); conv(12); pool(2);
  conv(16); conv(19); conv(22); conv(25); pool(3);
  conv(29, 'feat');
  return model([...nodes, ...inits, fLen(11, valueInfo('image', 3)), fLen(12, valueInfo('feat', 512))], 'adain_vgg_encoder');
}

/** Decoder: input `feat` [1,512,h,w] → `image` [1,3,8h,8w] (RGB, roughly 0..1; clamp afterwards). */
export function buildAdainDecoder(buf: ArrayBuffer): ArrayBuffer {
  checkSize(buf, ADAIN_DEC_BYTES, 'decoder_final.pth');
  const bytes = new Uint8Array(buf);
  const nodes: Uint8Array[] = [];
  const inits = [
    ...convInits(bytes, DEC_LAYERS, 'd'),
    fLen(5, i64Tensor('pads1', [0, 0, 1, 1, 0, 0, 1, 1])),
    fLen(5, f32Tensor('up2', [4], Float32Array.from([1, 1, 2, 2]))),
  ];
  const push = (n: Uint8Array) => nodes.push(fLen(1, n));
  let x = 'feat';
  const conv = (k: number, relu = true) => {
    push(node('Pad', [x, 'pads1'], [`p${k}`], [attrStr('mode', 'reflect')]));
    const out = relu ? `c${k}` : 'image';
    push(node('Conv', [`p${k}`, `d${k}.w`, `d${k}.b`], [out], [attrInts('kernel_shape', [3, 3])]));
    if (relu) push(node('Relu', [out], [`r${k}`]));
    x = relu ? `r${k}` : out;
  };
  const up = (k: number) => {
    // torch nn.Upsample(scale_factor=2, mode='nearest') = asymmetric coordinates, floor
    push(node('Resize', [x, '', 'up2'], [`u${k}`], [attrStr('mode', 'nearest'), attrStr('coordinate_transformation_mode', 'asymmetric'), attrStr('nearest_mode', 'floor')]));
    x = `u${k}`;
  };
  conv(1); up(1);
  conv(5); conv(8); conv(11); conv(14); up(2);
  conv(18); conv(21); up(3);
  conv(25); conv(28, false);
  return model([...nodes, ...inits, fLen(11, valueInfo('feat', 512)), fLen(12, valueInfo('image', 3))], 'adain_decoder');
}

/** Per-channel mean and std (unbiased, + 1e-5 inside the sqrt as in the reference) of C×N features. */
export function featStats(feat: Float32Array, c: number): { mean: Float32Array; std: Float32Array } {
  const n = feat.length / c;
  const mean = new Float32Array(c);
  const std = new Float32Array(c);
  for (let k = 0; k < c; k++) {
    let s = 0;
    const o = k * n;
    for (let i = 0; i < n; i++) s += feat[o + i];
    const m = s / n;
    let v = 0;
    for (let i = 0; i < n; i++) {
      const d = feat[o + i] - m;
      v += d * d;
    }
    mean[k] = m;
    std[k] = Math.sqrt(v / Math.max(1, n - 1) + 1e-5);
  }
  return { mean, std };
}

/**
 * AdaIN: normalise the content features per channel and give them the style's mean/std, then mix
 * with the content features by `alpha` (the paper's content–style trade-off). Returns a new array.
 */
export function adain(content: Float32Array, c: number, style: { mean: Float32Array; std: Float32Array }, alpha = 1): Float32Array {
  const n = content.length / c;
  const cs = featStats(content, c);
  const out = new Float32Array(content.length);
  for (let k = 0; k < c; k++) {
    const o = k * n;
    const g = style.std[k] / cs.std[k];
    const b = style.mean[k] - cs.mean[k] * g;
    for (let i = 0; i < n; i++) {
      const v = content[o + i];
      out[o + i] = alpha * (v * g + b) + (1 - alpha) * v;
    }
  }
  return out;
}
