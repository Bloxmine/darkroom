import { useRef, useState } from 'react';

type Pt = [number, number];

/** Monotone cubic (Fritsch–Carlson) interpolation through sorted points. */
export function monotone(pts: Pt[]): (x: number) => number {
  const p = [...pts].sort((a, b) => a[0] - b[0]);
  const n = p.length;
  if (n === 0) return (x) => x;
  if (n === 1) return () => p[0][1];
  const d: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((p[i + 1][1] - p[i][1]) / Math.max(1e-6, p[i + 1][0] - p[i][0]));
  m.push(d[0]);
  for (let i = 1; i < n - 1; i++) m.push(d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2);
  m.push(d[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  return (x) => {
    if (x <= p[0][0]) return p[0][1];
    if (x >= p[n - 1][0]) return p[n - 1][1];
    let i = 0;
    while (i < n - 2 && x > p[i + 1][0]) i++;
    const h = p[i + 1][0] - p[i][0];
    const t = (x - p[i][0]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * p[i][1] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * p[i + 1][1] + (t3 - t2) * h * m[i + 1];
  };
}

const S = 200; // svg units
const PAD = 6;

/** Small curve editor on a 0..1 grid. Click to add, drag to move, double/right-click to remove. */
export function CurveEditor({ value, onChange, onCommitEnd }: { value: Pt[]; onChange: (v: Pt[]) => void; onCommitEnd?: () => void }) {
  const pts: Pt[] = Array.isArray(value) && value.length ? value : [[0, 0], [1, 1]];
  const svg = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  const toLocal = (e: { clientX: number; clientY: number }): Pt => {
    const r = svg.current!.getBoundingClientRect();
    const sx = ((e.clientX - r.left) / r.width) * (S + PAD * 2) - PAD;
    const sy = ((e.clientY - r.top) / r.height) * (S + PAD * 2) - PAD;
    return [clamp(sx / S), clamp(1 - sy / S)];
  };
  const sorted = pts.map((p, i) => ({ p, i })).sort((a, b) => a.p[0] - b.p[0]);
  const f = monotone(pts);
  let d = '';
  for (let i = 0; i <= 100; i++) {
    const x = i / 100;
    d += (i ? 'L' : 'M') + (x * S).toFixed(2) + ',' + ((1 - clamp(f(x))) * S).toFixed(2);
  }

  const hit = (q: Pt) => {
    let best = -1;
    let bd = 0.06;
    pts.forEach((p, i) => {
      const dd = Math.hypot(p[0] - q[0], p[1] - q[1]);
      if (dd < bd) {
        bd = dd;
        best = i;
      }
    });
    return best;
  };

  const remove = (i: number) => {
    if (pts.length <= 2) return;
    onChange(pts.filter((_, j) => j !== i));
    onCommitEnd?.();
  };

  return (
    <div className="curve sunken">
      <svg
        ref={svg}
        viewBox={`${-PAD} ${-PAD} ${S + PAD * 2} ${S + PAD * 2}`}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          const q = toLocal(e);
          let i = hit(q);
          if (i < 0) {
            const next = [...pts, q].sort((a, b) => a[0] - b[0]);
            onChange(next);
            i = next.indexOf(q);
          }
          setDrag(i);
          (e.currentTarget as Element).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const q = toLocal(e);
          if (drag === null) {
            setHover(hit(q));
            return;
          }
          // keep x between neighbours
          const order = pts.map((p, i) => ({ p, i })).sort((a, b) => a.p[0] - b.p[0]);
          const k = order.findIndex((o) => o.i === drag);
          const lo = k > 0 ? order[k - 1].p[0] + 0.005 : 0;
          const hi = k < order.length - 1 ? order[k + 1].p[0] - 0.005 : 1;
          const next = pts.map((p, i) => (i === drag ? ([Math.min(hi, Math.max(lo, q[0])), q[1]] as Pt) : p));
          onChange(next);
        }}
        onPointerUp={() => {
          if (drag !== null) onCommitEnd?.();
          setDrag(null);
        }}
        onDoubleClick={(e) => {
          const i = hit(toLocal(e));
          if (i >= 0) remove(i);
        }}
        onContextMenu={(e) => {
          const i = hit(toLocal(e));
          if (i >= 0) {
            e.preventDefault();
            e.stopPropagation();
            remove(i);
          }
        }}
      >
        <rect x={0} y={0} width={S} height={S} className="curve-bg" />
        {[1, 2, 3].map((k) => (
          <g key={k} className="curve-grid">
            <line x1={(k * S) / 4} y1={0} x2={(k * S) / 4} y2={S} />
            <line x1={0} y1={(k * S) / 4} x2={S} y2={(k * S) / 4} />
          </g>
        ))}
        <line x1={0} y1={S} x2={S} y2={0} className="curve-diag" />
        <path d={d} className="curve-line" />
        {sorted.map(({ p, i }) => (
          <rect
            key={i}
            x={p[0] * S - 3.5}
            y={(1 - p[1]) * S - 3.5}
            width={7}
            height={7}
            className={'curve-pt' + (i === drag || i === hover ? ' active' : '')}
          />
        ))}
      </svg>
      <div className="curve-readout">
        {drag !== null && pts[drag] ? `in ${pts[drag][0].toFixed(3)}  out ${pts[drag][1].toFixed(3)}` : `${pts.length} pts · click: add · dbl-click: remove`}
      </div>
    </div>
  );
}

const clamp = (v: number) => Math.min(1, Math.max(0, v));
