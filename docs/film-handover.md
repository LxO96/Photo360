# Film simulation — handover (grain, tone curves, halation)

A portable description of the film look used in Photo360 (`film.js`,
`shaders.js` `FILM_*`; stocks and grain originally ported from Wigglecam's
`film/` + `filmgpu/`, halation and film formats added in Photo360).
Everything needed to re-implement it in another project is here; the
Photo360 files are the reference implementation.

Sections: **Grain** (first), **Tone curves and colour**, **Halation**, and
the **whole pass** at the end.

## Order of operations

```
display sRGB → linear → + halation → sensitivity 3×3 → per-layer curve
            → grain per layer → crosstalk 3×3 → clamp → display sRGB
```

The input is a *finished* image (display sRGB, 8-bit in Photo360); the
pass re-develops it as if it were film. Effect off = pass skipped entirely.

## What it is, in one paragraph

Grain is **Gaussian-blurred white noise, scaled per pixel by a
density-dependent standard deviation**. The blur width and the std curve are
not hand-tuned: they come from a physical model of silver-halide crystals (a
Boolean model of disks with log-normal radii at Poisson centres, seen through
a Gaussian scan filter). The model gives (a) the grain's variance at each
developed density `u` and (b) its lag-1 spatial correlation; the noise blur
σ is calibrated so the rendered noise has that same correlation, and the
std table gives the amplitude. Result: grain that is strongest in the
mid-tones, vanishes in clipped black/white, has the right "clumpiness", and
scales correctly with output size and film format.

## Pipeline position

Grain is applied **per film layer, in developed (display, 0..1) space**,
after the characteristic curve and before the layer-to-RGB crosstalk:

```
linear rgb → sensitivity 3×3 → per-layer curve → u (0..1)
          → u' = clamp(u + amount · norm · std(u) · n, 0, 1)    ← grain
          → crosstalk 3×3 → output rgb
```

- `n` = blurred unit noise for that layer at that pixel (independent field per
  layer; B&W uses one field for all three channels).
- `std(u)` = lookup in a 201-entry table (`u` rounded to `/200`).
- `norm` = `1 / Σw²` of the blur kernel (restores unit variance after blur,
  see below), `amount` = user slider (0..2, default 1).

If your project has no film curve, apply it to luminance or per channel in
display space; `u` is then just the display value.

## Stock grain parameters

Three numbers per stock, in **render pixels at the reference frame**
(a 4:3 frame 4080 px long, i.e. 3060 px on the short side):

| stock          | radiusMedianPx | radiusLogSigma | filterSigmaPx |
|----------------|---------------:|---------------:|--------------:|
| Vivid 100      | 0.07 | 0.30 | 0.8 |
| Portrait 160   | 0.09 | 0.30 | 0.8 |
| Golden 200     | 0.12 | 0.35 | 0.8 |
| Smooth 400 B&W | 0.13 | 0.30 | 0.8 |
| Pastel 400     | 0.15 | 0.35 | 0.8 |
| Verdant 400    | 0.16 | 0.35 | 0.8 |
| Tungsten 800   | 0.20 | 0.40 | 0.8 |
| Classic 400 B&W| 0.22 | 0.40 | 0.8 |

- `radiusMedianPx`: median crystal radius. Bigger → coarser *and* stronger.
- `radiusLogSigma`: spread of log radius. Bigger → a few large clumps.
- `filterSigmaPx`: scanner/print blur of the crystal image.

## The crystal model (port line for line)

