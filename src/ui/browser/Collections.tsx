/** Collections panel: saved sets of files, and Smart Collections (a folder + Filter selection). */
import { useEffect } from 'react';
import { basename } from '../../core/files/backend';
import { DND_FILES, focusProps } from './common';
import { Panel } from '../Chrome';
import { Icon } from '../Icon';
import { useContextMenu } from '../Menu';
import * as A from './actions';
import { useBrowser } from './store';

export function CollectionsPanel({ panelId }: { panelId: string }) {
  useEffect(() => void A.initBrowser(), []);
  const collections = useBrowser((s) => s.collections);
  const smart = useBrowser((s) => s.smart);
  const src = useBrowser((s) => s.source);
  const hasSel = useBrowser((s) => s.selection.length > 0);
  const menu = useContextMenu();
  return (
    <Panel
      title="Collections"
      icon="book"
      className="br-panel"
      tools={
        <>
          <button className="tbtn small" title={hasSel ? 'New Collection from the selection…' : 'New Collection…'} onClick={() => void A.newCollection(A.selectedFiles())}>
            <Icon name="book_add" />
          </button>
          <button className="tbtn small" title="New Smart Collection from the current folder and filter…" disabled={!useBrowser.getState().lastFolder} onClick={() => void A.saveSmartCollection()}>
            <Icon name="book_open" />
          </button>
        </>
      }
    >
      <div className="br-collections" {...focusProps(panelId)}>
        {!collections.length && !smart.length && (
          <div className="br-hint muted">
            No collections. Select files and click <Icon name="book_add" /> — or drag files here. A Smart Collection saves the current folder with its Filter panel selection.
          </div>
        )}
        {collections.map((c) => (
          <div
            key={c.id}
            className={'br-fav-row' + (src?.type === 'collection' && src.id === c.id ? ' selected' : '')}
            onClick={() => void A.openCollection(c.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              menu.open(e, [
                { label: 'Open', icon: 'book_open', run: () => void A.openCollection(c.id) },
                { label: 'Add Selection', icon: 'add', run: () => A.addToCollection(c.id, A.selectedFiles()), disabled: !A.selectedFiles().length },
                { label: 'Rename…', icon: 'textfield_rename', run: () => void A.renameCollection(c.id) },
                { label: 'Delete', icon: 'delete', run: () => void A.deleteCollection(c.id) },
              ]);
            }}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes(DND_FILES)) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
              }
            }}
            onDrop={(e) => {
              const raw = e.dataTransfer.getData(DND_FILES);
              if (!raw) return;
              e.preventDefault();
              A.addToCollection(c.id, JSON.parse(raw) as string[]);
            }}
            title={`${c.paths.length} item(s)`}
          >
            <Icon name="book" />
            <span className="br-tree-name">{c.name}</span>
            <span className="br-facet-count">{c.paths.length}</span>
          </div>
        ))}
        {smart.length > 0 && <div className="br-section">Smart Collections</div>}
        {smart.map((c) => (
          <div
            key={c.id}
            className={'br-fav-row' + (src?.type === 'smart' && src.id === c.id ? ' selected' : '')}
            onClick={() => void A.openSmart(c.id)}
            title={`In ${basename(c.folder)}: ${Object.entries(c.filters)
              .filter(([, v]) => v?.length)
              .map(([k, v]) => `${k} = ${v!.join(' or ')}`)
              .join('; ')}`}
            onContextMenu={(e) => {
              e.preventDefault();
              menu.open(e, [
                { label: 'Open', icon: 'book_open', run: () => void A.openSmart(c.id) },
                { label: 'Rename…', icon: 'textfield_rename', run: () => void A.renameCollection(c.id, true) },
                { label: 'Delete', icon: 'delete', run: () => void A.deleteCollection(c.id, true) },
              ]);
            }}
          >
            <Icon name="book_open" />
            <span className="br-tree-name">{c.name}</span>
          </div>
        ))}
      </div>
      {menu.el}
    </Panel>
  );
}
