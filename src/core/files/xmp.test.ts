import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { labelColor, newSidecar, parseXmp, writeXmp, mergeXmp } from './xmp';

const fixture = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const NOW = new Date(2026, 10, 11, 12, 30, 0);

describe('XMP sidecars', () => {
  it('round-trips a new sidecar', () => {
    const data = { rating: 4, label: 'Select', keywords: ['Places|France|Paris', 'sunset'], title: 'Eiffel <tower> & "co"', description: 'Line one', creator: 'A. Person; B. Person', copyright: '© 2026' };
    const xml = newSidecar(data, NOW);
    expect(xml).toContain('xmp:Rating="4"');
    expect(xml).toContain('xmp:Label="Select"');
    expect(xml).toContain('<lr:hierarchicalSubject>');
    expect(xml).toContain('<rdf:li>France</rdf:li>');
    expect(xml).toMatch(/xmp:MetadataDate="2026-11-11T12:30:00[+-]\d\d:\d\d"/);
    const back = parseXmp(xml);
    expect(back).toEqual(data);
  });

  it('writes Reject as -1 and omits an unrated rating', () => {
    expect(parseXmp(newSidecar({ rating: -1 })).rating).toBe(-1);
    expect(newSidecar({ rating: 0 })).not.toContain('Rating');
    expect(parseXmp(newSidecar({ rating: 0 })).rating).toBeUndefined();
  });

  it('reads a Bridge CS3 sidecar (element form, xap prefix, separate Descriptions)', () => {
    const d = parseXmp(fixture('bridge-cs3.xmp'));
    expect(d.rating).toBe(4);
    expect(d.label).toBe('Approved');
    expect(labelColor(d.label)).toBe('green');
    expect(d.title).toBe('Canal at dusk');
    expect(d.description).toBe('Herengracht, looking south & west');
    expect(d.creator).toBe('Jan de Vries');
    expect(d.copyright).toBe('© 2008 Jan de Vries');
    expect(d.keywords?.sort()).toEqual(['Places|Amsterdam', 'canal', 'dusk']);
  });

  it('updates a Bridge sidecar in place and keeps foreign properties', () => {
    const src = fixture('bridge-cs3.xmp');
    const cur = parseXmp(src);
    const out = writeXmp(src, { ...cur, rating: 2, label: 'Review', keywords: [...cur.keywords!, 'water'] }, NOW);
    const d = parseXmp(out);
    expect(d.rating).toBe(2);
    expect(d.label).toBe('Review');
    expect(d.keywords?.sort()).toEqual(['Places|Amsterdam', 'canal', 'dusk', 'water']);
    expect(d.title).toBe('Canal at dusk');
    // untouched: Camera Raw settings, tiff/exif, photoshop, xap dates other than MetadataDate
    for (const keep of ['<crs:Exposure>+0.35</crs:Exposure>', '<tiff:Model>Canon EOS 30D</tiff:Model>', '<photoshop:City>Amsterdam</photoshop:City>', '<xap:CreateDate>2008-03-14T15:09:26+01:00</xap:CreateDate>', '<rdf:li>400</rdf:li>'])
      expect(out).toContain(keep);
    // old values gone (no duplicate Rating / Label)
    expect(out).not.toContain('<xap:Rating>');
    expect(out).not.toContain('Approved');
    expect(out.match(/:Rating\b/g)).toHaveLength(1);
    expect(out.match(/<dc:subject>/g)).toHaveLength(1);
    // still a well-formed packet: every opened Description is closed
    expect(out.match(/<rdf:Description\b/g)!.length).toBe(out.match(/<\/rdf:Description>/g)!.length);
  });

  it('reads and updates a Lightroom sidecar (attribute form, self-closing Description)', () => {
    const src = fixture('lightroom-attrs.xmp');
    expect(parseXmp(src)).toEqual({ rating: -1, label: 'Red' });
    expect(labelColor('Red')).toBe('red');
    const out = writeXmp(src, { rating: 5, keywords: ['a'] }, NOW);
    expect(parseXmp(out)).toEqual({ rating: 5, keywords: ['a'] });
    expect(out).toContain('crs:Exposure2012="+0.50"');
    expect(out).toContain('</rdf:Description>');
    expect(out).not.toContain('Label');
  });

  it('refuses to overwrite something that is not XMP', () => {
    expect(() => writeXmp('hello world', { rating: 1 })).toThrow(/not an XMP/);
    expect(parseXmp('garbage <<<')).toEqual({});
  });

  it('merges sidecar over embedded XMP', () => {
    expect(mergeXmp({ rating: 1, title: 'a' }, { rating: 3 })).toEqual({ rating: 3, title: 'a' });
    expect(mergeXmp({ rating: 1 }, null)).toEqual({ rating: 1 });
  });
});
