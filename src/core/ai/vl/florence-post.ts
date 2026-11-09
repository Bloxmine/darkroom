/**
 * Florence-2 task prompts and answer parsing (pure; tested in florence-post.test.ts). Location tokens `<loc_N>` are
 * bins 0..999 over the (squashed 768²) image: coordinate = (N + 0.5) / 1000.
 */
import type { Box } from './boxes';

export const FLORENCE_TASKS = ['Caption', 'Detailed caption', 'More detailed caption', 'OCR', 'OCR with regions', 'Object detection', 'Phrase grounding'] as const;
export type FlorenceTask = (typeof FLORENCE_TASKS)[number];

const PROMPTS: Record<FlorenceTask, string> = {
  Caption: 'What does the image describe?',
  'Detailed caption': 'Describe in detail what is shown in the image.',
  'More detailed caption': 'Describe with a paragraph what is shown in the image.',
  OCR: 'What is the text in the image?',
  'OCR with regions': 'What is the text in the image, with regions?',
  'Object detection': 'Locate the objects with category name in the image.',
  'Phrase grounding': 'Locate the phrases in the caption: {input}',
};

/** Max new tokens per task (OCR / detection answers carry 4–8 location tokens per item). */
export const MAX_TOKENS: Record<FlorenceTask, number> = {
  Caption: 48,
  'Detailed caption': 160,
  'More detailed caption': 320,
  OCR: 512,
  'OCR with regions': 1024,
  'Object detection': 512,
  'Phrase grounding': 256,
};

export function florencePrompt(task: FlorenceTask, input = ''): string {
  return PROMPTS[task].replace('{input}', input.trim() || 'the main subject');
}

export interface FlorenceRegion {
  label: string;
  box?: Box;
  /** OCR quads: x0,y0 … x3,y3 (0..1). */
  quad?: number[];
}

export interface FlorenceAnswer {
  /** Plain text (captions, OCR) or the labels joined. */
  text: string;
  regions: FlorenceRegion[];
}

const loc = (n: string) => (Number(n) + 0.5) / 1000;
const clean = (s: string) => s.replace(/<\/?s>|<pad>/g, '');

/** Parse the decoded answer (with special tokens) for a task. */
export function parseFlorence(task: FlorenceTask, raw: string): FlorenceAnswer {
  const s = clean(raw);
  if (task === 'OCR with regions') {
    const regions: FlorenceRegion[] = [];
    for (const m of s.matchAll(/([^<]*?)((?:<loc_\d+>){8})/g)) {
      const n = [...m[2].matchAll(/<loc_(\d+)>/g)].map((x) => loc(x[1]));
      regions.push({ label: m[1].trim(), quad: n });
    }
    return { text: regions.map((r) => r.label).filter(Boolean).join('\n'), regions };
  }
  if (task === 'Object detection' || task === 'Phrase grounding') {
    const regions: FlorenceRegion[] = [];
    // "label<loc×4>[<loc×4>…]label2<loc×4>…": every group of four belongs to the preceding label
    for (const m of s.matchAll(/([^<]*)((?:<loc_\d+>){4,})/g)) {
      const label = m[1].trim();
      const n = [...m[2].matchAll(/<loc_(\d+)>/g)].map((x) => loc(x[1]));
      for (let i = 0; i + 3 < n.length; i += 4) regions.push({ label, box: [n[i], n[i + 1], n[i + 2], n[i + 3]] });
    }
    return { text: [...new Set(regions.map((r) => r.label))].join(', '), regions };
  }
  return { text: s.replace(/<[^>]+>/g, '').trim(), regions: [] };
}

/** A short project name from a caption: drop the article and the trailing period, capitalise, ≤ 60 chars. */
export function nameFromCaption(caption: string): string {
  let s = caption.trim().replace(/[.\s]+$/, '').replace(/^(a|an|the)\s+/i, '');
  if (s.length > 60) s = s.slice(0, 60).replace(/\s+\S*$/, '');
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}
