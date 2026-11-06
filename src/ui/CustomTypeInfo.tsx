import { describeOrigin, getNodeOrigin } from '../core/customNodes';
import { GROUP } from '../core/graph';
import { missingNodeMessage } from '../core/registry';
import type { GraphNode } from '../core/types';
import { canEditInBuilder, exportNodeType, openNodeBuilder } from '../store/extensions';
import { openDialog, useUi } from '../store/ui';
import { Icon } from './Icon';

/** Properties panel rows for custom / plugin node types: origin + "Edit Node Type…". */
export function CustomTypeRow({ node }: { node: GraphNode }) {
  if (node.type === GROUP || !getNodeOrigin(node.type)) return null;
  const editable = canEditInBuilder(node.type);
  const plugin = getNodeOrigin(node.type)?.kind === 'plugin';
  return (
    <div className="prow">
      <div className="plabel">Type</div>
      <div className="pwidget">
        <div className="muted small">{describeOrigin(node.type)}</div>
        {editable && (
          <button className="btn" onClick={() => openNodeBuilder(node.type)} title={plugin ? 'Open a copy in the Node Builder' : 'Open in the Node Builder'}>
            <Icon name="script_edit" /> Edit Node Type…
          </button>
        )}
        {editable && (
          <button className="btn" onClick={() => exportNodeType(node.type)} title="Export as .drnode.json">
            <Icon name="diskette" />
          </button>
        )}
        {plugin && !editable && (
          <button className="btn" onClick={() => openDialog('plugins')}>
            <Icon name="plugin" /> Plugins…
          </button>
        )}
      </div>
    </div>
  );
}

/** Missing-type note naming the plugin (if known) and the node's current engine error. */
export function NodeErrorNote({ node, flatId, unknown }: { node: GraphNode; flatId: string; unknown: boolean }) {
  const err = useUi((s) => s.errors[flatId]);
  if (unknown)
    return (
      <div className="pnote error">
        <Icon name="plugin_disabled" /> {missingNodeMessage(node.type)}
      </div>
    );
  if (!err) return null;
  return (
    <div className="pnote error" style={{ whiteSpace: 'pre-wrap', fontFamily: 'var(--mono)', userSelect: 'text' }}>
      <Icon name="error" /> {err.length > 600 ? err.slice(0, 600) + '…' : err}
    </div>
  );
}
