/** New / Rename / Delete / Save-changes workspace dialogs (Window › Workspace, the switcher's ▾ menu). */
import { useState } from 'react';
import { create } from 'zustand';
import { useSettings } from '../../store/settings';
import { status } from '../../store/ui';
import { Dialog } from '../Dialogs';
import { Icon } from '../Icon';
import { deleteWorkspace, overwriteCurrent, renameWorkspace, saveCurrentAs, useWorkspaceStore, workspaceDef, workspaceList, WorkspaceError } from './store';

type Mode = 'new' | 'rename' | 'delete' | 'overwrite';
const useDlg = create<{ mode: Mode | null; target: string | null }>(() => ({ mode: null, target: null }));

export function openWorkspaceDialog(mode: Mode, target?: string) {
  useDlg.setState({ mode, target: target ?? useWorkspaceStore.getState().current });
}
const close = () => useDlg.setState({ mode: null, target: null });

/** Typing in the dialog must not reach the app's single-key shortcuts. */
const isolate = (e: React.KeyboardEvent) => {
  if (e.key !== 'Escape' && e.key !== 'Enter') e.stopPropagation();
};

function NameDialog({ mode, target }: { mode: 'new' | 'rename'; target: string }) {
  const cur = workspaceDef(target);
  const [name, setName] = useState(mode === 'rename' ? (cur?.name ?? '') : cur && !cur.builtin ? cur.name : '');
  const [err, setErr] = useState('');
  useSettings((s) => s.customWorkspaces);
  const clash = workspaceList().find((w) => !w.builtin && w.name.toLowerCase() === name.trim().toLowerCase() && w.id !== (mode === 'rename' ? target : ''));
  const ok = () => {
    try {
      if (mode === 'new') saveCurrentAs(name);
      else {
        renameWorkspace(target, name);
        status(`Renamed workspace to “${name.trim()}”.`);
      }
      close();
    } catch (e) {
      setErr(e instanceof WorkspaceError ? e.message : String(e));
    }
  };
  return (
    <Dialog
      title={mode === 'new' ? 'New Workspace' : 'Rename Workspace'}
      icon={mode === 'new' ? 'layout_add' : 'layout_edit'}
      width={380}
      onClose={close}
      buttons={
        <>
          <button className="btn default" disabled={!name.trim()} onClick={ok}>
            {mode === 'new' ? 'Save' : 'Rename'}
          </button>
          <button className="btn" onClick={close}>
            Cancel
          </button>
        </>
      }
    >
      <div className="ws-dlg" onKeyDown={isolate}>
        <label className="ws-dlg-row">
          <span>Name:</span>
          <input
            className="field"
            autoFocus
            value={name}
            maxLength={60}
            spellCheck={false}
            onChange={(e) => (setName(e.target.value), setErr(''))}
            onKeyDown={(e) => e.key === 'Enter' && name.trim() && ok()}
            data-ws-name
          />
        </label>
        {mode === 'new' && <p className="muted small">Saves the current arrangement of panels, sizes and tabs. It appears in Window › Workspace and the workspace switcher.</p>}
        {clash && mode === 'new' && (
          <p className="ws-dlg-warn">
            <Icon name="error" /> “{clash.name}” will be overwritten.
          </p>
        )}
        {err && (
          <p className="ws-dlg-err">
            <Icon name="exclamation" /> {err}
          </p>
        )}
      </div>
    </Dialog>
  );
}

function DeleteDialog({ target }: { target: string }) {
  useSettings((s) => s.customWorkspaces);
  const custom = workspaceList().filter((w) => !w.builtin);
  const [id, setId] = useState(custom.some((w) => w.id === target) ? target : (custom[0]?.id ?? ''));
  return (
    <Dialog
      title="Delete Workspace"
      icon="layout_delete"
      width={360}
      onClose={close}
      buttons={
        <>
          <button className="btn default" disabled={!id} onClick={() => (deleteWorkspace(id), close())}>
            Delete
          </button>
          <button className="btn" onClick={close}>
            Cancel
          </button>
        </>
      }
    >
      <div className="ws-dlg">
        {custom.length ? (
          <label className="ws-dlg-row">
            <span>Workspace:</span>
            <select className="field select" value={id} onChange={(e) => setId(e.target.value)} data-ws-delete>
              {custom.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p className="muted">There are no saved workspaces. Built-in workspaces can be reset but not deleted.</p>
        )}
      </div>
    </Dialog>
  );
}

function OverwriteDialog({ target }: { target: string }) {
  const w = workspaceDef(target);
  return (
    <Dialog
      title="Save Workspace"
      icon="diskette"
      width={360}
      onClose={close}
      buttons={
        <>
          <button className="btn default" onClick={() => (overwriteCurrent(), close())}>
            Save
          </button>
          <button className="btn" onClick={close}>
            Cancel
          </button>
        </>
      }
    >
      <p>
        Replace the saved layout of <b>{w?.name}</b> with the current arrangement?
      </p>
    </Dialog>
  );
}

export function WorkspaceDialogs() {
  const { mode, target } = useDlg();
  if (!mode || !target) return null;
  if (mode === 'delete') return <DeleteDialog target={target} />;
  if (mode === 'overwrite') return <OverwriteDialog target={target} />;
  return <NameDialog key={mode + target} mode={mode} target={target} />;
}
