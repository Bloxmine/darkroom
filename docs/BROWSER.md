# File browser (Browse workspace)

Darkroom has an Adobe Bridge–style file browser. Switch to it with the workspace switcher in the
toolbar (**Browse**, **Filmstrip**, or any workspace you build from the browser panels) or
**Window › Workspace**. Every panel can also be opened on its own from the **Window** menu and docked
anywhere, next to the editor's panels.

| Panel | What it does |
| --- | --- |
| **Folders** | A lazy tree of the folders Darkroom may access. Drop thumbnails on a folder to move them (<kbd>⌥</kbd> copies). |
| **Favorites** | Favourite folders, the default locations (Pictures, Desktop, Downloads in the Mac app), **Add Folder…** and **Recent Folders**. |
| **Content** | The current folder or collection as thumbnails, a details list or a filmstrip (buttons at the bottom right), with a thumbnail size slider. Back / forward / up, refresh, new folder and **Sort by** in the panel header. |
| **Preview** | A large preview of the selection; scroll or double-click to zoom, drag to pan. Select 2–4 items to compare them side by side. |
| **Metadata** | File Properties, IPTC Core (editable: title, description, keywords, creator, copyright), Camera Data (EXIF) and GPS with an OpenStreetMap link. |
| **Keywords** | A hierarchical keyword list; tick a keyword to apply it to the selection. Add / rename / delete keywords from the buttons or the right-click menu. |
| **Filter** | Facets with counts, like Bridge's: Ratings, Labels, File Type, Keywords, Date Created, Camera, Lens, ISO, Focal Length, Orientation. Values are OR-ed within a facet and AND-ed across facets; the counts always say how many items a tick would show. |
| **Collections** | Saved sets of files (drag thumbnails onto a collection) and Smart Collections (a folder plus a Filter selection). |
| **Filmstrip** | A horizontal strip of the Content items, synced with the selection. |

The status bar shows the item and selection counts while a browser panel has focus.

## Supported files

JPEG, PNG, WebP, GIF, AVIF, BMP, HEIC/HEIF, TIFF; camera RAW (DNG, CR2, CR3, NEF, ARW, RAF, ORF, RW2,
PEF, SRW and the other LibRaw formats); video (MP4, MOV, M4V, WebM, MKV) with a poster frame; and
`.darkroom` projects, whose thumbnail is a small preview saved at the start of the file (projects saved
by this version carry one).

## Keyboard (Content, Filmstrip, Preview)

| Key | Action |
| --- | --- |
| Arrows | Move the selection (<kbd>Shift</kbd> extends) |
| Click / <kbd>Shift</kbd>-click / <kbd>⌘</kbd>-click | Select / range / toggle |
| <kbd>0</kbd>–<kbd>5</kbd> | Rating (0 removes it) |
| <kbd>⌥⌫</kbd> | Reject |
| <kbd>6</kbd> <kbd>7</kbd> <kbd>8</kbd> <kbd>9</kbd> | Labels Select (red), Second (yellow), Approved (green), Review (blue); again removes it. To Do (purple) is in the Label menu |
| <kbd>Space</kbd> | Full-screen Review (← → step, keys above work, scroll / double-click zoom, <kbd>Esc</kbd> closes) |
| <kbd>Enter</kbd> / <kbd>⌘↓</kbd> / double-click | Open in Darkroom (folders: open the folder) |
| <kbd>⌘↑</kbd>, <kbd>⌘[</kbd>, <kbd>⌘]</kbd> | Parent folder, back, forward |
| <kbd>F2</kbd> | Rename |
| <kbd>⌘⇧R</kbd> | Batch Rename |
| <kbd>⌫</kbd> / <kbd>Delete</kbd> | Move to Trash (after a confirmation) |
| <kbd>⌘A</kbd> | Select all |
| <kbd>F5</kbd> | Refresh |

These keys only act while a browser panel has focus, so the editor's single-key shortcuts are not
affected. The **Label** menu has the same rating, label and file commands.

## Opening files in the editor

- **Open in Darkroom** (<kbd>Enter</kbd>, double-click, or drag a thumbnail onto the **viewer**) replaces
  the graph's source image, keeping the rest of the graph, like sharing a photo to Darkroom: a RAW file
  becomes a **RAW Photo** node, a video a **Video** node. A `.darkroom` file opens as the project. The
  window then switches to the Essentials workspace.
- **Open as New Project** starts from the starter graph with the file as its source.
- **Add to Graph**, or dragging thumbnails onto the **node graph**, adds Image / RAW / Video nodes where
  you drop them.
- **Batch Process…** opens *File › Batch Process* with the selected files.

## Ratings, labels and keywords: XMP sidecars

Darkroom never writes into image files. Ratings, labels, keywords and the IPTC fields are written to an
XMP sidecar next to the file, the Adobe convention that Bridge, Lightroom, Capture One and darktable
read:

| Property | Written as |
| --- | --- |
| Rating | `xmp:Rating` (1–5, −1 = Reject; no rating = absent) |
| Label | `xmp:Label` with Bridge's label names: `Select`, `Second`, `Approved`, `Review`, `To Do` (Lightroom's `Red`, `Yellow`… are read as the same colours) |
| Keywords | `dc:subject` (rdf:Bag, every level), plus `lr:hierarchicalSubject` (`Places\|Paris`) for hierarchical keywords |
| Title, Description, Copyright | `dc:title`, `dc:description`, `dc:rights` (rdf:Alt, `x-default`) |
| Creator | `dc:creator` (rdf:Seq) |
| — | `xmp:MetadataDate` is updated on every write |

