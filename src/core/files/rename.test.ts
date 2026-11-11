import { describe, expect, it } from 'vitest';
import { buildName, formatDate, planRenames, seqLetter, type RenameFile, type RenamePart } from './rename';
import { renamedSidecar, sidecarName } from './sidecar';

const taken = Date.UTC(2024, 6, 9, 18, 5, 7); // EXIF wall clock 2024-07-09 18:05:07
const f = (name: string, extra: Partial<RenameFile> = {}): RenameFile => ({ path: `/p/${name}`, name, dir: '/p/Trip', mtime: Date.UTC(2025, 0, 2), ...extra });

describe('batch rename patterns', () => {
  it('builds names from text, sequence, date, name, folder and EXIF', () => {
    const parts: RenamePart[] = [
      { type: 'text', text: 'Trip_' },
      { type: 'date', source: 'taken', format: 'YYYY-MM-DD_hhmmss' },
      { type: 'text', text: '_' },
      { type: 'seq', start: 7, digits: 4 },
      { type: 'text', text: '_' },
      { type: 'name', case: 'lower' },
      { type: 'text', text: '_' },
      { type: 'meta', field: 'model' },
      { type: 'text', text: '_' },
      { type: 'meta', field: 'shutter' },
      { type: 'text', text: '_' },
      { type: 'folder' },
    ];
    const file = f('IMG_0001.CR2', { exif: { dateTaken: taken, model: 'EOS R5', exposureTime: 1 / 250 } });
    expect(buildName(parts, file, 2)).toBe('Trip_2024-07-09_180507_0009_img_0001_EOS R5_1-250_Trip.CR2');
    expect(buildName([{ type: 'letter' }], file, 27, { ext: 'lower' })).toBe('ab.cr2');
    expect(seqLetter(0)).toBe('a');
    expect(seqLetter(25)).toBe('z');
    expect(seqLetter(26)).toBe('aa');
  });

  it('falls back to the file date when there is no EXIF date', () => {
    const file = f('a.jpg', { mtime: new Date(2023, 1, 3, 4, 5, 6).getTime() });
    expect(buildName([{ type: 'date', source: 'modified', format: 'YYYYMMDD' }], file, 0)).toBe('20230203.jpg');
    expect(formatDate(new Date(2023, 1, 3, 4, 5, 6).getTime(), 'YY.MM.DD hh-mm-ss')).toBe('23.02.03 04-05-06');
  });

  it('strips characters a file name cannot contain', () => {
    expect(buildName([{ type: 'text', text: 'a/b:c*?' }], f('x.png'), 0)).toBe('a-b-c-.png');
  });

  it('detects duplicates in the batch (case-insensitive) and existing files', () => {
    const files = [f('a.jpg'), f('b.jpg'), f('c.jpg')];
    const siblings = () => ['a.jpg', 'b.jpg', 'c.jpg', 'Photo.jpg', 'keep.jpg'];
    // the same fixed name for everyone → all duplicates
    const dup = planRenames(files, [{ type: 'text', text: 'x' }], {}, siblings);
    expect(dup.every((p) => p.problem === 'Duplicate name in this batch')).toBe(true);
    // 'photo' collides with an existing, not-renamed file (case-insensitive)
    const one = planRenames([files[0]], [{ type: 'text', text: 'photo' }], {}, siblings);
    expect(one[0].problem).toBe('A file with this name already exists');
    // renaming onto a name that another batch item vacates is fine (a→b, b→c, c→a style rotations)
    const rot = planRenames(files, [{ type: 'seq', start: 1, digits: 1 }], {}, () => ['a.jpg', 'b.jpg', 'c.jpg', '2.jpg']);
    expect(rot.map((p) => p.to)).toEqual(['1.jpg', '2.jpg', '3.jpg']);
    expect(rot[1].problem).toBe('A file with this name already exists');
    const swap = planRenames([f('1.jpg'), f('2.jpg')], [{ type: 'seq', start: 2, digits: 1 }], {}, () => ['1.jpg', '2.jpg']);
    expect(swap.map((p) => [p.to, p.problem])).toEqual([
      ['2.jpg', undefined],
      ['3.jpg', undefined],
    ]);
  });

  it('flags empty names and allows unchanged / case-only renames', () => {
    expect(planRenames([f('a.jpg')], [{ type: 'text', text: '  ' }], {}, () => ['a.jpg'])[0].problem).toBe('Empty or hidden name');
    const same = planRenames([f('a.jpg')], [{ type: 'name' }], {}, () => ['a.jpg'])[0];
    expect(same.same).toBe(true);
    expect(same.problem).toBeUndefined();
    const upper = planRenames([f('a.jpg')], [{ type: 'name', case: 'upper' }], {}, () => ['a.jpg'])[0];
    expect(upper.to).toBe('A.jpg');
    expect(upper.problem).toBeUndefined();
  });

  it('checks conflicts per folder', () => {
    const files = [f('a.jpg', { dir: '/one', path: '/one/a.jpg' }), f('a.jpg', { dir: '/two', path: '/two/a.jpg' })];
    const plan = planRenames(files, [{ type: 'text', text: 'same' }], {}, () => ['a.jpg']);
    expect(plan.map((p) => p.problem)).toEqual([undefined, undefined]);
  });
});

describe('sidecar names', () => {
  it('uses <stem>.xmp, except for the non-RAW half of a RAW+JPEG pair', () => {
    expect(sidecarName('IMG_1.CR2', ['IMG_1.CR2', 'IMG_1.JPG'])).toBe('IMG_1.xmp');
    expect(sidecarName('IMG_1.JPG', ['IMG_1.CR2', 'IMG_1.JPG', 'IMG_1.xmp'])).toBe('IMG_1.JPG.xmp');
    expect(sidecarName('solo.jpg', ['solo.jpg', 'solo.xmp'])).toBe('solo.xmp');
    expect(renamedSidecar('IMG_1.xmp', 'IMG_1.CR2', 'Trip_1.CR2')).toBe('Trip_1.xmp');
    expect(renamedSidecar('IMG_1.JPG.xmp', 'IMG_1.JPG', 'x.JPG')).toBe('x.JPG.xmp');
    expect(renamedSidecar('other.xmp', 'IMG_1.JPG', 'x.JPG')).toBeNull();
  });
});
