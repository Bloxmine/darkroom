import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { NumField } from './NumField';

type RGBA = [number, number, number, number];

export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  return [h, max ? d / max : 0, max];
}

export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  return ([
    [v, t, p],
    [q, v, p],
    [p, v, t],
    [p, q, v],
    [t, p, v],
    [v, p, q],
  ][((i % 6) + 6) % 6] as [number, number, number]);
}

const c255 = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 255);
export const toHex = (c: number[]) => '#' + c.slice(0, 3).map((x) => c255(x).toString(16).padStart(2, '0')).join('');
export const cssColor = (c: number[]) => `rgba(${c255(c[0])},${c255(c[1])},${c255(c[2])},${c[3] ?? 1})`;

function parseHex(s: string): [number, number, number] | null {
  const m = s.trim().replace('#', '');
  const full = m.length === 3 ? m.split('').map((x) => x + x).join('') : m;
  if (!/^[0-9a-f]{6}$/i.test(full)) return null;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255) as [number, number, number];
}

/** Classic HSV picker popup: SV square + hue strip + alpha + numeric RGBA/hex. */
export function ColorPopup({ anchor, value, onChange, onClose }: { anchor: DOMRect; value: RGBA; onChange: (c: RGBA) => void; onClose: () => void }) {
  const [hsv, setHsv] = useState(() => rgbToHsv(value[0], value[1], value[2]));
  const [hex, setHex] = useState(toHex(value));
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: anchor.left, top: anchor.bottom + 2 });

  useLayoutEffect(() => {
    const r = box.current!.getBoundingClientRect();
    setPos({
      left: Math.min(anchor.left, window.innerWidth - r.width - 4),
      top: anchor.bottom + r.height + 4 > window.innerHeight ? Math.max(4, anchor.top - r.height - 2) : anchor.bottom + 2,
    });
  }, [anchor]);

  useEffect(() => {
    const down = (e: MouseEvent) => !box.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('mousedown', down);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('mousedown', down);
      window.removeEventListener('keydown', key);
    };
  }, [onClose]);

  const emit = (h: number, s: number, v: number, a = value[3]) => {
    setHsv([h, s, v]);
    const rgb = hsvToRgb(h, s, v);
    setHex(toHex(rgb));
    onChange([...rgb, a]);
  };
  const dragger = (fn: (fx: number, fy: number) => void) => ({
    onPointerDown: (e: React.PointerEvent) => {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      const r = (e.currentTarget as Element).getBoundingClientRect();
      fn(clamp01((e.clientX - r.left) / r.width), clamp01((e.clientY - r.top) / r.height));
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (!(e.currentTarget as Element).hasPointerCapture(e.pointerId)) return;
      const r = (e.currentTarget as Element).getBoundingClientRect();
      fn(clamp01((e.clientX - r.left) / r.width), clamp01((e.clientY - r.top) / r.height));
    },
  });
  const [h, s, v] = hsv;
  const hueRgb = hsvToRgb(h, 1, 1);
  const setChannel = (i: number, x: number) => {
    const c = [...value] as RGBA;
    c[i] = x;
    setHsv(rgbToHsv(c[0], c[1], c[2]));
    setHex(toHex(c));
    onChange(c);
  };

  return createPortal(
    <div className="colorpop window" ref={box} style={{ position: 'fixed', ...pos }} onMouseDown={(e) => e.stopPropagation()}>
      <div className="cp-main">
        <div className="cp-sv sunken" style={{ background: `rgb(${hueRgb.map(c255).join(',')})` }} {...dragger((fx, fy) => emit(h, fx, 1 - fy))}>
          <div className="cp-sv-w" />
          <div className="cp-sv-b" />
          <div className="cp-sv-cursor" style={{ left: `${s * 100}%`, top: `${(1 - v) * 100}%` }} />
        </div>
        <div className="cp-hue sunken" {...dragger((_, fy) => emit(fy, s, v))}>
          <div className="cp-hue-cursor" style={{ top: `${h * 100}%` }} />
        </div>
        <div className="cp-alpha sunken" {...dragger((_, fy) => setChannel(3, Math.round((1 - fy) * 1000) / 1000))}>
          <div className="cp-alpha-fill" style={{ background: `linear-gradient(${toHex(value)}, transparent)` }} />
          <div className="cp-hue-cursor" style={{ top: `${(1 - value[3]) * 100}%` }} />
        </div>
      </div>
      <div className="cp-fields">
        <div className="cp-preview sunken">
          <span style={{ background: cssColor(value) }} />
        </div>
        {(['R', 'G', 'B', 'A'] as const).map((l, i) => (
          <label key={l} className="cp-field">
            {l}
            <NumField value={value[i]} step={0.01} onChange={(x) => setChannel(i, Math.max(0, x))} />
          </label>
        ))}
        <label className="cp-field cp-hex">
          Hex
          <input
            className="field"
            value={hex}
            spellCheck={false}
            onChange={(e) => {
              setHex(e.target.value);
              const rgb = parseHex(e.target.value);
              if (rgb) {
                setHsv(rgbToHsv(...rgb));
                onChange([...rgb, value[3]]);
              }
            }}
          />
        </label>
      </div>
    </div>,
    document.body,
  );
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
