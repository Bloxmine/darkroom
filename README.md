<p align="center">
  <img src="docs/media/banner.png" alt="Darkroom — a node-based, shader-based image editor" width="100%">
</p>

<p align="center">
  <b>Wire up GPU shader nodes to make any photo look like it came from a 2002 digicam, a disposable camera, a VHS tape, a risograph — or something stranger.</b>
</p>

<p align="center">
  <a href="#getting-started">Getting started</a> ·
  <a href="#preset-gallery">Gallery</a> ·
  <a href="#nodes">Nodes</a> ·
  <a href="#custom-nodes--plugins">Custom nodes & plugins</a> ·
  <a href="docs/NODE_AUTHORING.md">Node authoring guide</a>
</p>

---

<p align="center">
  <img src="docs/media/screenshots/theme-aperture.png" alt="Darkroom in the Aperture theme: a risograph preset wired between Clarity and Vignette nodes" width="100%">
</p>

Darkroom is a non-destructive, node-based image editor that runs entirely in the browser. Every node is a
WebGL2 fragment shader. You chain them into a graph, tweak parameters, and see the result live. Groups of
nodes become reusable **presets**: "2002 Digicam (1.3 MP CCD)" is not a LUT, it is a chain of sensor
resolution, CCD clipping, smear, purple fringing, in-camera sharpening and a real 8×8 DCT JPEG round
trip. You can open any preset and take it apart.

## Features

- **Node graph editor.** Typed sockets, quick-add (<kbd>Tab</kbd>), drag-and-drop images, copy/paste,
  undo/redo, bypass, groups/subgraphs with exposed parameters, and a breadcrumb into nested groups.
- **Live node thumbnails.** Every node shows a small preview of its output, including side branches
  that don't reach the output. Click a thumbnail to view that node. Toggle with *View › Node Thumbnails*.
- **GPU engine.** WebGL2 with RGBA16F buffers, multi-pass nodes, CPU steps for text/LUTs/histograms,
  and per-node caching, so only what changed re-renders. The preview renders at screen resolution and
  export at full resolution, with scale-aware shaders so both look the same.
- **About 160 nodes** across Input, Color, Filter, Distort, Transform, Mask, Composite, Math, Stylize,
  Analog, Print, Process, Artistic, Optical, Retro and AI.
- **30 presets** emulating cameras, video formats, print processes and 19th-century photography, plus
  AI-driven looks such as portrait bokeh and real-depth tilt-shift.
- **Custom nodes.** A **GLSL Shader** node for quick one-offs, and a **Node Builder** that turns
  annotated GLSL (`// @param min=0 max=2`) into a reusable node type with sliders. Custom types are
  embedded in project files, so shared projects keep working.
- **Plugins.** Safe JSON shader packs, and JavaScript plugins (behind a trust prompt) with access to
  CPU steps and the preset builder. Managed in a Plugin Manager.
- **In-browser AI.** A Depth Map (Depth Anything V2) and a Subject Mask (MODNet / U²-Net-p), run
  locally with ONNX Runtime Web (WebGPU, or WASM on the CPU). They drive a depth-aware tilt-shift,
  real 3D anaglyphs, depth fog and portrait bokeh. Models download once and then work offline. See
  [docs/AI.md](docs/AI.md).
- **Click to select, scene segmentation and relighting.** Select a node with a viewer tool and work
  in the viewer: click objects to select them (Segment Anything: SlimSAM), paint masks with a brush,
  or drag a light. Scene Segmentation (DETR panoptic) finds sky, people, vegetation, water, buildings…
  for sky swaps.
