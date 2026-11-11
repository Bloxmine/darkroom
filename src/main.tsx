import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { setAutoFreeze } from 'immer';
import './index.css';
import App from './App.tsx';
import { PrefsHost } from './ui/prefs/runtime';
import { loadBuiltins } from './nodes';
import { initExtensions } from './store/extensions';
import * as actions from './store/actions';
import * as doc from './store/doc';
import { engine, requestRender } from './store/engine';
import * as io from './store/io';
import { loadAutosave, startAutosave } from './store/persist';
import { setTheme, useSettings } from './store/settings';
import { initNative } from './native/bridge';
import { bindDiagSettings, initDiagnostics, noteEdit } from './core/diag';
import { DiagnosticsHost } from './ui/diagnostics/Diagnostics';
import * as launch from './store/launch';
import * as batch from './store/batch';
import { status, useUi } from './store/ui';
import * as workspace from './ui/workspace/store';
import { listPanels } from './ui/workspace/panels';
import { BrowserHost } from './ui/browser'; // Bridge-style file browser: registers the browser.* panels
import { startProjectPreview } from './store/projectPreview';

setAutoFreeze(false);
loadBuiltins();

/** Restore the autosaved project, or build the starter project. */
async function boot() {
  await initExtensions().catch((e) => console.warn('[darkroom] extensions failed to load', e)); // custom nodes + plugins, before the project
  const launch = useSettings.getState().launchAction; // Preferences › General › At launch
  if (launch === 'empty') return io.newProject();
  const saved = launch === 'restore' ? await loadAutosave() : null;
  if (saved?.project?.graph?.nodes?.length) {
    try {
      await io.loadProject(io.validateProject(saved.project), { viewed: saved.viewed, dirty: saved.dirty });
      status('Restored autosaved project.');
      return;
    } catch (e) {
      console.warn('[darkroom] could not restore autosave', e);
    }
  }
  await io.loadProject(await io.starterProject());
}

// Test / console hook.
declare global {
  interface Window {
    __darkroom?: unknown;
  }
}
window.__darkroom = { doc, actions, io, engine, ui: useUi, settings: useSettings, setTheme, requestRender, launch, batch, workspace: { ...workspace, listPanels } };

const booted = boot()
  .catch((e) => {
    console.error(e);
    status(`Startup failed: ${(e as Error).message}`, 'error');
  })
  .finally(() => (startAutosave(), startProjectPreview()));
// diagnostics first, so errors during boot are captured (Window › Diagnostics)
initDiagnostics();
bindDiagSettings(() => {
  const p = useSettings.getState();
  return { verbose: p.verboseDiagnostics, toasts: p.errorToasts };
});
doc.useDoc.subscribe((st, prev) => st.project !== prev.project && noteEdit());
initNative(booted); // desktop app only (no-op in the browser)
launch.initLaunch(booted); // PWA share target + file handlers (see docs/RAW_AND_BATCH.md)

function Root() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    void booted.then(() => setReady(true));
  }, []);
  return (
    <>
      <App ready={ready} />
      <PrefsHost />
      <DiagnosticsHost />
      <BrowserHost />
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);

// A non-component export keeps this module from being treated as a React Refresh
// boundary: edits to node/preset files (which this module imports) then trigger a
// full page reload instead of re-running createRoot().
export const isEntry = true;
