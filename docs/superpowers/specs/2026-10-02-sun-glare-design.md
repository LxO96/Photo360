# Sun glare on the rim — design

Date: 2026-10-02.

## Goal

Outdoors, a real fisheye's rim is lit by the sun: veiling glare that is
brightest on the side of the rim facing the sun and weak on a lens that
faces away from it. The synthesized rim today is driven only by the image
right next to the edge (edge.js `buildRimProfile`), with samples capped at
white, so it cannot show this. The X1 fit (edge.js, "SHADOW-BAND
OPTIMIZATION") already found that the references' light outside the circle
is "sun-positioned veiling glare, which the model's content-driven glow
cannot reproduce". This adds that missing term.

## What the user said / decided

- Effect: **rim-wide glare** — the sun, wherever it is (including in the
  other lens), brightens the whole rim, most on the side facing it. No
  separate tight flare at the sun's azimuth.
- Finding the sun: **automatic, with a draggable marker** to correct it,
  and an off switch for when it is wrong or there is no sun.

## Geometry

The sun is stored as a unit direction in the camera frame:

- Lens A looks along +z. A source-image point at offset (dx, dy) from the
  lens's image-circle centre, in units of the image-circle radius, has
  polar angle `θ = ρ · θmax` (ρ = |(dx, dy)|, equidistant model, lens.js
  `THETA_MAX_DEG`, or the calibration's own θmax) and azimuth
  `φ = atan2(dy, dx)`:
  `dirA = (sinθ cosφ, sinθ sinφ, cosθ)`.
- Lens B is back-to-back and its azimuths run the other way (lens.js
  `rollFor`): `dir = (−sinθ cosφ, sinθ sinφ, −cosθ)`.
- The mirror convention is checked against `Testfiles/Sunscreen.insp`, where
  the sun is in both lenses' overlap: detected separately in each lens, the
  two directions agree across the seam (x, y within 0.01). They are 10° apart
  in how far past each lens's horizon the sun is (94.6° + 95.7° from the two
  axes, not 180°): the equidistant model with the X5's θmax 105° is a few
  degrees off near the rim. Far below the glare's 60° lobe; not corrected
  here.

For drawing lens L, the CPU converts the sun into that lens's frame: polar
angle `θs` from the lens axis and azimuth `φs` in the displayed circle's
coordinates (after roll and nudge, after Swap). The shader gets those two
numbers per lens.

## The glare term

A rim point at displayed azimuth θ looks at 90° from the lens axis, so the
angle γ between it and the sun is `cos γ = sin θs · cos(θ − φs)`.

    glare(θ) = uSunStrength · K · tint · (F + (1 − F) · lobe(γ)) · facing(θs)
    lobe(γ)   = exp(−(γ / W)²)
    facing(θs) = 1 − smoothstep(90°, θmax + 15°, θs) · (1 − B)

- `W` lobe width, `F` floor (the part of the glare spread over the whole
  rim of a lens facing the sun), `B` the fraction a lens facing away keeps,
  `K` the overall scale in display units. These four are constants in
  edge.js `SUN` with no slider: W = 60°, F = 0.25, B = 0.1, K = 0.12 (the X1
  haze from a white edge is about 0.08), chosen by eye. The reference
  measurements in `test/fixtures/x1-rim-profile.json` hold two bands per
  circle and no sun position, so they can't check or fit these after all;
  the README says so.
- The radial shape is the existing haze: `rimBell(u, 1, uHazeWidth)`. The
  glare is added in `rimLight` (shaders.js `EDGE_GLSL`) next to the glow and
  haze, so it goes wherever the rim goes (preview, every export format,
  monochrome, the terminator) with no other plumbing.
- `tint`: the mean colour of an annulus of 1.5–3× the sun blob's radius
  around it, normalised to max 1 and halfway desaturated toward white.
  A low sun gives warm glare.
- edge.js gets `sunGlare(theta, sun, consts)`, the JS reference; a parity
  test in the style of test/parity.test.js keeps the GLSL in step.
- Ultra HDR: the gain map ignores the rim already; it still does.

## Detection

Run when a photo is first opened and has no stored sun (and on
**Re-detect**). Both lenses are rendered at 256 × 256 over the whole source
image circle (θ up to θmax, no roll, no tone, exposure 0) into a float
target and read back. Raw and merged photos keep values above white; a
JPEG/.insp is display values, clipped at 1.

Each output texel is the brightest pixel (by luma) of its block, so a
small sun survives the downsampling.

- Peak `p` = the largest luminance over both lenses. If `p < 0.95`, there is
  no sun: glare stays off.
- Candidates are the connected components (8-neighbour) of pixels
  ≥ `0.98 · p`: clipped white in a JPEG or single raw frame, and in a merged
  HDR photo only what clipped even in its darkest exposure (the sun, not a
  sky the brighter frames recovered).
- A candidate must have at least 12 pixels (fewer is a glint), at most 2% of
  its image circle (more is a blown-out sky or a wall), and fill at least
  40% of its enclosing circle (less is a railing or a lit edge). The largest
  is the sun; its luminance-weighted centroid is where it is. None: no sun.
- (Changed from the first draft, which took the component around the single
  brightest pixel: in a JPEG every clipped pixel ties at 1, and on
  Sunscreen.insp that picked a one-pixel glint on a shirt.)
- The pure function is sundetect.js `detect(lenses, opts) → {lens, x, y,
  radius, tint} | null` over plain arrays, so it is tested in Node without a
  browser. app.js turns its result into the direction above.

## UI

Edge panel, under the existing sliders:

- **Sun glare** checkbox and **Strength** slider (0–200%, default 100%).
- **Re-detect** button.
- A sun marker (a small ring) in the preview at the sun's position when
  glare is on and the Edge panel is open. Drag it to move the sun on
  either lens. A sun that falls outside the displayed 180° crop is drawn
  as a hollow ring pinned at the rim, at its azimuth. It can be dragged
  back in.
- Status text under the controls: "Sun found in Lens A", "No sun found",
  or "Placed by hand".

## State

`state.sun = { on, mode: 'auto' | 'manual', dir: [x, y, z] | null,
strength, tint: [r, g, b] }`.

- Saved with the photo's edits (localStorage per photo) and in its History,
  like every other edit. Dragging is one history step.
- **Not pasted** (photos.js `PASTE_SKIP` gains `sun`): each shot's sun is
  its own. Reset to X1 classic does not touch it.
- A merged HDR photo detects from its merged image (values above white).
- Old saved photos have no `sun`: they detect on next open.

## Testing

- sundetect.js on synthetic planes: a single bright disc (found, right
  centroid), a disc in lens B, a blown sky (rejected), an HDR sky with a
  bright sun inside (accepted), nothing above 0.95 (null).
- The geometry: source position → direction → per-lens (θs, φs) round
  trips; roll and Swap move φs as the image moves.
- The glare: γ formula, facing() limits, the reference-band sign check
  above, JS/GLSL parity.
- Headless browser on the RTX 3070: `Sunscreen.insp` finds the sun in both
  lenses (see Geometry) and its rim is brighter on the sun side;
  `HDR/173735` finds the same direction in a single frame and in the merge;
  `IMG_20180101_044910_00_030.dng` (a daytime frame despite its unset clock)
  puts the marker on the sun. Dragging, undo and paste checked there too.
- npm test stays green.

## Not included

- A tight flare or ghost at the sun's azimuth.
- Glare inside the image (veiling over the photo), lens flare ghosts.
- Sun position from time, GPS and orientation metadata.
