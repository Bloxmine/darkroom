# Pro filters, local adjustments & LUTs

Darkroom's `pro.*` nodes cover what a photo editor like Lightroom or Capture One does: scene-linear tone
mapping and colour management, lens correction, local adjustments with on-image handles, HDR and
focus merging, sharpening, and a LUT workflow. They live in `src/nodes/pro/`, the workflow presets in
`src/presets/pro.ts`. Every node is resolution-independent, so the preview matches the export.

## Color Management

| Node | What it does | Key params |
|---|---|---|
| **Tone Map** `pro.tonemap` | Decodes sRGB to linear light (or takes linear float data with *Input is HDR*), applies exposure, then a filmic operator, then encodes for display. | Operator: **AgX** (Blender 4: log2 encoding −12.47…+4.03 EV, inset/outset matrices, 6th-order sigmoid; looks *Base* / *Punchy* / *Golden*), **ACES** (Stephen Hill's RRT+ODT fit with the AP1 matrices, or Narkowicz's single-curve fit), **Filmic** (Blender-style: log2 −10…+6.5 stops around 0.18, logistic contrast; an approximation of Blender's LUT), **Reinhard extended** (on luminance, white point), **Uchimura** (Gran Turismo), **Hable** (Uncharted 2). Exposure (EV), White point, Amount. |
| **Colour Space Convert** `pro.colorSpace` | Converts between sRGB, linear Rec.709, Display P3, Rec.2020, ProPhoto RGB, Adobe RGB (1998) and ACEScg. | From / To; out-of-gamut handling: clip, compress (desaturate towards luminance; keeps hue), none. Matrices are derived from each space's primaries and white point (SMPTE RP 177), with Bradford adaptation between D65, D50 (ProPhoto) and the ACES white. Transfer curves: sRGB piecewise, Adobe 563/256, ROMM 1.8 with linear toe, BT.1886 (2.4) for Rec.2020, linear. |
| **Exposure & White Balance (linear)** `pro.exposureLinear` | Camera-style exposure and white balance in scene-linear light, with a hue-preserving highlight shoulder. | Exposure (EV); Temperature (K, the *scene* illuminant: lower = cooler result, like Lightroom) and Tint, applied as a Bradford adaptation from the Planckian point (Kim et al. spline) to 6500 K; Highlight rolloff; *Linear (HDR) in/out*. |
| **Look** `pro.look` | A pack of original procedural looks: Teal & Orange, Bleach Bypass, Kodachrome-ish, Cross Cool, Faded Matte, Day for Night, Golden Hour, Nordic Cold, Noir (red filter). No third-party LUT data. | Look, Intensity (0–2), Amount. |
| **Hald CLUT** `pro.haldClut` | Applies a Hald CLUT PNG (level 8 = 512×512 = 64³) with trilinear interpolation, or outputs an identity Hald to grade in another editor. | Hald image, Amount, Output identity Hald, level. |

### Export LUT (.cube)

*File › Export LUT (.cube)…* bakes the colour pipeline into a 33³ Adobe `.cube` 3D LUT that you can load into
Resolve, Premiere, Photoshop, OBS, cameras…, or back into Darkroom's **LUT (.cube)** node.

How it works (`src/nodes/pro/lut-export.ts`, `exportLut()` in `src/store/io.ts`):

1. The target is the selected node, or the Output node if none (or a group) is selected.
2. The graph is flattened and every source node upstream of the target (Image, RAW, video, webcam) is
   replaced by an identity lattice: an N²×N float image where pixel (r + b·N, g) = (r, g, b)/(N−1).
3. The graph is rendered at scale 1 in a separate cache. Each output texel is the graded colour of its
   lattice entry, written red-fastest as `LUT_3D_SIZE N` / `DOMAIN_MIN` / `DOMAIN_MAX`.
4. Nodes that aren't per-pixel colour transforms (blur, grain, sharpening, distortion, local adjustments,
   anything based on image statistics) can't be represented. They are **bypassed while baking** and listed
   in a warning. A node is colour-only if `NodeDef.colorOnly` is set (all `pro` colour nodes) or it is in
   the curated list `COLOR_ONLY_IDS` (Levels, Curves, HSL, Exposure, Channel Mixer, LUT, convert.* …).
5. The file is downloaded in the browser, or saved with a native dialog in the Mac app.

Accuracy, measured by exporting a colour-only chain, loading the `.cube` into a LUT node and comparing pixels:
mean error 0.25/255 at 33³ and 0.06/255 at 65³ (max 2.9 / 1.3 levels, from trilinear interpolation).
`exportLut(65)` is available from the console (`__darkroom.io.exportLut(65)`).

## Lens

| Node | What it does | Key params |
|---|---|---|
| **Lens Correction** `pro.lensCorrect` | Brown–Conrady distortion in coordinates normalised to the half-diagonal. The output point p samples the source at p(1 − k1r² − k2r⁴ − k3r⁶) + tangential terms, so **positive k1 fixes barrel** and negative fixes pincushion. Also vignetting correction (divides by 1 − ½v1r² − ½v2r⁴ in linear light), lateral CA (red/blue scale), auto-crop (the largest zoom whose border still maps inside the source), and a grid overlay. | k1–k3, p1, p2, Vignetting, CA red/blue (%), Auto-crop, Zoom, Show grid |
| **Defringe** `pro.defringe` | Removes purple/green fringes only near high-contrast edges (luminance range on two sample rings), neutralising them towards the least-saturated neighbours. Purple flowers away from edges are left alone. | Purple/green amount, hue (°) and range, edge radius, edge contrast, Show mask |
| **Auto Straighten** `pro.autoStraighten` | Upright "Level". On a ≤ 384 px copy (so preview and export agree): Scharr gradients → 5×5 structure tensor → orientation histogram weighted by coherence² · √trace, restricted to ±max angle around horizontal / vertical / both, then a parabolic peak. Rotates and crops to the largest same-aspect rectangle (z = cos θ + (long/short)·sin θ). The estimated angle and a confidence are shown under Properties. | Mode (level / vertical / auto), Max correction, Adjust, Crop |

