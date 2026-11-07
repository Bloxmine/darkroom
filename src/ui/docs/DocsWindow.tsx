import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../Icon';
import {
  closeDocs,
  docByPath,
  DOCS,
  goBack,
  goForward,
  loadDoc,
  navigate,
  REPO_BLOB,
  REPO_RAW,
  renderMarkdown,
  resolvePath,
  searchDocs,
  useDocs,
  type Heading,
  type SearchHit,
} from './docs';
import './docs.css';

/** Floating, non-modal documentation window (Help › Darkroom Help, Plugin Manager › Plugin Docs). */
export function DocsHost() {
  const open = useDocs((s) => s.open);
  return open ? <DocsWindow /> : null;
}

function DocsWindow() {
  const { loc, back, fwd } = useDocs();
  const [md, setMd] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [off, setOff] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const article = useRef<HTMLDivElement>(null);
  const doc = docByPath(loc.path);

  useEffect(() => {
    let live = true;
    setMd(null);
    setErr(null);
    loadDoc(loc.path).then(
      (t) => live && setMd(t),
      (e) => live && setErr(String(e?.message ?? e)),
    );
    return () => {
      live = false;
    };
  }, [loc.path]);

  const rendered = useMemo(() => (md == null ? null : renderMarkdown(md)), [md]);

  // after render: fix image URLs, scroll to the anchor
  useEffect(() => {
    const el = article.current;
    if (!el || !rendered) return;
    for (const img of el.querySelectorAll('img')) {
      const src = img.getAttribute('src') ?? '';
      if (!/^(https?:|data:)/i.test(src)) img.src = REPO_RAW + resolvePath(loc.path, src);
      img.loading = 'lazy';
      img.onerror = () => (img.style.display = 'none'); // offline: hide gallery images
    }
    const target = loc.anchor ? el.querySelector(`[id="${CSS.escape(loc.anchor)}"]`) : null;
    if (target) target.scrollIntoView({ block: 'start' });
    else el.scrollTop = 0;
  }, [rendered, loc]);

  // debounced full-text search
  useEffect(() => {
    if (query.trim().length < 2) return setHits(null);
    let live = true;
    const t = setTimeout(() => void searchDocs(query).then((h) => live && setHits(h)), 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [query]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDocs();
      else if ((e.metaKey || e.altKey) && e.key === '[') goBack();
      else if ((e.metaKey || e.altKey) && e.key === ']') goForward();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

  const onArticleClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a');
    if (!a) return;
    const href = a.getAttribute('href') ?? '';
    e.preventDefault();
    if (href.startsWith('#')) return navigate({ path: loc.path, anchor: href.slice(1) });
    if (/^(https?:|mailto:)/i.test(href)) return void window.open(href, '_blank', 'noopener');
    const [p, anchor] = href.split('#');
    const path = resolvePath(loc.path, p);
    if (docByPath(path)) return navigate({ path, anchor });
    window.open(REPO_BLOB + path, '_blank', 'noopener'); // a source file or folder: show it on GitHub
  };

  const headings: Heading[] = rendered?.headings.filter((h) => h.depth >= 2 && h.depth <= 3) ?? [];

  return (
    <div className="docs-win window" style={{ transform: `translate(${off.x}px, ${off.y}px)` }} role="dialog" aria-label="Darkroom Help">
      <div
        className="titlebar"
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, ox: off.x, oy: off.y };
        }}
        onPointerMove={(e) => drag.current && setOff({ x: drag.current.ox + e.clientX - drag.current.x, y: drag.current.oy + e.clientY - drag.current.y })}
        onPointerUp={() => (drag.current = null)}
      >
        <Icon name="book_open" />
        <span className="titlebar-text">Darkroom Help{doc ? ` — ${doc.title}` : ''}</span>
        <button className="titlebar-close" onClick={closeDocs} title="Close (Esc)" onPointerDown={(e) => e.stopPropagation()}>
          ✕
        </button>
      </div>
      <div className="docs-toolbar">
        <button className="btn" disabled={!back.length} onClick={goBack} title="Back (⌘[)">
          <Icon name="arrow_left" />
        </button>
        <button className="btn" disabled={!fwd.length} onClick={goForward} title="Forward (⌘])">
          <Icon name="arrow_right" />
        </button>
        <button className="btn" onClick={() => navigate({ path: 'README.md' })} title="Overview">
          <Icon name="house" />
        </button>
        <span className="grow" />
        <label className="docs-search">
          <Icon name="magnifier" />
          <input type="search" placeholder="Search help" value={query} onChange={(e) => setQuery(e.target.value)} spellCheck={false} />
        </label>
        <button className="btn" onClick={() => window.open(REPO_BLOB + loc.path, '_blank', 'noopener')} title="Open this page on GitHub">
          <Icon name="world_link" />
        </button>
      </div>
      <div className="docs-main">
        <nav className="docs-side">
          {DOCS.map((d) => (
            <div key={d.path}>
              <button className={'docs-doc' + (d.path === loc.path ? ' active' : '')} onClick={() => (setQuery(''), navigate({ path: d.path }))}>
                <Icon name={d.icon} /> {d.title}
              </button>
              {d.path === loc.path && headings.length > 0 && (
                <div className="docs-toc">
                  {headings.map((h) => (
                    <button key={h.id} className={'docs-toc-item d' + h.depth + (loc.anchor === h.id ? ' active' : '')} onClick={() => navigate({ path: d.path, anchor: h.id })} title={h.text}>
                      {h.text}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </nav>
        {hits ? (
          <div className="docs-article docs-results">
            <h2>
              {hits.length ? `${hits.length}${hits.length >= 40 ? '+' : ''} results` : 'No results'} for “{query.trim()}”
            </h2>
            {hits.map((h, i) => (
              <button key={i} className="docs-hit" onClick={() => (setQuery(''), navigate({ path: h.path, anchor: h.heading?.id }))}>
                <span className="docs-hit-where">
                  {h.title}
                  {h.heading ? ` › ${h.heading.text}` : ''}
                </span>
                <span className="docs-hit-snippet">{h.snippet}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="docs-article" ref={article} onClick={onArticleClick}>
            {err ? <p className="docs-error">Couldn’t load this page: {err}</p> : rendered ? <div dangerouslySetInnerHTML={{ __html: rendered.html }} /> : <p className="docs-loading">Loading…</p>}
          </div>
        )}
      </div>
    </div>
  );
}
