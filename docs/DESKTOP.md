# Darkroom for macOS (Electron)

The desktop app is the same web app (`src/`) in an Electron shell. The browser/PWA build keeps working
unchanged: every native code path is behind `window.darkroomNative`, which only exists in Electron.

```text
electron/main.ts        main process: protocol, window, menu, dialogs, file IO, Finder events, theme
electron/preload.ts     sandboxed preload: exposes window.darkroomNative (contextBridge)
src/native/api.ts       the shared contract: types + IPC channel names (imported by both sides)
src/native/native.ts    `native` / `nativeMac` accessors for the renderer
src/native/bridge.ts    renderer side: native menu from the command table, theme/title sync, Finder files
src/native/files.ts     native open/save/import/export, current project path
src/native/native.css   hiddenInset title bar: toolbar = drag region, room for the traffic lights
scripts/build-electron.mjs   compiles main (ESM) + preload (CJS) into dist-electron/ with Vite
scripts/electron-dev.mjs     pnpm electron:dev
scripts/make-icns.mjs        build/icon.icns from docs/media/logo.svg (sips + iconutil)
```

## Build and run

| Command | What it does |
|---|---|
| `pnpm electron:dev` | Starts the Vite dev server, compiles `electron/`, launches Electron at the dev server (`DARKROOM_DEV_URL`). Renderer: HMR. `electron/*.ts` changes: rebuild + restart. Closing the app stops the dev server. |
| `pnpm electron:build` | `tsc -b` → `vite build --mode electron --outDir dist-app` → compile `electron/` → `electron-builder --mac`. Output: `release/Darkroom-<version>-<arch>.dmg` and `release/mac-<arch>/Darkroom.app` (host arch). |
| `pnpm electron:compile` | Only compile `electron/` into `dist-electron/`. |
| `pnpm electron:icon` | Regenerate `build/icon.icns` (+ `build/icon.png`). |

`--mode electron` turns off vite-plugin-pwa (`disable: mode === 'electron'`), so the app bundle has no
service worker, `registerSW.js` or manifest; the web build (`pnpm build` → `dist/`) still does. The app
build goes to `dist-app/` so it never clobbers the web `dist/`.

electron-builder config lives in `package.json` → `build`: appId `io.bloxmine.darkroom`, category
`public.app-category.photography`, `identity: null` (unsigned), only `dist-app/`, `dist-electron/` and
`package.json` are packed (`!node_modules`: everything the renderer needs is bundled by Vite; the main
process has no runtime dependencies).

If your shell has `ELECTRON_RUN_AS_NODE=1` set (some editors built on Electron export it), Electron
starts as plain Node. `electron:dev` strips it; unset it yourself when launching the app binary directly.

## Loading the app: `app://darkroom/`

The built app is served from a custom scheme registered with
`protocol.registerSchemesAsPrivileged({ standard, secure, supportFetchAPI, corsEnabled, stream, codeCache })`
and handled by `protocol.handle('app', …)`:

- `standard` + `secure` gives it a real, stable origin (`app://darkroom`), so localStorage (theme,
  plugin list), IndexedDB (autosave), `fetch`, module Workers, WASM (`application/wasm` → streaming
  compile), WebGL2 and `import()` of Blob URLs (the code-plugin loader) behave exactly as on https.
- Absolute paths keep working: `/icons/…`, `/samples/…`, `/plugins/…` resolve inside `dist-app/`.
- Path traversal is rejected (403); unknown paths with an extension are 404; extension-less paths fall
  back to `index.html`. Files are streamed with explicit MIME types and `Range` support (video seeking).
- Service workers don't run on custom schemes; the electron mode doesn't try to register one.

Why not `file://`? Absolute asset paths would break, `file://` has an opaque origin (storage and
`fetch` quirks) and module scripts/workers are restricted there.

## Window

- `titleBarStyle: 'hiddenInset'`, `trafficLightPosition {x: 14, y: 12}`. On macOS the in-app menu bar is
  not rendered (`App.tsx`), so the toolbar is the top row. `index.html` adds `html.native-mac`
  pre-paint, and `native.css` makes the toolbar 38 px tall, `-webkit-app-region: drag`, with 80 px
  left padding for the traffic lights. Buttons, inputs, menus and dialogs are `no-drag`.
