/** Metadata panel: File Properties, IPTC Core (editable → XMP sidecar), Camera Data (EXIF), GPS — grouped like Bridge. */
import { useEffect, useState, type ReactNode } from 'react';
import { cameraName, orientedDims } from '../../core/files/facets';
import { kindOf, typeLabel } from '../../core/files/kinds';
import { shutterText } from '../../core/files/rename';
import type { FsEntry } from '../../core/files/types';
import { LABELS, labelColor, type XmpData } from '../../core/files/xmp';
import { Panel } from '../Chrome';
import { Icon } from '../Icon';
import * as A from './actions';
import { fmtDate, fmtSize, focusProps, labelCss, Stars } from './common';
import { itemDate, useBrowser, type ItemMeta } from './store';

const MIXED = '(multiple values)';

function Group({ title, children, open: initial = true }: { title: string; children: ReactNode; open?: boolean }) {
  const [open, setOpen] = useState(initial);
  return (
    <div className="br-md-group">
      <div className="br-section" onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} {title}
      </div>
      {open && <table className="br-md-table">{<tbody>{children}</tbody>}</table>}
    </div>
  );
}

function Row({ k, v }: { k: string; v: ReactNode }) {
  if (v === undefined || v === null || v === '') return null;
  return (
    <tr>
      <th>{k}</th>
      <td>{v}</td>
    </tr>
  );
}

