import { describe, expect, it } from 'vitest';
import { countFacets, facetValues, matchesFilters, NONE, type FacetItem } from './facets';

const day = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d, 12);
const items: FacetItem[] = [
  { name: 'a.jpg', mtime: 0, xmp: { rating: 5, label: 'Select', keywords: ['Places|Paris', 'sunset'] }, exif: { make: 'Canon', model: 'Canon EOS R5', lens: 'RF24-70mm', iso: 100, focalLength: 35, dateTaken: day(2024, 7, 9), width: 6000, height: 4000 } },
  { name: 'b.jpg', mtime: 0, xmp: { rating: 3, label: 'Red' }, exif: { make: 'Canon', model: 'Canon EOS R5', iso: 400, focalLength: 35, dateTaken: day(2024, 7, 9), width: 6000, height: 4000, orientation: 6 } },
  { name: 'c.NEF', mtime: 0, xmp: { rating: -1 }, exif: { make: 'NIKON CORPORATION', model: 'Z 6', iso: 400, focalLength: 50, dateTaken: day(2024, 7, 10), width: 3000, height: 3000 } },
  { name: 'd.png', mtime: new Date(2023, 0, 1).getTime(), xmp: { keywords: ['sunset'] }, exif: null },
  { name: 'Folder', dir: true, mtime: 0 },
];

describe('filter facets', () => {
  it('derives values', () => {
    expect(facetValues(items[0], 'keywords').sort()).toEqual(['Paris', 'Places', 'sunset']);
    expect(facetValues(items[1], 'label')).toEqual(['red']);
    expect(facetValues(items[1], 'orientation')).toEqual(['portrait']); // orientation 6 rotates 6000×4000
    expect(facetValues(items[2], 'camera')).toEqual(['NIKON Z 6']);
    expect(facetValues(items[2], 'rating')).toEqual(['reject']);
    expect(facetValues(items[3], 'label')).toEqual([NONE]);
    expect(facetValues(items[3], 'type')).toEqual(['PNG image']);
    expect(facetValues(items[3], 'date')).toEqual(['2023-01-01']);
    expect(facetValues(items[3], 'camera')).toEqual([]);
  });

  it('counts every value without filters (folders excluded)', () => {
    const c = countFacets(items, {});
    const get = (f: keyof typeof c, v: string) => c[f].find((x) => x.value === v)?.count;
    expect(get('rating', '5')).toBe(1);
    expect(get('rating', '0')).toBe(1);
    expect(get('rating', 'reject')).toBe(1);
    expect(get('label', 'red')).toBe(2); // "Select" and Lightroom's "Red" are the same label
    expect(get('label', NONE)).toBe(2);
    expect(get('keywords', 'sunset')).toBe(2);
    expect(get('iso', '400')).toBe(2);
    expect(get('type', 'JPEG file')).toBe(2);
    expect(get('date', '2024-07-09')).toBe(2);
    expect(c.rating.map((r) => r.label)).toEqual(['No Rating', '★★★', '★★★★★', 'Rejected']);
    expect(c.date[0].value).toBe('2024-07-10'); // newest first
  });

  it('ORs within a facet, ANDs across facets, and counts other facets against the selection', () => {
    const filters = { iso: ['400'] };
    expect(items.filter((i) => matchesFilters(i, filters)).map((i) => i.name)).toEqual(['b.jpg', 'c.NEF']);
    const c = countFacets(items, filters);
    // ISO's own counts ignore the ISO selection, so 100 stays tickable
    expect(c.iso.find((x) => x.value === '100')?.count).toBe(1);
    // other facets only count ISO 400 items
    expect(c.camera.map((x) => [x.value, x.count])).toEqual([
      ['Canon EOS R5', 1],
      ['NIKON Z 6', 1],
    ]);
    const both = { iso: ['400', '100'], camera: ['Canon EOS R5'] };
    expect(items.filter((i) => matchesFilters(i, both)).map((i) => i.name)).toEqual(['a.jpg', 'b.jpg']);
    // folders show only when nothing is filtered
    expect(matchesFilters(items[4], {})).toBe(true);
    expect(matchesFilters(items[4], filters)).toBe(false);
  });

  it('keeps ticked values listed when they drop to zero', () => {
    const c = countFacets(items, { rating: ['5'], iso: ['400'] });
    expect(c.rating.find((x) => x.value === '5')?.count).toBe(0);
    expect(c.iso.find((x) => x.value === '400')?.count).toBe(0);
  });
});
