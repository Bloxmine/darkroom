import { useState } from 'react';
import { listNodeDefs, listPresets } from '../core/registry';
import { GROUP_INPUT, GROUP_OUTPUT } from '../core/graph';
import { addNode, freeSpot } from '../store/actions';
import { useDoc } from '../store/doc';
import { useUi } from '../store/ui';
import { graphApi } from './commands';
import { categoryIcon, nodeIcon } from './Icon';
import { MenuList, useOutsideClose, type MenuItem } from './Menu';
import { useRegistry } from './useRegistry';

function addAt() {
  return graphApi.mouseFlowPos() ?? freeSpot();
}

/** Category → node submenus, built live from the registry. */
export function addNodeMenus(at: () => { x: number; y: number } = addAt): MenuItem[] {
  const inGroup = useDoc.getState().path.length > 0;
  const defs = listNodeDefs().filter((d) => !d.hidden || (inGroup && (d.id === GROUP_INPUT || d.id === GROUP_OUTPUT)));
  const cats = new Map<string, typeof defs>();
  for (const d of defs) cats.set(d.category, [...(cats.get(d.category) ?? []), d]);
  const items: MenuItem[] = [...cats.keys()].sort().map((cat) => ({
    label: cat,
    icon: categoryIcon(cat),
    submenu: () =>
      cats
        .get(cat)!
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((d) => ({ label: d.name, icon: nodeIcon(d.id), title: d.description, run: () => void addNode({ kind: 'node', type: d.id }, at()) })),
  }));
  const presets = listPresets();
  if (presets.length) {
    const pc = new Map<string, typeof presets>();
    for (const p of presets) pc.set(p.category, [...(pc.get(p.category) ?? []), p]);
    items.push({ sep: true });
    items.push({
      label: 'Presets',
      icon: 'star',
      submenu: () =>
        [...pc.keys()].sort().map((c) => ({
          label: c,
          icon: categoryIcon(c),
          submenu: () =>
            pc
              .get(c)!
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((p) => ({ label: p.name, icon: 'bricks', title: p.description, run: () => void addNode({ kind: 'preset', id: p.id }, at()) })),
        })),
    });
  }
  return items;
}

const MENUS: { title: string; items: () => MenuItem[] }[] = [
  {
    title: 'File',
    items: () => [
      { cmd: 'file.new' },
      { cmd: 'file.open' },
      { cmd: 'file.save' },
      { sep: true },
      { cmd: 'file.import' },
      { cmd: 'file.export' },
    ],
  },
  {
    title: 'Edit',
    items: () => [
      { cmd: 'edit.undo' },
      { cmd: 'edit.redo' },
      { sep: true },
      { cmd: 'edit.cut' },
      { cmd: 'edit.copy' },
      { cmd: 'edit.paste' },
      { cmd: 'edit.duplicate' },
      { cmd: 'edit.delete' },
      { sep: true },
      { cmd: 'edit.selectAll' },
      { sep: true },
      { cmd: 'edit.group' },
      { cmd: 'edit.ungroup' },
      { cmd: 'edit.enterGroup' },
      { cmd: 'edit.exitGroup' },
    ],
  },
  {
    title: 'View',
    items: () => [
      { cmd: 'view.fitGraph' },
      { sep: true },
      { cmd: 'view.fitImage' },
      { cmd: 'view.actual' },
      { cmd: 'view.zoomIn' },
      { cmd: 'view.zoomOut' },
      { sep: true },
      { cmd: 'view.compare' },
      { sep: true },
      { cmd: 'view.library' },
      { cmd: 'view.properties' },
    ],
  },
  {
    title: 'Node',
    items: () => [
      { cmd: 'node.add' },
      { sep: true },
      ...addNodeMenus(),
      { sep: true },
      { cmd: 'node.bypass' },
      { cmd: 'node.view' },
      { cmd: 'node.viewOutput' },
    ],
  },
  {
    title: 'Window',
    items: () => [{ cmd: 'view.library' }, { cmd: 'view.properties' }],
  },
  {
    title: 'Help',
    items: () => [{ cmd: 'help.shortcuts' }, { sep: true }, { cmd: 'help.about' }],
  },
];

export function MenuBar() {
  const [open, setOpen] = useState<number | null>(null);
  useRegistry();
  useDoc((s) => s.past.length + s.future.length + s.selection.length + s.path.length); // refresh enabled states
  useUi((s) => s.compare);
  const close = () => setOpen(null);
  return (
    <div className="menubar" onMouseDown={(e) => e.stopPropagation()}>
      <img src="/icons/fatcow/16x16/camera_lens.png" className="menubar-logo" alt="" />
      {MENUS.map((m, i) => (
        <div
          key={m.title}
          className={'menubar-item' + (open === i ? ' open' : '')}
          onMouseDown={() => setOpen(open === i ? null : i)}
          onMouseEnter={() => open !== null && setOpen(i)}
        >
          <u>{m.title[0]}</u>
          {m.title.slice(1)}
          {open === i && <Dropdown items={m.items()} onClose={close} />}
        </div>
      ))}
    </div>
  );
}

function Dropdown({ items, onClose }: { items: MenuItem[]; onClose: () => void }) {
  useOutsideClose(onClose);
  return <MenuList items={items} onClose={onClose} style={{ position: 'absolute', left: -1, top: '100%', zIndex: 900 }} />;
}
