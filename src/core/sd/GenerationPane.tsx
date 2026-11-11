/**
 * Preferences › Generation: which local Stable Diffusion server the sd.generate node talks to.
 * Off by default; nothing is sent anywhere until a server is chosen here *and* a Generate node is run.
 */
import { useState, useSyncExternalStore } from 'react';
import { setPref, useSettings } from '../../store/settings';
import { Button, Note, PopUp, Row, Sep } from '../../ui/prefs/controls';
import { corsHint, DEFAULT_URLS, getListState, isLocalUrl, SERVER_NAMES, subscribeLists, testConnection } from './client';
import { hasCoreML } from './coreml';
import { CoreMLPane } from './CoreMLPane';

export function GenerationPane() {
  const s = useSettings();
  const lists = useSyncExternalStore(subscribeLists, getListState);
  const [err, setErr] = useState('');
  const kind = s.genServer;
  const urlKey = kind === 'a1111' ? 'genUrlA1111' : 'genUrlComfy';
  const url = kind === 'off' || kind === 'coreml' ? '' : s[urlKey];
  const coreml = hasCoreML();
  const L = lists.lists;
  return (
    <div className="slp-form">
      <Row label="Server">
        <PopUp
          label="Server"
          value={kind}
          width={300}
          onChange={(v) => setPref('genServer', v)}
          options={[
            { value: 'off', label: 'Off' },
            { value: 'comfyui', label: 'ComfyUI' },
            { value: 'a1111', label: 'AUTOMATIC1111 (Forge, SD.Next API)' },
            ...(coreml || kind === 'coreml' ? [{ value: 'coreml' as const, label: 'Core ML (built-in, this Mac)' }] : []),
          ]}
        />
      </Row>
      {kind === 'coreml' && (coreml ? <CoreMLPane /> : (
        <Row>
          <Note>The built-in Core ML engine is only available in the Darkroom Mac app. Generate nodes stay off in the browser.</Note>
        </Row>
      ))}
      {kind !== 'off' && kind !== 'coreml' && (
        <>
          <Row label="Server URL" top col>
            <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                className="slp-field"
                style={{ width: 240 }}
                value={url}
                spellCheck={false}
                placeholder={DEFAULT_URLS[kind]}
                list="darkroom-gen-urls"
                onChange={(e) => setPref(urlKey, e.target.value)}
              />
              <datalist id="darkroom-gen-urls">
                <option value={DEFAULT_URLS[kind]} />
                <option value={DEFAULT_URLS[kind].replace('127.0.0.1', 'localhost')} />
              </datalist>
              <Button
                disabled={lists.status === 'testing'}
                onClick={() => {
                  setErr('');
                  testConnection().catch((e) => setErr(String((e as Error)?.message ?? e)));
                }}
              >
                {lists.status === 'testing' ? 'Testing…' : 'Test Connection'}
              </Button>
            </span>
            {url && !isLocalUrl(url) && <span className="slp-error">This is not a loopback or LAN address: your images will travel over the network to it.</span>}
            {err && <span className="slp-error">{err}</span>}
            {!err && lists.status === 'ok' && <span className="slp-note">{lists.message}</span>}
            {L && lists.status !== 'error' && (
              <span className="slp-note" style={{ maxHeight: 84, overflow: 'auto', display: 'block' }}>
                <b>Checkpoints:</b> {L.checkpoints.join(', ') || '—'}
                <br />
                <b>ControlNet:</b> {L.controlnets.join(', ') || '—'}
              </span>
            )}
          </Row>
          <Sep />
          <Row label="Privacy" top col>
            <Note>
              When you press Generate on a Generate (Stable Diffusion) node, its prompts and connected images (init image, control maps, mask) are sent to{' '}
              {SERVER_NAMES[kind]} at this URL, and nowhere else. Nothing is sent while the server is Off.
            </Note>
          </Row>
          <Row label="Setup" top col>
            <Note>
              The server must allow this page: {corsHint(kind)} {kind === 'a1111' ? 'Install the ControlNet extension (built into Forge).' : ''} See Help › ControlNet for the exact
              launch commands.
            </Note>
          </Row>
        </>
      )}
      {kind === 'off' && (
        <Row>
          <Note>Generation is off: Generate nodes show a placeholder and send nothing. The ControlNet preprocessor nodes always run locally.</Note>
        </Row>
      )}
    </div>
  );
}