- The sidecar of `IMG_0001.CR2` is `IMG_0001.xmp`. When a RAW and a JPEG share a name (RAW+JPEG), the
  RAW keeps `IMG_0001.xmp` and the JPEG gets `IMG_0001.JPG.xmp`, so rating one never rates the other.
- An existing sidecar is updated in place: only the properties above are replaced; Camera Raw settings,
  history and everything else stay as they were.
- Existing sidecars (Bridge's element form and Lightroom's attribute form) and the XMP embedded in
  JPEG/TIFF/DNG files are read; the sidecar wins. IPTC-IIM fields are used when there is no XMP.
- Renaming, moving and trashing a file takes its sidecar along.

## Batch Rename

**Label › Batch Rename…** (<kbd>⌘⇧R</kbd>) builds new names from parts: text, the current filename
(keep / lower / upper case), a sequence number (start, digits), a sequence letter, a date (date taken
from EXIF, created or modified; formats like `YYYYMMDD`, `YYYY-MM-DD_hhmmss`), metadata (camera,
lens, ISO, focal length, aperture, shutter, size, rating, label) and the folder name. The extension is
kept (optionally lower- or upper-cased). The preview lists every old → new name and flags conflicts: two
files getting the same name (case-insensitive, like the Mac file system), a name that already exists in
the folder, or an empty name. Nothing is renamed while there are conflicts. The rename is done in two
phases (to temporary names, then to the targets) so swaps and rotations work, and it never overwrites a
file.

## The Mac app and the browser build

### Mac app (Electron)

The renderer never gets general file-system access. `window.darkroomNative.files` (see
`src/native/api.ts › FilesApi`, implemented in `electron/files/ipc.ts`) takes paths, and main checks
every one of them (`electron/files/guard.ts`): the path is resolved with `realpath` (symlinks followed,
`..` collapsed) and must be inside a root the user granted —

- a folder picked with **Add Folder…** (a native folder dialog),
- the folder of a file opened from Finder (double-click, Open With, Dock),
- the defaults `~/Pictures`, `~/Desktop` and `~/Downloads` (macOS may ask for permission the first time).

Granted folders are remembered in `file-roots.json` in the app's data folder; removing a location from
Favorites revokes it. Writes are limited to XMP sidecars, renames / moves / copies that never overwrite,
new folders, and `shell.trashItem` (the Trash). Main also provides:

- **Thumbnails** through macOS QuickLook (`nativeImage.createThumbnailFromPath`: JPEG, PNG, HEIC, TIFF,
  most RAWs, video poster frames), cached in `~/Library/Caches/darkroom-thumbs` keyed by path, modified
  time, size and thumbnail size. When QuickLook can't make one, the renderer decodes the file (embedded
  JPEG preview for RAW files).
- **Metadata** read with [exifr](https://github.com/MikeKovarik/exifr) in main, reading only the first
  chunks of each file. RAW formats exifr can't read (CR3, RAF…) fall back to LibRaw's metadata when the
  file is selected.
- **Reveal in Finder**, **Open with Default App**, and **watching** the open folder (`fs.watch`,
  debounced) so the Content panel refreshes when files change on disk.

### Browser / PWA

In Chrome, Edge, Arc and Opera the browser uses the **File System Access API**: **Add Folder…** shows
the browser's folder picker, the folder is remembered (its handle is kept in IndexedDB), and on the next
visit a click on it re-grants access. Thumbnails are made in the page (embedded previews for RAW, HEIC
and TIFF) and cached in IndexedDB. Sidecars are written next to the files when the browser grants write
access; otherwise they are kept in IndexedDB. Rename and move need `FileSystemHandle.move()` (recent
Chromium). A web page can't move files to the Trash, reveal them in Finder or open them in another app:
those commands are disabled with a tooltip saying so.

Safari and Firefox don't have the API. The Content panel says so and offers **Open Files…**: the picked
files can be browsed, previewed, rated, filtered and opened, with their metadata kept in this browser.

## Performance

The Content grid, details list and filmstrip are virtualised: only the cells on screen exist.
Thumbnails are generated in the background with a concurrency limit (6 in the Mac app, 4 in the
browser), newest request first, and requests for cells that scroll away are dropped. Metadata is read
in background chunks after the folder is listed; the Filter panel fills in as it arrives (it shows how
many files are left). Folders with thousands of photos stay responsive.

## Code map

| Path | |
| --- | --- |
| `src/core/files/` | Backend interface (`backend.ts`), Electron and web backends, XMP read/write (`xmp.ts`), sidecar naming, EXIF summary, facets, batch-rename patterns, thumbnail queue / cache |
| `electron/files/` | IPC handlers and the path guard |
| `src/ui/browser/` | Panels (registered in `index.ts` with the workspace system), actions, store, dialogs |
| `src/store/projectPreview.ts` | Keeps a small output JPEG that `serializeProject` saves as the project's `preview` |

Errors are logged as `[darkroom files] …` and appear in **Window › Diagnostics**.

## Known limits

- Bridge's own label names are fixed (Bridge lets you rename them in its preferences).
- Copying folders (Mac app) and moving to the Trash (browser) aren't supported.
- No marquee (drag-rectangle) selection in the Content panel.
- Smart Collections search one folder (not subfolders or several locations).
