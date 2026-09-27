<p align="center"><img src="logo.svg" width="96" height="96" alt="Fisheye Print Extractor logo: two overlapping circles with their shared region cut away"></p>

# Fisheye Print Extractor

A single static web page that turns an Insta360 dual-fisheye photo into a
print-ready 2D fisheye image of one lens (or both, side by side).

## Why this exists

An Insta360 X5 or ONE X shoots two overlapping fisheye circles onto one
frame — one per lens, back to back — meant to be stitched into a 360°
panorama. If instead you just want *one* fisheye photograph out of it (the
classic circular "fisheye look," not a stitched sphere), two things stand in
your way:

1. **Each lens sees more than a hemisphere.** The X5's lens covers roughly
   210° and the ONE X's roughly 190°, not the 180° a single fisheye
   photograph should show. The extra angle beyond 180° is the same real-world
   wedge the *other* lens also captured, so cropping to exactly 180° removes
   duplicated content, not real information.
2. **The camera's own sensor crops off the lens's own edge.** Insta360's
   hardware crops the image circle at the sensor's edge, discarding the
   soft, flared, dispersed rim that a real fisheye photograph shows at its
   circumference. Cropping to 180° alone leaves a photograph that ends in a
   flat, hard-edged circle — correct in framing, but visibly not what a
   fisheye lens actually renders.

This tool does both: it crops each lens to exactly 180° using a per-camera
lens calibration, then synthesizes the missing rim — driven by the
photograph's own content (its brightness and color right at the crop edge)
— using a falloff shape numerically fitted against real Insta360 ONE X
reference photographs. See "The edge preset" below for exactly how much to
trust that synthesis.

## Running it

This is a static page: no build step, no package to install, no server-side
code, and no network dependency once the page is open. Nothing you load is
uploaded anywhere — all decoding, rendering and export happens in your
browser.

- **Simplest:** double-click `index.html`. Everything works from `file://`
  **except** the built-in parity self-check (`App.checkParity`, used only by
  the test suite's browser-side half), which needs `fetch` and so needs the
  page served over HTTP.
- **To also enable that self-check**, serve the directory over HTTP, e.g.
  `python -m http.server 8765` from the project root, then open
  `http://localhost:8765/index.html`.

Drop an `.insp`, `.jpg`, or `.dng` dual-fisheye file onto the page (or click
to choose one) to get started.

### Browser requirement

The renderer needs **WebGL2** with the `EXT_color_buffer_float` extension
(required for the floating-point render targets the rim-glow pass uses). A
current desktop Chrome, Edge, or Firefox has both. Without WebGL2 the page
reports "This browser has no WebGL2 support"; without the float extension,
"This GPU/browser lacks floating-point render targets (EXT_color_buffer_float),
needed for the rim glow."

## The controls

The header bar shows the open file and has an **Open…** button that is
always there. The panel on the right is split into collapsible sections
(Framing, Level, White balance for raw files only, Edge, Tone, Output). The
page remembers which sections are open along with your other settings. Every
number beside a slider can be edited: type a value and press Enter, or click
away, to apply it. Values outside a slider's range are clamped to it, and
Escape cancels. With a slider or its number focused, the arrow keys nudge the
value. Shift makes the step coarser, Ctrl makes it finer, and Page Up/Down
make a coarse step. **Export** sits at the bottom of the panel, next to the
exact pixel size and aspect ratio it will write.

### Preview and zoom

The preview fills the stage at the composition's true aspect ratio, drawn at
the screen's full pixel density. The zoom controls in the header bar (−, the
zoom readout, +, **Fit**, **100%**) and the mouse wheel zoom the preview only;
the export is never affected. **100%** means one screen pixel per pixel of
the file Export would write with the current Output settings. When zoomed in,
only the visible region is rendered, at true resolution, never an upscaled
small preview. Double-click the image to toggle between Fit and 100%. At Fit,
dragging a circle rolls it. When zoomed in, a plain drag pans and Shift-drag
rolls. The zoom is not saved and resets to Fit when a file is opened.

The interface is deliberately neutral grey. A tinted surround shifts how you
judge white balance, so colour is kept for the image. The one warm accent only
marks what you are touching.

