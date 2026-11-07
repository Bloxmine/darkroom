import { useState } from 'react';
import { answer, useConsent } from '../../core/ai/consent';
import { Dialog } from '../Dialogs';

/** Asks once before a large AI model is downloaded for the first time (see core/ai/consent.ts). */
export function AiDownloadPrompt() {
  const req = useConsent((s) => s.queue[0]);
  const [always, setAlways] = useState(false);
  if (!req) return null;
  const mb = (req.bytes / 1e6).toFixed(0);
  return (
    <Dialog
      title="Download AI Model"
      icon="brain"
      width={420}
      onClose={() => answer(false)}
      buttons={
        <>
          <button className="btn" onClick={() => answer(false)}>
            Not Now
          </button>
          <button className="btn default" autoFocus onClick={() => answer(true, { always })}>
            Download {mb} MB
          </button>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>
        <b>{req.label}</b> needs a one-time download of about <b>{mb} MB</b>.
      </p>
      <p>The model is fetched from its public host and cached for offline use. Your images never leave this computer.</p>
      <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input type="checkbox" checked={always} onChange={(e) => setAlways(e.target.checked)} /> Don’t ask again (Preferences › Plugins &amp; AI)
      </label>
    </Dialog>
  );
}
