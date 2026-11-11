/**
 * Darkroom desktop shell (Electron main process). See docs/DESKTOP.md.
 *
 *  - serves the built web app (dist/) from the privileged `app://darkroom/` scheme
 *    (or the Vite dev server when DARKROOM_DEV_URL is set)
 *  - one hiddenInset window, size/position remembered
 *  - native application menu, built from the renderer's command table (IPC)
 *  - native open/save dialogs and file IO, Finder open-file / Dock drops, recent documents
 *  - follows the system light/dark appearance (nativeTheme)
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, protocol, screen, session, shell, type MenuItemConstructorOptions } from 'electron';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  IPC,
  type EditRole,
  type FileFilter,
  type NativeMenuItem,
  type NativeMenuState,
  type NativeMenuTemplate,
  type NativeRole,
  type OpenedFile,
  type ThemeSourcePref,
} from '../src/native/api';
import { registerCoreML } from './coreml/ipc';
import { grantRoot, registerFiles } from './files/ipc';

const SCHEME = 'app';
const HOST = 'darkroom';
const APP_URL = `${SCHEME}://${HOST}/`;
const DEV_URL = process.env.DARKROOM_DEV_URL || '';
const isMac = process.platform === 'darwin';

const PROJECT_EXTS = ['darkroom', 'json'];
const RAW_EXTS = ['dng', 'cr2', 'cr3', 'nef', 'arw', 'raf', 'orf', 'rw2'];
const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'avif', 'heic', 'heif', 'tif', 'tiff', ...RAW_EXTS];
const extOf = (p: string) => path.extname(p).slice(1).toLowerCase();

app.setName('Darkroom');
// tests / side-by-side profiles: DARKROOM_USER_DATA=<dir> isolates settings, localStorage and autosave
if (process.env.DARKROOM_USER_DATA) app.setPath('userData', process.env.DARKROOM_USER_DATA);

// Must happen before `ready`: a standard + secure scheme gets a real origin (localStorage,
// IndexedDB, Workers, fetch, Blob-URL dynamic import(), WASM streaming compile all work).
protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } },
]);

// ---------------------------------------------------------------------------
// Persistent state (window bounds, theme, paths the user granted via dialogs)
// ---------------------------------------------------------------------------

interface State {
  bounds?: { x: number; y: number; width: number; height: number };
  maximized?: boolean;
  themePref?: ThemeSourcePref;
  resolvedTheme?: 'classic' | 'aperture' | 'aqua';
  /** Project files the user picked/saved through a native dialog or Finder: may be overwritten in place. */
  granted?: string[];
}
const statePath = () => path.join(app.getPath('userData'), 'window-state.json');
let state: State = {};
try {
  state = JSON.parse(readFileSync(statePath(), 'utf8')) as State;
} catch {
  /* first run */
}
let saveTimer: NodeJS.Timeout | undefined;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void mkdir(path.dirname(statePath()), { recursive: true })
      .then(() => writeFile(statePath(), JSON.stringify(state)))
      .catch(() => {});
  }, 300);
}
const granted = new Set(state.granted ?? []);
function grant(p: string) {
  granted.delete(p);
  granted.add(p);
  state.granted = [...granted].slice(-100);
  saveState();
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

const THEME_BG = { classic: '#d4d0c8', aperture: '#2b2b2b', aqua: '#e3e3e3' } as const;
const themeSourceFor = (p: ThemeSourcePref) => (p === 'auto' ? 'system' : p === 'aperture' ? 'dark' : 'light');
function resolvedTheme(): keyof typeof THEME_BG {
  const pref = state.themePref ?? 'auto';
  if (pref === 'auto') return nativeTheme.shouldUseDarkColors ? 'aperture' : 'aqua';
  return pref;
}
nativeTheme.themeSource = themeSourceFor(state.themePref ?? 'auto');

// ---------------------------------------------------------------------------
// app:// protocol
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  webmanifest: 'application/manifest+json',
  map: 'application/json',
  txt: 'text/plain; charset=utf-8',
  glsl: 'text/plain; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  ico: 'image/x-icon',
  avif: 'image/avif',
  wasm: 'application/wasm',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  onnx: 'application/octet-stream',
};