```js
const MAX_U = 0.995, QUANTILES = 32;

function grainModel(radiusMedian, radiusLogSigma, filterSigma) {
  const meanArea = Math.PI * radiusMedian ** 2 * Math.exp(2 * radiusLogSigma ** 2);
  // 32 radius quantiles of the log-normal distribution
  const radii = Array.from({ length: QUANTILES }, (_, i) =>
    radiusMedian * Math.exp(radiusLogSigma * inverseNormal((i + 0.5) / QUANTILES)));
  const rMax = Math.max(...radii);
  // Poisson intensity giving coverage u
  const lambda = (u) => -Math.log(1 - Math.min(Math.max(u, 0), MAX_U)) / meanArea;
  // covariance of the coverage indicator at distance d
  function covariance(u, d) {
    if (u <= 0) return 0;
    const q = 1 - Math.min(Math.max(u, 0), MAX_U);
    let overlap = 0;
    for (const r of radii) overlap += lensArea(r, d);   // two-disk overlap area
    overlap /= radii.length;
    return q * q * (Math.exp(lambda(u) * overlap) - 1);
  }
  // covariance after a Gaussian filter of sigma filterSigma, at offset delta
  // (radial integral, Simpson with 400 steps on [0, 2·rMax])
  function filteredCovariance(u, delta) {
    if (u <= 0) return 0;
    const upper = 2 * rMax, n = 400, h = upper / n, s2 = filterSigma ** 2;
    const f = (r) => covariance(u, r)
      * Math.exp(-(r - delta) ** 2 / (4 * s2)) * i0e(r * delta / (2 * s2)) * r / (2 * s2);
    let sum = f(0) + f(upper);
    for (let i = 1; i < n; i++) sum += (i % 2 ? 4 : 2) * f(i * h);
    return sum * h / 3;
  }
  const filteredVariance = (u) => filteredCovariance(u, 0);
  const lagOneCorrelation = (u = 0.5) => {
    const v = filteredCovariance(u, 0);
    return v <= 0 ? 0 : filteredCovariance(u, 1) / v;
  };
  // the same film rendered s× larger (s < 1 adds the pixel-box term 1/12)
  const forRenderScale = (s) => grainModel(radiusMedian * s, radiusLogSigma,
    Math.sqrt(filterSigma ** 2 * s * s + Math.max(0, 1 - s * s) / 12));
  return { filteredVariance, lagOneCorrelation, forRenderScale };
}

function lensArea(r, d) {
  if (d >= 2 * r) return 0;
  return 2 * r * r * Math.acos(d / (2 * r)) - d / 2 * Math.sqrt(4 * r * r - d * d);
}
```

Helpers (copy verbatim from `film.js`):

- `inverseNormal(p)` — Acklam's rational approximation (|err| < 1.2e-9).
- `i0e(z)` — `e^-z · I0(z)`, Abramowitz & Stegun 9.8.1–9.8.2.

## From model to renderable setup

```js
const MAX_KERNEL_RADIUS = 31;   // shader loop bound; σ above ~10 px is clipped
function gaussianKernel(sigma) {
  const r = Math.min(MAX_KERNEL_RADIUS, Math.max(1, Math.ceil(3 * sigma)));
  const k = new Float64Array(2 * r + 1); let sum = 0;
  for (let i = 0; i < k.length; i++) { k[i] = Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)); sum += k[i]; }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return k;
}
// lag-1 autocorrelation of white noise after this (separable) kernel
function kernelLagOne(sigma) {
  const k = gaussianKernel(sigma); let num = 0, den = 0;
  for (let i = 0; i < k.length; i++) { den += k[i] * k[i]; if (i < k.length - 1) num += k[i] * k[i + 1]; }
  return num / den;
}
// σ whose blurred noise matches the model's lag-1 correlation (60-step bisection)
function calibrateNoiseSigma(target) {
  let lo = 0.05, hi = 20;
  for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (kernelLagOne(m) < target) lo = m; else hi = m; }
  return (lo + hi) / 2;
}

function grainSetup(stockGrain, scale) {
  const model = grainModel(stockGrain.radiusMedianPx, stockGrain.radiusLogSigma,
                           stockGrain.filterSigmaPx).forRenderScale(scale);
  const sigma = calibrateNoiseSigma(model.lagOneCorrelation());
  const k = gaussianKernel(sigma);
  const norm = 1 / k.reduce((a, w) => a + w * w, 0);
  const std = new Float32Array(201);
  for (let i = 0; i <= 200; i++) std[i] = Math.sqrt(Math.max(0, model.filteredVariance(i / 200)));
  return { sigma, radius: (k.length - 1) / 2, weights: k, norm, std };
}
```

