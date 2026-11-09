/**
 * Small, dependency-free BPE tokenizers for the vision-language models (no @huggingface/transformers):
 *  - CLIP (CLIP, OWL-ViT / OWLv2, CLIPSeg): NFC + whitespace collapse + lowercase, CLIP's word split,
 *    byte-level alphabet, BPE with the `</w>` end-of-word suffix, <|startoftext|> … <|endoftext|>.
 *  - Byte-level BPE (GPT-2 / RoBERTa / BART; Florence-2): GPT-2 pre-tokenizer regex, byte-level alphabet,
 *    BPE without suffix, <s> … </s>, added tokens (Florence's <loc_N>, <od>…) matched before BPE.
 * Both read a Hugging Face `tokenizer.json` (vocab + merges), which the caller downloads into the model cache,
 * so tokenizing works offline after first use. Output ids match the HF fast tokenizers (see tokenizer.test.ts).
 */

export interface TokenizerJson {
  model: { type: string; vocab: Record<string, number>; merges: (string | [string, string])[]; end_of_word_suffix?: string | null; unk_token?: string | null };
  added_tokens?: { id: number; content: string; special?: boolean }[];
}

/** GPT-2's byte → printable-unicode table (bytes_to_unicode). */
function byteTables() {
  const bs: number[] = [];
  for (let b = 33; b <= 126; b++) bs.push(b);
  for (let b = 161; b <= 172; b++) bs.push(b);
  for (let b = 174; b <= 255; b++) bs.push(b);
  const cs = bs.slice();
  let n = 0;
  for (let b = 0; b < 256; b++) {
    if (!bs.includes(b)) {
      bs.push(b);
      cs.push(256 + n++);
    }
  }
  const enc: string[] = new Array(256);
  const dec = new Map<string, number>();
  bs.forEach((b, i) => {
    const ch = String.fromCharCode(cs[i]);
    enc[b] = ch;
    dec.set(ch, b);
  });
  return { enc, dec };
}
const BYTES = byteTables();
const utf8 = new TextEncoder();
const utf8d = new TextDecoder();

/** UTF-8 bytes of `s` in the byte-level alphabet. */
export function toByteLevel(s: string): string {
  let out = '';
  for (const b of utf8.encode(s)) out += BYTES.enc[b];
  return out;
}

/** Inverse of toByteLevel (unknown characters are kept as UTF-8). */
export function fromByteLevel(s: string): string {
  const bytes: number[] = [];
  for (const ch of s) {
    const b = BYTES.dec.get(ch);
    if (b !== undefined) bytes.push(b);
    else bytes.push(...utf8.encode(ch));
  }
  return utf8d.decode(new Uint8Array(bytes));
}

const CLIP_SPLIT = /'s|'t|'re|'ve|'m|'ll|'d|[\p{L}]+|[\p{N}]|[^\s\p{L}\p{N}]+/gu;
const GPT2_SPLIT = /'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;

/** Core BPE over one pre-tokenized word (already in the byte-level alphabet). */
class Bpe {
  readonly vocab: Map<string, number>;
  readonly inv: string[] = [];
  private ranks = new Map<string, number>();
  private cache = new Map<string, string[]>();
  constructor(json: TokenizerJson, private suffix = '') {
    this.vocab = new Map(Object.entries(json.model.vocab));
    for (const [t, id] of this.vocab) this.inv[id] = t;
    for (const a of json.added_tokens ?? []) {
      this.vocab.set(a.content, a.id);
      this.inv[a.id] = a.content;
    }
    json.model.merges.forEach((m, i) => this.ranks.set(typeof m === 'string' ? m : `${m[0]} ${m[1]}`, i));
  }

  word(w: string): string[] {
    const hit = this.cache.get(w);
    if (hit) return hit;
    const parts = Array.from(w);
    if (this.suffix && parts.length) parts[parts.length - 1] += this.suffix;
    while (parts.length > 1) {
      let best = -1, bestRank = Infinity;
      for (let i = 0; i < parts.length - 1; i++) {
        const r = this.ranks.get(parts[i] + ' ' + parts[i + 1]);
        if (r !== undefined && r < bestRank) {
          bestRank = r;
          best = i;
        }
      }
      if (best < 0) break;
      // merge every occurrence of the best pair (left to right), like the reference implementation
      const a = parts[best], b = parts[best + 1];
      const merged: string[] = [];
      for (let i = 0; i < parts.length; i++) {
        if (i < parts.length - 1 && parts[i] === a && parts[i + 1] === b) {
          merged.push(a + b);
          i++;
        } else merged.push(parts[i]);
      }
      parts.splice(0, parts.length, ...merged);
    }
    if (this.cache.size > 5000) this.cache.clear();
    this.cache.set(w, parts);
    return parts;
  }
}

export interface Encoded {
  ids: number[];
}

