/**
 * JSON formats edited by the viewer tools and read by the nodes (pure TS, no React; nodes import it).
 * All coordinates are normalised 0..1 with a top-left origin, like v_uv.
 */
import type { ParamValue, ViewerToolDef, ViewerToolKind } from '../../core/types';

export interface ToolPoint {
  x: number;
  y: number;
  /** 1 = positive (include), 0 = negative (exclude). */
  label: number;
}

export interface Stroke {
  /** Radius as a fraction of the image height. */
  r: number;
  /** Hardness 0..1 (1 = hard edge). */
  h: number;
  /** 1 = erase. */
  e?: number;
  /** Flat polyline x0,y0,x1,y1,… */
  p: number[];
}

export type Box = [number, number, number, number];

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function parse(v: ParamValue | undefined): unknown {
  if (typeof v !== 'string' || !v.trim()) return null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

export function parsePoints(v: ParamValue | undefined): ToolPoint[] {
  const a = parse(v);
  if (!Array.isArray(a)) return [];
  return a
    .filter((p): p is ToolPoint => !!p && fin(p.x) && fin(p.y))
    .map((p) => ({ x: clamp01(p.x), y: clamp01(p.y), label: p.label === 0 ? 0 : 1 }));
}

export function parseStrokes(v: ParamValue | undefined): Stroke[] {
  const a = parse(v);
  if (!Array.isArray(a)) return [];
  return a.filter((s): s is Stroke => !!s && fin(s.r) && s.r > 0 && Array.isArray(s.p) && s.p.length >= 2 && s.p.every(fin));
}

export function parseBox(v: ParamValue | undefined): Box | null {
  const a = parse(v);
  if (!Array.isArray(a) || a.length !== 4 || !a.every(fin)) return null;
  const [x0, y0, x1, y1] = a as number[];
  const b: Box = [clamp01(Math.min(x0, x1)), clamp01(Math.min(y0, y1)), clamp01(Math.max(x0, x1)), clamp01(Math.max(y0, y1))];
  return b[2] - b[0] > 1e-4 && b[3] - b[1] > 1e-4 ? b : null;
}

const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
export const pointsJson = (pts: ToolPoint[]) => (pts.length ? JSON.stringify(pts.map((p) => ({ x: r4(p.x), y: r4(p.y), label: p.label }))) : '');
export const strokesJson = (s: Stroke[]) => (s.length ? JSON.stringify(s.map((k) => ({ ...k, r: r4(k.r), h: r4(k.h), p: k.p.map(r4) }))) : '');
export const boxJson = (b: Box | null) => (b ? JSON.stringify(b.map(r4)) : '');

/** Normalised tool definition (shorthand kinds get their default param keys). */
export function toolDef(t: ViewerToolKind | ViewerToolDef | undefined): ViewerToolDef | null {
  if (!t) return null;
  const d: ViewerToolDef = typeof t === 'string' ? { kind: t } : { ...t };
  if (!d.param && !d.vec2Param) d.param = d.kind === 'brush' ? 'strokes' : d.kind === 'box' ? 'box' : 'points';
  return d;
}
