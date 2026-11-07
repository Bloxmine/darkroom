/**
 * Canvas 2D drawing for the people AI nodes: anti-aliased region masks from face landmarks (smooth closed
 * curves through the contour points) and the landmark / mesh / skeleton overlays.
 * Exports an empty NodeDef[] so the auto-registration glob is satisfied.
 */
import type { NodeDef } from '../../core/types';
import {
  convexHull, FACE_OVAL, LEFT_BROW, LEFT_EYE, LEFT_IRIS, LIPS_INNER, LIPS_OUTER, lmPx, NOSE_POINTS, RIGHT_BROW, RIGHT_EYE, RIGHT_IRIS,
  type FaceBox, type FaceLm, type Pt,
} from './face-geom';

export default [] as NodeDef[];

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function makeCanvas(w: number, h: number): { canvas: OffscreenCanvas | HTMLCanvasElement; g: Ctx2D } {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(w, h);
    return { canvas, g: canvas.getContext('2d')! };
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return { canvas, g: canvas.getContext('2d')! };
}

/** Raster size for masks/overlays: the source size capped at `maxLong` on the long side. */
export function rasterSize(w: number, h: number, maxLong = 2048): [number, number] {
  const k = Math.min(1, maxLong / Math.max(w, h));
  return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
}

/** Closed smooth curve through `pts` (quadratic segments between edge midpoints). */
export function smoothLoop(g: Ctx2D, pts: Pt[]) {
  const n = pts.length;
  if (n < 3) return;
  const mid = (a: Pt, b: Pt): Pt => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const m0 = mid(pts[n - 1], pts[0]);
  g.moveTo(m0[0], m0[1]);
  for (let i = 0; i < n; i++) {
    const p = pts[i], m = mid(p, pts[(i + 1) % n]);
    g.quadraticCurveTo(p[0], p[1], m[0], m[1]);
  }
  g.closePath();
}

/** Polygon scaled about its centroid (k > 1 grows it). */
export function grow(pts: Pt[], k: number): Pt[] {
  let cx = 0, cy = 0;
  for (const p of pts) {
    cx += p[0];
    cy += p[1];
  }
  cx /= pts.length;
  cy /= pts.length;
  return pts.map((p) => [cx + (p[0] - cx) * k, cy + (p[1] - cy) * k]);
}

export const REGIONS = ['Face skin', 'Eyes', 'Irises', 'Eyebrows', 'Eyes + brows', 'Nose', 'Lips', 'Mouth (lips + inside)', 'Whole face'];

type P = (i: number) => Pt;

function irisCircle(g: Ctx2D, P: P, idx: number[]) {
  const c = P(idx[0]);
  let r = 0;
  for (let k = 1; k < idx.length; k++) r += Math.hypot(P(idx[k])[0] - c[0], P(idx[k])[1] - c[1]);
  r /= idx.length - 1;
  g.moveTo(c[0] + r, c[1]);
  g.arc(c[0], c[1], r, 0, Math.PI * 2);
}

/** Fill one face's `region` (white, holes black) into `g`; `P` maps a landmark index to canvas pixels. */
export function fillRegion(g: Ctx2D, P: P, region: string, has478: boolean) {
  const loop = (idx: number[], k = 1) => smoothLoop(g, k === 1 ? idx.map(P) : grow(idx.map(P), k));
  // masks are opaque (white on black) so anti-aliased coverage survives the unpremultiplied upload: holes paint black
  const fill = (draw: () => void, hole = false) => {
    g.save();
    g.fillStyle = hole ? '#000' : '#fff';
    g.beginPath();
    draw();
    g.fill('nonzero');
    g.restore();
  };
  switch (region) {
    case 'Whole face':
      fill(() => loop(FACE_OVAL));
      break;
    case 'Face skin':
      fill(() => loop(FACE_OVAL));
      // holes: eyes (a little bigger, lashes), brows, mouth
      fill(() => (loop(RIGHT_EYE, 1.25), loop(LEFT_EYE, 1.25), loop(RIGHT_BROW, 1.12), loop(LEFT_BROW, 1.12), loop(LIPS_OUTER, 1.06)), true);
      break;
    case 'Eyes':
      fill(() => (loop(RIGHT_EYE), loop(LEFT_EYE)));
      break;
    case 'Irises':
      if (has478) {
        // clipped to the eye opening (the lids cover part of the iris)
        g.save();
        g.beginPath();
        loop(RIGHT_EYE);
        loop(LEFT_EYE);
        g.clip();
        fill(() => (irisCircle(g, P, RIGHT_IRIS), irisCircle(g, P, LEFT_IRIS)));
        g.restore();
      }
      break;
    case 'Eyebrows':
      fill(() => (loop(RIGHT_BROW), loop(LEFT_BROW)));
      break;
    case 'Eyes + brows':
      fill(() => (loop(RIGHT_EYE, 1.15), loop(LEFT_EYE, 1.15), loop(RIGHT_BROW), loop(LEFT_BROW)));
      break;
    case 'Nose':
      fill(() => smoothLoop(g, convexHull(NOSE_POINTS.map(P))));
      break;
    case 'Lips':
      fill(() => loop(LIPS_OUTER));
      fill(() => loop(LIPS_INNER), true);
      break;
    case 'Mouth (lips + inside)':
      fill(() => loop(LIPS_OUTER));
      break;
  }
}

