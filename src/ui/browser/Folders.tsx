/** Folders (lazy tree of the granted locations) and Favorites (favourite folders, default locations, recent folders). */
import { useEffect, useState } from 'react';
import { basename } from '../../core/files/backend';
import type { FsEntry, FsRoot } from '../../core/files/types';
import { Panel } from '../Chrome';
import { Icon } from '../Icon';
import { useContextMenu, type MenuItem } from '../Menu';
import * as A from './actions';
import { folderDropProps, focusProps } from './common';
import { useBrowser } from './store';

function rootIcon(r: FsRoot) {
  const n = r.name.toLowerCase();
  if (r.needsPermission) return 'lock';
  if (r.source === 'default') return n === 'desktop' ? 'monitor' : n === 'downloads' ? 'download' : 'folder_picture';
  return 'folder_star';
}

function folderMenu(path: string, root?: FsRoot): MenuItem[] {
  const s = useBrowser.getState();
  const fav = s.favorites.includes(path);
  const fs = A.backend();
  return [
    { label: 'Open', icon: 'folder_go', run: () => void A.openFolder(path) },
    { label: fav ? 'Remove from Favorites' : 'Add to Favorites', icon: fav ? 'star' : 'folder_star', run: () => (fav ? A.removeFavorite(path) : A.addFavorite(path)) },
    { label: 'Reveal in Finder', icon: 'folder_explorer', run: () => A.reveal(path), disabled: !fs.caps.reveal, title: fs.caps.reveal ? undefined : fs.caps.why },
    { label: 'Copy Path', icon: 'page_copy', run: () => void A.copyPaths([path]) },
    ...(root ? [{ sep: true } as MenuItem, { label: root.source === 'default' ? 'Hide Location' : 'Remove Location', icon: 'delete', run: () => void A.removeRoot(root.path) } as MenuItem] : []),
  ];
}

function TreeNode({ entry, depth, root, onMenu }: { entry: { path: string; name: string }; depth: number; root?: FsRoot; onMenu: (e: React.MouseEvent, items: MenuItem[]) => void }) {
  const expanded = useBrowser((s) => s.expanded.includes(entry.path));
  const kids = useBrowser((s) => s.tree[entry.path]);
  const cur = useBrowser((s) => (s.source?.type === 'folder' ? s.source.path : null));
  const showHidden = useBrowser((s) => s.showHidden);
  useEffect(() => {
    if (expanded && kids === undefined && !root?.needsPermission) void A.listFolders(entry.path);
  }, [expanded, kids, entry.path, root?.needsPermission, showHidden]);
  const toggle = () =>
    useBrowser.setState((s) => ({ expanded: s.expanded.includes(entry.path) ? s.expanded.filter((x) => x !== entry.path) : [...s.expanded, entry.path] }));
  const open = () => (root?.needsPermission ? void A.grantAccess(root.path) : void A.openFolder(entry.path));
  return (
    <>
      <div
        className={'br-tree-row' + (cur === entry.path ? ' selected' : '')}
        style={{ paddingLeft: 4 + depth * 14 }}
        onClick={open}
        onDoubleClick={toggle}
        onContextMenu={(e) => onMenu(e, folderMenu(entry.path, root))}
        title={root?.needsPermission ? 'Click to grant access again' : A.backend().displayPath(entry.path)}
        {...folderDropProps(entry.path)}
      >
        <span
          className={'br-twisty' + (kids && !kids.length ? ' empty' : '')}
          onClick={(e) => {
            e.stopPropagation();
            toggle();
          }}
        >
          {kids && !kids.length ? '' : expanded ? '▾' : '▸'}
        </span>
        <Icon name={root ? rootIcon(root) : cur === entry.path ? 'folder_image' : 'folder'} />
        <span className="br-tree-name">{entry.name}</span>
      </div>
      {expanded && kids?.map((k: FsEntry) => <TreeNode key={k.path} entry={k} depth={depth + 1} onMenu={onMenu} />)}
      {expanded && kids === undefined && !root?.needsPermission && (
        <div className="br-tree-row muted" style={{ paddingLeft: 22 + depth * 14 }}>
          Loading…
        </div>
      )}
    </>
  );
}

function AddFolderButton() {
  const fs = A.backend();
  if (fs.kind === 'files') return null;
  return (
    <button className="btn br-add-folder" onClick={() => void A.addFolder()} title="Give Darkroom access to a folder and add it to Favorites">
      <Icon name="folder_add" /> Add Folder…
    </button>
  );
}

