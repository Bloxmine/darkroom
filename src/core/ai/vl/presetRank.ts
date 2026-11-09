/**
 * React glue for CLIP ranking in the Preset Browser: while a text query (“faded 90s camcorder”) or a reference
 * preset (“More like this”) is active, every rendered thumbnail is embedded lazily (one at a time, as thumbnails
 * arrive) and the presets get a cosine-similarity score. Nothing loads until the user asks: the first query
 * downloads CLIP (154 MB, through the consent prompt).
 */
import { useEffect, useRef, useState } from 'react';
import { clipImage, clipImageCached, clipText, cosine } from './clip';

export interface RankState {
  scores: Map<string, number>;
  embedded: number;
  total: number;
  busy: boolean;
  error?: string;
}

/**
 * `thumbs(id)` gives a preset's current thumbnail (url + input key) or null while it renders; `version` changes
 * whenever thumbnails change. `query` (text) or `like` (preset id) switches ranking on.
 */
export function useClipRank(ids: string[], thumbs: (id: string) => { url: string | null; key: string } | null | undefined, version: number, query: string, like: string | null): RankState | null {
  const [state, setState] = useState<RankState | null>(null);
  const run = useRef(0);
  const active = !!query.trim() || !!like;
  useEffect(() => {
    if (!active) {
      setState(null);
      return;
    }
    const me = ++run.current;
    let alive = true;
    setState((s) => ({ scores: s?.scores ?? new Map(), embedded: 0, total: ids.length, busy: true }));
    (async () => {
      try {
        const key = (id: string) => {
          const t = thumbs(id);
          return t?.url ? { k: `${id}|${t.key}`, url: t.url } : null;
        };
        let ref: Float32Array | null = null;
        if (like) {
          const t = key(like);
          if (t) ref = await clipImage(t.k, t.url);
        } else ref = await clipText(query);
        const ready = ids.filter((id) => key(id));
        const embs = new Map<string, Float32Array>();
        // Every thumbnail shows the same photo, so the raw similarity is dominated by its content. Scores use the
        // embeddings minus their mean (what is specific to each look); “More like this” compares centred vs centred.
        const score = () => {
          const out = new Map<string, number>();
          if (!ref || !embs.size) return out;
          const mean = new Float32Array(ref.length);
          if (embs.size >= 6) {
            for (const e of embs.values()) for (let i = 0; i < mean.length; i++) mean[i] += e[i] / embs.size;
          }
          const centre = (e: Float32Array) => {
            const c = e.map((v, i) => v - mean[i]);
            const n = Math.hypot(...c) || 1;
            return c.map((v) => v / n);
          };
          const r = like ? centre(ref) : ref;
          for (const [id, e] of embs) out.set(id, cosine(r, centre(e)));
          return out;
        };
        const fill = async (lazy: boolean) => {
          for (const id of ready) {
            const t = key(id)!;
            const cached = clipImageCached(t.k);
            if (lazy && !cached) continue;
            const e = await (cached ?? clipImage(t.k, t.url));
            if (!alive || run.current !== me) return false;
            embs.set(id, e);
            if (!lazy && embs.size % 8 === 0) setState({ scores: score(), embedded: embs.size, total: ids.length, busy: true });
          }
          return true;
        };
        if (!(await fill(true))) return; // already embedded: instant
        if (!(await fill(false))) return;
        if (alive && run.current === me) setState({ scores: score(), embedded: embs.size, total: ids.length, busy: false });
      } catch (e) {
        if (alive) setState({ scores: new Map(), embedded: 0, total: ids.length, busy: false, error: String((e as Error)?.message ?? e) });
      }
    })();
    return () => {
      alive = false;
    };
    // re-run as thumbnails arrive (version) or the query changes; ids by value
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, query, like, version, ids.join('\u0000')]);
  return state;
}
