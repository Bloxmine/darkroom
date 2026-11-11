/**
 * Preload (sandboxed, context-isolated). Exposes a small, typed `window.darkroomNative`
 * API — no Node, no fs, no generic ipcRenderer. See docs/DESKTOP.md.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC, type CoreMLApi, type CoreMLEvent, type DarkroomNative, type OpenedFile } from '../src/native/api';

function listen<T extends unknown[]>(channel: string, cb: (...a: T) => void) {
  const h = (_e: IpcRendererEvent, ...a: unknown[]) => cb(...(a as T));
  ipcRenderer.on(channel, h);
  return () => void ipcRenderer.removeListener(channel, h);
}

/** Built-in Core ML engine (macOS only). Errors from main arrive as “Error invoking remote method …: Error: [code] message”. */
const coreml: CoreMLApi = {
  status: () => ipcRenderer.invoke(IPC.coremlStatus),
  listModels: () => ipcRenderer.invoke(IPC.coremlList),
  generate: (req) => ipcRenderer.invoke(IPC.coremlGenerate, req),
  cancel: (jobId) => ipcRenderer.send(IPC.coremlCancel, jobId),
  onEvent: (cb) => listen<[CoreMLEvent]>(IPC.coremlEvent, cb),
  addFolder: () => ipcRenderer.invoke(IPC.coremlAddFolder),
  removeFolder: (id) => ipcRenderer.invoke(IPC.coremlRemoveFolder, id),
  revealModelsFolder: () => ipcRenderer.send(IPC.coremlReveal),
  download: (id, accepted) => ipcRenderer.invoke(IPC.coremlDownload, id, accepted),
  cancelDownload: (id) => ipcRenderer.send(IPC.coremlCancelDownload, id),
  deleteModel: (id) => ipcRenderer.invoke(IPC.coremlDelete, id),
  clearCache: () => ipcRenderer.invoke(IPC.coremlClearCache),
  unload: () => ipcRenderer.invoke(IPC.coremlUnload),
};

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
  ...(process.platform === 'darwin' ? { coreml } : {}),
};

contextBridge.exposeInMainWorld('darkroomNative', api);
