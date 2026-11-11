/** Remote zip extraction (range requests, CRC checks, resume) against a mock CDN. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CATALOG_BASES, catalogSelect } from '../../src/core/sd/coreml-catalog';
import { extractZip, parseCentralDirectory, readZipIndex } from './zipfetch';

// ------------------------------------------------------------------------------------- remote zip extraction
describe('zipfetch (range-request zip extraction)', () => {
  let dir = '';
  afterEach(async () => {
    vi.unstubAllGlobals();
    if (dir) await rm(dir, { recursive: true, force: true });
  });
  const big = new Uint8Array(200_000).map((_, i) => (i * 7919) & 255);
  const zip = zipSync({
    'Top/ControlledUnet.mlmodelc/weights/weight.bin': [big, { level: 0 }],
    'Top/ControlledUnet.mlmodelc/metadata.json': [strToU8('[{"x":1}]'), { level: 6 }],
    'Top/Unet.mlmodelc/weights/weight.bin': [big, { level: 6 }],
    'Top/vocab.json': [strToU8('{"a":1}'.repeat(500)), { level: 9 }],
  });
  /** Serves HEAD and Range GETs from the zip, like Hugging Face's CDN; can fail once mid-file. */
  function serve(opts: { failAfter?: number } = {}) {
    let served = 0;
    const calls: string[] = [];
    const f = vi.fn(async (_url: string, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      if (init?.method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-length': String(zip.length), 'accept-ranges': 'bytes' } });
      const m = /bytes=(\d+)-(\d+)/.exec(h.get('Range') ?? '')!;
      const [a, b] = [Number(m[1]), Number(m[2])];
      calls.push(`${a}-${b}`);
      let body = zip.slice(a, b + 1);
      if (opts.failAfter !== undefined && b < zip.length - 1 && body.length > 50_000 && served === 0) {
        served++;
        // a stream that delivers part of the file, then errors (connection drop)
        const part = body.slice(0, opts.failAfter);
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(part);
            setTimeout(() => c.error(new Error('connection reset')), 50);
          },
        });
        return new Response(stream, { status: 206 });
      }
      body = zip.slice(a, b + 1);
      return new Response(body, { status: 206, headers: { 'content-range': `bytes ${a}-${b}/${zip.length}` } });
    });
    vi.stubGlobal('fetch', f);
    return { f, calls };
  }

  it('parses the central directory', async () => {
    serve();
    const ix = await readZipIndex('https://example.test/m.zip');
    expect(ix.size).toBe(zip.length);
    expect(ix.entries.map((e) => e.name)).toEqual(['Top/ControlledUnet.mlmodelc/weights/weight.bin', 'Top/ControlledUnet.mlmodelc/metadata.json', 'Top/Unet.mlmodelc/weights/weight.bin', 'Top/vocab.json']);
    expect(ix.entries[0]).toMatchObject({ method: 0, usize: 200_000, csize: 200_000 });
    expect(ix.entries[2].method).toBe(8);
    expect(parseCentralDirectory(Buffer.alloc(0))).toEqual([]);
  });

  it('extracts only the selected entries, verifies CRCs, resumes a stored file after a dropped connection', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'darkroom-zip-'));
    const { calls } = serve({ failAfter: 60_000 });
    const progress: number[] = [];
    const sel = catalogSelect(CATALOG_BASES[0]);
    const r = await extractZip({ url: 'https://example.test/m.zip', dest: path.join(dir, 'model'), select: sel, onProgress: (d) => progress.push(d) });
    expect(r.files).toBe(3);
    expect(new Uint8Array(await readFile(path.join(dir, 'model/ControlledUnet.mlmodelc/weights/weight.bin')))).toEqual(big);
    expect(await readFile(path.join(dir, 'model/vocab.json'), 'utf8')).toBe('{"a":1}'.repeat(500));
    await expect(readFile(path.join(dir, 'model/Unet.mlmodelc/weights/weight.bin'))).rejects.toThrow();
    // the retry asked only for the bytes after the 60 000 that arrived before the drop
    const ranges = calls.map((c) => c.split('-').map(Number)).filter(([a, b]) => b - a > 1000 && b < zip.length - 1);
    expect(ranges[1][0] - ranges[0][0]).toBe(60_000);
    expect(progress.at(-1)).toBe(r.bytes);
  }, 20_000);

  it('skips files a previous run finished (manifest) and rejects unsafe paths', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'darkroom-zip-'));
    const { f } = serve();
    const dest = path.join(dir, 'm');
    const ix = await readZipIndex('https://example.test/m.zip');
    const crc = ix.entries[3].crc;
    await mkdir(dest + '.partial', { recursive: true });
    await writeFile(path.join(dest + '.partial', 'vocab.json'), '{"a":1}'.repeat(500));
    await writeFile(path.join(dest + '.partial', '.darkroom-download.json'), JSON.stringify({ url: 'https://example.test/m.zip', done: { 'vocab.json': crc } }));
    f.mockClear();
    await extractZip({ url: 'https://example.test/m.zip', dest, index: ix, select: (n) => (n.endsWith('vocab.json') ? 'vocab.json' : null) });
    expect(f).not.toHaveBeenCalled();
    await expect(extractZip({ url: 'https://example.test/m.zip', dest: path.join(dir, 'x'), index: ix, select: () => '../evil' })).rejects.toThrow(/Unsafe/);
  });
});
