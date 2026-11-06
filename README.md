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
- **GPU engine.** WebGL2 with RGBA16F buffers, multi-pass nodes, CPU steps for text/LUTs/histograms,
  and per-node caching, so only what changed re-renders. The preview renders at screen resolution and
  export at full resolution, with scale-aware shaders so both look the same.
- **About 150 nodes** across Input, Color, Filter, Distort, Transform, Mask, Composite, Math, Stylize,
  Analog, Print, Process, Artistic, Optical and Retro.
- **26 presets** emulating cameras, video formats, print processes and 19th-century photography.
- **Custom nodes.** A **GLSL Shader** node for quick one-offs, and a **Node Builder** that turns
  annotated GLSL (`// @param min=0 max=2`) into a reusable node type with sliders. Custom types are
  embedded in project files, so shared projects keep working.
- **Plugins.** Safe JSON shader packs, and JavaScript plugins (behind a trust prompt) with access to
  CPU steps and the preset builder. Managed in a Plugin Manager.
- **Three themes.** *Classic* (a 2000s Windows pro tool), *Aperture* (dark graphite Aqua) and *Aqua*
  (light Leopard). Choose under View → Theme or in Preferences.
- **Pro viewer.** Zoom/pan, pixel-exact zoom above 100%, A/B split compare against the source, and
  false-colour/gamut/histogram nodes for checking exposure.
- **Projects.** `.darkroom` files with embedded images and custom nodes. Autosaves to IndexedDB. Exports
  PNG, JPEG or WebP at full resolution.
- **Installable PWA.** Works offline once loaded.

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

Switch themes under **View → Theme** or in **Edit → Preferences…** (<kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>,</kbd>).
The choice is remembered.

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

## Nodes

| Category | Highlights |
|---|---|
| **Input** | Image, Solid Color, Gradient, Noise (value/Perlin/fBm), Text, Checker |
| **Color** | Levels, Curves, HSL, White Balance, Exposure, Color Balance, Channel Mixer, Gradient Map, 3D LUT (`.cube`), Auto Levels, Histogram Equalize, Clarity, Dehaze, Highlights/Shadows, Selective Color, Split Toning, Black & White mixer, Match Color, False Color, Gamut Warning |
| **Filter** | Gaussian/Box/Directional/Lens Blur, Sharpen, High Pass, Denoise, Surface Blur, Bilateral, Median, Min/Max, Glow, Edge Detect, Frequency Separation |
| **Transform & Distort** | Crop, Resize (Lanczos/bicubic/area), Rotate 90, Flip, Canvas Size, Straighten, Perspective, Tile, Lens Distortion, Chromatic Aberration, Displace, Pixelate, Downsample, Wave, Mirror, Polar |
| **Mask** | Color Range, Luma Range, Shape, Linear/Radial Gradient, Edges, Blur, Combine, Invert, Levels, Mask View |
| **Composite & Math** | Blend (18 modes), Mix, Layer Stack, Alpha Over, Drop Shadow, Border, Math Op, Remap, GLSL Expression |
| **Analog** | CCD Sensor, CCD Smear, Purple Fringing, Sensor Resolution, In-camera Sharpening, Direct Flash, Cheap Lens, Film Stock, Date Stamp, VHS Signal/Tracking/Noise, VCR OSD, Instant Frame, Thermal Camera, Digital Glitch |
| **Stylize** | Film Grain, Vignette, Bloom, Halation, Light Leak, Posterize, Dither, Halftone, Scanlines, JPEG artefacts (real DCT), CRT |
| **Print** | Risograph (1–4 drums, 26 Riso inks, grain touch, misregistration), Riso Layer, Screenprint, Photocopy, Fax |
| **Process** | Cyanotype, Wet Plate (tintype/ambrotype/daguerreotype), Infrared (Aerochrome), Cross Process, Toning |
| **Artistic** | Oil Paint (anisotropic Kuwahara), Pencil Sketch, ASCII Art, Pixel Sort, Mosaic/Stained Glass, Emboss |
| **Optical** | Tilt-Shift, Zoom Blur, Radial Blur, Lens Flare, God Rays, Anaglyph 3D, Kaleidoscope |
| **Retro** | Palette Quantize (NES, PICO-8, C64, EGA, CGA, Mac Plus, Apple II, ZX Spectrum…), Error Diffusion (Atkinson, Floyd–Steinberg, JJN, Sierra), LCD subpixels |
| **Utility** | Output, Reroute, Info, Split Compare, Channel View, Histogram Overlay, GLSL Shader |

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
- Built with [React](https://react.dev), [React Flow](https://reactflow.dev),
  [Zustand](https://zustand.docs.pmnd.rs), [CodeMirror](https://codemirror.net),
  [Vite](https://vite.dev) and [vite-plugin-pwa](https://vite-pwa-org.netlify.app).
