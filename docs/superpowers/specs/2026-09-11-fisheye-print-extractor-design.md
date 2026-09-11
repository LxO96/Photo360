# Fisheye Print Extractor — Design

**Date:** 2026-09-11
**Status:** Approved, ready for implementation planning

## Purpose

Turn Insta360 X5 `.insp` files into 2D prints of the **raw per-lens fisheye
image** — not a 360 viewer, not an equirectangular projection.

The X5's lenses see about 210°, well past a hemisphere. Two consequences drive
this tool:

1. **Doubles.** Content past 180° appears in both lenses, so printing both
   circles as-shot shows the same objects twice.
2. **No falloff.** The image circle is slightly larger than the sensor frame and
   gets hard-clipped at the border, losing the soft, flared, dispersed edge that
   makes a fisheye print look like a fisheye photograph.

The tool crops each lens to a true 180° hemisphere (removing the doubles) and
synthesizes the missing lens edge.

Reference for the target look: `Testfiles/Outputs/Flat.jpg`, a 3040² single
fisheye from the older Insta360 X1.

## Measured facts

Established by direct measurement of the supplied test files. These are inputs
to the design, not assumptions.

| Fact | Value | How established |
|---|---|---|
| `.insp` container | Plain JPEG, dual fisheye side by side | Magic bytes `ffd8`, decodes directly |
| Full-size source | 11904 × 5952 (one file 5888 × 2944) | EXIF / decode |
| Per-lens frame | Square, side `S = height`; circle inscribed, radius `S/2` | Geometry |
| Image circle vs frame | Content reaches ~1.03 × (S/2); circle is clipped by the frame | Radial brightness profile |
| Lens FOV | **θmax ≈ 105°** (≈210° full) | Correlation of the two overlap annuli across 3 files; peak at 104–107°, consistent |
| Lens azimuth offset | **180.0°**, with azimuth running in opposite directions | Same correlation; best shift 180.0–181.5° |
| 180° crop radius | **0.857 × circle radius** (= 90/105) | From θmax |
| Circle diameter at 180° | ~5100 px on an 11904 × 5952 source | 0.857 × 5952 |
| X1 edge, terminator | Darkening + desaturation begins ~0.90 radius | Radial profile of `Flat.jpg` |
| X1 edge, azimuthal glow | Sky azimuths 165/152/155 vs tree azimuths 13/39/53 at identical radius | Azimuthal RGB profile of `Flat.jpg` |
| X1 edge, dispersion | Ordered cream → yellow → green → cyan → violet → black, inward to outward | High-zoom crop of `Flat.jpg` top edge |
| Embedded orientation data | None usable — no XMP, no GPano; only an undocumented Insta360 binary trailer (magic `8db42d69…`) | Byte search |

## Scope

**In scope:** per-lens 180° extraction, in-plane roll, synthetic lens edge,
sensor selection and layout, basic tone, full-resolution export.

**Out of scope:** stitching, equirectangular output, 360 viewing, pitch/yaw
re-aiming, alternate projections (stereographic etc.), curves, white balance,
local adjustments, auto-levelling from camera metadata.

## Architecture

A single static page. Plain `<script src>` tags — **no build step, no module
system, no dev server** — so it runs by double-clicking `index.html` from
`file://` and equally uploads to any static host. All processing is client-side;
photos never leave the machine.

```
index.html    markup + styles
lens.js       pure math: lens model, FOV/overlap, layout & canvas geometry   [tested]
edge.js       pure math: edge/rim model, parameters, presets                 [tested]
shaders.js    GLSL source strings
gl.js         WebGL2 context, texture upload, render to canvas / to export target
exif.js       minimal JPEG APP1 read + re-inject
app.js        UI wiring, file load, export, settings persistence
test/         dependency-free Node test runner
```

`lens.js` and `edge.js` contain no DOM and no WebGL references, so they are
directly unit-testable in Node. `gl.js` and `app.js` hold all the untestable
platform surface.

### Geometry: concentric crop, not reprojection

A fisheye's field of view is determined entirely by how far out the image circle
is cropped. For any radially symmetric lens, cropping at radius `r` **is** an
exact FOV change — no unprojection, no resampling model, no introduced
distortion. The tool therefore never reprojects.

- **Lens model** (used only to *label* the crop in degrees):
  `θ(r) = θmax · r / R_circle`, equidistant, `θmax = 105°` default, exposed in
  an "advanced" disclosure for recalibration. Accurate to roughly ±2°.
- **FOV slider** defaults to 180.0° → crop radius 0.857 R. Live readout states
  the duplication against the other lens, e.g. *"180° — 0% duplicated"*.
- **Roll** is an in-plane rotation about the circle centre. Because the crop sits
  at 0.857 R there is always image data behind the rotation, so roll can never
  reveal black.
- **Roll sign.** A camera tilt appears as `+α` on lens A and `−α` on lens B,
  because the lenses are back-to-back and their azimuths run opposite (measured).
  One "level the camera" control drives both with the correct signs; a per-lens
  nudge can break the link.

### Loading

Drag-drop or file picker. `.insp` is re-blobbed as `image/jpeg` before
`createImageBitmap`, since the file extension yields an empty MIME type.

Layout is detected from the decoded dimensions: aspect 2:1 → dual fisheye,
1:1 → single fisheye.

Each half is decoded **separately** via
`createImageBitmap(blob, sx, sy, sw, sh)`, producing two `S × S` textures. This
avoids ever materialising a full-frame RGBA buffer (283 MB at 11904 × 5952).

## The edge renderer

The defining feature. `Flat.jpg` shows the X1 edge is three stacked effects, not
a single vignette.