A setup costs tens of ms (JS) — cache it by `(stock, scale)` and quantise the
scale to 1/8 octave: `q(v) = 2 ** (Math.round(8 * Math.log2(v)) / 8)`.

**Why `norm = 1/Σw²` (1-D weights).** Blurring unit white noise with the
separable kernel (X then Y, 2-D weights `w_i·w_j`) leaves a variance of
`(Σw²)²`, i.e. a std of `Σw²`. Multiplying the blurred value by `1/Σw²`
brings it back to std 1, so `std(u)` alone sets the amplitude.

## Scale: output size and film format

The stock parameters are for a 3060 px short side **taken as a Super 8 gate
(4.01 mm)**. For an image whose film frame short side is `D` output px:

```
scale = (D / 3060) · (4.01 / gateShortMm)
```

| format    | gate short side | scale at D = 5100 |
|-----------|----------------:|------------------:|
| Super 8   | 4.01 mm | 1.667 |
| Super 16  | 7.41 mm | 0.902 |
| 35 mm     | 24 mm   | 0.278 |
| 120 (6×6) | 56 mm   | 0.119 |

Then `grainSetup(stock.grain, q(scale))`. Below scale 1 the model's
pixel-box term weakens and fines the grain, exactly as a downscaled scan
would; you never need a separate "strength vs size" fudge.

(History: the first cut took 3060 px as 35 mm; the user found it far too
grainy, so today's 35 mm look became the coarsest, Super 8.)

## Noise: deterministic, integer-exact on CPU and GPU

PCG hash (Wigglecam `Rng`), 32-bit wrap-around. JS must use `Math.imul`,
`| 0` and `>>>`; GLSL uses `uint`:

```js
function pcg(v) {
  const state = (Math.imul(v | 0, 747796405) - 1403630843) | 0;   // + 2891336453 mod 2^32
  const word = Math.imul((state >>> ((state >>> 28) + 4)) ^ state, 277803737);
  return ((word >>> 22) ^ word) | 0;
}
const hash4 = (a, b, c, d) => pcg(a ^ pcg(b ^ pcg(c ^ pcg(d))));
const U24 = 1 / 16777216;                 // 24-bit uniforms: exact in fp32
function gaussian(h) {                    // Box-Muller
  const h1 = pcg(h), h2 = pcg(h1);
  const u1 = Math.max((h1 >>> 8) * U24, U24), u2 = (h2 >>> 8) * U24;
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
```

```glsl
uint pcg(uint v) {
  uint state = v * 747796405u + 2891336453u;
  uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
uint hash4(uint a, uint b, uint c, uint d) { return pcg(a ^ pcg(b ^ pcg(c ^ pcg(d)))); }
float filmGauss(uint h) {
  uint h1 = pcg(h), h2 = pcg(h1);
  float u1 = max(float(h1 >> 8u) / 16777216.0, 1.0 / 16777216.0);
  float u2 = float(h2 >> 8u) / 16777216.0;
  return sqrt(-2.0 * log(u1)) * cos(6.283185307179586 * u2);
}
```

Per pixel and layer: `n0 = gaussian(hash4(x, y, layerSeed[l], 0x3C6EF372))`
with `(x, y)` the **output-image pixel** (negative ints are fine: `uint(int)`
in GLSL keeps the bits, same as JS).

Seeds:

- image seed = FNV-1a (32-bit) of the file name → same photo always develops
  the same, different photos differ;
- `layerSeed[l] = hash4(seed, 0, l, 0x51)` for l = 0, 1, 2.

## Rendering (GPU, WebGL2)

1. **Noise pass** → RGBA16F/32F texture, one channel per layer.
2. **Blur X**, **Blur Y** with the setup's σ and radius (clamp-to-edge,
   weights computed in-shader as `exp(-k²/2σ²)` normalised by their sum —
   identical to `gaussianKernel`).
