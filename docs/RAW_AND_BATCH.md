# RAW photos, batch processing and sharing

## RAW Photo node (`core.raw`)

Darkroom opens camera RAW files with [LibRaw](https://www.libraw.org), compiled to WebAssembly
([libraw-wasm](https://github.com/ybouane/LibRaw-Wasm)). LibRaw runs in a Web Worker, so the editor
stays responsive while a file decodes.

**Formats:** DNG, CR2, CR3, CRW, NEF, NRW, ARW, SRF, SR2, RAF, ORF, RW2, RWL, PEF, SRW, X3F, 3FR, FFF,
IIQ, MOS, MRW, ERF, KDC, DCR, MEF, GPR, RAW. The list is in `src/core/raw/formats.ts`, and LibRaw
supports more cameras than this list names. Tested: Canon DNG (CHDK), Nikon NEF, Olympus ORF, Sony ARW
and Panasonic RW2.

**Importing.** Use any of the usual import paths. Each one recognises RAW extensions and MIME types and
creates a **RAW Photo** node in place of an **Image** node:

- *File › Import Image…*
- drag and drop onto the node graph
- paste
- the share sheet or "Open with…" (see below)
- *Browse…* on the node

A file LibRaw can't read gives an error in the status bar, and no node is created.

### Parameters

| Param | Values | Re-decodes? |
|---|---|---|
| `asset` | the RAW file | yes |
| `whiteBalance` | `as shot` (camera), `auto` (grey world), `daylight` (camera daylight multipliers), `custom` | yes (custom shares the daylight decode) |
| `temperature`, `tint` | 2000–12000 K, −100…100. Used when WB = custom | no (GPU) |
| `exposure` | −5…+5 EV, applied in linear light | no (GPU) |
| `highlights` | `clip`, `unclip`, `blend`, `rebuild` (LibRaw `-H 0/1/2/5`) | yes |
| `output` | `16-bit linear` (Float32 → RGBA16F texture) or `8-bit sRGB` (4× less memory) | yes |
| `demosaic` | AHD (default), DHT, AAHD, DCB, PPG, VNG, Linear. Used only by full-size decodes | yes |
| `denoise` | FBDD noise reduction: off / light / full | yes |
| `fastPreview` | on: decode at half size when the preview renders at ≤ 50 % | – |

The node decodes linear 16-bit sRGB-primaries data with LibRaw's auto-brightening off, so the
`exposure` parameter gives the same result on every file. The shader then applies exposure and custom
white balance in linear light and encodes the result to the engine's display-referred sRGB. Values
above 1.0 survive into the RGBA16F graph. The camera's orientation tag is applied.

**Preview and export.** The engine passes its render scale to `cpu()`. At a scale of 0.5 or less, the
node asks LibRaw for a `half_size` decode. That is 2×2 binning with no demosaic, so it is about 4×
faster. Export renders at scale 1, which means a full decode with the selected demosaic. Export waits
for the decode to finish, through `renderReady()` in `src/core/batch/ready.ts`.

**Caching.** Decodes are cached in memory per asset and decode parameters, up to about 768 MB, and the
most recent decode is always kept. Changing exposure or temperature/tint never re-decodes. The LibRaw
worker shuts down after 60 s idle, because its WASM heap never shrinks.

**Metadata.** The Properties panel shows camera, lens, ISO, shutter, aperture, focal length, sensor size
and capture time under the parameters.

### Storage

A RAW file is 20–60 MB, too large to keep in the project as a data URL. Its original bytes go to
IndexedDB instead: database `darkroom-raw`, store `files`, keyed by asset id. The project's asset entry
holds the reference `idb:raw/<assetId>`, which keeps autosaves small. RAW files the open project no
longer references are deleted a few seconds after the next project load.

*File › Save Project* embeds each RAW as a data URL, so `.darkroom` files are self-contained. The
status bar warns when a save embeds more than 25 MB. When a project with embedded RAWs is opened, the
bytes move back into IndexedDB.

## Batch processing

*File › Batch Process…* (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd>) runs the current graph over
many photos:

1. **Files.** Use *Add files…*, *Add folder…* (`webkitdirectory`), or drop files or folders onto the
   list. Images and RAWs can be mixed. Other files are skipped.
2. **Batch input.** This is the Image or RAW node that receives each file. It defaults to the first
   one feeding the Output. If the node's type doesn't match a file (for example a RAW file into an
   Image node), it switches type for that file. A RAW node keeps its develop settings for RAW files.
3. **Format.** PNG, JPEG or WebP, with a quality setting.
4. **Size.** 100 %, or a maximum long edge in px. It never upscales.
5. **File names.** The default pattern is `{name}_{preset}`. Tokens:
   - `{name}`: source name without its extension
   - `{preset}`: the first preset/group feeding the Output, else the project name
   - `{n}` / `{n:3}`: index, optionally zero-padded
   - `{date}`: run date
   - `{w}` / `{h}`: output size
   - `{ext}`: source extension

   Names are sanitised and made unique.
6. **Save to.** A **ZIP download**, streamed with fflate, or a **folder**. The folder option uses the
   File System Access API (`showDirectoryPicker`, Chrome and Edge only).

The batch never touches your document or undo history. Each file is swapped into a **cloned** graph
and rendered at full resolution by a **separate offscreen Engine**, with its own WebGL2 context on an
`OffscreenCanvas`, so the viewer's cache stays intact. If no second context is available, the batch
falls back to the viewer engine. After each file, the batch releases that file's asset, RAW decode and
textures. Each finished result is added to the ZIP stream right away. The dialog shows a progress bar,
a thumbnail strip, an ETA and a Cancel button. A file that fails is listed with its error, and the
batch carries on with the next file.

Code: `src/store/batch.ts` (runner), `src/ui/BatchDialog.tsx`, `src/core/batch/*` (pure helpers, tested
in `batch.test.ts`).

## Share target and file handlers (PWA)

The installed app registers two entry points in its web manifest (`vite.config.ts`):

- **`share_target`**: `POST /share-target`, `multipart/form-data`, field `files`. It accepts
  `image/*`, the RAW MIME types and extensions, and `.darkroom`. `public/share-target-sw.js` handles
  the POST. Workbox loads that script through `workbox.importScripts`, so it runs before Workbox's
  routes. The script stores the files in Cache Storage (`darkroom-share-target`) and redirects to
  `/?share-target=<n>`.
- **`file_handlers`**: lets the OS open `.darkroom` projects, images and RAW files with Darkroom.
  The app receives them through `window.launchQueue`. `launch_handler` reuses an open window.

At startup, `src/store/launch.ts` (`initLaunch`, called from `main.tsx`) picks the files up, removes
them from the cache, and routes them through `handleIncomingFiles()`:

- A `.darkroom` file opens as the project.
- **One photo** is imported into the current graph as an Image or RAW node. It takes over the current
  input node's connections and position, so with the starter project you get *photo → VHS → Output*.
  The old input node is removed, and Undo brings it back.
- **Several photos** open the Batch dialog with the files already listed.

Every import, including Electron's native "open file", goes through `importImageFiles()` in
`src/store/io.ts`.

The LibRaw WASM (1.4 MB) isn't precached. A runtime `CacheFirst` route (`libraw-wasm`) stores it the
first time a RAW is opened, and RAW decoding works offline after that.

## Known limitations

- Exposure and WB are applied after LibRaw's 16-bit output, so data clipped at the sensor's white
  level can't be recovered by negative exposure. Use `highlights = blend/rebuild` for that.
- Custom temperature/tint is a correction relative to the camera's daylight multipliers, applied as
  gains in linear sRGB. It is not LibRaw's per-camera matrix maths.
- Full-resolution `16-bit linear` decodes need 16 bytes per pixel on the CPU (about 380 MB for 24 MP)
  before upload. For very large files on low-memory devices, use `8-bit sRGB`.
- The RAW cleanup after a project load assumes one Darkroom tab. If two tabs hold different
  projects, RAWs from the other tab can be deleted.
- `launchQueue` and the share sheet only exist in an installed PWA, in Chromium browsers.