Let `R` be the crop radius and `u = r / R`, so `u = 1` is the nominal edge.

**1. Terminator.** Over roughly the last 10% of radius the image darkens,
desaturates, and shifts cool before reaching black. Visible in isolation on the
dark tree side of `Flat.jpg`, where no glow is present.
Parameters: *falloff start*, *falloff softness*, *cool shift*.

**2. Azimuthal rim glow.** Per-angle brightness that tracks adjacent content —
bright sky produces a blazing rim, dark foliage almost none.

**3. Radial dispersion.** The glow splits into a spectrum, red innermost to
violet outermost.

### Render passes

Per frame:

- **Pass 1 — build rim profile.** Render a `1 × 2048` texture. For each azimuth
  φ, sample the annulus just inside the crop edge (`u ∈ [0.94, 1.0]`) and store a
  highlight-weighted intensity `I(φ) = mean(max(0, L − knee)^p)` plus mean colour
  `C(φ)`. The glow is therefore derived from the photograph itself, which is what
  makes the sun side light up on its own.
- **Pass 2 — angular blur.** Blur the profile along φ; the glow bleeds sideways
  by roughly 5–20°.
- **Pass 3 — composite.** Image × terminator curve, plus `I(φ) · C(φ)` modulated
  by a narrow radial bell evaluated at a **different radius per channel** (red,
  green, blue offsets, ordered inward to outward) to produce the dispersion, plus
  a wide low-amplitude tail for the faint outer haze.

### Controls and preset

Exposed as sliders: *edge intensity, ring width, dispersion, glow spread,
highlight knee, falloff start, falloff softness*.

Fixed by the preset rather than exposed: the terminator's *cool shift* and
*desaturation* amounts, the highlight exponent `p`, and the per-channel
dispersion offset ratios. These are constants in `edge.js`; only their overall
scale is user-controlled, via *dispersion* and *edge intensity*.

An **"X1 classic"** preset ships as the default, with its parameter values fitted
numerically against `Flat.jpg` so the tool matches the reference out of the box.
Fitting is a one-off offline step performed during implementation; the resulting
constants live in `edge.js`.

## User interface

One dark workspace. The preview canvas renders exactly what will be exported
(WYSIWYG) at screen resolution. Controls sit in a right-hand column, in four
collapsible groups.

**Framing** — sensor selection (*A only*, *B only*, *both*), swap order, layout
(side-by-side 2:1 or stacked 1:2), gap slider including zero, margin around the
circle.

**Level** — roll slider (±180°, fine step, numeric entry, drag-on-image to spin),
per-lens nudge, and a horizon guide overlaying a straight line through the circle
centre. A straight line is geometrically correct here: a horizon passing through
the optical axis projects to a straight line in a fisheye. Optional thirds.

**Edge** — the seven edge controls, the *X1 classic* preset, and reset.

**Tone** — exposure, contrast, saturation. All three default to exact
pass-through. Nothing further: no curves, no white balance, no local tools;
finishing happens in Lightroom.

Settings persist in `localStorage` between sessions.

## Export

**Resolution.** At 180° the circle is ~5100 px across inside a 5952 px source
square. The default export is therefore **5100² — native sampling, no invented
resolution** — with margin and gap adding real pixels around it. An explicit
"pad to sensor square (5952²)" option exists and is labelled as an upscale.

**Layout.** Two-up renders as `2 · side + gap` wide (or transposed when stacked).
Single renders square.

**Format.** JPEG with a quality slider (default 95) or PNG.

**Filenames.** `<source>_<lens>_<fov>deg.<ext>`, e.g. `Sunscreen_A_180deg.jpg`.

**Metadata.** Canvas export discards EXIF, so a minimal APP1 block (Make, Model,
DateTimeOriginal) is re-injected from the source file to keep a Lightroom
catalogue coherent.

## Testing

`lens.js` and `edge.js` are developed test-first against a dependency-free Node
runner in `test/`.

**`lens.js`**
- `θ ↔ r` round trip
- 180° maps to 0.857 R at `θmax = 105`
- overlap/duplication percentage for FOV above and below 180°
- dual-vs-single detection from decoded dimensions, including the 5888 × 2944 file
- layout geometry: canvas size, circle centres, gap and margin, both orientations
- export filename construction

**`edge.js`**
- terminator curve is monotonic, equals 1 at falloff start, 0 at the edge
- dispersion offsets are strictly ordered red < green < blue
- rim-profile accumulation returns expected per-azimuth intensity for a synthetic
  annulus
- highlight knee: content below the knee contributes nothing

**Shader/JS parity.** The GLSL mirrors `edge.js`. A verification step renders a
synthetic pattern through the shader and compares sampled output against the JS
reference, so the two implementations cannot silently drift.

**Visual verification.** Render all four test files and compare the measured rim
profile numerically against the profile measured from `Flat.jpg`.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| GPU memory / `MAX_TEXTURE_SIZE` below 5952 on weaker machines | Per-lens textures rather than full frame; reduced-resolution preview with full resolution only at export; query `MAX_TEXTURE_SIZE` and downscale with a visible warning |
| `toBlob` failing on very large canvases | Catch the failure and offer a smaller export size |
| `θmax = 105°` is an estimate (fit peaked broadly over 104–107°) | FOV readout is honest about precision; `θmax` is user-adjustable in advanced settings |
| Equidistant projection is an approximation of the real lens | Only affects the degree *label*, never the pixels, since the crop is concentric |
| Very large JPEG decode on low-memory devices | Halves decoded separately; failure surfaces as a clear message rather than a blank page |
