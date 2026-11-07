import { NodeResizer, type Node, type NodeProps } from '@xyflow/react';
import { memo, useEffect, useRef, useState } from 'react';
import type { Frame } from '../core/types';
import { updateFrame } from '../store/graphEdit';
import { useGraphUi } from '../store/graphUi';
import { tagColor } from './graphIds';

export interface FrameData extends Record<string, unknown> {
  frame: Frame;
}
export type FrameNode = Node<FrameData, 'frame'>;


function Editor({ value, multiline, onCommit, onCancel }: { value: string; multiline?: boolean; onCommit: (v: string) => void; onCancel: () => void }) {
  const [v, setV] = useState(value);
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const props = {
    ref,
    value: v,
    spellCheck: false,
    className: (multiline ? 'fr-note-input' : 'fr-title-input') + ' nodrag nowheel nopan',
    onChange: (e: React.ChangeEvent<HTMLInputElement & HTMLTextAreaElement>) => setV(e.target.value),
    onBlur: () => onCommit(v),
    onMouseDown: (e: React.MouseEvent) => e.stopPropagation(),
    onDoubleClick: (e: React.MouseEvent) => e.stopPropagation(),
    onKeyDown: (e: React.KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Escape') onCancel();
      else if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) onCommit(v);
    },
  };
  return multiline ? <textarea {...props} placeholder="Note text… (⌘/Ctrl+Enter to finish)" /> : <input {...props} />;
}

/** A backdrop frame or sticky note, drawn as a low-z React Flow node. Drag it by its title bar. */
function FrameViewImpl({ data, selected }: NodeProps<FrameNode>) {
  const f = data.frame;
  const note = f.kind === 'note';
  const renaming = useGraphUi((s) => s.renaming);
  const editTitle = renaming === 'frame:' + f.id;
  const editNote = renaming === 'note:' + f.id;
  const done = () => useGraphUi.setState({ renaming: null });
  const color = tagColor(f.color || (note ? 'yellow' : 'blue'));
  return (
    <>
      <NodeResizer
        isVisible={selected}
        minWidth={note ? 100 : 140}
        minHeight={note ? 50 : 80}
        lineClassName="fr-resize-line"
        handleClassName="fr-resize-handle"
        onResizeEnd={(_, p) => updateFrame(f.id, { position: { x: Math.round(p.x), y: Math.round(p.y) }, size: { width: Math.round(p.width), height: Math.round(p.height) } })}
      />
      <div className={'fr' + (note ? ' fr-sticky' : ' fr-frame') + (selected ? ' selected' : '')} style={{ '--fr': color } as React.CSSProperties}>
        <div
          className="fr-head"
          title="Drag to move the frame and the nodes inside it · double-click to rename"
          onDoubleClick={(e) => {
            e.stopPropagation();
            useGraphUi.setState({ renaming: 'frame:' + f.id });
          }}
        >
          {editTitle ? (
            <Editor
              value={f.title}
              onCommit={(v) => {
                if (v !== f.title) updateFrame(f.id, { title: v });
                done();
              }}
              onCancel={done}
            />
          ) : (
            <span className="fr-title">{f.title || (note ? 'Note' : 'Frame')}</span>
          )}
        </div>
        {(note || f.note || editNote) && (
          <div
            className="fr-note"
            onDoubleClick={(e) => {
              e.stopPropagation();
              useGraphUi.setState({ renaming: 'note:' + f.id });
            }}
          >
            {editNote ? (
              <Editor
                multiline
                value={f.note ?? ''}
                onCommit={(v) => {
                  if (v !== (f.note ?? '')) updateFrame(f.id, { note: v || undefined });
                  done();
                }}
                onCancel={done}
              />
            ) : (
              f.note || <span className="fr-placeholder">Double-click to write a note</span>
            )}
          </div>
        )}
      </div>
    </>
  );
}

export const FrameView = memo(FrameViewImpl);
