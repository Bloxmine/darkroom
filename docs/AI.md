# AI nodes

Darkroom runs a few small neural networks in the browser with [ONNX Runtime Web](https://onnxruntime.ai)
(`onnxruntime-web` 1.31.1). Nothing is uploaded. A model downloads once from Hugging Face the first
time a node needs it. It is then kept in Cache Storage (`darkroom-models`), so it also works offline.

## Nodes (category **AI**)

| Node | Id | Output | What it does |
|---|---|---|---|
| Depth Map | `ai.depth` | `depth` (mask, near = white) | Depth Anything V2 Small, normalised (0.5–99.5 percentile), then upsampled edge-aware against the image |
| Subject Mask | `ai.subjectMask` | `mask` (mask, subject = white) | MODNet portrait matte, or U²-Net-p salient-object mask |
| Depth Fog | `ai.depthFog` | `out` (image) | Haze that thickens with distance; connect a Depth Map to `depth` |

**`ai.depth` params:**
- `resolution`: inference short side, 252 / 392 / 518 (multiples of 14; the long side follows the aspect, capped at 2×).
- `near` / `far`: the raw depth values mapped to white and black.
- `gamma`.
- `edges`: strength of the edge-aware refine.
- `smoothing`.
- `invert`.
- `model`: only *Depth Anything V2 Small* for now.

**`ai.subjectMask` params:**
- `model`: *Portrait (MODNet)* or *Object (U²-Net-p)*.
- `resolution`: MODNet short side, 256–768, multiple of 32. U²-Net-p always uses 320².
- `refine`: edge-aware upsampling strength.
- `threshold` and `softness`: `softness` 1 keeps the soft matte, 0 makes a hard cut.
- `feather`: px, scale-aware.
- `invert`: selects the background instead.

**`ai.depthFog` params:**
- `density`.
- `start`: the distance where the fog begins.
- `curve`.
- `color`: alpha = maximum fog.
- `soften`: blur of distant areas, px.
- `desaturate`.
- `showFog`.

Existing nodes that take a depth map:
- **Tilt-Shift** (`effects.tiltShift`) has an optional `depth` input. When it is connected, the focus is
  a depth (`focusDepth`) instead of a band, and `width`/`falloff` apply in depth.
- **Anaglyph 3D** (`effects.anaglyph`) has an optional `depth` input that replaces its depth guess.
- **Lens Blur** (`filter.lensBlur`): wire a depth map into `amount` and set *Mask is* to `depth`, with *Focus depth*.
- Any `mask.*` node accepts these outputs (e.g. Mask Levels to reshape depth, Mask Blur to soften a matte).

### Presets (`src/presets/ai.ts`)
- `ai.portraitBokeh`: subject mask (inverted), then lens blur on the background, then a subtle vignette.
- `ai.trueMiniature`: depth map driving tilt-shift (focus depth 0.82 ≈ the main subject).
- `ai.depth3d`: Dubois anaglyph from real depth.
- `ai.foggyMorning`: depth fog, then a warm soft glow, then white balance.

### Caching
The engine re-runs a node's `cpu()` whenever its params or the render scale change. The AI nodes keep
their own memo (`InferenceMemo` in `src/core/ai/image.ts`) keyed by:
- the model and inference size;
- a 24×24 fingerprint of the input image.

A memo hit costs only the readback and a resample, ≈0.2–0.5 s. You get one in all of these cases:
- tweaking near/far/edges/threshold/feather;
- switching the preview quality;
- exporting at full resolution.

The model runs again in two cases:
- the image content or the inference size changes;
- the cached result came from a source smaller than the inference size and a larger one is now available.

Everything after inference (normalisation lives in `cpu()`; remap, refine, threshold and feather are GPU
passes) is cheap.

## Models

URLs are pinned to a Hugging Face commit (see `src/core/ai/models.ts`).

| Model | File used | Size | Licence | Source |
|---|---|---|---|---|
| Depth Anything V2 Small | `onnx/model_fp16.onnx` on WebGPU with `shader-f16`, else `onnx/model_quantized.onnx` (int8) | 49.6 MB / 27.3 MB | Apache-2.0 | [onnx-community/depth-anything-v2-small](https://huggingface.co/onnx-community/depth-anything-v2-small) @ `4472b736` |
| MODNet | `onnx/model.onnx` (fp32) | 25.9 MB | Apache-2.0 | [Xenova/modnet](https://huggingface.co/Xenova/modnet) @ `fa2fa546` |
| U²-Net-p | `onnx/model.onnx` (fp32) | 4.6 MB | Apache-2.0 | [BritishWerewolf/U-2-Netp](https://huggingface.co/BritishWerewolf/U-2-Netp) @ `7112208d` (rembg export) |

Notes on the choices:
- **MODNet stays fp32.** The int8 export (6.6 MB) punches large holes in bodies and clothing; fp32 runs at the same speed.
- **Depth fp16 and int8 agree.** The two depth exports are visually identical (mean difference 1.2/255).
- **RMBG-1.4 was not used:** non-commercial licence.
- **ISNet was not used:** AGPL-3.0.
- **BiRefNet-lite (MIT) was not used:** 115 MB at fp16 was too heavy for a default.
- **Depth Anything V2 Base/Large** are CC-BY-NC, so only Small (Apache-2.0) is offered.

Attribution:
- Depth Anything V2: L. Yang, B. Kang, Z. Huang, Z. Zhao, X. Xu, J. Feng, H. Zhao, *Depth Anything V2*, 2024.
  [github.com/DepthAnything/Depth-Anything-V2](https://github.com/DepthAnything/Depth-Anything-V2).
- MODNet: Z. Ke, J. Sun, K. Li, Q. Yan, R. W.H. Lau, *MODNet: Real-Time Trimap-Free Portrait Matting via
  Objective Decomposition*, AAAI 2022. [github.com/ZHKKKe/MODNet](https://github.com/ZHKKKe/MODNet).
- U²-Net: X. Qin, Z. Zhang, C. Huang, M. Dehghan, O. Zaiane, M. Jagersand, *U²-Net: Going Deeper with Nested
  U-Structure for Salient Object Detection*, Pattern Recognition 2020. [github.com/xuebinqin/U-2-Net](https://github.com/xuebinqin/U-2-Net);
  the ONNX export is from [rembg](https://github.com/danielgatis/rembg) (MIT).
- ONNX Runtime Web: Microsoft, MIT licence.

## Selection, scene segmentation and relighting

| Node | Id | Output | What it does |
|---|---|---|---|
| Click Select (SAM) | `ai.segmentAnything` | `mask` | SlimSAM (Segment Anything, pruned): click objects in the viewer; + / − points and an optional box |
| Scene Segmentation | `ai.sceneSegment` | `mask`, `labels` | DETR ResNet-50 panoptic (COCO): a class (sky, person, vegetation…) as a mask, plus a colour-coded label map |
| Relight | `ai.relight` | `out` | Up to three point / spot / directional lights with soft shadows; see [Relighting](#relighting) |
| Paint Mask | `mask.paint` (category Mask) | `mask` | Brush strokes painted in the viewer, rasterised at any resolution |

**`ai.segmentAnything` params:**
- `points` (hidden JSON `[{"x":0.5,"y":0.6,"label":1}]`, 0..1 from the top-left; label 1 = include, 0 = exclude) and `box` (hidden JSON `[x0,y0,x1,y1]` or empty). Edited in the viewer.
- `maskIndex`: *Auto (best score)* or *Mask 1/2/3* (SAM's three proposals at different granularities).
- `threshold`, `softness` (on the mask probability), `refine` (edge-aware upsampling), `feather` (px), `invert`.
- The image is resized to a 1024 long side and encoded **once per image** (memo by fingerprint). Each click
  only re-runs the prompt decoder, and decoded masks are memoised per prompt, so slider tweaks don't
  re-run anything. The 256² low-res mask (logits → probability) is cropped to the image and upsampled
  with the joint-bilateral refine from `_shared.ts`.
- **Box:** this SAM export has no working box prompt (labels 2/3 act like background), so a box seeds a
  positive point at its centre when there is no other positive point, and the mask is clipped to the box.

**`ai.sceneSegment` params:**
- `class`: Sky, Person, Vegetation (trees, grass, plants), Trees, Grass, Water (sea, river, lake), Mountain & hills, Rock,
  Building & walls, Road & pavement, Ground (dirt, sand, gravel, snow), Snow, Vehicles, Animals, Landscape (not sky).
  They are groups of COCO panoptic categories (e.g. *Water* = river + sea + water-other).
- `resolution`: short side 384 / 512 (default) / 640 / 800 (multiple of 32, long side ≤ 2×).
- `threshold`, `softness`, `refine` (0.9 by default: the sky against branches), `feather`, `invert`.
- The mask is soft: for each pixel, the share of the class in Σ_q p(class | query) · σ(mask_q). Inference
  runs once per image; changing the class only recombines the cached query masks (a few ms).
- `labels` (second output): Sky, Person, Trees, Grass, Water, Mountain, Rock, Building, Road, Ground, Vehicles,
  Animals, Other; tinted by the image luminance.

**`ai.relight`** is documented in its own section, [Relighting](#relighting) (with `ai.normals` and the light-rig presets).

**`mask.paint` params:** `strokes` (hidden JSON `[{"r":0.03,"h":0.6,"e":0,"p":[x,y,x,y,…]}]`, r = radius as a
fraction of the image height, h = hardness, e = 1 to erase), `fill` (start white), `feather` (px), `invert`.
Strokes are rasterised in `cpu()` at the render size (distance to each segment, smoothstep falloff; paint =
max, erase = × (1 − coverage)). The optional `image` input sets the output size; the brush aspect comes
from the project size.

### Viewer tools (`src/ui/viewerTools/`)
A node opts in with `viewerTool` on its `NodeDef` (`src/core/types.ts`):
```ts
viewerTool?: 'points' | 'brush' | 'box' | {
  kind: 'points' | 'brush' | 'box';
  param?: string;      // JSON param edited by the tool (default points / strokes / box)
  single?: boolean;    // points: one draggable point
  vec2Param?: string;  // single point written to a vec2 param instead of JSON
  handles?: { param: string; label?: string; enabledBy?: string; colorParam?: string }[];
                       // points: several draggable points, one vec2 param each (Relight: light, light2, light3)
  boxParam?: string;   // points: drag on an empty area draws a box into this JSON param
  previewPort?: string;// mask output shown as a translucent tint while the tool is active
  label?: string;      // HUD title
}
```
- While exactly one node with a tool is selected, `ViewerToolOverlay` covers the viewer. It also works when a **group** (e.g. a
  preset) is selected and exposes the tool's param: it edits the exposed key on the group.
- Coordinates are normalised 0..1 with a top-left origin (like `v_uv`), mapped through the viewer's `imageRect()`, so zoom
  and pan work. Space-drag and the middle button still pan; the wheel still zooms.
- Edits go through `setParam` (undoable). A whole brush stroke or point drag is **one** undo step
  (`beginGesture` / `endGesture` in `tool.ts` collapse the history entries of the gesture).
- **Handles** (`handles`): each enabled handle (its `enabledBy` bool is true) is drawn as a labelled lamp tinted with its
  `colorParam`. Drag a handle to move it; a click on empty space moves the *selected* handle (HUD buttons *Light 1/2/3*).
  For a group, only handles whose param is exposed are shown; `enabledBy`/`colorParam` are read from the exposed key if
  there is one, else from the inner node.
- **Points:** click adds a point in the current mode; Shift = include, Alt = exclude; drag a point to move it; right-click removes it
  (or the box); drag on an empty area draws a box (if `boxParam`).
- **Brush:** Paint / Erase (X), size (`[` `]`, in full-resolution px), hardness.
- **HUD:** tool name and kind, a “working…” flag while the node is pending, mode buttons or brush settings,
  *Show mask*, *Clear* and *Done* (hides the tool until the selection changes; a small ✎ button brings it back). It is styled
  only with theme tokens (`--face`, `--text`, `--muted`, `--sel`, `--lo`, `.btn`), so Classic, Aperture and Aqua all work.
- **Mask tint:** the `previewPort` output is read back downsampled (`engine.thumbnail`, ≤640 px) after renders and drawn in `--sel` at
  50 % opacity. It is hidden when that node itself is being viewed.
- Automation: `window.__darkroomViewerTools.toClient(x, y)` maps a normalised image point to client coordinates, and `.ui` is the
  tool state store (point mode, brush size/hardness/erase).

### Presets (`src/presets/ai-select.ts`)
- `ai.skySwap`: scene segment (Sky), then a gradient sky (top → horizon over the upper half), colour-matched part-way to the photo, then mixed in.
  Knobs: sky top / horizon colours, gradient height, match to photo, amount, mask threshold / softness / refine / feather.
- `ai.selectiveColor`: Click Select keeps the object in colour, the rest goes black & white. Knobs: points/box (hidden; the viewer tool), mask, threshold, refine, feather, invert, colour amount.
- `ai.dramaticRelight`: Surface Normals, then Relight (*Replace lighting*, one low warm lamp, ambient 0.2), then a vignette. Knobs: light position (draggable), height, intensity, colour, ambient, falloff, shadows, shadow softness, remove old light, vignette. The light-rig presets are listed under [Relighting](#relighting).
- `ai.cutout`: Click Select, then alpha from the mask, then a drop shadow over a background colour (alpha 0 = transparent). Knobs: points/box, mask, refine, feather, shadow angle / distance / blur / opacity, background.

### Models

| Model | File used | Size | Licence | Source |
|---|---|---|---|---|
| SlimSAM-77 image encoder | `onnx/vision_encoder_fp16.onnx` on WebGPU with `shader-f16`, else `onnx/vision_encoder_quantized.onnx` | 12.2 MB / 8.9 MB | Apache-2.0 | [Xenova/slimsam-77-uniform](https://huggingface.co/Xenova/slimsam-77-uniform) @ `5850ab45` |
| SlimSAM-77 prompt decoder | `onnx/prompt_encoder_mask_decoder_fp16.onnx` / `…_quantized.onnx` | 8.6 MB / 4.9 MB | Apache-2.0 | same repo and commit |
| DETR ResNet-50 panoptic | `onnx/model_fp16.onnx` on every backend (fp16 weights, fp32 I/O) | 86.6 MB | Apache-2.0 | [Xenova/detr-resnet-50-panoptic](https://huggingface.co/Xenova/detr-resnet-50-panoptic) @ `ea24b2d4` |

They are registered from `src/core/ai/models-seg.ts` through `registerModel()` in `models.ts`.

Notes on the choices:
- **SAM int8 ≈ fp32.** On the canoe photo, the quantised encoder/decoder masks match fp32 (IoU scores within 0.03).
  WebGPU fp16 gives the same mask as WASM int8.
- **The DETR int8 export is broken:** its query masks are garbage (sky everywhere). fp16 matches fp32 exactly (same label
  histogram) at half the size, and runs on WASM too, so it is the only file. fp32 would be 172 MB.
- **Semantic-segmentation candidates rejected:**
  - SegFormer: NVIDIA non-commercial licence.
  - MaskFormer (onnx-community ADE20K / COCO-Stuff / Cityscapes exports): the MaskFormer code and weights are CC-BY-NC-4.0.
  - DeepLabV3-MobileViT (Xenova): Apple `apple-amlr` licence, and PASCAL VOC classes (no sky).
  - UperNet-ConvNeXt-T ADE20K (`JElvis/upernet-convnext-tiny-ade-onnx`, MIT): a 238 MB fp32 third-party re-upload.
  - CLIPSeg: ≥115 MB, and coarse at 352².
- The DETR export declares a fixed `pixel_mask` of 1×64×64; an all-ones 64×64 mask works at any input size (it is resized
  to the feature map inside). `config.json`'s `id2label` is the COCO-Stuff list, not the panoptic one: the node uses the
  COCO panoptic category ids directly (sky-other-merged = 187, tree-merged = 184, …), checked on the samples.

Attribution:
- SlimSAM: Z. Chen, G. Fang, X. Ma, X. Wang, *SlimSAM: 0.1% Data Makes Segment Anything Slim*, NeurIPS 2024.
  [github.com/czg1225/SlimSAM](https://github.com/czg1225/SlimSAM). Segment Anything: A. Kirillov et al., ICCV 2023 (Apache-2.0).
- DETR: N. Carion, F. Massa, G. Synnaeve, N. Usunier, A. Kirillov, S. Zagoruyko, *End-to-End Object Detection with
  Transformers*, ECCV 2020. [github.com/facebookresearch/detr](https://github.com/facebookresearch/detr) (Apache-2.0).
- ONNX exports: Xenova (Transformers.js).

### Runtime additions (additive)
- `TensorData.type?: 'float32' | 'int64'`: int64 feeds (SAM `input_labels`, DETR `pixel_mask`) are converted in the session host.
- `runModelMulti(id, inputs, outputs?)` in `runtime.ts`: several named inputs and outputs, through the `run` message's new
  optional `outputs` field (returned in `RunResult.extra`). It is also on `window.__darkroomAi`. Input buffers are transferred,
  so callers pass copies of cached tensors (the SAM node copies its embeddings, 2 × 4 MB, per decode).

### Timings
Measured on an Apple-silicon Mac, ORT 1.31.1, warm, as a worker round trip (including transfers):

| Model / input | WebGPU (Metal, fp16) | WASM 1 thread (int8 SAM / fp16 DETR) |
|---|---|---|
| SlimSAM encoder, 1024² | ≈0.86–1.0 s | ≈4.2 s |
| SlimSAM decoder (one click) | ≈75 ms | ≈120–175 ms |
| DETR panoptic, 960×640 | ≈0.6 s | ≈8.9 s |
| DETR panoptic, 768×512 (default) | not measured | ≈5.6 s |
| DETR panoptic, 1216×800 | ≈1.0 s | ≈14.5 s |

- In the editor (headless, WASM), a click after the first one took ≈0.2 s from click to updated mask.
- In Node.js with 4 WASM threads: SlimSAM encoder ≈1.6 s; DETR at 640×427 ≈1.7 s. Expect roughly this under COOP/COEP.

### Known gaps (selection)
- The SAM box is emulated (centre point + clip), because this export has no box prompt.
- SAM masks come from a 256² decoder output: thin structures (paddle shafts, hair strands) rely on the edge refine.
- A preview render from a tiny source (e.g. the 256 px node thumbnails) can trigger a second SAM encode when a larger source
  arrives (the memo re-runs for quality). It takes ≈4 s once on WASM.
- DETR at the default 512 is coarse (masks at ¼ resolution); spiky tree tops against the sky are partly lost.
  The refine helps; 800 is sharper but ~2.5× slower.
- Paint Mask takes the brush aspect from the project size: on an `image` input with another aspect, round dabs become slightly elliptical.
- The mask tint is a downsampled readback; it lags ~0.1–0.3 s behind a stroke, and longer when the GPU is busy.

## Image-to-image: upscale, remove object, colorize, style, low light, line art

| Node | Id | Output | What it does |
|---|---|---|---|
| AI Upscale | `ai.upscale` | `out` (2× / 4× size) | Real-ESRGAN, tiled with feathered seams; preview upscales the preview-sized input, export the full image |
| Remove Object (LaMa) | `ai.inpaint` | `out` | Fills whatever the `mask` input covers (white = remove), per region: context crop → 512² → LaMa → feathered paste-back |
| Colorize B&W | `ai.colorize` | `out` | DDColor tiny predicts Lab a/b at 512²; edge-aware upsampled and merged with the full-res L |
| Neural Style | `ai.styleTransfer` | `out` | Fast neural style (Mosaic, Candy, Rain Princess, Udnie, Pointillism) |
| Low-Light Enhance | `ai.lowLight` | `out` | Zero-DCE curve maps at low res, applied ×8 at full res in a shader (Zero-DCE++ style) |
| AI Line Art | `ai.lineArt` | `out` | Informative Drawings generators: fine lines (anime), bold contours, pencil sketch (OpenSketch) |

**`ai.upscale` params:**
- `model`: *General photo (Real-ESRGAN x4v3)* or *Anime / illustration (Real-ESRGAN x4plus anime)*.
- `factor`: 2× or 4×. Both run the 4× network; 2× box-downsamples each tile (sharper than a native 2× model). `size()` scales the output.
- `denoise` (general model): 1 = x4v3 (strong denoise), 0.5 = the official default (x4v3 / wdn-x4v3 weights blended 50/50, a separate export), other values run both and blend the outputs in a shader (below 0.5 it extrapolates toward the weak-denoise model). Both outputs are cached, so the slider is instant after the first run of each.
- `amount`: blend with a bicubic enlargement.
- `tile`: input px per tile (128–512). Tiles are spread evenly with ≥16 px overlap; seams are smoothstep-feathered in output space. The toast shows *AI Upscale … tile n/N*.

**`ai.inpaint` params:** `dilate` (grow mask, px), `feather` (px), `context` (crop padding × region size; the crop is at least 512 px when the image allows, so small fixes stay 1:1), `threshold` (mask binarisation), `showMask`.
Each 8-connected region gets its own crop; crops that overlap are merged. Inference is cached by image + mask + dilate/context, so feather changes are instant. The `mask` input is optional (unconnected = nothing removed): wire in `mask.paint`, `ai.segmentAnything`, `ai.sceneSegment`, `mask.shape`, `mask.lumaRange`…

**`ai.colorize` params:** `saturation` (a/b gain), `amount` (blend with the input), `warmth` (Lab b shift), `edges` (edge-aware chroma upsampling against luminance). Colour input works too: only its luminance is used.

**`ai.styleTransfer` params:** `style`, `strength` (mix with the original), `size` (inference short side 256–1024 = brush scale), `preserveColor` (stylised luminance + original chroma, YCbCr).

**`ai.lowLight` params:** `strength` (scales the curve parameters), `exposure` (EV after the curves), `saturation`, `iterations` (1–8 curve passes), `resolution` (curve-estimation short side).

**`ai.lineArt` params:** `style`, `size` (inference short side = detail), `weight` (stroke dilation, px), `contrast`, `darkness` (ink gamma), `ink` / `paper` colours, `invert`.

### Presets (`src/presets/ai-restore.ts`)
- `ai.restoreOldPhoto`: white top-hat scratch detection (`filter.minMax` open → subtract → `composite.maskFromLuma`) → Remove Object → Colorize → Upscale 2×. The detector is a heuristic: very fine bright detail (petals, grass) can be caught too; raise *Scratch threshold* or open the group and feed a painted mask into Remove Object.
- `ai.colorizeVintage`: Colorize → film curve (expired stock, fade) → grain.
- `ai.paintingStyles`: Neural Style → vibrance → canvas-like grain.
- `ai.nightRescue`: Low-Light Enhance → `filter.denoise` → grain.
- `ai.inkDrawing`: AI Line Art → paper grain → vignette.

### Models (`src/core/ai/models-img.ts`)

| Model | File used | Size | Licence | Source |
|---|---|---|---|---|
| Real-ESRGAN general x4v3 | `model_fp16.onnx` (WebGPU + `shader-f16`), else `model.onnx` | 2.4 / 4.9 MB | BSD-3-Clause | [skillsafe-ai/realesr-general-x4v3](https://huggingface.co/skillsafe-ai/realesr-general-x4v3) @ `042a40bc` |
| Real-ESRGAN general x4v3, denoise 0.5 | `realesr-general-x4v3-dn50.onnx` | 4.9 MB | BSD-3-Clause | [techycoder/realesrgan-general-x4v3](https://huggingface.co/techycoder/realesrgan-general-x4v3) @ `ec6f6298` |
| Real-ESRGAN x4plus anime 6B | `model_fp16.onnx` / `model.onnx` | 9.0 / 17.9 MB | BSD-3-Clause | [skillsafe-ai/realesrgan-x4plus-anime-6b](https://huggingface.co/skillsafe-ai/realesrgan-x4plus-anime-6b) @ `c001be50` |
| LaMa (big-lama) | `inpainting_lama_2025jan.onnx` (int8 weights); fallback `lama_fp32.onnx` | 92.6 / 208 MB | Apache-2.0 | [opencv/inpainting_lama](https://huggingface.co/opencv/inpainting_lama) @ `aee6d22f`; fallback [Carve/LaMa-ONNX](https://huggingface.co/Carve/LaMa-ONNX) @ `c3c0c9e4` |
| DDColor tiny | `ddcolor-tiny-fp16.onnx` (fp16 weights, fp32 I/O, fixed 512²) | 135.4 MB | Apache-2.0 | [edgetools/ddcolor](https://huggingface.co/edgetools/ddcolor) @ `4755ae9f` |
| Fast neural style ×5 | `mosaic-9.onnx`, `candy-9.onnx`, `rain-princess-9.onnx`, `udnie-9.onnx`, `pointilism-9.onnx` | 6.7 MB each | BSD-3-Clause (pytorch/examples; the HF repos are tagged Apache-2.0) | [onnxmodelzoo](https://huggingface.co/onnxmodelzoo) `mosaic-9` @ `9a267ba8`, `candy-9` @ `f24fcf55`, `rain-princess-9` @ `205625e4`, `udnie-9` @ `ab74109f`, `pointilism-9` @ `d9c3c80c` |
| Zero-DCE (DCE-Net) | `variables/variables.data-00000-of-00001` (raw Keras weights) | 0.33 MB | Apache-2.0 | [keras-io/low-light-image-enhancement](https://huggingface.co/keras-io/low-light-image-enhancement) @ `eb992d12` |
| Informative Drawings, anime / contour | `informative-drawings_{anime,contour}_512x512.onnx` | 17.2 MB each | MIT | [x-Liola-x/informative-drawings-onnx](https://huggingface.co/x-Liola-x/informative-drawings-onnx) @ `f6030b3a` |
| Informative Drawings, OpenSketch | `model.onnx` | 17.2 MB | MIT | [backnotprop/informative-drawings-image-to-opensketch-onnx](https://huggingface.co/backnotprop/informative-drawings-image-to-opensketch-onnx) @ `b18595c1` |

All URLs serve `access-control-allow-origin` (checked with `curl -I -H Origin:`).

Notes on the choices:
- **Upscale:** realesr-general-x4v3 (SRVGGNetCompact) is tiny and fully convolutional with dynamic H×W. The official
  `wdn-x4v3` has no hosted ONNX; the denoise-0.5 export is the official 50/50 weight blend, which with x4v3 gives
  two exact points of the denoise curve. x4plus (67 MB, 23 RRDB blocks) and Swin2SR were left out as too slow for tiled browser use.
- **LaMa:** the OpenCV-zoo file is Carve's export with int8 weights (DequantizeLinear): in our test its output matched
  the fp32 file at under half the download. Big-LaMa was trained on Places2, whose terms are non-commercial; the
  weights and code are Apache-2.0.
- **DDColor:** the smallest permissive ONNX export (paper_tiny, fp16 weights). The modelscope/artistic variants are larger; `artistic` was trained on private data.
- **Fast neural style:** the ONNX Model Zoo files are fixed at 1×3×224×224. `freeImageDims()` (in `onnx-proto.ts`) rewrites the graph inputs/outputs to symbolic H×W at load time (the network is fully convolutional), drops stale `value_info`, and removes initializers listed as inputs.
- **Zero-DCE:** the original repos (Li-Chongyi/Zero-DCE, Zero-DCE_extension) carry no licence, so they were not used. The Keras example's retrained DCE-Net is Apache-2.0, but only as a TF SavedModel. Its checkpoint is just the 7 conv layers' float32 weights (HWIO, in order), so `buildZeroDce()` builds the ONNX graph in the browser from the 325 KB weights file (validated against a Python reference: max diff 0).
- **Informative Drawings:** the x-Liola-x exports are fixed 512² and get the same `freeImageDims()` treatment; the OpenSketch export is already dynamic.

### WebGPU
- LaMa and DDColor are pinned to WASM (`wasmOnly`). In ORT 1.31 the WebGPU EP fails on LaMa's FFC `convg2g/Add` ("Can't perform binary op") and on DDColor's `/decoder/layers.0/shuf/conv/MatMul` ("shared dimension does not match"). A failed WebGPU run would also move every later model to WASM.
- Real-ESRGAN, fast neural style, Zero-DCE and Informative Drawings run on WebGPU.

### Runtime additions (additive)
- `ModelInfo.prepare?(buf)`: transforms the downloaded (cached as-is) bytes into the ONNX to load. Used by the style, Zero-DCE and line-art models.
- `setAiTask(id, {label, done, total} | null)` in `runtime.ts`, plus `AiState.tasks`: task progress rows in the AI toast (upscale tiles, inpaint regions).
- `ModelInfo.task` gained `super-resolution`, `inpainting`, `colorization`, `style-transfer`, `low-light` and `line-art`.

### Timings
Measured on an Apple-silicon Mac, ORT 1.31.1, warm (model cached, page reloaded). WebGPU = real Metal through Playwright
`channel: 'chromium'` + `--enable-unsafe-webgpu`. WASM = 1 thread (the harness page is not cross-origin isolated; the app with
COOP/COEP uses up to 4 threads, roughly 3× faster for the depth model).

| Model / input | WebGPU (Metal) | WASM 1 thread |
|---|---|---|
| Real-ESRGAN x4v3 (dn50, fp32), one 158×196 tile | ≈0.38 s | ≈1.8 s |
| Real-ESRGAN x4v3 (dn50), 4× of 1600×1067 (35 tiles of 243×227 → 6400×4268) | ≈17.5 s inference, ≈19 s total | not measured (≈35 tiles × ≈3 s) |
| Real-ESRGAN anime 6B, one 158×196 tile | ≈0.29 s (fp16) | ≈8.7 s (fp32) |
| LaMa (int8), one 512² region | runs on WASM | ≈13.8 s (+≈5 s session load) |
| DDColor tiny, 512² | runs on WASM | ≈5.3 s |
| Fast neural style, 768×512 | ≈0.37 s | ≈3.3 s |
| Informative Drawings (anime), 768×960 | ≈0.82 s | ≈11.1 s |
| Zero-DCE, 576×384 | ≈80 ms | ≈0.92 s |

The first download adds ~2.4–135 MB per model (LaMa 92.6 MB, DDColor 135 MB).

### Known gaps (image-to-image)
- **Memory:** a 4× upscale of a 24 MP photo is a 384 MP output: about 1.5 GB of RGBA8 and a GPU texture past most `MAX_TEXTURE_SIZE` limits. Use 2×, or upscale a crop. There is no check for the GL limit yet.
- A running upscale isn't cancelled when its params change. Work queues in the worker; finished results are memoised.
- LaMa works at 512²: large holes in big photos are filled at a lower resolution than their surroundings and look soft.
- DDColor runs on a squashed 512² image, and its colours can bleed slightly into fine detail.
- Zero-DCE brightens aggressively and over-saturates cyan: the presets pull saturation back.
- The `ai.restoreOldPhoto` scratch detector only finds bright marks, not dark ones, and catches fine bright texture.

## Denoise and sky

| Node | Id | Outputs | What it does |
|---|---|---|---|
| AI Denoise | `ai.denoise` | `out` | SCUNet blind real-world denoiser, tiled; recombined with the original in YCbCr |
| Sky Mask | `ai.skyMask` | `mask` (sky = white), `horizon` (mask), `image` (defringed) | SkySeg U²-Net + guided-filter matting; horizon line fit; edge un-mixing |
| Sky Replace | `ai.skyReplace` | `out` | New sky from the `sky` input (any image) or a procedural sky, with relight, edge light, defringe, horizon haze |

**`ai.denoise` params:**
- `model`: *Real-world, faithful (SCUNet PSNR)* (default) or *Real-world, sharper (SCUNet GAN)*.
- `strength`: mix with the original.
- `luma` / `chroma`: separate amounts for the Y and CbCr channels of the result (lower `luma` keeps a fine grain).
- `detail`: detail recovery. The luma high-pass that the network removed (original minus denoised, each
  minus its σ≈1 px blur) is added back, weighted towards places where the clean image has structure.
- `tile`: 128–512 input px per tile. Tiles overlap by 32 px. The outer 8 px of each overlap get ~0 weight and
  the rest is smoothstep-feathered, so no seams show. The progress toast counts tiles.
- Like `ai.upscale`, the preview denoises the preview-scale input and export runs at full resolution. Results are memoised
  per model, size, tile and input fingerprint, so the sliders (applied in a GPU pass) are instant.

**`ai.skyMask` params:**
- `resolution`: inference short side, 320 / 384 / 512 (default) / 640. The long side follows the aspect, capped at 2×.
- `threshold`, `softness`.
- `refine`: guided-filter matting amount (0 = plain upsampled mask).
- `radius`: guided-filter window (px, scale-aware).
- `eps`: guided-filter ε (edge tolerance).
- `connected`: keep only sky connected to the top of the frame. On by default; it removes reflections in water.
- `colorKey`: colour-key strength in the edge band. It also adds missed flat sky that matches the row's sky colour above the horizon.
- `feather`.
- `defringe`: `image` output only.
- `horizonSoftness` / `horizonOffset`: `horizon` output.
- `invert`: `mask` output only.

**`ai.skyReplace` params:**
- Procedural sky, used when `sky` is unconnected: `skyPreset` (*Sunset*, *Blue day*, *Overcast*, *Night*, *Stormy*),
  `clouds` (cover; 0.5 = the preset's), `sunX`, `seed`. The gradient is laid out relative to the detected horizon.
  Clouds are domain-warped fbm on a plane above the camera, so perspective squeezes them towards the horizon.
- Sky image: `skyFit` (*Fill above horizon*: covers the area above the horizon, bottom on it / *Fill frame* /
  *Stretch above horizon*), `skyScale`, `skyOffset`, `skyBlur` (px).
- `relight`: moves the foreground's colour balance (power 0.6 of the ratio) and level (√ of the luma ratio)
  from the old sky's average linear colour towards the new sky's. The averages are α-weighted and computed on the GPU.
- `edgeLight`: screen-blends the new sky onto the foreground just inside the silhouette.
- `defringe`: un-mixes edge pixels against the old local sky colour.
- `horizonBlend`: haze in the new sky's horizon colour just below the horizon. It applies only to pixels that have sky
  a short way above them, so it never reaches a subject that stands in front of the horizon.
- The mask params of Sky Mask, plus `showMask`.

Sky Replace runs the same analysis as Sky Mask, from one shared memo. A Sky Mask and a Sky Replace on the same
image therefore cost a single inference.

### How the sky mask is built
1. **SkySeg U²-Net** gives the sky probability at the inference size.
2. **On the CPU** (memoised per image):
   - the probability is flood-filled from the top 5 % of the frame and then dilated, which drops reflections and bright patches below the horizon;
   - a per-row mean sky colour is computed;
   - the horizon line `y = a + b·(x − ½)` is fitted as a robust *lower envelope* of the per-column extent of the top-down sky. Columns where a head or a tree sticks into the sky are down-weighted.
3. **On the GPU:**
   - joint-bilateral upsampling against the image, then threshold and softness;
   - a **guided filter** (He et al. 2010) with the luma as guide: this is the matting pass. Inside the mixed zone the matte becomes a local linear function of luma, so sky shows through between twigs, wires and hair strands;
   - a colour key against the local sky colour in the edge band;
   - an optional feather.
4. **Defringe** (`image` output and Sky Replace): `F = (I − α·S) / (1 − α)` in linear light, with `S` the local sky colour.
   It is applied only in the partial-α band.

**Why a dedicated model:**
- the scene segmentation's DETR sky class comes from 1/4-resolution query masks;
- SkySeg is trained only for sky, and U²-Net keeps fine structure;
- it runs fully convolutional at 512+ px. The fp16 export is fixed at 320²; `freeImageDims` frees the dims.
- One weakness: on the portrait sample it misses a sun-flared patch of sky beside the head (see Known gaps).

### Presets (`src/presets/ai-sky.ts`)
- `ai.sunsetSky`: Sky Replace with the procedural sunset, warm relight 0.65, edge light and haze.
- `ai.dramaticSky`: stormy sky. The foreground (an inverted Sky Mask, sharing the analysis) gets −0.6 EV and +0.2 contrast through `composite.mix`.
- `ai.cleanHighIso`: AI Denoise with luma 0.9, chroma 1 and detail 0.2.
- `ai.gradFilter`: Sky Mask `horizon` → `composite.mix` of the image and an `color.exposure` (−1 EV) → `color.whiteBalance` copy.
  It acts like a physical graduated ND/colour filter, tilted with the horizon.

### Models (`src/core/ai/models-denoise.ts`)

| Model | File used | Size | Licence | Source |
|---|---|---|---|---|
| SCUNet color real PSNR | `scunet_color_real_psnr.onnx.data` (weights) + `.onnx` (graph, 3.8 MB) | 73.1 MB | Apache-2.0 (cszn/SCUNet) | [Heliosoph/scunet-onnx](https://huggingface.co/Heliosoph/scunet-onnx) @ `6d11417e` |
| SCUNet color real GAN | `scunet_color_real_gan.onnx.data` + `.onnx` | 73.1 MB | Apache-2.0 | same repo and commit |
| SkySeg U²-Net | `skyseg_fp16.onnx` (fp16 weights, fp32 I/O) | 88.1 MB | MIT | [voyagerfromeast/skyseg](https://huggingface.co/voyagerfromeast/skyseg) @ `d76f97cf`, from [xiongzhu666/Sky-Segmentation-and-Post-processing](https://github.com/xiongzhu666/Sky-Segmentation-and-Post-processing) |

Loading details:
- **SCUNet** is a torch export with *external data*. The catalog downloads the 73 MB `.onnx.data` as the model file,
  so the toast and the AI Models list show the real size. `prepare` then fetches the small graph (also cached in
  `darkroom-models`) and `inlineExternalData()` rewrites each external `TensorProto` to inline `raw_data`. The result was checked bit-exact against
  onnxruntime (CPU) with the external file.
  - SCUNet pads to a multiple of 64 internally.
  - It runs on WebGPU (Einsum, ScatterND and ScatterElements are supported).
- **SkySeg** has 320² fixed dims, which `freeImageDims` frees. Its MaxPools use `ceil_mode`, which the ORT 1.31 WebGPU EP lacks
  (the reason `u2netp` is WASM-only). U²-Net downsamples by at most 32 and the node always feeds multiples of 32, so every
  pooled size is even and `ceil_mode` changes nothing. `dropMaxPoolCeil()` removes it, which allows WebGPU (verified identical in onnxruntime).
  The same trick should work for `u2netp` at 320².
- Pre-processing: ImageNet mean/std. The output is the sigmoid probability, used as-is.

Alternatives considered:
- **NAFNet-SIDD** (MIT): the browser-usable width-32 fp16 export is 124 MB, and SIDD is smartphone-only noise.
- **Restormer** (MIT): too heavy for a browser.
- **DnCNN / FFDNet**: weak on real noise. The Qualcomm exports are zips on S3.
- **Real-ESRGAN wdn**: not a 1× denoiser.
- **SkyWater SegFormer-B2** (MIT, 50 MB fp16, dynamic dims, [Realcat/skywater_seg](https://huggingface.co/Realcat/skywater_seg)):
  it labelled the whole sunlit field in `portrait` as sky and a water reflection in `street`, so SkySeg won.
- **SkySeg fp32** (176 MB, JianyuanWang/bukuroo): the same model at twice the size.

### Timings
Apple-silicon Mac, Chromium (`channel: 'chromium'`, real Metal WebGPU), ORT 1.31.1, warm:

| Model / input | WebGPU | WASM 4 threads (COOP/COEP) | WASM 1 thread |
|---|---|---|---|
| SCUNet, one 256² tile | ≈0.47 s | ≈1.5 s | ≈4.6 s |
| AI Denoise 600×750 preview (12 tiles) | ≈6 s | ≈18 s | ≈55 s |
| AI Denoise 1600×1067 export (35 tiles) | ≈17 s | ≈55 s | ≈2.7 min |
| SkySeg 768×512 (default 512 short side) | ≈0.39 s (first run ≈1 s) | ≈2.9 s | ≈11.5 s |
| SkySeg 512×640 (portrait) | ≈0.46 s | n/a | ≈9.4 s |

The WASM rows for whole images are tiles × the per-tile time. A tile size of 384–512 is a little faster per pixel on WebGPU.

### Known gaps (denoise / sky)
- AI Denoise on WASM is slow for big exports, minutes for 10+ MP. A running job isn't cancelled when params change.
- SCUNet removes the noise's *mean* too: in crushed JPEG shadows, where the noise was clipped at 0, blacks can look slightly lifted.
- The sky model misses sky that looks unlike sky. On `portrait`, a sun-flared whitish patch right of the head stays foreground at any threshold.
  The colour-extend step only adds flat areas within ≈0.14 of the row's sky colour.
- Hazy, low-contrast distant hills (left of `street`) get a partial α, so a thin band of the old sky can stay visible there.
- The horizon fit is one straight line. It assumes the sky is at the top and does not model curved horizons.
- Connecting a non-sky photo to `sky` works, but it is placed bottom-on-horizon; use `skyScale`/`skyOffset` to frame it.
- Procedural clouds are stylised (domain-warped fbm), not photographic.

## People: faces, face restoration, pose, smart crop

| Node | Id | Outputs | What it does |
|---|---|---|---|
| Face Detection & Landmarks | `ai.faces` | `mask`, `features` (masks), `overlay` (image) | Every face as a feathered oval traced from the 478-point landmark silhouette; a selectable feature region; the mesh / contours / points / boxes drawn on the image |
| Face Restoration | `ai.faceRestore` | `out` | Aligns each face to 512×512 (5-point similarity transform), restores it (RestoreFormer++ or GFPGAN v1.4), warps it back and blends it with a feathered face mask |
| Pose / Body | `ai.pose` | `mask`, `parts` (masks), `overlay` (image) | Person mask, a body-part mask (hair, skin, face skin, body skin, clothes, accessories), and a glowing motion-capture skeleton |
| Smart Auto-Crop | `ai.autoCrop` | `out` (smaller) | Best crop of a target aspect: subject kept whole, faces with headroom and eyes near the upper third, rule of thirds, nothing cut in half |

**`ai.faces` params:**
- `maxFaces` (largest first, up to 64) and `minConfidence`.
- `region` (the `features` output): *Face skin* (the oval minus eyes, brows and mouth), *Eyes*, *Irises* (clipped to the eye opening), *Eyebrows*, *Eyes + brows*, *Nose*, *Lips* (without the mouth opening), *Mouth (lips + inside)*, *Whole face*.
- `feather` and `dilate` (px, scale-aware; `dilate` < 0 shrinks). Both apply to `mask` and `features`.
- `style` (*Mesh*, *Contours*, *Points*, *Boxes*, *Mesh + boxes*), `color`, `lineWidth`.
- Faces the landmarker can't fit (strong profiles, heavy occlusion) still show as a dashed YuNet box with its 5 keypoints, and as an ellipse in `mask`.

**`ai.faceRestore` params:**
- `strength`: mix with the original.
- `maxFaces`: up to 16, largest first.
- `small`: also restore faces whose eyes are less than 24 px apart (full res). These faces have the most invented detail.
- `model`: *RestoreFormer++ (74 MB)* or *GFPGAN v1.4 (340 MB)*.
- `keepColor` (default on): moves each restored face to the photo's colour cast and tone. It uses a per-channel mean/std transfer inside the blend mask, with half of the contrast change. Without it, the restorers neutralise graded skin tones.
- `showMask`: shows the blend masks.

**`ai.pose` params:**
- `part`: what the `parts` output selects.
- `maskSource`: *Multiclass* (sharper, includes hair) or *Pose segmentation*.
- `model`: *Lite* or *Full*.
- `maxPeople`, `minConfidence`.
- `refine`: edge-aware upsample of both masks.
- `feather`.
- Skeleton: `style` (*Motion capture*, *Left / right colours*, *Lines only*, *Joints only*), `lineColor`, `jointColor`, `thickness` (px), `glow`, `glowRadius` (px), and `dim` (darkens the photo under the skeleton).

**`ai.autoCrop` params:**
- `aspect`: 4:5, 1:1, 3:2, 2:3, 16:9, 9:16, 4:3, 3:4, 5:4, original, or custom (`customW`:`customH`).
- `zoom`: 0 = the largest crop of that aspect, 1 = 40 % of it.
- `mode`:
  - *subject*: keeps the subject whole and centred.
  - *faces*: headroom, eyes near the upper third, and faces never cut.
  - *thirds*: puts the subject on a thirds point.
- `padding`: the margin the subject should stay out of.
- `showOverlay`: outputs the full image with the crop rectangle and thirds guides, instead of cropping.

How auto-crop works:
- **Size.** The crop size depends only on the params and the input size, so `size()` can report it. The content only picks the position.
- **Scoring.** The score combines:
  - the kept share of the subject;
  - saliency along crop edges that lie inside the image (cutting through the subject);
  - subject mass in the padding margin;
  - thirds or centre placement;
  - face terms: a cut face is penalised most, a face left out entirely is penalised, plus headroom and eye-line terms.
- **Search.** It is a 41×41 grid search plus a local refinement, so it is deterministic. The pure maths is unit-tested in `autocrop-score.test.ts`.
- **Saliency.** It comes from the existing U²-Net-p model, through the `subjectMatte()` helper now exported by `ai.subjectMask` (no duplicated model code). Face and head boxes are added on top.

### How faces are found (`src/nodes/ai/face-analysis.ts`)
1. **MediaPipe Face Landmarker** runs on the whole image. It finds big faces only: its built-in BlazeFace *short-range* detector misses faces smaller than about 1/10 of the frame.
2. **YuNet** (OpenCV Zoo, MIT, 232 kB, via ONNX Runtime on WASM) runs on the image at ≤ 1280 px. It finds faces down to about 10 px. Its 640×640 export is made size-free with `freeImageDims`.
3. **Crops.** The landmarker runs again on a crop of about 2.4× each YuNet box, keeping only the face that overlaps that box.
4. **Merge.** Duplicates are merged by IoU, preferring crop results. YuNet boxes left without landmarks are kept as `extra` (box + 5 keypoints).

The result is memoised by input fingerprint (`InferenceMemo`), so `ai.faces`, `ai.faceRestore` and `ai.autoCrop` on the same image share one detection, at any render scale.

Two approaches were tested and rejected:
- **BlazeFace full-range** (`blaze_face_full_range.tflite`) loads in the Tasks FaceDetector, but it returns no detections: the Tasks graph only configures short-range anchors.
- **Tiling with the short-range detector** would need hundreds of tiles for 50 px faces.

Tested on the Solvay 1927 group photo (1920×1389): all 29 faces were found, with landmarks aligned on 50 px faces.

### How bodies are found (`src/nodes/ai/pose-analysis.ts`)
- **Pose is top-down where faces are known.** Pose Landmarker runs with one pose on a crop around each detected face. A pose is accepted when its nose falls in that face box.
- **Why top-down.** On group photos, MediaPipe's own multi-pose output mixes the limbs of neighbours, and it also missed tight portraits.
- **Whole-image pass.** A whole-image pass adds the people without a detected face (e.g. seen from behind, `street.jpg`) and provides the segmentation masks.
- **Crops are landmarks-only.** Segmentation on small crops trips a MediaPipe check (`image_frame.cc: Check failed: 1 == ChannelSize()`, then a WASM abort). Re-configuring one task with `setOptions` also aborted, so each (count, confidence, masks) combination gets its own cached task.
- **Selfie Multiclass** (256×256, trained on selfies) runs on a padded crop around the people the pose model found, not on the whole frame. This gives much more detail on full-body shots.
- **Mask cleanup.** Confidences under 0.12 are floored to 0. This removes haze and the seam at the crop edge.

### Presets (`src/presets/ai-people.ts`)
- `ai.beautyRetouch`:
  - the `ai.faces` *Face skin* region (feathered, shrunk 2 px) masks frequency separation;
  - inside it, a surface blur on the low frequencies plus 85 % of the texture back, mixed in at 65 %;
  - eyes, brows and lips stay sharp.
- `ai.hairRecolor`: the `ai.pose` *Hair* part masks an HSL shift (default −40° hue, +0.35 saturation). Its *part* knob is exposed, so it also recolours clothes or skin.
- `ai.restorePortrait`: `ai.faceRestore` (strength 0.8) followed by subtle grain.
- `ai.motionCapture`: the `ai.pose` overlay with the photo darkened 82 %, a cyan glow skeleton and a cool bloom.
- `ai.instagramCrop`: `ai.autoCrop` at 4:5 in *faces* mode.

### Models (people)

| Model | File | Size | Licence | Source |
|---|---|---|---|---|
| MediaPipe Face Landmarker (BlazeFace short-range + Face Mesh v2, 478 pts) | `face_landmarker/face_landmarker/float16/1/face_landmarker.task` | 3.8 MB | Apache-2.0 | storage.googleapis.com/mediapipe-models |
| MediaPipe Pose Landmarker lite / full | `pose_landmarker/pose_landmarker_{lite,full}/float16/1/…task` | 5.8 / 9.4 MB | Apache-2.0 | same |
| MediaPipe Selfie Multiclass 256×256 | `image_segmenter/selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite` | 16.4 MB | Apache-2.0 | same |
| YuNet 2023mar | `face_detection_yunet_2023mar.onnx` (fp32) | 0.23 MB | MIT | [opencv/face_detection_yunet](https://huggingface.co/opencv/face_detection_yunet) @ `3cc26e7f` |
| RestoreFormer++ (default) | `restoreformer_pp_int8w.onnx` (int8 weights, fp32 compute) | 74.4 MB | Apache-2.0 | [Saimon8420/restoreformer-pp-web](https://huggingface.co/Saimon8420/restoreformer-pp-web) @ `9e5912e0` |
| GFPGAN v1.4 (option) | `GFPGANv1.4.onnx` (fp32) | 340.3 MB | Apache-2.0 | [neurobytemind/GFPGANv1.4.onnx](https://huggingface.co/neurobytemind/GFPGANv1.4.onnx) @ `e3fd467e` |

All the MediaPipe paths are pinned to model version `1`; the server sends `Access-Control-Allow-Origin: *`.

Notes on the choices:
- **RestoreFormer++ is the default, not GFPGAN.** Every browser-usable GFPGAN v1.4 ONNX export is 340 MB fp32, and no fp16 export exists. The RestoreFormer++ web export is 74 MB, with a mean output difference of 0.7/255 against the original, and it runs on WebGPU and WASM. GFPGAN remains selectable. Its weights are Apache-2.0; the GFPGAN repository also lists third-party components (CUDA ops) that this ONNX graph doesn't use.
- **CodeFormer was not used:** S-Lab licence, non-commercial.
- **GPEN was not used:** its repository has no licence.
- **The int8 weights are kept for WebGPU too.** The fp16-weight RestoreFormer++ file (148 MB) is the same speed on WebGPU, so only the int8 one is registered.
- **@mediapipe/tasks-vision is pinned to 0.10.35** (Apache-2.0), not the newer 1.x. Releases 1.0+ send usage metrics from the browser to `odml.pa.googleapis.com`, and the package README makes the app responsible for user consent. 0.10.35 is the last release without that upload, so "nothing leaves the device" still holds. The built bundle contains no `odml.pa` reference.

Attribution:
- MediaPipe (Google), Apache-2.0: BlazeFace (Bazarevsky et al., 2019), Face Mesh / attention mesh (Grishchenko et al., 2020), BlazePose GHUM (Bazarevsky et al., 2020; Xu et al., 2020), Selfie Multiclass.
- YuNet: W. Wu, H. Peng, S. Yu, *YuNet: A Tiny Millisecond-level Face Detector*, Machine Intelligence Research 2023. OpenCV Zoo, MIT.
- RestoreFormer++: Z. Wang, J. Zhang, T. Chen, W. Wang, P. Luo, *RestoreFormer++: Towards Real-World Blind Face Restoration from Undegraded Key-Value Pairs*, TPAMI 2023. [github.com/wzhouxiff/RestoreFormerPlusPlus](https://github.com/wzhouxiff/RestoreFormerPlusPlus).
- GFPGAN: X. Wang, Y. Li, H. Zhang, Y. Shan, *Towards Real-World Blind Face Restoration with Generative Facial Prior*, CVPR 2021. [github.com/TencentARC/GFPGAN](https://github.com/TencentARC/GFPGAN).

### Runtime additions (additive)
- **`src/core/ai/mediapipe.ts`** is the MediaPipe runtime:
  - **Bundling.** The WASM loader and binary (`@mediapipe/tasks-vision/vision_wasm_internal.{js,wasm}`) are imported with Vite `?url`. In the build they are emitted as hashed assets: the 11.2 MB wasm and the 322 kB loader. The tasks-vision JS (135 kB) is a lazy chunk.
  - **Caching.** Both runtime files and the models are fetched cache-first into `darkroom-models` with progress, through `runtime.download()`. MediaPipe gets them as blob URLs and `modelAssetBuffer`, so the PWA and Electron work offline after the first use.
  - **Main thread.** Tasks run on the main thread (MediaPipe's loader is a classic script that hands over `self.ModuleFactory`), with `runningMode: 'IMAGE'`.
  - **Task creation** is serialised and cached per task.
  - **Delegate.** CPU (XNNPACK) by default: deterministic, and faster than the GPU delegate for these small models (see the timings). The GPU delegate is used when the AI preference is WebGPU, or with `?mpDelegate=GPU`. It renders into MediaPipe's own OffscreenCanvas WebGL context, not the engine's.
  - **Timings** are exposed at `window.__darkroomMp.timings`.
- **`src/core/ai/models-face.ts`** registers YuNet, RestoreFormer++ and GFPGAN in the catalog.
- **`models.ts`:**
  - the task kinds `face`, `pose` and `face-restoration`;
  - an optional `external` flag on `ModelInfo`: the MediaPipe models are listed in *Plugins › AI Models*, and *Download* only caches them.
- **`runtime.ts`:**
  - `download()` is exported;
  - `prefetchModel()` only downloads `external` models.
- **`subject.ts`** exports `subjectMatte(src, 'portrait' | 'object')`, the same memo and preprocessing that `ai.subjectMask` uses.
- **Restoration in the shader.** `ai.faceRestore` keeps the restored crops in an RGBA8 atlas, with alpha = the blend mask. The per-face affines reach the shader as float32 bit patterns in an RGBA8 data texture: they are decoded with `uintBitsToFloat`, because RGBA16F is too coarse for them. `ai.autoCrop` passes its crop position the same way.

### Timings (people)
Measured on an Apple-silicon Mac in headless Chromium, cold (first run in a fresh profile, including the task or shader set-up):

| Step | CPU delegate / WASM | GPU delegate / WebGPU |
|---|---|---|
| YuNet, 1280×1024 | ≈0.1 s (WASM, 1 thread) | n/a (always WASM) |
| Face analysis, 1 face (portrait 1200×1500) | ≈1.0 s | — |
| Face analysis, 7 faces (1920×1536) | ≈2.3 s | ≈5.9 s |
| Face analysis, 29 faces (Solvay 1920×1389) | ≈1.4 s | — |
| Pose lite, one whole-image pass (1024 px) | 85–165 ms | — |
| Pose, top-down + whole image (street 1600×1067) | ≈1.3–1.9 s | ≈6.9 s |
| Selfie Multiclass, ≈512×380 | ≈0.2 s | ≈4.0 s |
| RestoreFormer++, one face 512×512 | ≈17 s (WASM, 1 thread) | ≈0.72 s warm, ≈0.93 s first (WebGPU) |

- **MediaPipe task creation** takes ≈0.1 s per task, once the 11 MB wasm is cached.
- **Restoring a group** costs one model run per face, plus ≈0.1 s of CPU warping per face.
- **After the first run**, the analyses are cached per image: changing feather, region, style, strength, aspect and so on only redraws or recomposites (≈0.1–0.5 s, mostly the input readback).

### Testing (people)
```bash
node scripts/snap.mjs out.png "node=ai.faces&img=portrait&wait=120&port=overlay"
node scripts/snap.mjs out.png "node=ai.pose&img=street&wait=120&port=parts"
node scripts/snap.mjs out.png "node=ai.autoCrop&img=street&wait=120&params={\"aspect\":\"1:1\",\"showOverlay\":true}"
SNAP_TIMEOUT=900000 node scripts/snap.mjs out.png "node=ai.faceRestore&img=portrait&wait=900"   # slow on WASM
```
- In a query string, `+` decodes to a space: write `Mesh%20%2B%20boxes`.
- Unit tests: `src/nodes/ai/face-geom.test.ts` (similarity transform, five points, IoU/NMS/merge, YuNet decoding) and `src/nodes/ai/autocrop-score.test.ts`.
- Relighting unit tests: `src/nodes/ai/relight-math.test.ts` (normal-map encode/decode and the OpenCV → OpenGL flip, light vectors for point / rim / directional lights, wrap, Blinn exponent, spot cone, the 4×4 shading-fit solve, MoGe post-processing, rig params).

### Known gaps (people)
- **Profiles.** MediaPipe's face mesh is unreliable on strong profiles: one profile in the STS-135 crew photo got a poor mesh, while the other three fell back to YuNet boxes. Feature masks need landmarks.
- **Tight portraits.** BlazePose finds no pose on tight head-and-shoulders portraits (`portrait.jpg`), so there is no skeleton there. The person and part masks still work.
- **Crowded groups.** Some top-down poses in crowded groups are still wrong or missing (6 of 7 people on Expedition 64).
- **Occlusions in restoration.** Restoration hallucinates through occlusions: a flower held in the mouth became teeth. Large, already-sharp faces gain little and lose some fine detail at 512 px, so use a lower strength for those. CPU restoration is slow (≈17 s per face single-threaded).
- **Auto-crop size.** The crop size follows `zoom`, not the content: `size()` cannot depend on the image. Very tight crops can trade headroom against the eye line.
- **Pose masks** come from the whole-image pass only (see above). The Multiclass mask is the default anyway.

## Relighting

| Node | Id | Outputs | What it does |
|---|---|---|---|
| Surface Normals | `ai.normals` | `normals` (image), `depth` (mask, near = white), `mask` (geometry, ≈ not sky) | MoGe-2 ViT-S: per-pixel surface normals and an affine point map in one pass, upsampled edge-aware |
| Relight | `ai.relight` | `out` | Up to 3 lights (point / spot / directional), hemisphere ambient, soft area-light shadows, contact shadows, ambient occlusion, specular, wrap / subsurface; *Replace lighting* divides out an estimate of the existing light first |

Typical graph: `image → Surface Normals`, then `normals` and `depth` → Relight (the presets do this). Relight also
works with only a depth map (e.g. `ai.depth`, as old projects have it); its normals are then derived from the depth.

### `ai.normals` (Surface Normals)
- **Output convention:** the normal map uses the OpenGL convention: red = right, green = **up**, blue = towards the
  viewer, `rgb = n · 0.5 + 0.5` (a wall facing the camera is lilac-blue `(0.5, 0.5, 1)`). MoGe's OpenCV camera-space
  normals (x right, y down, z forward) are converted with `(x, −y, −z)` (`cvToGl` in `relight-math.ts`).
- **Depth output:** disparity `1 / z` of MoGe's point map, spread between the 0.5 and 99.5 percentiles of the valid
  pixels, near = white; pixels outside MoGe's geometry mask (sky) are 0. Same semantics as `ai.depth`, so either
  can drive Relight, Tilt-Shift, Depth Fog…
- **Params:**
  - `resolution`: short side fed to the model, 392 / 518 (default) / 672. MoGe resizes internally, so this mostly sets
    the output resolution before the upsample.
  - `detail`: number of ViT tokens: *Fast* 1200 / *Balanced* 1800 (default) / *Fine* 2500 (MoGe's suggested range).
  - `strength`: scales the tangential part of the normals (< 1 flattens, > 1 exaggerates).
  - `edges`, `smoothing`: the joint-bilateral upsample (`jbu4` in `_shared.ts`, all four channels).
  - `flatSky`: where MoGe sees no geometry, the normal faces the camera instead of noise.
- **Inference** runs once per image content, inference size and token count (`InferenceMemo`), so every Relight
  change is free. Like every `ai.*` node it is *heavy*: it evaluates at the fit-to-window preview scale in the viewer.

### `ai.relight` (Relight)
Inputs `image`, `normals` (optional; takes priority), `depth` (optional; mask, near = white). It is **pure GPU**
(`heavy: false`): it re-renders at the viewer's own resolution, while Surface Normals stays cached. Dragging a light
on the studio preset costs ≈9–10 ms at the 600×400 preview and ≈40–55 ms at 1600×1067, both including a full readback
(Metal, M2 Pro).

**Lights** (light 1 always on; `on2`, `on3` switch the others):
- `type`, `type2`, `type3`:
  - *Point*: a lamp at the handle;
  - *Spot*: a lamp at the handle aiming straight into the scene (a pool of light); `spotAngle` and `spotSoftness`;
  - *Directional*: a sun. The handle's offset from the image centre sets the direction, `height` the elevation.
- `light`, `light2`, `light3`: the handle positions, dragged in the viewer.
- `height…`: in image heights in front of the nearest surface. Negative values put the light behind the subject
  (rim / back light).
- `color…`, `intensity…`.
- `size…`: radius of the light in image heights; it sets the shadow penumbra.
- `falloff`: inverse-square strength for point and spot lights.
- `background`: extra distance (image heights) of the far background (depth ≈ 0) from point and spot lights, so a
  lamp near the subject does not light a distant backdrop or the sky. 0 = plain depth.

**Environment:**
- `ambient` (old param, same meaning): the level of what the lights miss.
- `skyColor` / `groundColor`: a hemisphere ambient: surfaces facing up get the first, facing down the second (bounce).
- `occlusion`: depth-based ambient occlusion (8 rotated taps at two radii; only rises within `thickness` count).

**Blend** (`mode`):
- *Add light*: `base·env + base·lights + ½·specular`;
- *Multiply shade*: only darkens, towards the ambient where the lights don't reach;
- *Full relight*: `base·(env + lights) + specular` (the old default);
- *Replace lighting* (new default): `albedo·(env + lights) + specular`, with `albedo = base / S_old`.

**Removing the existing light (approximate delighting):** `S_old = S_fit^delight · S_lf^evenOut`.
- `S_fit` is a ridge-regularised least-squares fit of linear luminance against the normals, `Y ≈ c0 + c·n`, on a
  40 × 40 grid. Very dark, clipped and far-background pixels are left out. It recovers the dominant direction of the
  old light. The 4×4 normal equations are built and solved on the GPU (two tiny passes). `S_fit` is that fit at the
  pixel's normal, relative to a camera-facing normal, clamped to 0.4–2.5.
- `S_lf` is the low-frequency, edge-aware (bilateral in log space, 96 px) luminance relative to its mean, clamped to 0.5–2.
- The division fades out in near-black areas, where it would only amplify noise and dark albedo.
- `keepBackground` keeps the far background (sky, distant scenery) as it was: the sky is a light source, not a lit
  surface.

**Shadows:**
- **Area lights.** For each light, 4 rays go to jittered points on a disc of radius `size × 2·shadowSoftness`. Each ray
  takes 12 steps with quadratic spacing (dense near the start); the result is the mean of the rays (a real penumbra).
  The jitter noise is removed by a depth-aware 5×5 blur. The shadow buffer is capped at a 1280 px long side.
- **Contact shadows** (`contact`): an extra short (3 % of the image height), crisp march along the central ray.
- **Rim and halo fixes:**
  - *Finite thickness* (`thickness`, 0..1 of the depth range): a surface only occludes a ray that passes less than this
    below it. Without it, the depth map behaves like a solid wall, and a person casts a hard "ghost" of their outline
    onto the sky. That was the main artefact of the old node.
  - *Silhouette ramps never occlude* (`edgeSlope`): the few pixels at an object outline where upsampling blends
    subject and background depth would otherwise shadow a sliver right next to every silhouette. Pixels whose depth
    slope is steeper than `edgeSlope` (depth range per image height) are dropped from the occluder buffer.
  - *The far background is at infinity*: depth ≈ 0 never receives cast shadows or occlusion.
  - *Depth-only normals use edge-aware gradients*: per axis, the one-sided difference with the smaller magnitude, at
    1×, 2× and 4× `radius`. A depth step therefore no longer tilts the pixels on either side of it (the old bright and
    dark rims).
- `shadows`, `shadowStrength`, `depthScale` as before.

**Material:**
- `specular` and `roughness`: Blinn-Phong with exponent `2 / r⁴ − 2`, gated by the shadows.
- `wrap` and `subsurface`: wrap diffuse `(n·l + w) / (1 + w)`; the wrapped part is tinted with the subsurface colour (skin).
- `shape`: normal gain. `strength` and `radius` apply only when there is no normals input.

**Output:** `exposure` (EV), `amount` (mix with the original), and `view`, a debug view:
- *Result*;
- *Light only*;
- *Normals*;
- *Shadows*: the visibility of lights 1–3 in RGB, × the AO;
- *Albedo (delit)*;
- *Old shading*.

**Viewer tool:** a multi-handle points tool (`handles`, see *Viewer tools* above). Each enabled light is a labelled lamp
tinted in its colour. Drag a lamp to move it; a click elsewhere moves the light selected in the HUD.

**Compatibility:** the id and every old param key and meaning are unchanged (`light`, `height`, `color`, `intensity`,
`falloff`, `ambient`, `mode` with the old three options, `strength`, `radius`, `depthScale`, `shadows`,
`shadowSoftness`, `shadowStrength`, `specular`, `showLight`). New params take their defaults. Old projects therefore
load and render without changes to the graph. They do look different, because the fixes apply:
- no ghost shadows or rims;
- the far background is no longer lit by point lights. Set *Background distance* to 0 for the old behaviour there.

### Presets (`src/presets/ai-select.ts`, rigs in `relight-math.ts` `RIGS`)
All of them are Surface Normals → Relight (*Replace lighting*). Each exposes the light positions (draggable in the
viewer), the intensities, colours, ambient, shadows, *Remove old light* and *Amount*.

| Preset | Lights |
|---|---|
| `ai.dramaticRelight` | One warm lamp low at the upper left, ambient 0.2, a vignette |
| `ai.studioPortrait` | Spot key upper left, cool point fill right, rim light behind (height −0.25) |
| `ai.rimLight` | Two back lights (cool left, warm right), weak front fill |
| `ai.goldenHourRelight` | Low warm directional sun from the left, cool sky fill, a touch of vibrance |
| `ai.overheadNoon` | Hard directional sun from almost straight above, blue-sky ambient, the sky kept |
| `ai.neonRelight` | Magenta and cyan point lights left and right, dark ambient |
| `ai.candleRelight` | One small warm light low in front, fast falloff, near-black ambient, a vignette |

### Model

| Model | File used | Size | Licence | Source |
|---|---|---|---|---|
| MoGe-2 ViT-S normal | `model.onnx` (fp32, dynamic H×W, opset 14) | 140.9 MB | MIT (code and weights); DINOv2 backbone Apache-2.0 | [Ruicheng/moge-2-vits-normal-onnx](https://huggingface.co/Ruicheng/moge-2-vits-normal-onnx) @ `e50ffda4` (the official export by the first author) |

- **I/O:** inputs `image` (1×3×H×W, RGB 0..1; the normalisation is in the graph) and `num_tokens` (int64 scalar).
  Outputs `points` (1×H×W×3), `normal` (1×H×W×3, unit), `mask` (1×H×W), `scale`.
- **Backends:** it runs on the WebGPU EP of ORT 1.31.1 without patches, including its `If`, `Round` and `Mod` ops.
  WebGPU and WASM outputs match: the mean difference of the rendered normal map is 0.04/255.
- **CORS:** `access-control-allow-origin` is served.

Attribution: R. Wang, S. Xu, Y. Dong, Y. Deng, J. Xiang, Z. Lv, G. Sun, X. Tong, J. Yang, *MoGe-2: Accurate Monocular
Geometry with Metric Scale and Sharp Details*, 2025. [github.com/microsoft/MoGe](https://github.com/microsoft/MoGe).

### Timings (Apple M2 Pro, ORT 1.31.1, warm)

| Step | WebGPU (Metal) | WASM 1 thread |
|---|---|---|
| MoGe-2 ViT-S, 518×644 (portrait), 1800 tokens | ≈0.62 s (first run ≈1.2 s) | ≈13.0 s |
| MoGe-2 ViT-S, 770×518 (street), 1800 tokens | ≈0.63–0.68 s | ≈13.3 s |
| Relight after a light move, 600×400 preview | ≈9–10 ms incl. readback | (WebGL, same) |
| Relight after a light move, 1600×1067 | ≈40–55 ms incl. readback | (WebGL, same) |

The first use downloads 140.9 MB (the model) plus the ORT runtime.

### What was considered and rejected
Checked in November 2026 with the Hugging Face API, the repositories' licence files, and runs in onnxruntime (CPU) and
in Chromium (Metal WebGPU).

**Normal estimators:**
- **Metric3D v2 ViT-S** ([onnx-community/metric3d-vit-small](https://huggingface.co/onnx-community/metric3d-vit-small) @ `ee63b95d`):
  - it works, at 75.8 MB fp16 (fp16 I/O) or 150.7 MB fp32, with outputs `predicted_depth`, `predicted_normal` and `normal_confidence`;
  - its code is BSD-2-Clause, but the README sends commercial use to the authors, and the HF card says CC0;
  - on `street` it read the lake's reflections as a vertical wall, where MoGe-2 got the water plane right;
  - MoGe-2 also gives sharper detail (flowers) and depth + mask from the same pass. Kept as the fallback candidate.
- **DSINE:** Imperial College licence, "non-commercial, internal or academic research purposes" only.
- **Omnidata** (DPT-hybrid normals): trained on the Omnidata Starter Dataset, whose EULA is non-commercial; no ONNX either
  (`jzhangbs/dpt-hybrid-omnidata-normal` is a 490 MB PyTorch file).
- **Sapiens normal:** CC-BY-NC (Meta), excluded; the onnx-community 0.3B export is 245 MB–1.36 GB anyway.
- **HyDen MoGe-v2 surface normal** (facebook): FAIR non-commercial licence, 1.46 GB.
- **DeepBump** (ONNX, 26.7 MB): GPL-3.0, and made for textures, not photos.
- **Diffusion normal estimators:** StableNormal (Apache-2.0, ≈3.4 GB of fp16 weights), Marigold-normals (Apache-2.0,
  1.7 GB UNet fp16) and Lotus-normal (Apache-2.0, 3.5 GB UNet fp32). None has an ONNX export, they run many SD steps,
  and they are far too heavy for a node that should take about a second.

**Intrinsic decomposition (delighting):**
- **compphoto/Intrinsic** (Careaga & Aksoy, ordinal shading): "academic use only", patent notice.
- **RGB↔X:** non-commercial. Excluded as briefed.
- No permissive intrinsic model with an ONNX export was found. The delighting is therefore the normals-based fit plus
  the low-frequency luminance described above. It is approximate: strong cast shadows and coloured light in the
  original survive partly.

**Diffusion relighting / ControlNet in the browser:**
- **IC-Light** (lllyasviel; SD1.5 fine-tune for foreground relighting):
  - *Licences.* The code is Apache-2.0. The weight repo [lllyasviel/ic-light](https://huggingface.co/lllyasviel/ic-light)
    (`iclight_sd15_fc/fbc/fcon`, 1.72 GB each) states no licence. The weights derive from SD1.5 (CreativeML OpenRAIL-M).
  - *The only ONNX port.* [Daankular/ic-light-onnx-fc](https://huggingface.co/Daankular/ic-light-onnx-fc) @ `696ef1db`
    is a third-party export from July 2026 on a Realistic Vision 5.1 base, with no licence and no model card. Its files:
    UNet 1.72 GB (fp16 weights, external data), CLIP text encoder 492.6 MB, VAE decoder 198.1 MB, VAE encoder 136.8 MB.
    That is **≈2.55 GB** in all.
  - *Measured here.* That UNet runs in ORT-web 1.31.1 on Metal WebGPU (M2 Pro, 16 GB):
    - session creation ≈3–4 s;
    - **≈0.8 s per step at 512×512** and ≈1.13 s at 640×512, at batch 1;
    - classifier-free guidance doubles the batch.
  - *Estimated total.* 20–25 steps plus the text encoder and the VAE is roughly 35–60 s per image at 512–640 px, after
    a 2.5 GB download. The result also has to be upscaled and detail-transferred back onto the photo: IC-Light
    re-renders the subject at 512–768 px, and faces drift.
  - *Not built.* The project does not ship models without a clear licence (as with Zero-DCE and GPEN), and the cost is
    out of proportion for an editor node. It becomes possible if an explicitly licensed IC-Light ONNX (ideally
    fp16 + int8 text encoder) appears. The runtime would then need multi-file external data (`externalData` in the
    session options; the benchmark used it successfully), a CLIP BPE tokenizer and a scheduler.
- **Stable Diffusion + ControlNet:**
  - ControlNet SD1.5 ONNX exports (`ForserX/sd-controlnet-*-onnx`, ≈724 MB each, no licence file) need a 1.7–3.4 GB SD1.5 UNet on top;
  - LCM-Dreamshaper-v7 ONNX (MIT card): 4.27 GB fp32;
  - SD-Turbo ORT-web (`schmuell/sd-turbo-ort-web`): Stability AI *non-commercial* licence;
  - MLC web-stable-diffusion: SD1.5 only, no ControlNet, Chrome WebGPU needs a GPU with ~8 GB of memory.
  - None is a relighting model; all would generate a new image rather than relight this one.

### Known gaps (relighting)
- **Screen-space geometry.**
  - Shadows come only from what is in the frame and visible; hidden back sides don't exist.
  - The depth is relative (MoGe's affine point map or Depth Anything's disparity), so `depthScale`, `thickness` and the
    light heights are photo-dependent.
- **Approximate delighting.**
  - Strong hard shadows, coloured light and specular highlights in the original are only partly removed.
  - Very dark albedo (black hair, a forest in shade) is deliberately left alone, so it cannot be brightened by delighting.
- **Fine structures.** MoGe-2 at 1800 tokens gives trees and grass "striped" normals; raking light (golden hour) makes
  that visible on forests. Lower *Surface relief* or *Normal strength*.
- **Depth-only graphs.** With only `ai.depth` (old projects), the soft depth ramp at outlines can still leave a faint
  light seam; Surface Normals avoids it.
- **No exposure normalisation.** *Replace lighting* applies the new light as-is, so strong rigs can over- or
  under-expose a photo. Use *Exposure* or the intensities.
- **Spot lights** aim straight into the scene (−z), not at a target.

## Motion, interpolation, style from image and matting

| Node | Id | Outputs | What it does |
|---|---|---|---|
| Optical Flow | `ai.opticalFlow` | `flow` (float RG motion), `viz` (Middlebury colour wheel) | Per-pixel motion from frame A to frame B: NeuFlow v2 (default, WebGPU) or RAFT (CPU) |
| Flow Motion Blur | `effects.flowMotionBlur` (category Motion) | `out` | Directional blur along the flow, with a shutter angle |
| Flow Warp | `effects.flowWarp` (Motion) | `out` | Moves the image along the flow × amount |
| Datamosh | `effects.datamosh` (Motion) | `out` | I-frame removal: the previous output dragged along the flow in macroblocks, accumulated over frames |
| Frame Interpolation (RIFE) | `ai.frameInterp` | `out` | The in-between frame at time t between frames A and B |
| Smooth Slow Motion (RIFE) | `ai.videoSlowMo` (category Input) | `out` | A Video source whose in-between times (speed < 1) are RIFE frames instead of repeated ones |
| Video Frame (offset) | `core.videoFrameOffset` (Input) | `out` | A video N source frames before/after the timeline time, with its own decoder |
| Style from Image | `ai.styleFromImage` | `out` | AdaIN arbitrary style transfer from any `style` image |
| Background Removal (BiRefNet) | `ai.matte` | `mask`, `cutout` (RGBA) | BiRefNet lite matte, optional edge tiles, foreground colour decontamination |

**`ai.opticalFlow`:** inputs `a` (earlier frame, optional) and `b` (current frame).
- `model`: *NeuFlow v2 (fast)* (768×432) or *RAFT (WASM only)* (Sintel weights, 480×360). Both exports have fixed
  input sizes: frames are resampled to them and the flow is scaled back.
- `refine`: joint-bilateral upsampling of the flow against B, so motion edges follow object edges.
- `vizMax`: px of motion drawn fully saturated in `viz`; 0 = auto (99.5th percentile × 1.1).
- **The `flow` encoding:** RGBA float on B's pixel grid. R, G = motion of the content from A to B, divided by the image
  width / height (so it works at any render scale). B is predicted by sampling A at `uv − flow(uv)`.
  The network is run as (image1 = B, image2 = A) and negated, which gives exactly that backward-warp field.
- `viz` is the Middlebury colour wheel (Baker et al. 2011; the same 55-entry wheel as the OpenCV zoo demo):
  hue = direction, saturation = speed, white = still.

**Multi-frame inputs (design).** A node only sees its inputs at the engine's single current time, so "the previous
frame" needs either a second source or memory:
- **History (the default; `a` unconnected).** During playback and export the engine evaluates frames in order, so the
  node keeps the last few B frames it saw (per node id, model and content) and uses the one from frame f−1 (or up to
  f−3 when realtime playback dropped frames) as A. It works for any upstream graph: a Video, a Webcam, a graded or
  cropped video, and inside presets, which only have one `image` input. On a jump in time (scrub, first frame, a still
  at frame 0) there is no previous frame and the flow is zero, so every flow effect is the identity.
- **Video Frame (offset)** (`core.videoFrameOffset`, offset −1) into `a` gives exact pairs at any time, including while
  scrubbing. It has its own `VideoDecoderSource` (`privateDecoder()` in `flowSource.ts`): sampling the clip at t − 1/fps
  through the shared decoder would seek backwards on every frame, and each backward seek restarts at a keyframe.
- Rejected: a `video` asset param on the flow node (only works on raw video, not after other nodes, nor on webcams or in
  presets), and an engine-level "evaluate upstream at t − dt" node (changes engine.ts, and needs every upstream source to
  decode two times per frame).
- **Every frame** playback now waits for async node work (AI) before advancing (`timeline.ts`), so each frame is
  complete; **Realtime** still drops frames (history then spans up to 3 frames).

**`effects.flowMotionBlur`:** `shutter` (°; 180 = half the frame-to-frame motion, like a film camera), `amount`
(motion scale), `maxBlur` (px), `samples`, `centered` (around the pixel, or trailing).

**`effects.flowWarp`:** `amount` (1 with frame A as the image predicts B; 0.5 lands half-way), `steps` (follows the
field in several short steps).

**`effects.datamosh`:** `keyframe` (I-frame every N frames; 0 = only at the start or after a jump in time), `block`
(macroblock px: one motion vector per block), `gain`, `bleed` (how much of the real frame leaks in per frame), `mix`.
The accumulation runs on the CPU (≤ 1280 px long side), with the state kept per node id and frame, so re-evaluating a
frame (a parameter change, the flow arriving late) recomputes it from the previous frame's state. Frame 0 / stills pass
through.

**`ai.frameInterp`:** inputs `a` (t = 0) and `b` (t = 1); `t`; `resolution` (max short side for RIFE: Full / 1080 /
720 / 540). Within 0.001 of an end the source frame is used without inference. Frames are edge-padded to multiples of
64 (the network's requirement) and cropped back.

**`ai.videoSlowMo`:** the Video node's params (`asset`, `start`, `end`, `speed` default 0.5, `loop`) plus `resolution`.
For timeline time t it takes the source time s (trim, speed, loop as in `core.video`), finds the decoded frame k whose
interval contains s and the next one, and runs RIFE at (s − ts_k) / duration_k. Decoded frames are cached (6), so a ×4
slow motion decodes each source frame once; its decoder only moves forward during playback and export.

**Export Video › Slow motion** (*Smooth slow motion ×2 / ×4 (AI frame interpolation)*): `exportVideo()` swaps every
`core.video` node (also inside groups) for `ai.videoSlowMo` at speed ÷ factor (`slowMoGraph()`), and renders
duration × factor seconds at the chosen fps. Effects downstream run on every interpolated frame. Audio is skipped.
The export loop now also waits for chains of async nodes (up to 8 rounds, e.g. slow-motion source → flow → datamosh).

**`ai.styleFromImage`:** inputs `image` and `style`.
- `strength`: AdaIN's content–style trade-off, applied in feature space.
- `styleScale`: short side the style image is resized to (256–1024); smaller gives bigger strokes and patterns.
- `resolution`: content short side (384–1024, long side ≤ 2×, multiples of 8).
- `preserveColor`: stylised luminance with the original chroma (YCbCr).
- `mix`: blend with the original image.
- Pipeline: VGG-19 encoder (relu4_1) on the style, then per-channel mean/std, cached per style image and style
  scale. The encoder also runs on the content, and those features are cached per image and size. AdaIN then runs in JS,
  followed by the decoder. Changing `strength` re-runs only the decoder; a new photo with the same painting doesn't
  re-analyse the painting.

**`ai.matte`:**
- `resolution`: *512*, or *High detail (512 + 3×3 tiles)*. High detail is a global 512² pass plus a 3×3 grid of
  overlapping 512² tiles of a 1280² stretch. The tiles are only used in the global matte's edge band (where a 9×9
  neighbourhood has both fore- and background), so they can't add stray objects. It costs 10 inferences.
- `refine`: joint-bilateral against the image.
- `threshold` / `softness`.
- `decontaminate`, with `spillRadius` (px): foreground colour estimation by Blur-Fusion (Forte & Pitié, ICIP 2021).
  There are two iterations: the large radius at ¼ resolution, then 6 px at full resolution. Every pixel is unmixed as
  F = F̂ + α(I − αF̂ − (1−α)B̂), where F̂ and B̂ are α-weighted local means. This removes the old background's colour
  from hair and semi-transparent edges.
- `invert`: `mask` only.
- `cutout` is RGBA (alpha = matte, not premultiplied).

### Presets (`src/presets/ai-motion.ts`)
- `ai.datamoshVideo`: flow (NeuFlow v2, history) → Datamosh. Knobs: I-frame interval, macroblock, motion gain, bleed, mix, flow model.
- `ai.motionBlurFlow`: flow (NeuFlow v2, refine 0.6) → Flow Motion Blur. Knobs: shutter angle, motion scale, max blur, samples, centred, flow model, edge refine.
- `ai.paintingFromImage`: Style from Image → vibrance → canvas grain. It has a **second group input `style`** for the
  painting (unconnected = passthrough). Knobs: style strength, brush scale, detail, keep photo colours, mix, vibrance, grain.
- `ai.hairCutout`: Background Removal (High detail, decontaminate 1) over a solid colour (alpha 0 = transparent).
  Knobs: resolution, edge refine, threshold, softness, decontamination and its radius, background.

### Models (`src/core/ai/models-motion.ts`)

| Model | File | Size | Licence | Source |
|---|---|---|---|---|
| NeuFlow v2 (mixed) | `neuflow_mixed.onnx` (fixed 1×3×432×768, input 0..1) | 42.2 MB | Apache-2.0 (NeuFlow v2) / MIT (export) | [bukuroo/NeuFlowV2-ONNX](https://huggingface.co/bukuroo/NeuFlowV2-ONNX) @ `6b92f2df` |
| RAFT (Sintel) | `optical_flow_estimation_raft_2023aug.onnx` (fixed 480×360, input 0..255) | 64.1 MB | BSD-3-Clause (RAFT) / MIT (PINTO0309 conversion) | [opencv/optical_flow_estimation_raft](https://huggingface.co/opencv/optical_flow_estimation_raft) @ `06ce4aec` |
| RIFE 4.25 lite | `rife_v425lite.onnx` (dynamic H×W, multiples of 64) | 22.7 MB | MIT | [t9749/rife-4.25-lite-onnx](https://huggingface.co/t9749/rife-4.25-lite-onnx) @ `8d1488a8` |
| AdaIN VGG-19 encoder | `vgg_normalized.pth` (graph built in the browser) | 80.1 MB | MIT | [BhupatiNadar/adain-style-transfer-models](https://huggingface.co/BhupatiNadar/adain-style-transfer-models) @ `52de1b15` |
| AdaIN decoder | `decoder_final.pth` (graph built in the browser) | 14.0 MB | MIT | same repo and commit |
| BiRefNet lite 512² | `onnx/model_fp16.onnx` (fp16 weights, fp32 I/O, logits) | 98.5 MB | MIT | [studioludens/birefnet-lite-512](https://huggingface.co/studioludens/birefnet-lite-512) @ `962e6796` |

All URLs serve `access-control-allow-origin: *` (checked with `curl -I -H Origin:`). Upstream licences were checked on
GitHub too: NeuFlow_v2 Apache-2.0, princeton-vl/RAFT BSD-3-Clause, hzwer/Practical-RIFE MIT, naoto0804/pytorch-AdaIN
MIT, ZhengPeng7/BiRefNet MIT.

Notes on the choices:
- **RAFT is pinned to WASM.** On WebGPU (ORT 1.31) it runs without an error but the flow is wrong. Already the 1/8-resolution
  iterations differ from WASM by up to 14 px on the test pair (probably its GatherElements bilinear lookup). Because the
  WebGPU run doesn't fail, the runtime can't fall back by itself. NeuFlow v2 on WebGPU matches WASM (max diff 1e-4), so it
  is the default. On a synthetic pan + moving box, both models agree with phase correlation to 0.1 px.
- **AdaIN.** The VGG file is byte-identical (SHA-256 `804ca283…`) to naoto0804's v0.0.0 release `vgg_normalised.pth`.
  The decoder is a re-trained pytorch-AdaIN decoder (MIT card); its results look like the original release's decoder on
  the same inputs. `styleImageOnnx.ts` reads each conv tensor at a fixed byte offset of the pinned files (legacy torch
  format / stored zip) and writes the ONNX graph (reflect Pad, Conv, ReLU, MaxPool / nearest Resize, opset 13). The built
  graphs match PyTorch: max diff 2.4e-5 (encoder) and 4.9e-6 (decoder) on random input.
- **BiRefNet: the 1024² exports don't fit in the browser.** onnx-community `BiRefNet_lite-ONNX` (MIT; 115 MB fp16 /
  224 MB fp32) needs ≈7 GB at run time (measured peak RSS in onnxruntime CPU). ORT-web WASM dies with `std::bad_alloc`, and
  WebGPU fails a kernel. The Studio Ludens 512² re-export of the same BiRefNet_lite weights peaks at ≈2 GB and runs on WASM.
  On WebGPU, one kernel fails WGSL validation (`no matching constructor for i32(vec4<u32>)`) and the run returns a
  near-black matte **without an error**, so the model is `wasmOnly`. The High-detail tiles bring back resolution.
- **Rejected:**
  - Magenta arbitrary image stylization ONNX (`nkyygitt/magenta-style-transfer-onnx`): no licence on the card, and
    content fixed at 256².
  - Other AdaIN uploads: no licence, or training snapshots.
  - FILM: no permissive ONNX export found.
  - Other RIFE exports: `FuryTMP/RIFE_fp32` doesn't say which version or what the I/O is; `square-zero-labs` has no licence.
  - BiRefNet full / portrait / 512×512 (Swin-L, 470–970 MB).
  - RMBG: non-commercial.
  - RAFT int8bq: block-quantised DequantizeLinear.

Attribution:
- NeuFlow v2: Z. Zhang, A. Gupta, H. Jiang, H. Singh, *NeuFlow v2: High-Efficiency Optical Flow Estimation on Edge
  Devices*, 2024. [github.com/neufieldrobotics/NeuFlow_v2](https://github.com/neufieldrobotics/NeuFlow_v2).
- RAFT: Z. Teed, J. Deng, *RAFT: Recurrent All-Pairs Field Transforms for Optical Flow*, ECCV 2020.
- RIFE: Z. Huang, T. Zhang, W. Heng, B. Shi, S. Zhou, *Real-Time Intermediate Flow Estimation for Video Frame
  Interpolation*, ECCV 2022. [github.com/hzwer/Practical-RIFE](https://github.com/hzwer/Practical-RIFE).
- AdaIN: X. Huang, S. Belongie, *Arbitrary Style Transfer in Real-time with Adaptive Instance Normalization*, ICCV 2017;
  PyTorch port by N. Inoue ([naoto0804/pytorch-AdaIN](https://github.com/naoto0804/pytorch-AdaIN)).
- BiRefNet: P. Zheng, D. Gao, D.-P. Fan, L. Liu, J. Laaksonen, W. Ouyang, N. Sebe, *Bilateral Reference for
  High-Resolution Dichotomous Image Segmentation*, CAAI AIR 2024.
- Blur-Fusion: M. Forte, F. Pitié, *Approximate Fast Foreground Colour Estimation*, ICIP 2021.
- Middlebury colour coding: S. Baker et al., *A Database and Evaluation Methodology for Optical Flow*, IJCV 2011.

### Timings
The machine is an Apple-silicon Mac with ORT 1.31.1, in a worker, warm (3rd run). The WebGPU column is real Metal
(Playwright `channel: 'chromium'`). The WASM columns are 1 thread (no COOP/COEP) and 4 threads (COOP/COEP).

| Model / input | WebGPU | WASM 1 thread | WASM 4 threads |
|---|---|---|---|
| NeuFlow v2, 768×432 | ≈0.19 s | ≈4.1 s | ≈1.5 s |
| RAFT, 480×360 | runs on WASM | ≈6.1 s | ≈2.2 s |
| RIFE 4.25 lite, 960×576 | ≈0.15 s (≈0.10 s in a long export) | ≈0.9 s | ≈0.34 s |
| RIFE 4.25 lite, 1920×1088 | ≈0.58 s | ≈3.5 s | ≈1.2 s |
| AdaIN encoder, content 1152×768 | ≈0.36 s | ≈9.6–10.3 s | ≈2.5 s |
| AdaIN encoder, style 640×512 | ≈0.13 s | ≈3.5 s | ≈0.93 s |
| AdaIN decoder → 1152×768 | ≈0.51 s | ≈9.8 s | ≈2.6 s |
| BiRefNet lite 512² | runs on WASM | ≈5.2 s | ≈1.5–1.7 s |

End to end (WebGPU where possible):
- Datamosh preset export, 3 s of 960×540 at 30 fps: 25 s (90 frames).
- *Every frame* playback of the datamosh preset: ≈3.4 fps.
- ×2 slow-motion export of 1 s at 960×540: 5.8–11 s (60 frames).
- ×4 slow-motion export of 0.5 s: 7.3 s (60 frames).
- Background Removal: ≈6 s at 512. High detail: ≈60 s on 1 thread, roughly 3× faster with 4 threads.

### Verification (motion / matting)
- `src/nodes/ai/flowMath.test.ts` covers:
  - the colour wheel against the Python reference values;
  - the flow encoding sign and units;
  - the robust maximum;
  - bilinear sampling and backward warp by a constant flow (amount 1, 0.5, −1);
  - macroblocks;
  - the hash.
- `src/nodes/ai/interpMath.test.ts` covers:
  - timestep snapping and clamping;
  - the timestep between decoded frames;
  - the ×2/×4 schedule against the slow-motion source's time mapping;
  - padding to 64 and the crop back.
- **Held-out slow motion.** A 60 fps synthetic clip (pan + zoom of a landscape with a portrait moving over it) was
  reduced to 30 fps and exported ×2. The in-between frames scored PSNR 28.4 dB (minimum 26.1 dB) against the dropped
  60 fps frames, against 25.3 dB for a cross-fade and 22.9 dB for frame repetition. ×4 at t = 0.5 scored 28.2 dB. Every
  in-between frame differs from both neighbours. The exported file has 60 frames over 2.0 s (`ffprobe -count_frames`).

### Known gaps (motion / matting)
- **Datamosh softens over time.** Its accumulation resamples bilinearly every frame, so long runs without an I-frame
  grow soft. The I-frame interval or a little bleed brings the detail back.
- **History needs order.** Previous-frame mode needs frames in order: scrubbing shows zero flow (wire Video Frame
  (offset) into A for that). It is in-memory per session.
- **Fixed flow resolutions.** The flow models run at 768×432 / 480×360 whatever the video size. Small fast details
  (thin poles, hair) get the motion of their surroundings. The refine helps at edges.
- **Slow-motion audio.** Smooth slow motion drops audio. It interpolates the *source* video, so effects downstream
  are rendered on the synthetic frames. Scene cuts produce a morph between the two shots.
- **RAFT is slow.** RAFT only runs on the CPU (wrong results on WebGPU), at 2–6 s per frame.
- **BiRefNet resolution.** BiRefNet runs at 512² on WASM (~5 s per inference single-threaded), and High detail is 10
  inferences. Without tiles, fine hair is softer than with MODNet's portrait matte. BiRefNet doesn't count objects held
  in front of a person (the bouquet in `portrait.jpg`) as part of the subject.
- **AdaIN's look.** AdaIN shows the usual VGG grid texture at small style scales and repaints the whole frame
  uniformly, with no semantic awareness.
- **Not tested on real footage.** No real-world (non-synthetic) video was tested: the frame-interpolation numbers come
  from synthetic rigid motion.

## Vision-language: text prompts, captions, OCR, CLIP search

| Node | Id | Outputs | What it does |
|---|---|---|---|
| Select by Text | `ai.textSelect` | `mask`, `overlay` | OWLv2 open-vocabulary detection finds what the prompt names; SAM traces each box |
| Text Mask (CLIPSeg) | `ai.textMask` | `mask` | Soft region masks from words (“sky”, “water”, “skin”), union / subtract, matted to the image |
| Caption & OCR | `ai.caption` | `out`, `overlay`, `mask` | Florence-2: caption, detailed caption, OCR (± regions), object detection, phrase grounding |

**`ai.textSelect` params:**
- `prompt`: what to select. Commas separate objects (“red jacket, paddle”); a leading `-` subtracts an object (“person, -paddle”).
- `threshold` (*Box threshold*, default 0.1): minimum detection score (sigmoid of OWL's logit).
- `maxObjects`, `keep` (*All matches* / *Best match* / *Nth match*), `nth`.
- `refine` (*Refine with SAM*, on): trace each box with SlimSAM. Off = the filled boxes.
- `threshold2` (*Mask threshold*), `softness`, `edges` (edge-aware upsampling), `feather`, `invert`.
- `model`: *OWLv2 B/16 (accurate)* (default) or *OWL-ViT B/32 (fast)*.
- `tint`: colour of the selection in `overlay`. The overlay draws every found box with its label and score; kept boxes are solid, found-but-not-kept ones dashed.

How it works:
- **Image once, prompt cheap.** The OWL ONNX export is a single graph that takes image and text together. At load time
  `extractGraph()` (`src/core/ai/vl/onnx-split.ts`, a browser port of `onnx.utils.extract_model`) cuts the one
  download into an image part (outputs: normalised class embeddings, logit shift, logit scale, `pred_boxes`) and a text
  part (normalised text embeddings). The small class head that mixes them runs in JS (`owlLogits` in `vl/boxes.ts`).
  So the image is encoded once per image (`InferenceMemo` by fingerprint), each prompt only runs the text tower
  (≈15–70 ms, cached per text), and threshold / count / keep are pure post-processing. The split was checked against
  the full graph in onnxruntime: max |Δlogit| 7e-6, boxes identical.
- **Post-processing:** per patch the best query (sigmoid), threshold, cx cy w h → x0 y0 x1 y1, rescale from OWLv2's
  square-padded frame to the image, class-wise NMS (IoU 0.3). Patches over the grey padding, and a few border patches
  that the q4f16 export makes degenerate (identical features, centre on the frame edge, ≈100 %), are dropped.
- **SAM refinement** reuses Click Select's cached SAM embedding (`samEmbedding()` / `samDecodeBatch()` exported from
  `segment-sam.ts`, same memo). This SAM export has no box prompt, so nine positive points inside the box (centre,
  diagonals, mid-lines) are decoded in one point batch; of the 27 proposals the one whose bounding box fits the
  detection best wins (`boxFitScore`: IoU of the mask's bounding box with the box − the share of the mask outside the
  box grown by 8 % + 0.15 × SAM's IoU prediction). The mask is clipped to the grown box. Memoised per image + box.

**`ai.textMask` params:** `prompt` (commas = union, `-x` = subtract: `m · Π(1 − subtract·n)`), `normalize` (stretch
each positive prompt's map to its own peak; on by default, CLIPSeg is often unsure on photos), `subtract`,
`threshold`, `softness`, `edges` (joint-bilateral upsampling of the 352² map), `refine` / `radius` / `eps` (guided-filter
matting on luma, He et al. 2010), `feather`, `invert`. CLIPSeg is split three ways (image activations of layers 3/6/9
after the decoder's reduce layers, the FiLM text conditioning, and the 1.2 MB decoder), so a new prompt is a text pass
plus a decode (≈50 ms). The split is exact (max |Δ| = 0 in onnxruntime). One cut tensor is the batch size as an int64
shape value; it is always 1 and fed as a constant.

**`ai.caption` params:** `task` (*Caption*, *Detailed caption*, *More detailed caption*, *OCR*, *OCR with regions*,
*Object detection*, *Phrase grounding*), `phrase` (grounding input), `samMask` (trace boxes with SAM for `mask`),
mask threshold / softness / edges / feather / invert, `tint` (used for grounding only).
- The answer appears below the parameters in the Properties panel, read-only, with **Copy text** and, for *Caption*,
  **Use as project name** (article and final period dropped).
- `out` passes the image through, so the node can sit in a chain; `overlay` draws boxes / OCR quads with labels.
- Pipeline (`vl/florence.ts`, as transformers' Florence2ForConditionalGeneration): 768² squash → DaViT vision encoder
  (577 tokens) → `[image tokens, embed(prompt)]` → BART encoder → merged decoder with KV cache, greedy with a
  no-repeat-3-gram rule (the model's config asks for 3 beams; greedy is 3× cheaper and matched the reference captions).
  The merged decoder's bool `use_cache_branch` input is re-typed to float by `castInputs()` at load time, because the
  session host only sends float32 / int64 tensors. The answers are memoised per image + task + phrase.
- Location tokens `<loc_N>` are bins over the squashed image: coordinate = (N + 0.5) / 1000 (`vl/florence-post.ts`).
- Not optional / not gated: with the vision encoder on WebGPU an answer takes ≈2–5 s; WASM-only adds ≈10 s for the image once (well under the 30 s budget).

### Preset Browser: CLIP look search
- **Describe a look…** (a second search field; press Enter): ranks the presets by CLIP similarity between the text
  and each preset's live thumbnail, e.g. “faded 90s camcorder”, “moody cyan night”, “newspaper print”. The text is
  wrapped as “a photo, …”. The score (×100) is shown next to the category.
- **≈ more like this** (on hover, on every tile): ranks by image–image similarity to that preview.
- All thumbnails show the same photo, so raw CLIP similarity is dominated by the photo's content. Scores therefore use
  each embedding minus the mean of the visible thumbnails' embeddings (once ≥ 6 are embedded), i.e. what is specific
  to each look.
- Lazy and off by default: nothing loads until a query is entered; the first query downloads CLIP (154 MB, through the
  consent prompt). Thumbnails are embedded one at a time as they render (≈0.2 s each on WASM), cached per preset +
  thumbnail input key (the graph / viewed-node state the preview was rendered from); text embeddings per text.
- Code: `src/core/ai/vl/clip.ts`, `src/core/ai/vl/presetRank.ts` (React hook), a few lines in `PresetBrowser.tsx`.

### Presets (`src/presets/ai-vl.ts`)
All expose the prompt as a knob.
- `ai.textRecolor` *Recolour by Text*: Select by Text → Hue / Saturation, mixed through the mask. Knobs: prompt, hue, saturation, lightness, keep, box threshold, feather, amount.
- `ai.textBlurBackground` *Blur All But…*: Select by Text (best match, inverted) → Lens Blur amount. Knobs: prompt, keep, blur, bokeh highlights, blades, box threshold, feather.
- `ai.textCutout` *Cut Out by Text*: Select by Text → Alpha from Mask. Knobs: prompt, keep, N, box threshold, mask threshold, feather.

### Tokenizers (`src/core/ai/vl/tokenizer.ts`)
Own TypeScript BPE tokenizers instead of `@huggingface/transformers`: that package bundles its own onnxruntime-web
(a second ≈25 MB of wasm next to the app's 1.31.1, in another version) plus its own model loading and caching, and
the app only needs two tokenizers. They read the Hugging Face `tokenizer.json`, fetched through the model cache
(`vl/text.ts` → `runtime.download`), so prompts work offline after the first use.
- **CLIP BPE** (CLIP, OWL-ViT, OWLv2, CLIPSeg share one vocab; the 2.2 MB file comes from `Xenova/clip-vit-base-patch32`):
  NFC, whitespace collapse, lower case, CLIP's word split, GPT-2 byte alphabet, BPE with the `</w>` suffix,
  `<|startoftext|> … <|endoftext|>`. OWL pads to 16 tokens with id 0 plus an attention mask.
- **Byte-level BPE** (Florence-2 / BART): GPT-2 pre-tokenizer regex, byte alphabet, BPE, `<s> … </s>`, the 1029 added
  tokens (`<loc_N>`, `<od>`, …) matched before BPE and decoded verbatim.
- Tests (`tokenizer.test.ts`) compare ids with the HF `tokenizers` library on fixtures cut from the real files (the vocab
  entries and merges that can occur in the test strings, in their original order). A one-off check on 614 random
  phrases against the full files matched every id.

### Models (`src/core/ai/models-vl.ts`)

| Model | File(s) used | Size | Licence | Source |
|---|---|---|---|---|
| OWLv2 B/16 ensemble | `onnx/model_quantized.onnx` (int8: text part always, image part on WASM); `onnx/model_q4f16.onnx` (image part on WebGPU) | 155.3 / 128.4 MB | Apache-2.0 | [Xenova/owlv2-base-patch16-ensemble](https://huggingface.co/Xenova/owlv2-base-patch16-ensemble) @ `3e255bc9` (from [google/owlv2-base-patch16-ensemble](https://huggingface.co/google/owlv2-base-patch16-ensemble)) |
| OWL-ViT B/32 (option) | same pattern | 155.4 / 127.3 MB | Apache-2.0 | [Xenova/owlvit-base-patch32](https://huggingface.co/Xenova/owlvit-base-patch32) @ `b75f4e52` (from google/owlvit-base-patch32) |
| CLIPSeg rd64 refined | `onnx/model_quantized.onnx` (int8, WASM) | 139.1 MB | Apache-2.0 | [Xenova/clipseg-rd64-refined](https://huggingface.co/Xenova/clipseg-rd64-refined) @ `924dc94f` (from CIDAS/clipseg-rd64-refined) |
| Florence-2 base ft | `vision_encoder_fp16.onnx` (WebGPU) or `vision_encoder_quantized.onnx` (WASM); `embed_tokens_quantized`, `encoder_model_quantized`, `decoder_model_merged_quantized` (WASM) | 183.9 or 93.7 + 39.4 + 43.7 + 98.2 MB | MIT | [onnx-community/Florence-2-base-ft](https://huggingface.co/onnx-community/Florence-2-base-ft) @ `e88a44ea` (from microsoft/Florence-2-base-ft) |
| CLIP ViT-B/32 | `onnx/vision_model_quantized.onnx` + `onnx/text_model_quantized.onnx` (WASM) | 89.1 + 64.5 MB | MIT | [Xenova/clip-vit-base-patch32](https://huggingface.co/Xenova/clip-vit-base-patch32) @ `6b7c5237` (from openai/clip-vit-base-patch32) |
| Tokenizers | `tokenizer.json` of the CLIP and Florence-2 repos above | 2.2 + 2.3 MB | as the models | same commits |

Every file serves `access-control-allow-origin` (checked with `curl -sI -H Origin:`; the LFS files redirect to the HF CDN with `*`).
Everything over 50 MB goes through the consent prompt (`download()`). First-use totals: Select by Text ≈ 284 MB on
WebGPU (q4f16 image part + int8 file for the text part) or 155 MB on WASM, plus SlimSAM; Text Mask 139 MB;
Caption & OCR ≈ 365 MB on WebGPU / 275 MB on WASM; CLIP search 154 MB.

Notes on the choices:
- **int8 is wrong on WebGPU.** ORT 1.31's WebGPU EP runs the dynamically quantised (MatMulInteger) OWLv2 graph ≈16 s
  slower than WASM and returns garbage boxes and scores. So int8 files run on WASM (`wasmOnly`), and WebGPU gets
  q4f16 / fp16 files only where measured correct.
- **OWLv2 q4f16 text tower is degraded** (paddle score 0.04 instead of 0.71 on `street`), while its image part is fine
  (0.64, same boxes). So the text part is always the int8 file on WASM (≈60 ms per prompt). A new `Precision`
  `'q4f16'` was added; `pickFile` takes fp16, else q4f16, on WebGPU with `shader-f16`.
- **OWLv2 over OWL-ViT** as default: on `street` OWLv2 scores the paddle 0.71 vs 0.11 for OWL-ViT B/32. OWL-ViT stays as
  the fast option (576 vs 3600 patches).
- **Grounding DINO tiny** (`onnx-community/grounding-dino-tiny-ONNX`, Apache-2.0) was not used: 204 MB int8 / 360 MB fp16,
  and its text and image streams are fused inside the encoder, so every prompt would re-run the whole model.
- **CLIPSeg** stays int8 on WASM: 352² is small (≈1.9 s per image on one thread), one 139 MB download.
- **Florence-2**: the fp16 vision encoder on WebGPU (0.3–0.6 s vs ≈10 s on one WASM thread) is worth its 184 MB; the
  decoder runs on WASM at ≈21 ms per token (worker round trip), so even long OCR answers stay within seconds.
  Florence-2 large (0.77 B) was not considered: ≈4× the size.
- **CLIP** quantised (int8) on WASM: ≈0.21 s per thumbnail, ≈20 ms per query.

Attribution:
- OWL-ViT / OWLv2: M. Minderer, A. Gritsenko, N. Houlsby, *Scaling Open-Vocabulary Object Detection*, NeurIPS 2023;
  M. Minderer et al., *Simple Open-Vocabulary Object Detection with Vision Transformers*, ECCV 2022. Google, Apache-2.0.
- CLIPSeg: T. Lüddecke, A. Ecker, *Image Segmentation Using Text and Image Prompts*, CVPR 2022. Apache-2.0.
- Florence-2: B. Xiao et al., *Florence-2: Advancing a Unified Representation for a Variety of Vision Tasks*, CVPR 2024. Microsoft, MIT.
- CLIP: A. Radford et al., *Learning Transferable Visual Models From Natural Language Supervision*, ICML 2021. OpenAI, MIT.
- ONNX exports: Xenova and onnx-community (Transformers.js).

### Runtime additions (additive)
- `src/core/ai/vl/onnx-split.ts`: `extractGraph(model, outputs, cutInputs?)` (sub-model extraction, with typed new
  outputs / inputs, subgraph outer-scope references) and `castInputs()` (re-type a graph input behind a Cast).
- `ModelInfo.task` gained `detection`, `vision-language`, `embedding`; `Precision` gained `q4f16`.
- Several catalog entries can share one pinned URL (downloaded and cached once) with different `prepare` functions.
- **Node info hook:** `src/core/nodeInfo.ts` (`setNodeInfo(id, {title, text, detail, suggestName})`, keyed by the new
  `CpuContext.nodeId`, which the engine fills with the node's flat id). The Properties panel renders it
  (`src/ui/NodeInfoBlock.tsx`) with Copy text / Use as project name. For a group, the infos of its inner nodes are shown.
- `segment-sam.ts` exports `samEmbedding()`, `samDecodeBatch()` (SAM's point batch, padding label −10) and `samLowRes()`.

### Timings (vision-language)
Apple-silicon Mac, ORT 1.31.1, Chromium (`channel: 'chromium'`, real Metal WebGPU) vs WASM with 1 thread (the harness page is not
cross-origin isolated; the app under COOP/COEP uses up to 4 threads), `street` (1600×1067), worker round trips included.

| Step | WebGPU machine | WASM only (1 thread) |
|---|---|---|
| OWLv2 image part, 960² (q4f16 on WebGPU / int8) | ≈2.1 s (first ≈2.9 s incl. session) | ≈27 s |
| OWL text part, a new prompt (int8, WASM in both) | ≈40 ms (first ≈0.3–0.5 s incl. load) | ≈40 ms |
| SAM refine of one box (9 prompts, one batch) | ≈0.1 s (+ ≈0.8–1.3 s SAM encode, once per image) | ≈1.1 s (+ ≈5–7 s encode) |
| Select by Text in the editor, typing a new prompt | mask updated ≈0.3–1 s after the last key | — |
| CLIPSeg image part, 352² (int8, WASM in both) | ≈1.9 s | ≈1.8 s |
| CLIPSeg new prompt (text + decoder) | ≈45 ms | ≈45 ms |
| Florence-2 vision encoder, 768² (fp16 WebGPU / int8) | ≈0.33 s (first ≈1.1 s) | ≈9.8 s |
| Florence-2 caption (12–13 tokens, encoder + decoder on WASM) | ≈2.3 s | ≈2.3–5.5 s |
| Florence-2 object detection (24 tokens) / OCR with regions (93 tokens) | ≈2.1 s / ≈5 s | ≈2.1 s / ≈4.2 s |
| Florence-2 decoder, per token | ≈21 ms | ≈21 ms |
| CLIP image (224², one thumbnail) / text query | ≈0.22 s / ≈20 ms | ≈0.22 s / ≈20 ms |
| Preset Browser, first ranking of 29 thumbnails | ≈7 s incl. CLIP load; later queries ≈0.1 s | same |

The text encoder of Florence-2 (≈1.3 s for 577 + n tokens) and the decoder stay on WASM: int8 graphs are wrong or slow on
the WebGPU EP. No Florence answer measured came near 30 s, so the node is not gated behind a “Run” switch.

### Testing (vision-language)
```bash
node scripts/snap.mjs out.png 'node=ai.textSelect&img=street&wait=600&port=overlay&params={"prompt":"paddle"}'
node scripts/snap.mjs out.png 'node=ai.textMask&img=landscape&wait=600&params={"prompt":"water"}'
node scripts/snap.mjs out.png 'node=ai.caption&img=street&wait=900&port=overlay&params={"task":"Object%20detection"}'
node scripts/snap.mjs out.png 'preset=ai.textBlurBackground&img=street&wait=600&p.prompt="woman"'
```
- The consent prompt has no UI in the harness: models over 50 MB wait forever. Set the pref first, e.g. with a
  Playwright init script `localStorage.setItem('darkroom.prefs', JSON.stringify({version: 1, prefs: {aiConfirmMB: 0}}))`,
  or approve once in the app (approvals persist per URL).
- Unit tests: `src/core/ai/vl/tokenizer.test.ts`, `boxes.test.ts` (OWL head, detections, padding filter, NMS, keep modes,
  prompt parsing, SAM proposal choice), `florence-post.test.ts` (answer parsing).

### Known gaps (vision-language)
- OWL detects *things*, not *stuff*: “trees”, “water”, “sky” come out as one huge low-score box or nothing. Use Text Mask for those.
- The q4f16 OWLv2 image part scores slightly lower than int8 (paddle 0.64 vs 0.71); hence the 0.1 default threshold.
- SAM refinement inherits SAM's 256² mask: thin parts (paddle shaft, fingers) may be lost, and a box that holds two objects can select only one.
- CLIPSeg is coarse (352² for the whole frame, ≈16 px patches). The matting snaps edges, but semantic errors stay
  (e.g. “skin” on `portrait` finds the shoulder and only part of the face).
- Florence-2 plain *OCR* returns lines without separators (as the reference implementation); *OCR with regions* gives one line per region.
  Greedy decoding instead of beam search; long answers (dense OCR) take ≈20 ms per token on top.
- Florence-2's detection labels are COCO-like (“human face”, “person”); boxes can cover the whole frame (“boat”).
- CLIP ranking of looks is approximate: thumbnails are small and share the photo. Mean-centring helps but semantic
  queries (“newspaper print”) match better than vague moods.
- The WebGPU paths download two copies of OWLv2 (q4f16 image part + int8 text part).

## Runtime (`src/core/ai/`)

| File | Role |
|---|---|
| `models.ts` | Model catalog: pinned URLs, sizes, licences; picks fp16 vs int8 per backend |
| `cache.ts` | Cache-first downloads with progress (Cache Storage `darkroom-models`); plain `fetch` where Cache Storage is unavailable |
| `runtime.ts` | Main thread: execution-provider choice, worker lifecycle, model loading, observable state, `runModel()` |
| `session.ts` | ORT session host shared by the worker and the main-thread fallback (fp16 I/O conversion, WebGPU→WASM fallback) |
| `worker-gpu.ts` / `worker-wasm.ts` | Worker entries: the JSEP build (WebGPU + CPU) or the smaller CPU-only build |
| `image.ts` | Resampling, NCHW packing, normalisation, the inference memo |
| `models-img.ts` | Image-to-image models (upscale, inpaint, colorize, style, low light, line art), registered with `registerModel()` |
| `models-relight.ts` | MoGe-2 ViT-S (normals + geometry) for `ai.normals` |
| `models-vl.ts` | Vision-language models (OWLv2 / OWL-ViT, CLIPSeg, Florence-2, CLIP), several entries per shared download |
| `vl/` | Tokenizers, ONNX graph split, OWL / CLIPSeg / Florence-2 / CLIP pipelines, box post-processing, Preset Browser ranking |
| `onnx-proto.ts` | Minimal ONNX protobuf editing for `ModelInfo.prepare`: `freeImageDims()`, `buildZeroDce()` |
| `AiModels.tsx` | The *AI Models* section of the Plugin Manager, and the download-progress toast |

### Execution provider
- **Auto** (the default) uses WebGPU when `navigator.gpu.requestAdapter()` succeeds, else WASM. The
  Plugin Manager can force *WebGPU* or *WASM*; for debugging, `?aiEp=wasm|webgpu` on the URL does the same.
- **WebGPU** loads the JSEP build (`ort-wasm-simd-threaded.jsep.wasm`, 29.5 MB), which also contains the CPU EP.
- **WASM only** loads `ort-wasm-simd-threaded.wasm` (14.8 MB).
- **Threads:** `min(4, cores/2)` when the page is `crossOriginIsolated` (COOP/COEP headers), else 1.
  Threaded WASM was tested in both dev and the production build under COOP/COEP.
- **WebGPU fallbacks.** If a WebGPU session can't be created, the model falls back to WASM. If a WebGPU
  run fails, everything moves to WASM: a failed JSEP run breaks later WebGPU runs ("kernel … not
  allowed to be called recursively").
- **U²-Net-p always runs on WASM.** ORT 1.31's WebGPU MaxPool lacks `ceil_mode`.

### Worker
Inference runs in a dedicated module worker, so the UI stays responsive:
- Model bytes and tensors are *transferred*, not copied.
- If the worker can't start (20 s timeout or an error), the runtime loads ORT on the main thread instead
  (still async).
- `serveWorker()` ignores emscripten pthread workers (`self.name` = `em-pthread*`). They re-run the
  bundled worker script.

### Bundling and offline use
- The ORT `.wasm` files are imported with Vite `?url` from `node_modules`:
  - in dev they are served from `node_modules`;
  - in the build they are emitted as hashed assets (`dist/assets/ort-wasm-simd-threaded*.wasm`, about 44 MB
    in total, 11 MB gzipped). No CDN is involved.
- The runtime fetches the wasm itself (cache-first, into `darkroom-models`) and hands it to ORT as
  `env.wasm.wasmBinary`. That's why the PWA precache can leave these big files out
  (`maximumFileSizeToCacheInBytes` is 8 MB): after the first AI use, the runtime and the models come from
  Cache Storage.
- The JS glue is inlined (`ort*.bundle.min.mjs`), so no `.mjs` has to be fetched at runtime.
- The Electron app ships the wasm files inside the app bundle. The models are still downloaded on first
  use (Cache Storage needs a secure origin; on `file://` the runtime falls back to an uncached download each session).

### Progress and status
- While a file downloads, a small toast shows its progress (mounted in `ExtensionsHost`). The status bar
  can't be used for this: it shows "Loading… (n)" while nodes are pending.
- Status-bar messages announce when a model is ready or failed.
- *Plugins › AI Models* lists each model with its licence, size and status, plus the last inference time
  and resolution. It also has the *Run on* switch and *Download* / *Delete* / *Clear all* buttons.
- For automation, `window.__darkroomAi` exposes `getState()`, `runModel()`, `runModelMulti()`, `prefetchModel()`,
  `setEpPreference()` and `clearModelCache()`.

## Timings

Measured on an Apple-silicon Mac in headless Chromium, ORT 1.31.1, warm (after the first run):

| Model / input | WebGPU (Metal) | WASM 4 threads (COOP/COEP) | WASM 1 thread |
|---|---|---|---|
| Depth Anything V2 S, 588×392 | ≈75 ms (fp16) | ≈0.8–1.0 s (int8) | ≈2.6 s (int8) |
| Depth Anything V2 S, 770×518 | ≈125 ms (fp16) | n/a | ≈4.2 s (int8, 518×644) |
| MODNet, 512×640 | ≈70 ms | n/a | ≈1.2 s |
| U²-Net-p, 320×320 | n/a (runs on WASM) | n/a | ≈1.1 s |

The first WebGPU run of a model adds ≈1–2 s of shader compilation. On a first visit the downloads come on
top (14.8–29.5 MB runtime + the model).

## Testing

```bash
node scripts/snap.mjs out.png "node=ai.depth&img=street&wait=120"
node scripts/snap.mjs out.png "preset=ai.portraitBokeh&img=portrait&wait=120"
node scripts/snap.mjs out.png "preset=ai.studioPortrait&img=portrait&wait=200"   # Surface Normals → Relight
SNAP_TIMEOUT=300000 node scripts/snap.mjs …        # snap's per-shot timeout (ms)
```
- `&wait=<s>` raises the harness's wait for pending CPU nodes (the default is 2.5 s). Each snap run uses a
  fresh browser profile, so the first shot downloads the models.
- The harness now links a node's *first* output to the Output (e.g. `depth`), not `out`.
- Playwright's default headless shell only offers a SwiftShader WebGPU adapter. To test real WebGPU, launch
  with `channel: 'chromium'` and `--enable-unsafe-webgpu`, and without `--use-angle=swiftshader`.

## Known gaps
- Depth is relative (disparity-like): sky and far mountains crowd near 0. Use `gamma`/`far` to spread the far range.
- MODNet is trained on people. For other subjects, use *Object (U²-Net-p)*: it is coarser at 320², with
  hair edges recovered only by the edge-aware refine.
- `effects.godRays` and the other `mask.*` nodes don't take depth yet. You can wire a depth map through
  `mask.levels` and `composite.mix` instead.
