/** Snow Leopard Aqua controls for the Preferences window (styled in prefs.css). */
import type { ReactNode } from 'react';

export function Button({
  children,
  onClick,
  primary,
  small,
  disabled,
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  primary?: boolean;
  small?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button type="button" className={'slp-btn' + (primary ? ' default' : '') + (small ? ' small' : '')} onClick={onClick} disabled={disabled} title={title}>
      {children}
    </button>
  );
}

export function PopUp<T extends string | number>({
  value,
  options,
  onChange,
  width,
  disabled,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  width?: number;
  disabled?: boolean;
  label?: string;
}) {
  const idx = options.findIndex((o) => o.value === value);
  return (
    <span className={'slp-popup' + (disabled ? ' disabled' : '')} style={width ? { width } : undefined}>
      <select aria-label={label} value={String(idx)} disabled={disabled} onChange={(e) => onChange(options[+e.target.value].value)}>
        {options.map((o, i) => (
          <option key={String(o.value)} value={String(i)}>
            {o.label}
          </option>
        ))}
      </select>
    </span>
  );
}

export function Check({
  checked,
  onChange,
  children,
  disabled,
  title,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children: ReactNode;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button type="button" role="checkbox" aria-checked={checked} className="slp-check" disabled={disabled} title={title} onClick={() => onChange(!checked)}>
      <span className="box" />
      <span>{children}</span>
    </button>
  );
}

export function Radios<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="slp-radios" role="radiogroup">
      {options.map((o) => (
        <button key={String(o.value)} type="button" role="radio" aria-checked={o.value === value} className="slp-check radio" onClick={() => onChange(o.value)}>
          <span className="box" />
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  );
}

/** A tick-mark slider over a discrete set of values (snaps to the stops). */
export function TickSlider<T extends number>({
  value,
  stops,
  labels,
  onChange,
  width = 260,
}: {
  value: T;
  stops: T[];
  labels: string[];
  onChange: (v: T) => void;
  width?: number;
}) {
  const i = Math.max(0, stops.indexOf(value));
  const pct = (k: number) => (stops.length > 1 ? (k / (stops.length - 1)) * 100 : 0);
  return (
    <span className="slp-slider" style={{ width }}>
      <input type="range" min={0} max={stops.length - 1} step={1} value={i} onChange={(e) => onChange(stops[+e.target.value])} aria-valuetext={labels[i]} />
      <span className="slp-ticks">
        {stops.map((_, k) => (
          <i key={k} style={{ left: `${pct(k)}%` }} />
        ))}
      </span>
      <span className="slp-tick-labels">
        {labels.map((l, k) => (
          <span key={k} style={{ left: `${pct(k)}%` }}>
            {l}
          </span>
        ))}
      </span>
    </span>
  );
}

/** Numeric field with an Aqua stepper. */
export function Stepper({
  value,
  min,
  max,
  step = 1,
  onChange,
  suffix,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  suffix?: string;
}) {
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{ display: 'inline-flex', alignItems: 'center' }}>
        <input
          className="slp-field num"
          value={value}
          inputMode="numeric"
          onChange={(e) => {
            const v = parseInt(e.target.value, 10);
            if (Number.isFinite(v)) onChange(clamp(v));
          }}
        />
        <span className="slp-stepper">
          <button type="button" aria-label="Increase" onClick={() => onChange(clamp(value + step))} />
          <button type="button" aria-label="Decrease" onClick={() => onChange(clamp(value - step))} />
        </span>
      </span>
      {suffix && <span>{suffix}</span>}
    </span>
  );
}

export function Box({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <>
      {title && <div className="slp-box-title">{title}</div>}
      <div className="slp-box">{children}</div>
    </>
  );
}

/** One row of the classic right-aligned-label form. */
export function Row({ label, children, top, col }: { label?: string; children: ReactNode; top?: boolean; col?: boolean }) {
  return (
    <>
      <div className={'lbl' + (top ? ' top' : '')}>{label ? label + ':' : ''}</div>
      <div className={'ctl' + (col ? ' col' : '')}>{children}</div>
    </>
  );
}

export const Sep = () => <div className="sep" />;

export function Note({ children }: { children: ReactNode }) {
  return <span className="slp-note">{children}</span>;
}

export const fmtBytes = (b: number) =>
  b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : b >= 1e3 ? `${(b / 1e3).toFixed(0)} KB` : `${b} bytes`;
