# Plugins

A plugin bundles node types and presets. There are two tiers:

| Tier | File | Can do | Install |
|---|---|---|---|
| **Data** | `*.drplugin.json` | GLSL-only nodes (any number of passes), presets | No prompt (it's JSON + GLSL; shaders can't touch anything outside the GPU) |
| **Code** | `*.js` (ES module) | Anything a built-in node can: `cpu()` steps (canvas, text, LUT parsing), size/uniform functions, procedural presets | A **trust prompt** naming the source, before the first load |

Manage plugins in **Edit › Plugins…** (also under **Window**):
- **Installed plugins:** name, version, author, tier, node/preset counts, status, an enabled
  checkbox and remove. Errors and skipped ids show inline.
- **Install from File…** accepts `.drplugin.json`, `.json` and `.js`. **Install from URL** fetches the file
  (a relative URL like `/plugins/x.js` resolves against the app).
- **My custom nodes:** your Node Builder library (edit, export or delete).
- **Built-in node packs:** read-only counts per namespace.
- **Plugin Docs:** opens `/plugins/README.md`.

Example plugins (served from `public/plugins/`):
- `/plugins/example-shader-pack.drplugin.json` (data): *Duotone*, *Sobel Glow* (2 passes, the first at
  half resolution), *Kaleidoscope*, and a *Neon Night* preset.
- `/plugins/example-code-plugin.js` (code): *Text Watermark* (a CPU canvas step), *Warm Sepia* (built with
  `api.nodeFromJSON`), and a *Signed Print* preset built with `GraphBuilder`.

## Data plugins (`.drplugin.json`)

```json
{
  "format": "darkroom-plugin",
  "id": "acme.filmPack",
  "name": "ACME Film Pack",
  "version": "1.2.0",
  "author": "ACME",
  "description": "…",
  "nodes": [ /* SerializedNodeDef[] — same as .drnode.json "node", see CUSTOM_NODES.md */ ],
  "presets": [ /* PresetDef[] — { id, name, category, description?, group: GroupData } */ ]
}
```

- `id`: `[A-Za-z][\w-]*(\.[\w-]+)*`. Use a namespace you own. Node ids must be namespaced too
  (`acme.grain`). The convention is to share the plugin's prefix.
- `version`: dotted numbers are compared numerically (`1.10.0` > `1.9.3`).
- Node `frag`s may keep their `@param` annotation lines. Params missing from `params` are filled in
  from the annotations.
- Presets are plain data. Each group needs one `core.groupInput` named `image` and one
  `core.groupOutput` named `out`, plus `exposed` params (see `docs/NODE_AUTHORING.md`). Inner node
  params you leave out get their defaults when the plugin loads.

The easiest way to write one is to build the nodes in the Node Builder, export them as `.drnode.json`,
and paste the `node` objects into `nodes`.

## Code plugins (`.js`)

An ES module whose default export is a `PluginDef`, or a function that receives the API and returns one
(sync or async):

```js
export default (api) => ({
  id: 'acme.text',
  name: 'ACME Text Tools',
  version: '1.0.0',
  author: 'ACME',
  nodes: [
    api.defineNode({
      id: 'acme.caption',
      name: 'Caption',
      category: 'Composite',
      inputs: { image: { type: 'image' } },
      params: { text: { type: 'string', default: 'Hello' }, opacity: { type: 'float', default: 1, min: 0, max: 1 } },
      cpu: ({ params, scale, projectSize }) => {
        const c = new OffscreenCanvas(projectSize.width * scale, projectSize.height * scale);
        const g = c.getContext('2d');
        g.font = `${48 * scale}px sans-serif`;
        g.fillStyle = '#fff';
        g.fillText(params.text, 20 * scale, 60 * scale);
        return { text: c };                       // → sampler u_text in the passes
      },
      passes: [{ frag: `void main() {
        vec4 s = texture(u_image, v_uv), t = texture(u_text, v_uv);
        fragColor = vec4(mix(s.rgb, t.rgb, t.a * u_opacity), s.a);
      }` }],
    }),
  ],
  // An array, or a function (called after this plugin's nodes are registered, so GraphBuilder sees their defaults).
  presets: () => { const b = new api.GraphBuilder(); /* … */ return []; },
});
```

