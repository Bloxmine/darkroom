import { useEffect, useRef, useState } from 'react';
import './App.css';
import * as A from './store/actions';
import { useDoc } from './store/doc';
import { importImageFiles } from './store/io';
import { useUi } from './store/ui';
import { Splitter, StatusBar } from './ui/Chrome';
import { graphApi, handleKeyDown } from './ui/commands';
import { Dialogs } from './ui/Dialogs';
import { GraphEditor } from './ui/GraphEditor';
import { Library } from './ui/Library';
import { MenuBar } from './ui/MenuBar';
import { Properties } from './ui/Properties';
import { Toolbar } from './ui/Toolbar';
import { Viewer } from './ui/Viewer';

function useGlobalHandlers() {
  useEffect(() => {
    const paste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (useUi.getState().dialog) return;
      const at = graphApi.mouseFlowPos() ?? undefined;
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
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
  const showLib = useUi((s) => s.showLibrary);
  const showProps = useUi((s) => s.showProperties);
  const libW = useUi((s) => s.libraryWidth);
  const propW = useUi((s) => s.propertiesWidth);
  const frac = useUi((s) => s.viewerFrac);
  const center = useRef<HTMLDivElement>(null);
  const start = useRef(0);
  const name = useDoc((s) => s.project.name);
  const dirty = useDoc((s) => s.dirty);
  const [, force] = useState(0);

  useEffect(() => {
    document.title = `${dirty ? '*' : ''}${name || 'Untitled'} — Darkroom`;
  }, [name, dirty]);
  useEffect(() => {
    const r = () => force((x) => x + 1);
    window.addEventListener('resize', r);
    return () => window.removeEventListener('resize', r);
  }, []);

  return (
    <div className="app">
      <MenuBar />
      <Toolbar />
      <div className="workspace">
        {showLib && (
          <>
            <div className="side" style={{ width: libW }}>
              <Library />
            </div>
            <Splitter
              dir="v"
              onStart={() => (start.current = useUi.getState().libraryWidth)}
              onDrag={(d) => useUi.setState({ libraryWidth: Math.max(150, Math.min(480, start.current + d)) })}
            />
          </>
        )}
        <div className="center" ref={center}>
          <div className="center-top" style={{ flexBasis: `${frac * 100}%` }}>
            <Viewer />
          </div>
          <Splitter
            dir="h"
            onStart={() => (start.current = useUi.getState().viewerFrac)}
            onDrag={(d) => {
              const h = center.current?.clientHeight || 1;
              useUi.setState({ viewerFrac: Math.max(0.15, Math.min(0.85, start.current + d / h)) });
            }}
          />
          <div className="center-bottom">
            <GraphEditor />
          </div>
        </div>
        {showProps && (
          <>
            <Splitter
              dir="v"
              onStart={() => (start.current = useUi.getState().propertiesWidth)}
              onDrag={(d) => useUi.setState({ propertiesWidth: Math.max(220, Math.min(560, start.current - d)) })}
            />
            <div className="side" style={{ width: propW }}>
              <Properties />
            </div>
          </>
        )}
      </div>
      <StatusBar />
      <Dialogs />
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
