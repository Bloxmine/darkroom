import { useEffect, useRef, useState } from 'react';
import { loadAsset } from '../core/assets';
import { getParamDefs, getPorts, GROUP, IMAGE, OUTPUT } from '../core/graph';
import { getNodeDef } from '../core/registry';
import type { GraphNode, ParamDef, ParamValue } from '../core/types';
import * as A from '../store/actions';
import { currentGraph, effectiveViewed, outputNodeId, useDoc } from '../store/doc';
import { engine } from '../store/engine';
import { flatId, groupNodeAt } from '../store/graphPath';
import { addAsset, pickFiles } from '../store/io';
import { status } from '../store/ui';
import { Panel } from './Chrome';
import { ColorPopup, cssColor, toHex } from './ColorPicker';
import { CurveEditor } from './CurveEditor';
import { editorOwnsParam, NodeParamEditor } from './ColorRampEditor';
import { NumField } from './NumField';
import { Icon, nodeIcon } from './Icon';
import { useContextMenu, type MenuItem } from './Menu';
import { useRegistry } from './useRegistry';
import { CustomTypeRow, NodeErrorNote } from './CustomTypeInfo';
import { RawMetaBlock } from './RawInfo';
import { RAW } from '../core/raw/formats';
import { GenerateBar, showGenerateBar } from '../core/sd/GenerateBar';
import { EyedropperButton } from './viewer/Eyedropper';
import { startEyedropper } from '../store/viewer';

// ---------------------------------------------------------------------------
// Generic fields
// ---------------------------------------------------------------------------

function Slider({ value, def, onChange }: { value: number; def: ParamDef; onChange: (v: number) => void }) {
  const int = def.type === 'int';
  const step = def.step ?? (int ? 1 : 0.01);
  const hasRange = def.min !== undefined && def.max !== undefined;
  return (
    <div className="slider-row">
      {hasRange && (
        <input
          type="range"
          className="slider"
          min={def.min}
          max={def.max}
          step={step}
          value={Math.min(def.max!, Math.max(def.min!, value))}
          onChange={(e) => onChange(int ? Math.round(+e.target.value) : +e.target.value)}
          style={{ '--fill': `${((Math.min(def.max!, Math.max(def.min!, value)) - def.min!) / (def.max! - def.min! || 1)) * 100}%` } as React.CSSProperties}
        />
      )}
      <NumField value={value} onChange={onChange} step={step} int={int} width={hasRange ? 58 : undefined} />
      {def.pixels && <span className="unit">px</span>}
    </div>
  );
}

function ColorField({ value, onChange, onEnd, onPick, label = 'colour' }: { value: number[]; onChange: (c: number[]) => void; onEnd: () => void; onPick?: (c: number[]) => void; label?: string }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const c = [value[0] ?? 0, value[1] ?? 0, value[2] ?? 0, value[3] ?? 1] as [number, number, number, number];
  return (
    <div className="color-row">
      <button className="swatch" title="Pick colour" onClick={(e) => setAnchor(anchor ? null : e.currentTarget.getBoundingClientRect())}>
        <span style={{ background: cssColor(c) }} />
      </button>
      <code className="hex">{toHex(c)}</code>
      <span className="muted">α {c[3].toFixed(2)}</span>
      {onPick && <EyedropperButton label={label} keepAlpha={c[3]} onPick={onPick} />}
      {anchor && (
        <ColorPopup
          onEyedropper={
            onPick &&
            ((cb) =>
              startEyedropper(label, (p) => {
                const v = [...p.slice(0, 3).map((x) => Math.min(1, Math.max(0, x))), c[3]] as [number, number, number, number];
                onPick(v);
                cb(v);
              }))
          }
          anchor={anchor}
          value={c}
          onChange={onChange}
          onClose={() => {
            setAnchor(null);
            onEnd();
          }}
        />
      )}
    </div>
  );
}

