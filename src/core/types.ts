/**
 * Darkroom core types — the contract shared by the engine, the editor UI,
 * built-in nodes, presets, custom nodes and plugins.
 *
 * Colour convention: all images flow through the graph as display-referred
 * sRGB-encoded RGBA in [0,1] (premultiplied alpha is NOT used). Textures are
 * RGBA16F where supported, so intermediate values may exceed 1.
 */

/** Socket types. `mask` is an image where only `.r` matters (0..1). */
export type PortType = 'image' | 'mask';

export interface PortDef {
  type: PortType;
  label?: string;
  /** Optional inputs may stay unconnected; their sampler is bound to a 1x1 texture (see `fallback`). */
  optional?: boolean;
  /** What an unconnected optional input samples as. Default 'black' (0,0,0,0) for image, 'white' for mask. */
  fallback?: 'black' | 'white' | 'transparent' | 'gray';
}

export type ParamType =
  | 'float'
  | 'int'
  | 'bool'
  | 'color' // [r,g,b,a] 0..1, uniform vec4
  | 'vec2' // [x,y], uniform vec2
  | 'enum' // string value from options; uniform int = index into options
  | 'string' // no uniform; for CPU nodes (e.g. text)
  | 'asset' // asset id string (image or file); no uniform; for CPU nodes
  | 'curve'; // array of [x,y] control points 0..1; no uniform (bake via cpu()) — see color.curves

export interface ParamDef {
  type: ParamType;
  default: ParamValue;
  label?: string;
  min?: number;
  max?: number;
  step?: number;
  /** For enum. */
  options?: string[];
  /** Short help text shown as tooltip. */
  description?: string;
  /** Hide from properties panel (still saved). */
  hidden?: boolean;
  /** For 'asset': accepted file types, e.g. 'image/*' or '.cube'. */
  accept?: string;
  /** For 'string': render as multiline textarea. */
  multiline?: boolean;
  /** For float/int: values are in *pixels at full resolution* (UI hint only; shader must multiply by u_scale). */
  pixels?: boolean;
}

export type ParamValue = number | boolean | string | number[] | number[][] | null;
export type Params = Record<string, ParamValue>;

/** Anything that can be uploaded to a texture. */
export type TexSource =
  | ImageBitmap
  | HTMLImageElement
  | HTMLCanvasElement
  | OffscreenCanvas
  | ImageData
  | RawTex
  // video sources (nodes with `volatile`): uploaded without mipmaps, texture reused between frames
  | HTMLVideoElement
  | VideoFrame;

export interface RawTex {
  width: number;
  height: number;
  /** RGBA, row 0 = top of image. Float32Array → RGBA16F/32F, Uint8Array → RGBA8. */
  data: Float32Array | Uint8Array;
  /** Default 'linear'. */
  filter?: 'linear' | 'nearest';
}

export type UniformValue = number | boolean | number[];

export interface PassContext {
  params: Params;
  /** Output size (pixels) of the node at the current render scale. */
  width: number;
  height: number;
  /** Render scale = current render resolution / full resolution (1 at export). */
  scale: number;
  /** Sizes of connected inputs keyed by input name (at current scale). */
  inputSizes: Record<string, { width: number; height: number }>;
  /** Sizes of passes already rendered in this node, by index. */
  passSizes: { width: number; height: number }[];
  /** Engine time (s) and frame index (0 for stills); e.g. animate a seed via `uniforms()`. See docs/VIDEO.md. */
  time?: number;
  frame?: number;
}