function registerAppProtocol() {
  const root = path.join(app.getAppPath(), 'dist-app');
  protocol.handle(SCHEME, async (req) => {
    const url = new URL(req.url);
    if (url.host !== HOST) return new Response('Not found', { status: 404 });
    let rel: string;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      return new Response('Bad request', { status: 400 });
    }
    let file = path.normalize(path.join(root, rel));
    if (file !== root && !file.startsWith(root + path.sep)) return new Response('Forbidden', { status: 403 });
    let st = await stat(file).catch(() => null);
    if (!st || st.isDirectory()) {
      // SPA fallback for extension-less routes; real missing assets are 404s
      if (path.extname(rel)) return new Response('Not found', { status: 404 });
      file = path.join(root, 'index.html');
      st = await stat(file).catch(() => null);
      if (!st) return new Response('Not found', { status: 404 });
    }
    const headers: Record<string, string> = {
      'content-type': MIME[extOf(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
      'accept-ranges': 'bytes',
    };
    const size = st.size;
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') ?? '');
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      let end = range[1] && range[2] ? Number(range[2]) : size - 1;
      end = Math.min(end, size - 1);
      start = Math.min(start, end);
      const body = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream;
      return new Response(body, {
        status: 206,
        headers: { ...headers, 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${size}` },
      });
    }
    const body = Readable.toWeb(createReadStream(file)) as ReadableStream;
    return new Response(body, { headers: { ...headers, 'content-length': String(size) } });
  });
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

let win: BrowserWindow | null = null;
let rendererReady = false;

function visibleBounds(b: State['bounds']) {
  if (!b) return undefined;
  const ok = screen.getAllDisplays().some((d) => {
    const w = d.workArea;
    return b.x + 100 > w.x && b.y + 40 > w.y && b.x < w.x + w.width - 100 && b.y < w.y + w.height - 40;
  });
  return ok ? b : { width: b.width, height: b.height, x: undefined, y: undefined };
}

function createWindow() {
  const b = visibleBounds(state.bounds);
  const w = new BrowserWindow({
    width: b?.width ?? 1440,
    height: b?.height ?? 900,
    x: b?.x,
    y: b?.y,
    minWidth: 900,
    minHeight: 560,
    show: false,
    title: 'Darkroom',
    backgroundColor: THEME_BG[resolvedTheme()],
    ...(isMac ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 12 } } : {}),
    webPreferences: {
      preload: path.join(import.meta.dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  win = w;
  rendererReady = false;
  if (state.maximized) w.maximize();
  w.once('ready-to-show', () => w.show());

  const remember = () => {
    if (w.isDestroyed() || w.isFullScreen() || w.isMinimized()) return;
    state.maximized = w.isMaximized();
    if (!state.maximized) state.bounds = w.getBounds();
    saveState();
  };
  w.on('resize', remember);
  w.on('move', remember);
  w.on('close', (e) => {
    remember();
    if (closeOk.has(w) || !edited.get(w) || !rendererReady) return;
    e.preventDefault();
    void (async () => {
      const name = w.getTitle() || 'Untitled';
      // test hook (like DARKROOM_TEST_DIALOG_PATH): 'save' | 'cancel' | 'discard'
      const forced = { save: 0, cancel: 1, discard: 2 }[process.env.DARKROOM_TEST_CLOSE_CHOICE ?? ''];
      // the forced answer arrives on a later tick, like the real dialog's: answering synchronously would close the
      // window and re-call app.quit() inside this prevented 'close' event, where Electron drops the quit
      const r = forced !== undefined ? await new Promise<{ response: number }>((res) => setTimeout(() => res({ response: forced }), 0)) : await dialog.showMessageBox(w, {
        type: 'warning',
        buttons: ['Save', 'Cancel', 'Don’t Save'],
        defaultId: 0,
        cancelId: 1,
        message: `Do you want to save the changes you made to “${name}”?`,
        detail: 'Your changes will be lost if you don’t save them. (The last session is also kept as an autosave.)',
      });
      if (r.response === 1) {
        quitting = false; // a cancelled close also cancels a pending ⌘Q
        return;
      }
      if (r.response === 2) return closeNow(w);
      w.webContents.send(IPC.saveBeforeClose); // renderer saves, then replies via closeAfterSave
    })();
  });
  w.on('closed', () => {
    if (win === w) win = null;
  });

  // the renderer's document.title includes "*" etc.; the native title is set via setDocument
  w.on('page-title-updated', (e) => e.preventDefault());

  const wc = w.webContents;
  wc.on('did-start-navigation', (d) => {
    if (d.isMainFrame && !d.isSameDocument) rendererReady = false;
  });
  const ours = (u: string) => u.startsWith(APP_URL) || (!!DEV_URL && u.startsWith(DEV_URL));
  wc.on('will-navigate', (e, url) => {
    if (ours(url)) return;
    e.preventDefault();
    if (/^https?:/i.test(url)) void shell.openExternal(url);
  });
  wc.setWindowOpenHandler(({ url }) => {
    // the app's own pages (e.g. the render harness from Preferences › Advanced) open in a child window
    if (ours(url) && !/\.md(#|$)/i.test(url)) return { action: 'allow', overrideBrowserWindowOptions: { width: 1100, height: 760, backgroundColor: '#1d1e21' } };
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  void w.loadURL(DEV_URL || APP_URL);
  return w;
}

function ensureWindow() {
  if (!win || win.isDestroyed()) createWindow();
  return win!;
}

// ---------------------------------------------------------------------------
// Finder → app: open-file (also before `ready`), Dock drops, second instance
// ---------------------------------------------------------------------------

const pendingOpen: string[] = [];
let flushTimer: NodeJS.Timeout | undefined;

function queueOpen(p: string) {
  const ext = extOf(p);
  if (!PROJECT_EXTS.includes(ext) && !IMAGE_EXTS.includes(ext)) return;
  pendingOpen.push(p);
  if (app.isReady()) {
    const w = ensureWindow();
    if (w.isMinimized()) w.restore();
    w.focus();
  }
  scheduleFlush();
}

function scheduleFlush() {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => void flushOpen(), 120);
}

async function flushOpen() {
  if (!rendererReady || !win || win.isDestroyed() || !pendingOpen.length) return;
  const paths = pendingOpen.splice(0);
  const files: OpenedFile[] = [];
  for (const p of paths) {
    try {
      if (PROJECT_EXTS.includes(extOf(p))) {
        files.push({ kind: 'project', path: p, name: path.basename(p, path.extname(p)), text: await readFile(p, 'utf8') });
        grant(p);
        app.addRecentDocument(p);
      } else {
        files.push({ kind: 'image', path: p, name: path.basename(p), data: await readFile(p) });
      }
      grantRoot(path.dirname(p)); // the Browse workspace may show the folder of a file opened from Finder
    } catch (e) {
      console.warn('[darkroom] could not open', p, e);
    }
  }
  if (files.length) win.webContents.send(IPC.openFiles, files);
}

app.on('open-file', (e, p) => {
  e.preventDefault();
  queueOpen(p);
});

function filesFromArgv(argv: string[]) {
  return argv.slice(1).filter((a) => !a.startsWith('-') && path.isAbsolute(a) && existsSync(a));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const w = ensureWindow();
    if (w.isMinimized()) w.restore();
    w.focus();
    filesFromArgv(argv).forEach(queueOpen);
  });
}

// ---------------------------------------------------------------------------
// Dialogs + file IO
// ---------------------------------------------------------------------------

/** Test-only bypass: DARKROOM_TEST_DIALOG_PATH=<path>[:<path>…] answers every dialog. */
function testPaths(): string[] | null {
  const v = process.env.DARKROOM_TEST_DIALOG_PATH;
  return v ? v.split(path.delimiter).filter(Boolean) : null;
}

async function pickOpen(filters: FileFilter[], multi: boolean): Promise<string[]> {
  const t = testPaths();
  if (t) return multi ? t : t.slice(0, 1);
  const w = ensureWindow();
  const r = await dialog.showOpenDialog(w, { properties: multi ? ['openFile', 'multiSelections'] : ['openFile'], filters });
  return r.canceled ? [] : r.filePaths;
}

async function pickSave(defaultPath: string, filters: FileFilter[]): Promise<string | null> {
  const t = testPaths();
  if (t) return t[0];
  const w = ensureWindow();
  const r = await dialog.showSaveDialog(w, { defaultPath, filters, properties: ['createDirectory', 'showOverwriteConfirmation'] });
  return r.canceled || !r.filePath ? null : r.filePath;
}

async function writeAtomic(file: string, data: string | Uint8Array) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  await writeFile(tmp, data);
  await rename(tmp, file);
}

const PROJECT_FILTER: FileFilter[] = [{ name: 'Darkroom Project', extensions: ['darkroom'] }];
const safeFileName = (s: string) => s.replace(/[/\\:*?"<>|]+/g, '').trim() || 'Untitled';

// --- closing with unsaved changes -----------------------------------------
const edited = new WeakMap<BrowserWindow, boolean>();
const closeOk = new WeakSet<BrowserWindow>();
let quitting = false;
app.on('before-quit', () => (quitting = true));
function closeNow(w: BrowserWindow) {
  closeOk.add(w);
  w.close();
  if (quitting) app.quit();
}

// --- Stable Diffusion bridge: relax CORS for exactly the configured server ---
/** Set by the renderer (Preferences › Generation); null = generation off, nothing is rewritten. */
let genOrigin: URL | null = null;
const toHttp = (p: string) => (p === 'ws:' ? 'http:' : p === 'wss:' ? 'https:' : p);
function isGenServer(url: string) {
  if (!genOrigin) return false;
  try {
    const u = new URL(url);
    return toHttp(u.protocol) === genOrigin.protocol && u.host === genOrigin.host;
  } catch {
    return false;
  }
}
/**
 * ComfyUI rejects foreign Origins and neither ComfyUI nor A1111 send CORS headers by default, so the
 * app:// renderer could not talk to a stock local server. For requests to the user's configured
 * server only: drop Origin/Referer, answer preflights, and add permissive CORS response headers.
 */
function installGenServerCors() {
  const wr = session.defaultSession.webRequest;
  wr.onBeforeSendHeaders((d, cb) => {
    if (!isGenServer(d.url)) return cb({});
    const h = { ...d.requestHeaders };
    for (const k of Object.keys(h)) if (/^(origin|referer)$/i.test(k)) delete h[k];
    cb({ requestHeaders: h });
  });
  wr.onHeadersReceived((d, cb) => {
    if (!isGenServer(d.url)) return cb({});
    const h: Record<string, string[]> = { ...(d.responseHeaders ?? {}) };
    for (const k of Object.keys(h)) if (/^access-control-/i.test(k)) delete h[k];
    h['Access-Control-Allow-Origin'] = ['*'];
    h['Access-Control-Allow-Methods'] = ['GET, POST, DELETE, OPTIONS'];
    h['Access-Control-Allow-Headers'] = ['Content-Type, Authorization'];
    cb({ responseHeaders: h, ...(d.method === 'OPTIONS' ? { statusLine: 'HTTP/1.1 204 No Content' } : {}) });
  });
}

function registerIpc() {
  ipcMain.on(IPC.appVersion, (e) => (e.returnValue = app.getVersion()));

  ipcMain.handle(IPC.openProject, async () => {
    const [p] = await pickOpen([{ name: 'Darkroom Project', extensions: PROJECT_EXTS }], false);
    if (!p) return null;
    const text = await readFile(p, 'utf8');
    grant(p);
    app.addRecentDocument(p);
    return { path: p, name: path.basename(p, path.extname(p)), text };
  });

  ipcMain.handle(IPC.saveProject, async (_e, text: string, opts: { path?: string | null; suggestedName: string; saveAs?: boolean }) => {
    if (typeof text !== 'string') throw new Error('bad project data');
    // overwrite in place only for files the user opened/saved through us (never arbitrary renderer paths)
    let target = !opts.saveAs && opts.path && granted.has(opts.path) ? opts.path : null;
    if (!target) {
      const dir = opts.path ? path.dirname(opts.path) : app.getPath('documents');
      target = await pickSave(path.join(dir, `${safeFileName(opts.suggestedName)}.darkroom`), PROJECT_FILTER);
      if (!target) return null;
      if (!path.extname(target)) target += '.darkroom';
    }
    await writeAtomic(target, text);
    grant(target);
    app.addRecentDocument(target);
    return { path: target, name: path.basename(target, path.extname(target)) };
  });

  ipcMain.handle(IPC.openImages, async () => {
    const paths = await pickOpen(
      [
        { name: 'Images', extensions: IMAGE_EXTS },
        { name: 'Camera RAW', extensions: RAW_EXTS },
        { name: 'All Files', extensions: ['*'] },
      ],
      true,
    );
    const out = [];
    for (const p of paths) out.push({ path: p, name: path.basename(p), data: await readFile(p) });
    return out;
  });

  ipcMain.handle(IPC.saveFile, async (_e, data: Uint8Array, opts: { suggestedName: string; filters?: FileFilter[] }) => {
    if (!(data instanceof Uint8Array)) throw new Error('bad file data');
    const target = await pickSave(path.join(app.getPath('pictures'), safeFileName(opts.suggestedName)), opts.filters ?? []);
    if (!target) return null;
    await writeAtomic(target, data);
    return target;
  });

  ipcMain.on(IPC.setDocument, (e, doc: { title: string; path: string | null; edited: boolean }) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w) return;
    edited.set(w, !!doc.edited);
    w.setTitle(doc.path ? path.basename(doc.path) : doc.title || 'Darkroom');
    if (isMac) {
      w.setRepresentedFilename(doc.path && existsSync(doc.path) ? doc.path : '');
      w.setDocumentEdited(!!doc.edited);
    }
  });

  ipcMain.on(IPC.setTheme, (e, pref: ThemeSourcePref, resolved: State['resolvedTheme']) => {
    if (!['auto', 'classic', 'aperture', 'aqua'].includes(pref)) return;
    // only on a preference change: 'auto' re-resolving must not reset an explicit themeSource
    if (pref !== (state.themePref ?? 'auto')) nativeTheme.themeSource = themeSourceFor(pref);
    state.themePref = pref;
    state.resolvedTheme = resolved;
    saveState();
    BrowserWindow.fromWebContents(e.sender)?.setBackgroundColor(THEME_BG[resolvedTheme()]);
  });

  ipcMain.on(IPC.setMenu, (_e, template: NativeMenuTemplate, st: NativeMenuState) => buildMenu(template, st));
  ipcMain.on(IPC.updateMenuState, (_e, st: NativeMenuState) => applyMenuState(st));

  const EDIT_ROLES: EditRole[] = ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll', 'delete'];
  ipcMain.on(IPC.editRole, (e, role: EditRole) => {
    if (EDIT_ROLES.includes(role)) e.sender[role]();
  });

  ipcMain.on(IPC.closeAfterSave, (e, saved: boolean) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w) return;
    if (saved) closeNow(w);
    else quitting = false; // save was cancelled: stay open
  });
  ipcMain.on(IPC.setGenServer, (_e, url: string | null) => {
    try {
      genOrigin = url ? new URL(url) : null;
    } catch {
      genOrigin = null;
    }
  });
  ipcMain.on(IPC.ready, (e) => {
    if (win && e.sender === win.webContents) {
      rendererReady = true;
      scheduleFlush();
    }
  });
}

// ---------------------------------------------------------------------------
// Native menu (template comes from the renderer's command table)
// ---------------------------------------------------------------------------

const ROLES: NativeRole[] = [
  'about',
  'services',
  'hide',
  'hideOthers',
  'unhide',
  'quit',
  'close',
  'minimize',
  'zoom',
  'front',
  'togglefullscreen',
  'toggleDevTools',
  'reload',
  'recentDocuments',
  'clearRecentDocuments',
];
let menuItems = new Map<string, Electron.MenuItem>();

function sendCommand(id: string, viaAccelerator: boolean) {
  const w = ensureWindow();
  if (rendererReady) w.webContents.send(IPC.menuCommand, id, viaAccelerator);
}

function toItem(it: NativeMenuItem, st: NativeMenuState): MenuItemConstructorOptions | null {
  switch (it.type) {
    case 'sep':
      return { type: 'separator' };
    case 'role':
      if (!ROLES.includes(it.role)) return null;
      if (it.role === 'recentDocuments')
        return { label: it.label ?? 'Open Recent', role: 'recentDocuments', submenu: [{ label: 'Clear Menu', role: 'clearRecentDocuments' }] };
      return { role: it.role, ...(it.label ? { label: it.label } : {}), ...(it.accelerator ? { accelerator: it.accelerator } : {}) };
    case 'submenu':
      return { label: it.label, ...(it.role ? { role: it.role } : {}), submenu: it.items.map((x) => toItem(x, st)).filter((x) => !!x) };
    case 'cmd': {
      const s = st[it.id];
      const checkable = it.checked !== undefined || s?.checked !== undefined;
      return {
        id: it.id,
        label: it.label,
        accelerator: it.accelerator,
        registerAccelerator: it.registerAccelerator ?? true,
        enabled: s?.enabled ?? it.enabled,
        type: checkable ? (it.radio ? 'radio' : 'checkbox') : 'normal',
        checked: checkable ? !!(s?.checked ?? it.checked) : undefined,
        click: (_mi, _w, ev) => sendCommand(it.id, !!ev?.triggeredByAccelerator),
      };
    }
  }
}

function buildMenu(t: NativeMenuTemplate, st: NativeMenuState) {
  const tpl: MenuItemConstructorOptions[] = t.menus.map((m) => ({
    label: m.role === 'appMenu' ? app.name : m.label,
    ...(m.role === 'windowMenu' || m.role === 'help' ? { role: m.role } : {}),
    submenu: m.items.map((x) => toItem(x, st)).filter((x) => !!x),
  }));
  const menu = Menu.buildFromTemplate(tpl);
  menuItems = new Map();
  const walk = (m: Electron.Menu) =>
    m.items.forEach((i) => {
      if (i.id) menuItems.set(i.id, i);
      if (i.submenu) walk(i.submenu);
    });
  walk(menu);
  Menu.setApplicationMenu(menu);
}

function applyMenuState(st: NativeMenuState) {
  for (const [id, s] of Object.entries(st)) {
    const mi = menuItems.get(id);
    if (!mi) continue;
    if (mi.enabled !== s.enabled) mi.enabled = s.enabled;
    if (s.checked !== undefined && mi.checked !== s.checked) mi.checked = s.checked;
  }
}

/** Minimal menu until the renderer sends the real one (and if it never does). */
function fallbackMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(isMac ? [{ role: 'appMenu' as const }] : []),
      { role: 'editMenu' as const },
      { role: 'viewMenu' as const },
      { role: 'windowMenu' as const },
    ]),
  );
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

const ALLOWED_PERMISSIONS = new Set(['media', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'pointerLock']);

void app.whenReady().then(() => {
  registerAppProtocol();
  registerIpc();
  installGenServerCors();
  registerCoreML();
  registerFiles();
  fallbackMenu();
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(ALLOWED_PERMISSIONS.has(perm)));
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => ALLOWED_PERMISSIONS.has(perm));
  nativeTheme.on('updated', () => {
    if ((state.themePref ?? 'auto') === 'auto') win?.setBackgroundColor(THEME_BG[resolvedTheme()]);
  });
  if (!isMac) filesFromArgv(process.argv).forEach(queueOpen);
  createWindow();
  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});
