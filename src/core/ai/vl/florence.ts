/**
 * Florence-2 base (MIT): captioning, OCR, object detection and phrase grounding in the browser.
 * Pipeline (as transformers' Florence2ForConditionalGeneration):
 *   pixel_values (768², ImageNet norm) → vision encoder → 577 image tokens
 *   [image tokens, embed(prompt ids)] → BART encoder
 *   decoder loop with KV cache (merged decoder; its bool `use_cache_branch` input is re-typed to float by castInputs()
 *   because the session host only sends float32 / int64), greedy with no-repeat-3-gram (the model's generation config
 *   uses 3 beams; greedy is 3× cheaper and gave the same captions on the samples).
 * The image encoding is memoised per image; answers are memoised per image + task + input text.
 */
import '../models-vl';
import { fingerprint, InferenceMemo, resampleRGB, throwIfAborted } from '../image';
import { runModelMulti } from '../runtime';
import type { TensorData } from '../session';
import type { RawTex } from '../../types';
import { florencePrompt, MAX_TOKENS, parseFlorence, type FlorenceAnswer, type FlorenceTask } from './florence-post';
import { florenceTokenizer } from './text';

const SIZE = 768;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
const LAYERS = 6;
const HEADS = 12;
const HD = 64;
const D_MODEL = 768;
const DEC_START = 2;
const BOS = 0;
const EOS = 2;

const memo = new InferenceMemo<TensorData>(3);
const answers = new WeakMap<TensorData, Map<string, Promise<FlorenceResult>>>();

export interface FlorenceResult extends FlorenceAnswer {
  raw: string;
  tokens: number;
  ms: number;
}

/** Vision features [1, 577, 768] of the image squashed to 768², memoised by content. */
export function florenceImage(src: RawTex, signal?: AbortSignal): Promise<TensorData> {
  const rgb = resampleRGB(src.data, src.width, src.height, SIZE, SIZE);
  return memo.get(
    'florence2',
    fingerprint(rgb, SIZE, SIZE),
    Math.min(src.width, src.height),
    SIZE,
    async () => {
      const n = SIZE * SIZE;
      const px = new Float32Array(3 * n);
      for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) px[c * n + i] = (rgb[i * 3 + c] - MEAN[c]) / STD[c];
      const r = await runModelMulti('florence2-vision', { pixel_values: { data: px, dims: [1, 3, SIZE, SIZE] } }, ['image_features']);
      if (!r.image_features) throw new Error('Florence-2 vision encoder returned nothing');
      return r.image_features;
    },
    signal,
  );
}

async function embed(ids: number[]): Promise<TensorData> {
  const r = await runModelMulti('florence2-embed', { input_ids: { data: Float32Array.from(ids), dims: [1, ids.length], type: 'int64' } }, ['inputs_embeds']);
  return r.inputs_embeds;
}

const pastNames: string[] = [];
for (let l = 0; l < LAYERS; l++) for (const k of ['decoder.key', 'decoder.value', 'encoder.key', 'encoder.value']) pastNames.push(`past_key_values.${l}.${k}`);

async function generate(feat: TensorData, prompt: string, maxNew: number, signal?: AbortSignal, onToken?: (n: number) => void): Promise<number[]> {
  const tok = await florenceTokenizer();
  const ids = tok.encode(prompt);
  const te = await embed(ids);
  const nImg = feat.dims[1], nTxt = ids.length, L = nImg + nTxt;
  const emb = new Float32Array(L * D_MODEL);
  emb.set(feat.data.subarray(0, nImg * D_MODEL), 0);
  emb.set(te.data.subarray(0, nTxt * D_MODEL), nImg * D_MODEL);
  const mask = new Float32Array(L).fill(1);
  const enc = await runModelMulti('florence2-encoder', { inputs_embeds: { data: emb, dims: [1, L, D_MODEL] }, attention_mask: { data: mask.slice(), dims: [1, L], type: 'int64' } }, ['last_hidden_state']);
  const hidden = enc.last_hidden_state;
  if (!hidden) throw new Error('Florence-2 encoder returned nothing');

  const past: Record<string, TensorData> = {};
  for (const n of pastNames) past[n] = { data: new Float32Array(0), dims: [1, HEADS, 0, HD] };
  const seq = [DEC_START];
  const decOut = ['logits', ...pastNames.filter((n) => n.includes('.decoder.')).map((n) => n.replace('past_key_values', 'present'))];
  const allOut = ['logits', ...pastNames.map((n) => n.replace('past_key_values', 'present'))];
  for (let step = 0; step < maxNew; step++) {
    throwIfAborted(signal);
    const e = await embed([seq[seq.length - 1]]);
    const feeds: Record<string, TensorData> = {
      inputs_embeds: e,
      encoder_hidden_states: { data: hidden.data.slice(), dims: hidden.dims },
      encoder_attention_mask: { data: mask.slice(), dims: [1, L], type: 'int64' },
      use_cache_branch: { data: Float32Array.of(step > 0 ? 1 : 0), dims: [1] },
    };
    for (const n of pastNames) feeds[n] = { data: past[n].data.slice(), dims: past[n].dims };
    const r = await runModelMulti('florence2-decoder', feeds, step === 0 ? allOut : decOut);
    for (const n of pastNames) {
      const p = r[n.replace('past_key_values', 'present')];
      if (p && (step === 0 || n.includes('.decoder.'))) past[n] = p;
    }
    const lo = r.logits;
    const V = lo.dims[lo.dims.length - 1];
    const off = lo.data.length - V;
    let next: number;
    if (step === 0) next = BOS; // forced_bos_token_id
    else {
      // no_repeat_ngram_size = 3: ban tokens that would repeat a trigram
      const ban = new Set<number>();
      const a = seq[seq.length - 2], b = seq[seq.length - 1];
      for (let i = 0; i + 2 < seq.length; i++) if (seq[i] === a && seq[i + 1] === b) ban.add(seq[i + 2]);
      next = -1;
      let best = -Infinity;
      for (let v = 0; v < V; v++) {
        const x = lo.data[off + v];
        if (x > best && !ban.has(v)) {
          best = x;
          next = v;
        }
      }
    }
    seq.push(next);
    onToken?.(seq.length - 1);
    if (next === EOS) break;
  }
  return seq;
}

/** Run one task on an encoded image (memoised per image + task + input). */
export function florenceRun(feat: TensorData, task: FlorenceTask, input = '', signal?: AbortSignal, onToken?: (n: number) => void): Promise<FlorenceResult> {
  let m = answers.get(feat);
  if (!m) answers.set(feat, (m = new Map()));
  const key = `${task}\u0000${task === 'Phrase grounding' ? input.trim() : ''}`;
  let p = m.get(key);
  if (!p) {
    p = (async () => {
      const t0 = performance.now();
      const seq = await generate(feat, florencePrompt(task, input), MAX_TOKENS[task], signal, onToken);
      const tok = await florenceTokenizer();
      const raw = tok.decode(seq);
      console.info(`[darkroom ai] Florence-2 ${task}: ${seq.length - 1} tokens in ${(performance.now() - t0).toFixed(0)} ms`);
      return { ...parseFlorence(task, raw), raw, tokens: seq.length - 1, ms: performance.now() - t0 };
    })();
    p.catch(() => m!.delete(key));
    m.set(key, p);
  }
  return p;
}
