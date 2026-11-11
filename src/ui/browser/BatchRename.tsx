/** Batch Rename (Bridge's Tools › Batch Rename): build names from parts, live preview, conflict detection. */
import { useMemo, useState } from 'react';
import { basename, dirname } from '../../core/files/backend';
import { META_LABELS, planRenames, DEFAULT_RENAME_PARTS, type MetaField, type RenameOptions, type RenamePart } from '../../core/files/rename';
import { Dialog } from '../Dialogs';
import { Icon } from '../Icon';
import * as A from './actions';
import { useBrowser, visibleItems } from './store';

const PART_TYPES: { id: RenamePart['type']; label: string; make: () => RenamePart }[] = [
  { id: 'text', label: 'Text', make: () => ({ type: 'text', text: '' }) },
  { id: 'name', label: 'Current Filename', make: () => ({ type: 'name', case: 'keep' }) },
  { id: 'seq', label: 'Sequence Number', make: () => ({ type: 'seq', start: 1, digits: 3 }) },
  { id: 'letter', label: 'Sequence Letter', make: () => ({ type: 'letter', upper: false }) },
  { id: 'date', label: 'Date Time', make: () => ({ type: 'date', source: 'taken', format: 'YYYYMMDD' }) },
  { id: 'meta', label: 'Metadata', make: () => ({ type: 'meta', field: 'model' }) },
  { id: 'folder', label: 'Folder Name', make: () => ({ type: 'folder' }) },
];
const DATE_FORMATS = ['YYYYMMDD', 'YYYY-MM-DD', 'YYMMDD', 'DDMMYYYY', 'MMDDYYYY', 'YYYYMMDD_hhmmss', 'YYYY-MM-DD hh.mm.ss', 'hhmmss'];

let lastParts: RenamePart[] = DEFAULT_RENAME_PARTS;
let lastOpts: RenameOptions = { ext: 'keep' };