3. **Apply pass**: curve → `u + amount·norm·std(u)·n` → crosstalk. `std` is a
   201×1 R32F texture read with `texelFetch` at `int(clamp(u,0,1)·200 + 0.5)`.

Large exports are done in **horizontal bands** (Photo360: 256 rows) with a
noise margin of `radius` rows above and below each band. Because noise
depends only on the absolute output pixel, bands join seamlessly.

## Preview at another zoom (the trap)

Preview shows `z` screen px per output px.

- **z < 1 (zoomed out):** generate noise at screen resolution, hashing the
  output pixel under each screen pixel, and use the setup at
  `forRenderScale(q(z))` on top of the export scale. Grain correctly gets
  finer and weaker, like a downscaled export.
- **z > 1 (zoomed in):** do **not** re-blur at screen resolution with σ·z —
  that made grain ~z× too strong (0.135 vs 0.048 at 300 %). Instead render
  the noise **on the output-pixel lattice** with the export setup (z = 1)
  for just the visible output pixels (+ blur margin), and magnify it
  nearest-neighbour: screen px `t` → lattice texel `floor((t + 0.5 − origin) / z)`.
  Then the preview is exactly the export, enlarged.

Either way the hash is keyed on output pixels, so grain doesn't crawl when
panning.

## Verification that caught real bugs

- **CPU reference vs GPU**: keep a JS reference renderer of the whole pass
  and diff a test image; Photo360 gets max diff 1/255 (incl. z = 0.6, z = 2.6).
- **Statistics on a flat grey patch**: measured std ≈ `amount·std(u)` and
  measured lag-1 correlation ≈ `model.lagOneCorrelation()`, at z = 1 and
  z = 0.25.
- **Bands**: full render vs banded render identical; boundary-row std equals
  neighbouring rows.
- **Zoom-in**: zoomed preview std equals export std (the bug above).
- **Model numbers**: test `grainModel` values against numbers from the
  original Kotlin formulas; test `pcg` against known outputs in both JS and
  GLSL (wrap-around is where ports break).
- **Off is a no-op**: with the effect off, output byte-identical to before.

## Checklist for a new project

1. Copy `pcg`/`hash4`/`gaussian`, `inverseNormal`, `i0e`, `lensArea`,
   `grainModel`, `gaussianKernel`, `kernelLagOne`, `calibrateNoiseSigma`,
   `grainSetup` (all in Photo360 `film.js`).
2. Decide what `D` (film-frame short side in output px) is for your images
   and offer formats via the gate table.
3. Decide the space `u` (developed layer, or display value) and where in the
   pipeline grain goes (after tone, before final colour mix).
4. Noise keyed on output pixel + per-image seed + per-layer seed.
5. Separable blur, apply with `amount·norm·std(u)·n`, clamp.
6. Bands with `radius` margins for big images; export-lattice magnify for
   zoomed-in previews.
7. Write the parity + statistics tests above before tuning anything.


---

# Tone curves and colour

Each stock is three film layers (R, G, B-sensitive; B&W: one layer) with:

- `sensitivity` 3×3 (row-major): how much of linear R, G, B exposes each
  layer. Off-diagonals and row sums give the stock its cast and saturation.
- a characteristic curve per layer `{gamma, logE0, uMin, uMax}`;
- `crosstalk` 3×3 (row-major): developed layers → output RGB (dye
  impurities; diagonal > 1 with negative off-diagonals = more saturation).

## The curve

Wigglecam `ToneCurve.develop`: a logistic in log10 exposure whose slope at
`logE0` is `gamma`, running from `uMin` (base + fog: the black floor) to `uMax`:

```js
function develop(logE, l) {
  const range = l.uMax - l.uMin;
  const k = 4 * l.gamma / range;          // slope gamma at logE0
  return l.uMin + range / (1 + Math.exp(-k * (logE - l.logE0)));
}
```

