/**
 * XMP sidecars (Adobe convention: `<name>.xmp` next to the photo), read and written
 * without a DOM so the same code runs in the renderer, the Electron main process and
 * tests. Only the properties Bridge / Lightroom use for culling and IPTC Core basics
 * are managed:
 *
 *   xmp:Rating               0–5, −1 = Reject
 *   xmp:Label                colour label by Bridge's names (Select, Second, Approved, Review, To Do)
 *   xmp:MetadataDate         updated on every write (Lightroom uses it to detect changes)
 *   dc:subject               keywords (rdf:Bag), every level of hierarchical keywords
 *   lr:hierarchicalSubject   hierarchical keywords as "Parent|Child" (rdf:Bag)
 *   dc:title, dc:description, dc:rights   (rdf:Alt, x-default)
 *   dc:creator               (rdf:Seq)
 *
 * Updating an existing sidecar only replaces those properties: everything else (Camera Raw
 * settings, history, other namespaces) is kept byte-for-byte.
 */

export const NS = {
  x: 'adobe:ns:meta/',
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  xmp: 'http://ns.adobe.com/xap/1.0/',
  dc: 'http://purl.org/dc/elements/1.1/',
  lr: 'http://ns.adobe.com/lightroom/1.0/',
} as const;

export type LabelColor = 'red' | 'yellow' | 'green' | 'blue' | 'purple';

/** Bridge's default label names (Preferences › Labels) and their colours; 6–9 are Bridge's shortcuts. */
export const LABELS: { color: LabelColor; name: string; css: string; key?: string }[] = [
  { color: 'red', name: 'Select', css: '#d8302f', key: '6' },
  { color: 'yellow', name: 'Second', css: '#e8c21c', key: '7' },
  { color: 'green', name: 'Approved', css: '#3f9a3a', key: '8' },
  { color: 'blue', name: 'Review', css: '#2f66d0', key: '9' },
  { color: 'purple', name: 'To Do', css: '#8b45b8' },
];

/** Label text (Bridge names, Lightroom colour names, any case) → colour, or null for custom/none. */
export function labelColor(label: string | undefined | null): LabelColor | null {
  if (!label) return null;
  const l = label.trim().toLowerCase();
  for (const x of LABELS) if (l === x.name.toLowerCase() || l === x.color) return x.color;
  return null;
}

export const labelName = (c: LabelColor) => LABELS.find((x) => x.color === c)!.name;

export interface XmpData {
  /** 0–5, −1 = Reject. Undefined/0 = unrated. */
  rating?: number;
  /** Label text as stored (Bridge writes the label name, e.g. "Select"). */
  label?: string;
  /** Keywords; hierarchical ones as "Parent|Child". */
  keywords?: string[];
  title?: string;
  description?: string;
  creator?: string;
  copyright?: string;
}

// ---------------------------------------------------------------------------
// XML helpers (just enough for RDF/XML as written by Adobe apps, exiftool, Lightroom, darktable)
// ---------------------------------------------------------------------------

const decode = (s: string) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

export const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** All prefixes bound to `uri` anywhere in the document (plus the conventional one as a fallback). */
function prefixes(xml: string, uri: string, conventional: string): string[] {
  const out = new Set<string>();
  const re = new RegExp(`xmlns:([\\w.-]+)\\s*=\\s*["']${reEsc(uri)}["']`, 'g');
  for (const m of xml.matchAll(re)) out.add(m[1]);
  // old Adobe files bind xmp as "xap"; tolerate files that forgot the declaration
  if (!out.size) out.add(conventional);
  return [...out];
}

/** Text of an attribute-form property `pfx:local="…"`, or of a simple element `<pfx:local>…</pfx:local>`. */
function readSimple(xml: string, pfxs: string[], local: string): string | undefined {
  for (const p of pfxs) {
    const q = `${reEsc(p)}:${reEsc(local)}`;
    const a = new RegExp(`\\s${q}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(xml);
    if (a) return decode(a[1] ?? a[2] ?? '');
    const e = new RegExp(`<${q}(?:\\s[^>]*)?>([\\s\\S]*?)</${q}>`).exec(xml);
    if (e && !/<\w[\w.-]*:li\b/.test(e[1])) return decode(e[1].trim());
  }
  return undefined;
}

/** rdf:li values of a container property (Bag/Seq/Alt). Alt: the x-default (or first) item only. */
function readList(xml: string, pfxs: string[], local: string, rdf: string[]): { items: string[]; langs: (string | undefined)[] } | undefined {
  for (const p of pfxs) {
    const q = `${reEsc(p)}:${reEsc(local)}`;
    const e = new RegExp(`<${q}(?:\\s[^>]*)?>([\\s\\S]*?)</${q}>`).exec(xml);
    if (!e) {
      const a = new RegExp(`\\s${q}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(xml); // a single value written as an attribute
      if (a) return { items: [decode(a[1] ?? a[2] ?? '')], langs: [undefined] };
      continue;
    }
    const items: string[] = [];
    const langs: (string | undefined)[] = [];
    for (const r of rdf) {
      const li = new RegExp(`<${reEsc(r)}:li\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${reEsc(r)}:li>)`, 'g');
      for (const m of e[1].matchAll(li)) {
        items.push(decode((m[2] ?? '').trim()));
        langs.push(/xml:lang\s*=\s*["']([^"']*)["']/.exec(m[1])?.[1]);
      }
    }
    if (!items.length && e[1].trim() && !/</.test(e[1])) return { items: [decode(e[1].trim())], langs: [undefined] };
    return { items, langs };
  }
  return undefined;
}

