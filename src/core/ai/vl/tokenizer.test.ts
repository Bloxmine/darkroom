import { describe, expect, it } from 'vitest';
import bart from './__fixtures__/bart-tokenizer.json';
import clip from './__fixtures__/clip-tokenizer.json';
import { ByteBpeTokenizer, ClipTokenizer, fromByteLevel, toByteLevel, type TokenizerJson } from './tokenizer';

// Fixtures: the vocab entries and merges (in their original order) that can occur in the test strings, cut from the
// real tokenizer.json files (openai/clip-vit-base-patch32, microsoft/Florence-2-base-ft). Restricting the merge list
// to merges whose parts are substrings of the test words leaves BPE's trajectory on those words unchanged.
// `reference` holds the ids from the Hugging Face `tokenizers` library (0.22) on the full files.

describe('CLIP BPE tokenizer', () => {
  const tok = new ClipTokenizer(clip.tokenizer as TokenizerJson);
  for (const [text, ids] of Object.entries(clip.reference as Record<string, number[]>)) {
    it(`matches HF ids: ${JSON.stringify(text)}`, () => expect(tok.encode(text)).toEqual(ids));
  }
  it('decodes back to the normalised text', () => {
    expect(tok.decode(tok.encode('Red Jacket, paddle'))).toBe('red jacket , paddle');
  });
  it('pads a batch with an attention mask', () => {
    const b = tok.encodeBatch(['paddle', 'red jacket'], { padTo: 16 });
    expect(b.len).toBe(16);
    expect(Array.from(b.ids.slice(0, 4))).toEqual([49406, 20811, 49407, 0]);
    expect(Array.from(b.mask.slice(16, 21))).toEqual([1, 1, 1, 1, 0]);
  });
  it('truncates but keeps the end token', () => {
    const ids = tok.encode('red red red red red red red red red red red red red red red red red red', 16);
    expect(ids.length).toBe(16);
    expect(ids[15]).toBe(49407);
  });
});

describe('byte-level BPE tokenizer (Florence-2 / BART)', () => {
  const tok = new ByteBpeTokenizer(bart.tokenizer as TokenizerJson);
  for (const [text, ids] of Object.entries(bart.reference as Record<string, number[]>)) {
    it(`matches HF ids: ${JSON.stringify(text)}`, () => expect(tok.encode(text)).toEqual(ids));
    it(`round-trips: ${JSON.stringify(text)}`, () => expect(tok.decode(tok.encode(text), true)).toBe(text));
  }
  it('decodes added (location / task) tokens verbatim', () => {
    expect(tok.decode(bart.decode.ids)).toBe(bart.decode.text);
    expect(tok.encode('<od>car<loc_12><loc_500><loc_999><loc_12></od>')).toEqual(bart.decode.ids);
  });
  it('byte-level alphabet round-trips any UTF-8', () => {
    const s = 'naïve 😀 \t\n end';
    expect(fromByteLevel(toByteLevel(s))).toBe(s);
    expect(toByteLevel(' a')).toBe('Ġa');
  });
});