export interface ShaderPass {
  /**
   * GLSL ES 3.00 fragment source *body*. The engine prepends a header with:
   *   precision highp float; in vec2 v_uv; out vec4 fragColor;
   *   uniform vec2 u_resolution;   // this pass's output size in px
   *   uniform float u_scale;       // render scale (multiply pixel-unit params by this)
   *   uniform float u_time;        // seconds: timeline time (0 for stills / still export)
   *   uniform int u_frame;         // frame index on the timeline (0 for stills / still export)
   *   uniform sampler2D u_<input>; uniform vec2 u_<input>_size;   // every node input
   *   uniform sampler2D u_pass<N>; uniform vec2 u_pass<N>_size;   // earlier passes of this node
   *   uniform sampler2D u_prev;    uniform vec2 u_prev_size;      // previous pass (or first input on pass 0)
   *   uniform sampler2D u_<cpuKey>; uniform vec2 u_<cpuKey>_size; // textures returned by cpu()
   *   uniform <type> u_<param>;    // every param with a uniform type (float,int,bool,color,vec2,enum)
   *   plus the shared library in core/glsl.ts (luma, rgb2yiq, hash, noise, blend modes...)
   * Must define `void main()` and write `fragColor`.
   * May be a function of params when the source itself depends on them (e.g. an expression node);
   * compiled programs are cached by source text.
   */
  frag: string | ((params: Params) => string);
  /** Output size of this pass. Default: node output size. Return [w,h]. */
  size?: (ctx: PassContext) => [number, number];
  /** Texture filtering when this pass is *sampled* by later passes/nodes. Default 'linear'. */
  filter?: 'linear' | 'nearest';
  /** Extra uniforms computed in JS (e.g. derived values). */
  uniforms?: (ctx: PassContext) => Record<string, UniformValue>;
  /** Which node output this pass writes. Default: the last pass writes the first output. */
  output?: string;
  /** Repeat this pass N times (ping-pong; u_prev is the previous iteration). */
  repeat?: (ctx: PassContext) => number;
}

export interface CpuContext {
  params: Params;
  scale: number;
  /** Full-resolution (scale 1) project size. */
  projectSize: { width: number; height: number };
  /** Resolve an asset id to its loaded data. */
  getAsset: (id: string) => Asset | undefined;
  /** Read back an input image as RGBA float pixels (slow; use sparingly). */
  readInput: (name: string) => RawTex | null;
  /** Engine time in seconds (timeline position; 0 for stills). See docs/VIDEO.md. */
  time?: number;
  /** Engine frame index (u_frame; 0 for stills). */
  frame?: number;
  /**
   * Aborted when this cpu() run is superseded (params/inputs changed before it finished). Long
   * jobs (tiled AI) should check it between steps and stop early. See InferenceMemo for sharing.
   */
  signal?: AbortSignal;
}

export interface NodeDef {
  /** Globally unique, namespaced: 'color.levels', 'analog.vhsChroma', 'myplugin.foo'. */
  id: string;
  name: string;
  category: string;
  description?: string;
  /** Search keywords. */
  tags?: string[];
  inputs: Record<string, PortDef>;
  /** Default: { out: { type: 'image' } }. */
  outputs?: Record<string, PortDef>;
  params: Record<string, ParamDef>;
  /** GPU passes, executed in order. Omit for pure-CPU nodes. */
  passes?: ShaderPass[];
  /**
   * CPU step. Returns textures keyed by name.
   *  - If the node has `passes`, these become extra samplers `u_<key>`.
   *  - If the node has no passes, keys must match output names (e.g. { out }).
   * Results are cached by params + input versions. May be async (the engine re-renders when it resolves).
   */
  cpu?: (ctx: CpuContext) => Record<string, TexSource> | Promise<Record<string, TexSource>>;
  /** Set true if cpu() uses readInput (forces recompute when inputs change). */
  cpuReadsInputs?: boolean;
  /**
   * Time-varying CPU source (video, webcam). 'time': cpu() re-runs whenever the engine time changes
   * (e.g. a video decoded at `ctx.time`); 'live': re-runs every displayed frame while present (webcam).
   * Textures are re-uploaded in place (no mipmaps) and the previous frame stays visible while an async
   * cpu() is pending. See docs/VIDEO.md.
   */
  volatile?: 'time' | 'live';
  /**
   * Expensive node (AI inference, big CPU work). In the interactive viewer it is evaluated once at
   * the "fit to window" preview resolution and only upscaled for display while zooming, instead of
   * re-running at every zoom step; exports still run it at full resolution. Default: true for `ai.*`.
   * See RenderOptions.heavyScale.
   */
  heavy?: boolean;
  /**
   * Output size at FULL resolution. Default: size of first connected image input,
   * else the project size. The engine multiplies by render scale.
   */
  size?: (ctx: { params: Params; inputSizes: Record<string, { width: number; height: number }>; projectSize: { width: number; height: number }; getAsset: (id: string) => Asset | undefined }) => [number, number];
  /** Node colour accent in the editor (CSS colour). */
  color?: string;
  /** Hidden from the add-node menu (e.g. group internals). */
  hidden?: boolean;
  /**
   * Interactive viewer tool shown while this node (or a group exposing its `param`) is selected.
   * Shorthand kinds use the param `points` / `strokes` / `box`. See src/ui/viewerTools.
   */
  viewerTool?: ViewerToolKind | ViewerToolDef;
  /**
   * Custom parameter editor shown at the top of the Properties panel; it takes over the params it
   * owns (hidden from the generic rows). 'colorRamp': `count`, `pos0..7`, `color0..7`,
   * `interpolation`, `colorMode`, `hueInterpolation` (see src/ui/ColorRampEditor.tsx).
   */
  editor?: NodeEditorKind;
}

