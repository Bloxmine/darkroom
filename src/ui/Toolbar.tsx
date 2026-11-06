import { useEffect, useState } from 'react';
import { useDoc } from '../store/doc';
import { renameProject } from '../store/io';
import { useUi } from '../store/ui';
import { commands, displayKeys } from './commands';
import { Icon } from './Icon';

const LAYOUT: (string | '|')[] = [
  'file.new',
  'file.open',
  'file.save',
  '|',
  'file.import',
  'file.export',
  '|',
  'edit.undo',
  'edit.redo',
  '|',
  'edit.cut',
  'edit.copy',
  'edit.paste',
  'edit.delete',
  '|',
  'node.add',
  'edit.group',
  'edit.ungroup',
  'node.bypass',
  'node.view',
  '|',
  'view.fitGraph',
  'view.fitImage',
  'view.actual',
  'view.compare',
  '|',
  'help.shortcuts',
];

export function ToolButton({ id, small }: { id: string; small?: boolean }) {
  const c = commands[id];
  if (!c) return null;
  const disabled = c.enabled ? !c.enabled() : false;
  const checked = c.checked?.();
  const keys = displayKeys(c.keys);
  return (
    <button
      className={'tbtn' + (checked ? ' checked' : '') + (small ? ' small' : '')}
      disabled={disabled}
      title={keys ? `${c.label} (${keys})` : c.label}
      onClick={() => c.run()}
      onMouseDown={(e) => e.preventDefault()}
    >
      {c.icon && <Icon name={c.icon} />}
    </button>
  );
}

export function Toolbar() {
  // subscribe to things that affect enabled/checked states
  useDoc((s) => `${s.past.length}|${s.future.length}|${s.selection.join()}|${s.edgeSelection.length}|${s.path.length}`);
  useUi((s) => `${s.compare}|${s.showLibrary}|${s.showProperties}`);
  return (
    <div className="toolbar">
      <span className="toolbar-grip" />
      {LAYOUT.map((id, i) => (id === '|' ? <span key={i} className="tsep" /> : <ToolButton key={id} id={id} />))}
      <span className="flex1" />
      <ProjectName />
    </div>
  );
}

function ProjectName() {
  const name = useDoc((s) => s.project.name);
  const [v, setV] = useState(name);
  useEffect(() => setV(name), [name]);
  return (
    <label className="tb-label project-name" title="Project name (used for saved and exported file names)">
      <Icon name="book_picture" /> Project
      <input
        className="field"
        value={v}
        spellCheck={false}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => v.trim() && v !== name && renameProject(v.trim())}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
    </label>
  );
}
