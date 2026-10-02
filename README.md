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

### Several photos

Open or drop any number of files at once and they line up in a strip under
the picture; click one to open it. Each photo keeps its own edits and undo
history, and its edits are remembered in the browser (by file name, size
and date, for the 500 most recently edited photos), so the same file opens
as you left it next time. A photo you have not edited yet starts from the
settings you were last using. Only the open photo is decoded, so a big
folder costs little memory; switching re-reads the file (a second or two
for a DNG).

The strip first shows the camera's own thumbnail (a coarse read of the raw
data for a DNG), then a picture of the photo as edited once you have opened
it. A dot marks an edited photo; × removes one from the strip.

- **Copy edits / Paste** (Ctrl+Shift+C / Ctrl+Shift+V) copy every edit,
  levelling included, onto every selected photo.
  Ctrl-click or Shift-click photos to select them; the open photo is always
  included.
- With several selected, **Export N** writes each one with its own edits
  and the current Output settings (DNG only for raw photos, JPEG for the
  rest), one download each. Esc stops it.

### HDR (bracket merge)

Raw (DNG) exposure brackets of a still scene — the same camera and second,
different exposures (shutter time × ISO: the ONE X steps both) — are
recognised in the strip and marked
**HDR n**; click the marker to select the whole set (or Ctrl-select raw
photos by hand), then **Merge HDR**. The merge becomes a new photo,
`<first>_HDR`, next to them: each sensor block is taken from the cleanest
exposure that isn't clipping there (longer exposures count more; a block
nearing white in one frame comes wholly from a shorter one, so highlights
keep their colour), in the middle exposure's brightness. The result keeps
the range the longest exposure clipped, and the tone controls roll that
brighter-than-white range off instead of clipping it (see Tone). It opens
with Auto tone applied, and edits like any photo; it is merged again from
its files each time it is opened (a second or two). JPEG / .insp brackets
aren't merged, there is no alignment or ghost removal (use a still
camera), and a merged photo can't be exported as DNG yet.

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
(Framing, Level, White balance for raw files only, Edge, Tone, Detail, Output). The
page remembers which sections are open along with your other settings. Every
number beside a slider can be edited: type a value and press Enter, or click
away, to apply it. Values outside a slider's range are clamped to it, and
Escape cancels. Double-click a slider to reset it to its default; the
white-balance sliders reset to the file's as-shot values. With a slider or its number focused, ← and → nudge the
value. Shift makes the step coarser, Ctrl makes it finer, and Page Up/Down
make a coarse step. ↑ and ↓ move to the previous or next slider. **Export** sits at the bottom of the panel, next to the
exact pixel size and aspect ratio it will write.

### Keyboard shortcuts

