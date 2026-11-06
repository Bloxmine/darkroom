# Darkroom plugin folder

Files here are served at `/plugins/…` and can be installed via **Edit › Plugins… › Install from URL**.

| File | Tier | Contents |
|---|---|---|
| `example-shader-pack.drplugin.json` | data (JSON + GLSL, no prompt) | Duotone, Sobel Glow (2 passes), Kaleidoscope, and the *Neon Night* preset |
| `example-code-plugin.js` | code (JavaScript, trust prompt) | Text Watermark (CPU canvas step), Warm Sepia, and the *Signed Print* preset |

Full reference: `docs/PLUGINS.md` (format, API, security) and `docs/CUSTOM_NODES.md`
(Node Builder, `@param` annotations, `.drnode.json`) in the repository.

## Template: data plugin

Save as `my-pack.drplugin.json`:

```json
{
  "format": "darkroom-plugin",
  "id": "me.myPack",
  "name": "My Pack",
  "version": "1.0.0",
  "author": "Me",
  "description": "What it does.",
  "nodes": [
    {
      "id": "me.invert",
      "name": "Simple Invert",
      "category": "Color",
      "inputs": { "image": { "type": "image" } },
      "params": {},
      "passes": [
        {
          "frag": "uniform float u_amount; // @param min=0 max=1 default=1 label=\"Amount\"\nvoid main() {\n  vec4 c = texture(u_image, v_uv);\n  fragColor = vec4(mix(c.rgb, 1.0 - c.rgb, u_amount), c.a);\n}\n"
        }
      ]
    }
  ],
  "presets": []
}
```

Tip: build nodes in **Node › New Custom Node…** and use **Export…** to get the `node` JSON.

## Template: code plugin

Save as `my-plugin.js`:

```js
export default (api) => ({
  id: 'me.myCode',
  name: 'My Code Plugin',
  version: '1.0.0',
  author: 'Me',
  nodes: [
    api.defineNode({
      id: 'me.tint',
      name: 'Tint',
      category: 'Color',
      inputs: { image: { type: 'image' } },
      params: { color: { type: 'color', default: [1, 0.8, 0.6, 1] } },
      passes: [{ frag: 'void main(){ vec4 c = texture(u_image, v_uv); fragColor = vec4(c.rgb * u_color.rgb, c.a); }' }],
    }),
  ],
  presets: () => [], // built after the nodes are registered; use new api.GraphBuilder()
});
```

Code plugins load from a Blob URL. Keep them in a single file, with no relative imports.