/** CLIP tokenizer (openai/clip-vit-base-patch32 tokenizer.json; same vocab for OWL-ViT, OWLv2 and CLIPSeg). */
export class ClipTokenizer {
  private bpe: Bpe;
  readonly bos: number;
  readonly eos: number;
  private unk: number;
  constructor(json: TokenizerJson) {
    this.bpe = new Bpe(json, json.model.end_of_word_suffix ?? '</w>');
    this.bos = this.bpe.vocab.get('<|startoftext|>') ?? 49406;
    this.eos = this.bpe.vocab.get('<|endoftext|>') ?? 49407;
    this.unk = this.eos;
  }

  /** Token ids with <|startoftext|> … <|endoftext|>, truncated to `maxLen` (keeping the end token). */
  encode(text: string, maxLen = 77): number[] {
    const norm = text.normalize('NFC').replace(/\s+/g, ' ').toLowerCase().replace(/<\|(start|end)oftext\|>/g, ' ');
    const ids: number[] = [this.bos];
    for (const m of norm.matchAll(CLIP_SPLIT)) {
      for (const t of this.bpe.word(toByteLevel(m[0]))) ids.push(this.bpe.vocab.get(t) ?? this.unk);
    }
    if (ids.length > maxLen - 1) ids.length = maxLen - 1;
    ids.push(this.eos);
    return ids;
  }

  /** Several texts padded to one length (pad id, attention mask 0 on padding). */
  encodeBatch(texts: string[], opts: { maxLen?: number; padTo?: number; padId?: number } = {}) {
    const all = texts.map((t) => this.encode(t, opts.maxLen ?? 77));
    const len = Math.max(opts.padTo ?? 0, ...all.map((a) => a.length));
    const ids = new Float32Array(texts.length * len).fill(opts.padId ?? 0);
    const mask = new Float32Array(texts.length * len);
    all.forEach((a, i) => a.forEach((v, j) => ((ids[i * len + j] = v), (mask[i * len + j] = 1))));
    return { ids, mask, len };
  }

  decode(ids: number[]): string {
    const s = ids.filter((i) => i !== this.bos && i !== this.eos).map((i) => this.bpe.inv[i] ?? '').join('');
    return fromByteLevel(s.replace(/<\/w>/g, ' ')).trim();
  }
}

/** Byte-level BPE tokenizer (BART / RoBERTa; Florence-2). */
export class ByteBpeTokenizer {
  private bpe: Bpe;
  private added: Map<string, number>;
  private addedRe: RegExp | null;
  private specialIds: Set<number>;
  readonly bos: number;
  readonly eos: number;
  readonly pad: number;
  constructor(json: TokenizerJson) {
    this.bpe = new Bpe(json, '');
    this.added = new Map((json.added_tokens ?? []).map((a) => [a.content, a.id]));
    const esc = [...this.added.keys()].sort((a, b) => b.length - a.length).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    this.addedRe = esc.length ? new RegExp(`(${esc.join('|')})`, 'g') : null;
    this.specialIds = new Set((json.added_tokens ?? []).filter((a) => a.special && /^<\/?(s|pad|unk|mask)>$/.test(a.content)).map((a) => a.id));
    this.bos = this.added.get('<s>') ?? 0;
    this.eos = this.added.get('</s>') ?? 2;
    this.pad = this.added.get('<pad>') ?? 1;
  }

  /** Ids with <s> … </s>. Added tokens (e.g. `<loc_12>`) in the text map to their ids. */
  encode(text: string, opts: { special?: boolean } = {}): number[] {
    const ids: number[] = opts.special === false ? [] : [this.bos];
    const chunks = this.addedRe ? text.split(this.addedRe) : [text];
    for (const c of chunks) {
      if (!c) continue;
      const a = this.added.get(c);
      if (a !== undefined) {
        ids.push(a);
        continue;
      }
      for (const m of c.matchAll(GPT2_SPLIT)) for (const t of this.bpe.word(toByteLevel(m[0]))) ids.push(this.bpe.vocab.get(t) ?? this.pad);
    }
    if (opts.special !== false) ids.push(this.eos);
    return ids;
  }

  /** Token string of one id (added tokens verbatim, byte-level otherwise). */
  token(id: number): string {
    return this.bpe.inv[id] ?? '';
  }

  isAdded(id: number) {
    const t = this.bpe.inv[id];
    return t !== undefined && this.added.get(t) === id;
  }

  /** Decode ids. `skipSpecial` drops <s>, </s>, <pad>, <unk>, <mask> (task / location tokens stay). */
  decode(ids: number[], skipSpecial = false): string {
    let out = '';
    let run = '';
    const flush = () => {
      if (run) out += fromByteLevel(run);
      run = '';
    };
    for (const id of ids) {
      if (skipSpecial && this.specialIds.has(id)) continue;
      if (this.isAdded(id)) {
        flush();
        out += this.bpe.inv[id];
      } else run += this.bpe.inv[id] ?? '';
    }
    flush();
    return out;
  }
}
