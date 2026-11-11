/**
 * Remote zip extraction over HTTP range requests (Electron main; also runnable under plain Node ≥ 22 with type
 * stripping — keep this file free of relative imports and TS-only runtime syntax).
 *
 * The Core ML model zips on Hugging Face are 0.7–3.6 GB. Instead of downloading the zip and unzipping it we read the
 * central directory from the end of the file, then fetch only the entries we want (e.g. one resolution out of a
 * four-resolution ControlNet zip, or a base model without the plain Unet when the ControlledUnet is enough), inflate
 * them as they stream in and check every file's CRC-32 against the zip's directory.
 *
 * Resume: finished files are recorded in `<dest>.partial/.darkroom-download.json`; an interrupted *stored* entry
 * continues with a Range request from where it stopped (deflated entries restart that one file). The staging folder
 * is renamed to `dest` only when everything verified.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';

export interface ZipEntry {
  name: string;
  method: number;
  crc: number;
  csize: number;
  usize: number;
  offset: number;
}

export interface ZipIndex {
  url: string;
  size: number;
  entries: ZipEntry[];
}

const UA = 'Darkroom (Core ML model download)';

async function rangeBytes(url: string, start: number, end: number, signal?: AbortSignal): Promise<Buffer> {
  const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}`, 'User-Agent': UA }, signal, redirect: 'follow' });
  if (res.status !== 206 && res.status !== 200) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return res.status === 200 ? buf.subarray(start, end + 1) : buf;
}

async function remoteSize(url: string, signal?: AbortSignal): Promise<number> {
  const res = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': UA }, signal, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const n = Number(res.headers.get('content-length'));
  if (!n) throw new Error(`No Content-Length for ${url}`);
  if (!/bytes/i.test(res.headers.get('accept-ranges') ?? 'bytes')) throw new Error(`${url} does not support range requests`);
  return n;
}

/** Parse a zip (incl. zip64) central directory. Exported for tests. */
export function parseCentralDirectory(cd: Buffer): ZipEntry[] {
  const out: ZipEntry[] = [];
  let p = 0;
  while (p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50) {
    const method = cd.readUInt16LE(p + 10);
    const crc = cd.readUInt32LE(p + 16);
    let csize = cd.readUInt32LE(p + 20);
    let usize = cd.readUInt32LE(p + 24);
    const n = cd.readUInt16LE(p + 28), e = cd.readUInt16LE(p + 30), c = cd.readUInt16LE(p + 32);
    let offset = cd.readUInt32LE(p + 42);
    const name = cd.subarray(p + 46, p + 46 + n).toString('utf8');
    let q = p + 46 + n;
    const extraEnd = q + e;
    while (q + 4 <= extraEnd) {
      const id = cd.readUInt16LE(q), len = cd.readUInt16LE(q + 2);
      if (id === 1) {
        let k = q + 4;
        if (usize === 0xffffffff) (usize = Number(cd.readBigUInt64LE(k))), (k += 8);
        if (csize === 0xffffffff) (csize = Number(cd.readBigUInt64LE(k))), (k += 8);
        if (offset === 0xffffffff) (offset = Number(cd.readBigUInt64LE(k))), (k += 8);
      }
      q += 4 + len;
    }
    out.push({ name, method, crc, csize, usize, offset });
    p = extraEnd + c;
  }
  return out;
}

export async function readZipIndex(url: string, signal?: AbortSignal): Promise<ZipIndex> {
  const size = await remoteSize(url, signal);
  const tailLen = Math.min(size, 128 * 1024);
  const tail = await rangeBytes(url, size - tailLen, size - 1, signal);
  let cdSize: number, cdOff: number;
  const z64 = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x06, 0x06]));
  if (z64 >= 0) {
    cdSize = Number(tail.readBigUInt64LE(z64 + 40));
    cdOff = Number(tail.readBigUInt64LE(z64 + 48));
  } else {
    const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) throw new Error(`Not a zip file: ${url}`);
    cdSize = tail.readUInt32LE(eocd + 12);
    cdOff = tail.readUInt32LE(eocd + 16);
  }
  const cd = cdOff >= size - tailLen ? tail.subarray(cdOff - (size - tailLen), cdOff - (size - tailLen) + cdSize) : await rangeBytes(url, cdOff, cdOff + cdSize - 1, signal);
  return { url, size, entries: parseCentralDirectory(cd) };
}

export interface ExtractOptions {
  url: string;
  /** Final folder; written as `<dest>.partial` and renamed when complete. */
  dest: string;
  /** Map a zip entry name to a path relative to `dest`, or null to skip it. Default: keep everything. */
  select?: (name: string) => string | null;
  onProgress?: (done: number, total: number, file: string) => void;
  signal?: AbortSignal;
  /** Reuse an index already fetched (e.g. to show sizes first). */
  index?: ZipIndex;
}

