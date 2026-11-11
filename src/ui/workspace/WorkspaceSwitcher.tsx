/**
 * Adobe Bridge CS3-style workspace switcher (toolbar, top right): flat tab-like buttons for three
 * workspaces (pinned first, else the most recent), and a ▾ menu with every workspace and the
 * New / Save / Rename / Delete / Reset commands.
 */
import { useState } from 'react';
import { useSettings } from '../../store/settings';
import { displayKeys, commands } from '../commands';
import { ContextMenu, type MenuItem } from '../Menu';
import { WS_PREFIX, workspaceMenuItems } from './commands';
import { openWorkspaceDialog } from './dialogs';
import { resetWorkspace, setWorkspace, togglePinned, useWorkspaceStore, workspaceList } from './store';

export function WorkspaceSwitcher() {
  const current = useWorkspaceStore((s) => s.current);
  const bar = useWorkspaceStore((s) => s.bar);
  const pinned = useWorkspaceStore((s) => s.pinned);
  useSettings((s) => s.customWorkspaces);
  useSettings((s) => s.keyOverrides);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const list = workspaceList();
  const name = (id: string) => list.find((w) => w.id === id)?.name ?? id;
  const shown = bar.filter((id) => list.some((w) => w.id === id));

  const buttonMenu = (id: string): MenuItem[] => {
    const w = list.find((x) => x.id === id);
    return [
      { label: pinned.includes(id) ? 'Unpin from Bar' : 'Keep on Bar', icon: 'anchor', checked: pinned.includes(id), run: () => togglePinned(id) },
      { sep: true },
      { label: 'Reset Workspace', icon: 'arrow_refresh', run: () => (id === current ? resetWorkspace() : resetWorkspace(id)) },
      ...(w && !w.builtin
        ? ([
            { label: 'Rename…', icon: 'layout_edit', run: () => openWorkspaceDialog('rename', id) },
            { label: 'Delete…', icon: 'layout_delete', run: () => openWorkspaceDialog('delete', id) },
          ] as MenuItem[])
        : []),
    ];
  };

  return (
    <div className="ws-switcher" role="tablist" aria-label="Workspaces">
      {shown.map((id) => {
        const k = displayKeys(commands[WS_PREFIX + id]?.keys);
        return (
          <button
            key={id}
            role="tab"
            aria-selected={id === current}
            className={'ws-btn' + (id === current ? ' active' : '') + (pinned.includes(id) ? ' pinned' : '')}
            title={`${name(id)} workspace${k ? ` (${k})` : ''} — right-click for options`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setWorkspace(id)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, items: buttonMenu(id) });
            }}
            data-ws={id}
          >
            {name(id)}
          </button>
        );
      })}
      <button
        className={'ws-btn ws-more' + (menu ? ' open' : '')}
        title="All workspaces"
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          setMenu(menu ? null : { x: Math.max(4, r.right - 230), y: r.bottom + 1, items: workspaceMenuItems() });
        }}
        data-ws-menu
      >
        ▾
      </button>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}
