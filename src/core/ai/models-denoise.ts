/**
 * Denoising and sky-segmentation models, registered into the shared catalog. Imported for its side
 * effect by src/nodes/ai/{denoise,sky}.ts. URLs are pinned to a Hugging Face commit. Licences: docs/AI.md.
 *
 * SCUNet's ONNX export keeps its weights in a sibling `.onnx.data` file (torch external data). The
 * catalog downloads that big file as the model's file (so the progress toast and the AI Models list
 * show the real size), and `prepare` fetches the small graph file (also cache-first) and inlines the
 * weights as `raw_data`, producing a single self-contained ONNX buffer for ONNX Runtime Web.
 */
import { fetchCached } from './cache';
import { registerModel, type ModelInfo } from './models';
import { freeImageDims } from './onnx-proto';

const hf = (repo: string, sha: string, file: string) => `https://huggingface.co/${repo}/resolve/${sha}/${file}`;
const page = (repo: string) => `https://huggingface.co/${repo}`;

const SCU = 'Heliosoph/scunet-onnx';
const SCU_SHA = '6d11417ee2fbcc73783c502a238ac115097754fe';
const SKY = 'voyagerfromeast/skyseg';
const SKY_SHA = 'd76f97cf68f049654f087d78d071dfd7505b2561';

