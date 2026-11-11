/** Pixel size from the first bytes of a JPEG / PNG / GIF / WebP / BMP (no decode). Pure. */
export function sniffDimensions(b: Uint8Array): { width: number; height: number } | null {
  const n = b.length;
  if (n < 24) return null;
  const u16be = (i: number) => (b[i] << 8) | b[i + 1];
  const u16le = (i: number) => b[i] | (b[i + 1] << 8);
  const u32be = (i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  const u32le = (i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
  // PNG
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { width: u32be(16), height: u32be(20) };
  // GIF
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { width: u16le(6), height: u16le(8) };
  // BMP
  if (b[0] === 0x42 && b[1] === 0x4d && n >= 26) return { width: u32le(18), height: Math.abs(u32le(22) | 0) };
  // WebP
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 && n >= 30) {
    const fmt = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (fmt === 'VP8 ') return { width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff };
    if (fmt === 'VP8L') {
      const bits = u32le(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (fmt === 'VP8X') return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    return null;
  }
  // JPEG: walk the segments to the first SOFn
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < n) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const m = b[i + 1];
      if (m === 0xff) {
        i++;
        continue;
      }
      if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) {
        i += 2;
        continue;
      }
      const len = u16be(i + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: u16be(i + 5), width: u16be(i + 7) };
      i += 2 + len;
    }
  }
  return null;
}

/** Bytes of the largest embedded JPEG (RAW previews: most RAWs carry a full-size JPEG), or null. */
export function largestEmbeddedJpeg(b: Uint8Array, minBytes = 8 * 1024): Uint8Array | null {
  let best: [number, number] | null = null;
  const n = b.length;
  for (let i = 0; i + 3 < n; i++) {
    if (b[i] !== 0xff || b[i + 1] !== 0xd8 || b[i + 2] !== 0xff) continue;
    // walk segments to SOS, then scan for EOI
    let j = i + 2;
    let ok = false;
    while (j + 4 < n && b[j] === 0xff) {
      const m = b[j + 1];
      if (m === 0xda) {
        ok = true;
        break;
      }
      j += 2 + ((b[j + 2] << 8) | b[j + 3]);
    }
    if (!ok) continue;
    let k = j + 2;
    while (k + 1 < n && !(b[k] === 0xff && b[k + 1] === 0xd9)) k++;
    if (k + 1 >= n) break;
    const len = k + 2 - i;
    if (len >= minBytes && (!best || len > best[1])) best = [i, len];
    i = k + 1;
  }
  return best ? b.subarray(best[0], best[0] + best[1]) : null;
}
