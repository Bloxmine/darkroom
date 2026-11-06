# Custom nodes

Darkroom has two ways to write your own GLSL without touching the source code:

| | **GLSL Shader node** (`core.shader`) | **Node Builder** (custom node types) |
|---|---|---|
| What | One node instance with its code in a parameter | A reusable node *type* (`user.myEffect`) |
| Where | Node › Utility › GLSL Shader | Node › New Custom Node… |
| Inputs | fixed: `a`, `b`, `c` (optional) | any number, image or mask, optional or required |
| Params | fixed knobs `p1`..`p4` (0–1) + `color1` | declared with `@param` annotations |
| Passes | 1 | 1 or more, each with its own size/filter/repeat |
| Saved in | the project (it's just a param) | your library (IndexedDB) **and** embedded in every project that uses it |

## GLSL Shader node

Add **Utility › GLSL Shader**, connect up to three images to `a`, `b`, `c` and edit the **Code**
parameter. It is a fragment shader body. It must define `void main()` and write `fragColor`.
Compile errors show as the red badge on the node, and in full in the Properties panel.

```glsl
void main() {
  vec4 src = texture(u_a, v_uv);
  vec3 tinted = luma(src.rgb) * u_color1.rgb * 1.6;
  fragColor = vec4(mix(src.rgb, tinted, u_p1), src.a);
}
```

## Node Builder

**Node › New Custom Node…** opens the builder. It is a floating, non-modal window, so you can keep
the viewer and graph in sight. To edit an existing custom type, select one of its nodes and either use
**Node › Edit Node Type…** or click **Edit Node Type…** in the Properties panel.

- **Node:** `id` (namespaced, e.g. `user.myEffect`; must not clash with a built-in or plugin id),
  name, category (pick an existing one to file it next to built-ins), and description.
- **Inputs:** name (a GLSL identifier, available as `u_<name>` and `u_<name>_size`), type
  `image`/`mask`, optional. An unconnected optional input samples black. A mask samples white.
- **Passes:** one tab per pass, each with a CodeMirror GLSL editor. The per-pass options are:
  - **Size:** *Same as node*, or *Scale factor* × node size (e.g. 0.5 for a half-res blur pass).
  - **Filter:** how later passes sample this one (`nearest` for pixel art).
  - **Repeat:** run the pass N times ping-pong (`u_prev` = previous iteration). Use a number or the
    name of an `int` param.
- **Parameters (from @param):** a live table parsed from your annotations (see below).
- **Problems:** `@param` mistakes (yellow), compile errors (red; they are compiled off-screen while
  you type, so line numbers match your editor), and runtime errors of instances in the graph.
- **Cheat sheet:** a collapsible list of the built-in uniforms for the current inputs/pass, the
  library functions and the `@param` syntax.

Buttons:
- **Apply** registers or replaces the type and saves it to your library. Instances in the graph
  re-render at once. Tick **Live** to apply automatically while you type, whenever there are no errors.
- **Insert into Graph** applies the type, adds a node after the selected node, and views it.
- **Open… / Export…** load or save a `.drnode.json` file. **Delete from Library** removes the type.
- **Template:** three starters: *Invert*, *Two-input blend* (with an optional mask), and
  *Two-pass blur* (half-res horizontal + vertical).

Plugin nodes can also be opened. The builder then edits a **copy** under a new `user.*` id.

### Shader environment

Exactly as for built-in nodes (see `docs/NODE_AUTHORING.md`):
`v_uv` (0,0 = top-left), `fragColor`, `u_resolution`, `u_scale`, `u_time`, `u_iteration`,
`u_<input>` / `u_<input>_size`, `u_prev`, `u_pass0…`, every param as `u_<key>`, and the library
(`luma`, `rgb2hsv`, `blendOverlay`, `fbm`, `hash22`, `texClamp`…). Pixel-unit params must be
multiplied by `u_scale`, so the preview matches the export.

## `@param` annotations

Declare a uniform and annotate it on the same line:

```glsl
uniform float u_amount;   // @param min=0 max=2 default=1 label="Amount" desc="Effect strength"
uniform float u_radius;   // @param min=0 max=100 default=8 pixels label="Radius"
uniform int   u_steps;    // @param min=1 max=32 step=1 default=8
uniform bool  u_invert;   // @param default=false
uniform vec2  u_center;   // @param default=0.5,0.5 step=0.01
uniform vec4  u_tint;     // @param color default=#ff8800          (or default=1,0.5,0,1)
uniform int   u_mode;     // @param enum=add|multiply|screen default=multiply
```

| GLSL type | Param type | Attributes |
|---|---|---|
| `float` | float | `min max step default pixels` |
| `int` | int | `min max step default` |
| `int` + `enum=a\|b\|c` | enum (the uniform is the option index) | `default=` option name or index |
| `bool` | bool | `default=true/false` |
| `vec2` | vec2 | `default=x,y step` |
| `vec4` + `color` | color (RGBA 0–1) | `default=#rgb/#rrggbb/#rrggbbaa` or `r,g,b[,a]` |

Common attributes are `label="…"`, `desc="…"` (tooltip), `hidden`, and `pixels` (shows "px", a UI
hint only, so you still multiply by `u_scale`).

Rules:
- The uniform must be named `u_<key>`. The key is what's saved in projects, so renaming it resets the
  value in existing nodes.
- Names reserved by the engine are an error: `u_resolution`, `u_scale`, `u_time`, `u_iteration`
  and `u_prev`. Input names and `pass<N>` are reserved too.
- The engine already declares every param uniform, so the builder **replaces the annotated lines
  with a comment** before compiling. Line numbers stay unchanged.
- Declare a param once, in any pass. It is available in every pass. Repeating an identical
  declaration in another pass is fine. A *different* declaration is an error.

## Where custom nodes are stored

- **Your library:** IndexedDB (`darkroom-extensions` → `nodes`) in this browser. It is loaded at startup
  after the built-ins and before the autosaved project. The Plugins dialog lists it under *My custom nodes*.
- **Projects:** when you save, every custom type the project uses (and every *data-plugin* type) is
  embedded in the `.darkroom` file as `customNodes: SerializedNodeDef[]`, along with a `plugins: [{id, name,
  version, url, nodes}]` list. When you open the project on another machine, the missing types are
  registered from the file (shown as *embedded in this project*). Types you already have installed win;
  the status bar notes when the embedded copy differs. Code-plugin nodes can't be embedded. Their nodes show
  an error naming the plugin id and its install URL.

## The `.drnode.json` format

```json
{
  "format": "darkroom-node",
  "version": 1,
  "node": {
    "id": "user.softBlur",
    "name": "Soft Blur",
    "category": "Custom",
    "description": "…",
    "inputs": { "image": { "type": "image" } },
    "params": { "radius": { "type": "float", "default": 16, "min": 0, "max": 150, "pixels": true, "label": "Radius" } },
    "passes": [
      { "frag": "uniform float u_radius; // @param …\nvoid main() { … }", "size": { "scale": 0.5 } },
      { "frag": "void main() { … u_prev … }", "filter": "linear", "repeat": 1 }
    ]
  }
}
```

This is `SerializedNodeDef` from `src/core/types.ts`. (De)serialisation lives in `src/core/serialize.ts`:
- `frag` is the GLSL string. `uniform … u_<param>;` lines are stripped on load, so annotated
  sources work as-is. Params missing from `params` are filled in from `@param` annotations. Explicit
  entries win.
- `size` is declarative: `{ "scale": 0.5 }` (× node size), or `{ "width": 256, "height": 256 }`
  (full-resolution pixels × render scale). Either side may be omitted.
- `repeat` is a number, or the key of an int/float param.
- No functions anywhere, so a `cpu()` step or `size()`/`uniforms()` functions need a code plugin
  (see `docs/PLUGINS.md`).

Import with **Node › Import Node Type…** or the Plugins dialog. Export with **Node › Export Node Type…**,
the Properties panel, or the builder.