- **AI relighting with shadows.** Surface Normals (MoGe-2) estimates the shape of faces and objects;
  Relight then removes much of the existing light and adds up to three point, spot or directional lights
  with soft area-light shadows, contact shadows and ambient occlusion. Drag the lights in the viewer in
  real time. Presets: *Studio Portrait Light*, *Rim Light*, *Golden Hour*, *Overhead Noon*, *Neon
  Two-Tone*, *Candlelight* and *Dramatic Relight*. Why there is no diffusion relighter (IC-Light) yet:
  [docs/AI.md](docs/AI.md#relighting).
- **AI restoration and creative filters.** Upscale 2×/4× (Real-ESRGAN, tiled), Remove Object (LaMa
  inpainting, from any mask), Colorize B&W (DDColor), Neural Style (fast neural style), Low-Light
  Enhance (Zero-DCE) and AI Line Art (Informative Drawings), plus presets such as *Restore Old Photo*
  (scratch removal → colorize → upscale) and *Night Rescue*. All run locally; see [docs/AI.md](docs/AI.md).
- **AI denoise and sky replacement.** AI Denoise (SCUNet, tiled, separate luma/colour amounts and detail
  recovery) cleans high-ISO noise. Sky Mask (a dedicated sky network plus guided-filter matting for
  branches and hair) also gives a horizon gradient for graduated filters. Sky Replace swaps in any image
  or a procedural sunset, blue, overcast, night or stormy sky, relights the foreground and defringes edges.
- **AI for people.** Face Detection & Landmarks (478-point mesh: face, skin, eye, lip and brow masks,
  even for the small faces of group photos), Face Restoration (RestoreFormer++ or GFPGAN), Pose / Body
  (skeleton, person, hair, skin and clothes masks) and Smart Auto-Crop (keeps faces whole, with
  headroom and rule-of-thirds placement), plus *Beauty Retouch*, *Hair Recolor*, *Restore Portrait*,
  *Motion Capture* and *Instagram Crop 4:5* presets. Runs locally; see [docs/AI.md](docs/AI.md).
  Presets: *Sunset Sky*, *Dramatic Sky*, *Clean High ISO*, *Graduated Filter*.
- **Themes that follow your system.** *Auto* (the default) uses *Aperture* (dark graphite Aqua) in
  Dark Mode and *Aqua* (light Leopard) in Light Mode. *Classic* (a 2000s Windows pro tool) is also available.
- **Snow Leopard–style Preferences** (<kbd>⌘</kbd>+<kbd>,</kbd>) with eight panes: General, Appearance,
  Viewer, Performance (GPU info), Export (filename patterns), Plugins & AI (model cache), Keyboard
  (rebindable shortcuts) and Advanced (import/export settings).
- **Native Mac app.** A standalone Electron build with a native menu bar, native dialogs, Finder file
  associations and Open Recent. See [Mac app](#mac-app).
- **Pro viewer.** Zoom/pan, pixel-exact zoom above 100%, A/B split compare against the source, and
  false-colour/gamut/histogram nodes for checking exposure.
- **Projects.** `.darkroom` files with embedded images and custom nodes. Autosaves to IndexedDB. Exports
  PNG, JPEG or WebP at full resolution.
- **Camera RAW.** DNG, CR2, CR3, NEF, ARW, RAF, ORF, RW2, PEF, SRW and more, developed with LibRaw
  (WebAssembly, in a worker) by a **RAW Photo** node: white balance, exposure, highlight recovery,
  demosaic and noise reduction, with the full 16-bit data on the GPU. See
  [docs/RAW_AND_BATCH.md](docs/RAW_AND_BATCH.md).
- **Batch processing.** *File › Batch Process…* runs the current graph over many photos or a folder
  and saves a ZIP or writes into a folder, with progress, ETA and per-file errors.
- **Video.** Drop an MP4/WebM/MOV onto the graph for a **Video** node (frame-accurate WebCodecs
  decoding, trim/speed/loop), or add a live **Webcam** node. A timeline bar under the viewer plays,
  scrubs and steps frames (<kbd>Space</kbd>, <kbd>←</kbd>/<kbd>→</kbd>); grain, VHS noise, glitch and
  gate weave move every frame, even on a still photo (*Playback › Animate*). *File › Export Video…*
  renders offline to MP4 (H.264) or WebM (VP9) with optional audio passthrough. Still exports are
  unchanged. See [docs/VIDEO.md](docs/VIDEO.md).
- **Installable PWA.** Works offline once loaded. Share photos to Darkroom from the OS share sheet,
  or use it to open `.darkroom`, image and RAW files.

## Preset gallery

All renders below come straight from the built-in presets at default settings.

| | | |
|:-:|:-:|:-:|
| <img src="docs/media/presets/camera.ccd2002.jpg" width="260"><br>**2002 Digicam (1.3 MP CCD)** | <img src="docs/media/presets/camera.disposable.jpg" width="260"><br>**Disposable Film Camera** | <img src="docs/media/presets/video.vhs.jpg" width="260"><br>**VHS Camcorder** |
| <img src="docs/media/presets/print.risoZine.jpg" width="260"><br>**Riso Zine (2-colour)** | <img src="docs/media/presets/print.riso3.jpg" width="260"><br>**Riso 3-Colour** | <img src="docs/media/presets/print.screenprint.jpg" width="260"><br>**Screenprint** |
| <img src="docs/media/presets/process.tintype.jpg" width="260"><br>**Tintype (wet plate)** | <img src="docs/media/presets/process.cyanotype.jpg" width="260"><br>**Cyanotype** | <img src="docs/media/presets/process.aerochrome.jpg" width="260"><br>**Aerochrome Infrared** |
| <img src="docs/media/presets/camera.polaroid.jpg" width="260"><br>**Instant Film** | <img src="docs/media/presets/camera.lomo.jpg" width="260"><br>**Toy Camera (Lomo)** | <img src="docs/media/presets/video.super8.jpg" width="260"><br>**Super 8** |
| <img src="docs/media/presets/fun.gameboy.jpg" width="260"><br>**Game Boy Camera** | <img src="docs/media/presets/fun.macPaint.jpg" width="260"><br>**MacPaint (Atkinson dither)** | <img src="docs/media/presets/fun.pico8.jpg" width="260"><br>**PICO-8** |
| <img src="docs/media/presets/fun.crt.jpg" width="260"><br>**CRT Monitor** | <img src="docs/media/presets/art.asciiTerminal.jpg" width="260"><br>**ASCII Terminal** | <img src="docs/media/presets/fun.glitch.jpg" width="260"><br>**Glitch** |
| <img src="docs/media/presets/art.oilPainting.jpg" width="260"><br>**Oil Painting (Kuwahara)** | <img src="docs/media/presets/print.photocopy.jpg" width="260"><br>**Photocopy Zine** | <img src="docs/media/presets/print.newspaper.jpg" width="260"><br>**Newspaper Halftone** |
| <img src="docs/media/presets/fun.thermal.jpg" width="260"><br>**Thermal Camera** | <img src="docs/media/presets/fun.miniature.jpg" width="260"><br>**Miniature (tilt-shift)** | <img src="docs/media/presets/camera.webcam2005.jpg" width="260"><br>**2005 Webcam** |

<details>
<summary>Original sample photos</summary>

| | | |
|:-:|:-:|:-:|
| <img src="docs/media/presets/orig_street.jpg" width="260"> | <img src="docs/media/presets/orig_portrait.jpg" width="260"> | <img src="docs/media/presets/orig_landscape.jpg" width="260"> |

</details>

## Themes

| Classic | Aperture | Aqua |
|:-:|:-:|:-:|
| <img src="docs/media/screenshots/theme-classic.png" width="300"> | <img src="docs/media/screenshots/theme-aperture.png" width="300"> | <img src="docs/media/screenshots/theme-aqua.png" width="300"> |

<p align="center"><img src="docs/media/screenshots/preferences.png" alt="Snow Leopard-style Preferences window, Appearance pane" width="80%"></p>

Switch themes under **View → Theme** or in **Edit → Preferences…** (<kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>,</kbd>).
The default, **Auto (match system)**, uses Aperture when the system is in Dark Mode and Aqua in Light
Mode, and switches live when the system appearance changes. The choice is remembered.

## Getting started

Requirements: Node 20+ and [pnpm](https://pnpm.io). The browser needs WebGL2 with
`EXT_color_buffer_float`. Darkroom is developed and tested in Chromium-based browsers (Chrome, Edge,
Arc); Safari and Firefox should work but are less tested.

```bash
git clone https://github.com/Bloxmine/darkroom.git
cd darkroom
pnpm install
pnpm dev          # http://localhost:5173
```

```bash
pnpm build        # production build in dist/ (includes the service worker)
pnpm preview      # serve the build locally; install it as an app from the address bar
pnpm test         # unit tests (vitest)
pnpm typecheck
```

On first launch Darkroom opens a starter project: a sample photo → *VHS Camcorder* → Output. Drop your
own photo onto the node graph, swap the preset from the **Node Library**, and export with
<kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>E</kbd>.

### Basics

| Action | How |
|---|---|
| Add a node or preset | <kbd>Tab</kbd> or right-click on the graph, or drag from the library |
| Connect | Drag from an output socket to an input. Drop on empty space to add and connect a node |
| View a node's output | Select it and press <kbd>1</kbd> |
| Bypass | <kbd>B</kbd> |
| Group / ungroup | <kbd>Ctrl</kbd>+<kbd>G</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd> |
| Enter / leave a group | <kbd>Ctrl</kbd>+<kbd>Enter</kbd> / <kbd>Ctrl</kbd>+<kbd>Backspace</kbd> |
| Expose a parameter on its group | Right-click the parameter → *Expose on Group* |
| Compare with the original | Viewer toolbar → A/B split |
| Save / open / export | <kbd>Ctrl</kbd>+<kbd>S</kbd> / <kbd>Ctrl</kbd>+<kbd>O</kbd> / <kbd>Ctrl</kbd>+<kbd>E</kbd> |

On macOS, <kbd>⌘</kbd> works wherever <kbd>Ctrl</kbd> is listed. Help → Keyboard Shortcuts has the full list.

## Mac app

| Dark Mode | Light Mode |
|:-:|:-:|
| <img src="docs/media/screenshots/mac-app-dark.png" width="420"> | <img src="docs/media/screenshots/mac-app-light.png" width="420"> |

Darkroom also ships as a standalone macOS app (Electron): native menu bar, native open/save dialogs,
real files on disk (Save overwrites in place, Save As…, Open Recent), the window title shows the
document with the unsaved-changes dot, and `.darkroom` projects and images (JPEG/PNG/WebP/HEIC/TIFF and
camera RAW) open from Finder or by dropping them on the Dock icon. It follows the system light/dark
appearance like the web version, and works fully offline.

**Requirements:** macOS 13 Ventura or later, on Apple silicon or Intel. The download is one universal
app that runs natively on both.

**Install:** open `Darkroom-<version>-universal.dmg` and drag Darkroom to Applications. The app is not
signed or notarized, so the first time macOS Gatekeeper will refuse to open it. **Right-click (or
Control-click) Darkroom in Applications → Open → Open.** After that it opens normally. (On recent
macOS versions you may instead need *System Settings → Privacy & Security → Open Anyway*. Or remove
the quarantine flag with `xattr -dr com.apple.quarantine /Applications/Darkroom.app`.)

**Build it yourself** (on a Mac, either architecture):

```bash
pnpm install
pnpm electron:build         # universal (arm64 + x86_64) → release/Darkroom-<version>-universal.dmg/.zip
pnpm electron:build:arm64   # Apple silicon only → release/Darkroom-<version>-arm64.dmg/.zip
pnpm electron:build:x64     # Intel only → release/Darkroom-<version>-x64.dmg/.zip
pnpm electron:dev           # Vite dev server + Electron with live reload (main/preload rebuild + restart)
pnpm electron:icon          # regenerate build/icon.icns from docs/media/logo.svg
```

Architecture, IPC surface and security choices: [docs/DESKTOP.md](docs/DESKTOP.md).

## Nodes

| Category | Highlights |
|---|---|
| **Input** | Image, RAW Photo, Solid Color, Gradient, Noise (value/Perlin/fBm), Text, Checker |
| **Color** | Levels, Curves, HSL, White Balance, Exposure, Color Balance, Channel Mixer, Gradient Map, 3D LUT (`.cube`), Auto Levels, Histogram Equalize, Clarity, Dehaze, Highlights/Shadows, Selective Color, Split Toning, Black & White mixer, Match Color, False Color, Gamut Warning |
| **Filter** | Gaussian/Box/Directional/Lens Blur, Sharpen, High Pass, Denoise, Surface Blur, Bilateral, Median, Min/Max, Glow, Edge Detect, Frequency Separation |
| **Transform & Distort** | Crop, Resize (Lanczos/bicubic/area), Rotate 90, Flip, Canvas Size, Straighten, Perspective, Tile, Lens Distortion, Chromatic Aberration, Displace, Pixelate, Downsample, Wave, Mirror, Polar |
| **Mask** | Paint Mask (brush in the viewer), Color Range, Luma Range, Shape, Linear/Radial Gradient, Edges, Blur, Combine, Invert, Levels, Mask View |
| **Composite & Math** | Blend (18 modes), Mix, Layer Stack, Alpha Over, Drop Shadow, Border, Math Op, Remap, GLSL Expression |
| **Analog** | CCD Sensor, CCD Smear, Purple Fringing, Sensor Resolution, In-camera Sharpening, Direct Flash, Cheap Lens, Film Stock, Date Stamp, VHS Signal/Tracking/Noise, VCR OSD, Instant Frame, Thermal Camera, Digital Glitch |
| **Stylize** | Film Grain, Vignette, Bloom, Halation, Light Leak, Posterize, Dither, Halftone, Scanlines, JPEG artefacts (real DCT), CRT |
| **Print** | Risograph (1–4 drums, 26 Riso inks, grain touch, misregistration), Riso Layer, Screenprint, Photocopy, Fax |
| **Process** | Cyanotype, Wet Plate (tintype/ambrotype/daguerreotype), Infrared (Aerochrome), Cross Process, Toning |
| **Artistic** | Oil Paint (anisotropic Kuwahara), Pencil Sketch, ASCII Art, Pixel Sort, Mosaic/Stained Glass, Emboss |
| **Optical** | Tilt-Shift, Zoom Blur, Radial Blur, Lens Flare, God Rays, Anaglyph 3D, Kaleidoscope |
| **Retro** | Palette Quantize (NES, PICO-8, C64, EGA, CGA, Mac Plus, Apple II, ZX Spectrum…), Error Diffusion (Atkinson, Floyd–Steinberg, JJN, Sierra), LCD subpixels |
| **Utility** | Output, Reroute, Info, Split Compare, Channel View, Histogram Overlay, GLSL Shader |
| **AI** | Depth Map, Subject Mask, Depth Fog, Click Select (SAM), Scene Segmentation, Surface Normals, Relight, AI Upscale, Remove Object (LaMa), Colorize B&W, Neural Style, Low-Light Enhance, AI Line Art, AI Denoise, Sky Mask, Sky Replace, Face Detection & Landmarks, Face Restoration, Pose / Body, Smart Auto-Crop (models run in the browser, see [docs/AI.md](docs/AI.md)) |

## Custom nodes & plugins

<p align="center">
  <img src="docs/media/screenshots/node-builder.png" alt="Node Builder with GLSL editor, parsed parameters and an inline compile error" width="49%">
  <img src="docs/media/screenshots/plugin-manager.png" alt="Plugin Manager with a data plugin and a code plugin installed" width="49%">
</p>

**Node Builder** (Node → New Custom Node…). Write GLSL ES 3.00. Uniforms annotated with `@param` become
sliders, colour pickers, checkboxes and dropdowns:

```glsl
uniform float u_amount; // @param min=0 max=2 default=1 label="Amount"
uniform vec4  u_tint;   // @param color default=1,0.6,0.3,1

void main() {
  vec4 c = texture(u_image, v_uv);
  fragColor = vec4(mix(c.rgb, c.rgb * u_tint.rgb, u_amount), c.a);
}
```

Nodes can have several passes, inputs and outputs, and work at a smaller resolution. Compile errors show
inline at your own line numbers. See [docs/CUSTOM_NODES.md](docs/CUSTOM_NODES.md).

**Plugins** (Edit → Plugins…) come in two tiers:

- **Data plugins** (`.drplugin.json`): shader-only nodes and presets. Safe, so they install without a prompt.
- **Code plugins** (`.js` ES modules): can add CPU steps, canvas drawing and programmatic presets. They run
  arbitrary JavaScript, so Darkroom asks you to trust each one first.

```js
// my-plugin.js
export default ({ defineNode, GraphBuilder }) => ({
  id: 'me.myPlugin', name: 'My Plugin', version: '1.0.0',
  nodes: [defineNode({
    id: 'me.posterTint', name: 'Poster Tint', category: 'My Plugin',
    inputs: { image: { type: 'image' } },
    params: { levels: { type: 'int', default: 4, min: 2, max: 16 } },
    passes: [{ frag: `void main(){ vec4 c = texture(u_image, v_uv);
      fragColor = vec4(floor(c.rgb * float(u_levels)) / float(u_levels), c.a); }` }],
  })],
});
```

Example plugins live in [`public/plugins/`](public/plugins/). The format and API are documented in
[docs/PLUGINS.md](docs/PLUGINS.md), and built-in nodes follow [docs/NODE_AUTHORING.md](docs/NODE_AUTHORING.md).

## How it works

```
src/
  core/        engine (graph evaluation, caching, WebGL2), types, registry, groups, GLSL library,
               serialization, plugin loader
  nodes/       built-in nodes, auto-registered from library/, analog/, effects/, custom/
  presets/     presets built with GraphBuilder
  store/       Zustand document store, undo/redo, project I/O, autosave, settings
  ui/          editor (React + React Flow), themes, Node Builder, Plugin Manager
scripts/
  snap.mjs     render any node/preset headlessly to PNG (used for visual testing)
  app-snap.mjs screenshot the full editor with scripted interactions
```

- The engine flattens groups, evaluates the graph back from the viewed node and caches every node's output
  texture by a key made of its params and its inputs' keys, so moving one slider only re-renders the
  nodes downstream of it.
- Shaders get an auto-generated header with every input sampler, param uniform and a shared GLSL library:
  colour spaces, noise and blend modes.
- Parameters measured in pixels are multiplied by the render scale, so the preview and the full-resolution
  export match.

To render nodes and presets headlessly for testing:

```bash
node scripts/snap.mjs out.png "preset=print.riso3&img=portrait"
node scripts/snap.mjs out.png 'node=effects.kuwahara&params={"radius":8}'
```

## Credits

- Icons: [Farm-Fresh Web Icons](http://www.fatcow.com/free-icons) by FatCow Web Hosting, licensed
  [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/).
- Sample photos (via [Unsplash](https://unsplash.com) / [Lorem Picsum](https://picsum.photos)):
  [Roberto Nickson](https://unsplash.com/photos/7BjmDICVloE) (canoe),
  [Alexander Shustov](https://unsplash.com/photos/AHBiSKaENwc) (portrait),
  [Alexey Topolyanskiy](https://unsplash.com/photos/-oWyJoSqBRM) (fjord).
- AI models (downloaded on first use, all Apache-2.0):
  [Depth Anything V2 Small](https://huggingface.co/onnx-community/depth-anything-v2-small) (Yang et al.),
  [MODNet](https://huggingface.co/Xenova/modnet) (Ke et al.) and
  [U²-Net-p](https://huggingface.co/BritishWerewolf/U-2-Netp) (Qin et al., via rembg). They run with
  [ONNX Runtime Web](https://onnxruntime.ai) (MIT). Details in [docs/AI.md](docs/AI.md).
- Image-to-image models: [Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN) x4v3 / anime 6B (Wang et al., BSD-3-Clause),
  [LaMa](https://github.com/advimman/lama) (Suvorov et al., Apache-2.0; ONNX by Carve / OpenCV zoo),
  [DDColor](https://github.com/piddnad/DDColor) tiny (Kang et al., Apache-2.0),
  fast neural style (Johnson et al.; [pytorch/examples](https://github.com/pytorch/examples), BSD-3-Clause, via the ONNX Model Zoo),
  Zero-DCE (Guo et al.; [Keras example](https://huggingface.co/keras-io/low-light-image-enhancement), Apache-2.0) and
  [Informative Drawings](https://github.com/carolineec/informative-drawings) (Chan et al., MIT).
- Selection models (Apache-2.0): [SlimSAM-77](https://huggingface.co/Xenova/slimsam-77-uniform) (Chen et al.,
  pruned from Segment Anything by Kirillov et al.) and
  [DETR ResNet-50 panoptic](https://huggingface.co/Xenova/detr-resnet-50-panoptic) (Carion et al.), ONNX exports by Xenova.
- Relighting geometry: [MoGe-2](https://github.com/microsoft/MoGe) ViT-S normal (Wang et al., Microsoft, MIT; DINOv2
  backbone Apache-2.0; [official ONNX export](https://huggingface.co/Ruicheng/moge-2-vits-normal-onnx)).
- Denoise and sky models: [SCUNet](https://github.com/cszn/SCUNet) real-world PSNR/GAN (Zhang et al., Apache-2.0;
  [ONNX by Heliosoph](https://huggingface.co/Heliosoph/scunet-onnx)) and the SkySeg U²-Net from
  [xiongzhu666/Sky-Segmentation-and-Post-processing](https://github.com/xiongzhu666/Sky-Segmentation-and-Post-processing)
  (MIT; [fp16 ONNX by voyagerfromeast](https://huggingface.co/voyagerfromeast/skyseg)).
- People models: [MediaPipe Tasks Vision](https://ai.google.dev/edge/mediapipe) 0.10.35 with the Face Landmarker,
  Pose Landmarker and Selfie Multiclass models (Google, Apache-2.0),
  [YuNet](https://huggingface.co/opencv/face_detection_yunet) (Wu et al., OpenCV Zoo, MIT),
  [RestoreFormer++](https://github.com/wzhouxiff/RestoreFormerPlusPlus) (Wang et al., Apache-2.0;
  [web ONNX by Saimon8420](https://huggingface.co/Saimon8420/restoreformer-pp-web)) and
  [GFPGAN v1.4](https://github.com/TencentARC/GFPGAN) (Wang et al., Apache-2.0).
- RAW decoding: [LibRaw](https://www.libraw.org) (LGPL-2.1 / CDDL) via
  [libraw-wasm](https://github.com/ybouane/LibRaw-Wasm) (ISC). ZIP writing: [fflate](https://github.com/101arrowz/fflate) (MIT).
- Built with [React](https://react.dev), [React Flow](https://reactflow.dev),
  [Zustand](https://zustand.docs.pmnd.rs), [CodeMirror](https://codemirror.net),
  [Vite](https://vite.dev) and [vite-plugin-pwa](https://vite-pwa-org.netlify.app).