- Size, position and maximized state are saved to `userData/window-state.json` and restored, as long
  as they're still on a connected display.
- `backgroundColor` is the current theme's background (no white flash). It updates on theme changes.
- The title is the document name (`Name.darkroom` once saved). `setRepresentedFilename` is the
  project path, and `setDocumentEdited` shows the unsaved-changes dot.
- `page-title-updated` is ignored; the renderer's `document.title` is for the browser build.

## Native menu (one command table)

`src/ui/commands.ts` is still the single source of truth. `bridge.ts` walks the same `MENUS` layout the
in-app `MenuBar` renders and turns it into a serialisable template (`NativeMenuTemplate`): command ids,
labels, accelerators and enabled/checked state. Dynamic submenus (Node › Add ▸ category ▸ node,
presets) get `dyn:N` ids that map to their closures. Main builds the menu with
`Menu.buildFromTemplate` and adds the standard roles:

- **Darkroom**: About Darkroom (the app's About dialog), Preferences… ⌘, (the app's prefs dialog),
  Services, Hide, Hide Others, Show All, Quit
- **File**: …, Open Recent (`recentDocuments`, `app.addRecentDocument`), Close Window, Save, Save As…
- **Edit**: the app's edit commands; **View**: + Enter Full Screen, Developer Tools
- **Window** (`windowMenu`): Minimize, Zoom, the app's panel toggles, Bring All to Front
- **Help** (`help` role → system search field): Keyboard Shortcuts

Sync: the bridge subscribes to the doc/UI/settings stores, the node registry and focus changes. A
structure change (new nodes, entering a group) rebuilds the menu. Otherwise only changed
enabled/checked flags are sent (`updateMenuState`), so theme radio items and toggles stay checked
correctly. While an app dialog is open, commands are disabled.

Clicks come back as `menuCommand(id, viaAccelerator)` and go through `commands[id].run()`.

**Shortcuts, no double-firing:** only ⌘-combos become native key equivalents. For those,
`commands.ts › handleKeyDown` asks `keyHooks.nativeOwns(id, combo)` and leaves the event alone, so the
native menu runs the command exactly once. Single-key shortcuts (F, B, 1, 0, Tab, Delete…), F1, and
⌘⌫ / ⌘↩ (which also edit text) stay with the renderer and aren't shown in the native menu.

**Text fields:** Undo/Redo/Cut/Copy/Select All/Delete act on the focused text field (`webContents.undo()`
etc.) instead of the graph. Paste always goes through `webContents.paste()`, so text fields get text
and the graph gets the DOM `paste` event the app already handles (images → Image nodes, copied nodes).
While typing, other ⌘-shortcuts that would edit the graph are ignored (as in the browser). File
commands and Preferences still work.

## File handling

