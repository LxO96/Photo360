# Rim looks — design

Date: 2026-10-02.

## Goal

A small library of built-in **looks** for the lens rim: named sets of the
rim settings that give clearly different edges (the fitted X1 classic, a
clean edge, a soft one, a rainbow fringe...). Pick one, then fine-tune with
the sliders.

## What the user said / decided

- Looks are presets of the rim settings, not new stackable effect kinds.
- Built-in only: no saving your own looks.
- Their ONE X shots sometimes show a **blue highlight on the rim**. In
  `Testfiles/Outputs/IMG_20210605_193319_00_019.jpg` (lower circle) it is a
  thin, saturated blue-violet line where the image runs out, then a dark
  band. The model cannot make it today (edge.js: the cast `COOL` tops out at
  b ≈ 0.41 of the RGB sum, the references reach 0.65), so two new values
  are added that looks can set.

## The look values

A look sets every one of these and nothing else:

- The seven Edge sliders: edgeIntensity, ringWidth, dispersion,
  glowSpreadDeg, highlightKnee, falloffStart, falloffSoftness.
- The five values with no slider: highlightExponent, hazeWidth,
  hazeStrength, terminatorDesaturate, terminatorCoolShift.
- New, no slider:
  - `castColor` [r, g, b]: the colour the last of the image takes on as it
    fades (replaces the shader's fixed `COOL`, which becomes X1 classic's
    value, 0.82 / 0.92 / 1.12). terminatorCoolShift stays its amount.
    A warm cast makes a warm look possible.
  - `fringeColor` [r, g, b] and `fringeStrength` (0..1): a thin line of
    colour where the image fades out, as on the ONE X (see below).
    X1 classic keeps 0, so it renders exactly as today.
- The sun glare Strength (`sun.strength`). Not the sun's position or its on
  switch.

All live in `state.edge` (sun strength in `state.sun`), so they are part of
the photo's edits: saved, undone and pasted like any other.

## The fringe

At radius u, with `term(u)` the terminator (1 inside the falloff start, 0
at the edge), the fringe sits where the image is half faded:

    band(u) = exp(-((term(u) - 0.5) / 0.18)^2)      (a line in fade space,
                                                     so it follows Falloff
                                                     start / softness)
    img = mix(img, fringeColor * luma(img_before_fade) * 1.6, fringeStrength * band(u))

It takes its brightness from the image right there (a bright sky gives a
bright line, a dark edge none), as the chromatic edge of a real lens does.
Mirrored in edge.js (`fringeAt`) with a parity check like the others; in the
DNG composite it is applied in linear light like the cast.

## The library

`Edge.LOOKS`, an ordered list of `{ id, name, edge: {...all edge values},
sunStrength }`. `PRESETS.x1classic` stays as the first look's values (and
the app default). Starting set — values tuned by eye on Sunscreen.insp and
the sun-in-frame DNG, shown to the user before committing:

1. **X1 classic** — today's fitted values.
2. **X1 blue rim** — X1 classic plus the blue-violet fringe of the
   reference (fringeColor ≈ (0.35, 0.3, 1.0), fringeStrength ≈ 0.7).
3. **Clean** — nearly hard edge, faint glow, no dispersion, no fringe.
4. **Soft** — wide gentle fade, broad haze, stronger sun glare.
5. **Prism** — wide ring, strong dispersion: a clear rainbow fringe.
6. **Muted** — desaturated fade, weak glow, neutral cast.
7. **Warm** — amber cast and fringe, a sunset edge.
8. **Dark edge** — no glow or haze: the image fades straight to black.

Every look's values sit inside `Settings.RANGES` (tested).

## UI

- A **Look** select at the top of the Edge panel, replacing "Reset to X1
  classic". Picking a look sets all its values in one undo step (also the
  way to reset to it).
- The select shows the look whose values the photo has, or "<name>
  (edited)" for the look last picked once a slider moves, or "Custom" when
  nothing matches (an older photo, values from elsewhere). Which look is
  derived by matching values, not stored.

## State, settings

- `RANGES.edge` gains castColor [0, 2], fringeColor [0, 1],
  fringeStrength [0, 1]. Older stored settings lack them and get X1
  classic's (sanitize already fills missing leaves).

## Testing

- Every look within RANGES; X1 classic equals PRESETS.x1classic; ids unique.
- `fringeAt` shape: 0 with strength 0, peak at half fade, scales with the
  image luma. JS/GLSL parity on the GPU (App check, like the tone one).
- Static: both composites use `uCastColor` and the fringe; the fixed
  `COOL` constant is gone.
- `lookOf(edge, sunStrength)`: exact match → that look; changed → null.
- Headless GPU: X1 classic renders pixel-identical to before; a contact
  sheet of all looks on the two test photos for the user.

## Not included

- Saving your own looks (decided: built-in only).
- The faint grey outer line in the reference (the lens barrel's edge, past
  a dark band) — a possible later look value.
