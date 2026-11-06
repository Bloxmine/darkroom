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

## Runtime (`src/core/ai/`)

| File | Role |
|---|---|
| `models.ts` | Model catalog: pinned URLs, sizes, licences; picks fp16 vs int8 per backend |
| `cache.ts` | Cache-first downloads with progress (Cache Storage `darkroom-models`); plain `fetch` where Cache Storage is unavailable |
| `runtime.ts` | Main thread: execution-provider choice, worker lifecycle, model loading, observable state, `runModel()` |
| `session.ts` | ORT session host shared by the worker and the main-thread fallback (fp16 I/O conversion, WebGPU→WASM fallback) |
| `worker-gpu.ts` / `worker-wasm.ts` | Worker entries: the JSEP build (WebGPU + CPU) or the smaller CPU-only build |
| `image.ts` | Resampling, NCHW packing, normalisation, the inference memo |
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
- For automation, `window.__darkroomAi` exposes `getState()`, `runModel()`, `prefetchModel()`,
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
