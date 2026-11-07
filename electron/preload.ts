/**
 * Preload (sandboxed, context-isolated). Exposes a small, typed `window.darkroomNative`
 * API — no Node, no fs, no generic ipcRenderer. See docs/DESKTOP.md.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC, type DarkroomNative, type OpenedFile } from '../src/native/api';

function listen<T extends unknown[]>(channel: string, cb: (...a: T) => void) {
  const h = (_e: IpcRendererEvent, ...a: unknown[]) => cb(...(a as T));
  ipcRenderer.on(channel, h);
  return () => void ipcRenderer.removeListener(channel, h);
}

const api: DarkroomNative = {
  platform: process.platform,
  versions: {
    app: String(ipcRenderer.sendSync(IPC.appVersion) ?? ''),
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
  },
  openProject: () => ipcRenderer.invoke(IPC.openProject),
  saveProject: (text, opts) => ipcRenderer.invoke(IPC.saveProject, text, opts),
  openImages: () => ipcRenderer.invoke(IPC.openImages),
  saveFile: (data, opts) => ipcRenderer.invoke(IPC.saveFile, data, opts),
  setDocument: (doc) => ipcRenderer.send(IPC.setDocument, doc),
  setTheme: (pref, resolved) => ipcRenderer.send(IPC.setTheme, pref, resolved),
  setMenu: (template, state) => ipcRenderer.send(IPC.setMenu, template, state),
  updateMenuState: (state) => ipcRenderer.send(IPC.updateMenuState, state),
  editRole: (role) => ipcRenderer.send(IPC.editRole, role),
  onMenuCommand: (cb) => listen<[string, boolean]>(IPC.menuCommand, cb),
  onOpenFiles: (cb) => listen<[OpenedFile[]]>(IPC.openFiles, cb),
  ready: () => ipcRenderer.send(IPC.ready),
  onSaveBeforeClose: (cb) => listen<[]>(IPC.saveBeforeClose, cb),
  closeAfterSave: (saved) => ipcRenderer.send(IPC.closeAfterSave, saved),
  setGenServer: (url) => ipcRenderer.send(IPC.setGenServer, url),
};

contextBridge.exposeInMainWorld('darkroomNative', api);
