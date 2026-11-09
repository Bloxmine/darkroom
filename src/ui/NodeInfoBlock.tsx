import { useSyncExternalStore } from 'react';
import { nodeInfosFor, nodeInfoVersion, subscribeNodeInfo } from '../core/nodeInfo';
import { renameProject } from '../store/io';
import { status } from '../store/ui';
import { Icon } from './Icon';

/** Read-only results a node published with setNodeInfo() (caption / OCR text…), with Copy and optional rename. */
export function NodeInfoBlock({ flatId }: { flatId: string }) {
  useSyncExternalStore(subscribeNodeInfo, nodeInfoVersion);
  const list = nodeInfosFor(flatId);
  if (!list.length) return null;
  return (
    <>
      {list.map((info, i) => (
        <div className="pnote node-info" key={i}>
          {info.title && <b>{info.title}</b>}
          <textarea className="field text" readOnly value={info.text} rows={Math.min(10, Math.max(2, Math.ceil(info.text.length / 42)))} style={{ width: '100%', resize: 'vertical', marginTop: 4 }} />
          {info.detail && <div className="muted small">{info.detail}</div>}
          <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
            <button
              className="btn"
              onClick={() =>
                navigator.clipboard?.writeText(info.text).then(
                  () => status('Copied to the clipboard.'),
                  () => status('Could not copy to the clipboard.', 'error'),
                )
              }
            >
              <Icon name="page_copy" /> Copy text
            </button>
            {info.suggestName && (
              <button className="btn" title={`Rename the project to “${info.suggestName}”`} onClick={() => (renameProject(info.suggestName!), status(`Project renamed to “${info.suggestName}”.`))}>
                <Icon name="textfield_rename" /> Use as project name
              </button>
            )}
          </div>
        </div>
      ))}
    </>
  );
}