The output `u` is **display lightness directly** (0..1, sRGB-like), not
linear: no encode afterwards.

## Re-centring on the input

The stock curves were made for raw scene exposure; here the input is an
already edited image. So per stock, one exposure shift `b` and one stretch
`s` are fitted on the **anchor layer** (green, layer 1; layer 0 for B&W) so
that:

- linear 0.18 → 0.4613561295 (sRGB-encoded 0.18: mid-grey stays put),
- linear 1.0 → 0.96 (white stays near white, keeping a little shoulder).

All three layers then use the same `b` and `s`, so their own differences in
`logE0`/`uMin`/`uMax` and the sensitivity rows remain as the stock's colour.

```js
const MID_OUT = 0.46135612950044164, WHITE_OUT = 0.96;
function fitCurve(stock) {                       // cache per stock
  const l = stock.layers[stock.bw ? 0 : 1];
  const at = (e, b) => develop(Math.log10(e) + b, l);
  const midFor = (b) => {
    const s = (WHITE_OUT - l.uMin) / (at(1, b) - l.uMin);
    return { s, mid: l.uMin + s * (at(0.18, b) - l.uMin) };
  };
  let lo = -4, hi = 4;                            // mid rises monotonically with b
  for (let i = 0; i < 80; i++) { const m = (lo + hi) / 2; if (midFor(m).mid < MID_OUT) lo = m; else hi = m; }
  const b = (lo + hi) / 2;
  return { b, s: midFor(b).s, uMinA: l.uMin };
}

function curvePixel(lin, stock, fit) {           // linear rgb → developed layers
  const m = stock.sensitivity, out = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const e = m[i*3] * lin[0] + m[i*3+1] * lin[1] + m[i*3+2] * lin[2];
    const u = develop(Math.log10(Math.max(e, 1e-5)) + fit.b, stock.layers[i]);
    out[i] = fit.uMinA + fit.s * (u - fit.uMinA);
  }
  return out;
}
// then grain on out[i]; then rgb[c] = clamp01(Σ_j crosstalk[c*3+j] · u[j])
```

Consequences worth knowing:

- Colour negatives **lift black** to their base (`uMin`, about 3–9 %), so pure
  black backgrounds become the film's dark grey. Intended (it is the look);
  mask it if your project needs true black borders.
- Neutral greys need not stay neutral: that is the stock's cast (Golden 200's
  blue sensitivity row sums to 0.84 → warm).
- Grain indexes `std(u)` with the fitted `u`, before crosstalk.

## Stocks

Looks: **Portrait 160** (soft, neutral), **Golden 200** (warm), **Vivid 100**
(saturated, fine grain), **Pastel 400** (low contrast, lifted shadows, minty
greens), **Verdant 400** (green-leaning), **Tungsten 800** (cool in daylight,
coarse grain, strong red halation), **Classic 400 B&W** (contrasty),
**Smooth 400 B&W** (soft). Portrait, Golden, Verdant and both B&W are
Wigglecam's, verbatim; Vivid, Pastel and Tungsten were made in Photo360 in
the same form.

Layers are `{gamma, logE0, uMin, uMax}`, listed R, G, B.

