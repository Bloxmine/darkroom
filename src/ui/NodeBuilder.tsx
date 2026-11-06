import { useEffect, useMemo, useRef, useState } from 'react';
import { applyUserNode, deleteUserNode, getNodeOrigin, getUserNode, saveUserNode } from '../core/customNodes';
import { Engine } from '../core/engine';
import { ShaderCompileError } from '../core/gl';
import { flattenGraph, getPorts } from '../core/graph';
import { stripParamUniforms } from '../core/glslParams';
import { getNodeDef, listNodeDefs } from '../core/registry';
import { isValidNodeId, parseNodeFile, serializeNodeDef, toNodeFile, validateSerializedNodeDef } from '../core/serialize';
import type { ParamDef, SerializedNodeDef } from '../core/types';
import * as A from '../store/actions';
import { useDoc } from '../store/doc';
import { requestRender } from '../store/engine';
import { closeNodeBuilder, downloadText, useExt } from '../store/extensions';
import { status, useUi } from '../store/ui';
import { formParams, formToSerialized, newPass, parseCompileLog, serializedToForm, TEMPLATES, type BuilderForm, type BuilderInput } from './builderModel';
import { GlslEditor, type EditorDiagnostic } from './GlslEditor';
import { Icon } from './Icon';
import { useRegistry } from './useRegistry';
import './nodeBuilder.css';

// ---------------------------------------------------------------------------
// Compile check (an off-screen engine, so it works without an instance in the graph)
// ---------------------------------------------------------------------------

let checker: Engine | null = null;
type HeaderFn = (inputs: string[], passIndex: number, cpuNames: string[], params: [string, ParamDef][]) => string;

function compileCheck(form: BuilderForm, params: Record<string, ParamDef>): { pass: number; line: number; message: string }[] {
  try {
    checker ??= new Engine(new OffscreenCanvas(4, 4));
  } catch {
    return [];
  }
  const header = (checker as unknown as { header: HeaderFn }).header.bind(checker);
  const inputs = form.inputs.map((i) => i.name.trim()).filter(Boolean);
  const keys = Object.keys(params);
  const out: { pass: number; line: number; message: string }[] = [];
  form.passes.forEach((p, i) => {
    try {
      checker!.gl.program(header(inputs, i, [], Object.entries(params)) + stripParamUniforms(p.code, keys));
    } catch (e) {
      const log = e instanceof ShaderCompileError ? e.log : String((e as Error).message ?? e);
      for (const d of parseCompileLog(log)) if (!/compilation errors?\.? No code generated/i.test(d.message) && d.message !== '\0') out.push({ pass: i, ...d });
    }
  });
  return out;
}

const emptyForm = (): BuilderForm => TEMPLATES[0].form();

function suggestId(base: string) {
  const leaf = (base.split('.').pop() || 'node').replace(/[^\w]/g, '');
  let id = `user.${leaf}`;
  for (let i = 2; getNodeDef(id) && getNodeOrigin(id)?.kind !== 'user'; i++) id = `user.${leaf}${i}`;
  return id;
}