`nodes` are full runtime `NodeDef`s (see `src/core/types.ts` and `docs/NODE_AUTHORING.md`):
`cpu()`, `size()`, pass `size`/`uniforms`/`repeat` functions and function `frag`s all work.

### The `api` object

| Member | Description |
|---|---|
| `version` | Darkroom version string, e.g. `'0.5.0'` |
| `apiVersion` | Plugin API version (integer, currently `1`), bumped on breaking changes |
| `defineNode(def)` / `definePreset(def)` | Identity helpers (type inference in TS/JSDoc) |
| `GraphBuilder` | Build preset groups: `input()`, `node(type, params, inputs)`, `output()`, `expose()`, `toGroup(name)` |
| `GLSL_LIB` | The shared GLSL library source (already prepended to every shader, provided for reference/tools) |
| `nodeFromJSON(serialized)` | Build a `NodeDef` from the JSON form (string GLSL, `@param` annotations, declarative pass sizes) |
| `parseParams(glsl)` | Parse `@param` annotations into a `params` object |
| `loadAsset(url, id?)` | Fetch an image or text file, resolved relative to the plugin's URL when installed from a URL, register it with the engine, and return the `Asset` (`image`, `text`, `width`, `height`). Keep the returned object and return `asset.image` from `cpu()`, or look it up with `ctx.getAsset(id)` |
| `sourceUrl` | The URL the plugin was installed from (or `undefined`) |

Constraints:
- The module is imported from a **Blob URL**, so relative `import`s don't resolve. Bundle into
  one file, or import absolute `https://` URLs.
- Keep top-level side effects to a minimum. Everything should happen inside the default export.
- Assets fetched by `loadAsset` are **not** stored in projects. Re-fetch them when the plugin loads.

## Lifecycle and persistence

- Installed plugins are stored in IndexedDB (`darkroom-extensions` → `plugins`) with their **source text**,
  `enabled`, `trusted`, the source URL or file name, and the ids they provided. At startup the enabled ones are
  re-loaded from the stored source, so offline works and a changed URL doesn't silently update code. To update,
  install again: the manager asks before upgrading, reinstalling or downgrading.
- **Disable** or **remove** unregisters the plugin's nodes and presets at once. Nodes in the open
  project then show an error badge: *Unknown node type "acme.caption" — provided by plugin "ACME Text
  Tools" (acme.text), which is disabled*. They come back when you re-enable it. Graph data is never lost.
- **Conflicts:** a plugin can't replace a built-in node, a node of another plugin, or one of your
  custom nodes. Such nodes and presets are skipped and listed as warnings. A node *embedded in the current
  project* is replaced by the installed plugin's version.
- **Errors** (bad JSON, failing module, invalid defs) mark the plugin *Error* in the manager with the message.
  Startup and the rest of the app carry on.
- **Projects** that use plugin nodes record `plugins: [{ id, name, version, url, nodes }]`. Data-plugin
  nodes are also embedded in `customNodes`, so the project renders on a machine without the plugin.
  Code-plugin nodes can't be embedded. On another machine they show an error naming the plugin id and
  install URL.

## Security model

- **Data plugins** are JSON. Their GLSL runs on the GPU in WebGL2's sandbox and can only read the
  textures Darkroom binds. They install without a prompt.
- **Code plugins** run JavaScript **with the same privileges as Darkroom** in this origin. They can read
  your projects and images, make network requests and use this site's storage. Darkroom therefore:
  - shows a trust dialog naming the exact source (URL or file name), its size and a preview,
    before the code runs for the first time;
  - stores the trusted source text and re-runs only that text later (a compromised URL can't push
    new code without another install);
  - never loads code plugins from projects. A project can only *name* a plugin.
- There is no further sandbox (no iframe/worker isolation). Only install code from authors you trust.

## Writing a plugin: checklist

1. Pick a namespace: `yourname.packName` for the plugin and `yourname.*` for node ids.
2. Prototype nodes in the Node Builder and export `.drnode.json` (data tier), or write
   `defineNode` objects (code tier).
3. Test by installing from a file. Reinstalling with the same id offers to replace.
4. Bump `version` on every release.
5. Host the file anywhere with CORS enabled (or in Darkroom's `public/plugins/`) and share the URL.
