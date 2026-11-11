# ControlNet

Darkroom does not run Stable Diffusion itself. The weights are 2–5 GB, and many have no licence or a
non-commercial one (see [Relighting › What was considered and rejected](AI.md#what-was-considered-and-rejected)).
Instead it has two parts:

1. **Preprocessor nodes** (category **ControlNet**, ids `control.*`). They make control maps in the exact
   conventions the sd-webui-controlnet / ComfyUI preprocessors use, locally on the GPU or with small in-browser
   models.
2. **A generation bridge** (`sd.generate`). It sends the maps, prompts and an optional init image / mask to
   **your own** ComfyUI or AUTOMATIC1111 (Forge, SD.Next) server and shows the result. It is off by default.

## Preprocessor nodes

All maps are computed at a **detect resolution**, like the A1111 *Preprocessor resolution*. The short side is
scaled to it, and both sides are rounded to multiples of 64 (`resize_image` in controlnet_aux). The map is then
resized bilinearly to the node's output size, which is the input's size. So a map looks the same in preview and
export, and the line widths match what the standard preprocessors produce at that resolution.

| Node | Id | Map | How |
|---|---|---|---|
| Canny | `control.canny` | white 1-px edges on black | GPU OpenCV Canny: per-channel 3×3 Sobel, L1 magnitude, the channel with the largest gradient wins, 4-sector non-maximum suppression, double threshold, iterative hysteresis |
| Soft Edge | `control.softEdge` | soft white outlines | GPU **approximation** of HED / PiDiNet (multi-scale colour gradients, see below), optional *safe* quantising |
| Scribble | `control.scribble` | thick white strokes | soft edges → controlnet_aux `nms(x, 127, 3)` → gaussian σ 3 → `> 4/255` |
| M-LSD Lines | `control.mlsd` | white straight lines | M-LSD tiny (ONNX), decoded like `pred_lines`, drawn at the detect resolution |
| Lineart | `control.lineart` | white lines on black | Informative Drawings: the same weights as `sk_model.pth` (realistic) / `sk_model2.pth` (coarse), output `1 − line` |
| Depth | `control.depth` | near = white, min-max normalised | Depth Anything V2 Small, or MoGe-2; or formats a connected depth map |
| Normal Map | `control.normal` | NormalBae colours | MoGe-2 normals, red flipped (see below); or converts a connected OpenGL normal map |
| OpenPose | `control.openpose` | standard 18-point skeleton on black | MediaPipe Pose / Hand / Face landmarks drawn with the controlnet_aux colours |
| Segmentation | `control.seg` | ADE20K palette | DETR panoptic (COCO) classes mapped to ADE20K |
| Content Shuffle | `control.shuffle` | warped image | `make_noise_disk` flow + remap, as ContentShuffleDetector |
| Tile / Blur | `control.tile` | low-res image | tile_resample (area down by *rate*, bilinear up) or ComfyUI pyrUp-style blur |
| Color Grid | `control.colorGrid` | flat 64-px colour cells | T2I color adapter: down by 64, nearest up |
| Inpaint Mask | `control.inpaintMask` | mask, white = regenerate | threshold + grow + feather; or the image with the area blanked (black / grey / alpha 0) |
| Control Sheet | `control.sheet` | grid | up to 6 maps with labels, for comparing preprocessors |

### Params
- **Common:** `resolution` (*Detect resolution*, 64–2048, step 64, default 512; Depth and Normal use 518 and
  multiples of 14 because the models need them).
- `control.canny`: `lowThreshold` 100, `highThreshold` 200 (OpenCV units, 0–255), `hysteresis` (passes,
  i.e. how many px a weak edge is followed; default 96).
- `control.softEdge`:
  - `mode`: *HED* or *PiDiNet* (approximation);
  - `strength`, `detail`;
  - `safe`: controlnet_aux `safe_step`, which quantises the map to 0 / ½ / 1.
- `control.scribble`: the soft-edge params, plus `threshold` (0.5 = 127/255) and `thickness` (σ of the dilation;
  3 = standard).
- `control.mlsd`: `scoreThreshold` (thr_v, 0.1), `distanceThreshold` (thr_d, 0.1), `thickness` (px at the detect
  resolution; 1 = standard).
- `control.lineart`: `model` *Realistic (sk_model)* / *Coarse (sk_model2)*.
- `control.depth`:
  - `model`: *Depth Anything V2 Small* / *MoGe-2*;
  - `invert`;
  - optional `depth` input: a depth map to normalise instead of running a model.
- `control.normal`:
  - `flatBackground`: the sky faces the camera;
  - optional `normals` input: an OpenGL normal map, e.g. *Surface Normals*.
- `control.openpose`:
  - `preprocessor`: `openpose`, `openpose_hand`, `openpose_face`, `openpose_faceonly` or `openpose_full`;
  - `model`: *Lite* or *Full*;
  - `maxPeople`;
  - `minConfidence`: MediaPipe visibility a keypoint needs before it is drawn.
- `control.seg`: `inference` (DETR short side, 384–800), `minConfidence`.
- `control.shuffle`: `frequency` (f, 256), `seed`.
- `control.tile`: `mode`, `rate` (down sampling rate, 1–8), `iterations` (blur mode).
- `control.colorGrid`: `cell` (64).
- `control.inpaintMask`: `output`, `threshold`, `grow` (px), `feather` (px), `invert`.
- `control.sheet`: `label1`…`label6`, `columns` (0 = auto), `cellWidth`, `gap`, `showLabels`.

Model-based nodes (`lineart`, `depth`, `normal`, `mlsd`, `openpose`, `seg`) set `heavy: true`. In the viewer they
evaluate once at fit-to-window resolution, and their inference is memoised by image content. Changing the
detect resolution of the drawing, the thresholds or the OpenPose mode never re-runs a model.

### Conventions, checked against the reference code
- **OpenPose.** These come from controlnet_aux `open_pose/util.py`, as used by sd-webui-controlnet and ComfyUI:
  - *Keypoints.* BODY-18 COCO order: Nose, Neck, RShoulder, RElbow, RWrist, LShoulder, LElbow, LWrist, RHip, RKnee,
    RAnkle, LHip, LKnee, LAnkle, REye, LEye, REar, LEar.
  - *Limbs.* `limbSeq`, drawn as filled ellipses (half-width 4 px) in `colors[i] × 0.6`.
  - *Joints.* Circles (r 4) in the 18 standard colours: `[255,0,0]`, `[255,85,0]` … `[255,0,85]`.
  - *Hands.* 21 points; the edges use HSV hue `i/20`, width 2; the points are blue `[0,0,255]`.
  - *Face.* 68 white dots, r 3.
  - *Mapping.* MediaPipe 33 → OpenPose 18 is `[0, neck, 12, 14, 16, 11, 13, 15, 24, 26, 28, 23, 25, 27, 5, 2, 8, 7]`.
    The neck is the midpoint of the shoulders. MediaPipe's "left" is the person's left, as is OpenPose's "L".
  - *Hands source.* The MediaPipe Hand Landmarker gives 21 points in the same order as the OpenPose hand model.
  - *Face source.* 68 face points are picked from the 478-point Face Mesh (`MESH_TO_FACE68`). This is an approximation
    of the dlib-68 layout.
  - *Verified.* In a render of `street`, every non-black colour is an exact standard joint or limb colour.
- **Normal (BAE).** The ControlNet 1.1 README says normalbae maps follow the ScanNet / NYU-v2 protocol: "blue is
  front, red is left, green is top".
  - *ai.normals* (OpenGL) has red = **right**. So `control.normal` flips x: `(−x, y, z)`.
  - A camera-facing wall is (128,128,255), the ground is green, and a surface facing image-left is red.
- **Depth.** Near = white, normalised `(d − min) / (max − min)`, as the depth_anything / midas preprocessors do.
- **Segmentation.** ControlNet's seg model was trained on ADE20K maps in the mmseg / UniFormer palette: 150 colours,
  copied from ControlNet-v1-1-nightly `annotator/uniformer/mmseg/datasets/ade.py`.
  - *Mapping.* Darkroom's scene model is DETR panoptic, whose 133 COCO-panoptic categories are mapped to the nearest
    ADE20K class (`COCO_TO_ADE` in `src/nodes/control/_palettes.ts`). For example sky-other-merged → sky (6,230,230),
    tree-merged → tree (4,200,3), person → person (150,5,61) and the walls → wall.
  - *Coverage.* About 70 ADE20K classes are reachable. Interiors (lamps, cushions, wardrobes…) are coarser than with
    OneFormer / UniFormer.
  - *Per pixel.* The class of the query with the highest P(mapped class) · σ(mask) wins, so regions are hard-edged,
    like the reference maps.
- **Scribble, safe and shuffle.** These are ports of controlnet_aux `nms`, `safe_step` and `make_noise_disk`.
  - The shuffle noise grid is hashed per seed, so it is reproducible, unlike numpy's random state.
  - Its min-max normalisation uses the grid values, not the cubic overshoot.

## Models

| Used by | Model | File @ commit | Size | Licence |
|---|---|---|---|---|
| `control.mlsd` | M-LSD tiny | [mlboydaisuke/M-LSD-tiny-OpenVINO](https://huggingface.co/mlboydaisuke/M-LSD-tiny-OpenVINO) `mlsd_fp16.onnx` @ `db488937a8c23fa5f2f6b59f5be70b5044960deb` (fp32 weights despite the name) | 2.6 MB | Apache-2.0 (card; upstream navervision/mlsd Apache-2.0) |
| `control.openpose` (hands) | MediaPipe Hand Landmarker | `storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task` | 7.8 MB | Apache-2.0 |
| `control.lineart` | Informative Drawings anime / opensketch (= `sk_model.pth` / `sk_model2.pth`, bit-identical weights) | already in the catalog (*AI Line Art*): x-Liola-x @ `f6030b3a`, backnotprop @ `b18595c1` | 17.2 MB each | MIT |
| `control.depth` | Depth Anything V2 Small / MoGe-2 | already in the catalog (*Depth Map*, *Surface Normals*) | 27–50 MB / 141 MB | Apache-2.0 / MIT |
| `control.normal` | MoGe-2 ViT-S | already in the catalog | 141 MB | MIT |
| `control.openpose` (body, face) | MediaPipe Pose / Face Landmarker | already in the catalog (*Pose / Body*, *Faces*) | 5.8–9.4 MB / 3.8 MB | Apache-2.0 |
| `control.seg` | DETR ResNet-50 panoptic | already in the catalog (*Scene Segmentation*) | 86.6 MB | Apache-2.0 |

- **CORS.** Every URL was checked with `curl -sI -H "Origin: …"`. huggingface.co answers 302 with
  `access-control-allow-origin`, and the CDN answers 200 with `*`. Google Storage answers `*`.
- **Consent prompt.** Models over Preferences › *Ask before downloading* (50 MB) prompt once, as for every AI node.

### What was looked for and not used (November 2026)
- **PiDiNet** (`softedge_pidinet`):
  - *The export exists.* [bdck/PiDiNet_ONNX](https://huggingface.co/bdck/PiDiNet_ONNX) @ `6b3f899d` is an exact
    ONNX export of `table5_pidinet.pth` (2.9 MB, sigmoid inside, dynamic size).
  - *Why it is not used.* The repo has no licence. The upstream LICENSE (hellozhuo/pidinet, also copied into
    ControlNet-v1-1-nightly) is MIT text prefixed with *"It is just for research purpose, and commercial use should be
    contacted with authors first."*, which is not cleanly permissive.
- **HED:**
  - lllyasviel's re-trained `ControlNetHED.pth` (Apache-2.0 per its code comment) has **no ONNX export**.
  - The only HED ONNX found (axodoxian/controlnet_onnx `annotators/hed.onnx`) is the original HED through
    sniklaus/pytorch-hed, which is **GPL-3.0**. Excluded.
  - Hence `control.softEdge` is a GPU approximation. It gives thick soft outlines with texture suppressed, close to
    HED in character but not identical. *Safe* mode hides most of the remaining texture.
- **M-LSD large** (`mlsd_large_512_fp32.pth`, the one ControlNet uses): no ONNX export found.
  - The tiny model above is what the sd-webui ecosystem calls `mlsd_tiny`.
  - The LiteRT conversion changed the decoder upsample to half-pixel, so lines can differ slightly from the large model.
- **TEED** (MIT): only `.pth` / safetensors, no ONNX.
- **DexiNed** (opencv/edge_detection_dexined, MIT) is a 47 MB int8 model with a fixed 480×640 input. Not needed.

## Generation bridge

### Settings: Preferences › Generation
- **Server:** *Off* (default) / *ComfyUI* / *AUTOMATIC1111 (Forge, SD.Next API)*.
- **Server URL:**
  - Defaults: `http://127.0.0.1:8188` for ComfyUI, `http://127.0.0.1:7860` for A1111. Each type keeps its own URL.
  - Only loopback addresses are suggested. Any URL can be typed; a non-loopback, non-LAN host shows a warning.
- **Test Connection** lists the checkpoints and ControlNet models (also samplers and schedulers). The lists fill the
  pickers under *Generate*.
  - ComfyUI: `/object_info/CheckpointLoaderSimple`, `/ControlNetLoader`, `/KSampler`.
  - A1111: `/sdapi/v1/sd-models`, `/controlnet/model_list`, `/sdapi/v1/samplers`, `/sdapi/v1/schedulers`.

### `sd.generate`: Generate (Stable Diffusion)
- **Inputs** (all optional):
  - `image`: the init image, so the job is img2img;
  - `control1`–`control3`: control maps;
  - `mask`: the inpainting mask, white = regenerate; it needs `image`.
- **Params:**
  - `positive`, `negative` (multiline);
  - `checkpoint`;
  - `steps` 20, `cfg` 7;
  - `sampler`, `scheduler` (empty = the server default);
  - `seed` (−1 = random per Generate);
  - `denoise` 0.6 (img2img only);
  - `baseSize` 512/768/1024, `width`/`height` (0 = match the input's aspect; the short side is `baseSize`, rounded
    to multiples of 64; explicit sizes are rounded to multiples of 8);
  - per unit, `cnNModel`, `cnNWeight`, `cnNStart`, `cnNEnd`;
  - `autoRun` (off);
  - `run`: hidden; the *Generate* button sets it.
  - The batch size is always 1.
- **Generate button.** Properties shows **Generate**, **Test connection** and **Server…** above the params, plus
  pickers that fill `checkpoint`, `sampler`, `scheduler` and `cnNModel` from the server's lists
  (`src/core/sd/GenerateBar.tsx`). Groups that expose `run` (the presets) get the same bar.
- **No generation while you edit.** A job starts only when the `run` token changes, or with *Auto-run* (after a
  700 ms pause; a newer evaluation cancels the pending one).
  - Results are cached by every image-affecting param plus 24×24 fingerprints of every input. Preview, export,
    zoom (`heavy: true`) and re-renders reuse them.
  - When params change without a run, the last image of that node stays on screen, and the status bar says
    *press Generate*. If the node's job is still running, the new evaluation re-joins it instead of cancelling it.
- **Cancellation.** It is reference-counted, like `InferenceMemo`: a job is cancelled only when every evaluation
  waiting on it was superseded, after a 400 ms grace period.
  - Cancelling stops the uploads, the polling and the A1111 request.
  - A ComfyUI prompt that has not started yet is removed from the queue with `POST /queue {delete:[id]}`. A running
    one finishes on the server; its result is just not shown.
- **Progress** appears in the AI toast (`setAiTask`): step / total from ComfyUI's websocket, or from A1111's
  `/sdapi/v1/progress`.

**ComfyUI request.**
1. The images are uploaded with `POST /upload/image` (`type=input`, `overwrite=true`).
2. Then an API-format workflow is queued with `POST /prompt {prompt, client_id}`:
   ```
   CheckpointLoaderSimple → CLIPTextEncode ×2 → [ControlNetLoader + LoadImage → ControlNetApplyAdvanced] ×N (chained)
   EmptyLatentImage | LoadImage → VAEEncode [→ SetLatentNoiseMask ← ImageToMask(red) ← LoadImage]
   → KSampler → VAEDecode → SaveImage (prefix "Darkroom")
   ```
   The builder is `buildComfyWorkflow()` in `src/core/sd/comfy.ts`, with snapshot tests.
3. Progress comes over `/ws?clientId=`. Completion is detected by polling `/history/{id}`.
4. The image is fetched with `/view?filename=…&subfolder=…&type=output`.

**A1111 / Forge request.**
- `POST /sdapi/v1/txt2img`, or `/sdapi/v1/img2img` with `init_images`, `denoising_strength`, and optionally `mask`
  (with `inpainting_fill: 1`).
- The checkpoint goes in `override_settings.sd_model_checkpoint`.
- Each unit goes in `alwayson_scripts.controlnet.args`:
  `{enabled, image, module: "none", model, weight, guidance_start, guidance_end, resize_mode: "Just Resize", control_mode: "Balanced"}`.
  The module is `none` because the maps are already preprocessed.
- The builder is `buildA1111Payload()` in `src/core/sd/a1111.ts`.

### Server setup (exact flags)
**Mac app: no flags needed.** The desktop app relaxes CORS/Origin checks for exactly the server URL you configure
in Preferences › Generation, so a stock ComfyUI or A1111 (`--api` is still required for A1111) works as-is.

**Browser / PWA:** the browser only lets Darkroom talk to the server when the server allows Darkroom's origin (CORS).

**ComfyUI**
```bash
# allow any origin (simplest for a loopback-only server)
python main.py --listen 127.0.0.1 --port 8188 --enable-cors-header
# or only Darkroom's origin, e.g. the dev server / your PWA URL / the Mac app
python main.py --listen 127.0.0.1 --port 8188 --enable-cors-header http://localhost:5173
python main.py --listen 127.0.0.1 --port 8188 --enable-cors-header app://darkroom
```
ControlNet models go in `ComfyUI/models/controlnet/` and checkpoints in `ComfyUI/models/checkpoints/`.

**AUTOMATIC1111 / Forge**
```bash
# webui-user.sh (macOS / Linux) — Windows: set COMMANDLINE_ARGS=... in webui-user.bat
export COMMANDLINE_ARGS="--api --cors-allow-origins=http://localhost:5173"
# several origins are comma-separated; or use a regex
export COMMANDLINE_ARGS="--api --cors-allow-origins-regex=.*"
```
- **A1111** needs the [sd-webui-controlnet](https://github.com/Mikubill/sd-webui-controlnet) extension.
  Models go in `extensions/sd-webui-controlnet/models/` or `models/ControlNet/`.
- **Forge** has ControlNet built in (`models/ControlNet/`). SD.Next's API is compatible.
- **Without CORS.** If the flags are missing, the node fails with *"Could not reach … CORS …"* and the exact flag to add.
- **HTTPS pages.** A PWA served over HTTPS can reach `http://127.0.0.1` / `http://localhost`, which browsers treat as
  secure. A plain-HTTP **LAN** address is blocked as mixed content; the error says so. Use localhost, HTTPS on the
  server, or the Mac app.
- **Private Network Access.** Chromium may also send a Private Network Access preflight. If it is blocked, run the
  server on localhost.

### Security and privacy
- **Nothing is sent by default.** The server is *Off*, and the node shows a placeholder.
- **What is sent, and when.** Only when a server is configured *and* a Generate node runs: that node's prompts and its
  connected images (init, maps, mask), resized to the generation size, go to the configured URL only.
- **No credentials.** Requests use `credentials: 'omit'`.
- **Visible destination.** Properties and Preferences always show where images go. A non-local URL is flagged.
- **What comes back.** Server responses are only decoded as images or JSON. Nothing from the server is executed.
- **Mac app (Electron).** The renderer tells the main process the configured server URL (`setGenServer`). For
  requests to exactly that scheme + host + port (including ComfyUI's websocket), main drops the `app://` Origin and
  Referer headers, answers CORS preflights and adds CORS response headers. Every other request is untouched, and with
  generation *Off* nothing is rewritten at all.

## Core ML (built-in, Mac app)
Choose **Core ML (built-in, this Mac)** as the server in Preferences › Generation. SD 1.5-family models then run on the
Mac itself, through Apple's Core ML, with ControlNet. There is no server, no CORS, and nothing is uploaded. The option
is absent in the browser / PWA build: a synced `genServer: 'coreml'` pref simply means *off* there.

Why Core ML: AUTOMATIC1111 and ComfyUI cannot load Core ML models. Apple's
[ml-stable-diffusion](https://github.com/apple/ml-stable-diffusion) (MIT) runs them on the Neural Engine or GPU.
SDXL is deliberately not supported; the engine rejects SDXL models with a clear message.

### Architecture
- **`native/coreml-sd/`** is a Swift package with an executable target, `DarkroomCoreML`, shipped as
  `darkroom-coreml`.
  - It depends on `apple/ml-stable-diffusion`, pinned to release **1.1.1**
    (`5a170d29cf38e674b80541d7ce22929c6a11cdde`).
  - It uses only the package's public building blocks (BPETokenizer / TextEncoder, VAE Encoder / Decoder, PNDM and
    DPM-Solver++ schedulers, ManagedMLModel) and runs **its own denoising loop**. That loop adds:
    - **ControlNet weight and step range per unit.** The package's pipeline sums the residuals unweighted.
    - **Inpainting.** A latent noise mask is applied every step, then a pixel composite outside the mask.
    - **ControlNet inpaint convention.** Masked pixels are −1 in the control image (`maskedCond`).
    - **One UNet for everything.** The *ControlledUnet* gets zero residuals when no ControlNet is active, so a model
      needs only one UNet compiled and the plain `Unet.mlmodelc` (1.6 GB) is not even downloaded.
    - **NumPy-compatible RNG.** Seeds match Apple's CLI and Mochi Diffusion.
- **Protocol: JSON lines on stdin/stdout.**
  - Requests are `{id, cmd, …}`. Replies are `{id, ok, result | error{code, message}}`. Events are `progress` and
    `state`.
  - Commands: `hello`, `listModels {roots}`,
    `load {modelDir, computeUnits, controlNets[], reduceMemory, idleUnloadSeconds}`,
    `generate {prompt, negative, seed, steps, guidance, scheduler: dpm++ | dpm++karras | pndm, startingImage,
    strength, mask, controlNetInputs[{name, image, weight, start, end, maskedCond}], width, height}`, `cancel`,
    `unload`, `status`, `shutdown`.
  - Why stdio rather than a localhost socket with a token:
    - nothing else on the machine can reach the helper (no port, no secret to leak);
    - its lifetime is the parent's (stdin EOF = exit);
    - there is nothing to configure or firewall.
  - Framework `print()`s are redirected to stderr, so stdout carries only the protocol.
- **Errors carry a `code`.**
  - `attentionMismatch`: a split-einsum ControlNet with an original base, or the reverse.
  - `wrongResolution`: a ControlNet or input image of another size.
  - `noControlNetUnet`: the model was not converted with `--unet-support-controlnet`.
  - `compiling`: a request arrived while the first load is still compiling.
  - Also `unsupported` (SDXL, chunked iOS UNets), `notFound` and `cancelled`.
- **States.**
  - *First use compiles.* Each part reports `compiling`, and the AI toast says so; later loads are seconds.
  - *Idle unload.* Model memory is freed after 5 idle minutes, and main quits the helper after 20.
  - *Reduce memory.* The **Reduce memory use** checkbox loads each part only while it runs.
- **Neural Engine placement check.** On macOS 14.4+ the helper asks Core ML's `MLComputePlan` where the UNet would run.
  - On the test machine (M2 Pro, macOS 27.2), Core ML places neither SD 1.5 split-einsum UNet (plain or
    ControlledUnet) on the Neural Engine. It falls back to the **CPU**, which is 3× slower than the GPU.
  - In that case the helper gives just the UNet `cpuAndGPU`. The text encoder, VAE and ControlNets stay on the Neural
    Engine.
  - The load result and Preferences say so. `darkroom-coreml --compute-plan <x.mlmodelc> <units>` prints the
    placement.
- **Electron main.**
  - `electron/coreml/engine.ts` spawns the helper on demand, runs one job at a time (later jobs queue; cancelling a
    queued job drops it) and routes progress.
  - `electron/coreml/downloads.ts` and `electron/coreml/zipfetch.ts` handle downloads. `electron/coreml/ipc.ts` holds
    the IPC (`window.darkroomNative.coreml`, see docs/DESKTOP.md).
  - The renderer sends only model ids and catalog ids, never paths. Extra folders come from a native folder picker.
- **Models folders.**
  - Darkroom's own folder is `~/Library/Application Support/Darkroom/coreml-models` (`<id>/` for base models,
    `controlnet/<Name>.mlmodelc`).
  - You can add folders, e.g. Mochi Diffusion's models and ControlNet folders. They are scanned to depth 3 by reading
    each `metadata.json`.
  - Resolution is the UNet `sample` shape × 8. Attention is *split-einsum* when the program uses `einsum` ops and
    *original* when it uses `matmul`.
- **Compiled cache.** Core ML caches compiled models in `~/Library/Caches/darkroom-coreml`, a few GB per model and
  compute-unit combination. Preferences shows its size and can clear it.
- **Packaging.**
  - `scripts/build-electron.mjs` runs `swift build -c release --arch arm64 --arch x86_64`, which produces one
    universal binary.
  - The binary is copied to `dist-native/darkroom-coreml/` and ad-hoc signed (`codesign -s -`, like the app). A
    `.json` beside it lists the slices.
  - electron-builder ships it via `extraResources` (`Contents/Resources/darkroom-coreml/`). `mac.x64ArchFiles` lets
    the already universal file pass the universal merge.
  - Without a Swift toolchain, the build skips the helper and the app shows the engine as unavailable. Set
    `DARKROOM_SKIP_COREML=1` to skip it on purpose.
  - The x86_64 slice builds and runs. On Intel Macs Core ML uses CPU/GPU only (slow). Without the slice, the engine is
    disabled on Intel with a message.
  - The helper needs macOS 13.1 (an ml-stable-diffusion requirement). On 13.0 the engine is disabled with a message.

### Models (curated downloads; none are bundled)
Downloads run in Electron main, so CORS is irrelevant (Hugging Face sends permissive CORS anyway).
- **Licence first.** Each download first shows the **CreativeML OpenRAIL-M** licence and its use restrictions, and
  must be accepted.
- **Only the needed parts.** Main reads the zip's central directory with an HTTP range request and fetches only the
  entries it needs, inflating them as they stream in.
- **Checked.** Every file's CRC-32 is compared with the zip directory.
- **Resumable.** Finished files are remembered, and a stored entry resumes with a Range request. The folder appears
  only when complete.

| Item | Source (pinned) | Fetched |
|---|---|---|
| SD 1.5 · Neural Engine (split-einsum) 512² | `coreml-community/coreml-stable-diffusion-v1-5_cn@57b9414` `split_einsum/stable-diffusion-_v1-5_split-einsum_cn.zip` (3.58 GB zip) | 1.98 GB |
| SD 1.5 · GPU (original) 512², 768×512, 512×768 | same repo, `original/…_cn.zip` | 1.98 GB each |
| DreamShaper 8 · NE / GPU 512² | `coreml-community/cormel-DreamShaper-v8_cn@f8b9183` | 1.98 GB |
| Realistic Vision 5.1 · NE / GPU 512² | `coreml-community/coreml-realisticVision-v51VAE_cn@3977db7` | 1.98 GB |
| ControlNet 1.1 (canny, depth, softedge, lineart, lineart anime, openpose, scribble, tile, seg, normalbae, inpaint, mlsd, shuffle, ip2p) | `coreml-community/ControlNet-Models-For-Core-ML@2a21985` `CN/<Name>-SE.zip` (split-einsum 512²) or one resolution out of `CN/<Name>.zip` (original 5x5 / 5x7 / 7x5 / 7x7) | 671 MB each |

The *ControlNets for* picker in Preferences offers the variant matching the chosen base model (attention + size).

### Using it
- **`sd.generate` on Core ML.**
  - `checkpoint` is a model id (empty = the first ControlNet-capable SD 1.5 model).
  - `cnNModel` accepts an id, a file name, or a **kind** (`canny`, `depth`, …). A kind picks the installed variant that
    matches the model; the Core ML presets use kinds.
  - The ControlNet preprocessor nodes provide the control images (standard conventions: white edges on black, near =
    bright depth, …).
  - Sampler `dpm++` (default), `dpm++ karras` or `pndm`.
- **Fixed size.** Every input is fitted to the model's size by the node's **Fit** param:
  - *letterbox* (default): the whole input fits, with a blurred fill for photos and black for maps; the result is
    cropped back to the input's aspect.
  - *crop*: the centre is generated at full model resolution, and the node outputs that crop.
  - *stretch*: the input is squashed to the model size and the result stretched back.
  - Width, height and base size are ignored on Core ML.
- **Style** (any backend): a curated prompt snippet plus its negative.
  - Choices: oil painting, watercolor, anime cel, pencil sketch, cinematic photo, pixel art, riso print, ink comic,
    ukiyo-e, impressionist, charcoal, stained glass, low-poly 3d.
- **Presets** (`src/presets/coreml.ts`, category *Core ML*):
  - `coreml.restyle`: Style + img2img (0.7) + canny ControlNet (0.85), with an optional tile unit (weight 0 = off,
    needs no model). Then the colours of an optional **reference** input (`color.matchColor`), then optional AdaIN
    **Style from image** of the reference (`ai.styleFromImage`, mix 0 = off, no download).
  - `coreml.depthRestyle`: the same, but with depth and img2img at 0.85.
  - `coreml.sketchToImage`: scribble, txt2img.
  - `coreml.poseTransfer`: OpenPose, txt2img.
  - `coreml.inpaint`: image + mask → `control.inpaintMask` → latent-mask inpainting with the inpaint ControlNet.
    Pixels outside the mask are kept exactly.
- **Caching.** Results are cached like the other backends. The key adds fit and compute units.

### Measured (M2 Pro 16 GB, macOS 27.2, SD 1.5 split-einsum `_cn` + Canny-SE, 512², 20 steps DPM++)
| | First load (compile) | Warm load (new process) | txt2img 20 steps | img2img 0.75 + canny (15 steps) |
|---|---|---|---|---|
| Neural Engine (UNet on GPU, see above) | 37.4 s | 3.3 s | 10.4–12.0 s (≈1.95 it/s) | 10.9 s |
| GPU | 7.2 s* | 5.3 s | 10.9–12.8 s (≈1.9 it/s) | 12.2–12.5 s |

*The UNet's GPU compile was already cached by the Neural Engine run. Before the placement check, Neural Engine mode ran
the UNet on the CPU at 0.65 it/s. ControlNet on the Neural Engine costs about 0.15 s per step.

## Presets (`src/presets/control.ts`)
- **`control.allMaps`, *All Control Maps*:** one photo → a Control Sheet of canny, depth, normal (BAE), soft edge,
  OpenPose and ADE20K segmentation.
- **`control.restyle`, *Restyle (SD + ControlNet)*:** photo → depth (weight 0.8) + canny (0.5) → `sd.generate`,
  img2img at denoise 0.6. The default ControlNet names are `control_v11f1p_sd15_depth.pth` and
  `control_v11p_sd15_canny.pth`.
- **`control.poseTransfer`, *Pose Transfer (SD + OpenPose)*:** `openpose_full` → `sd.generate` txt2img with
  `control_v11p_sd15_openpose.pth`.

The generation presets expose the prompt, checkpoint, seed, steps, CFG, unit models / weights and the hidden `run`,
so the Generate bar works on the group node.

## Testing
```bash
npx vitest run src/core/sd src/nodes/control     # builders (snapshots), OpenPose mapping, palettes, M-LSD decode, sizes
node scripts/snap.mjs out.png "node=control.canny&img=street"
node scripts/snap.mjs out.png "preset=control.allMaps&img=street&wait=280"   # model downloads on first use
```
- **Consent prompt.** The harness waits on the download-consent prompt for models over 50 MB (MoGe-2, DETR). Set
  `aiConfirmMB: 0` in `localStorage['darkroom.prefs']` (e.g. a Playwright `addInitScript`) for unattended renders.
- **Mock servers.** The bridge was tested end to end against mock ComfyUI and A1111 servers written in Node. They
  implement the endpoints above, including the websocket, validate the workflow and payload, and return a generated
  PNG. The tests ran both through the harness and in the editor UI (Generate button, Test connection pickers, no
  re-generation on param tweaks).
- **Real servers.** Testing against a real ComfyUI / A1111 is still pending; none was available on the test machine.
- **Core ML.**
  - `npx vitest run src/core/sd electron/coreml` covers the request builder, fitting, resolvers, catalog and styles,
    plus the range-request zip extractor against a mock CDN (CRC checks, resume after a dropped connection, unsafe
    paths).
  - The helper speaks JSON lines, so it is easy to drive from a Node script (spawn, write requests, read replies).
  - `DARKROOM_COREML_PROFILE=1` makes it print per-step ControlNet / UNet / mixing times to stderr.
  - `darkroom-coreml --list <dir>` and `--compute-plan <x.mlmodelc> <units>` help with model problems.
  - `DARKROOM_COREML_LOG=1` makes Electron main log every helper request.
  - `localStorage['darkroom.debug.sd'] = '1'` traces every `sd.generate` cpu() decision (scale, key, input
    fingerprint, hit / triggered) as `[darkroom sd] …`.
- **Re-evaluation loop (fixed).**
  - Symptom: exporting while a generated result was on screen made the viewer flicker and the export never finish.
  - Cause: `exportBlob` polls the output at scale 1 in the engine's main cache namespace while the viewer rendered it
    at preview scale. Each async cpu node's pending run was replaced by the other scale's, and each completion
    re-invalidated the viewer (3,351 cpu() calls and a 300 s timeout in one test).
  - Fix, part 1: `sd.generate` answers synchronously unless a generation is really in flight.
  - Fix, part 2: `exportBlob` suspends viewer renders until the export is done, like video export does.
  - Result: exactly one helper `generate` per Generate click, five cpu() calls in the whole scripted session
    (generate, idle, view other nodes, Preferences, zoom, export), and the export took 0.3 s.

## Known gaps
- **Core ML:**
  - On this test machine Core ML will not place the SD 1.5 UNet on the Neural Engine, so it runs on the GPU. This may
    differ on other macOS versions and Macs; the placement check adapts.
  - Only SD 1.5-family models (SD 2.x without ControlNet). No SDXL, no IP-Adapter.
  - The fixed model size means letterboxed photos use part of the 512² canvas. Use the 768×512 GPU model for 3:2
    photos.
  - The x86_64 helper builds but was not run on an Intel Mac.
- **Soft edge is an approximation.** Use *safe* mode or Canny if a ControlNet softedge model over-reacts to texture.
  It becomes exact as soon as a permissively licensed HED/PiDiNet ONNX exists.
- **M-LSD is the tiny model**, not large.
- **OpenPose:**
  - Body landmarks come from MediaPipe. Where it finds no body (e.g. the tight `portrait` sample, where *Pose / Body*
    also finds none), only the face/hands modes draw anything.
  - The 68 face points and the neck are derived, not predicted.
  - Canvas drawing is anti-aliased; OpenCV's is not. The colours are exact, but the edges have blended pixels.
- **Seg covers about 70 ADE20K classes** (COCO-panoptic vocabulary). There is no COCO-palette mode for the
  OneFormer-COCO seg model.
- **Inpaint:**
  - On ComfyUI / A1111, `control.inpaintMask` formats masks, but the ControlNet *inpaint* unit (masked pixels = −1) is
    not built automatically. The built-in Core ML engine does build it (`maskedCond`).
  - Use `sd.generate`'s `mask` input for normal img2img inpainting, or wire *Masked image (transparent)* into a unit
    when your UI reads alpha.
- **Core ML first-load label.** The “compiling (first use)” label comes from markers in the app's user-data folder.
  A fresh profile shows it even when Core ML's own cache is warm; the load is then quick anyway.
- **Result cache.**
  - The cache is in memory: after a reload a node shows *Press Generate* until it runs again.
  - Results are not saved in the project. Export or save the image.