```js
const HALO_STD = { gain: 0.6, tint: [1, 0.28, 0.05] };
const STOCKS = [
  { id: 'portrait160', name: 'Portrait 160', bw: false,
    sensitivity: [1.02, -0.01, -0.01, 0.00, 1.00, 0.00, -0.01, -0.02, 0.96],
    layers: [{ gamma: 0.50, logE0: -0.82, uMin: 0.040, uMax: 0.960 },
             { gamma: 0.50, logE0: -0.82, uMin: 0.040, uMax: 0.960 },
             { gamma: 0.49, logE0: -0.80, uMin: 0.045, uMax: 0.955 }],
    grain: { radiusMedianPx: 0.09, radiusLogSigma: 0.30, filterSigmaPx: 0.8 },
    crosstalk: [1.04, -0.03, -0.01, -0.02, 1.04, -0.02, -0.01, -0.03, 1.04],
    halation: HALO_STD },
  { id: 'golden200', name: 'Golden 200', bw: false,
    sensitivity: [1.06, -0.02, -0.04, -0.01, 1.00, 0.01, -0.03, -0.05, 0.92],
    layers: [{ gamma: 0.62, logE0: -0.80, uMin: 0.035, uMax: 0.965 },
             { gamma: 0.62, logE0: -0.79, uMin: 0.030, uMax: 0.965 },
             { gamma: 0.60, logE0: -0.76, uMin: 0.045, uMax: 0.950 }],
    grain: { radiusMedianPx: 0.12, radiusLogSigma: 0.35, filterSigmaPx: 0.8 },
    crosstalk: [1.12, -0.08, -0.04, -0.06, 1.10, -0.04, -0.03, -0.09, 1.12],
    halation: HALO_STD },
  { id: 'vivid100', name: 'Vivid 100', bw: false,
    sensitivity: [1.08, -0.05, -0.03, -0.04, 1.08, -0.04, -0.03, -0.06, 1.09],
    layers: [{ gamma: 0.70, logE0: -0.80, uMin: 0.030, uMax: 0.970 },
             { gamma: 0.70, logE0: -0.79, uMin: 0.028, uMax: 0.970 },
             { gamma: 0.68, logE0: -0.78, uMin: 0.035, uMax: 0.960 }],
    grain: { radiusMedianPx: 0.07, radiusLogSigma: 0.30, filterSigmaPx: 0.8 },
    crosstalk: [1.16, -0.10, -0.06, -0.07, 1.15, -0.08, -0.04, -0.11, 1.15],
    halation: HALO_STD },
  { id: 'pastel400', name: 'Pastel 400', bw: false,
    sensitivity: [0.96, 0.02, 0.02, 0.00, 0.99, 0.05, 0.02, 0.04, 0.98],
    layers: [{ gamma: 0.41, logE0: -0.90, uMin: 0.085, uMax: 0.952 },
             { gamma: 0.41, logE0: -0.92, uMin: 0.090, uMax: 0.952 },
             { gamma: 0.40, logE0: -0.88, uMin: 0.095, uMax: 0.948 }],
    grain: { radiusMedianPx: 0.15, radiusLogSigma: 0.35, filterSigmaPx: 0.8 },
    crosstalk: [0.95, 0.03, 0.02, 0.03, 0.95, 0.02, 0.02, 0.03, 0.95],
    halation: HALO_STD },
  { id: 'verdant400', name: 'Verdant 400', bw: false,
    sensitivity: [0.97, -0.01, -0.01, -0.01, 1.04, -0.01, -0.01, 0.00, 1.04],
    layers: [{ gamma: 0.60, logE0: -0.76, uMin: 0.030, uMax: 0.960 },
             { gamma: 0.58, logE0: -0.85, uMin: 0.055, uMax: 0.960 },
             { gamma: 0.60, logE0: -0.80, uMin: 0.040, uMax: 0.955 }],
    grain: { radiusMedianPx: 0.16, radiusLogSigma: 0.35, filterSigmaPx: 0.8 },
    crosstalk: [1.08, -0.05, -0.03, -0.04, 1.08, -0.04, -0.02, -0.06, 1.08],
    halation: HALO_STD },
  { id: 'tungsten800', name: 'Tungsten 800', bw: false,
    sensitivity: [0.80, -0.01, -0.01, -0.02, 1.00, 0.02, 0.00, 0.05, 1.22],
    layers: [{ gamma: 0.58, logE0: -0.82, uMin: 0.045, uMax: 0.955 },
             { gamma: 0.58, logE0: -0.80, uMin: 0.040, uMax: 0.955 },
             { gamma: 0.56, logE0: -0.78, uMin: 0.050, uMax: 0.950 }],
    grain: { radiusMedianPx: 0.20, radiusLogSigma: 0.40, filterSigmaPx: 0.8 },
    crosstalk: [1.10, -0.06, -0.04, -0.05, 1.09, -0.04, -0.03, -0.08, 1.11],
    halation: { gain: 1.8, tint: [1, 0.15, 0.02] } },
  { id: 'classic400bw', name: 'Classic 400 B&W', bw: true,
    sensitivity: [0.30, 0.59, 0.11, 0.30, 0.59, 0.11, 0.30, 0.59, 0.11],
    layers: [{ gamma: 0.78, logE0: -0.74, uMin: 0.020, uMax: 0.980 },
             { gamma: 0.78, logE0: -0.74, uMin: 0.020, uMax: 0.980 },
             { gamma: 0.78, logE0: -0.74, uMin: 0.020, uMax: 0.980 }],
    grain: { radiusMedianPx: 0.22, radiusLogSigma: 0.40, filterSigmaPx: 0.8 },
    crosstalk: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    halation: HALO_STD },
  { id: 'smooth400bw', name: 'Smooth 400 B&W', bw: true,
    sensitivity: [0.25, 0.62, 0.13, 0.25, 0.62, 0.13, 0.25, 0.62, 0.13],
    layers: [{ gamma: 0.56, logE0: -0.78, uMin: 0.040, uMax: 0.960 },
             { gamma: 0.56, logE0: -0.78, uMin: 0.040, uMax: 0.960 },
             { gamma: 0.56, logE0: -0.78, uMin: 0.040, uMax: 0.960 }],
    grain: { radiusMedianPx: 0.13, radiusLogSigma: 0.30, filterSigmaPx: 0.8 },
    crosstalk: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    halation: HALO_STD },
];
```