export function FoldersPanel({ panelId }: { panelId: string }) {
  useEffect(() => void A.initBrowser(), []);
  const roots = useBrowser((s) => s.roots);
  const menu = useContextMenu();
  const onMenu = (e: React.MouseEvent, items: MenuItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    menu.open(e, items);
  };
  return (
    <Panel
      title="Folders"
      icon="folder"
      className="br-panel"
      tools={
        <button className="tbtn small" title="Add Folder…" onClick={() => void A.addFolder()} disabled={A.backend().kind === 'files'}>
          <Icon name="folder_add" />
        </button>
      }
    >
      <div className="br-tree" {...focusProps(panelId)}>
        {roots.map((r) => (
          <TreeNode key={r.path} entry={r} depth={0} root={r} onMenu={onMenu} />
        ))}
        {!roots.length && <div className="br-hint muted">No folders yet.</div>}
        <AddFolderButton />
      </div>
      {menu.el}
    </Panel>
  );
}

function FavRow({ path, name, icon, onMenu, title }: { path: string; name: string; icon: string; onMenu: (e: React.MouseEvent) => void; title?: string }) {
  const cur = useBrowser((s) => (s.source?.type === 'folder' ? s.source.path : null));
  return (
    <div className={'br-fav-row' + (cur === path ? ' selected' : '')} onClick={() => void A.openFolder(path)} onContextMenu={onMenu} title={title ?? A.backend().displayPath(path)} {...folderDropProps(path)}>
      <Icon name={icon} />
      <span className="br-tree-name">{name}</span>
    </div>
  );
}

export function FavoritesPanel({ panelId }: { panelId: string }) {
  useEffect(() => void A.initBrowser(), []);
  const roots = useBrowser((s) => s.roots);
  const favorites = useBrowser((s) => s.favorites);
  const recent = useBrowser((s) => s.recent);
  const collections = useBrowser((s) => s.collections);
  const [showRecent, setShowRecent] = useState(true);
  const menu = useContextMenu();
  const cur = useBrowser((s) => (s.source?.type === 'folder' ? s.source.path : null));
  const rootOf = (p: string) => roots.find((r) => r.path === p);
  const defaults = roots.filter((r) => r.source === 'default');
  const favs = favorites.filter((f) => !defaults.some((d) => d.path === f));
  const onMenu = (e: React.MouseEvent, path: string) => {
    e.preventDefault();
    e.stopPropagation();
    menu.open(e, folderMenu(path, rootOf(path)));
  };
  return (
    <Panel
      title="Favorites"
      icon="star"
      className="br-panel"
      tools={
        <button className="tbtn small" title="Add the current folder to Favorites" disabled={!cur || favorites.includes(cur)} onClick={() => cur && A.addFavorite(cur)}>
          <Icon name="folder_star" />
        </button>
      }
    >
      <div className="br-favs" {...focusProps(panelId)}>
        {defaults.map((r) => (
          <FavRow key={r.path} path={r.path} name={r.name} icon={rootIcon(r)} onMenu={(e) => onMenu(e, r.path)} />
        ))}
        {favs.map((p) => {
          const r = rootOf(p);
          return r?.needsPermission ? (
            <div key={p} className="br-fav-row" onClick={() => void A.grantAccess(p)} title="Click to grant access again">
              <Icon name="lock" />
              <span className="br-tree-name">{r.name}</span>
            </div>
          ) : (
            <FavRow key={p} path={p} name={r?.name ?? basename(p)} icon="folder_star" onMenu={(e) => onMenu(e, p)} />
          );
        })}
        {collections.length > 0 && (
          <div className="br-fav-row" onClick={() => void A.openCollection(collections[0].id)} title="Collections (see the Collections panel)">
            <Icon name="book" />
            <span className="br-tree-name">Collections</span>
          </div>
        )}
        <AddFolderButton />
        <div className="br-section" onClick={() => setShowRecent((x) => !x)}>
          {showRecent ? '▾' : '▸'} Recent Folders
        </div>
        {showRecent &&
          (recent.length ? (
            recent.slice(0, 10).map((p) => <FavRow key={p} path={p} name={A.backend().displayPath(p).split('/').pop() || p} icon="clock" onMenu={(e) => onMenu(e, p)} />)
          ) : (
            <div className="br-hint muted">None yet.</div>
          ))}
        {recent.length > 0 && showRecent && (
          <button className="br-linkbtn br-clear-recent" onClick={() => useBrowser.setState({ recent: [] })}>
            Clear Recent Folders
          </button>
        )}
      </div>
      {menu.el}
    </Panel>
  );
}

