import { useEffect, useState } from 'react';

const fmt = (v: number, step?: number) => {
  if (!isFinite(v)) return '0';
  const dec = step && step < 1 ? Math.min(4, Math.max(0, Math.ceil(-Math.log10(step)))) : Number.isInteger(v) ? 0 : 3;
  return String(Number(v.toFixed(Math.max(dec, Number.isInteger(v) ? 0 : 2))));
};

/** Sunken numeric field: commit on Enter/blur, arrow keys step, typing beyond slider range allowed. */
export function NumField({ value, onChange, step = 0.01, int, width }: { value: number; onChange: (v: number) => void; step?: number; int?: boolean; width?: number }) {
  const [text, setText] = useState(fmt(value, step));
  const [focus, setFocus] = useState(false);
  useEffect(() => {
    if (!focus) setText(fmt(value, step));
  }, [value, step, focus]);
  const commit = (s: string) => {
    let v: number;
    try {
      // allow simple expressions like "2*3" or "1/3"
      v = /^[\d\s.+\-*/()e]+$/i.test(s) ? Number(Function(`"use strict";return (${s})`)()) : parseFloat(s);
    } catch {
      v = NaN;
    }
    if (!isFinite(v)) {
      setText(fmt(value, step));
      return;
    }
    if (int) v = Math.round(v);
    onChange(v);
  };
  return (
    <input
      className="field num"
      style={width ? { width } : undefined}
      value={text}
      spellCheck={false}
      onFocus={(e) => {
        setFocus(true);
        e.target.select();
      }}
      onBlur={(e) => {
        setFocus(false);
        commit(e.target.value);
      }}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          commit((e.target as HTMLInputElement).value);
          (e.target as HTMLInputElement).blur();
        } else if (e.key === 'Escape') {
          setText(fmt(value, step));
          (e.target as HTMLInputElement).blur();
        } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          const k = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : e.altKey ? 0.1 : 1) * step;
          const v = (int ? Math.round : (x: number) => Math.round(x * 1e6) / 1e6)(value + k);
          onChange(v);
          setText(fmt(v, step));
        }
      }}
    />
  );
}