// --- tiny protobuf reader/writer (just enough to inline ONNX external data) ------------------------
function readVarint(b: Uint8Array, i: number): [number, number] {
  let r = 0, mul = 1;
  for (;;) {
    const c = b[i++];
    r += (c & 0x7f) * mul;
    if (c < 0x80) return [r, i];
    mul *= 128;
  }
}
interface Field { f: number; wt: number; raw: Uint8Array; body: Uint8Array }
function parse(b: Uint8Array): Field[] {
  const out: Field[] = [];
  let i = 0;
  while (i < b.length) {
    const start = i;
    let tag: number;
    [tag, i] = readVarint(b, i);
    const f = Math.floor(tag / 8), wt = tag & 7;
    let body = b.subarray(0, 0);
    if (wt === 0) [, i] = readVarint(b, i);
    else if (wt === 1) i += 8;
    else if (wt === 5) i += 4;
    else if (wt === 2) {
      let len: number;
      [len, i] = readVarint(b, i);
      body = b.subarray(i, i + len);
      i += len;
    } else throw new Error('protobuf: unsupported wire type ' + wt);
    out.push({ f, wt, raw: b.subarray(start, i), body });
  }
  return out;
}
function varint(n: number): number[] {
  const out: number[] = [];
  while (n >= 128) {
    out.push((n % 128) | 128);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
}
/** Length-delimited field header (tag + length); the payload is written separately. */
const lenHeader = (f: number, len: number) => Uint8Array.from([...varint(f * 8 + 2), ...varint(len)]);
const utf8 = new TextDecoder();

/** Inline torch/ONNX external data: `graph` references tensors stored in `data` (one external file). */
export function inlineExternalData(graph: ArrayBuffer, data: ArrayBuffer): ArrayBuffer {
  const dataU8 = new Uint8Array(data);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const push = (c: Uint8Array) => (chunks.push(c), (total += c.length));

  // a TensorProto → list of chunks (re-encoded only when external)
  const tensor = (body: Uint8Array): Uint8Array[] => {
    const fields = parse(body);
    const ext = fields.filter((x) => x.f === 13);
    if (!ext.length) return [body];
    let offset = 0, length = -1;
    for (const e of ext) {
      const kv = parse(e.body);
      const k = utf8.decode(kv.find((x) => x.f === 1)?.body ?? new Uint8Array());
      const v = utf8.decode(kv.find((x) => x.f === 2)?.body ?? new Uint8Array());
      if (k === 'offset') offset = Number(v);
      else if (k === 'length') length = Number(v);
    }
    if (length < 0) length = dataU8.length - offset;
    const kept = fields.filter((x) => x.f !== 13 && x.f !== 14).map((x) => x.raw);
    return [...kept, lenHeader(9, length), dataU8.subarray(offset, offset + length)];
  };
  const size = (parts: Uint8Array[]) => parts.reduce((s, p) => s + p.length, 0);

  for (const top of parse(new Uint8Array(graph))) {
    if (top.f !== 7) {
      push(top.raw);
      continue;
    }
    const gparts: Uint8Array[] = [];
    for (const g of parse(top.body)) {
      if (g.f !== 5) {
        gparts.push(g.raw);
        continue;
      }
      const t = tensor(g.body);
      gparts.push(lenHeader(5, size(t)), ...t);
    }
    push(lenHeader(7, size(gparts)));
    gparts.forEach(push);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out.buffer;
}

/** Drop `ceil_mode` from every MaxPool (top-level graph). Only valid when all pooled sizes are even, i.e. inputs are multiples of 2^levels. */
export function dropMaxPoolCeil(buf: ArrayBuffer): ArrayBuffer {
  const chunks: Uint8Array[] = [];
  const size = (parts: Uint8Array[]) => parts.reduce((s, p) => s + p.length, 0);
  for (const top of parse(new Uint8Array(buf))) {
    if (top.f !== 7) {
      chunks.push(top.raw);
      continue;
    }
    const gparts: Uint8Array[] = [];
    for (const g of parse(top.body)) {
      const fields = g.f === 1 ? parse(g.body) : null;
      const op = fields && utf8.decode(fields.find((x) => x.f === 4)?.body ?? new Uint8Array());
      if (!fields || op !== 'MaxPool') {
        gparts.push(g.raw);
        continue;
      }
      const kept = fields.filter((x) => !(x.f === 5 && utf8.decode(parse(x.body).find((y) => y.f === 1)?.body ?? new Uint8Array()) === 'ceil_mode')).map((x) => x.raw);
      gparts.push(lenHeader(1, size(kept)), ...kept);
    }
    chunks.push(lenHeader(7, size(gparts)), ...gparts);
  }
  const out = new Uint8Array(size(chunks));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out.buffer;
}

const scunet = (variant: 'psnr' | 'gan'): ModelInfo => {
  const base = `scunet_color_real_${variant}.onnx`;
  return {
    id: `scunet-real-${variant}`,
    name: `SCUNet real-world denoise (${variant.toUpperCase()})`,
    task: 'denoising',
    licence: 'Apache-2.0',
    page: page(SCU),
    credit: 'SCUNet (Zhang et al., Practical Blind Image Denoising via Swin-Conv-UNet and Data Synthesis, MIR 2023); ONNX export by Heliosoph',
    // the weights (external data); prepare() fetches the 3.8 MB graph and inlines them
    files: [{ precision: 'fp32', url: hf(SCU, SCU_SHA, base + '.data'), bytes: 73138176 }],
    prepare: async (data) => {
      const g = await fetchCached(hf(SCU, SCU_SHA, base), undefined, 3.8e6);
      return inlineExternalData(g.buffer, data);
    },
  };
};

registerModel(scunet('psnr'), scunet('gan'), {
  id: 'skyseg',
  name: 'SkySeg U²-Net (sky segmentation)',
  task: 'segmentation',
  licence: 'MIT',
  page: page(SKY),
  credit: 'Sky segmentation U²-Net by xiongzhu666 (Sky-Segmentation-and-Post-processing, MIT); fp16 ONNX by voyagerfromeast',
  // fp16 weights, fp32 I/O. Exported at 320×320; fully convolutional, so freeImageDims lets it run at any multiple of 32.
  files: [{ precision: 'fp16', url: hf(SKY, SKY_SHA, 'skyseg_fp16.onnx'), bytes: 88084505 }],
  // U²-Net pools ×1/32 in total; the node always feeds multiples of 32, so every pooled size is even and
  // MaxPool's ceil_mode (which ORT 1.31's WebGPU EP lacks) makes no difference: drop it to allow WebGPU.
  prepare: (buf) => freeImageDims(dropMaxPoolCeil(buf)),
});
