/**
 * The contract between the Electron main process (electron/main.ts), the preload
 * script (electron/preload.ts) and the renderer (src/native/*). Type-only: this
 * file is imported by both sides and must not contain runtime code that touches
 * DOM or Node APIs.
 *
 * In the browser / PWA build `window.darkroomNative` is undefined and every
 * caller falls back to the web code path.
 */

/** A serialisable native menu item, built in the renderer from the command table. */
export type NativeMenuItem =
  | {
      type: 'cmd';
      /** Command id (src/ui/commands.ts) or a 'dyn:N' id for one-off items (Node › Add submenus). */
      id: string;
      label: string;
      /** Electron accelerator string, e.g. 'CmdOrCtrl+Shift+Z'. */
      accelerator?: string;
      /** false = shown in the menu but the renderer handles the key itself. */
      registerAccelerator?: boolean;
      enabled: boolean;
      /** undefined = plain item, boolean = checkbox (or radio when `radio`). */
      checked?: boolean;
      radio?: boolean;
    }
  | { type: 'sep' }
  | { type: 'submenu'; label: string; items: NativeMenuItem[]; role?: 'windowMenu' | 'help' }
  | { type: 'role'; role: NativeRole; label?: string; accelerator?: string };

/** Electron menu roles the renderer may ask for (whitelisted in main). */
export type NativeRole =
  | 'about'
  | 'services'
  | 'hide'
  | 'hideOthers'
  | 'unhide'
  | 'quit'
  | 'close'
  | 'minimize'
  | 'zoom'
  | 'front'
  | 'togglefullscreen'
  | 'toggleDevTools'
  | 'reload'
  | 'recentDocuments'
  | 'clearRecentDocuments';

/** Top-level menus. The app menu (Darkroom › About/Preferences/Services/Hide/Quit) is the first entry. */
export interface NativeMenuTemplate {
  menus: { label: string; items: NativeMenuItem[]; role?: 'appMenu' | 'windowMenu' | 'help' }[];
}

/** Live enabled/checked state of menu items, keyed by item id. */
export type NativeMenuState = Record<string, { enabled: boolean; checked?: boolean }>;

/** Text-editing actions forwarded to webContents (undo/redo/cut/copy/paste/selectAll in text fields). */
export type EditRole = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll' | 'delete';

export type ThemeSourcePref = 'auto' | 'classic' | 'aperture' | 'aqua';

export interface OpenedProject {
  path: string;
  name: string;
  text: string;
}
export interface OpenedImage {
  path: string;
  name: string;
  data: Uint8Array;
}
/** Files handed to the app by Finder (double-click, Open With, Dock drop, Open Recent). */
export type OpenedFile = ({ kind: 'project' } & OpenedProject) | ({ kind: 'image' } & OpenedImage);

export interface FileFilter {
  name: string;
  extensions: string[];
}

// --- Built-in Core ML Stable Diffusion engine (Mac app only; electron/coreml/*, native/coreml-sd) ---
export type CoreMLComputeUnits = 'cpuAndNeuralEngine' | 'cpuAndGPU' | 'all';
export type CoreMLScheduler = 'dpm++' | 'dpm++karras' | 'pndm';