## Local adjustments (on-image handles)

Select the node and work in the viewer. The tool's "Show mask" tints the affected area.

| Node | Interaction | Adjustments |
|---|---|---|
| **Graduated Filter** `pro.gradFilter` | Drag **Start** (full effect) and **End** (no effect). A click on empty space moves the selected handle. | Exposure (linear), Temperature, Tint, Contrast, Highlights, Shadows, Saturation, Clarity (local contrast against a quarter-res blur, σ = 1.2 % of the height), Invert |
| **Radial Filter** `pro.radialFilter` | Drag **Centre** and **Edge** (Edge sets the radius and rotation; Roundness the other radius). | Same set, Feather, inside / outside |
| **Dodge & Burn** `pro.dodgeBurn` | Paint with the brush (`[` `]` size, X erase). | Mode, Strength (EV), Range (shadows / midtones / highlights), Protect tones |
| **Heal / Clone** `pro.heal` | Paint over the blemish. | Heal / Clone, Source auto / manual offset, Opacity |

**Healing.** The source offset is found automatically on a ≤ 256 px copy. Candidates around the stroke are
scored by how well the source's surrounding ring matches the target's (mean-removed for heal), how similar its
texture is, and how much extra detail it would bring in. The heal itself works in the gradient domain: the
correction (target − shifted source), known on a thin ring outside the stroke, is interpolated across the
stroke by a GPU push–pull pyramid (a membrane / Poisson-style solve) and added to the cloned texture. It is
seamless on skin and sky. Limitation: a boundary crossing a strong edge (hair against skin) bleeds that
edge's difference into the fill; use Clone or a smaller stroke there.

## Photo

| Node | What it does |
|---|---|
| **Merge HDR** `pro.mergeHdr` | 2–5 brackets (EV per input; the first is the reference). Radiance = Σ w(z)·lin(z)/2^EV / Σ w(z), where w is the Debevec–Malik hat with the clipped ends excluded; all-clipped pixels fall back to the darkest / brightest frame. **Align** uses phase correlation on Ward's median-threshold bitmaps (exposure invariant), 512² FFT, sub-pixel peak, with low-confidence peaks ignored. **Deghost** drops frames that disagree with the reference by more than the threshold (stops). The output is **linear**: follow it with Tone Map (*Input is HDR*). |
| **Exposure Fusion** `pro.exposureFusion` | Mertens, Kautz & Van Reeth 2007. Weights C^ωc · S^ωs · E^ωe (contrast = \|Laplacian\|, saturation = RGB standard deviation, well-exposedness = Π exp(−(i−½)²/2σ²) with σ = 0.2), normalised, then blended with Laplacian pyramids of the images and Gaussian pyramids of the weights (9 levels, on the GPU). |
| **Focus Stack** `pro.focusStack` | Sharpness = RMS Laplacian over a disc (radius in px), soft-max via Selectivity, then the same pyramid blend (no halos or seams). |
| **Smart Sharpen** `pro.smartSharpen` | *Sharpen*: luminance unsharp mask with a threshold, an edge mask (Masking) and halo control (Detail clamps overshoot to the local 3×3 range). *Lens blur removal*: Richardson–Lucy deconvolution (E ← E · K⊗(obs / K⊗E)) with a gaussian PSF in linear light, up to 12 damped iterations. |
| **Texture** `pro.texture` | Lightroom Texture: a luminance band-pass between ~1.5 and ~6 px with an edge stop. Positive values enhance pores, foliage and rock; negative values smooth skin while edges stay sharp. Clarity (`color.clarity`) works at a larger scale. |

`pro.grain2` was not added: `stylize.grain` already has multi-octave, midtone-weighted, optionally chromatic
grain. A physically based (boolean-model) grain wouldn't be clearly better at the cost.

## Utility

| Node | What it does |
|---|---|
| **Compare Grid** `pro.compareGrid` | 2–4 inputs side by side or in a 2×2 grid, each fitted into a cell of input A's size, with labels. |
| **Watermark** `pro.watermark` | Text (plain, ©, or handwritten signature with a flourish) or a logo PNG. Placed at a corner, edge or centre with a margin, or tiled diagonally. Size is a % of the short side. Opacity and shadow. The built-in successor of the example plugin's text watermark. |
| **Print Frame** `pro.frame` | Gallery mat with a lit 45° bevel window and frame moulding; 35 mm film strip (KS perforations 2.8 × 1.98 mm at 4.75 mm pitch, frame gaps, edge print with frame numbers; vertical for portrait images); filed negative-carrier border. Optional rounded photo corners. Enlarges the canvas. For instant film use Instant Frame; for plain borders, Border / Frame. |

## Presets (category *Pro*)

- **Cinematic Grade**: AgX Punchy → Look → vignette → grain.
- **Landscape Polish**: graduated sky filter (handles stay draggable on the group) → Texture → Smart Sharpen.
- **Portrait Retouch**: negative Texture (skin) → radial spotlight → edge-only sharpening.
- **Natural HDR (single image)**: the photo at −1.5 / 0 / +1.5 EV fused with Exposure Fusion.