function AssetField({ node, k, def }: { node: GraphNode; k: string; def: ParamDef }) {
  const id = String(node.params[k] ?? '');
  const asset = engine?.assets.get(id);
  const projAsset = useDoc((s) => s.project.assets[id]);
  const name = asset?.name ?? projAsset?.name;
  const browse = async () => {
    const [f] = await pickFiles(def.accept ?? '*/*');
    if (!f) return;
    try {
      const a = await loadAsset(f, f.name);
      addAsset(a);
      A.setParam(node.id, k, a.id, false);
      status(`Loaded ${a.name}${a.width ? ` (${a.width}×${a.height})` : ''}`);
    } catch (e) {
      status(`Could not load ${f.name}: ${(e as Error).message}`, 'error');
    }
  };
  return (
    <div className="asset-row">
      {asset?.image && <img className="asset-thumb sunken" src={asset.dataUrl} alt="" />}
      <div className="asset-info">
        <div className="asset-name" title={name}>
          <Icon name={asset?.image ? 'picture' : name ? 'page_white_text' : 'page_white'} /> {name ?? <span className="muted">(none)</span>}
        </div>
        {asset?.width && (
          <div className="muted">
            {asset.width} × {asset.height} px
          </div>
        )}
        <button className="btn" onClick={() => void browse()}>
          <Icon name="folder" /> Browse…
        </button>
        {id && (
          <button className="btn" onClick={() => A.setParam(node.id, k, '', false)} title="Clear">
            <Icon name="cross" />
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Param rows
// ---------------------------------------------------------------------------

function ParamWidget({ node, k, def, value }: { node: GraphNode; k: string; def: ParamDef; value: ParamValue }) {
  const set = (v: ParamValue, coalesce = true) => A.setParam(node.id, k, v, coalesce);
  switch (def.type) {
    case 'float':
    case 'int':
      return <Slider value={Number(value ?? 0)} def={def} onChange={(v) => set(v)} />;
    case 'bool':
      return (
        <label className="check">
          <input type="checkbox" checked={!!value} onChange={(e) => set(e.target.checked, false)} />
          <span>{value ? 'On' : 'Off'}</span>
        </label>
      );
    case 'color':
      return <ColorField value={(value as number[]) ?? [0, 0, 0, 1]} onChange={(c) => set(c)} onEnd={() => {}} onPick={(c) => set(c, false)} label={def.label ?? k} />;
    case 'vec2': {
      const v = (value as number[]) ?? [0, 0];
      const step = def.step ?? 0.01;
      return (
        <div className="vec2-row">
          <span className="axis">X</span>
          <NumField value={v[0] ?? 0} step={step} onChange={(x) => set([x, v[1] ?? 0])} />
          <span className="axis">Y</span>
          <NumField value={v[1] ?? 0} step={step} onChange={(y) => set([v[0] ?? 0, y])} />
        </div>
      );
    }
    case 'enum':
      return (
        <select className="field select" value={String(value ?? '')} onChange={(e) => set(e.target.value, false)}>
          {(def.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
    case 'string':
      return def.multiline ? (
        <textarea className="field textarea" value={String(value ?? '')} onChange={(e) => set(e.target.value)} rows={4} spellCheck={false} />
      ) : (
        <input className="field text" value={String(value ?? '')} onChange={(e) => set(e.target.value)} spellCheck={false} />
      );
    case 'asset':
      return <AssetField node={node} k={k} def={def} />;
    case 'curve':
      return <CurveEditor value={(value as [number, number][]) ?? []} onChange={(c) => set(c)} />;
    default:
      return <span className="muted">({def.type})</span>;
  }
}

function isDefault(v: ParamValue, def: ParamDef) {
  return JSON.stringify(v) === JSON.stringify(def.default);
}

function ParamRow({ node, k, def, inGroup, openMenu }: { node: GraphNode; k: string; def: ParamDef; inGroup: boolean; openMenu: (e: React.MouseEvent, items: MenuItem[]) => void }) {
  const value = node.params[k] ?? def.default;
  const exposed = inGroup ? A.exposedAs(node.id, k) : undefined;
  const wide = def.type === 'curve' || def.type === 'asset' || (def.type === 'string' && def.multiline);
  const menu = (e: React.MouseEvent) => {
    e.preventDefault();
    const items: MenuItem[] = [{ label: 'Reset to Default', icon: 'arrow_rotate_anticlockwise', run: () => A.resetParam(node.id, k) }];
    if (inGroup)
      items.push(
        exposed
          ? { label: `Exposed as “${exposed.label ?? exposed.key}”`, icon: 'tick', disabled: true }
          : { label: 'Expose on Group', icon: 'link_add', run: () => A.exposeParam(node.id, k) },
      );
    items.push({ sep: true }, { label: 'Copy Value', icon: 'page_copy', run: () => void navigator.clipboard?.writeText(JSON.stringify(value)).catch(() => {}) });
    openMenu(e, items);
  };
  const label = def.label ?? k;
  const tip = [def.description, `${k} : ${def.type}`, def.min !== undefined ? `range ${def.min} … ${def.max}` : '', 'Right-click for options'].filter(Boolean).join('\n');
  return (
    <div className={'prow' + (wide ? ' wide' : '')} onContextMenu={menu}>
      <div className={'plabel' + (isDefault(value, def) ? '' : ' modified')} title={tip}>
        {exposed && <Icon name="link" title={`Exposed on group as “${exposed.label ?? exposed.key}”`} />}
        {label}
      </div>
      <div className="pwidget" title={def.description}>
        <ParamWidget node={node} k={k} def={def} value={value} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

function Section({ title, icon, children, right }: { title: string; icon?: string; children: React.ReactNode; right?: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="psection">
      <div className="psection-head" onClick={() => setOpen(!open)}>
        <span className={'tree-toggle' + (open ? ' open' : '')} />
        {icon && <Icon name={icon} />}
        <span>{title}</span>
        <span className="psection-right" onClick={(e) => e.stopPropagation()}>
          {right}
        </span>
      </div>
      {open && <div className="psection-body">{children}</div>}
    </div>
  );
}

function LabelField({ node }: { node: GraphNode }) {
  const [v, setV] = useState(A.nodeName(node));
  const ref = useRef(node.id);
  useEffect(() => {
    setV(A.nodeName(node));
    ref.current = node.id;
  }, [node]);
  const commit = () => {
    const def = getNodeDef(node.type)?.name;
    if (v !== A.nodeName(node)) A.setLabel(node.id, v === def ? '' : v);
  };
  return (
    <input
      className="field text"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      spellCheck={false}
    />
  );
}

function ExposedEditor({ node }: { node: GraphNode }) {
  const ex = node.group?.exposed ?? [];
  if (!ex.length)
    return <div className="pnote muted">No parameters exposed. Open the group (Ctrl+Enter), right-click a parameter and choose “Expose on Group”.</div>;
  return (
    <table className="grid-table">
      <thead>
        <tr>
          <th>Label</th>
          <th>Target</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {ex.map((e, i) => {
          const inner = node.group!.graph.nodes.find((n) => n.id === e.node);
          return (
            <tr key={e.key}>
              <td>
                <ExposedLabel groupId={node.id} k={e.key} label={e.label ?? e.key} />
              </td>
              <td className="muted" title={`${e.node}.${e.param}`}>
                {inner ? A.nodeName(inner) : '?'}.{e.param}
              </td>
              <td className="nowrap">
                <button className="tbtn small" disabled={i === 0} title="Move up" onClick={() => A.moveExposed(node.id, e.key, -1)}>
                  <Icon name="arrow_up" />
                </button>
                <button className="tbtn small" disabled={i === ex.length - 1} title="Move down" onClick={() => A.moveExposed(node.id, e.key, 1)}>
                  <Icon name="arrow_down" />
                </button>
                <button className="tbtn small" title="Remove (un-expose)" onClick={() => A.removeExposed(node.id, e.key)}>
                  <Icon name="cross" />
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function ExposedLabel({ groupId, k, label }: { groupId: string; k: string; label: string }) {
  const [v, setV] = useState(label);
  useEffect(() => setV(label), [label]);
  return (
    <input
      className="field text"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== label && A.renameExposed(groupId, k, v)}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

export function Properties() {
  useRegistry();
  const node = useDoc((s) => {
    const g = currentGraph(s);
    return g.nodes.find((n) => n.id === s.selection[0]) ?? null;
  });
  const selCount = useDoc((s) => s.selection.length);
  const path = useDoc((s) => s.path);
  const viewed = useDoc((s) => effectiveViewed(s));
  const outId = useDoc((s) => outputNodeId(s.project));
  const enclosing = useDoc((s) => groupNodeAt(s.project.graph, s.path));
  const ctx = useContextMenu();

  if (!node) {
    return (
      <Panel title="Properties" icon="application_side_list" className="props">
        <div className="props-empty">
          <Icon name="cursor" size={32} />
          <div>No node selected</div>
          <div className="muted">Click a node in the Node Graph to edit its parameters.</div>
          {enclosing && (
            <div className="pnote">
              Editing inside <b>{A.nodeName(enclosing)}</b>. Use the breadcrumb bar or Ctrl+Backspace to go up.
            </div>
          )}
        </div>
      </Panel>
    );
  }

  const def = getNodeDef(node.type);
  const params = getParamDefs(node);
  const visible = Object.entries(params).filter(([, d]) => !d.hidden);
  const customEditor = node.type === GROUP ? undefined : def?.editor;
  const shown = customEditor ? visible.filter(([k]) => !editorOwnsParam(customEditor, k)) : visible;
  const isGroup = node.type === GROUP;
  const ports = getPorts(node);
  const fid = flatId(path, node.id);
  const typeLabel = isGroup ? 'Group' : (def?.name ?? 'Unknown');

  return (
    <Panel
      title="Properties"
      icon="application_side_list"
      className="props"
      tools={selCount > 1 ? <span className="panel-meta">{selCount} selected · showing first</span> : null}
    >
      <div className="props-scroll">
        <div className="props-head">
          <Icon name={nodeIcon(node.type)} size={32} />
          <div className="props-head-text">
            <LabelField node={node} />
            <div className="muted props-type">
              {typeLabel} <code>{isGroup ? 'core.group' : node.type}</code>
            </div>
          </div>
        </div>
        {(def?.description || (isGroup && node.group)) && <div className="props-desc">{def?.description ?? `Group of ${node.group!.graph.nodes.length} nodes.`}</div>}
        <NodeErrorNote node={node} flatId={fid} unknown={!def && !isGroup} />

        <Section title="Node" icon="cog">
          <div className="prow">
            <div className="plabel" title="Pass the first input straight through">
              Bypass
            </div>
            <div className="pwidget">
              <label className="check">
                <input type="checkbox" checked={!!node.bypass} onChange={() => A.toggleBypass([node.id])} />
                <span>{node.bypass ? 'Bypassed' : 'Active'}</span>
              </label>
            </div>
          </div>
          <div className="prow">
            <div className="plabel">Viewer</div>
            <div className="pwidget">
              {viewed === fid ? (
                <span className="muted">
                  <Icon name="eye" /> Shown in viewer
                </span>
              ) : (
                <button className="btn" onClick={() => A.viewNode(node.id)}>
                  <Icon name="eye" /> View this node
                </button>
              )}
            </div>
          </div>
          {node.type === OUTPUT && !path.length && (
            <div className="prow">
              <div className="plabel">Export</div>
              <div className="pwidget">
                {outId === node.id ? (
                  <span className="muted">
                    <Icon name="flag_finish" /> Project output
                  </span>
                ) : (
                  <button className="btn" onClick={() => A.setOutputNode(node.id)}>
                    <Icon name="flag_finish" /> Use as output
                  </button>
                )}
              </div>
            </div>
          )}
          <CustomTypeRow node={node} />
          <div className="prow">
            <div className="plabel">Ports</div>
            <div className="pwidget muted small">
              in: {Object.keys(ports.inputs).join(', ') || '—'} · out: {Object.keys(ports.outputs).join(', ') || '—'}
            </div>
          </div>
        </Section>

        <Section
          title={isGroup ? 'Exposed Parameters' : 'Parameters'}
          icon={isGroup ? 'link' : 'application_form_edit'}
          right={
            visible.length > 0 && (
              <button
                className="tbtn small"
                title="Reset all to defaults"
                onClick={() => visible.forEach(([k]) => A.resetParam(node.id, k))}
              >
                <Icon name="arrow_rotate_anticlockwise" />
              </button>
            )
          }
        >
          {visible.length === 0 && <div className="pnote muted">{isGroup ? 'No exposed parameters.' : 'This node has no parameters.'}</div>}
          {customEditor && <NodeParamEditor kind={customEditor} node={node} />}
          {showGenerateBar(node) && <GenerateBar node={node} />}
          {shown.map(([k, d]) => (
            <ParamRow key={k} node={node} k={k} def={d} inGroup={path.length > 0} openMenu={ctx.open} />
          ))}
          {node.type === IMAGE && !node.params.asset && <div className="pnote">Tip: drop an image file onto the Node Graph to import it.</div>}
          {node.type === RAW && <RawMetaBlock assetId={String(node.params.asset ?? '')} />}
        </Section>

        {isGroup && (
          <Section title="Group" icon="bricks">
            <div className="prow">
              <div className="plabel">Contents</div>
              <div className="pwidget">
                <button className="btn" onClick={() => A.enterGroup(node.id)}>
                  <Icon name="door_in" /> Open group
                </button>
                <button className="btn" onClick={() => A.ungroupSelection()}>
                  <Icon name="shape_ungroup" /> Ungroup
                </button>
              </div>
            </div>
            <ExposedEditor node={node} />
          </Section>
        )}
      </div>
      {ctx.el}
    </Panel>
  );
}