export interface CoreMLModelInfo {
  /** Opaque id (`<root>:<relative path>`); the renderer never sends paths. */
  id: string;
  name: string;
  /** Folder label (“Darkroom” or the added folder's name). */
  root: string;
  kind: 'sd15' | 'sd2' | 'sdxl' | 'unknown';
  attention: 'splitEinsum' | 'original' | 'unknown';
  width: number;
  height: number;
  controlNetSupport: boolean;
  img2img: boolean;
  bytes: number;
  /** Inside Darkroom's own models folder (can be deleted from Preferences). */
  deletable: boolean;
}
export interface CoreMLControlNetInfo {
  id: string;
  name: string;
  root: string;
  attention: 'splitEinsum' | 'original' | 'unknown';
  width: number;
  height: number;
  /** Model card id from the metadata, e.g. lllyasviel/control_v11p_sd15_canny. */
  version: string;
  bytes: number;
  deletable: boolean;
}
export interface CoreMLModelList {
  models: CoreMLModelInfo[];
  controlNets: CoreMLControlNetInfo[];
}
export type CoreMLEngineState = 'stopped' | 'starting' | 'idle' | 'loading' | 'compiling' | 'ready' | 'busy' | 'unloaded' | 'error';
export interface CoreMLStatus {
  available: boolean;
  /** Why the engine is unavailable (Intel without x86_64 helper, macOS < 13.1, helper missing…). */
  reason?: string;
  arch: string;
  state: CoreMLEngineState;
  helperVersion?: string;
  neuralEngine?: boolean;
  loaded?: { modelId: string; computeUnits: CoreMLComputeUnits; unetDevice?: string; note?: string; controlNets: string[] };
  /** Display only. */
  modelsDir: string;
  folders: { id: string; name: string; path: string }[];
  /** Core ML's compiled-model cache for the helper (bytes). */
  cacheBytes?: number;
}
export interface CoreMLControlInput {
  controlNetId: string;
  /** PNG at the model's size; omitted for the inpaint ControlNet with `maskedCond` (built from init + mask). */
  image?: Uint8Array;
  weight: number;
  start: number;
  end: number;
  /** ControlNet-inpaint convention: pixels under the mask become −1. */
  maskedCond?: boolean;
}
export interface CoreMLGenerateRequest {
  jobId: string;
  modelId: string;
  computeUnits: CoreMLComputeUnits;
  prompt: string;
  negative: string;
  seed: number;
  steps: number;
  guidance: number;
  scheduler: CoreMLScheduler;
  /** PNG at the model's size (img2img / inpaint). */
  init?: Uint8Array;
  strength?: number;
  /** PNG mask, white = regenerate (needs `init`). */
  mask?: Uint8Array;
  controls: CoreMLControlInput[];
  reduceMemory?: boolean;
}
export interface CoreMLGenerateResult {
  png: Uint8Array;
  width: number;
  height: number;
  seed: number;
  timings: Record<string, number>;
  load?: { ms: number; firstLoad: boolean; unetDevice?: string; note?: string };
}
export type CoreMLEvent =
  | { type: 'job'; jobId: string; phase: 'queued' | 'planning' | 'compiling' | 'loading' | 'encoding' | 'denoising' | 'decoding'; step: number; total: number; message: string }
  | { type: 'state'; state: CoreMLEngineState; detail?: string }
  | { type: 'download'; id: string; state: 'downloading' | 'done' | 'error' | 'cancelled'; done: number; total: number; file?: string; error?: string }
  /** Helper stderr lines, exits and main-side errors, for the renderer console (`[darkroom coreml]`). */
  | { type: 'log'; level: 'error' | 'warn' | 'info'; message: string };

export interface CoreMLApi {
  status(): Promise<CoreMLStatus>;
  listModels(): Promise<CoreMLModelList>;
  generate(req: CoreMLGenerateRequest): Promise<CoreMLGenerateResult>;
  cancel(jobId: string): void;
  onEvent(cb: (e: CoreMLEvent) => void): () => void;
  /** Folder picker in main (e.g. Mochi Diffusion's models folder); resolves with the new folder list. */
  addFolder(): Promise<CoreMLStatus['folders']>;
  removeFolder(id: string): Promise<CoreMLStatus['folders']>;
  revealModelsFolder(): void;
  /** Download a catalog item (src/core/sd/coreml-catalog.ts) after the user accepted its licence. */
  download(catalogId: string, licenseAccepted: true): Promise<void>;
  cancelDownload(catalogId: string): void;
  /** Move a model in Darkroom's own folder to the Trash. */
  deleteModel(id: string): Promise<void>;
  /** Quit the helper and delete Core ML's compiled-model cache (it recompiles on next use). */
  clearCache(): Promise<void>;
  unload(): Promise<void>;
}

/** `window.darkroomNative` (exposed by electron/preload.ts via contextBridge). */
export interface DarkroomNative {
  platform: 'darwin' | 'win32' | 'linux' | string;
  versions: { app: string; electron: string; chrome: string };

