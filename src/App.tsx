import { useEffect } from 'react';
import { AiDownloadPrompt } from './ui/ai/DownloadPrompt';
import { DocsHost } from './ui/docs/DocsWindow';
import './App.css';
import './ui/themes/mac.css';
import './ui/themes/aperture.css';
import './ui/themes/aqua.css';
import * as A from './store/actions';
import { useDoc } from './store/doc';
import { importImageFiles } from './store/io';
import { isImportableImage } from './core/raw/formats';
import { useUi } from './store/ui';
import { StatusBar } from './ui/Chrome';
import { graphApi, handleKeyDown } from './ui/commands';
import { Dialogs } from './ui/Dialogs';
import { ExtensionsHost } from './ui/PluginManager';
import { MenuBar } from './ui/MenuBar';
import { nativeMac } from './native/native';
import { Toolbar } from './ui/Toolbar';
import { DockRoot, WorkspaceDialogs } from './ui/workspace';

function useGlobalHandlers() {
  useEffect(() => {
    const paste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (useUi.getState().dialog) return;
      const at = graphApi.mouseFlowPos() ?? undefined;
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => isImportableImage(f.name, f.type));
      e.preventDefault();
      if (files.length) {
        void importImageFiles(files, at);
        return;
      }
      const text = e.clipboardData?.getData('text/plain');
      if (text && A.pasteText(text, at)) return;
      A.pasteClipboard(at);
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('paste', paste);
    // block the browser's own context menu everywhere except text fields
    const cm = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest('input,textarea')) e.preventDefault();
    };
    window.addEventListener('contextmenu', cm);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('paste', paste);
      window.removeEventListener('contextmenu', cm);
    };
  }, []);
}

export default function App({ ready }: { ready: boolean }) {
  useGlobalHandlers();
  const name = useDoc((s) => s.project.name);
  const dirty = useDoc((s) => s.dirty);

  useEffect(() => {
    document.title = `${dirty ? '*' : ''}${name || 'Untitled'} — Darkroom`;
  }, [name, dirty]);

  return (
    <div className="app">
      {!nativeMac && <MenuBar />}
      <Toolbar />
      {/* docked panels, arranged by the active workspace (Window › Workspace, src/ui/workspace) */}
      <DockRoot />
      <StatusBar />
      <Dialogs />
      <WorkspaceDialogs />
      <DocsHost />
      <AiDownloadPrompt />
      <ExtensionsHost />
      {!ready && (
        <div className="modal-backdrop light">
          <div className="window loading">
            <div className="titlebar">
              <span className="titlebar-text">Darkroom</span>
            </div>
            <div className="dialog-body">
              <img src="/icons/fatcow/32x32/hourglass.png" alt="" /> Loading project…
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