interface Manifest {
  url: string;
  done: Record<string, number>;
}

/** Bytes that `extract` will fetch with this selection (compressed sizes). */
export function selectedBytes(index: ZipIndex, select?: (name: string) => string | null): number {
  return index.entries.filter((e) => !e.name.endsWith('/') && (select ? select(e.name) !== null : true)).reduce((a, e) => a + e.csize, 0);
}

async function crcOfFile(file: string): Promise<number> {
  let crc = 0;
  for await (const chunk of createReadStream(file)) crc = zlib.crc32(chunk as Buffer, crc);
  return crc;
}

export async function extractZip(o: ExtractOptions): Promise<{ files: number; bytes: number }> {
  const index = o.index ?? (await readZipIndex(o.url, o.signal));
  const pick = index.entries
    .map((e) => ({ e, rel: o.select ? o.select(e.name) : e.name }))
    .filter((x): x is { e: ZipEntry; rel: string } => x.rel !== null && x.rel !== '' && !x.e.name.endsWith('/'));
  if (!pick.length) throw new Error('Nothing to extract: the selection matched no files in the zip.');
  for (const { rel } of pick) if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) throw new Error(`Unsafe path in zip: ${rel}`);
  const staging = o.dest + '.partial';
  await mkdir(staging, { recursive: true });
  const manPath = path.join(staging, '.darkroom-download.json');
  let man: Manifest = { url: o.url, done: {} };
  try {
    const m = JSON.parse(await readFile(manPath, 'utf8')) as Manifest;
    if (m.url === o.url) man = m;
  } catch {
    /* fresh */
  }
  const total = pick.reduce((a, x) => a + x.e.csize, 0);
  let done = pick.filter((x) => man.done[x.rel] === x.e.crc).reduce((a, x) => a + x.e.csize, 0);
  let lastTick = 0;
  const tick = (file: string, force = false) => {
    const now = Date.now();
    if (!force && now - lastTick < 200) return;
    lastTick = now;
    o.onProgress?.(done, total, file);
  };
  tick('', true);

  for (const { e, rel } of pick) {
    if (man.done[rel] === e.crc) continue;
    const file = path.join(staging, rel);
    await mkdir(path.dirname(file), { recursive: true });
    for (let attempt = 1; ; attempt++) {
      const before = done;
      try {
        o.signal?.throwIfAborted();
        const lh = await rangeBytes(o.url, e.offset, e.offset + 29, o.signal);
        if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error(`Bad local header for ${e.name}`);
        const dataStart = e.offset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
        // resume a stored (uncompressed) entry from its partial file
        let have = 0, crc = 0;
        if (e.method === 0) {
          try {
            have = (await stat(file)).size;
            if (have > e.usize) have = 0;
            else if (have > 0) crc = await crcOfFile(file);
          } catch {
            have = 0;
          }
        }
        done += have;
        if (e.csize - have > 0) {
          const res = await fetch(o.url, { headers: { Range: `bytes=${dataStart + have}-${dataStart + e.csize - 1}`, 'User-Agent': UA }, signal: o.signal, redirect: 'follow' });
          if (res.status !== 206 || !res.body) throw new Error(`HTTP ${res.status} while downloading ${e.name}`);
          const count = new Transform({
            transform(chunk: Buffer, _enc, cb) {
              done += chunk.length;
              tick(rel);
              cb(null, chunk);
            },
          });
          const check = new Transform({
            transform(chunk: Buffer, _enc, cb) {
              crc = zlib.crc32(chunk, crc);
              cb(null, chunk);
            },
          });
          const sink = createWriteStream(file, { flags: have > 0 ? 'a' : 'w' });
          const src = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>);
          if (e.method === 8) await pipeline(src, count, zlib.createInflateRaw(), check, sink, { signal: o.signal });
          else if (e.method === 0) await pipeline(src, count, check, sink, { signal: o.signal });
          else throw new Error(`Unsupported zip compression method ${e.method} (${e.name})`);
        }
        const size = (await stat(file)).size;
        if (size !== e.usize) throw new Error(`${e.name}: got ${size} bytes, expected ${e.usize}`);
        if (crc >>> 0 !== e.crc >>> 0) {
          await rm(file, { force: true });
          throw new Error(`${e.name}: CRC mismatch (corrupt download)`);
        }
        man.done[rel] = e.crc;
        await writeFile(manPath, JSON.stringify(man));
        tick(rel, true);
        break;
      } catch (err) {
        if (o.signal?.aborted || attempt >= 4) throw err;
        done = before;
        if (e.method !== 0) await rm(file, { force: true });
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
  }
  await rm(manPath, { force: true });
  await rm(o.dest, { recursive: true, force: true });
  await rename(staging, o.dest);
  return { files: pick.length, bytes: total };
}