  // --- files (dialogs run in main; the renderer never gets arbitrary fs access) ---
  /** Open dialog for a .darkroom project; resolves with its text, or null if cancelled. */
  openProject(): Promise<OpenedProject | null>;
  /**
   * Save project text. With `path` and !`saveAs` it overwrites in place;
   * otherwise a save dialog is shown. Resolves with the written path, or null if cancelled.
   */
  saveProject(text: string, opts: { path?: string | null; suggestedName: string; saveAs?: boolean }): Promise<{ path: string; name: string } | null>;
  /** Multi-select image open dialog (incl. RAW). */
  openImages(): Promise<OpenedImage[]>;
  /** Save dialog + write binary data (image export). Resolves with the path, or null if cancelled. */
  saveFile(data: Uint8Array, opts: { suggestedName: string; filters?: FileFilter[] }): Promise<string | null>;

  // --- window / document ---
  setDocument(doc: { title: string; path: string | null; edited: boolean }): void;
  setTheme(pref: ThemeSourcePref, resolved: 'classic' | 'aperture' | 'aqua'): void;

  // --- menu ---
  setMenu(template: NativeMenuTemplate, state: NativeMenuState): void;
  updateMenuState(state: NativeMenuState): void;
  editRole(role: EditRole): void;
  /** Subscribe to native menu clicks. Returns an unsubscribe function. */
  onMenuCommand(cb: (id: string, viaAccelerator: boolean) => void): () => void;

  // --- Finder → app ---
  onOpenFiles(cb: (files: OpenedFile[]) => void): () => void;
  /** Tell main the renderer has booted; queued open-file events are delivered after this. */
  ready(): void;

  // --- closing with unsaved changes ---
  /** Main asks the renderer to save before closing; reply with closeAfterSave(saved). */
  onSaveBeforeClose(cb: () => void): () => void;
  closeAfterSave(saved: boolean): void;

  // --- Stable Diffusion bridge ---
  /**
   * The user-configured generation server URL (or null when generation is Off). Main relaxes CORS /
   * Origin checks for exactly that origin so a stock ComfyUI / A1111 works without launch flags.
   */
  setGenServer(url: string | null): void;
  /** Built-in Core ML engine (macOS only; absent elsewhere and in the web build). */
  coreml?: CoreMLApi;
}

/** IPC channel names (shared so they can't drift). */
export const IPC = {
  openProject: 'darkroom:open-project',
  saveProject: 'darkroom:save-project',
  openImages: 'darkroom:open-images',
  saveFile: 'darkroom:save-file',
  setDocument: 'darkroom:set-document',
  setTheme: 'darkroom:set-theme',
  setMenu: 'darkroom:set-menu',
  updateMenuState: 'darkroom:update-menu-state',
  editRole: 'darkroom:edit-role',
  menuCommand: 'darkroom:menu-command',
  openFiles: 'darkroom:open-files',
  ready: 'darkroom:ready',
  appVersion: 'darkroom:app-version',
  saveBeforeClose: 'darkroom:save-before-close',
  closeAfterSave: 'darkroom:close-after-save',
  setGenServer: 'darkroom:set-gen-server',
  coremlStatus: 'darkroom:coreml-status',
  coremlList: 'darkroom:coreml-list',
  coremlGenerate: 'darkroom:coreml-generate',
  coremlCancel: 'darkroom:coreml-cancel',
  coremlEvent: 'darkroom:coreml-event',
  coremlAddFolder: 'darkroom:coreml-add-folder',
  coremlRemoveFolder: 'darkroom:coreml-remove-folder',
  coremlReveal: 'darkroom:coreml-reveal',
  coremlDownload: 'darkroom:coreml-download',
  coremlCancelDownload: 'darkroom:coreml-cancel-download',
  coremlDelete: 'darkroom:coreml-delete',
  coremlClearCache: 'darkroom:coreml-clear-cache',
  coremlUnload: 'darkroom:coreml-unload',
} as const;
