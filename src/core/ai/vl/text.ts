/**
 * Tokenizer loading: the tokenizer.json files are fetched once through the model cache (runtime.download, Cache
 * Storage `darkroom-models`), so text prompts work offline after first use.
 */
import { TOKENIZERS } from '../models-vl';
import { download } from '../runtime';
import { ByteBpeTokenizer, ClipTokenizer, type TokenizerJson } from './tokenizer';

let clipP: Promise<ClipTokenizer> | null = null;
let floP: Promise<ByteBpeTokenizer> | null = null;

async function json(t: { label: string; url: string; bytes: number }): Promise<TokenizerJson> {
  return JSON.parse(new TextDecoder().decode(await download(t.label, t.url, t.bytes))) as TokenizerJson;
}

export function clipTokenizer(): Promise<ClipTokenizer> {
  return (clipP ??= json(TOKENIZERS.clip).then((j) => new ClipTokenizer(j)).catch((e) => ((clipP = null), Promise.reject(e))));
}

export function florenceTokenizer(): Promise<ByteBpeTokenizer> {
  return (floP ??= json(TOKENIZERS.florence).then((j) => new ByteBpeTokenizer(j)).catch((e) => ((floP = null), Promise.reject(e))));
}
