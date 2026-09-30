# HDR bracket merge — design

Date: 2026-09-30. Sub-project 2 of 3 (1. file strip — done; 2. bracket
merge; 3. HDR display/export). Builds on the strip (photos.js, strip.js).

## Goal

Merge a set of raw (DNG) exposure brackets into one high-dynamic-range raw
photo that is then edited like any other, so highlights clipped in the
longer exposures and shadows noisy in the shorter ones both come out clean.

## What the user said / decided

- HDR means both merging brackets and (later, sub-project 3) HDR
  display/export.
- Brackets are shot from a still camera of a still scene: no alignment, no
  ghost removal.
- DNG only (JPEG/.insp brackets are not merged).
- Approach A: merge the raw sensor data on the CPU into a floating-point
  raw plane that the existing GPU pipeline takes as a new input kind.
- Revised (same day): the pipeline clamps every pixel to white before the
  tone controls, which would clip the merged highlights again, so the raw
  path and the tone controls are extended to carry and roll off values
  brighter than white (see "Brighter than white"). This is also the base
  sub-project 3 (HDR display) needs.

## Finding bracket sets

- Every DNG added to the strip has its header read in the background
  (already done for its quick thumbnail): camera model, capture time
  (DateTime, to the second), ISO, exposure time, sensor size, CFA pattern,
  black/white level.
- DNGs with the same model, capture second, ISO, sensor size and CFA
  pattern, and at least two different exposure times, form a set. Files
  with the same exposure time as another member are left out of that set.
- The strip marks each member tile with a small "HDR n" marker (n = set
  size) in the tile's top-left corner.
- Test data: `IMG_20240825_174907_00_019.dng` (1/867 s) and `_020`
  (1/217 s) — a 2 EV pair, same second, ISO 100.

## Starting a merge

- A **Merge HDR** button in the strip head is enabled when the selection
  holds two or more DNGs that could merge (same model, sensor size, CFA,
  ISO; different exposure times) — either a detected set or any such
  Ctrl-selected DNGs. Clicking the marker on a tile selects its whole set.
- The merge adds a new strip entry right after the last member, named
  `<first member stem>_HDR` (e.g. `IMG_20240825_174907_00_019_HDR`), and
  opens it. The source photos stay in the strip.
- Merging the same set again opens the existing entry instead of adding a
  second.

## The merge (CPU, in a worker)

Per lens, per CFA sample, for frames i = 1..n with exposure time t_i:

- `n_i = (v_i - black) / (white - black)` (the sample, 0..1).
- Reference exposure `t_ref` = the median exposure time (for an even
  count, the longer of the two middle ones), so the merged photo has the
  brightness of the middle bracket.
- Radiance estimate `r_i = n_i * t_ref / t_i`.
- Clip test per 2×2 Bayer block: `m_i` = the block's largest `n_i`.
  Clip weight `c_i = 1 - smoothstep(KNEE, CLIP, m_i)` with `KNEE = 0.80`,
  `CLIP = 0.95`, so a block is dropped from a frame as it nears clipping
  (per block, so the channels of one pixel never come from different
  frames — no magenta highlights).
- Noise weight `t_i` (a longer exposure collected more light).
- `w_i = c_i * t_i`; output `r = Σ w_i r_i / Σ w_i`.
- If every frame's weight is zero (clipped even in the shortest frame),
  output the shortest frame's `r_i`.
