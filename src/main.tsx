import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { setAutoFreeze } from 'immer';
import './index.css';
import App from './App.tsx';
import { loadBuiltins } from './nodes';
import { initExtensions } from './store/extensions';
import * as actions from './store/actions';
import * as doc from './store/doc';
import { engine, requestRender } from './store/engine';
import * as io from './store/io';
import { loadAutosave, startAutosave } from './store/persist';
import { setTheme, useSettings } from './store/settings';
import { status, useUi } from './store/ui';

setAutoFreeze(false);
loadBuiltins();

/** Restore the autosaved project, or build the starter project. */
async function boot() {
  await initExtensions().catch((e) => console.warn('[darkroom] extensions failed to load', e)); // custom nodes + plugins, before the project
  const saved = await loadAutosave();
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
window.__darkroom = { doc, actions, io, engine, ui: useUi, settings: useSettings, setTheme, requestRender };

const booted = boot()
  .catch((e) => {
    console.error(e);
    status(`Startup failed: ${(e as Error).message}`, 'error');
  })
  .finally(() => startAutosave());

function Root() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    void booted.then(() => setReady(true));
  }, []);
  return <App ready={ready} />;
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
