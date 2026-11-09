/**
 * In-app documentation: the repo's Markdown docs are bundled with the app (Vite `?raw` glob), so the
 * viewer works offline in the browser, the PWA and the Mac app. The plugin template README lives in
 * public/ and is fetched from the app's own origin.
 */
import { Marked, type Tokens } from 'marked';
import { create } from 'zustand';

export const REPO_RAW = 'https://raw.githubusercontent.com/Bloxmine/darkroom/main/';
export const REPO_BLOB = 'https://github.com/Bloxmine/darkroom/blob/main/';

const bundled = import.meta.glob(['/README.md', '/docs/*.md'], { query: '?raw', import: 'default' }) as Record<string, () => Promise<string>>;

export interface DocInfo {
  /** Repo-relative path, e.g. 'docs/AI.md'. */
  path: string;
  title: string;
  icon: string;
  load: () => Promise<string>;
}

const meta: [path: string, title: string, icon: string][] = [
  ['README.md', 'Overview', 'house'],
  ['docs/NODE_AUTHORING.md', 'Writing Nodes', 'script_code'],
  ['docs/CUSTOM_NODES.md', 'Custom Nodes', 'script_edit'],
  ['docs/PLUGINS.md', 'Plugins', 'plugin'],
  ['public/plugins/README.md', 'Plugin Template', 'plugin_add'],
  ['docs/FILTERS.md', 'Pro Filters & LUTs', 'color_swatch'],
  ['docs/AI.md', 'AI Nodes', 'brain'],
  ['docs/CONTROLNET.md', 'ControlNet', 'artwork'],
  ['docs/VIDEO.md', 'Video', 'film'],
  ['docs/RAW_AND_BATCH.md', 'RAW & Batch', 'camera'],
  ['docs/DESKTOP.md', 'Mac App', 'computer'],
];

export const DOCS: DocInfo[] = meta
  .map(([path, title, icon]): DocInfo | null => {
    if (path.startsWith('public/')) return { path, title, icon, load: () => fetch('/' + path.slice('public/'.length)).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${r.status}`)))) };
    const l = bundled['/' + path];
    return l ? { path, title, icon, load: l } : null;
  })
  .filter((d): d is DocInfo => !!d);

export const docByPath = (p: string) => DOCS.find((d) => d.path === p);

const cache = new Map<string, Promise<string>>();
export function loadDoc(path: string): Promise<string> {
  let p = cache.get(path);
  if (!p) {
    const d = docByPath(path);
    p = d ? d.load() : Promise.reject(new Error('Unknown document ' + path));
    p.catch(() => cache.delete(path));
    cache.set(path, p);
  }
  return p;
}

/** GitHub-style heading anchor. */
export function slugify(text: string) {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s/g, '-');
}

export interface Heading {
  depth: number;
  text: string;
  id: string;
}

/** Render Markdown to HTML with GitHub-style heading ids; also returns the headings for the outline. */
export function renderMarkdown(md: string): { html: string; headings: Heading[] } {
  const headings: Heading[] = [];
  const used = new Map<string, number>();
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      heading(this: { parser: { parseInline: (t: Tokens.Generic[]) => string } }, tok: Tokens.Heading) {
        const plain = tok.text.replace(/[`*_]/g, '');
        let id = slugify(plain);
        const n = used.get(id) ?? 0;
        used.set(id, n + 1);
        if (n) id += '-' + n;
        headings.push({ depth: tok.depth, text: plain.replace(/<[^>]+>/g, ''), id });
        return `<h${tok.depth} id="${id}">${this.parser.parseInline(tok.tokens)}</h${tok.depth}>\n`;
      },
    },
  });
  return { html: marked.parse(md, { async: false }) as string, headings };
}

/** Resolve `href` relative to the repo path `base` (e.g. 'docs/AI.md' + '../README.md#x' → 'README.md#x'). */
export function resolvePath(base: string, href: string): string {
  if (href.startsWith('/')) return href.slice(1);
  const parts = base.split('/').slice(0, -1);
  for (const seg of href.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.' && seg !== '') parts.push(seg);
  }
  return parts.join('/') + (href.endsWith('/') ? '/' : '');
}

// ---------------------------------------------------------------------------
// Viewer state
// ---------------------------------------------------------------------------

export interface Loc {
  path: string;
  anchor?: string;
}

interface DocsState {
  open: boolean;
  loc: Loc;
  back: Loc[];
  fwd: Loc[];
}

export const useDocs = create<DocsState>(() => ({ open: false, loc: { path: 'README.md' }, back: [], fwd: [] }));

/** Open the documentation viewer, optionally at a document (repo path) and heading anchor. */
export function openDocs(path?: string, anchor?: string) {
  if (!path) return useDocs.setState({ open: true });
  navigate({ path, anchor });
  useDocs.setState({ open: true });
}

export function navigate(loc: Loc) {
  const s = useDocs.getState();
  if (s.loc.path === loc.path && s.loc.anchor === loc.anchor) return;
  useDocs.setState({ loc, back: [...s.back, s.loc].slice(-50), fwd: [] });
}

export function goBack() {
  const s = useDocs.getState();
  const prev = s.back[s.back.length - 1];
  if (prev) useDocs.setState({ loc: prev, back: s.back.slice(0, -1), fwd: [s.loc, ...s.fwd] });
}

export function goForward() {
  const s = useDocs.getState();
  const next = s.fwd[0];
  if (next) useDocs.setState({ loc: next, fwd: s.fwd.slice(1), back: [...s.back, s.loc] });
}

export const closeDocs = () => useDocs.setState({ open: false });

// ---------------------------------------------------------------------------
// Full-text search
// ---------------------------------------------------------------------------

export interface SearchHit {
  path: string;
  title: string;
  heading?: Heading;
  snippet: string;
}

export async function searchDocs(q: string, limit = 40): Promise<SearchHit[]> {
  const query = q.trim().toLowerCase();
  if (query.length < 2) return [];
  const hits: SearchHit[] = [];
  for (const d of DOCS) {
    let md: string;
    try {
      md = await loadDoc(d.path);
    } catch {
      continue;
    }
    const { headings } = renderMarkdown(md);
    let hi = -1;
    for (const line of md.split('\n')) {
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) hi++;
      const i = line.toLowerCase().indexOf(query);
      if (i < 0) continue;
      const clean = line.replace(/<[^>]+>/g, '').replace(/[#*`>|]/g, '').trim();
      if (!clean) continue;
      const j = clean.toLowerCase().indexOf(query);
      const start = Math.max(0, j - 50);
      hits.push({
        path: d.path,
        title: d.title,
        heading: hi >= 0 ? headings[hi] : undefined,
        snippet: (start ? '…' : '') + clean.slice(start, start + 140) + (clean.length > start + 140 ? '…' : ''),
      });
      if (hits.length >= limit) return hits;
    }
  }
  return hits;
}