- Output: a `Float32Array` plane per lens, black 0, white 1, values up to
  `t_ref / t_min` (the merged photo's headroom, `hdrMax`).
- Runs in a Blob-URL worker (like devcpu.js), so it works from `file://`;
  one lens at a time, ~2 × 37 MB file reads + ~74 MB output for a
  3040 × 3040 dual-lens pair.

## Float raw input (GPU and CPU paths)

- The merged photo is a normal raw descriptor (`kind: 'dng'`,
  `isRaw: true`) with `rawMeta.black = 0`, `rawMeta.white = 1`,
  `hdrMax`, float planes, the reference frame's colour matrix, as-shot
  neutral, model, date and calibration.
- `GL.makeBayerTexture` uploads a `Float32Array` plane as `R32F` (vs
  `R16UI` for the integer plane). The raw sampling shader gets a float
  variant (`sampler2D`, no black/white scaling), chosen per lens.
- The CPU develop fallback (devcpu.js) and the noise profile fit
  (noise.js) accept a float plane (black 0, white 1).
- Parity requirement: a single frame converted to float (`n` values) must
  render the same as its 16-bit original (within 1e-3).

## Brighter than white

Today every raw pixel is clamped to 1 (the sensor's white) right after
demosaic (`shaders.js` `rawCameraAt`, `demosaicAt`, the developed-frame
read), and the tone curve clamps its base to 1 (`edge.js` applyTone). For
a merged photo, values up to `hdrMax` are real scene light, so:

- **Raw path:** each of those clamps becomes `[0, uRawMax]`, with
  `uRawMax = hdrMax` for a merged photo and 1 for everything else (so
  ordinary files render exactly as now). The white-balance clamp that
  keeps clipped highlights from turning magenta keeps working, at
  `uRawMax` instead of 1.
- **Tone:** a highlight shoulder, applied to lightness `l` (and to the
  local base) before Highlights / Shadows / Whites / Blacks / Contrast:
  - headroom `H = srgbEncode(uRawMax) · 2^exposureEv` — the lightness a
    fully clipped white reaches after Exposure;
  - when `H > 1` (only possible for a merged photo), lightness above the
    knee `K = 0.75` is compressed so `H` lands exactly on 1:
    `x = (l − K) / (1 − K)`, `X = (H − K) / (1 − K)`,
    `l' = K + (1 − K) · x (1 + x / X²) / (1 + x)` — slope 1 at the knee,
    monotone, `l' ≤ 1`;
  - below the knee, or with `H ≤ 1`, `l' = l` — so ordinary files, and
    `uRawMax = 1`, are bit-identical to today (the existing tone parity
    and tone tests stay unchanged);
  - for a merged photo the shoulder applies even with every tone slider
    at 0 (the pass-through shortcut is skipped when `H > 1`), so it never
    shows clipped highlights by default;
  - colour follows lightness as now (the pixel's linear RGB scaled by the
    luminance ratio, then the gamut map).
- The JS reference (`Edge.applyTone(rgb, tone, coef, rawMax = 1)`) and
  `TONE_GLSL` (`uniform float uRawMax`) change together; the tone parity
  check gains merged-photo cases (`rawMax` 4 and 16).
- **Auto tone** on a merged photo renders its tone-off frame scaled by
  `1 / srgbEncode(hdrMax)` (so nothing clips in the 8-bit histogram) and
  `AutoTone.solve` takes that scale and `rawMax`, reading percentiles in
  the photo's real range and simulating the shoulder through
  `Edge.applyTone(..., rawMax)`.
- The scopes show the displayed (toned) picture, as now.

## Opening a merged photo

- A merged entry has no file of its own: opening it re-reads its members
  and merges again (progress in the strip note: "Merging 2 photos…").
  Only the open photo's planes are kept.
- Its edits are stored under the key `HDR|` + the members' keys, sorted.
- The first time it opens (no stored edits) Auto tone is applied, so the
  recovered highlights are visible at once. White balance starts as shot
  (the reference frame's).
- Its thumbnail is the rendered preview once opened; before that, the
  reference member's quick thumbnail.

## Export

- JPEG / PNG / Print: unchanged.
- DNG export is disabled for a merged photo (the 16-bit writer would clip
  it); the format option is greyed with the note "DNG of a merged HDR photo
  comes with HDR export". Floating-point DNG is sub-project 3.
- Export N includes merged entries (each re-merged in turn).

## Error handling

- A member that fails to parse, or differs in size/CFA/model: Merge HDR
  stays disabled with a tooltip saying why.
- A member removed from the strip: the merged entry keeps working while
  its files are still referenced (the `File` objects live in the entry);
  removing the merged entry itself is allowed any time.
- Merge failure (read error, out of memory): the entry shows the error
  badge, the previous photo stays open.

## Not included

- Alignment and ghost removal; JPEG/.insp brackets; tone-mapping presets
  beyond Auto tone; HDR display and float DNG export (sub-project 3).

## Testing

- Unit (node):
  - the shoulder: identity for `rawMax = 1` at any exposure (every existing
    tone test unchanged), `H` maps to 1, monotone and slope 1 at the knee,
    active with all sliders at 0 when `H > 1`;
  - Auto tone on a synthetic merged histogram (bright sky beyond 1):
    highlights end below 1, the median near the middle bracket's;
  - set detection: grouping by model/second/ISO/size/CFA, duplicate
    exposure left out, singletons ignored;
  - merge maths on synthetic planes: a linear ramp exposed at t and 4t
    merges back to the ramp (within 1%), a block clipped in the long frame
    comes from the short one, colour of a near-clipped block stays neutral,
    all-clipped falls back to the shortest, reference = median exposure;
  - DNG exposure-time / ISO parsing from the Exif IFD;
  - float plane through `Noise.fitProfile` and devcpu develop.
- GPU parity (headless Chrome, as the existing parity checks): float copy
  of one frame vs its 16-bit original; tone parity with `rawMax` 4 and 16.
- Headless end to end: add `_019` and `_020`, the set is detected, Merge
  HDR creates and opens `…_HDR`; in a sky region clipped in `_020` the
  merged, exposure-matched pixels are unclipped and match `_019` scaled
  by 4 within 3%.
