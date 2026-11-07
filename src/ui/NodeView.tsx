import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import { memo } from 'react';
import { getPorts, GROUP, IMAGE } from '../core/graph';
import { getNodeDef } from '../core/registry';
import type { GraphNode, PortDef } from '../core/types';
import { nodeName } from '../store/actions';
import { engine } from '../store/engine';
import { useSettings } from '../store/settings';
import { Icon, nodeColor, nodeIcon } from './Icon';
import { NodeThumb } from './NodeThumb';
import { RampStrip } from './ColorRampEditor';

export interface NodeData extends Record<string, unknown> {
  node: GraphNode;
  viewed: boolean;
  isOutput: boolean;
  error?: string;
  pending: boolean;
  /** Ports referenced by edges (for nodes whose type is unknown, so their wires still attach). */
  edgePorts?: { inputs: string[]; outputs: string[] };
}

export type DrNode = Node<NodeData, 'dr'>;

export const inHandle = (port: string) => 'i:' + port;
export const outHandle = (port: string) => 'o:' + port;
export const portOf = (handle: string | null | undefined) => (handle ?? '').slice(2);

function subtitle(n: GraphNode): string | null {
  if (n.type === GROUP && n.group) return `group · ${n.group.graph.nodes.length} nodes`;
  if (n.type === IMAGE) {
    const a = engine?.assets.get(String(n.params.asset ?? ''));
    return a ? `${a.width}×${a.height}` : 'no image';
  }
  if (n.label) return getNodeDef(n.type)?.name ?? n.type;
  return null;
}

function NodeViewImpl({ data, selected }: NodeProps<DrNode>) {
  const { node, viewed, error, pending, isOutput } = data;
  const thumbs = useSettings((s) => s.nodeThumbnails);
  const ports = getPorts(node);
  const def = getNodeDef(node.type);
  const unknown = node.type !== GROUP && !def;
  // unknown type (e.g. plugin disabled): show a "missing" socket for every port an edge uses
  const missing = (names: string[] = []) => names.map((n): [string, PortDef & { missing?: boolean }] => [n, { type: 'image', missing: true }]);
  const ins: [string, PortDef & { missing?: boolean }][] = unknown ? missing(data.edgePorts?.inputs) : Object.entries(ports.inputs);
  const outs: [string, PortDef & { missing?: boolean }][] = unknown ? missing(data.edgePorts?.outputs) : Object.entries(ports.outputs);
  const rows = Math.max(ins.length, outs.length);
  const sub = subtitle(node);
  const cls = [
    'dn',
    selected && 'selected',
    viewed && 'viewed',
    node.bypass && 'bypassed',
    error && 'has-error',
    unknown && 'unknown',
    node.type === GROUP && 'is-group',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={cls} style={{ '--accent': nodeColor(node.type) } as React.CSSProperties}>
      <div className="dn-title">
        <Icon name={unknown ? 'plugin_disabled' : nodeIcon(node.type)} />
        <span className="dn-name">{nodeName(node)}</span>
        {pending && <Icon name="hourglass" title="Loading…" />}
        {isOutput && <Icon name="flag_finish" title="Project output (exported)" className="dn-flag" />}
        {viewed && <Icon name="eye" title="Shown in the Viewer" />}
        {error && (
          <span className="dn-err" title={error}>
            !
          </span>
        )}
      </div>
      {sub && <div className="dn-sub">{sub}</div>}
      {thumbs && !unknown && <NodeThumb node={node} />}
      {def?.editor === 'colorRamp' && <RampStrip node={node} />}
      <div className="dn-ports">
        {Array.from({ length: rows }, (_, i) => {
          const inp = ins[i];
          const out = outs[i];
          return (
            <div className="dn-row" key={i}>
              {inp && (
                <>
                  <Handle
                    type="target"
                    position={Position.Left}
                    id={inHandle(inp[0])}
                    className={'dh dh-' + inp[1].type + (inp[1].optional ? ' optional' : '') + (inp[1].missing ? ' missing' : '')}
                  />
                  <span
                    className={'dn-port dn-in' + (inp[1].missing ? ' missing' : '')}
                    title={inp[1].missing ? `${inp[0]} (missing: the node type is unavailable)` : `${inp[0]} (${inp[1].type}${inp[1].optional ? ', optional' : ''})`}
                  >
                    {inp[1].label ?? inp[0]}
                  </span>
                </>
              )}
              {out && (
                <>
                  <span
                    className={'dn-port dn-out' + (out[1].missing ? ' missing' : '')}
                    title={out[1].missing ? `${out[0]} (missing: the node type is unavailable)` : `${out[0]} (${out[1].type})`}
                  >
                    {out[1].label ?? out[0]}
                  </span>
                  <Handle
                    type="source"
                    position={Position.Right}
                    id={outHandle(out[0])}
                    className={'dh dh-' + out[1].type + (out[1].missing ? ' missing' : '')}
                  />
                </>
              )}
            </div>
          );
        })}
      </div>
      {node.bypass && <div className="dn-bypass-tag">BYPASS</div>}
    </div>
  );
}

export const NodeView = memo(NodeViewImpl);