/** Text field that commits on blur / Enter (Esc reverts). */
function EditField({ value, multi, onCommit, area, placeholder }: { value: string; multi?: boolean; onCommit: (v: string) => void; area?: boolean; placeholder?: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => v !== value && onCommit(v);
  const common = {
    value: v,
    placeholder: multi ? MIXED : placeholder,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setV(e.target.value),
    onBlur: commit,
    onKeyDown: (e: React.KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Escape') setV(value);
      if (e.key === 'Enter' && (!area || e.metaKey || e.ctrlKey)) (e.target as HTMLElement).blur();
    },
  };
  return area ? <textarea className="br-md-input" rows={3} {...common} /> : <input className="br-md-input" {...common} />;
}

const common = <T,>(vals: T[]): { value: T | undefined; multi: boolean } => {
  const s = new Set(vals.map((v) => JSON.stringify(v ?? null)));
  return { value: vals[0], multi: s.size > 1 };
};

function gpsText(lat: number, lon: number) {
  const f = (v: number, p: string, n: string) => {
    const a = Math.abs(v);
    const d = Math.floor(a);
    const m = (a - d) * 60;
    return `${d}°${m.toFixed(3)}′ ${v >= 0 ? p : n}`;
  };
  return `${f(lat, 'N', 'S')}, ${f(lon, 'E', 'W')}`;
}

function SingleFile({ e, m }: { e: FsEntry; m: ItemMeta | undefined }) {
  const x = m?.exif;
  const d = orientedDims(x);
  const fs = A.backend();
  useEffect(() => {
    if (kindOf(e.name) === 'raw') void A.ensureRawMeta(e.path);
  }, [e]);
  return (
    <>
      <Group title="File Properties">
        <Row k="Filename" v={e.name} />
        <Row k="Document Type" v={typeLabel(e.name, e.dir)} />
        <Row k="Date Created" v={fmtDate(itemDate(e, m))} />
        <Row k="Date File Modified" v={fmtDate(e.mtime)} />
        <Row k="File Size" v={e.dir ? '' : fmtSize(e.size)} />
        <Row k="Dimensions" v={d ? `${d.w} × ${d.h}` : ''} />
        <Row k="Orientation" v={d ? (d.w > d.h ? 'Landscape' : d.w < d.h ? 'Portrait' : 'Square') : ''} />
        <Row k="Color Profile" v={x?.colorProfile} />
        <Row k="Color Space" v={x?.colorSpace} />
        <Row k="Location" v={<span className="br-md-path">{fs.displayPath(e.path)}</span>} />
        <Row k="XMP Sidecar" v={m?.sidecarPath ? <span className="br-md-path">{fs.displayPath(m.sidecarPath).split('/').pop()}</span> : ''} />
        <Row k="Metadata from" v={x?.source === 'libraw' ? 'LibRaw (RAW decoder)' : x ? 'EXIF' : ''} />
      </Group>
      <Group title="Camera Data (EXIF)">
        <Row k="Exposure" v={x?.exposureTime || x?.fNumber ? `${shutterText(x?.exposureTime)}${x?.exposureTime ? ' s' : ''}${x?.fNumber ? ` at f/${Math.round(x.fNumber * 10) / 10}` : ''}` : ''} />
        <Row k="Exposure Bias" v={x?.exposureBias !== undefined ? `${x.exposureBias > 0 ? '+' : ''}${Math.round(x.exposureBias * 100) / 100} EV` : ''} />
        <Row k="Exposure Program" v={x?.exposureProgram} />
        <Row k="ISO Speed Ratings" v={x?.iso ? String(x.iso) : ''} />
        <Row k="Focal Length" v={x?.focalLength ? `${Math.round(x.focalLength * 10) / 10} mm${x.focalLength35 ? ` (${x.focalLength35} mm in 35 mm)` : ''}` : ''} />
        <Row k="Lens" v={x?.lens} />
        <Row k="Flash" v={x?.flash} />
        <Row k="Metering Mode" v={x?.meteringMode} />
        <Row k="White Balance" v={x?.whiteBalance} />
        <Row k="Date Time Original" v={x?.dateTaken !== undefined ? new Date(x.dateTaken).toLocaleString(undefined, { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'medium' }) : ''} />
        <Row k="Make" v={x?.make} />
        <Row k="Model" v={cameraName(x) !== x?.make ? x?.model : ''} />
        <Row k="Software" v={x?.software} />
        <Row k="Artist" v={x?.artist} />
        {!x && <Row k="" v={<span className="muted">{m ? 'No camera data' : 'Reading…'}</span>} />}
      </Group>
      {x?.gps && (
        <Group title="GPS">
          <Row k="Position" v={gpsText(x.gps.lat, x.gps.lon)} />
          <Row k="Altitude" v={x.gps.alt !== undefined ? `${Math.round(x.gps.alt)} m` : ''} />
          <Row
            k="Map"
            v={
              <a href={`https://www.openstreetmap.org/?mlat=${x.gps.lat.toFixed(6)}&mlon=${x.gps.lon.toFixed(6)}#map=15/${x.gps.lat.toFixed(5)}/${x.gps.lon.toFixed(5)}`} target="_blank" rel="noreferrer">
                <Icon name="map_go" /> Open in OpenStreetMap
              </a>
            }
          />
        </Group>
      )}
    </>
  );
}

export function MetadataPanel({ panelId }: { panelId: string }) {
  useEffect(() => void A.initBrowser(), []);
  const sel = useBrowser((s) => s.selection);
  const entries = useBrowser((s) => s.entries);
  const metaAll = useBrowser((s) => s.meta);
  const items = sel.map((p) => entries.find((e) => e.path === p)).filter((e): e is FsEntry => !!e && !e.dir);
  const paths = items.map((e) => e.path);
  const metas = items.map((e) => metaAll[e.path]);
  const xs: XmpData[] = metas.map((m) => m?.xmp ?? {});
  const rating = common(xs.map((x) => x.rating ?? 0));
  const label = common(xs.map((x) => labelColor(x.label) ?? x.label ?? ''));
  const field = (k: keyof XmpData) => common(xs.map((x) => (k === 'keywords' ? (x.keywords ?? []).join(', ') : String(x[k] ?? ''))));
  const set = (f: Partial<XmpData>) => A.setFields(paths, f);
  return (
    <Panel title="Metadata" icon="information" className="br-panel">
      <div className="br-metadata" {...focusProps(panelId)}>
        {!items.length ? (
          <div className="br-hint muted">{sel.length ? 'Folders have no metadata.' : 'Select a file to see its metadata.'}</div>
        ) : (
          <>
            <div className="br-md-head">
              <b>{items.length === 1 ? items[0].name : `${items.length} documents selected`}</b>
              <div className="br-md-cull">
                {rating.multi ? <span className="muted">{MIXED}</span> : <Stars rating={rating.value} onRate={(r) => A.setRating(paths, r)} />}
                <button className={'tbtn small' + (rating.value === -1 && !rating.multi ? ' checked' : '')} title="Reject (⌥⌫)" onClick={() => A.setRating(paths, rating.value === -1 ? 0 : -1)}>
                  <Icon name="reject" />
                </button>
                <select
                  className="br-md-label"
                  value={label.multi ? '__multi' : (label.value ?? '')}
                  onChange={(e) => (e.target.value === '' ? A.setLabel(paths, null) : e.target.value !== '__multi' && set({ label: LABELS.find((l) => l.color === e.target.value)?.name }))}
                  style={{ borderLeftColor: labelCss(xs[0]?.label) ?? 'transparent' }}
                >
                  {label.multi && <option value="__multi">{MIXED}</option>}
                  <option value="">No Label</option>
                  {LABELS.map((l) => (
                    <option key={l.color} value={l.color}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <Group title="IPTC Core">
              <tr>
                <th>Title</th>
                <td>
                  <EditField value={field('title').multi ? '' : (field('title').value ?? '')} multi={field('title').multi} onCommit={(v) => set({ title: v })} />
                </td>
              </tr>
              <tr>
                <th>Description</th>
                <td>
                  <EditField area value={field('description').multi ? '' : (field('description').value ?? '')} multi={field('description').multi} onCommit={(v) => set({ description: v })} />
                </td>
              </tr>
              <tr>
                <th>Keywords</th>
                <td>
                  <EditField
                    value={field('keywords').multi ? '' : (field('keywords').value ?? '')}
                    multi={field('keywords').multi}
                    placeholder="comma, separated"
                    onCommit={(v) =>
                      set({
                        keywords: v
                          .split(/[,;]/)
                          .map((k) => k.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                </td>
              </tr>
              <tr>
                <th>Creator</th>
                <td>
                  <EditField value={field('creator').multi ? '' : (field('creator').value ?? '')} multi={field('creator').multi} onCommit={(v) => set({ creator: v })} />
                </td>
              </tr>
              <tr>
                <th>Copyright</th>
                <td>
                  <EditField value={field('copyright').multi ? '' : (field('copyright').value ?? '')} multi={field('copyright').multi} placeholder="© …" onCommit={(v) => set({ copyright: v })} />
                </td>
              </tr>
            </Group>
            {items.length === 1 && <SingleFile e={items[0]} m={metas[0]} />}
            <div className="br-hint muted br-md-foot">
              {A.backend().caps.sidecarOnDisk ? 'Rating, label, keywords and IPTC fields are saved to XMP sidecar files (.xmp) that Bridge and Lightroom read. Image files are never modified.' : 'Rating, label, keywords and IPTC fields are kept in this browser.'}
            </div>
          </>
        )}
      </div>
    </Panel>
  );
}