export type NodeEditorKind = 'colorRamp';

export type ViewerToolKind = 'points' | 'brush' | 'box';

/**
 * Viewer tool options. Coordinates are normalised 0..1, top-left origin (same as v_uv).
 * - points: `param` holds JSON `[{"x":0.5,"y":0.4,"label":1}, …]` (label 1 = positive, 0 = negative).
 *   With `single`, there is one draggable point; with `vec2Param` it is written to that vec2 param instead.
 *   With `boxParam`, a drag draws a box stored as JSON `[x0,y0,x1,y1]` (or "" for none).
 * - brush: `param` holds JSON strokes `[{"r":0.03,"h":0.6,"e":0,"p":[x,y,x,y,…]}, …]`
 *   (r = radius as a fraction of the image height, h = hardness 0..1, e = 1 for erase).
 * - box: `param` holds JSON `[x0,y0,x1,y1]`.
 */
export interface ViewerToolDef {
  kind: ViewerToolKind;
  param?: string;
  single?: boolean;
  vec2Param?: string;
  boxParam?: string;
  /** Output port shown as a translucent tint over the image while the tool is active (mask outputs). */
  previewPort?: string;
  /** HUD title (default: the node name). */
  label?: string;
  /**
   * points: several draggable single points, each written to its own vec2 param (e.g. Relight's three
   * lights). Takes precedence over `vec2Param` in the viewer; `vec2Param` stays the first handle's key.
   */
  handles?: ViewerToolHandle[];
}

export interface ViewerToolHandle {
  /** vec2 param holding the point (0..1, top-left origin). */
  param: string;
  /** Short label drawn next to the handle and on its HUD button. */
  label?: string;
  /** Bool param: the handle is shown only while it is true. */
  enabledBy?: string;
  /** Color param used to tint the handle. */
  colorParam?: string;
}

// ---------------------------------------------------------------------------
// Graph document
// ---------------------------------------------------------------------------

export interface GraphNode {
  id: string;
  type: string; // NodeDef id, or 'core.group'
  params: Params;
  position: { x: number; y: number };
  /** User-given title. */
  label?: string;
  /** Pass first image input straight through. */
  bypass?: boolean;
  /** Collapsed UI state. */
  collapsed?: boolean;
  /** Editor colour tag (a palette name like 'red', or a CSS colour). UI only; the engine ignores it. */
  color?: string;
  /** Only for type 'core.group'. */
  group?: GroupData;
}

export interface Edge {
  id: string;
  from: { node: string; port: string };
  to: { node: string; port: string };
}

export interface Graph {
  nodes: GraphNode[];
  edges: Edge[];
  /** Editor backdrops and sticky notes (UI only; the engine ignores them). */
  frames?: Frame[];
}

/**
 * A titled, coloured rectangle drawn behind nodes in the graph editor (a "backdrop"),
 * or a sticky note (`kind: 'note'`). Moving a frame moves the nodes whose centre lies inside it.
 */
export interface Frame {
  id: string;
  kind?: 'frame' | 'note';
  title: string;
  /** Free text shown under the title (the whole body of a sticky note). */
  note?: string;
  /** Palette name ('blue', 'green'…) or a CSS colour ('#aabbcc'). */
  color?: string;
  position: { x: number; y: number };
  size: { width: number; height: number };
}

/**
 * A group (subgraph / macro). Its inputs are the `core.groupInput` nodes inside
 * (param `name`), its outputs the `core.groupOutput` nodes (param `name`).
 * Exposed params appear on the group node and override inner node params.
 */
export interface GroupData {
  name: string;
  graph: Graph;
  exposed: ExposedParam[];
}