`src/store/io.ts` keeps its browser code and branches with `if (native) …` in: Open Project, Save
Project, Save Project As… (new `file.saveAs` command, ⌘⇧S; in the browser it's the same as Save),
Import Image (native multi-select dialog; files go into the same `importImageFiles()` the browser
uses, as `File` objects with the right MIME type, so RAW decoding applies unchanged), Export Image, and
New Project (forgets the path).

The current project path is kept in `useDocFile` (`src/native/files.ts`, persisted in localStorage
next to the autosave). Save overwrites it in place (atomic write: temp file + rename).

**Finder:** `open-file` is handled from process start (before `ready`), so double-clicking a file,
Open With, Open Recent and dropping files on the Dock icon all work. Main queues the paths until the
renderer says `ready()` (after boot), then reads them and sends `openFiles`. `.darkroom`/`.json` open
as projects; images and RAW are imported as Image/RAW nodes. Single-instance lock: a second launch
focuses the first window and passes its file arguments along.

**File associations** (`package.json` → `build.fileAssociations`): `.darkroom` (Darkroom Project,
role Editor, Owner, exported UTI `io.bloxmine.darkroom.project`), images jpg/jpeg/png/webp/heic/heif/
tif/tiff and RAW dng/cr2/cr3/nef/arw/raf/orf/rw2 (role Viewer, Alternate).

## Theme

`settings.ts` has `pref: 'auto' | 'classic' | 'aperture' | 'aqua'` (default `auto`) and the
resolved `theme`. Auto follows `prefers-color-scheme` live. In Electron, `prefers-color-scheme` follows
`nativeTheme.themeSource`. Main maps the preference: auto → `system`, aperture → `dark`,
aqua/classic → `light`. Native menus, dialogs, sheets and the traffic-light chrome then match the app
theme. Main changes `themeSource` only when the preference changes, and remembers it for the next
launch's window background.

## IPC surface (`window.darkroomNative`)

| Member | Kind | Notes |
|---|---|---|
| `platform`, `versions` | values | `versions.app` via one `sendSync` at preload time |
| `openProject()` | invoke | open dialog → `{path, name, text}` or null |
| `saveProject(text, {path, suggestedName, saveAs})` | invoke | overwrite in place **only** if `path` was granted (see below), else save dialog |
| `openImages()` | invoke | multi-select dialog → `[{path, name, data: Uint8Array}]` |
| `saveFile(data, {suggestedName, filters})` | invoke | save dialog + write (export) |
| `setDocument({title, path, edited})` | send | title, represented file, edited dot |
| `setTheme(pref, resolved)` | send | nativeTheme.themeSource + window background |
| `setMenu(template, state)` / `updateMenuState(state)` | send | native menu |
| `editRole(role)` | send | undo/redo/cut/copy/paste/selectAll/delete on the focused webContents (whitelisted) |
| `onMenuCommand(cb)` | event | `(id, viaAccelerator)` |
| `onOpenFiles(cb)` | event | Finder / Dock / Open Recent files |
| `ready()` | send | renderer booted, flush queued files |

## Security choices

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`. The preload
  exposes only the functions above, with no raw `ipcRenderer`, `fs` or `shell`.
- The renderer can't read or write arbitrary paths. Reads only happen for files the user picked in a
  native dialog or handed over via Finder. Writes without a dialog only go to project files the user
  opened or saved through a dialog/Finder before ("granted" paths, remembered in `window-state.json`).
  Any other path from the renderer gets a save dialog.
- Navigation away from `app://darkroom` (or the dev server) is blocked. `http(s)` links (About box
  credits) open in the default browser, and `window.open` is denied.
- Permissions: only `media` (webcam nodes), clipboard read/sanitized-write, fullscreen and pointer
  lock are granted. `Info.plist` carries `NSCameraUsageDescription` / `NSMicrophoneUsageDescription`.
- Menu roles from the renderer are whitelisted in main.

## Tests

The packaged app can be driven with Playwright's `_electron.launch({ executablePath:
'release/mac-arm64/Darkroom.app/Contents/MacOS/Darkroom', colorScheme: null })`. `colorScheme: null` is
needed, or Playwright forces `prefers-color-scheme: light`. Test hooks in main:

- `DARKROOM_TEST_DIALOG_PATH=<path>[:<path>…]` answers every open/save dialog without showing it.
  It's read on each call, so a test can change it with `electronApp.evaluate(() => process.env.… = …)`.
- `DARKROOM_USER_DATA=<dir>` isolates userData (window state, localStorage, autosave).

## Known gaps

- Not code-signed or notarized (`identity: null`): Gatekeeper needs right-click → Open the first time.
  To ship properly, set a Developer ID identity, `hardenedRuntime: true` with entitlements, and add
  `notarize`.
- No auto-update (electron-updater isn't wired up).
- Closing the window doesn't ask about unsaved changes. The project is autosaved and restored on next
  launch, as in the browser.
- Only the macOS build is configured. The shell is mostly platform-neutral, but Windows/Linux targets,
  their menu-bar handling (the in-app menu bar is hidden only on macOS) and icons aren't set up.
- Single-key shortcuts aren't shown next to native menu items (macOS would treat them as global key
  equivalents and steal them from text fields). Help → Keyboard Shortcuts lists them.