function PartEditor({ p, onChange }: { p: RenamePart; onChange: (p: RenamePart) => void }) {
  switch (p.type) {
    case 'text':
      return <input className="field br-br-text" value={p.text} placeholder="text" onChange={(e) => onChange({ ...p, text: e.target.value })} autoFocus={!p.text} />;
    case 'name':
      return (
        <select className="field select" value={p.case ?? 'keep'} onChange={(e) => onChange({ ...p, case: e.target.value as 'keep' })}>
          <option value="keep">Name (keep case)</option>
          <option value="lower">lowercase</option>
          <option value="upper">UPPERCASE</option>
        </select>
      );
    case 'seq':
      return (
        <>
          <input className="field num" type="number" value={p.start ?? 1} onChange={(e) => onChange({ ...p, start: Number(e.target.value) || 0 })} title="Start at" />
          <select className="field select" value={p.digits ?? 3} onChange={(e) => onChange({ ...p, digits: Number(e.target.value) })}>
            {[1, 2, 3, 4, 5, 6].map((d) => (
              <option key={d} value={d}>
                {d} Digit{d > 1 ? 's' : ''}
              </option>
            ))}
          </select>
        </>
      );
    case 'letter':
      return (
        <select className="field select" value={p.upper ? 'u' : 'l'} onChange={(e) => onChange({ ...p, upper: e.target.value === 'u' })}>
          <option value="l">a, b, c…</option>
          <option value="u">A, B, C…</option>
        </select>
      );
    case 'date':
      return (
        <>
          <select className="field select" value={p.source ?? 'taken'} onChange={(e) => onChange({ ...p, source: e.target.value as 'taken' })}>
            <option value="taken">Date Time Original</option>
            <option value="created">Date Created</option>
            <option value="modified">Date File Modified</option>
          </select>
          <select className="field select" value={p.format ?? 'YYYYMMDD'} onChange={(e) => onChange({ ...p, format: e.target.value })}>
            {DATE_FORMATS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </>
      );
    case 'meta':
      return (
        <select className="field select" value={p.field} onChange={(e) => onChange({ ...p, field: e.target.value as MetaField })}>
          {(Object.keys(META_LABELS) as MetaField[]).map((k) => (
            <option key={k} value={k}>
              {META_LABELS[k]}
            </option>
          ))}
        </select>
      );
    case 'folder':
      return <span className="muted">name of the containing folder</span>;
  }
}

export function BatchRenameDialog({ paths }: { paths: string[] }) {
  const [parts, setParts] = useState<RenamePart[]>(lastParts);
  const [opts, setOpts] = useState<RenameOptions>(lastOpts);
  const [busy, setBusy] = useState(false);
  const meta = useBrowser((s) => s.meta);
  const entries = useBrowser((s) => s.entries);
  const names = useBrowser((s) => s.names);
  const close = () => useBrowser.setState({ dialog: null });
  // files in the current sort order
  const files = useMemo(() => {
    const order = new Map(paths.map((p, i) => [p, i]));
    const vis = new Map(visibleItems().map((e, i) => [e.path, i]));
    return [...paths]
      .sort((a, b) => (vis.get(a) ?? order.get(a)!) - (vis.get(b) ?? order.get(b)!))
      .map((p) => {
        const e = entries.find((x) => x.path === p);
        return { path: p, name: basename(p), dir: dirname(p), mtime: e?.mtime ?? 0, btime: e?.btime, exif: meta[p]?.exif, xmp: meta[p]?.xmp };
      });
  }, [paths, entries, meta]);
  const plan = useMemo(() => {
    const cur = useBrowser.getState().source?.type === 'folder' ? (useBrowser.getState().source as { path: string }).path : null;
    return planRenames(files, parts, opts, (dir) => (dir === cur ? names : files.filter((f) => f.dir === dir).map((f) => f.name)));
  }, [files, parts, opts, names]);
  const problems = plan.filter((p) => p.problem).length;
  const changes = plan.filter((p) => !p.same).length;
  const update = (i: number, p: RenamePart) => setParts((ps) => ps.map((x, j) => (j === i ? p : x)));
  const go = async () => {
    lastParts = parts;
    lastOpts = opts;
    setBusy(true);
    const n = await A.applyRenames(plan.filter((p) => !p.same).map((p) => ({ from: p.path, to: p.to })));
    setBusy(false);
    if (n) close();
  };
  return (
    <Dialog
      title="Batch Rename"
      icon="document_rename"
      width={640}
      onClose={close}
      buttons={
        <>
          <span className="br-br-status">
            {problems ? (
              <span className="sb-error">
                <Icon name="error" /> {problems} conflict{problems > 1 ? 's' : ''} — fix the pattern to continue
              </span>
            ) : (
              <span className="muted">
                {changes} of {plan.length} file(s) will be renamed. Existing files are never overwritten.
              </span>
            )}
          </span>
          <button className="btn default" disabled={busy || !!problems || !changes} onClick={() => void go()}>
            {busy ? 'Renaming…' : 'Rename'}
          </button>
          <button className="btn" onClick={close}>
            Cancel
          </button>
        </>
      }
    >
      <fieldset className="br-br-parts">
        <legend>New Filenames</legend>
        {parts.map((p, i) => (
          <div key={i} className="br-br-part">
            <select className="field select br-br-type" value={p.type} onChange={(e) => update(i, PART_TYPES.find((t) => t.id === e.target.value)!.make())}>
              {PART_TYPES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
            <span className="br-br-editor">
              <PartEditor p={p} onChange={(np) => update(i, np)} />
            </span>
            <button className="tbtn small" title="Remove" disabled={parts.length < 2} onClick={() => setParts((ps) => ps.filter((_, j) => j !== i))}>
              <Icon name="delete" />
            </button>
            <button className="tbtn small" title="Add a part after this one" onClick={() => setParts((ps) => [...ps.slice(0, i + 1), { type: 'text', text: '' }, ...ps.slice(i + 1)])}>
              <Icon name="add" />
            </button>
          </div>
        ))}
        <div className="br-br-part">
          <span className="muted">Extension:</span>
          <select className="field select" value={opts.ext ?? 'keep'} onChange={(e) => setOpts({ ...opts, ext: e.target.value as 'keep' })}>
            <option value="keep">keep as is</option>
            <option value="lower">lowercase</option>
            <option value="upper">UPPERCASE</option>
          </select>
          <span className="muted">XMP sidecars are renamed with their files.</span>
        </div>
      </fieldset>
      <fieldset className="br-br-preview">
        <legend>Preview</legend>
        <div className="br-br-list" role="table">
          <div className="br-br-row head">
            <span>Current filename</span>
            <span>New filename</span>
          </div>
          {plan.map((p) => (
            <div key={p.path} className={'br-br-row' + (p.problem ? ' bad' : p.same ? ' same' : '')} title={p.problem}>
              <span>{p.from}</span>
              <span>
                {p.problem && <Icon name="exclamation" />} {p.to}
                {p.problem && <span className="br-br-problem"> — {p.problem}</span>}
              </span>
            </div>
          ))}
        </div>
      </fieldset>
    </Dialog>
  );
}