**Keys** in the header, or **?**, lists them, and picks the keyboard layout:
on **Swedish**, before / after is on **<** or **§** instead of `\` (which
needs AltGr there). Cmd stands in for Ctrl on a Mac. Single keys don't fire
while you type in a number box, and Ctrl+Z there undoes the typing.

| Keys | Does |
|---|---|
| Ctrl+Z, Ctrl+Shift+Z / Ctrl+Y | Undo, redo (the last 100 edits of this photo) |
| ↑ / ↓, or , / . | Previous / next slider (in the open sections; from nothing, the last one used) |
| ← / →, or − / + | Change the focused slider (Shift coarse, Ctrl fine) |
| Backspace / Delete | Reset the focused slider |
| Shift+drag | Drag a slider at a tenth of the speed (press or let go of Shift at any time) |
| B | Black & white on / off |
| R / Shift+R | Rotate a quarter turn (Camera roll ±90°) |
| Shift+W | Auto white balance (raw files) |
| Esc | Leave the slider |
| Z | Fit / 100% |
| Ctrl+0, Ctrl+1, Ctrl+= / Ctrl+− | Fit, 100%, zoom in / out |
| `\` (Swedish: < or §) | Before, while held: Tone and Detail off until you let go |
| Ctrl+O, Ctrl+Shift+E, Ctrl+P | Open, Export, Print |
| Page Down / Page Up, or Ctrl+→ / Ctrl+← | Next / previous photo in the strip (Ctrl+arrows not on a slider, where they fine-adjust) |
| Ctrl+Shift+C / Ctrl+Shift+V | Copy edits / paste them onto the selected photos |

History records edits to the picture (Framing, Level, White balance, Edge,
Tone, Detail), one step per finished change: a whole slider drag, a held
arrow key, an Auto click. Open sections, the scopes and zoom are not edits.
Each photo has its own history, kept while the page is open. `history.js` and `shortcuts.js` hold
the logic and the table.

### Scopes

The scopes float over the bottom-right corner of the image, where a fisheye
composition is usually black. **Scopes** in the header (or the × on the box)
shows and hides them. Drag the bracket at the box's top-left corner to
scale it (plot, buttons and text together, 0.75–2.5×, never more than 60%
of the image area's width or height); double-click the bracket to reset.
The size is remembered.

- **Histogram** (the default): how many pixels sit at each brightness, as
  **Luma** or overlaid **RGB** curves. The readout under it gives the share
  of pixels clipped to pure black and pure white, highlighted from 0.5%.
- **Waveform**: brightness (0–100%) across the image, column by column, as
  Luma or an RGB parade.
- **Vector**: colour on the standard Rec.709 vectorscope, with boxes for the
  75% colour targets and a dashed skin-tone line. A neutral image sits in
  the centre, so an off-centre blob shows a colour cast.

All three read the rendered preview, so they include white balance, tone,
detail and edge; when zoomed in they cover only the visible part. They
count the photograph only: the black outside the circles and the synthetic
lens edge inside them (from the Edge falloff start outward) are left out,
since that black would otherwise pile up at 0%.

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
  you which, and by how much, and names the camera's lens (see Calibration
  below).
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

- **Straighten** — click it, then drag along something in the photo that
  should be level or upright: the horizon, a roof edge, a door frame, a
  tree trunk. On release the camera roll changes so that line is truly
  level (or plumb, whichever is the smaller turn), and the tool switches
  off. Esc cancels. A fisheye bends straight lines away from the centre,
  so the tool does not use the on-screen angle of what you drew: it turns
  the two ends back into directions in space (`Lens.straightenDelta`) and
  levels the real line, assuming the lens axis itself was roughly level.
- **Camera roll** — rotates the whole composition to correct a tilted
  horizon. The two lenses are back-to-back with their azimuths running in
  opposite directions, so a single roll value is applied with opposite sign
  to lens B automatically.
- **Lens A / B nudge** — small per-lens rotation (±10°) for correcting a
  lens that's very slightly misaligned relative to its partner, independent
  of the shared roll.
- **Always show guides** — the guides (crop-edge circle, thirds grid,
  horizon line; preview only, never exported) appear while you level —
  moving these sliders, dragging a circle, using Straighten — and fade
  out a second later. Tick this to keep them on.

Controls for a lens that isn't shown (Lens B nudge with "Lens A only", and
the same in White balance) are hidden; with Swap on, "shown" means the
physical lens actually on screen.

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

### White balance

For a raw `.dng` the sliders are Kelvin and tint, below. A JPEG/`.insp` has
already been white balanced by the camera, so there the panel (tagged JPEG)
has relative **Temperature** and **Tint** per lens instead, −100 to +100,
0 = as shot, as in Lightroom for JPEGs: raising Temperature warms, positive
Tint adds magenta. They correct the camera's rendering for a different light
(a chromatic adaptation in linear light that keeps brightness; `jpegwb.js`),
and every JPEG opens at 0 / 0. Link A and B, Pick neutral, Auto, Match lenses
and Reset (to 0 / 0) work the same way for both kinds of file; clipped JPEG
highlights (often the sky's blue channel) are left out of what they measure.

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
- **Auto** (Shift+W) — measures the light from the raw data of the photo
  itself (inside the circle and the Edge falloff; clipped and black pixels
  left out) and sets Kelvin and tint. Linked, both lenses are measured
  together and get one value; unlinked, each lens gets its own. Starting
  from the camera's own white balance, it looks for pixels that come out
  grey and averages those, so a big coloured area (a lawn, the sea, a blue
  sky) doesn't pull it, and the tint stays within 20 of the camera's. The
  note under the buttons says what it set. `autowb.js`.
- **Match lenses** — puts two circles on the photo: an orange **Target** on
  one lens (the colour that is right) and a white **Matching colour** on the
  other, joined by a dashed arrow pointing at the one that changes. Drag each
  onto the same kind of surface (the same sky, wall or grass seen by both
  lenses); drag the handle on a circle's rim, or scroll over it, to size the
  area it averages. Letting go sets the Matching colour lens's Kelvin and
  tint so its circle comes out the Target's colour (hue and saturation;
  white balance can't change brightness), unlinking A and B if they were
  linked. A circle over mostly clipped pixels turns red and says so, since
  there is no colour left to measure there (move it to something bright but
  not blown out). The circles always sit on different lenses: drag one across onto
  the other lens and the two change sides. They stay pinned to the photo
  when you zoom, pan or rotate, and ⇄ Swap switches the roles. Esc or the
  button again puts them away. `wbmatch.js`.
- **Pick neutral** — click it, then click something in the photo that
  should be neutral grey or white, or drag a rectangle over a larger white
  or grey area (a wall, a sheet, a cloud). That lens's Kelvin and tint
  (both lenses when linked) are set so the spot or area renders grey, and
  the note under the buttons says what was set. A click averages a small
  patch; a drag averages the whole rectangle (the part inside the circle).
  It measures with Tone and Detail switched off, so those sliders don't
  skew the pick. Clipped and near-black pixels are left out of the
  average; if most of the area is unusable the pick is refused with a note. The spot's
  camera colour is recovered by inverting the render (`Wb.neutralFromRendered`),
  converted to Kelvin/tint and re-measured a couple of times until it lands.
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
composited, in Lightroom's order: **Exposure** (stops), **Contrast**,
**Highlights**, **Shadows**, **Whites**, **Blacks**, **Saturation**. All
default to neutral (no change).

A merged HDR photo has light brighter than white. For it (only), a
highlight shoulder runs first: lightness above 0.75 is compressed smoothly
so the brightest value lands exactly on white, even with every slider at
0 — raising Exposure pushes more of the range into the shoulder instead of
clipping it; Highlights and Whites then shape it as usual.

**Auto** sets Exposure, Contrast, Highlights, Shadows, Whites and Blacks
from the photo; Saturation stays yours. It measures the whole composition
(not just the zoomed view) with tone off, and counts only the photograph —
inside the circles and inside the Edge falloff start — so the black around
the circles can't make it brighten. It aims for an open, punchy look:
Exposure brings a dark photo up to mid grey but a bright one only a quarter
of the way down (±2 EV, never raised into clipping), so a sunny scene stays
sunny; Highlights pulls the bright part down (at least −20 when there is one) and
Shadows lifts the dark part (at least +25) — local, so both keep texture;
Contrast then puts the punch back in the middle; Whites and Blacks stretch
the ends. Last, if all that left the middle tones darker than they were,
Exposure brings them back — Auto opens a photo up, it doesn't dim it. Blown highlights are left out of the Highlights decision, and pure
white never moves. Each slider is capped short of its range, so the result
is a starting point; click again after other changes to re-measure, or
double-click a slider to reset it. The solver is `autotone.js`.

Highlights, Shadows, Whites and Blacks (−100 to +100) build a luminance
tone curve, applied after exposure and before contrast and saturation.
Highlights and Shadows bend the upper and lower parts of the curve (smooth
weights peaking around 0.75 and 0.25) and never move pure black or white.
Whites and Blacks move the white and black end points. The curve is always
monotonic, so it can't invert tones. The strong directions are the usual
recovery moves: pulling Highlights down and lifting Shadows.

**Highlights and Shadows are local.** They move each area as a whole — a
bright sky, a face in shade — by its smoothed brightness, and the pixel keeps
its texture on top, so recovery doesn't go flat and grey. The smoothing
(`tonebase.js`, a guided filter at a quarter resolution, run once per image)
follows edges, so a horizon or a head against the sky gets no halo. Where
the plain curve would bring out texture (pale clouds when Highlights are
pulled) it still does. Whites and Blacks stay global.

**Colour stays put.** Brightness changes (curve, Contrast) scale linear
light, so hue and saturation are kept. Contrast is a smooth S-curve that
eases into black and white instead of clipping. Saturation works in OKLab
at constant lightness, and eases off before colours leave the displayable
range instead of clipping into another hue. Anything still out of range
(say, after a big Exposure push) fades toward white or black at its own hue.

**Black & white** (or **B**) turns the finished picture — photo and rim —
into greys of the same lightness, last of all, so every other Tone control
still shapes it (Saturation then has nothing to act on). Before / after and
the DNG export leave it out, like the rest of Tone.

`Edge.applyTone` in `edge.js` is the reference, and the shader mirrors it.
`App.checkToneParity()` compares the two on the GPU.

### Detail

**Sharpening** (Amount 0–150, Radius 0.5–2 px) and **Noise reduction**
(Luminance and Colour, 0–100). All four default to off, and at zero they
cost nothing. They run first, on each lens's whole source frame, before
white balance, tone and the fisheye mapping: noise reduction, then
sharpening on what is left. The result is kept and reused, so it is only
redone when a Detail slider or the file changes.

- **The noise is measured, not guessed.** For a DNG, the raw plane gives the
  sensor's noise model on load: read noise from the black around the image
  circle, and shot noise from how the noise grows with brightness (about
  6 DN read noise and 1.6–2 DN per DN on the ONE X / One2 at ISO 100). A
  variance-stabilising transform then makes the noise the same size at
  every brightness, so one setting works in shadows and highlights alike.
  A camera JPEG is already denoised in camera; there the noise is measured
  in the flattest parts of the frame, with a floor of about one 8-bit step.
- **Noise reduction** is multi-scale: the frame is split into five wavelet
  layers, from pixel-fine grain to 32-pixel blotches. In each layer,
  detail about the size of the measured noise is shrunk and larger detail
  (edges, texture) kept. The test looks at each point's small
  neighbourhood, so a lone noise spike goes with the noise around it
  instead of being left as a speck. Luminance and Colour set how hard, in
  units of the measured noise; Colour reaches the coarse layers, where a
  JPEG's colour blotches are. 50 is a strong setting.
- **Sharpening** boosts the fine luminance layers that survived the noise
  reduction (Radius picks which), and only detail well above the noise
  level, so it neither brings the noise back nor adds colour fringes.

They act at pixel level, so judge them at 100% zoom. `detail.js` and
`noise.js` are the reference and the develop shaders mirror them;
`App.checkDetailParity()` compares the two, and `App.noiseInfo()` shows the
measured noise. The DNG export leaves them out, like tone, for the raw
converter to apply.

**Graphics memory.** The Detail panel shows what Detail takes on the GPU,
and where it runs (`devplan.js`):

- **Whole frame**, the fastest: five float copies of a lens frame, about
  370 MB for a ONE X file. Used while that stays under 1 GB.
- **In tiles**: the same GPU passes over 1024 px pieces, each with an 80 px
  border of the frame so the result is identical, pixel for pixel. About
  600 MB for an X5 file (1.4 GB whole), nearly as fast.
- **On the CPU** (`devcpu.js`), when the GPU runs out of memory even for
  tiles: the same method on worker threads, a few seconds per change
  (about 2 s for a ONE X DNG, 6 s for an X5 file on 8 threads). Export and
  print wait for it.

Each falls back to the next when the GPU can't allocate what it needs;
`App.developBudget(bytes)` pretends the GPU has only that much, to try the
fallbacks, and `App.developInfo()` shows the path in use.

### Output

- **Format** — JPEG or PNG (PNG is lossless; JPEG carries a **quality**
  slider, 60–100). Only the JPEG export carries the source file's EXIF
  (capture time, camera model) forward into the output — a PNG export has
  none, since `Exif.reattach` only knows how to splice APP1 metadata into a
  JPEG container.
- **DNG (linear raw)** — raw (DNG) sources only; greyed out otherwise. Writes
  a 16-bit linear-raw DNG (`dngwrite.js`) for Lightroom, ACR, darktable and
  the like: the same framing, roll, FOV, layout and padding as the other
  formats, with the lens edge (falloff, fade, rim glow) baked in, but **no
  Tone or Detail** — you finish it in the raw converter. The pixels are the
  camera's own demosaiced linear data; white balance goes in as
  `AsShotNeutral` (the first shown lens's; with unlinked lenses the other
  lens's pixels are re-expressed so it keeps its own balance), alongside the
  source's `ColorMatrix1`, illuminant, make, model and date. Pixels at
  sensor saturation are clipped to white after white balance, as the
  preview does, so blown sky doesn't turn magenta; everything below that is
  left alone, so bright colours keep their latitude. Uncompressed: about
  67 MB per ONE X lens.
- **Ultra HDR JPEG** — raw (DNG) sources, merged HDR photos included;
  JPEG / .insp sources export a plain JPEG instead. The normal JPEG (same
  quality slider, same EXIF) plus a gain map (`ultrahdr.js`, Ultra HDR v1.1
  with ISO 21496-1 metadata): on an HDR screen — Android 14+, Chrome / Edge
  on an HDR display, iOS 18 / macOS 15 — the highlights are shown brighter,
  everywhere else it is the ordinary JPEG. Only light the edit compressed
  is given back: where Highlights, Whites, the HDR shoulder or Exposure
  squeezed or clipped a highlight, the HDR version shows it nearer its
  real brightness, faded in over the bright tones so mid-tones and faces
  stay exactly the JPEG. **HDR headroom** (1–3 stops, default 2) caps how
  much brighter than white it may go. A merged HDR photo gains the most; an
  unedited single DNG looks the same in HDR. The rim glow is not boosted.
- **Pad to sensor square** — see "Export sizing" below.
- **Export** — renders at full resolution to an offscreen buffer (so the
  on-screen preview is never touched) and downloads the result. The
  filename encodes the source name, which lens(es), and the FOV used.
- **Print** (or **Ctrl+P** / **Cmd+P**) — renders the same full-resolution
  image Export would (same size and padding, no JPEG/PNG encode) and opens
  the browser's print dialog with only that image on the page, scaled to
  fit the page and centred. The page itself has no margin; the printer's
  own unprintable edge is left to the printer. The page is landscape for a
  wider than tall image (both lenses side by side) and portrait otherwise; the
  dialog can still change paper, orientation and scale. Printing from the
  browser's own menu gets the same page. With no file loaded, Ctrl+P prints
  the page as usual.

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

The note under Field of view names the camera, its full field of view and
where the number comes from, for example "X5 · 210° full · measured" or
"ONE X · 190° full · user-reported". The **Field of view** slider runs from
120° up to the lens's whole image circle (twice the calibration). The
calibration comes only from the camera model; there is no control for it,
and it is not saved between sessions.

The camera is identified from the file's EXIF model tag when present. A
stacked 1:2 file with **no** EXIF at all (which does happen — one of this
project's own ONE X test files has none) is never guessed to be an X5: the
X5 never writes that shape, so the tool falls back to the ONE X figure
instead, and says plainly in the UI that the camera wasn't identified and
the number is a guess from the file's shape, not a read tag.

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