/**
 * Opaque mask canvas (white on black) with `region` of every face; landmarks normalised to the canvas.
 * `extra` (detections without landmarks) are drawn as ellipses for the whole-face region.
 */
export function regionMask(faces: FaceLm[], w: number, h: number, region: string, extra: FaceBox[] = []) {
  const { canvas, g } = makeCanvas(w, h);
  g.fillStyle = '#000';
  g.fillRect(0, 0, w, h);
  if (region === 'Whole face') {
    g.fillStyle = '#fff';
    for (const e of extra) {
      const [x0, y0, x1, y1] = e.box;
      g.beginPath();
      g.ellipse(((x0 + x1) / 2) * w, ((y0 + y1) / 2) * h, ((x1 - x0) / 2) * w * 0.92, ((y1 - y0) / 2) * h * 0.95, 0, 0, Math.PI * 2);
      g.fill();
    }
  }
  for (const f of faces) fillRegion(g, (i) => lmPx(f, i, w, h), region, f.pts.length >= 478 * 3);
  return canvas;
}

export const OVERLAY_STYLES = ['Mesh', 'Contours', 'Points', 'Boxes', 'Mesh + boxes'];

const css = (c: number[], a = 1) => `rgba(${Math.round((c[0] ?? 1) * 255)},${Math.round((c[1] ?? 1) * 255)},${Math.round((c[2] ?? 1) * 255)},${(c[3] ?? 1) * a})`;

/**
 * Landmark overlay (transparent background) for `faces`. `lw` = line width in canvas pixels.
 * `tess` = Face Mesh tesselation edges (from the MediaPipe module) for the mesh styles.
 */
export function faceOverlay(faces: FaceLm[], w: number, h: number, style: string, color: number[], lw: number, tess: [number, number][] | null, extra: FaceBox[] = []) {
  const { canvas, g } = makeCanvas(w, h);
  g.lineJoin = 'round';
  g.lineCap = 'round';
  // detections without landmarks (profiles…): dashed box + the 5 keypoints, in every style
  for (const e of extra) {
    const [x0, y0, x1, y1] = e.box;
    g.strokeStyle = css(color, 0.8);
    g.lineWidth = lw * 1.2;
    g.setLineDash([lw * 4, lw * 3]);
    g.strokeRect(x0 * w, y0 * h, (x1 - x0) * w, (y1 - y0) * h);
    g.setLineDash([]);
    g.fillStyle = css(color);
    g.beginPath();
    for (const [x, y] of e.kps) {
      g.moveTo(x * w + lw * 1.5, y * h);
      g.arc(x * w, y * h, lw * 1.5, 0, Math.PI * 2);
    }
    g.fill();
  }
  faces.forEach((f, n) => {
    const P = (i: number) => lmPx(f, i, w, h);
    const has478 = f.pts.length >= 478 * 3;
    const mesh = style.startsWith('Mesh');
    if (mesh && tess) {
      g.strokeStyle = css(color, 0.45);
      g.lineWidth = lw * 0.5;
      g.beginPath();
      for (const [a, b] of tess) {
        const pa = P(a), pb = P(b);
        g.moveTo(pa[0], pa[1]);
        g.lineTo(pb[0], pb[1]);
      }
      g.stroke();
    }
    if (mesh || style === 'Contours') {
      g.strokeStyle = css(color);
      g.lineWidth = lw;
      g.beginPath();
      for (const idx of [FACE_OVAL, RIGHT_EYE, LEFT_EYE, RIGHT_BROW, LEFT_BROW, LIPS_OUTER, LIPS_INNER]) {
        const pts = idx.map(P);
        g.moveTo(pts[0][0], pts[0][1]);
        for (let k = 1; k < pts.length; k++) g.lineTo(pts[k][0], pts[k][1]);
        g.closePath();
      }
      if (has478) {
        irisCircle(g, P, RIGHT_IRIS);
        irisCircle(g, P, LEFT_IRIS);
      }
      g.stroke();
    }
    if (style === 'Points') {
      g.fillStyle = css(color);
      const r = Math.max(0.6, lw * 0.6);
      const n2 = f.pts.length / 3;
      g.beginPath();
      for (let i = 0; i < n2; i++) {
        const p = P(i);
        g.moveTo(p[0] + r, p[1]);
        g.arc(p[0], p[1], r, 0, Math.PI * 2);
      }
      g.fill();
    }
    if (style === 'Boxes' || style === 'Mesh + boxes') {
      const [x0, y0, x1, y1] = f.box;
      const bw = (x1 - x0) * w, bh = (y1 - y0) * h;
      g.strokeStyle = css(color);
      g.lineWidth = lw * 1.5;
      g.strokeRect(x0 * w - bw * 0.05, y0 * h - bh * 0.12, bw * 1.1, bh * 1.17);
      g.fillStyle = css(color);
      g.font = `${Math.max(10, Math.round(lw * 7))}px sans-serif`;
      g.textBaseline = 'bottom';
      g.fillText(`face ${n + 1}`, x0 * w - bw * 0.05, y0 * h - bh * 0.12 - lw);
    }
  });
  return canvas;
}
