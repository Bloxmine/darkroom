/**
 * IPC for the built-in Core ML engine (window.darkroomNative.coreml, see src/native/api.ts › CoreMLApi).
 * Security model: the renderer passes model ids and catalog ids only; folders are chosen in a native dialog here,
 * deletions are limited to Darkroom's own models folder (and go to the Trash).
 */
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import { IPC, type CoreMLEvent, type CoreMLGenerateRequest } from '../../src/native/api';
import { CoreMLDownloads } from './downloads';
import { CoreMLEngine, CoreMLError } from './engine';

let engine: CoreMLEngine | null = null;
let downloads: CoreMLDownloads | null = null;

function helperPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'darkroom-coreml', 'darkroom-coreml')
    : path.join(app.getAppPath(), 'dist-native', 'darkroom-coreml', 'darkroom-coreml');
}

const emit = (e: CoreMLEvent) => {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(IPC.coremlEvent, e);
};

/** Errors cross IPC as plain messages; keep the helper's code as a prefix the renderer can show. */
const wrap =
  <A extends unknown[], R>(f: (...a: A) => Promise<R>) =>
  async (_e: Electron.IpcMainInvokeEvent, ...a: A): Promise<R> => {
    try {
      return await f(...a);
    } catch (err) {
      const e = err as Error & { code?: string };
      throw new Error(err instanceof CoreMLError ? `[${e.code}] ${e.message}` : e?.message ?? String(err));
    }
  };

export function registerCoreML() {
  if (process.platform !== 'darwin') return;
  const userData = app.getPath('userData');
  const modelsDir = path.join(userData, 'coreml-models');
  engine = new CoreMLEngine({
    helperPath: helperPath(),
    modelsDir,
    stateDir: path.join(userData, 'coreml-state'),
    settingsFile: path.join(userData, 'coreml.json'),
    emit,
    log: process.env.DARKROOM_COREML_LOG ? console.log : undefined,
  });
  downloads = new CoreMLDownloads(modelsDir, emit);
  const E = engine, D = downloads;

  ipcMain.handle(IPC.coremlStatus, wrap(() => E.status()));
  ipcMain.handle(IPC.coremlList, wrap(() => E.listModels()));
  ipcMain.handle(IPC.coremlGenerate, wrap((req: CoreMLGenerateRequest) => E.generate(req)));
  ipcMain.on(IPC.coremlCancel, (_e, jobId: string) => E.cancel(String(jobId)));
  ipcMain.handle(
    IPC.coremlAddFolder,
    wrap(async () => {
      const w = BrowserWindow.getFocusedWindow();
      const opts: Electron.OpenDialogOptions = {
        title: 'Add a Core ML models folder',
        message: 'Choose a folder with Core ML Stable Diffusion models or ControlNets (for example Mochi Diffusion’s models folder).',
        properties: ['openDirectory', 'createDirectory'],
      };
      // test hook, like main's DARKROOM_TEST_DIALOG_PATH: answers the folder picker
      const forced = process.env.DARKROOM_TEST_DIALOG_PATH?.split(path.delimiter).filter(Boolean)[0];
      const r = forced ? { canceled: false, filePaths: [forced] } : w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts);
      if (r.canceled || !r.filePaths[0]) return E.folderList();
      return E.addFolder(r.filePaths[0]);
    }),
  );
  ipcMain.handle(IPC.coremlRemoveFolder, wrap((id: string) => E.removeFolder(String(id))));
  ipcMain.on(IPC.coremlReveal, () => {
    void import('node:fs/promises').then((fs) => fs.mkdir(modelsDir, { recursive: true })).then(() => shell.openPath(modelsDir));
  });
  ipcMain.handle(IPC.coremlDownload, wrap((id: string, accepted: unknown) => D.download(String(id), accepted)));
  ipcMain.on(IPC.coremlCancelDownload, (_e, id: string) => D.cancel(String(id)));
  ipcMain.handle(
    IPC.coremlDelete,
    wrap(async (id: string) => {
      if (!String(id).startsWith('darkroom:')) throw new Error('Only models in Darkroom’s own folder can be deleted here.');
      await E.listModels();
      const p = E.pathOf(String(id));
      if (!p || !p.startsWith(modelsDir + path.sep)) throw new Error('Model not found.');
      await E.unload();
      await shell.trashItem(p);
    }),
  );
  ipcMain.handle(IPC.coremlClearCache, wrap(() => E.clearCache()));
  ipcMain.handle(IPC.coremlUnload, wrap(() => E.unload()));

  app.on('before-quit', () => {
    D.cancelAll();
    E.shutdown();
  });
}
