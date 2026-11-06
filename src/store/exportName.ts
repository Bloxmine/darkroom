/**
 * Export file naming (Preferences › Export › File name pattern).
 * Tokens: {project} {source} {date} {time} {scale}.
 */
import { flattenGraph } from '../core/graph';
import { outputNodeId, useDoc } from './doc';
import { compareSource, engine } from './engine';
import { useSettings } from './settings';

export const NAME_TOKENS: { token: string; label: string }[] = [
  { token: '{project}', label: 'Project name' },
  { token: '{source}', label: 'Source image file name' },
  { token: '{date}', label: 'Date (YYYY-MM-DD)' },
  { token: '{time}', label: 'Time (HHMMSS)' },
  { token: '{scale}', label: 'Export scale (e.g. 50%)' },
];

const clean = (s: string) =>
  s
    .replace(/[\\/:*?"<>|]+/g, '')
    .replace(/\p{Cc}+/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

/** File name (without extension) of the image feeding the project output, or ''. */
export function sourceImageName(): string {
  const p = useDoc.getState().project;
  const out = outputNodeId(p);
  if (!out) return '';
  const src = compareSource(p.graph, out);
  const n = src ? flattenGraph(p.graph).nodes.find((x) => x.id === src) : undefined;
  const a = n ? engine?.assets.get(String(n.params.asset ?? '')) : undefined;
  return (a?.name ?? n?.label ?? '').replace(/\.[^.]+$/, '');
}

/** Expand a pattern for the current project (no extension). */
export function expandNamePattern(pattern: string, opts: { scale?: number; includeSource?: boolean; now?: Date } = {}): string {
  const d = opts.now ?? new Date();
  const z = (n: number) => String(n).padStart(2, '0');
  let pat = pattern.trim() || '{project}';
  if (opts.includeSource && !pat.includes('{source}')) pat += '-{source}';
  const src = pat.includes('{source}') ? sourceImageName() : '';
  const name = pat
    .replaceAll('{project}', useDoc.getState().project.name || 'untitled')
    .replaceAll('{source}', src || 'image')
    .replaceAll('{date}', `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`)
    .replaceAll('{time}', `${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`)
    .replaceAll('{scale}', `${Math.round((opts.scale ?? 1) * 100)}%`);
  return clean(name) || 'untitled';
}

/** The export file name (no extension) from the saved preferences. */
export function exportBaseName(): string {
  const s = useSettings.getState();
  return expandNamePattern(s.filenamePattern, {
    scale: s.exportScale,
    includeSource: s.includeSourceName,
  });
}