const altValue = (l: ReturnType<typeof readList>) => {
  if (!l || !l.items.length) return undefined;
  const i = l.langs.indexOf('x-default');
  return l.items[i >= 0 ? i : 0];
};

/** Parse the managed properties out of an XMP packet / sidecar. Never throws (garbage → {}). */
export function parseXmp(xml: string | null | undefined): XmpData {
  if (!xml || typeof xml !== 'string') return {};
  const out: XmpData = {};
  const xmp = prefixes(xml, NS.xmp, 'xmp');
  const dc = prefixes(xml, NS.dc, 'dc');
  const lr = prefixes(xml, NS.lr, 'lr');
  const rdf = prefixes(xml, NS.rdf, 'rdf');

  const rating = readSimple(xml, xmp, 'Rating');
  if (rating !== undefined && rating !== '') {
    const r = Math.round(Number(rating));
    if (Number.isFinite(r)) out.rating = Math.max(-1, Math.min(5, r));
  }
  const label = readSimple(xml, xmp, 'Label');
  if (label) out.label = label;

  const subject = readList(xml, dc, 'subject', rdf)?.items.filter(Boolean) ?? [];
  const hier = readList(xml, lr, 'hierarchicalSubject', rdf)?.items.filter(Boolean) ?? [];
  if (subject.length || hier.length) {
    const parts = new Set(hier.flatMap((h) => h.split('|')));
    const kw = [...hier, ...subject.filter((s) => !parts.has(s))];
    out.keywords = [...new Set(kw)];
  }
  const title = altValue(readList(xml, dc, 'title', rdf));
  if (title) out.title = title;
  const desc = altValue(readList(xml, dc, 'description', rdf));
  if (desc) out.description = desc;
  const rights = altValue(readList(xml, dc, 'rights', rdf));
  if (rights) out.copyright = rights;
  const creator = readList(xml, dc, 'creator', rdf)?.items.filter(Boolean);
  if (creator?.length) out.creator = creator.join('; ');
  return out;
}

/** Sidecar values win over the embedded XMP of the file. */
export function mergeXmp(embedded: XmpData, sidecar: XmpData | null): XmpData {
  return sidecar ? { ...embedded, ...Object.fromEntries(Object.entries(sidecar).filter(([, v]) => v !== undefined)) } : embedded;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

const MANAGED: [keyof typeof NS, string][] = [
  ['xmp', 'Rating'],
  ['xmp', 'Label'],
  ['xmp', 'MetadataDate'],
  ['dc', 'subject'],
  ['dc', 'title'],
  ['dc', 'description'],
  ['dc', 'creator'],
  ['dc', 'rights'],
  ['lr', 'hierarchicalSubject'],
];

/** ISO 8601 with the local UTC offset, as Adobe apps write it. */
export function xmpDate(d = new Date()): string {
  const pad = (n: number) => String(Math.abs(Math.trunc(n))).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${off >= 0 ? '+' : '-'}${pad(off / 60)}:${pad(off % 60)}`;
}

function normalize(d: XmpData): XmpData {
  const kw = [...new Set((d.keywords ?? []).map((k) => k.trim()).filter(Boolean))];
  return {
    rating: d.rating === undefined ? undefined : Math.max(-1, Math.min(5, Math.round(d.rating))),
    label: d.label?.trim() || undefined,
    keywords: kw.length ? kw : undefined,
    title: d.title?.trim() || undefined,
    description: d.description?.trim() || undefined,
    creator: d.creator?.trim() || undefined,
    copyright: d.copyright?.trim() || undefined,
  };
}

function managedAttrs(d: XmpData, date: string): string[] {
  const a: string[] = [];
  if (d.rating !== undefined && d.rating !== 0) a.push(`xmp:Rating="${d.rating}"`);
  if (d.label) a.push(`xmp:Label="${escapeXml(d.label)}"`);
  a.push(`xmp:MetadataDate="${date}"`);
  return a;
}

function managedElements(d: XmpData, ind: string): string {
  const li = (v: string, lang = false) => `${ind}   <rdf:li${lang ? ' xml:lang="x-default"' : ''}>${escapeXml(v)}</rdf:li>\n`;
  const block = (name: string, kind: 'Bag' | 'Seq' | 'Alt', vals: string[]) =>
    `${ind}<${name}>\n${ind}  <rdf:${kind}>\n${vals.map((v) => li(v, kind === 'Alt')).join('')}${ind}  </rdf:${kind}>\n${ind}</${name}>\n`;
  let s = '';
  if (d.title) s += block('dc:title', 'Alt', [d.title]);
  if (d.description) s += block('dc:description', 'Alt', [d.description]);
  if (d.creator)
    s += block(
      'dc:creator',
      'Seq',
      d.creator
        .split(/\s*;\s*/)
        .filter(Boolean),
    );
  if (d.copyright) s += block('dc:rights', 'Alt', [d.copyright]);
  if (d.keywords?.length) {
    const flat = [...new Set(d.keywords.flatMap((k) => k.split('|').map((x) => x.trim()).filter(Boolean)))];
    s += block('dc:subject', 'Bag', flat);
    const hier = d.keywords.filter((k) => k.includes('|'));
    if (hier.length) s += block('lr:hierarchicalSubject', 'Bag', hier);
  }
  return s;
}

const NS_DECL = `xmlns:xmp="${NS.xmp}"\n    xmlns:dc="${NS.dc}"\n    xmlns:lr="${NS.lr}"`;

/** A complete new sidecar. */
export function newSidecar(data: XmpData, now = new Date()): string {
  const d = normalize(data);
  const attrs = managedAttrs(d, xmpDate(now))
    .map((a) => `\n    ${a}`)
    .join('');
  return (
    `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n` +
    `<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Darkroom">\n` +
    ` <rdf:RDF xmlns:rdf="${NS.rdf}">\n` +
    `  <rdf:Description rdf:about=""\n    ${NS_DECL}${attrs}>\n` +
    managedElements(d, '   ') +
    `  </rdf:Description>\n` +
    ` </rdf:RDF>\n` +
    `</x:xmpmeta>\n` +
    `<?xpacket end="w"?>\n`
  );
}

