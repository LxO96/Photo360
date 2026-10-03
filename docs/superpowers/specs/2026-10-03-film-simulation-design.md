# Film simulation (silver halide) — design

Date: 2026-10-03.

## Goal

An optional film look on the finished image: a film **stock** (colour and
tone), **grain** modelled on silver-halide crystals, and **halation**, with
a **format** (Super 8 … 120) that sets how coarse the grain and how wide the
halation are. Ported from the user's Wigglecam app
(`C:\Users\Leo\Gits\Wigglecam`, `film/` and `filmgpu/`), which has the
stocks and the grain but no halation.

## What the user said / decided

- Shown in the preview and in the export (not export-only).
- Wigglecam's five stocks and its calibrated grain, plus:
  - a grain amount slider,
  - halation,
  - a grain size option by film format, "such as super 16 being bigger
    grain".
- Not ported: Wigglecam's lens character (vignette, chromatic aberration,
  softness, per-frame variation) -- Photo360 models its own lens.
- Approved in chat: a post-pass on the composed image; stock curves
  re-centred on the user's edit; Off by default.

## Settings

`state.film` (persisted, copied by paste-settings like the other edits):

| key        | values                                                          | default |
|------------|-----------------------------------------------------------------|---------|
| `stock`    | `off`, `golden200`, `verdant400`, `portrait160`, `classic400bw`, `smooth400bw` | `off` |
| `gauge`    | `s8`, `s16`, `35`, `120` (the film format; not `format`, which is the output file type) | `35` |
| `grain`    | 0 .. 2 (multiplier on the stock's grain std)                    | 1       |
| `halation` | 0 .. 1                                                          | 0.5     |

UI: a new **Film** panel (collapsible like the others, after Tone/Detail,
before Output). Stock as a row of chips ("Off" first), Format as a select
("Super 8", "Super 16", "35 mm", "120 (6×6)"), Grain and Halation sliders
(shown as 0–200 % and 0–100). Format, Grain and Halation are disabled while
the stock is Off. Each change is one undo step; slider drags coalesce like
the existing sliders.

## Stocks (verbatim from Wigglecam `film/src/main/resources/stocks/*.json`)

Display names: Golden 200, Verdant 400, Portrait 160, Classic 400 B&W,
Smooth 400 B&W. Per stock: `sensitivity` 3×3, three layer curves
`{gamma, logE0, uMin, uMax}`, `crosstalk` 3×3 (row-major; identity for B&W),
grain `{radiusMedianPx, radiusLogSigma, filterSigmaPx}` at Wigglecam's
reference frame, `bw`. B&W stocks have one layer (sensitivity row 0, e.g.
`[.30,.59,.11]`) replicated to RGB. All values are copied exactly into a new
`film.js` `STOCKS` table, with a test comparing them to the JSON files'
numbers transcribed in the test.

## The film pass

Runs after the composition (photo, tone, edge, rim, sun glare, mono) on the
composed display-sRGB image, per output pixel:

1. **Linear:** `x = srgbDecode(rgb)`.
2. **Halation** (below) is added to `x`.
3. **Exposure per layer:** `e_l = sensitivity[l] · x`.
4. **Characteristic curve, re-centred on the edit.** Wigglecam's curve
   (`ToneCurve.develop`: `u = uMin + range / (1 + exp(-k (logE - logE0)))`,
   `k = 4 gamma / range`) gives display values directly; its own slope is
   kept. Per stock, one exposure shift `b` and one stretch `s` are fitted on
   the anchor layer (green, layer 1; layer 0 for B&W):
   `logE_l = log10(max(e_l, 1e-5)) + b`,
   `u_l = uMinA + s (develop_l(logE_l) - uMinA)` (uMinA: the anchor's uMin),
   with `b` (bisection) and `s` chosen so linear 0.18 -> display 0.461 (sRGB
   of 0.18) and linear 1.0 -> display 0.96 on the anchor layer. The other
   layers use the same `b`, `s`, so their own `logE0`/`uMin`/`uMax` and
   sensitivity rows remain as the stock's colour (Golden 200's blue row sums
   to 0.84: a warm cast, as intended).
   Result: mid-grey and white stay about where the edit put them; the stock
   adds its toe, shoulder, contrast and cast.
5. **Grain**, per layer, in `u` (below).
6. **Crosstalk:** `rgb = crosstalk · u'`, clamped to 0..1 → output.

Stock Off: the pass is skipped entirely (the render is exactly today's).

## Grain

Wigglecam's FastGrain, ported to JS (model + tables) and GLSL (passes):

- `GrainModel(radiusMedian, radiusLogSigma, filterSigma)` with `meanArea`,
  `lambda`, `covariance`, `filteredCovariance` (Simpson, 400 steps, 32 radius
  quantiles, Acklam inverse normal, A&S `i0e`), `lagOneCorrelation`,
  `forRenderScale` — a line-for-line port, tested against values computed
  from the Kotlin formulas.
- `calibrateNoiseSigma` (60-step bisection on [0.05, 20]), Gaussian kernel
  radius `max(1, ceil(3σ))` capped at 63 taps, `normalization = 1/Σw²`,
  std table of 201 entries `sqrt(filteredVariance(i/200))`.
- Render: unit white noise per pixel and layer from a PCG-style integer
  hash of (export x, export y, seed, layer), separable Gaussian blur
  (2 passes), then `u' = clamp(u + grain · std(u) · n · normalization, 0, 1)`.
- **Seed:** a hash of the photo's file name, so a photo always develops the
  same and two photos differ. The two lenses sit at different pixels, so
  they get independent grain (two separate negatives).

### Format → grain size

Each lens circle stands for one film frame, its diameter `D` (export px)
spanning the gate's short side. Wigglecam's grain parameters are for a 4:3
frame 4080 px long, i.e. a short side of 3060 px. That frame is taken as
**Super 8** (4.01 mm short side) -- revised 2026-10-03 at the user's request
("scale the grain down a whole lot", today's 35 mm look = the coarsest); the
first cut took it as 35 mm. Export render scale:

`scale = (D / 3060) · (4.01 / gateShort)`, gateShort: Super 8 4.01 mm,
Super 16 7.41 mm, 35 mm 24 mm, 120 56 mm.

So Super 8 is Wigglecam's grain; Super 16 0.54×, 35 mm 0.17×, 120 0.07× its
size (below a pixel the model's pixel-box term also weakens it). The export
model is `GrainModel(stock grain).forRenderScale(scale)`. Halation keeps its
own size relative to 35 mm (below).

### Preview

The preview shows a view at `z` screen px per export px. Its model is the
export model `.forRenderScale(z)` (Wigglecam's own rule for rendering the
same film at another size; for z < 1 it adds the pixel-box term, so
zoomed-out grain is weaker, as in a downscaled export). Noise is hashed on
the export-pixel lattice (the export pixel under each screen pixel), so
grain does not crawl when panning; when zoomed in (z > 1) the blur σ is in
screen px, `σ_export · z`. Models are cached by (stock, format, scale
quantised to 1/8 octave) — building one costs ~100 ms in Kotlin.

## Halation

Light that passes the emulsion, reflects off the film base and re-exposes
mostly the red layer around bright areas:

- Source: `h = smoothstep(0.75, 1.0, Y) · Y` from the linear luminance `Y`
  of the composed image (the composition is 8-bit display, so clipped
  highlights, the sun and its glare, are the trigger).
- Spread: a wide soft blur of `h`, radius `R = 0.008 · D · (24 / gateShort)`
  export px (≈ 0.2 mm on 35 mm), made with a downsample pyramid (cheap at
  any radius); in the preview `R · z`.
- Added before the curve: `x += halation · 0.6 · blur(h) · [1.0, 0.28, 0.05]`.

## Pipeline placement

- `GL.renderComposition` gains a film stage: when `state.film.stock !== 'off'`
  (and not a DNG or gain-map render), the composition is drawn into an
  intermediate RGBA8 texture of the target size; the film passes (halation
  pyramid, noise, blur X, blur Y, apply) then draw into the real target
  (canvas or export FBO). The extra textures are reused across previews and
  freed after an export.
- Export of large frames (up to ~10200 × 5100): the film passes run in
  horizontal bands of rows with margins of the blur radius plus the
  halation radius, reading the full composed texture, so the temporaries
  stay band-sized. Noise depends only on export position, so bands join
  without seams.
- JPEG, PNG and Print get the look. Ultra HDR: the SDR base gets it; the
  gain map is unchanged. DNG: never (it is raw data).

## Testing

- `test/film.test.js`: stock table transcription; curve re-centring
  (0.18 → 0.461, 1 → 0.96 on the anchor layer; neutrals stay neutral
  through crosstalk); `GrainModel` against reference numbers from the
  Kotlin formulas; `calibrateNoiseSigma`/kernel; `forRenderScale`; format
  scale factors; settings ranges/enums/persistence/paste.
- GPU parity (`App.checkFilmParity`, like `checkSunParity`): the GPU film
  pass against a JS reference on a test image (curve + crosstalk + grain
  with a fixed seed) within float tolerance.
- Grain statistics: measured std and lag-1 correlation of a rendered flat
  grey patch match the model at z = 1 and z = 0.25.
- Headless check on the test files: stock Off renders byte-identical to
  HEAD; Super 16 visibly coarser than 35 mm; halation shows around the sun.

## Out of scope

Saved custom stocks; grain in the DNG; lens character from Wigglecam;
grain on the gain map.

## More looks (2026-10-03, approved in chat)

Three stocks of this app's own, in Wigglecam's form: **Vivid 100** (fine,
saturated negative), **Pastel 400** (lower contrast, lifted shadows, mildly
desaturating crosstalk, minty greens) and **Tungsten 800** (cool daylight
cast via its sensitivity rows, coarse grain, strong red halation). Chip
order: negatives, tungsten, B&W. A slide stock (Chrome 50) was tried and
dropped at the user's request; a first Pastel was too washed out.

Halation becomes per stock, `{gain, tint}`, scaled by the slider: the
Wigglecam five keep `{0.6, [1, 0.28, 0.05]}` (exports byte-identical to
before), Tungsten 800 `{1.8, [1, 0.15, 0.02]}`.
