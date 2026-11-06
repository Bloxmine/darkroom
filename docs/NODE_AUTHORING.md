# Darkroom — node & preset authoring guide

Darkroom is a node-based, shader-based image editor (Vite + React + TS, WebGL2).
Core contract: `src/core/types.ts`. Read it first — it is authoritative.

## Layout

| Path | What |
|---|---|
| `src/core/types.ts` | All shared types (NodeDef, ShaderPass, Graph, GroupData, PresetDef, PluginDef…) |
| `src/core/registry.ts` | `defineNode`, `registerNode(s)`, `registerPreset`, `registerPlugin`, `listNodeDefs`, `subscribeRegistry` |
| `src/core/graph.ts` | Graph helpers: `createNode`, `createGroupNode`, `getPorts`, `getParamDefs`, `flattenGraph`, `groupNodes`, `ungroupNode`, `connect`, `wouldCycle`, `GraphBuilder`, `layout` |
| `src/core/engine.ts` | `Engine`: evaluates a graph with per-node caching; `render`, `present`, `export`, `toImageData`, `errors`, `assets` |
| `src/core/gl.ts` | WebGL2 wrapper (programs, textures, pool) |
| `src/core/glsl.ts` | Shared GLSL library prepended to every shader |
| `src/core/assets.ts` | `loadAsset(file)`, `assetFromUrl`, `assetFromDataUrl` |
| `src/nodes/core.ts` | `core.image`, `core.output`, `core.groupInput`, `core.groupOutput` |
| `src/nodes/library/*.ts` | General node library (input/color/filter/distort/composite/math/util) |
| `src/nodes/analog/*.ts` | Stylize + analog-emulation nodes |
| `src/presets/*.ts` | Presets (camera looks etc.) |
| `src/harness/main.ts`, `harness.html` | Headless render harness |
| `scripts/snap.mjs` | Screenshot harness renders to PNG |

**Auto-registration:** every `src/nodes/**/*.ts` file (not tests) must `export default` a `NodeDef[]`.
Every `src/presets/**/*.ts` must `export default` a function returning `PresetDef[]`
(a function, so it runs after all nodes are registered — `GraphBuilder` reads node defaults).
No index file needs editing.

## Writing a node

```ts
import { defineNode } from '../../core/registry';
import type { NodeDef } from '../../core/types';

export default [
  defineNode({
    id: 'filter.gaussianBlur',          // namespace.camelCase, globally unique
    name: 'Gaussian Blur',
    category: 'Filter',                  // menu category
    description: 'Separable gaussian blur.',
    tags: ['soften', 'smooth'],
    inputs: { image: { type: 'image' } },
    // outputs default to { out: { type: 'image' } }
    params: {
      radius: { type: 'float', default: 8, min: 0, max: 200, step: 0.1, pixels: true, label: 'Radius' },
    },
    passes: [
      { frag: `void main(){ /* horizontal: read u_image */ }` },
      { frag: `void main(){ /* vertical: read u_prev (= pass 0) */ }` },
    ],
  }),
] satisfies NodeDef[];
```

### Shader environment (auto-generated header — do NOT redeclare these)
- `in vec2 v_uv;` — **(0,0) is the TOP-LEFT** of the image, (1,1) bottom-right.
- `out vec4 fragColor;`
- `uniform vec2 u_resolution;` — this pass's output size in pixels.
- `uniform float u_scale;` — render scale (preview < 1, export = 1). **Any param measured in pixels
  must be multiplied by `u_scale`** so preview and export match (mark such params `pixels: true`).
- `uniform float u_time;` `uniform int u_iteration;` (index within a `repeat`ed pass).
- For every input `foo`: `uniform sampler2D u_foo; uniform vec2 u_foo_size;` (unconnected optional
  inputs are bound to a 1×1 fallback: black for image, white for mask, or `fallback`).
- `u_prev` / `u_prev_size`: previous pass output (pass 0: the first input).
- `u_pass0`, `u_pass1`, …: outputs of earlier passes of this node.
- For each texture key returned by `cpu()`: `u_<key>` / `u_<key>_size`.
- For each param: `float→float`, `int→int`, `bool→bool`, `color→vec4`, `vec2→vec2`,
  `enum→int` (index into `options`). Named `u_<paramKey>`. `string`/`asset`/`curve` params get no uniform.