/**
 * Write `data` into an existing sidecar (or a new one when `existing` is null/blank).
 * The managed properties are replaced as a whole: pass the complete desired state
 * (e.g. `{...parseXmp(existing), rating: 3}`). Throws on text that isn't XMP so a
 * foreign file is never clobbered.
 */
export function writeXmp(existing: string | null | undefined, data: XmpData, now = new Date()): string {
  if (!existing || !existing.trim()) return newSidecar(data, now);
  const rdf = prefixes(existing, NS.rdf, 'rdf');
  const descRe = new RegExp(`<(${rdf.map(reEsc).join('|')}):Description\\b([^>]*?)(/?)>`);
  const first = descRe.exec(existing);
  if (!first) throw new Error('not an XMP file (no rdf:Description)');
  let xml = existing;
  // drop every managed property (attribute and element forms, any bound prefix)
  for (const [ns, local] of MANAGED) {
    for (const p of prefixes(xml, NS[ns], ns)) {
      const q = `${reEsc(p)}:${reEsc(local)}`;
      xml = xml.replace(new RegExp(`\\s+${q}\\s*=\\s*(?:"[^"]*"|'[^']*')`, 'g'), '');
      xml = xml.replace(new RegExp(`[ \\t]*<${q}(?:\\s[^>]*)?/>[ \\t]*\\r?\\n?`, 'g'), '');
      xml = xml.replace(new RegExp(`[ \\t]*<${q}(?:\\s[^>]*)?>[\\s\\S]*?</${q}>[ \\t]*\\r?\\n?`, 'g'), '');
    }
  }
  const m = descRe.exec(xml)!;
  const [tag, rdfP, attrs, selfClose] = m;
  const d = normalize(data);
  const decl = (pfx: string, uri: string) => (new RegExp(`xmlns:${pfx}\\s*=\\s*["']${reEsc(uri)}["']`).test(xml) ? '' : `\n    xmlns:${pfx}="${uri}"`);
  const newAttrs =
    decl('xmp', NS.xmp) +
    decl('dc', NS.dc) +
    (d.keywords?.some((k) => k.includes('|')) ? decl('lr', NS.lr) : '') +
    managedAttrs(d, xmpDate(now))
      .map((a) => `\n    ${a}`)
      .join('');
  const ind = /\n([ \t]*)<[\w.-]+:Description/.exec(xml)?.[1] ?? '  ';
  const elems = managedElements(d, ind + ' ');
  const open = `<${rdfP}:Description${attrs.replace(/\s+$/, '')}${newAttrs}>`;
  const replacement = selfClose ? `${open}\n${elems}${ind}</${rdfP}:Description>` : `${open}\n${elems}`;
  let out = xml.slice(0, m.index) + replacement + xml.slice(m.index + tag.length).replace(/^\r?\n/, selfClose ? '' : '');
  out = out.replace(/\n{3,}/g, '\n\n');
  return out;
}

/** The managed fields as they would round-trip (for comparing / "is anything set"). */
export const isEmptyXmp = (d: XmpData) => !d.rating && !d.label && !d.keywords?.length && !d.title && !d.description && !d.creator && !d.copyright;
