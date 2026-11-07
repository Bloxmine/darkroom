import { useEffect, useMemo, useState } from 'react';
import { listPresets } from '../core/registry';
import { nodeName } from '../store/actions';
import { currentGraph } from '../store/doc';
import { useGraphUi } from '../store/graphUi';
import { captureGroupThumb, saveGroupAsPreset } from '../store/presets';
import { Dialog } from './Dialogs';
import { Icon } from './Icon';

const close = () => useGraphUi.setState({ dialog: null });

/** Keys typed in an editor dialog must not reach the graph shortcuts (Delete, B, H…). */
const isolate = (e: React.KeyboardEvent) => {
  if (e.key !== 'Escape') e.stopPropagation();
};

function SavePresetDialog({ groupId }: { groupId: string }) {
  const node = currentGraph().nodes.find((n) => n.id === groupId);
  const [name, setName] = useState(() => (node ? nodeName(node) : 'My Preset'));
  const [category, setCategory] = useState('My Presets');
  const [description, setDescription] = useState('');
  const [thumb, setThumb] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const cats = useMemo(() => [...new Set(['My Presets', ...listPresets().map((p) => p.category)])].sort(), []);
  useEffect(() => {
    let live = true;
    void captureGroupThumb(groupId).then((t) => live && setThumb(t));
    return () => {
      live = false;
    };
  }, [groupId]);
  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    await saveGroupAsPreset(groupId, { name: name.trim(), category: category.trim() || 'My Presets', description: description.trim(), thumb });
    close();
  };
  return (
    <Dialog
      title="Save as Preset"
      icon="star"
      width={420}
      onClose={close}
      buttons={
        <>
          <button className="btn default" disabled={busy || !name.trim() || !node} onClick={() => void save()}>
            Save Preset
          </button>
          <button className="btn" onClick={close}>
            Cancel
          </button>
        </>
      }
    >
      <div className="sp-form" onKeyDown={isolate}>
        <div className="sp-thumb sunken">
          {thumb ? <img src={thumb} alt="" /> : <span className="muted">{thumb === undefined ? 'Rendering…' : 'No preview'}</span>}
        </div>
        <div className="sp-fields">
          <label>
            Name
            <input
              className="field"
              autoFocus
              value={name}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void save()}
            />
          </label>
          <label>
            Category
            <input className="field" list="sp-cats" value={category} maxLength={60} onChange={(e) => setCategory(e.target.value)} />
            <datalist id="sp-cats">
              {cats.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </label>
          <label>
            Description
            <textarea className="field" rows={3} value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} />
          </label>
        </div>
      </div>
      <p className="sp-hint muted">
        <Icon name="information" /> The group’s inner nodes and exposed controls are saved. Find it in the Node Library under <b>My Presets</b> and in the add-node search (Tab).
      </p>
    </Dialog>
  );
}

function ConfirmDeleteDialog({ count, run }: { count: number; run: () => void }) {
  return (
    <Dialog
      title="Delete Nodes"
      icon="cross"
      onClose={close}
      buttons={
        <>
          <button
            className="btn default"
            autoFocus
            onClick={() => {
              close();
              run();
            }}
          >
            Delete {count} Nodes
          </button>
          <button className="btn" onClick={close}>
            Cancel
          </button>
        </>
      }
    >
      <div onKeyDown={isolate}>
        <p>
          <b>Delete {count} nodes?</b>
        </p>
        <p className="muted">You can undo this with Edit › Undo. The threshold is set in Preferences › General.</p>
      </div>
    </Dialog>
  );
}

export function GraphDialogs() {
  const d = useGraphUi((s) => s.dialog);
  if (d?.kind === 'savePreset') return <SavePresetDialog groupId={d.groupId} />;
  if (d?.kind === 'confirmDelete') return <ConfirmDeleteDialog count={d.count} run={d.run} />;
  return null;
}
