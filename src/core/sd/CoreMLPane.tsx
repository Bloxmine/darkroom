/**
 * Preferences › Generation › Core ML (built-in): engine status, compute units, installed models and ControlNets,
 * the curated download list (licence shown and accepted before every download), extra model folders and the
 * compiled-model cache. Mac app only (window.darkroomNative.coreml).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CoreMLEvent, CoreMLModelList, CoreMLStatus } from '../../native/api';
import { setPref, useSettings } from '../../store/settings';
import { Button, Check, fmtBytes, Note, PopUp, Row, Sep } from '../../ui/prefs/controls';
import { testConnection } from './client';
import { cachedCoreMLList, cleanIpcError, coremlApi, controlNetKind } from './coreml';
import {
  CATALOG_BASES,
  catalogControlNet,
  CONTROL_KINDS,
  CONTROL_LABELS,
  hfPage,
  OPENRAIL_SUMMARY,
  type CatalogBase,
  type CatalogControlNet,
} from './coreml-catalog';

type Dl = Extract<CoreMLEvent, { type: 'download' }>;
const icon = (n: string) => <img src={`/icons/fatcow/16x16/${n}.png`} alt="" style={{ verticalAlign: '-3px', marginRight: 4 }} />;
const res = (w: number, h: number) => (w === h ? `${w}²` : `${w}×${h}`);
const attLabel = (a: string) => (a === 'splitEinsum' ? 'Neural Engine' : a === 'original' ? 'GPU' : '—');

export function CoreMLPane() {
  const s = useSettings();
  const api = coremlApi();
  const [status, setStatus] = useState<CoreMLStatus | null>(null);
  const [list, setList] = useState<CoreMLModelList | null>(null);
  const [err, setErr] = useState('');
  const [dls, setDls] = useState<Record<string, Dl>>({});
  const [ask, setAsk] = useState<CatalogBase | CatalogControlNet | null>(null);
  const [target, setTarget] = useState('');

  const refresh = useCallback(async () => {
    if (!api) return;
    try {
      const st = await api.status();
      setStatus(st);
      if (st.available) {
        // one scan: testConnection lists the models (and fills the shared cache the Generate pickers use)
        await testConnection().catch((e) => setErr(cleanIpcError(e).message));
        setList(cachedCoreMLList());
      }
      setStatus(await api.status());
    } catch (e) {
      setErr(cleanIpcError(e).message);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
    if (!api) return;
    return api.onEvent((e) => {
      if (e.type === 'download') {
        setDls((d) => ({ ...d, [e.id]: e }));
        if (e.state === 'done') void refresh();
      } else if (e.type === 'state') setStatus((st) => (st ? { ...st, state: e.state } : st));
    });
  }, [api, refresh]);

  // ControlNet target: the installed base model (or a catalog one) whose variant we offer
  const targets = useMemo(() => {
    const out: { value: string; label: string; attention: 'splitEinsum' | 'original'; w: number; h: number }[] = [];
    for (const m of list?.models ?? [])
      if (m.controlNetSupport && m.attention !== 'unknown') out.push({ value: m.id, label: `${m.name} (${attLabel(m.attention)}, ${res(m.width, m.height)})`, attention: m.attention, w: m.width, h: m.height });
    for (const [a, w, h] of [['splitEinsum', 512, 512], ['original', 512, 512], ['original', 768, 512], ['original', 512, 768]] as const)
      if (!out.some((t) => t.attention === a && t.w === w && t.h === h)) out.push({ value: `${a}:${w}x${h}`, label: `Any ${attLabel(a)} model, ${res(w, h)}`, attention: a, w, h });
    return out;
  }, [list]);
  const tgt = targets.find((t) => t.value === target) ?? targets[0];

  if (!api) return null;
  if (status && !status.available)
    return (
      <Row label="Core ML" top col>
        <span className="slp-error">{status.reason}</span>
      </Row>
    );

  const installedCN = (c: CatalogControlNet) => list?.controlNets.some((x) => x.name === c.entry && x.width === c.width && x.height === c.height);
  const installedBase = (b: CatalogBase) => list?.models.some((m) => m.id === `darkroom:${b.id}`);
  const start = async (item: CatalogBase | CatalogControlNet) => {
    setAsk(null);
    setErr('');
    try {
      await api.download(item.id, true);
    } catch (e) {
      const m = cleanIpcError(e).message;
      if (!/cancelled/i.test(m)) setErr(m);
    }
  };
  const dlCell = (item: CatalogBase | CatalogControlNet, installed: boolean | undefined) => {
    const d = dls[item.id];
    if (d?.state === 'downloading')
      return (
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <progress value={d.done} max={d.total || 1} style={{ width: 90 }} />
          {Math.floor((d.done / (d.total || 1)) * 100)}%
          <Button small onClick={() => api.cancelDownload(item.id)}>
            Cancel
          </Button>
        </span>
      );
    if (installed) return <span>{icon('accept_button')}Installed</span>;
    return (
      <Button small onClick={() => setAsk(item)} title={`${fmtBytes(item.bytes)} from huggingface.co/${item.repo}`}>
        {d?.state === 'cancelled' || d?.state === 'error' ? 'Resume…' : 'Download…'}
      </Button>
    );
  };

  return (
    <>
      <Row label="Engine" top col>
        <Note>
          Runs Stable Diffusion 1.5-family models with ControlNet on this Mac through Apple’s Core ML (ml-stable-diffusion): nothing is uploaded. State:{' '}
          <b>{status?.state ?? '…'}</b>
          {status?.helperVersion ? ` · helper ${status.helperVersion}` : ''}
          {status?.neuralEngine === false ? ' · no Neural Engine on this Mac (GPU/CPU only)' : ''}
          {status?.loaded?.note ? ` · ${status.loaded.note}` : ''}
        </Note>
      </Row>
      <Row label="Compute units">
        <PopUp
          label="Compute units"
          value={s.coremlUnits}
          width={300}
          onChange={(v) => setPref('coremlUnits', v)}
          options={[
            { value: 'cpuAndNeuralEngine', label: 'Neural Engine (split-einsum models)' },
            { value: 'cpuAndGPU', label: 'GPU (original-attention models)' },
            { value: 'all', label: 'All (let Core ML decide)' },
          ]}
        />
      </Row>
      <Row label="" top col>
        <Check checked={s.coremlReduceMemory} onChange={(v) => setPref('coremlReduceMemory', v)} title="Load each part only while it runs (slower, ~2 GB less memory)">
          Reduce memory use (load parts only while they run)
        </Check>
        <Note>
          The first use of a model compiles it for the chosen compute units (minutes on the Neural Engine); later loads take seconds. Models are freed from memory after 5 idle minutes.
        </Note>
      </Row>
      <Sep />
      <Row label="Installed" top col>
        <div className="slp-table-wrap" style={{ height: 120, width: '100%' }}>
          <table className="slp-table">
            <colgroup>
              <col />
              <col style={{ width: 90 }} />
              <col style={{ width: 70 }} />
              <col style={{ width: 70 }} />
            </colgroup>
            <thead>
              <tr>
                <th>Model / ControlNet</th>
                <th>Runs on</th>
                <th>Size</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {!list && (
                <tr className="empty">
                  <td colSpan={4}>Scanning…</td>
                </tr>
              )}
              {list && !list.models.length && !list.controlNets.length && (
                <tr className="empty">
                  <td colSpan={4}>No Core ML models yet: download one below or add a folder.</td>
                </tr>
              )}
              {list?.models.map((m) => (
                <tr key={m.id} title={`${m.id}${m.controlNetSupport ? '' : ' — no ControlledUnet: cannot use ControlNet'}`}>
                  <td>
                    {icon('brain')}
                    {m.name} · {res(m.width, m.height)}
                    {m.kind === 'sdxl' ? ' · SDXL (unsupported)' : m.controlNetSupport ? '' : ' · no ControlNet'} <span className="muted">({m.root})</span>
                  </td>
                  <td>{attLabel(m.attention)}</td>
                  <td className="right">{fmtBytes(m.bytes)}</td>
                  <td>
                    {m.deletable && (
                      <Button small onClick={() => void api.deleteModel(m.id).then(refresh, (e) => setErr(cleanIpcError(e).message))}>
                        Delete
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
              {list?.controlNets.map((c) => (
                <tr key={c.id} title={`${c.id} — ${c.version}`}>
                  <td>
                    {icon('cog')}
                    {c.name} · {controlNetKind(c) ?? '?'} · {res(c.width, c.height)} <span className="muted">({c.root})</span>
                  </td>
                  <td>{attLabel(c.attention)}</td>
                  <td className="right">{fmtBytes(c.bytes)}</td>
                  <td>
                    {c.deletable && (
                      <Button small onClick={() => void api.deleteModel(c.id).then(refresh, (e) => setErr(cleanIpcError(e).message))}>
                        Delete
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <span style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
          <Button onClick={() => void api.addFolder().then(refresh, (e) => setErr(cleanIpcError(e).message))}>Add Folder…</Button>
          <Button onClick={() => api.revealModelsFolder()}>Show Models Folder</Button>
          <Button onClick={() => void refresh()}>Refresh</Button>
        </span>
        {!!status?.folders.length && (
          <Note>
            Also scanning:{' '}
            {status.folders.map((f) => (
              <span key={f.id} title={f.path} style={{ marginRight: 8 }}>
                {f.name}{' '}
                <a href="#" onClick={(e) => (e.preventDefault(), void api.removeFolder(f.id).then(refresh))}>
                  (remove)
                </a>
              </span>
            ))}
          </Note>
        )}
        <Note>Mochi Diffusion users: add its models folder and its ControlNet folder; models need a ControlledUnet (“_cn” conversions) for ControlNet.</Note>
      </Row>
      <Sep />
      <Row label="Download" top col>
        <div className="slp-table-wrap" style={{ height: 150, width: '100%' }}>
          <table className="slp-table">
            <colgroup>
              <col />
              <col style={{ width: 70 }} />
              <col style={{ width: 170 }} />
            </colgroup>
            <thead>
              <tr>
                <th>Base model (SD 1.5, ControlNet-ready)</th>
                <th>Size</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {CATALOG_BASES.map((b) => (
                <tr key={b.id} title={`${b.description}\n${b.repo}@${b.commit.slice(0, 7)} · ${b.license}`}>
                  <td>{b.name}</td>
                  <td className="right">{fmtBytes(b.bytes)}</td>
                  <td>{dlCell(b, installedBase(b))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <span style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 }}>
          ControlNets for
          <PopUp label="ControlNets for" value={tgt?.value ?? ''} width={300} onChange={(v) => setTarget(String(v))} options={targets.map((t) => ({ value: t.value, label: t.label }))} />
        </span>
        <div className="slp-table-wrap" style={{ height: 150, width: '100%', marginTop: 4 }}>
          <table className="slp-table">
            <colgroup>
              <col />
              <col style={{ width: 70 }} />
              <col style={{ width: 170 }} />
            </colgroup>
            <tbody>
              {tgt &&
                CONTROL_KINDS.map((k) => {
                  const c = catalogControlNet(k, tgt.attention, tgt.w, tgt.h);
                  if (!c) return null;
                  return (
                    <tr key={c.id} title={`${c.entry}.mlmodelc from ${c.repo}@${c.commit.slice(0, 7)} · ${c.license}`}>
                      <td>
                        {CONTROL_LABELS[k]} <span className="muted">({c.entry})</span>
                      </td>
                      <td className="right">{fmtBytes(c.bytes)}</td>
                      <td>{dlCell(c, installedCN(c))}</td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
        {ask && (
          <div
            className="slp-box"
            role="dialog"
            aria-label="Model licence"
            style={{
              position: 'fixed', left: '50%', top: '18%', transform: 'translateX(-50%)', width: 480, zIndex: 1000, padding: 12,
              background: 'var(--slp-bg, var(--panel, #ececec))', boxShadow: '0 8px 30px rgba(0,0,0,0.45)', border: '1px solid rgba(0,0,0,0.35)',
            }}
          >
            <b>
              {'name' in ask ? ask.name : `${CONTROL_LABELS[ask.kind]} ControlNet (${ask.entry})`} — {fmtBytes(ask.bytes)}
            </b>
            <div className="slp-note" style={{ margin: '4px 0' }}>
              From <a href={hfPage(ask)} target="_blank" rel="noreferrer">huggingface.co/{ask.repo}</a> (pinned to {ask.commit.slice(0, 7)}). Licence:{' '}
              <a href={ask.licenseUrl} target="_blank" rel="noreferrer">
                {ask.license}
              </a>
              .
            </div>
            <div className="slp-note" style={{ whiteSpace: 'pre-line', maxHeight: 110, overflow: 'auto' }}>
              {OPENRAIL_SUMMARY.join('\n')}
            </div>
            <span style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              <Button primary onClick={() => void start(ask)}>
                Accept Licence &amp; Download
              </Button>
              <Button onClick={() => setAsk(null)}>Cancel</Button>
            </span>
          </div>
        )}
        <Note>Downloads come from Hugging Face, resume where they stopped, and are checked file by file. Only the needed parts of each zip are fetched.</Note>
      </Row>
      <Sep />
      <Row label="Compiled cache" top col>
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {fmtBytes(status?.cacheBytes ?? 0)}
          <Button small onClick={() => void api.clearCache().then(refresh, (e) => setErr(cleanIpcError(e).message))}>
            Clear
          </Button>
        </span>
        <Note>Core ML keeps compiled models here so later loads are fast. Clearing it frees disk space; the next use compiles again.</Note>
      </Row>
      {err && (
        <Row label="" top col>
          <span className="slp-error">{err}</span>
        </Row>
      )}
    </>
  );
}