### Framing

- **Field of view** — how much of the lens to keep, in degrees. 180°
  crops to exactly a hemisphere (no duplication with the other lens, no
  gap). Above 180° you get some of what the other lens also saw; below
  180° you get less than a hemisphere. The note under the slider tells
  you which, and by how much.
- **Calibration** (lens calibration, advanced) — the half-angle, in degrees, at which
  the lens's own image circle sits. This is what turns "field of view" into
  a crop radius. It's set automatically from the camera identified in the
  file (see Calibration below); reach for this slider yourself only if the
  180° crop visibly doesn't reach the true horizon-to-horizon frame, most
  likely on a file whose camera this tool doesn't recognize.
- **Sensors** — export lens A only, lens B only, or both together.
- **Layout** — when exporting both sensors, whether to arrange the two
  circles side by side (2:1 output) or stacked (1:2). This is independent
  of how the *source* file happens to be arranged — a side-by-side `.insp`
  can still be exported stacked, and vice versa.
- **Swap A and B** — exchanges which physical lens is labelled A and which
  is B (and which filename suffix each gets). Disabled for a single-lens
  (1:1) file, which has no lens B to swap in.
- **Gap** — space between the two circles when exporting both, as a
  fraction of one circle's diameter.
- **Margin** — black border kept around each circle, as a fraction of its
  diameter. See "Export sizing" for why the default isn't 0.

### Level

- **Show horizon guides** — overlays a crop-edge circle, an axis-aligned
  thirds grid, and a horizon line on the preview; has no effect on the
  export.
- **Camera roll** — rotates the whole composition to correct a tilted
  horizon. The two lenses are back-to-back with their azimuths running in
  opposite directions, so a single roll value is applied with opposite sign
  to lens B automatically.
- **Lens A / B nudge** — small per-lens rotation (±10°) for correcting a
  lens that's very slightly misaligned relative to its partner, independent
  of the shared roll.
- The text under these sliders reports the FOV/duplication relationship
  described above, live.

### Edge

Controls the synthesized rim glow — the part standing in for what the
sensor crops away. These seven sliders are seven of the *twelve* parameters
that make up the `x1classic` preset (see "The edge preset" below for where
its numbers came from) — the other five (`highlightExponent`, `hazeWidth`,
`hazeStrength`, `terminatorDesaturate`, `terminatorCoolShift`) have no
slider and sit fixed at the preset's own values in `edge.js`'s `PRESETS`
table. **Reset to X1 classic** restores the shipped values of the seven
sliders shown here if you've been experimenting.

- **Intensity** — overall strength of the rim effect.
- **Ring width** — how narrow or broad the colored fringe ring is.
- **Dispersion** — how far apart the red/green/blue fringe rings sit
  (chromatic aberration at the rim). 0 makes the ring achromatic.
- **Glow spread** — how far the rim's brightness variation is smeared
  around the circle's circumference, azimuthally — i.e. how much a bright
  patch near the edge "bleeds" into the neighboring rim rather than staying
  a tight local highlight.
- **Highlight knee / Falloff start / Falloff softness** — shape the
  brightness falloff itself: where in the source image a highlight starts
  counting toward the glow, and where and how abruptly the image fades to
  black at the true edge of the lens's field of view.

### White balance (raw sources only)

Shown only when the loaded file is a raw `.dng` — a JPEG/`.insp` has already
been demosaiced and white balanced by the camera, so the panel has nothing
to do there.