- Library (see `src/core/glsl.ts`): `luma`, `luma601`, `saturate`, `srgbToLinear`, `linearToSrgb`,
  `rgb2yiq/yiq2rgb`, `rgb2yuv/yuv2rgb`, `rgb2ycbcr/ycbcr2rgb`, `rgb2hsv/hsv2rgb`, `rgb2hsl/hsl2rgb`,
  `kelvinToRgb`, `hash11/12/22/32/13`, `gaussRand`, `valueNoise`, `gradNoise`, `fbm(p, octaves)`,
  `blendMultiply/Screen/Overlay/SoftLight/HardLight/ColorDodge/ColorBurn/LinearLight`,
  `texClamp`, `texel(sampler, ivec2)`, `pixelCoord()`, `PI`, `TAU`.
- GLSL ES 3.00: use `texture()`, `texelFetch()`, `textureSize()`. Loops with uniform bounds are fine;
  cap them (`for (int i = 0; i < 256; i++) { if (i >= n) break; ... }`) to keep compilers happy.

### Colour convention
Images are display-referred **sRGB-encoded** RGBA in [0,1], not premultiplied. Buffers are RGBA16F,
so intermediates may exceed 1 (clamp at the end if needed). Convert with `srgbToLinear` when doing
physically-motivated maths (blur/bloom/light mixing look better in linear).

### Passes
- `size: (ctx) => [w, h]` to render at another resolution (e.g. downsample). `ctx.width/height` is
  the node's output size at the current scale; `ctx.scale` the render scale.
- `filter: 'nearest'` to make later samplers of that pass nearest-neighbour (pixel art, CCD blocks).
- `repeat: (ctx) => n` ping-pongs the pass n times (`u_prev` = last iteration).
- `uniforms: (ctx) => ({ u_foo: 1 })` for JS-computed uniforms (e.g. arrays of weights — declare them yourself).
- `output: 'name'` to write a named output (multi-output nodes). Otherwise the last pass writes the first output.
- `frag` may be `(params) => string` when the source depends on params (expression nodes). Programs are cached by source.

### CPU step
`cpu(ctx)` returns textures (`ImageBitmap`, canvas, `ImageData`, or `{width,height,data: Float32Array|Uint8Array}`;
row 0 = top). With passes, they become `u_<key>` samplers; without passes, keys must equal output names.
May be async. Cached by params + scale (+ inputs if `cpuReadsInputs`). Use for text, LUT parsing, curve baking.

### Output size
Default = full-res size of the first connected image input, else the project size (first image's size).
Override with `size: ({params, inputSizes, projectSize}) => [w, h]` (full-res pixels).

## Presets = groups

```ts
import { GraphBuilder } from '../core/graph';
import type { PresetDef } from '../core/types';

export default (): PresetDef[] => {
  const b = new GraphBuilder();
  const img = b.input('image');                       // group input socket
  const blur = b.node('filter.gaussianBlur', { radius: 2 }, { image: img });
  const grain = b.node('stylize.grain', { amount: 0.3 }, { image: blur });
  b.output('out', grain);                             // group output socket
  b.expose('softness', blur, 'radius', 'Softness');   // shown on the preset node
  b.expose('grain', grain, 'amount', 'Grain');
  return [{ id: 'camera.example', name: 'Example Cam', category: 'Camera', description: '…', group: b.toGroup('Example Cam') }];
};
```
Each preset needs exactly one input named `image` and one output named `out`. Expose the 4–8 most
useful knobs with friendly labels (a master `amount`/`intensity` style knob is good where it makes sense).
Users can open the group and edit internals.

## Verifying visually

```bash
node scripts/snap.mjs /path/out.png "node=filter.gaussianBlur&params={\"radius\":20}&img=street"
node scripts/snap.mjs /path/a.png "preset=video.vhs&img=portrait" /path/b.png "preset=video.vhs&p.amount=1"
```
Samples: `street`, `portrait`, `landscape` (in `public/samples`). `&scale=0.5` tests preview scale
(look should match full-res apart from resolution). `&port=name` renders a specific output.
Each shot prints JSON `{ ok, ms, width, height, errors }` — errors include GLSL compile logs.
Then view the PNG (Read tool). Run multiple shots in one invocation — it's much faster.

Typecheck: `npx tsc -b`. Unit tests: `npx vitest run`.