B&W: three identical rows and layers, identity crosstalk; grain uses one
noise field for all channels so it stays neutral.

## Reference values (for tests)

Fit, and output after crosstalk (no grain or halation) for neutral linear
inputs 0, 0.18 and 1:

| stock        | b       | s      | black (rgb)    | mid 0.18 (rgb) | white (rgb)    |
|--------------|--------:|-------:|----------------|----------------|----------------|
| portrait160  | -0.4134 | 1.4131 | .040 .040 .047 | .462 .462 .434 | .960 .961 .923 |
| golden200    | -0.2339 | 1.2222 | .036 .029 .050 | .475 .463 .388 | .970 .962 .890 |
| vivid100     | -0.1826 | 1.1521 | .030 .027 .037 | .472 .461 .454 | .966 .961 .942 |
| pastel400    | -0.7714 | 1.7700 | .082 .090 .098 | .447 .470 .459 | .942 .971 .943 |
| verdant400   | -0.3414 | 1.2715 | .021 .057 .035 | .359 .473 .416 | .888 .968 .937 |
| tungsten800  | -0.2799 | 1.2744 | .047 .039 .054 | .399 .461 .536 | .911 .961 .996 |
| classic400bw | -0.0974 | 1.1005 | .020 .020 .020 | .461 .461 .461 | .960 .960 .960 |
| smooth400bw  | -0.2853 | 1.2998 | .040 .040 .040 | .461 .461 .461 | .960 .960 .960 |

Tuning notes from Photo360: the first Pastel was too washed out (low gamma,
high `uMin` and desaturating crosstalk all stack); a slide stock (Chrome 50)
was tried and dropped.

---

# Halation

Light passes through the emulsion, reflects off the film base and
re-exposes mostly the red layer: a red-orange glow around bright light.
It is added in **linear**, **before** the curve, so the curve's shoulder
compresses it naturally.

## Steps

1. **Source**, from the input's linear luminance (Rec. 709):
   `Y = 0.2126 R + 0.7152 G + 0.0722 B`, `h = smoothstep(0.75, 1.0, Y) · Y`.
   Only near-clipped highlights glow (with 8-bit input: clipped areas and
   the sun). With HDR input, reconsider the threshold.