function loadForm(typeId: string): { form: BuilderForm; note?: string } {
  if (!typeId) return { form: emptyForm() };
  const def = getNodeDef(typeId);
  const stored = getUserNode(typeId);
  try {
    const s: SerializedNodeDef = stored ?? serializeNodeDef(def!);
    const form = serializedToForm(s);
    const o = getNodeOrigin(typeId);
    if (o?.kind === 'plugin') {
      form.id = suggestId(typeId);
      form.name = `${form.name} (copy)`;
      return { form, note: `Editing a copy of “${def?.name}” from plugin ${o.name}. Plugin nodes are read-only.` };
    }
    if (o?.kind === 'project') return { form, note: 'This type is embedded in the current project. Apply saves it to your library.' };
    return { form };
  } catch (e) {
    return { form: emptyForm(), note: `Could not open ${typeId}: ${(e as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// UI pieces
// ---------------------------------------------------------------------------

function fmtDefault(d: ParamDef) {
  const v = d.default;
  if (Array.isArray(v)) return (v as number[]).map((x) => +Number(x).toFixed(3)).join(', ');
  return String(v);
}

function ParamsTable({ params, lines }: { params: Record<string, ParamDef>; lines: Record<string, number> }) {
  const rows = Object.entries(params);
  if (!rows.length) return <div className="nb-empty muted">No parameters. Add one with e.g. <code>uniform float u_amount; // @param min=0 max=1 default=0.5</code></div>;
  return (
    <table className="grid-table nb-params">
      <thead>
        <tr>
          <th>Uniform</th>
          <th>Type</th>
          <th>Default</th>
          <th>Range</th>
          <th>Label</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([k, d]) => (
          <tr key={k} title={`line ${lines[k]}${d.description ? ' — ' + d.description : ''}`}>
            <td>
              <code>u_{k}</code>
            </td>
            <td>
              {d.type}
              {d.pixels ? ' px' : ''}
            </td>
            <td className="nb-mono">{fmtDefault(d)}</td>
            <td className="nb-mono">{d.type === 'enum' ? (d.options ?? []).join(' | ') : d.min !== undefined || d.max !== undefined ? `${d.min ?? '−∞'} … ${d.max ?? '∞'}` : ''}</td>
            <td>{d.label ?? ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function InputsTable({ inputs, onChange }: { inputs: BuilderInput[]; onChange: (v: BuilderInput[]) => void }) {
  const set = (i: number, patch: Partial<BuilderInput>) => onChange(inputs.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <>
      <table className="grid-table nb-inputs">
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th title="Optional (unconnected = black / white for masks)">Opt.</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {inputs.map((inp, i) => (
            <tr key={i}>
              <td>
                <input className="field text" value={inp.name} spellCheck={false} onChange={(e) => set(i, { name: e.target.value.replace(/[^\w]/g, '') })} />
              </td>
              <td>
                <select className="field select" value={inp.type} onChange={(e) => set(i, { type: e.target.value as BuilderInput['type'] })}>
                  <option value="image">image</option>
                  <option value="mask">mask</option>
                </select>
              </td>
              <td className="nb-center">
                <input type="checkbox" checked={inp.optional} onChange={(e) => set(i, { optional: e.target.checked })} />
              </td>
              <td className="nowrap">
                <button className="tbtn small" title="Remove input" onClick={() => onChange(inputs.filter((_, j) => j !== i))}>
                  <Icon name="cross" />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button
        className="btn nb-add"
        onClick={() => {
          const taken = new Set(inputs.map((x) => x.name));
          let n = inputs.length ? 'input' : 'image';
          for (let k = 2; taken.has(n); k++) n = 'input' + k;
          onChange([...inputs, { name: n, type: 'image', optional: inputs.length > 0 }]);
        }}
      >
        <Icon name="add" /> Add input
      </button>
    </>
  );
}

function CheatSheet({ form, pass }: { form: BuilderForm; pass: number }) {
  const ins = form.inputs.map((i) => i.name).filter(Boolean);
  return (
    <details className="nb-cheat">
      <summary>
        <Icon name="book_open" /> Built-in uniforms &amp; library (cheat sheet)
      </summary>
      <div className="nb-cheat-body">
        <table className="kv">
          <tbody>
            <tr>
              <td>
                <code>v_uv</code>
              </td>
              <td>vec2 texture coordinate, (0,0) = top-left</td>
            </tr>
            <tr>
              <td>
                <code>fragColor</code>
              </td>
              <td>vec4 output (sRGB-encoded RGBA, not premultiplied)</td>
            </tr>
            <tr>
              <td>
                <code>u_resolution</code>
              </td>
              <td>vec2 size of this pass in pixels</td>
            </tr>
            <tr>
              <td>
                <code>u_scale</code>
              </td>
              <td>render scale (preview &lt; 1); multiply pixel-unit params by it</td>
            </tr>
            <tr>
              <td>
                <code>u_time</code>, <code>u_iteration</code>
              </td>
              <td>seconds; index within a repeated pass</td>
            </tr>
            {ins.map((n) => (
              <tr key={n}>
                <td>
                  <code>u_{n}</code>, <code>u_{n}_size</code>
                </td>
                <td>input “{n}” sampler2D and its size</td>
              </tr>
            ))}
            <tr>
              <td>
                <code>u_prev</code>
              </td>
              <td>previous pass (pass 0: first input{ins[0] ? ` = u_${ins[0]}` : ''})</td>
            </tr>
            {Array.from({ length: pass }, (_, i) => (
              <tr key={i}>
                <td>
                  <code>u_pass{i}</code>
                </td>
                <td>output of pass {i}</td>
              </tr>
            ))}
            <tr>
              <td>
                <code>u_&lt;param&gt;</code>
              </td>
              <td>every @param (declared for you in every pass)</td>
            </tr>
          </tbody>
        </table>
        <p className="small">
          <b>Library:</b>{' '}
          <code>
            luma luma601 saturate srgbToLinear linearToSrgb rgb2hsv hsv2rgb rgb2hsl hsl2rgb rgb2yiq yiq2rgb rgb2yuv yuv2rgb rgb2ycbcr ycbcr2rgb kelvinToRgb hash11 hash12 hash22 hash32 hash13 gaussRand
            valueNoise gradNoise fbm(p,oct) blendMultiply blendScreen blendOverlay blendSoftLight blendHardLight blendColorDodge blendColorBurn blendLinearLight texClamp texel pixelCoord PI TAU
          </code>
        </p>
        <p className="small">
          <b>@param:</b> <code>uniform float u_x; // @param min=0 max=1 step=0.01 default=0.5 label="X" desc="…" pixels</code> · <code>int</code> · <code>bool default=true</code> ·{' '}
          <code>vec2 default=0.5,0.5</code> · <code>vec4 … @param color default=#ff8800</code> · <code>int … @param enum=a|b|c default=b</code>
        </p>
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function NodeBuilderWindow({ typeId }: { typeId: string }) {
  useRegistry();
  const initial = useMemo(() => loadForm(typeId), [typeId]);
  const [form, setForm] = useState<BuilderForm>(initial.form);
  const [note, setNote] = useState<string | undefined>(initial.note);
  const [pass, setPass] = useState(0);
  const [live, setLive] = useState(false);
  const [applied, setApplied] = useState<string | null>(typeId && getNodeOrigin(typeId)?.kind === 'user' ? typeId : null);
  const [compileErrors, setCompileErrors] = useState<{ pass: number; line: number; message: string }[]>([]);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [off, setOff] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const categories = useMemo(() => [...new Set(listNodeDefs().map((d) => d.category))].sort(), []);

  const { params, perPass, lines } = useMemo(() => formParams(form), [form]);
  const curPass = form.passes[Math.min(pass, form.passes.length - 1)];
  const pi = Math.min(pass, form.passes.length - 1);

  // errors of instances in the graph (from the live engine)
  const uiErrors = useUi((s) => s.errors);
  const graph = useDoc((s) => s.project.graph);
  const graphErrors = useMemo(() => {
    if (!applied) return [];
    const flat = flattenGraph(graph);
    return flat.nodes.filter((n) => n.type === applied && uiErrors[n.id]).map((n) => ({ id: n.id, error: uiErrors[n.id] }));
  }, [applied, graph, uiErrors]);
  const instances = useMemo(() => (applied ? flattenGraph(graph).nodes.filter((n) => n.type === applied).length : 0), [applied, graph]);

  // debounced compile check (+ live apply)
  const formRef = useRef(form);
  formRef.current = form;
  useEffect(() => {
    const t = window.setTimeout(() => {
      const errs = compileCheck(form, params);
      setCompileErrors(errs);
      if (live && !errs.length && !perPass.some((p) => p.length)) void apply(true);
    }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, params, live]);

  const update = (patch: Partial<BuilderForm>) => setForm((f) => ({ ...f, ...patch }));
  const setPassPatch = (patch: Partial<BuilderForm['passes'][number]>) => setForm((f) => ({ ...f, passes: f.passes.map((p, i) => (i === pi ? { ...p, ...patch } : p)) }));

  const diagnostics: EditorDiagnostic[] = useMemo(
    () => [
      ...(perPass[pi] ?? []).map((e) => ({ line: e.line, message: e.message, severity: 'warning' as const })),
      ...compileErrors.filter((e) => e.pass === pi && e.line > 0).map((e) => ({ line: e.line, message: e.message })),
    ],
    [perPass, compileErrors, pi],
  );

  const idError = !isValidNodeId(form.id.trim()) ? 'Use a namespaced id, e.g. user.myEffect' : null;
  const annotationErrors = perPass.flatMap((p, i) => p.map((e) => ({ pass: i, ...e })));

  async function apply(quiet = false): Promise<string | null> {
    const f = formRef.current;
    setApplyError(null);
    try {
      const s = validateSerializedNodeDef(formToSerialized(f));
      if (quiet) applyUserNode(s);
      else await saveUserNode(s);
      setApplied(s.id);
      requestRender();
      if (!quiet) status(`Applied node type “${s.name}” (${s.id}) — saved to your library.`);
      return s.id;
    } catch (e) {
      setApplyError((e as Error).message);
      if (!quiet) status((e as Error).message, 'error');
      return null;
    }
  }

  async function insert() {
    const id = await apply();
    if (!id) return;
    const s = useDoc.getState();
    const g = s.path.length ? null : s.project.graph;
    const sel = (g ?? { nodes: [] }).nodes.find((n) => n.id === s.selection[0]);
    const from = sel && Object.keys(getPorts(sel).outputs)[0] ? { node: sel.id, port: Object.keys(getPorts(sel).outputs)[0], kind: 'source' as const } : undefined;
    const nid = A.addNode({ kind: 'node', type: id }, A.freeSpot(), from);
    if (nid) {
      A.viewNode(nid);
      status(`Inserted ${id}${from ? ' after the selected node' : ''} and viewing it.`);
    }
  }

  const loadTemplate = (tid: string) => {
    const t = TEMPLATES.find((x) => x.id === tid);
    if (!t) return;
    setForm(t.form());
    setPass(0);
    setNote(undefined);
    setApplied(null);
  };

  const exportFile = () => {
    try {
      const s = validateSerializedNodeDef(formToSerialized(form));
      downloadText(toNodeFile(s), `${s.id}.drnode.json`);
    } catch (e) {
      setApplyError((e as Error).message);
    }
  };
  const importFile = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      try {
        setForm(serializedToForm(parseNodeFile(await f.text())));
        setPass(0);
        setNote(`Loaded ${f.name}. Apply to register it.`);
      } catch (e) {
        setApplyError(`${f.name}: ${(e as Error).message}`);
      }
    };
    input.click();
  };
  const del = async () => {
    const id = form.id.trim();
    if (!getUserNode(id)) return;
    if (!confirm(`Delete “${id}” from your library? Nodes of this type in projects will show an error until it is re-imported.`)) return;
    await deleteUserNode(id);
    setApplied(null);
    status(`Deleted ${id} from your library.`);
  };

  const inLibrary = !!getUserNode(form.id.trim());
  const totalErrors = compileErrors.length + annotationErrors.length;

  return (
    <div className="window dialog node-builder" style={{ transform: `translate(${off.x}px, ${off.y}px)` }} role="dialog" aria-label="Node Builder">
      <div
        className="titlebar"
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, ox: off.x, oy: off.y };
        }}
        onPointerMove={(e) => drag.current && setOff({ x: drag.current.ox + e.clientX - drag.current.x, y: drag.current.oy + e.clientY - drag.current.y })}
        onPointerUp={() => (drag.current = null)}
      >
        <Icon name="script_code" />
        <span className="titlebar-text">Node Builder — {form.name || 'Untitled'}</span>
        <button className="titlebar-close" onClick={closeNodeBuilder} title="Close" onPointerDown={(e) => e.stopPropagation()}>
          ✕
        </button>
      </div>
      <div className="nb-toolbar">
        <label>
          Template:{' '}
          <select className="field select" value="" onChange={(e) => loadTemplate(e.target.value)}>
            <option value="">Choose…</option>
            {TEMPLATES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <span className="tsep" />
        <button className="btn" onClick={importFile} title="Load a .drnode.json file into the builder">
          <Icon name="folder" /> Open…
        </button>
        <button className="btn" onClick={exportFile} title="Save as .drnode.json">
          <Icon name="diskette" /> Export…
        </button>
        <span className="flex1" />
        <label className="check" title="Apply automatically while typing when there are no errors">
          <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /> Live
        </label>
        <span className={'nb-state' + (totalErrors ? ' bad' : ' good')}>
          <Icon name={totalErrors ? 'error' : 'tick'} /> {totalErrors ? `${totalErrors} problem${totalErrors > 1 ? 's' : ''}` : 'Compiles'}
        </span>
      </div>
      <div className="dialog-body nb-body">
        <div className="nb-left">
          {note && (
            <div className="pnote nb-note">
              <Icon name="information" /> {note}
            </div>
          )}
          <fieldset className="groupbox">
            <legend>Node</legend>
            <div className="nb-grid">
              <label htmlFor="nb-id">ID</label>
              <div>
                <input id="nb-id" className={'field text' + (idError ? ' nb-invalid' : '')} value={form.id} spellCheck={false} onChange={(e) => update({ id: e.target.value.trim() })} />
                {idError && <div className="nb-err small">{idError}</div>}
              </div>
              <label htmlFor="nb-name">Name</label>
              <input id="nb-name" className="field text" value={form.name} onChange={(e) => update({ name: e.target.value })} />
              <label htmlFor="nb-cat">Category</label>
              <div>
                <input id="nb-cat" className="field text" list="nb-cats" value={form.category} onChange={(e) => update({ category: e.target.value })} />
                <datalist id="nb-cats">
                  {categories.map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
              </div>
              <label htmlFor="nb-desc">Description</label>
              <textarea id="nb-desc" className="field textarea nb-desc" rows={2} value={form.description} onChange={(e) => update({ description: e.target.value })} />
            </div>
          </fieldset>
          <fieldset className="groupbox">
            <legend>Inputs</legend>
            <InputsTable inputs={form.inputs} onChange={(inputs) => update({ inputs })} />
          </fieldset>
          <fieldset className="groupbox nb-params-box">
            <legend>Parameters (from @param)</legend>
            <ParamsTable params={params} lines={lines} />
          </fieldset>
        </div>
        <div className="nb-right">
          <div className="nb-tabs">
            {form.passes.map((_, i) => (
              <button key={i} className={'nb-tab' + (i === pi ? ' active' : '') + (compileErrors.some((e) => e.pass === i) || perPass[i]?.length ? ' has-error' : '')} onClick={() => setPass(i)}>
                Pass {i}
              </button>
            ))}
            <button
              className="tbtn small"
              title="Add a pass"
              onClick={() => {
                setForm((f) => ({ ...f, passes: [...f.passes, newPass('// u_prev = previous pass output\nvoid main() {\n  fragColor = texture(u_prev, v_uv);\n}\n')] }));
                setPass(form.passes.length);
              }}
            >
              <Icon name="add" />
            </button>
            <button
              className="tbtn small"
              title="Remove this pass"
              disabled={form.passes.length < 2}
              onClick={() => {
                setForm((f) => ({ ...f, passes: f.passes.filter((_, i) => i !== pi) }));
                setPass(Math.max(0, pi - 1));
              }}
            >
              <Icon name="delete" />
            </button>
            <span className="flex1" />
            <span className="nb-passopts">
              Size:{' '}
              <select className="field select" value={curPass.sizeMode} onChange={(e) => setPassPatch({ sizeMode: e.target.value as 'same' | 'scale', fixed: undefined })}>
                <option value="same">Same as node</option>
                <option value="scale">Scale factor</option>
              </select>
              {curPass.sizeMode === 'scale' && (
                <input
                  className="field num nb-num"
                  type="number"
                  min={0.01}
                  max={4}
                  step={0.05}
                  value={curPass.scale}
                  onChange={(e) => setPassPatch({ scale: Math.max(0.01, +e.target.value || 0.5) })}
                  title="Pass size = node size × factor"
                />
              )}
              {curPass.fixed && <span className="muted"> (fixed {curPass.fixed.width ?? '·'}×{curPass.fixed.height ?? '·'})</span>}
              {'  '}Filter:{' '}
              <select className="field select" value={curPass.filter} onChange={(e) => setPassPatch({ filter: e.target.value as 'linear' | 'nearest' })}>
                <option value="linear">linear</option>
                <option value="nearest">nearest</option>
              </select>
              {'  '}Repeat:{' '}
              <input
                className="field text nb-repeat"
                placeholder="1"
                title="Run this pass N times (ping-pong). A number, or the name of an int param."
                value={curPass.repeat}
                onChange={(e) => setPassPatch({ repeat: e.target.value.replace(/[^\w]/g, '') })}
              />
            </span>
          </div>
          <GlslEditor value={curPass.code} onChange={(code) => setPassPatch({ code })} diagnostics={diagnostics} className="nb-editor" />
          <div className="nb-problems sunken" aria-label="Problems">
            {applyError && (
              <div className="nb-problem error">
                <Icon name="exclamation" /> {applyError}
              </div>
            )}
            {annotationErrors.map((e, i) => (
              <div key={'a' + i} className="nb-problem warn" onClick={() => setPass(e.pass)}>
                <Icon name="error" /> Pass {e.pass}, line {e.line}: {e.message}
              </div>
            ))}
            {compileErrors.map((e, i) => (
              <div key={'c' + i} className="nb-problem error" onClick={() => setPass(e.pass)}>
                <Icon name="exclamation" /> Pass {e.pass}
                {e.line ? `, line ${e.line}` : ''}: {e.message}
              </div>
            ))}
            {graphErrors.map((e) => (
              <div key={e.id} className="nb-problem error">
                <Icon name="exclamation" /> In graph ({e.id}): {e.error.split('\n')[0]}
              </div>
            ))}
            {!applyError && !totalErrors && !graphErrors.length && (
              <div className="nb-problem ok">
                <Icon name="tick" /> No problems.{' '}
                {applied ? `${instances} instance${instances === 1 ? '' : 's'} of ${applied} in the graph.` : 'Apply to register the node type.'}
              </div>
            )}
          </div>
          <CheatSheet form={form} pass={pi} />
        </div>
      </div>
      <div className="dialog-buttons">
        {inLibrary && (
          <button className="btn nb-left-btn" onClick={() => void del()}>
            <Icon name="bin" /> Delete from Library
          </button>
        )}
        <button className="btn default" onClick={() => void apply()} title="Register (or replace) this node type and save it to your library">
          <Icon name="tick" /> Apply
        </button>
        <button className="btn" onClick={() => void insert()} title="Apply, add a node of this type after the selected node, and view it">
          <Icon name="add" /> Insert into Graph
        </button>
        <button className="btn" onClick={closeNodeBuilder}>
          Close
        </button>
      </div>
    </div>
  );
}

/** Mounted once in the app; shows the builder window when open. */
export function NodeBuilderHost() {
  const typeId = useExt((s) => s.builder);
  const nonce = useExt((s) => s.builderNonce);
  if (typeId === null) return null;
  return <NodeBuilderWindow key={nonce} typeId={typeId} />;
}
