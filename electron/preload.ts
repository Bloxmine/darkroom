/**
 * Preload (sandboxed, context-isolated). Exposes a small, typed `window.darkroomNative`
 * API — no Node, no fs, no generic ipcRenderer. See docs/DESKTOP.md.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC, type CoreMLApi, type CoreMLEvent, type DarkroomNative, type FilesApi, type OpenedFile } from '../src/native/api';
import type { FsChange } from '../src/core/files/types';

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

/** File browser (Browse workspace). Paths are validated against the granted roots in main (electron/files/ipc.ts). */
const files: FilesApi = {
  caps: { rename: true, move: true, copy: true, trash: true, reveal: true, openDefault: true, mkdir: true, sidecarOnDisk: true, watch: true },
  roots: () => ipcRenderer.invoke(IPC.filesRoots),
  addRoot: () => ipcRenderer.invoke(IPC.filesAddRoot),
  removeRoot: (p) => ipcRenderer.invoke(IPC.filesRemoveRoot, p),
  list: (dir, opts) => ipcRenderer.invoke(IPC.filesList, dir, opts),
  stat: (p) => ipcRenderer.invoke(IPC.filesStat, p),
  read: (p, range) => ipcRenderer.invoke(IPC.filesRead, p, range),
  thumb: (p, size) => ipcRenderer.invoke(IPC.filesThumb, p, size),
  meta: (paths) => ipcRenderer.invoke(IPC.filesMeta, paths),
  writeXmp: (p, data) => ipcRenderer.invoke(IPC.filesWriteXmp, p, data),
  rename: (pairs) => ipcRenderer.invoke(IPC.filesRename, pairs),
  transfer: (paths, dest, mode) => ipcRenderer.invoke(IPC.filesTransfer, paths, dest, mode),
  trash: (paths) => ipcRenderer.invoke(IPC.filesTrash, paths),
  reveal: (p) => ipcRenderer.send(IPC.filesReveal, p),
  openDefault: (p) => ipcRenderer.invoke(IPC.filesOpenDefault, p),
  mkdir: (parent, name) => ipcRenderer.invoke(IPC.filesMkdir, parent, name),
  watch: (dir) => ipcRenderer.invoke(IPC.filesWatch, dir),
  unwatch: (id) => ipcRenderer.send(IPC.filesUnwatch, id),
  onChange: (cb) => listen<[FsChange]>(IPC.filesChanged, cb),
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
  files,
  ...(process.platform === 'darwin' ? { coreml } : {}),
};

contextBridge.exposeInMainWorld('darkroomNative', api);