2. **Spread**: a Gaussian blur of `h` with σ = `R` output px,

   ```
   R = 0.008 · D · 24 / gateShortMm        (D: film-frame short side, px)
   ```

   about 0.19 mm on the film whatever the format, so smaller formats glow
   wider relative to the frame. At D = 5100: Super 8 244 px, Super 16 132,
   35 mm 41, 120 17.5. (Grain's reference format is Super 8, halation's is
   35 mm: two independent constants.)
3. **Cheap at any radius**: box-downsample `h` by
   `f = R ≤ 8 ? 1 : min(64, 2^ceil(log2(R / 8)))`, blur separably with
   σ = `R / f` (≤ 8 texels; kernel radius `ceil(3σ)`), and read it back
   **bilinearly** at full resolution (halo texel coords `(x + 0.5) / f`).
4. **Add** to the linear pixel, before the sensitivity matrix:

   ```
   lin += slider · stock.halation.gain · halo(x, y) · stock.halation.tint
   ```

   `slider` 0..1 (default 0.5). Standard stocks
   `{gain: 0.6, tint: [1, 0.28, 0.05]}`; Tungsten 800 (no anti-halation
   layer) `{gain: 1.8, tint: [1, 0.15, 0.02]}`. Skip the whole path when
   `slider · gain = 0`.

## Code

```js
const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const haloFactor = (R) => (R <= 8 ? 1 : Math.min(64, 2 ** Math.ceil(Math.log2(R / 8))));
const halationRadius = (D, gateShortMm) => 0.008 * D * 24 / gateShortMm;
// halo field: f×f box average of h, then separable clamp-edge Gaussian with
// σ = R / f (gaussianKernel from the grain section), sampled bilinearly.
```

```glsl
// downsample pass: one texel per f×f block, averaged
float y = 0.2126 * dec(c.r) + 0.7152 * dec(c.g) + 0.0722 * dec(c.b);
s += smoothstep(0.75, 1.0, y) * y;
// apply pass, before the curve (x, yUp: full-res pixel, GL y-up)
vec2 hc = (vec2(x, yUp) + 0.5) / uHaloF;
lin += uHalation * uHaloGain * texture(uHalo, hc / uHaloSize).r * uHaloTint;
```

The halo field is a LINEAR-filtered float texture (R16F is enough).

## Notes

- Compute the halo field once over the **whole** image, even when the rest
  of the pass runs in bands (its blur reaches hundreds of px).
- Preview at zoom `z`: radius `R · z` on the screen image. Halation is
  smooth, so it needs no lattice trick (unlike grain).
- The visible strength is well under `gain` because the shoulder compresses
  it: Tungsten's 3× gain shows as about 2× the red of the standard stocks.

---

# The whole pass (GLSL apply shader)

```glsl
uniform mat3 uSens, uCross;      // row-major arrays, uploaded with transpose = true
uniform vec3 uLogE0, uK, uUMin, uRange;   // per layer; uK = 4·gamma/range
uniform vec3 uFit;               // b, s, uMinA
uniform float uGrainK;           // amount · norm
uniform sampler2D uStd;          // 201×1 R32F: std(u)
uniform sampler2D uNoise;        // blurred noise, one channel per layer

vec3 lin = srgbDecode(src);
lin += uHalation * uHaloGain * halo * uHaloTint;
vec3 e = uSens * lin;
vec3 logE = log(max(e, vec3(1e-5))) / log(10.0) + uFit.x;
vec3 u = uUMin + uRange / (1.0 + exp(-uK * (logE - uLogE0)));
u = uFit.z + uFit.y * (u - uFit.z);
u = clamp(u + uGrainK * vec3(stdOf(u.r), stdOf(u.g), stdOf(u.b)) * noise, 0.0, 1.0);
fragColor = vec4(clamp(uCross * u, 0.0, 1.0), 1.0);   // already display values
```

Controls Photo360 exposes: stock (with Off), format (Super 8 / Super 16 /
35 mm / 120), grain 0–200 % (default 100 %), halation 0–100 (default 50).
