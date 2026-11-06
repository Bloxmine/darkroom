# Video, webcam and animated noise

Darkroom renders moving images with the same node graph it uses for stills. A project has a
**timeline** (time, fps, length, loop). Time only runs when the project is *in motion*: it contains a
**Video** or **Webcam** node, or **Animate** is on. Otherwise `u_time` and `u_frame` stay 0, and stills
and still exports render exactly as before, byte for byte.

## Using it

- **Import a video.** Drop an MP4, WebM, MOV or MKV onto the node graph, or use *File › Import Image…*
  (it accepts video too). This creates a **Video** node (`core.video`, category Input). The timeline
  takes the clip's length and frame rate.
- **Webcam.** Add *Input › Webcam* (`core.webcam`). The browser asks for camera permission. The node has
  *Device* (camera 1–4 in the browser's order), *Resolution* and *Mirror*. While a webcam is in the
  graph, the viewer renders continuously and playback starts automatically.
- **Animate a still.** *Playback › Animate*, or the film-strip button in the viewer toolbar, runs time on
  a photo so grain, VHS noise, glitches and gate weave move.
- **Transport bar** (under the viewer; shown while in motion): go to start, previous/next frame,
  play/pause, loop, a scrub slider, the timecode `mm:ss.ff / length #frame`, timeline *fps* and
  *len*gth, **Realtime** (keeps wall-clock speed and drops frames) or **Every frame** (renders each
  frame, and may run slower than realtime), the measured preview fps, the Animate toggle, and Export Video.
- **Keys.** <kbd>Space</kbd> plays and pauses while the project is in motion and focus isn't in a text
  field. <kbd>←</kbd>/<kbd>→</kbd> step one frame. These are in the **Playback** menu.

### Video node parameters

| Param | Meaning |
|---|---|
| Video | The file (asset). |
| Trim start / Trim end (s) | Source range. End 0 = to the end of the file. |
| Speed | Playback rate (0.05–8). |
| Loop | Loop the clip on the timeline. Off = hold the last frame. |

The node's output size is the video's display size, and the project size follows the first video when
no Image node exists.

## Export

*File › Export Video…* (<kbd>Ctrl/⌘+Shift+E</kbd>):

- **Container and codec:** MP4 with H.264 (default), HEVC or AV1, or WebM with VP9, AV1 or VP8. The
  dialog checks `VideoEncoder.isConfigSupported` (through mediabunny's `canEncodeVideo`) for the exact
  size, fps and bitrate, and shows the reason when a combination isn't supported.
- **Quality** preset (Low to Very high) or a fixed bitrate in Mbit/s.
- **Resolution:** full, 75 %, 50 % or 25 % of the output. Sizes are rounded down to even numbers
  for 4:2:0.
- **Frame rate and duration.** For a still, the duration is N seconds of animated noise.
- **Audio passthrough:** copies the encoded audio packets of the first Video node (trim offset applied,
  no re-encode). Needs speed 1 and an audio codec the container accepts (AAC → MP4, Opus/Vorbis → WebM).
  Otherwise the option is disabled, or skipped with a note.
- A progress bar with fps and ETA, and **Cancel**.

How it works (`src/store/videoExport.ts`): for frame *i*, it sets `t = i / fps`, `engine.time = t` and
`engine.frame = i`, decodes every video source frame-accurately at *t*, renders the Output at the export
scale, presents it 1:1 onto the engine canvas (resized to the export size, letterboxed in the viewer
while exporting), and hands the canvas to mediabunny's `CanvasSource`. That creates a
`new VideoFrame(canvas)` and feeds the WebCodecs `VideoEncoder`, then the MP4/WebM muxer
(`fastStart: 'in-memory'`). Nothing goes through `readPixels`. The viewer's own rendering is suspended
during export.

Measured in headless Google Chrome (GPU, Apple Silicon), 5 s of 1080p30 → MP4/H.264, "High":
VHS Camcorder preset ≈ 124 fps (4.1× realtime), Super 8 preset ≈ 38–41 fps (1.3× realtime).

## Making nodes move (node authors)

The shader header declares `uniform float u_time;` (seconds) and `uniform int u_frame;` (frame index).
Both are **0 for stills and still export**, so anything driven by them must be the identity at 0.
`PassContext` (the argument of `size`, `repeat` and `uniforms`) also carries `time` and `frame`.

To make seeded noise evolve per frame **without touching the shader** (GPU compilers fold constant
maths differently once a shader changes, which can flip hash-based specks, so even a `+ 0.0` can alter
a still), override the node's own seed uniform from `uniforms()`:

```ts
import { ANIMATE_PARAM, animSeed, animFloat, drift, pnum } from '../../core/motion';

params: {
  seed: { type: 'int', default: 7, ... },
  animate: ANIMATE_PARAM,                   // bool, default true
},
passes: [{
  uniforms: (c) => animSeed(c, 7),          // u_seed = seed + 7·(1 + frame mod 509) when frame > 0
  frag: F(`...uses u_seed as before...`),
}],
```

`animSeed(c, def, key = 'seed', hold = 1)` re-seeds every `hold` frames. `animFloat(c, t => ({ u_x: … }))`
overrides float param uniforms with time-dependent values, for slow drifts and flicker; `drift(t, k)`
is smooth noise in [-1, 1] that is exactly 0 at t = 0. Both return `{}` at frame/time 0 or when
`animate` is off.

Nodes animated this way: Film Grain, VHS Tracking (with a drifting tracking band), VHS Noise, Digital
Glitch (every 2 frames), CCD Sensor, Photocopy (final toner pass) and Light Leak (wanders along its edge
and flickers). Scanlines has a **Roll** param (lines/s; 0 = static). **Gate Weave** (`analog.gateWeave`)
is a new motion-only node, with frame drift and jumps, a slight rotation and exposure flicker. It is the
identity at frame 0 and is part of the Super 8 preset. A verification run rendered 11 still
shots (VHS, Super 8, each edited node) and they were byte-identical to the code before these changes.

### Time-varying CPU sources

A `NodeDef` can set `volatile: 'time' | 'live'`:

- `'time'`: `cpu()` re-runs whenever the engine time changes. `CpuContext.time` / `.frame` give the
  time. Example: `core.video` decodes the frame for `ctx.time`.
- `'live'`: `cpu()` re-runs every displayed frame (`engine.liveTick`) while the node exists. Example:
  `core.webcam` returns its `<video>` element.

Volatile textures are uploaded in place (`GL.uploadFrame`: `texSubImage2D` into the same texture, no
mipmaps; the shader box-filters when downscaling). While an async `cpu()` is pending, the previous
frame stays on screen, and a pending volatile step is retried on the next evaluation. `cpu()` may
return a `VideoFrame` or `HTMLVideoElement`.

### Frame accuracy

`src/core/video.ts` keeps one mediabunny `VideoSampleSink` per video asset. Sequential requests
(playback, export) advance a single pre-decoding sample iterator, so each packet is decoded once. Jumps
backwards or more than 2 s ahead restart from the nearest keyframe. `frameAt(t)` returns the frame whose
presentation interval contains *t*. Before every playback step and every exported frame,
`prepareVideoFrames(graph, t)` decodes the needed frames, so the engine's `cpu()` call finds them
synchronously. A test with a clip that encodes its frame number in pixels returned the exact frame
for t = 0, 1/30, 0.5, 1.4999, 2.95 and others, including backwards seeks and loop wrap.

## Storage

Video files can be big, so their bytes go to IndexedDB (`darkroom-media` → `videos`), and the project
stores `dataUrl: "idb:video/<id>"`. That keeps autosaves small, and reloading restores from IndexedDB.
When you save a `.darkroom` file, videos up to **50 MB** are embedded as data URLs, so the file opens
on other machines. Larger ones stay a reference, and the import status warns that they won't be inside
the saved file. The timeline settings (fps, length, loop, animate, realtime) are saved in
`project.timeline`.

## Known limits

- Preview playback has no audio. Audio export is passthrough only: it needs speed 1, has no loop
  wrap, and covers the first video source.
- Very large exports (above the browser's maximum canvas or drawing-buffer size, typically 8K–16K) are
  not supported.
- The CCD Sensor's fixed-pattern column noise is re-seeded with the rest of its noise in motion, because
  it shares the seed.
- The *Device* list of the Webcam node is positional (camera 1–4), because node parameters are static.
- Animated GIF/WebP export is not implemented.