- **Lens A/B Kelvin, Lens A/B tint** — each lens's own white balance,
  independent of the other, expressed as a classic colour-temperature +
  tint pair (like Lightroom's), not raw multipliers. The motivating case is
  one lens in sun and the other in shade, which a single white-balance
  value can't fix. Kelvin is logarithmic (2000–12000 K); dragging it right
  (raising the temperature you're correcting for) warms the image. Tint
  runs −150…+150; positive is magenta, negative is green — dragging either
  readout number directly and pressing Enter/Tab also works. Both readouts
  are editable text, not just labels.
- **Link A and B** (on by default) — moving either lens's controls moves
  both, for the common case where you just want one overall white balance.
  Turn it off to give the two lenses genuinely different white balance.
- **Reset to as-shot** — returns both lenses to the Kelvin/tint that
  reproduces the file's own `AsShotNeutral`, discarding any adjustment.

Internally, `wb.js` converts Kelvin/tint to a camera-space neutral triple
(green fixed at 1, on the Planckian locus for tint 0) via the file's own
`ColorMatrix1`, then feeds that triple through exactly the same shader path
Task 16 established: the renderer divides the demosaiced pixel by it, so a
*lower* value in a channel makes that channel *stronger* in the image.
Because white balance is applied in the fragment shader (demosaic, white
balance, colour matrix and gamma all happen live, every frame, from the
raw sensor data uploaded once at load time), moving these controls costs
nothing and never re-decodes the file.

### Tone

Ordinary global grade applied to the photograph before the rim is
composited: **Exposure** (stops), **Contrast**, **Saturation**. All default
to neutral (no change).

### Output

- **Format** — JPEG or PNG (PNG is lossless; JPEG carries a **quality**
  slider, 60–100). Only the JPEG export carries the source file's EXIF
  (capture time, camera model) forward into the output — a PNG export has
  none, since `Exif.reattach` only knows how to splice APP1 metadata into a
  JPEG container.
- **Pad to sensor square** — see "Export sizing" below.
- **Export** — renders at full resolution to an offscreen buffer (so the
  on-screen preview is never touched) and downloads the result. The
  filename encodes the source name, which lens(es), and the FOV used.

## Calibration

Turning "180° field of view" into an actual crop radius requires knowing
how many degrees of the real world one physical lens's image circle spans
edge-to-edge — the half-angle of that is `thetaMaxDeg` (`Lens.THETA_MAX_DEG`
in `lens.js`).

- **Insta360 X5: 105°** (i.e. a ~210° lens). Measured by correlating the
  two lenses' overlap annuli — the region both lenses photograph — across
  three X5 test files, which agreed with each other at 104–107°. Treated
  as a confident, corroborated figure.
- **Insta360 ONE X: 95°, user-reported** (i.e. a ~190° lens, with very little
  overlap between the two lenses). The ONE X writes `Insta360 One2` as its
  EXIF model. This replaces an earlier provisional 112.5°, measured from a
  single reference file at weak correlation. It is not a measurement, and
  the UI says so.

Other Insta360 bodies (ONE X2, X3, X4) are not listed: their exact EXIF
model strings haven't been confirmed from real files, and a guessed string
would either never match or silently apply the wrong lens. They fall back to
the X5 figure, marked as a default.

The note under the Calibration slider names the camera, its full field of
view and where the number comes from, for example "X5 · 210° full ·
measured" or "ONE X · 190° full · user-reported". The **Field of view**
slider runs from 120° up to the lens's whole image circle (twice the
calibration), so moving the Calibration slider moves its maximum and clamps
the FOV into it.

The camera is identified from the file's EXIF model tag when present. A
stacked 1:2 file with **no** EXIF at all (which does happen — one of this
project's own ONE X test files has none) is never guessed to be an X5: the
X5 never writes that shape, so the tool falls back to the ONE X figure
instead, and says plainly in the UI that the camera wasn't identified and
the number is a guess from the file's shape, not a read tag.

Whatever the source, the **Calibration** slider (60°–150°)
always lets you override `thetaMaxDeg` by eye if the 180° crop doesn't
reach the true horizon — most likely on an unrecognized camera, but nothing
stops you from second-guessing a "confident" one either.

## Export sizing

Exports are sized from the **source pixels actually available**, never
upscaled to some invented target resolution:

- A single-lens export is `circleDiameter + 2 × margin` pixels square,
  where `circleDiameter` is derived from the field of view and the
  uploaded lens's native pixel size — e.g. a full-size Insta360 X5 frame
  (5952 px per lens) at the shipped 180° FOV and 8% margin exports at
  5918 × 5918.
- **Pad to sensor square** additionally pads (and, if needed, upscales)
  the circle out to the full uploaded lens size, rather than cropping
  tightly to the FOV — useful if you want every export from a session to
  come out the same pixel size regardless of FOV.
- If this GPU's `MAX_TEXTURE_SIZE` forced a downscale at load time (very
  large sensors on modest GPUs), the export sizes itself off the
  *downscaled* texture actually in memory, never past what was really
  decoded — the on-screen "Exports at …" line always reflects this.
- Exporting **both** sensors lays the two circles out with
  `width = margin + diameter + gap + diameter + margin` along the long
  axis and `height = margin + diameter + margin` across it (or transposed,
  for the stacked layout). The default **Gap is exactly twice the default
  Margin** (16% vs 8%) specifically so that relationship holds:
  `along / across` comes out to precisely 2.0, keeping a two-up export at
  exactly 2:1 (or 1:2 stacked) out of the box. Move Gap or Margin
  independently and you get a different aspect ratio on purpose — the
  on-screen size readout always shows the ratio you'll actually get, e.g.
  "1.86:1", so a departure from 2:1 is visible rather than silent.

## Raw (DNG) input

The page also accepts Insta360 ONE X raw files (`.dng`), decoded entirely by
`dng.js` — pure byte parsing, no dependency, working the same from `file://`
as over HTTP.

**Only uncompressed 16-bit CFA (Bayer) DNGs are accepted.** Specifically:
`Compression = 1` (uncompressed), 16 bits per sample, one sample per pixel,
`PhotometricInterpretation = 32803` (CFA), and a single strip whose byte
count matches `width × height × 2` exactly. A DNG that uses lossless-JPEG
compression, is 12/14-bit, or is already demosaiced is **declined with a
specific, human-readable reason** (shown in the same error area as any other
load failure) rather than silently mis-decoded — mis-reading a raw file's
sensor data one bit wrong produces a *plausible-looking wrong image*, which
is worse than refusing it outright. `Dng.parse` returns `null` and
`Dng.lastRejectionReason()` explains why; the page falls back to trying the
JPEG path only if the file's extension isn't `.dng`.

**The render is deliberately neutral: demosaic, white balance, the camera's
own colour matrix, and a plain sRGB gamma curve — no creative tone curve.**
The intent is a clean base to finish grading in Lightroom or similar, not a
finished look. (The existing Tone and Edge controls still apply on top, the
same as for a JPEG source, if you do want a look baked in before export.)

Everything past the raw strip itself (demosaic, linearize, white balance,
colour matrix, gamma) happens **in the fragment shader**, from a raw CFA
plane uploaded once to the GPU as a 16-bit integer texture
(`GL.uploadBayer`) — never re-decoded or re-uploaded when you move a
white-balance slider, which is what makes that control free to use live.
The demosaic is a plain bilinear reconstruction (no edge-aware
sharpening) driven by the file's own `CFAPattern` tag, so it isn't limited
to this camera's GRBG arrangement.

**Colour matrix, and why it's not just `invert(ColorMatrix1)`.** A DNG's
`ColorMatrix1` maps CIE XYZ to camera-native RGB — the opposite of what a
renderer needs — so it's inverted once per file, on the CPU, at parse time
(never per fragment). But inverting it and chaining straight into a fixed
D50→sRGB matrix is *not* enough on its own to guarantee a neutral subject
renders neutral: these files carry no `ForwardMatrix`/`CameraCalibration`/
`AnalogBalance` tags, so nothing pins the calibration illuminant's white to
the D50 the fixed matrix assumes. Measured directly against the three
supplied files, that naive chain puts a perfectly white-balanced neutral at
roughly `(2.03, 0.54, 1.46)` in linear sRGB — nowhere near grey. `dng.js`
additionally normalizes the matrix so its own neutral point (its row sums)
lands at exactly `(1, 1, 1)`, folded into the same 3×3 so nothing extra runs
per fragment. Verified against a real, visually neutral patch in one of the
supplied files: R, G, B come out within 0.003 of each other before gamma.
This is a one-time per-channel correction, not a full chromatic adaptation,
so it isn't colorimetrically perfect for strongly saturated colors — an
acceptable trade given the stated goal is a neutral base to finish
elsewhere, not absolute colour accuracy.

**Blown highlights are clamped before the colour matrix, not after.** A
channel that hit the sensor's white level is genuinely unknown past that
point, and a per-lens white-balance gain (up to roughly 2× on this camera's
blue channel) pushes a clipped channel well past 1.0 before white balance
even finishes. Feeding that far-out-of-range value into a matrix with large
negative cross terms doesn't recover detail — it manufactures a colour that
was never in the scene (a blown sky rendered a stark, saturated magenta was
the first symptom found while building this). Clamping the white-balanced
value to `[0, 1]` before the matrix, rather than only clamping its output,
renders the same clipped sky a plausible pale white/blue instead.

**Per-lens white balance, not a single global one.** See "White balance" in
"The controls" above.

## The edge preset and its known limits

The rim-glow shape shipped as `Edge.PRESETS.x1classic` (`edge.js`) was
fitted numerically by `tools/fit-x1-edge.py` against two real Insta360 ONE X
photographs held in `Testfiles/Outputs/` — `IMG_20210605_193319_00_019.jpg`
and `IMG_20210721_192852_00_141.jpg`, stacked dual-fisheye frames
contributing four separate image circles between them. Each circle's true
edge is registered per-azimuth before anything is measured (a robust Fourier
fit to a half-plateau landmark on 1440 rays per circle), because the raw
frame-relative radius differs across circles that simply sit differently in
their frames.

**`Testfiles/Outputs/Flat.jpg` is measured and stored in the fit's fixture,
but deliberately held out of the fit itself.** It's EXIF-tagged Adobe
Lightroom 12.5, is the only reference with a lifted black point, and even
on its own registered radius its run-out is roughly twice as wide as any
ONE X circle's — a single terminator curve can't be both, and averaging
across all five fits neither well. Do not treat `Flat.jpg` as ground truth
for this preset.

**Known limitation: the rendered ring reads less saturated than the
references.** Two of the twelve parameters that make up the preset,
`dispersion` and `ringWidth`, are only weakly constrained by the fit
(neither is actually *fitted* — see the per-parameter verdicts in `edge.js`
above `PRESETS`: `dispersion` is measured directly, and `ringWidth` is set
from it by a fixed ratio, not optimised) — the fit's objective
is luminance-dominated and is nearly blind to a thin chromatic ring (pinning
either parameter to either end of its slider moves the fit's objective by
under 0.0004). Both are set from a direct chromatic measurement of the
references instead of from the optimizer, so they're honest measurements of
real channel separation, but they're small, and the rendered ring is
visibly softer and less colored than the real photographs. Part of this is
structural: the references' saturated blue fringe sits *inside* the
run-out, where this model's only chromatic lever is the achromatic
terminator curve plus a fixed cool color-shift constant (`COOL` in
`shaders.js`) — and `COOL` tops out around 41% of the way to the
references' measured 65% blue channel share. If a rendered rim looks too
neutral for your taste, **raising the Dispersion and Ring width sliders is
the intended remedy** — the shipped defaults are the measured floor from
the fit, not a ceiling on what looks good.

Full provenance, every fitted-vs-unconstrained-vs-boundary-pegged verdict,
and the sensitivity numbers behind each one are documented in the long
comment above `PRESETS` in `edge.js`, and reproduced in detail by running
`tools/fit-x1-edge.py` itself (it prints its own sensitivity table).

## Running the tests

```
npm test
```

runs the whole suite (`node test/run.js`) headlessly
in Node — no browser needed for this. It covers the lens math, edge/rim
math, EXIF and DNG header parsing, roll/nudge geometry, settings persistence,
and a JS/GLSL parity fixture for the rim-profile shaders.

**`Testfiles/` is git-ignored** (it holds ~85 MB of real camera output) —
a fresh clone of this repository does not have it. `test/exif.test.js` and
`test/dng.test.js` read specific files from `Testfiles/` directly (by
filename, e.g. `Sunscreen.insp`, or the three `.dng` raw files) and will fail
with a file-not-found error on a fresh clone until you supply your own
copies of those files at the same paths. The rest of the suite does not
depend on `Testfiles/` and passes on a bare clone.

`tools/fit-x1-edge.py` and `tools/verify-rim.py` are developer tools, not
part of the test suite — they need Python 3 with `numpy`, `Pillow`, and (for
the fitter only) `scipy`, and they too read from `Testfiles/Outputs/`.
