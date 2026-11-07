import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import { memo, useEffect, useRef, useState } from 'react';
import { getPorts, GROUP, IMAGE } from '../core/graph';
import { getNodeDef } from '../core/registry';
import type { GraphNode, PortDef } from '../core/types';
import { nodeName, setLabel, toggleBypass } from '../store/actions';
import { engine } from '../store/engine';
import { setCollapsed } from '../store/graphEdit';
import { useGraphUi } from '../store/graphUi';
import { useSettings } from '../store/settings';
import { Icon, nodeColor, nodeIcon } from './Icon';
import { NodeThumb } from './NodeThumb';
import { tagColor } from './graphIds';
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

type PortRow = [string, PortDef & { missing?: boolean }];

function InHandle({ p, compact }: { p: PortRow; compact?: boolean }) {
  return (
    <Handle
      type="target"
      position={Position.Left}
      id={inHandle(p[0])}
      className={'dh dh-' + p[1].type + (p[1].optional ? ' optional' : '') + (p[1].missing ? ' missing' : '')}
      title={compact ? `${p[1].label ?? p[0]} (${p[1].type})` : undefined}
    />
  );
}
function OutHandle({ p, compact }: { p: PortRow; compact?: boolean }) {
  return (
    <Handle
      type="source"
      position={Position.Right}
      id={outHandle(p[0])}
      className={'dh dh-' + p[1].type + (p[1].missing ? ' missing' : '')}
      title={compact ? `${p[1].label ?? p[0]} (${p[1].type})` : undefined}
    />
  );
}

/** Inline title editor (double-click the header or press F2). */
function RenameField({ node, onDone }: { node: GraphNode; onDone: () => void }) {
  const [v, setV] = useState(nodeName(node));
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const commit = () => {
    const def = node.type === GROUP ? undefined : getNodeDef(node.type)?.name;
    const t = v.trim();
    if (t !== nodeName(node)) setLabel(node.id, t === def ? '' : t);
    onDone();
  };
  return (
    <input
      ref={ref}
      className="dn-rename nodrag"
      value={v}
      spellCheck={false}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') commit();
        else if (e.key === 'Escape') onDone();
      }}
    />
  );
}

function NodeViewImpl({ data, selected }: NodeProps<DrNode>) {
  const { node, viewed, error, pending, isOutput } = data;
  const thumbs = useSettings((s) => s.nodeThumbnails);
  const renaming = useGraphUi((s) => s.renaming === node.id);
  const ports = getPorts(node);
  const def = getNodeDef(node.type);
  const unknown = node.type !== GROUP && !def;
  // unknown type (e.g. plugin disabled): show a "missing" socket for every port an edge uses
  const missing = (names: string[] = []) => names.map((n): PortRow => [n, { type: 'image', missing: true }]);
  const ins: PortRow[] = unknown ? missing(data.edgePorts?.inputs) : Object.entries(ports.inputs);
  const outs: PortRow[] = unknown ? missing(data.edgePorts?.outputs) : Object.entries(ports.outputs);
  const rows = Math.max(ins.length, outs.length);
  const sub = subtitle(node);
  const collapsed = !!node.collapsed;
  const cls = [
    'dn',
    selected && 'selected',
    viewed && 'viewed',
    node.bypass && 'bypassed',
    error && 'has-error',
    unknown && 'unknown',
    node.type === GROUP && 'is-group',
    collapsed && 'collapsed',
    node.color && 'tagged',
  ]
    .filter(Boolean)
    .join(' ');
  const accent = node.color ? tagColor(node.color) : nodeColor(node.type);
  const canMute = ins.length > 0 && outs.length > 0;
  const doneRename = () => useGraphUi.setState({ renaming: null });
  return (
    <div className={cls} style={{ '--accent': accent } as React.CSSProperties}>
      <div
        className="dn-title"
        onDoubleClick={(e) => {
          e.stopPropagation();
          useGraphUi.setState({ renaming: node.id });
        }}
      >
        <span
          className={'dn-icon' + (canMute ? ' mutable' : '')}
          title={canMute ? (node.bypass ? 'Bypassed — click to enable' : 'Click to bypass (mute)') : undefined}
          onClick={(e) => {
            if (!canMute) return;
            e.stopPropagation();
            toggleBypass([node.id]);
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <Icon name={unknown ? 'plugin_disabled' : node.bypass ? 'link_break' : nodeIcon(node.type)} />
        </span>
        {renaming ? <RenameField node={node} onDone={doneRename} /> : <span className="dn-name">{nodeName(node)}</span>}
        {pending && <Icon name="hourglass" title="Loading…" />}
        {isOutput && <Icon name="flag_finish" title="Project output (exported)" className="dn-flag" />}
        {viewed && <Icon name="eye" title="Shown in the Viewer" />}
        {error && (
          <span className="dn-err" title={error}>
            !
          </span>
        )}
        <button
          className={'dn-collapse nodrag' + (collapsed ? ' closed' : '')}
          title={collapsed ? 'Expand (H)' : 'Collapse (H)'}
          onClick={(e) => {
            e.stopPropagation();
            setCollapsed([node.id], !collapsed);
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        />
        {collapsed && (
          <>
            {ins.map((p) => (
              <InHandle key={'i' + p[0]} p={p} compact />
            ))}
            {outs.map((p) => (
              <OutHandle key={'o' + p[0]} p={p} compact />
            ))}
          </>
        )}
      </div>
      {!collapsed && (
        <>
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
                      <InHandle p={inp} />
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
                      <OutHandle p={out} />
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
      {node.bypass && <div className="dn-bypass-tag">BYPASS</div>}
    </div>
  );
}

export const NodeView = memo(NodeViewImpl);
