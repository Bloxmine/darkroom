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
| Relight | `ai.relight` | `out` | Virtual point light: normals from a depth map (Sobel), soft shadows by a screen-space ray march |
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

**`ai.relight` inputs/params:** `image`, `depth` (mask, near = white, e.g. from `ai.depth`; unconnected = flat).
- `light` (vec2 on the image, draggable in the viewer), `height` (in front of the image plane, image height = 1), `color`, `intensity`, `falloff` (inverse square).
- `ambient` (level of what the light misses; 1 = unchanged) and `mode`:
  - *Add light*: `base·ambient + base·light`;
  - *Multiply shade*: only darkens, towards `ambient` where the light doesn't reach;
  - *Full relight*: `base·(ambient + light)` + a little specular.
- `strength` (normal gain) and `radius` (Sobel distance, px); steep depth steps are compressed so object outlines don't get dark rims.
- `depthScale` (scene depth in image heights), `shadows`, `shadowSoftness`, `shadowStrength`: 24 jittered steps
  towards the light, at most 40 % of the image height, starting 3 px out (no self-shadowing). `specular`, `showLight`.

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
  vec2Param?: string;  // single point written to a vec2 param instead of JSON (Relight: 'light')
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
- `ai.dramaticRelight`: depth map, then Relight (*Full relight*, ambient 0.32), then a vignette. Knobs: light position (draggable), height, intensity, colour, ambient, falloff, shadows, vignette.
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
- Relight is screen-space: no shadows from things outside the frame, and relative depth means the light's height and the depth range need tuning per photo.
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

### Known gaps (people)
- **Profiles.** MediaPipe's face mesh is unreliable on strong profiles: one profile in the STS-135 crew photo got a poor mesh, while the other three fell back to YuNet boxes. Feature masks need landmarks.
- **Tight portraits.** BlazePose finds no pose on tight head-and-shoulders portraits (`portrait.jpg`), so there is no skeleton there. The person and part masks still work.
- **Crowded groups.** Some top-down poses in crowded groups are still wrong or missing (6 of 7 people on Expedition 64).
- **Occlusions in restoration.** Restoration hallucinates through occlusions: a flower held in the mouth became teeth. Large, already-sharp faces gain little and lose some fine detail at 512 px, so use a lower strength for those. CPU restoration is slow (≈17 s per face single-threaded).
- **Auto-crop size.** The crop size follows `zoom`, not the content: `size()` cannot depend on the image. Very tight crops can trade headroom against the eye line.
- **Pose masks** come from the whole-image pass only (see above). The Multiclass mask is the default anyway.

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