export interface ExposedParam {
  /** Param key on the group node. */
  key: string;
  label?: string;
  node: string; // inner node id
  param: string; // inner param key
  /** Optional overrides of the inner ParamDef (min/max/etc). */
  def?: Partial<ParamDef>;
}

export interface Asset {
  id: string;
  name: string;
  mime: string;
  /** Decoded image, if an image. */
  image?: ImageBitmap;
  /** Raw text, if a text file (e.g. .cube). */
  text?: string;
  /** Data URL for saving inside the project. RAW assets use an `idb:raw/<id>` reference instead (bytes live in IndexedDB). */
  dataUrl: string;
  width?: number;
  height?: number;
  /** Camera RAW file (developed by the `core.raw` node, see core/raw). */
  raw?: RawAssetData;
  /** Video assets: the file (bytes also live in IndexedDB; see core/videoAssets.ts). */
  blob?: Blob;
  /** Video assets: duration in seconds and average frame rate. */
  duration?: number;
  fps?: number;
}

/** Project timeline settings (video / animated noise). See docs/VIDEO.md. */
export interface TimelineSettings {
  fps: number;
  /** Seconds. */
  duration: number;
  loop?: boolean;
  /** Play time even without video sources (animated noise on stills). */
  animate?: boolean;
  /** true = realtime playback (drops frames), false = render every frame. */
  realtime?: boolean;
}

/** Original RAW bytes + camera metadata. */
export interface RawAssetData {
  bytes: Uint8Array;
  meta: RawMeta;
}

export interface RawMeta {
  make: string;
  model: string;
  iso: number;
  /** Seconds. */
  shutter: number;
  aperture: number;
  /** mm. */
  focalLength: number;
  lens?: string;
  /** ms since epoch. */
  timestamp?: number;
  /** Sensor size before orientation. */
  width: number;
  height: number;
  /** LibRaw flip (0 none, 3 = 180°, 5 = 90° CCW, 6 = 90° CW). */
  flip: number;
}

export interface Project {
  version: 1;
  name: string;
  graph: Graph;
  /** Asset ids → serialized assets (dataUrl). */
  assets: Record<string, { id: string; name: string; mime: string; dataUrl: string }>;
  /** Node whose output is shown/exported. Default: the first core.output node. */
  outputNode?: string;
  /** Custom / data-plugin node types used by this project, embedded so it opens on other machines. */
  customNodes?: SerializedNodeDef[];
  /** Plugins that provided node types used by this project (for "missing plugin" messages). */
  plugins?: ProjectPluginRef[];
  /** Timeline (video / animation) settings. */
  timeline?: TimelineSettings;
}

/** A pass in JSON form (no functions). See core/serialize.ts. */
export interface SerializedPass {
  /** GLSL body. May still contain `uniform … u_<param>; // @param …` lines; they are stripped on load. */
  frag: string;
  /** Declarative size: `scale` × node output size, or fixed full-res `width`/`height` (× render scale). */
  size?: { scale?: number; width?: number; height?: number };
  filter?: 'linear' | 'nearest';
  output?: string;
  /** Fixed count, or the key of an int/float param. */
  repeat?: number | string;
}

/** A NodeDef in JSON form: string frags, no functions. Used by custom nodes, data plugins and projects. */
export interface SerializedNodeDef {
  id: string;
  name: string;
  category: string;
  description?: string;
  tags?: string[];
  inputs: Record<string, PortDef>;
  outputs?: Record<string, PortDef>;
  params: Record<string, ParamDef>;
  passes: SerializedPass[];
  color?: string;
  hidden?: boolean;
}

export interface ProjectPluginRef {
  id: string;
  name?: string;
  version?: string;
  url?: string;
  /** Node type ids from this plugin used by the project. */
  nodes: string[];
}

/** A preset is a ready-made group the user can drop into the graph. */
export interface PresetDef {
  id: string; // 'camera.ccd2002'
  name: string;
  category: string; // 'Camera', 'Video', 'Fun'...
  description?: string;
  tags?: string[];
  /** Built group. Must contain one groupInput named 'image' and one groupOutput named 'out'. */
  group: GroupData;
}

export interface PluginDef {
  id: string;
  name: string;
  version: string;
  author?: string;
  description?: string;
  nodes?: NodeDef[];
  presets?: PresetDef[];
}
