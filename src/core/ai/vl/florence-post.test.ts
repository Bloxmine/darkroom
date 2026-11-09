import { describe, expect, it } from 'vitest';
import { florencePrompt, nameFromCaption, parseFlorence } from './florence-post';

describe('Florence-2 answers', () => {
  it('cleans plain text', () => {
    expect(parseFlorence('Caption', '</s><s>A woman sitting in a boat on a lake.</s>').text).toBe('A woman sitting in a boat on a lake.');
  });
  it('parses detection boxes (several boxes per label)', () => {
    // decoded on street.jpg by the Python reference pipeline
    const raw = '</s><s>boat<loc_0><loc_0><loc_998><loc_998>human face<loc_434><loc_352><loc_460><loc_445>paddle<loc_589><loc_535><loc_736><loc_657>person<loc_399><loc_313><loc_617><loc_998>person<loc_1><loc_2><loc_3><loc_4><loc_5><loc_6><loc_7><loc_8></s>';
    const a = parseFlorence('Object detection', raw);
    expect(a.regions.length).toBe(6);
    expect(a.regions[2].label).toBe('paddle');
    expect(a.regions[2].box).toEqual([0.5895, 0.5355, 0.7365, 0.6575]);
    expect(a.regions[5].label).toBe('person');
    expect(a.regions[5].box).toEqual([0.0055, 0.0065, 0.0075, 0.0085]);
    expect(a.text).toBe('boat, human face, paddle, person');
  });
  it('parses OCR quads', () => {
    const a = parseFlorence('OCR with regions', '</s><s>DARKROOM CAFE<loc_1><loc_2><loc_3><loc_2><loc_3><loc_4><loc_1><loc_4>2.50<loc_10><loc_10><loc_20><loc_10><loc_20><loc_20><loc_10><loc_20></s>');
    expect(a.text).toBe('DARKROOM CAFE\n2.50');
    expect(a.regions[1].quad?.[2]).toBeCloseTo(0.0205, 6);
  });
  it('builds prompts and project names', () => {
    expect(florencePrompt('Phrase grounding', ' the paddle ')).toBe('Locate the phrases in the caption: the paddle');
    expect(nameFromCaption('A woman sitting in a boat on a lake.')).toBe('Woman sitting in a boat on a lake');
  });
});
