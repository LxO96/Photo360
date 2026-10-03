# Film Simulation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An optional silver-halide film look (stock, calibrated grain, halation, film gauge) on the preview, JPEG/PNG/Ultra HDR export and print.

**Architecture:** A pure `film.js` module (stocks, curve fit, Wigglecam's grain model port, PCG hash, a JS reference renderer) drives a GPU post-pass in `gl.js`/`shaders.js` that runs on the composed display image: a whole-image low-res halation field, then per band of rows: hashed noise → separable blur → apply (curve, grain, crosstalk). The preview composes into an offscreen texture and runs one band to the canvas; export runs bands into a band target and reads each back.

**Tech Stack:** Plain UMD JS modules (no build), WebGL2 / GLSL ES 3.00, `node:test` (`npm test`), headless Chrome via scratchpad `cdp_gpu.py` for GPU checks.

**Spec:** `docs/superpowers/specs/2026-10-03-film-simulation-design.md`

## Global Constraints

- `Testfiles/` is read-only: never modify or commit it.
- Commit only when the user asks (the plan's commit steps are skipped unless the user said so; leave changes staged-free in the working tree).
- Preserve each file's existing line endings (check with scratchpad `eol2.py`; new files LF). Never rewrite whole files through Python text mode on Windows.
- Stock Off must render byte-identical to HEAD (no film code path runs).
- DNG export and the Ultra HDR gain-map render never get the film pass.
- Stock values copied exactly from Wigglecam `film/src/main/resources/stocks/*.json`.
- Mid-grey linear 0.18 → display 0.4613561295 and linear 1.0 → 0.96 on the anchor layer (green; layer 0 for B&W).
- Gate short sides: Super 8 4.01 mm, Super 16 7.41 mm, 35 mm 24 mm, 120 56 mm; reference 35 mm short side = 3060 export px.
- Halation: `h = smoothstep(0.75, 1, Y)·Y`, radius `0.008·D·24/gateShort`, added as `halation·0.6·blur(h)·[1, 0.28, 0.05]` to linear before the curve.
- State key `film = {stock, gauge, grain, halation}`, defaults `{off, '35', 1, 0.5}`.

## Review Focus

1. **Huge exports (≈10200×5100) with film on** — must not allocate full-size float textures; bands must join without visible seams (noise depends only on export position; margins ≥ kernel radius).
2. **Zoomed preview vs export** — grain must not crawl when panning and must look like the export at 100 %; zoomed out it must be weaker, not aliased.
3. **Switching photos / undo / paste** — `film` travels with per-photo edits, undo and paste; a photo opened with stock Off renders exactly as before.
4. **B&W stocks** — grain must be monochrome (one noise field), not three coloured fields.
5. **Super 8 at large export** — kernel radius capped at 31 taps each side; no shader loop beyond the cap, no NaN from huge σ.

Tests pinning these: Task 3 (band seam test in the JS reference, B&W grain test, cap test), Task 4 (settings/paste), Task 7 (GPU parity across bands and zoom).

---

## File map

- Create `film.js` — stocks, gauges, curve fit, hash, grain model, kernels, params, JS reference renderer.
- Create `test/film.test.js`.
- Modify `settings.js` — PERSISTED_KEYS, ENUMS, RANGES, PANEL_SECTIONS, DEFAULT_PANELS.
- Modify `shaders.js` — `FILM_GLSL`, `FILM_HALO_DOWN_FS`, `FILM_BLUR_FS`, `FILM_NOISE_FS`, `FILM_APPLY_FS`; export them.
- Modify `gl.js` — film programs in ctx, `filmFrame`, `renderFilmed`, `filmStrips`, `releaseFilm`.
- Modify `app.js` — state default, Film panel wiring, preview/export/print paths, before view, `checkFilmParity`.
- Modify `index.html` — Film panel, CSS, `<script src="film.js">` before `shaders.js`.
- Modify `README.md`.
- Tests: `test/settings.test.js`, `test/ui-settings.test.js`, `test/photos.test.js`, `test/gl.test.js`.

---

### Task 1: film.js — stocks, gauges, curve fit, hash

**Files:**
- Create: `film.js`
- Test: `test/film.test.js`

**Interfaces:**
- Produces: `Film.STOCKS` (array of `{id, name, bw, sensitivity[9], layers[3]{gamma,logE0,uMin,uMax}, grain{radiusMedianPx,radiusLogSigma,filterSigmaPx}, crosstalk[9]}`), `Film.GAUGES` (`[{id, name, short}]`), `Film.MID_OUT`, `Film.WHITE_OUT`, `Film.HALATION`, `Film.REF_SHORT_PX`, `Film.REF_SHORT_MM`, `Film.develop(logE, layer)`, `Film.fitCurve(stock) → {b, s, uMinA}` (cached per stock id), `Film.curvePixel(lin[3], stock, fit) → u[3]`, `Film.pcg(int) → int32`, `Film.hash4(a,b,c,d) → int32`, `Film.gaussian(h) → number`, `Film.seedOf(name) → int32`, `Film.layerSeeds(seed) → [int32×3]`, `Film.srgbDecode(v)`, `Film.srgbEncode(v)`.

- [ ] **Step 1: Write the failing tests** (`test/film.test.js`)

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Film = require('../film.js');

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} ${a} vs ${b}`);

test('the five Wigglecam stocks, transcribed exactly', () => {
  assert.deepStrictEqual(Film.STOCKS.map((s) => s.id),
    ['golden200', 'verdant400', 'portrait160', 'classic400bw', 'smooth400bw']);
  const g = Film.STOCKS[0];
  assert.deepStrictEqual(g, {
    id: 'golden200', name: 'Golden 200', bw: false,
    sensitivity: [1.06, -0.02, -0.04, -0.01, 1.00, 0.01, -0.03, -0.05, 0.92],
    layers: [
      { gamma: 0.62, logE0: -0.80, uMin: 0.035, uMax: 0.965 },
      { gamma: 0.62, logE0: -0.79, uMin: 0.030, uMax: 0.965 },
      { gamma: 0.60, logE0: -0.76, uMin: 0.045, uMax: 0.950 },
    ],
    grain: { radiusMedianPx: 0.12, radiusLogSigma: 0.35, filterSigmaPx: 0.8 },
    crosstalk: [1.12, -0.08, -0.04, -0.06, 1.10, -0.04, -0.03, -0.09, 1.12],
  });
  const v = Film.STOCKS[1];
  assert.deepStrictEqual(v.sensitivity, [0.97, -0.01, -0.01, -0.01, 1.04, -0.01, -0.01, 0.00, 1.04]);
  assert.deepStrictEqual(v.layers[1], { gamma: 0.58, logE0: -0.85, uMin: 0.055, uMax: 0.960 });
  assert.deepStrictEqual(v.grain, { radiusMedianPx: 0.16, radiusLogSigma: 0.35, filterSigmaPx: 0.8 });
  assert.deepStrictEqual(v.crosstalk, [1.08, -0.05, -0.03, -0.04, 1.08, -0.04, -0.02, -0.06, 1.08]);
  const p = Film.STOCKS[2];
  assert.deepStrictEqual(p.layers[2], { gamma: 0.49, logE0: -0.80, uMin: 0.045, uMax: 0.955 });
  assert.deepStrictEqual(p.grain, { radiusMedianPx: 0.09, radiusLogSigma: 0.30, filterSigmaPx: 0.8 });
  const c = Film.STOCKS[3];
  assert.strictEqual(c.bw, true);
  assert.deepStrictEqual(c.sensitivity, [0.30, 0.59, 0.11, 0.30, 0.59, 0.11, 0.30, 0.59, 0.11]);
  assert.deepStrictEqual(c.layers[0], { gamma: 0.78, logE0: -0.74, uMin: 0.020, uMax: 0.980 });
  assert.deepStrictEqual(c.grain, { radiusMedianPx: 0.22, radiusLogSigma: 0.40, filterSigmaPx: 0.8 });
  const s = Film.STOCKS[4];
  assert.deepStrictEqual(s.sensitivity.slice(0, 3), [0.25, 0.62, 0.13]);
  assert.deepStrictEqual(s.layers[0], { gamma: 0.56, logE0: -0.78, uMin: 0.040, uMax: 0.960 });
  assert.deepStrictEqual(s.crosstalk, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
});

test('every colour stock\'s crosstalk rows sum to 1 (neutrals stay neutral)', () => {
  for (const s of Film.STOCKS) {
    for (let r = 0; r < 3; r++) near(s.crosstalk[r * 3] + s.crosstalk[r * 3 + 1] + s.crosstalk[r * 3 + 2], 1, 1e-9, s.id);
  }
});

test('gauges: short sides of the gate', () => {
  assert.deepStrictEqual(Film.GAUGES.map((g) => [g.id, g.short]),
    [['s8', 4.01], ['s16', 7.41], ['35', 24], ['120', 56]]);
});

test('develop: Wigglecam\'s logistic, mid-range at logE0 with slope gamma', () => {
  const l = { gamma: 0.62, logE0: -0.8, uMin: 0.035, uMax: 0.965 };
  near(Film.develop(-0.8, l), 0.5, 1e-12);
  const d = 1e-6;
  near((Film.develop(-0.8 + d, l) - Film.develop(-0.8 - d, l)) / (2 * d), 0.62, 1e-6);
});

test('fitCurve pins mid-grey and white on the anchor layer for every stock', () => {
  for (const s of Film.STOCKS) {
    const f = Film.fitCurve(s);
    const a = s.bw ? 0 : 1;
    const out = (x) => Film.curvePixel([x, x, x], { ...s, sensitivity: [1, 0, 0, 0, 1, 0, 0, 0, 1] }, f)[a];
    near(out(0.18), Film.MID_OUT, 1e-6, s.id + ' mid');
    near(out(1.0), Film.WHITE_OUT, 1e-6, s.id + ' white');
    assert.ok(out(0.01) < out(0.18) && out(0.18) < out(1), s.id + ' monotone');
  }
  near(Film.MID_OUT, 0.46135612950044164, 1e-12);
});

// 32-bit reference with BigInt: the PCG hash as Wigglecam's Rng.hash (Int wraps).
function pcgRef(v) {
  const M = 0xFFFFFFFFn;
  const st = (BigInt.asUintN(32, BigInt(v)) * 747796405n + 2891336453n) & M;
  const word = (((st >> ((st >> 28n) + 4n)) ^ st) * 277803737n) & M;
  return Number(BigInt.asIntN(32, (word >> 22n) ^ word));
}

test('pcg matches a 32-bit BigInt reference, negative inputs included', () => {
  for (const v of [0, 1, 2, 12345, -1, -987654, 0x7fffffff, -0x80000000, 3141592653 | 0]) {
    assert.strictEqual(Film.pcg(v), pcgRef(v), String(v));
  }
});

test('hash4 nests as Wigglecam: hash(a ^ hash(b ^ hash(c ^ hash(d))))', () => {
  const want = pcgRef(5 ^ pcgRef(-7 ^ pcgRef(11 ^ pcgRef(0x51))));
  assert.strictEqual(Film.hash4(5, -7, 11, 0x51), want);
});

test('gaussian: 24-bit uniforms (as on the GPU), unit normal statistics', () => {
  let s = 0, s2 = 0;
  const n = 200000;
  for (let i = 0; i < n; i++) { const g = Film.gaussian(Film.hash4(i, 3, 9, 1)); s += g; s2 += g * g; }
  near(s / n, 0, 0.01, 'mean');
  near(s2 / n, 1, 0.02, 'variance');
});

test('seedOf: deterministic, differs between names; three layer seeds differ', () => {
  assert.strictEqual(Film.seedOf('IMG_1.insp'), Film.seedOf('IMG_1.insp'));
  assert.notStrictEqual(Film.seedOf('IMG_1.insp'), Film.seedOf('IMG_2.insp'));
  const l = Film.layerSeeds(Film.seedOf('x'));
  assert.strictEqual(new Set(l).size, 3);
  assert.ok(l.every((v) => Number.isInteger(v) && v === (v | 0)));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/film.test.js`
Expected: FAIL — `Cannot find module '../film.js'`.

- [ ] **Step 3: Implement `film.js` (this task's part)**

```js
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Film = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Film simulation (spec docs/superpowers/specs/2026-10-03-film-simulation-design.md),
  // ported from the user's Wigglecam app (film/ and filmgpu/): stocks, the
  // characteristic curve, grain calibrated to a silver-halide crystal model,
  // plus halation and the film gauge, which Wigglecam does not have. The GPU
  // passes are shaders.js FILM_*; this module holds the maths, the per-render
  // parameters and a JS reference renderer the GPU is checked against.

  // Verbatim from Wigglecam film/src/main/resources/stocks/*.json.
  // sensitivity and crosstalk are 3x3, row-major.
  const STOCKS = [
    { id: 'golden200', name: 'Golden 200', bw: false,
      sensitivity: [1.06, -0.02, -0.04, -0.01, 1.00, 0.01, -0.03, -0.05, 0.92],
      layers: [
        { gamma: 0.62, logE0: -0.80, uMin: 0.035, uMax: 0.965 },
        { gamma: 0.62, logE0: -0.79, uMin: 0.030, uMax: 0.965 },
        { gamma: 0.60, logE0: -0.76, uMin: 0.045, uMax: 0.950 },
      ],
      grain: { radiusMedianPx: 0.12, radiusLogSigma: 0.35, filterSigmaPx: 0.8 },
      crosstalk: [1.12, -0.08, -0.04, -0.06, 1.10, -0.04, -0.03, -0.09, 1.12] },
    { id: 'verdant400', name: 'Verdant 400', bw: false,
      sensitivity: [0.97, -0.01, -0.01, -0.01, 1.04, -0.01, -0.01, 0.00, 1.04],
      layers: [
        { gamma: 0.60, logE0: -0.76, uMin: 0.030, uMax: 0.960 },
        { gamma: 0.58, logE0: -0.85, uMin: 0.055, uMax: 0.960 },
        { gamma: 0.60, logE0: -0.80, uMin: 0.040, uMax: 0.955 },
      ],
      grain: { radiusMedianPx: 0.16, radiusLogSigma: 0.35, filterSigmaPx: 0.8 },
      crosstalk: [1.08, -0.05, -0.03, -0.04, 1.08, -0.04, -0.02, -0.06, 1.08] },
    { id: 'portrait160', name: 'Portrait 160', bw: false,
      sensitivity: [1.02, -0.01, -0.01, 0.00, 1.00, 0.00, -0.01, -0.02, 0.96],
      layers: [
        { gamma: 0.50, logE0: -0.82, uMin: 0.040, uMax: 0.960 },
        { gamma: 0.50, logE0: -0.82, uMin: 0.040, uMax: 0.960 },
        { gamma: 0.49, logE0: -0.80, uMin: 0.045, uMax: 0.955 },
      ],
      grain: { radiusMedianPx: 0.09, radiusLogSigma: 0.30, filterSigmaPx: 0.8 },
      crosstalk: [1.04, -0.03, -0.01, -0.02, 1.04, -0.02, -0.01, -0.03, 1.04] },
    { id: 'classic400bw', name: 'Classic 400 B&W', bw: true,
      sensitivity: [0.30, 0.59, 0.11, 0.30, 0.59, 0.11, 0.30, 0.59, 0.11],
      layers: [
        { gamma: 0.78, logE0: -0.74, uMin: 0.020, uMax: 0.980 },
        { gamma: 0.78, logE0: -0.74, uMin: 0.020, uMax: 0.980 },
        { gamma: 0.78, logE0: -0.74, uMin: 0.020, uMax: 0.980 },
      ],
      grain: { radiusMedianPx: 0.22, radiusLogSigma: 0.40, filterSigmaPx: 0.8 },
      crosstalk: [1, 0, 0, 0, 1, 0, 0, 0, 1] },
    { id: 'smooth400bw', name: 'Smooth 400 B&W', bw: true,
      sensitivity: [0.25, 0.62, 0.13, 0.25, 0.62, 0.13, 0.25, 0.62, 0.13],
      layers: [
        { gamma: 0.56, logE0: -0.78, uMin: 0.040, uMax: 0.960 },
        { gamma: 0.56, logE0: -0.78, uMin: 0.040, uMax: 0.960 },
        { gamma: 0.56, logE0: -0.78, uMin: 0.040, uMax: 0.960 },
      ],
      grain: { radiusMedianPx: 0.13, radiusLogSigma: 0.30, filterSigmaPx: 0.8 },
      crosstalk: [1, 0, 0, 0, 1, 0, 0, 0, 1] },
  ];

  // Film gauges: the gate's short side (mm). Each lens circle stands for one
  // frame, its diameter spanning the short side, so a smaller gate means
  // coarser grain and wider halation at the same export size.
  const GAUGES = [
    { id: 's8', name: 'Super 8', short: 4.01 },
    { id: 's16', name: 'Super 16', short: 7.41 },
    { id: '35', name: '35 mm', short: 24 },
    { id: '120', name: '120 (6×6)', short: 56 },
  ];
  // Wigglecam's grain sizes are for a 4:3 frame 4080 px long: 3060 px on the
  // short side, taken as 35 mm's 24 mm.
  const REF_SHORT_PX = 3060;
  const REF_SHORT_MM = 24;

  const srgbDecode = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  const srgbEncode = (x) => (x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);
  const MID = 0.18;
  const MID_OUT = srgbEncode(MID);   // 0.46135612950044164
  const WHITE_OUT = 0.96;
  const HALATION = { LO: 0.75, HI: 1.0, GAIN: 0.6, TINT: [1, 0.28, 0.05], RADIUS: 0.008 };

  // Wigglecam ToneCurve.develop: developed fraction (display lightness) for
  // log10 exposure, a logistic with slope gamma at logE0.
  function develop(logE, l) {
    const range = l.uMax - l.uMin;
    const k = 4 * l.gamma / range;
    return l.uMin + range / (1 + Math.exp(-k * (logE - l.logE0)));
  }

  // The curve re-centred on the edit (the input is already a finished
  // image): one exposure shift b and one stretch s per stock, fitted on the
  // anchor layer so linear 0.18 -> MID_OUT and 1.0 -> WHITE_OUT. The other
  // layers share b and s, so the stock's own layer differences stay as its
  // colour. b by bisection: the stretched mid rises monotonically with b.
  const fitCache = new Map();
  function fitCurve(stock) {
    if (fitCache.has(stock.id)) return fitCache.get(stock.id);
    const l = stock.layers[stock.bw ? 0 : 1];
    const at = (e, b) => develop(Math.log10(e) + b, l);
    const midFor = (b) => {
      const s = (WHITE_OUT - l.uMin) / (at(1, b) - l.uMin);
      return { s, mid: l.uMin + s * (at(MID, b) - l.uMin) };
    };
    let lo = -4, hi = 4;
    for (let i = 0; i < 80; i++) {
      const m = (lo + hi) / 2;
      if (midFor(m).mid < MID_OUT) lo = m; else hi = m;
    }
    const b = (lo + hi) / 2;
    const fit = { b, s: midFor(b).s, uMinA: l.uMin };
    fitCache.set(stock.id, fit);
    return fit;
  }

  // Linear rgb -> the three developed layers (display values, before grain).
  function curvePixel(lin, stock, fit) {
    const m = stock.sensitivity, out = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      const e = m[i * 3] * lin[0] + m[i * 3 + 1] * lin[1] + m[i * 3 + 2] * lin[2];
      const u = develop(Math.log10(Math.max(e, 1e-5)) + fit.b, stock.layers[i]);
      out[i] = fit.uMinA + fit.s * (u - fit.uMinA);
    }
    return out;
  }

  // Wigglecam Rng.hash (PCG), 32-bit integer ops only so the shader
  // (FILM_GLSL pcg) reproduces it exactly. Returns a signed int32.
  function pcg(v) {
    const state = (Math.imul(v | 0, 747796405) - 1403630843) | 0;
    const word = Math.imul((state >>> ((state >>> 28) + 4)) ^ state, 277803737);
    return ((word >>> 22) ^ word) | 0;
  }
  const hash4 = (a, b, c, d) => pcg(a ^ pcg(b ^ pcg(c ^ pcg(d))));
  // Box-Muller from 24-bit uniforms, as Wigglecam's GPU uniform01 (fp32
  // safe); the shader does the same.
  const U24 = 1 / 16777216;
  function gaussian(h) {
    const h1 = pcg(h), h2 = pcg(h1);
    const u1 = Math.max((h1 >>> 8) * U24, U24);
    const u2 = (h2 >>> 8) * U24;
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
  // The photo's grain seed: FNV-1a of its file name, so a photo always
  // develops the same and two photos differ.
  function seedOf(name) {
    let h = 0x811c9dc5 | 0;
    for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 0x01000193);
    return h | 0;
  }
  // Wigglecam FilmPipeline.layerSeed with frame 0.
  const layerSeeds = (seed) => [0, 1, 2].map((l) => hash4(seed, 0, l, 0x51));

  return {
    STOCKS, GAUGES, REF_SHORT_PX, REF_SHORT_MM, MID_OUT, WHITE_OUT, HALATION,
    srgbDecode, srgbEncode, develop, fitCurve, curvePixel,
    pcg, hash4, gaussian, seedOf, layerSeeds,
  };
});
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/film.test.js`
Expected: PASS, all tests.

- [ ] **Step 5: Commit** (only if the user asked) — `git add film.js test/film.test.js && git commit -m "feat(film): stocks, re-centred curve and PCG hash from Wigglecam"`

---

### Task 2: film.js — grain model, kernels, setups

**Files:**
- Modify: `film.js`
- Test: `test/film.test.js`

**Interfaces:**
- Consumes: Task 1's module.
- Produces: `Film.inverseNormal(p)`, `Film.i0e(z)`, `Film.grainModel(rMed, sLog, fSig) → {radiusMedian, radiusLogSigma, filterSigma, meanArea, maxRadius, lambda(u), covariance(u,d), filteredCovariance(u,δ), filteredVariance(u), lagOneCorrelation(u=0.5), forRenderScale(s)}`, `Film.gaussianKernel(sigma) → Float64Array` (radius `min(MAX_KERNEL_RADIUS, max(1, ceil(3σ)))`), `Film.kernelLagOne(sigma)`, `Film.calibrateNoiseSigma(target)`, `Film.MAX_KERNEL_RADIUS = 31`, `Film.STD_TABLE = 200`, `Film.grainSetup(grainParams, scaleExport, z) → {model, sigma, radius, weights: Float32Array, norm, std: Float32Array(201)}` (cached), `Film.quantizeScale(v)`.

- [ ] **Step 1: Write the failing tests** (append to `test/film.test.js`)

```js
test('grainModel: coverage from lambda, point covariance u(1-u), zero beyond reach', () => {
  const m = Film.grainModel(0.3, 0.35, 0.8);
  for (const u of [0.1, 0.5, 0.9]) near(1 - Math.exp(-m.lambda(u) * m.meanArea), u, 1e-9);
  for (const u of [0.2, 0.5, 0.8]) near(m.covariance(u, 0), u * (1 - u), 0.03 * u * (1 - u));
  assert.strictEqual(m.covariance(0.5, 2.5 * m.maxRadius), 0);
});

test('grainModel: filtered variance peaks mid-tone, zero at u=0', () => {
  const m = Film.grainModel(0.3, 0.35, 0.8);
  const mid = m.filteredVariance(0.5);
  assert.ok(mid > m.filteredVariance(0.1) && mid > m.filteredVariance(0.95) && mid < 0.25);
  assert.strictEqual(m.filteredVariance(0), 0);
});

test('forRenderScale as Wigglecam (its GrainModelTest numbers)', () => {
  const m = Film.grainModel(1.2, 0.35, 0.9);
  const same = m.forRenderScale(1);
  assert.deepStrictEqual([same.radiusMedian, same.radiusLogSigma, same.filterSigma], [1.2, 0.35, 0.9]);
  const q = m.forRenderScale(0.25);
  near(q.radiusMedian, 0.3, 1e-12);
  near(q.filterSigma, Math.sqrt(0.9 * 0.9 * 0.0625 + (1 - 0.0625) / 12), 1e-12);
});

test('inverseNormal and i0e', () => {
  near(Film.inverseNormal(0.5), 0, 1e-9);
  near(Film.inverseNormal(0.975), 1.959964, 1e-5);
  near(Film.inverseNormal(0.01), -2.326348, 1e-5);
  near(Film.i0e(0), 1, 1e-7);
  near(Film.i0e(1), 1.2660658777520082 * Math.exp(-1), 1e-6);
  near(Film.i0e(10), 2815.716628466254 * Math.exp(-10), 1e-6);
});

test('calibrateNoiseSigma inverts kernelLagOne', () => {
  for (const t of [0.2, 0.5, 0.8]) near(Film.kernelLagOne(Film.calibrateNoiseSigma(t)), t, 1e-6);
});

test('gaussianKernel: normalised, radius max(1, ceil(3 sigma)) capped at 31', () => {
  const k = Film.gaussianKernel(1.4);
  assert.strictEqual(k.length, 2 * 5 + 1);
  near(k.reduce((a, b) => a + b, 0), 1, 1e-12);
  assert.strictEqual(Film.gaussianKernel(0.1).length, 3);
  assert.strictEqual(Film.gaussianKernel(40).length, 2 * Film.MAX_KERNEL_RADIUS + 1);
});

test('grainSetup: std table from the scaled model, unit-variance normalisation, cached', () => {
  const p = Film.STOCKS[0].grain;
  const a = Film.grainSetup(p, 1.6, 1);
  assert.strictEqual(a, Film.grainSetup(p, 1.6, 1));
  assert.strictEqual(a.std.length, Film.STD_TABLE + 1);
  near(a.std[100], Math.sqrt(a.model.filteredVariance(0.5)), 1e-6);
  assert.strictEqual(a.std[0], 0);
  const sw2 = Array.from(a.weights).reduce((s, w) => s + w * w, 0);
  near(a.norm, 1 / sw2, 1e-5);
  assert.strictEqual(a.weights.length, 2 * a.radius + 1);
  // the composed model: export scale, then the preview's z
  const m = Film.grainModel(p.radiusMedianPx, p.radiusLogSigma, p.filterSigmaPx).forRenderScale(1.6).forRenderScale(0.5);
  const b = Film.grainSetup(p, 1.6, 0.5);
  near(b.model.filterSigma, m.filterSigma, 1e-12);
  assert.ok(b.std[100] < a.std[100], 'zoomed out: weaker grain');
});

test('quantizeScale: 1/8 octave steps', () => {
  assert.strictEqual(Film.quantizeScale(1), 1);
  near(Film.quantizeScale(1.05), Math.pow(2, 1 / 8), 1e-12);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/film.test.js`
Expected: FAIL — `Film.grainModel is not a function` (and the others).

- [ ] **Step 3: Implement** (add to `film.js` before `return`, and export the names)

```js
  // -- Grain: Wigglecam GrainModel / FastGrain, line for line --------------
  // Boolean model of silver-halide crystals: disks with log-normal radii at
  // Poisson centres, seen through a Gaussian filter (scan blur). Lengths in
  // render pixels.
  const MAX_U = 0.995;
  const QUANTILES = 32;

  // Inverse standard normal CDF (Acklam, |error| < 1.2e-9).
  function inverseNormal(p) {
    const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
    const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
    const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
    const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
    const low = 0.02425;
    if (p < low) {
      const q = Math.sqrt(-2 * Math.log(p));
      return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
    if (p <= 1 - low) {
      const q = p - 0.5, r = q * q;
      return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
    }
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }

  // e^-z I0(z), z >= 0 (Abramowitz & Stegun 9.8.1-9.8.2).
  function i0e(z) {
    if (z <= 3.75) {
      const t = (z / 3.75) * (z / 3.75);
      const i0 = 1 + t * (3.5156229 + t * (3.0899424 + t * (1.2067492 + t * (0.2659732 + t * (0.0360768 + t * 0.0045813)))));
      return i0 * Math.exp(-z);
    }
    const t = 3.75 / z;
    return (0.39894228 + t * (0.01328592 + t * (0.00225319 + t * (-0.00157565 + t * (0.00916281 + t * (-0.02057706 + t * (0.02635537 + t * (-0.01647633 + t * 0.00392377)))))))) / Math.sqrt(z);
  }

  // Overlap area of two disks of radius r whose centres are d apart.
  function lensArea(r, d) {
    if (d >= 2 * r) return 0;
    return 2 * r * r * Math.acos(d / (2 * r)) - d / 2 * Math.sqrt(4 * r * r - d * d);
  }

  function grainModel(radiusMedian, radiusLogSigma, filterSigma) {
    const meanArea = Math.PI * radiusMedian * radiusMedian * Math.exp(2 * radiusLogSigma * radiusLogSigma);
    const maxRadius = radiusMedian * Math.exp(2.5 * radiusLogSigma);
    const radii = Array.from({ length: QUANTILES }, (_, i) => radiusMedian * Math.exp(radiusLogSigma * inverseNormal((i + 0.5) / QUANTILES)));
    const rMax = Math.max(...radii);
    const lambda = (u) => -Math.log(1 - Math.min(Math.max(u, 0), MAX_U)) / meanArea;
    function covariance(u, d) {
      if (u <= 0) return 0;
      const q = 1 - Math.min(Math.max(u, 0), MAX_U);
      let overlap = 0;
      for (const r of radii) overlap += lensArea(r, d);
      overlap /= radii.length;
      return q * q * (Math.exp(lambda(u) * overlap) - 1);
    }
    function filteredCovariance(u, delta) {
      if (u <= 0) return 0;
      const upper = 2 * rMax, n = 400, h = upper / n, s2 = filterSigma * filterSigma;
      const f = (r) => covariance(u, r) * Math.exp(-(r - delta) * (r - delta) / (4 * s2)) * i0e(r * delta / (2 * s2)) * r / (2 * s2);
      let sum = f(0) + f(upper);
      for (let i = 1; i < n; i++) sum += (i % 2 === 1 ? 4 : 2) * f(i * h);
      return sum * h / 3;
    }
    const filteredVariance = (u) => filteredCovariance(u, 0);
    function lagOneCorrelation(u = 0.5) {
      const v = filteredCovariance(u, 0);
      return v <= 0 ? 0 : filteredCovariance(u, 1) / v;
    }
    const forRenderScale = (s) => grainModel(radiusMedian * s, radiusLogSigma,
      Math.sqrt(filterSigma * filterSigma * s * s + Math.max(0, 1 - s * s) / 12));
    return { radiusMedian, radiusLogSigma, filterSigma, meanArea, maxRadius, lambda, covariance,
      filteredCovariance, filteredVariance, lagOneCorrelation, forRenderScale };
  }

  // Separable kernels in the shader loop at most this many taps each side.
  const MAX_KERNEL_RADIUS = 31;
  function gaussianKernel(sigma) {
    const r = Math.min(MAX_KERNEL_RADIUS, Math.max(1, Math.ceil(3 * sigma)));
    const k = new Float64Array(2 * r + 1);
    let sum = 0;
    for (let i = 0; i < k.length; i++) { k[i] = Math.exp(-((i - r) * (i - r)) / (2 * sigma * sigma)); sum += k[i]; }
    for (let i = 0; i < k.length; i++) k[i] /= sum;
    return k;
  }
  function kernelLagOne(sigma) {
    const k = gaussianKernel(sigma);
    let num = 0, den = 0;
    for (let i = 0; i < k.length; i++) { den += k[i] * k[i]; if (i < k.length - 1) num += k[i] * k[i + 1]; }
    return num / den;
  }
  function calibrateNoiseSigma(target) {
    let lo = 0.05, hi = 20;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (kernelLagOne(mid) < target) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  const STD_TABLE = 200;
  const quantizeScale = (v) => Math.pow(2, Math.round(8 * Math.log2(v)) / 8);
  // Everything a render needs for one stock's grain at export scale
  // `scaleExport` seen at `z` screen px per export px (1 for the export).
  // Building one costs tens of ms, so they are cached.
  const setupCache = new Map();
  function grainSetup(p, scaleExport, z) {
    const key = [p.radiusMedianPx, p.radiusLogSigma, p.filterSigmaPx, scaleExport, z].join('|');
    if (setupCache.has(key)) return setupCache.get(key);
    let model = grainModel(p.radiusMedianPx, p.radiusLogSigma, p.filterSigmaPx).forRenderScale(scaleExport);
    if (z !== 1) model = model.forRenderScale(z);
    const sigma = calibrateNoiseSigma(model.lagOneCorrelation());
    const k = gaussianKernel(sigma);
    let sw2 = 0;
    for (const w of k) sw2 += w * w;
    const std = new Float32Array(STD_TABLE + 1);
    for (let i = 0; i <= STD_TABLE; i++) std[i] = Math.sqrt(Math.max(0, model.filteredVariance(i / STD_TABLE)));
    const setup = { model, sigma, radius: (k.length - 1) / 2, weights: Float32Array.from(k), norm: 1 / sw2, std };
    if (setupCache.size > 16) setupCache.delete(setupCache.keys().next().value);
    setupCache.set(key, setup);
    return setup;
  }
```

Add to the returned object: `inverseNormal, i0e, grainModel, gaussianKernel, kernelLagOne, calibrateNoiseSigma, MAX_KERNEL_RADIUS, STD_TABLE, grainSetup, quantizeScale`.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/film.test.js`
Expected: PASS.

- [ ] **Step 5: Commit** (only if asked) — `feat(film): grain model, kernels and setups ported from Wigglecam`

---

### Task 3: film.js — params and the JS reference renderer

**Files:**
- Modify: `film.js`
- Test: `test/film.test.js`

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces:
  - `Film.active(state) → bool` — `state.film && state.film.stock !== 'off' && !state.dngOutput && !state.gainOut` and the stock exists.
  - `Film.gaugeOf(id)`, `Film.stockOf(id)`.
  - `Film.renderScale(D, gaugeId) = D / REF_SHORT_PX * REF_SHORT_MM / short`.
  - `Film.halationRadius(D, gaugeId) = HALATION.RADIUS * D * REF_SHORT_MM / short`.
  - `Film.params(state, frame) → {stock, fit, grain: setup, amount, halation, haloR, seeds:[3], bw}` where `frame = {D, z, px, py}` (circle diameter in export px; screen px per export px; top-left of the export in target px). Uses `quantizeScale` on the export scale and on z.
  - `Film.haloFactor(R) → f` = `R <= 8 ? 1 : min(64, 2^ceil(log2(R/8)))` (64 = the halo-down shader's loop bound; beyond it — only far-zoomed Super 8 previews — the blur kernel is truncated at its 31-tap cap, a ledgered approximation).
  - `Film.reference(src, W, H, params, frame) → Uint8ClampedArray` — `src` is RGBA8 **top-down** (ImageData order), output RGBA8 top-down; does exactly what the GPU does (halo field in GL y-up, noise on the export lattice, clamp-edge blurs, apply).
  - `Film.referenceBands(src, W, H, params, frame, bandRows)` — the same but computing the noise per band with margins (as the GPU does), to prove bands join seamlessly.

GPU conventions this reference fixes (Task 5/6 must match):
- Noise for target pixel (x, r) (r top-origin): `ex = floor((x + 0.5 - px) / z)`, `ey = floor((r + 0.5 - py) / z)`; layer l noise `gaussian(hash4(ex, ey, seeds[l], 0x3C6EF372))`; B&W uses layer 0's noise for all three.
- Noise blur: X then Y, kernel `grain.weights`, edge texels clamped to the band texture (bands carry margin = `grain.radius` rows above and below, clamped to the image).
- Halo: `Y = 0.2126 r + 0.7152 g + 0.0722 b` of linear; `h = smoothstep(0.75, 1, Y) * Y`; box-average f×f source texels in GL y-up (texel (i, j) covers GL x ∈ [i f, i f + f), GL y ∈ [j f, j f + f), clamped to the image), size `ceil(W/f) × ceil(H/f)`; blur X then Y with `gaussianKernel(R / f)` clamped at edges; sampled bilinearly (GL `texture()` rules, clamp-to-edge) at halo coords `((x + 0.5) / f, (H - r - 0.5) / f)`.
- Apply: `lin = srgbDecode(src)`; if `haloR > 0 && halation > 0`, `lin += halation * 0.6 * halo * TINT`; `u = curvePixel(lin)`; `u_l = clamp(u_l + amount * norm * std[round(clamp(u_l,0,1) * 200)] * n_l, 0, 1)`; `rgb = clamp(crosstalk · u, 0, 1)`; output `round(rgb * 255)`.

- [ ] **Step 1: Write the failing tests** (append)

```js
const frame35 = { D: 3060, z: 1, px: 0, py: 0 };
const st = (film, name) => ({ film: Object.assign({ stock: 'golden200', gauge: '35', grain: 1, halation: 0.5 }, film), sourceName: name || 'a.insp' });

test('active: off, unknown stock, DNG and gain-map renders are not filmed', () => {
  assert.strictEqual(Film.active(st({ stock: 'off' })), false);
  assert.strictEqual(Film.active(st({ stock: 'nope' })), false);
  assert.strictEqual(Film.active(Object.assign(st({}), { dngOutput: true })), false);
  assert.strictEqual(Film.active(Object.assign(st({}), { gainOut: true })), false);
  assert.strictEqual(Film.active({}), false);
  assert.strictEqual(Film.active(st({})), true);
});

test('gauge scale: 35 mm at the reference is 1; Super 16 3.24x, Super 8 5.99x, 120 0.43x', () => {
  near(Film.renderScale(3060, '35'), 1, 1e-12);
  near(Film.renderScale(3060, 's16'), 24 / 7.41, 1e-12);
  near(Film.renderScale(3060, 's8'), 24 / 4.01, 1e-12);
  near(Film.renderScale(3060, '120'), 24 / 56, 1e-12);
  near(Film.renderScale(5100, '35'), 5100 / 3060, 1e-12);
  near(Film.halationRadius(5100, '35'), 0.008 * 5100, 1e-12);
  near(Film.halationRadius(5100, 's16'), 0.008 * 5100 * 24 / 7.41, 1e-12);
});

test('params: Super 16 grain coarser than 35 mm; preview z scales the halo radius', () => {
  const a = Film.params(st({ gauge: '35' }), { D: 5100, z: 1, px: 0, py: 0 });
  const b = Film.params(st({ gauge: 's16' }), { D: 5100, z: 1, px: 0, py: 0 });
  assert.ok(b.grain.sigma > a.grain.sigma * 2);
  const c = Film.params(st({ gauge: '35' }), { D: 5100, z: 0.25, px: 0, py: 0 });
  near(c.haloR, a.haloR * 0.25, 1e-9);
  assert.deepStrictEqual(a.seeds, Film.layerSeeds(Film.seedOf('a.insp')));
});

function flat(W, H, v) {
  const a = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) { a[i * 4] = v[0]; a[i * 4 + 1] = v[1]; a[i * 4 + 2] = v[2]; a[i * 4 + 3] = 255; }
  return a;
}

test('haloFactor: sigma at most 8 texels, factor capped at 64', () => {
  assert.strictEqual(Film.haloFactor(5), 1);
  assert.strictEqual(Film.haloFactor(41), 8);
  assert.strictEqual(Film.haloFactor(5000), 64);
});

test('reference: no grain, no halation, B&W on mid-grey gives mid-grey', () => {
  const p = Film.params(st({ stock: 'classic400bw', grain: 0, halation: 0 }), frame35);
  const g = Math.round(Film.MID_OUT * 255);
  const out = Film.reference(flat(8, 8, [g, g, g]), 8, 8, p, frame35);
  for (let i = 0; i < 64; i++) assert.ok(Math.abs(out[i * 4] - g) <= 1 && out[i * 4] === out[i * 4 + 2]);
});

test('reference grain statistics match the model (std within 8%, lag-1 within 0.05)', () => {
  const p = Film.params(st({ stock: 'smooth400bw', gauge: 's16', halation: 0 }), frame35);
  const W = 192, H = 192, g = 118;
  const out = Film.reference(flat(W, H, [g, g, g]), W, H, p, frame35);
  const base = Film.reference(flat(W, H, [g, g, g]), W, H, Object.assign({}, p, { amount: 0 }), frame35);
  let s2 = 0, lag = 0, n = 0, nl = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = (out[(y * W + x) * 4] - base[(y * W + x) * 4]) / 255;
      s2 += d * d; n++;
      if (x + 1 < W) { lag += d * (out[(y * W + x + 1) * 4] - base[(y * W + x + 1) * 4]) / 255; nl++; }
    }
  }
  const u0 = base[0] / 255;
  const want = p.grain.std[Math.round(u0 * 200)];
  near(Math.sqrt(s2 / n), want, 0.08 * want, 'std');
  near((lag / nl) / (s2 / n), p.grain.model.lagOneCorrelation(), 0.05, 'lag-1');
});

test('reference: B&W grain is monochrome, colour grain is not', () => {
  const bw = Film.reference(flat(16, 16, [120, 120, 120]), 16, 16, Film.params(st({ stock: 'classic400bw', halation: 0 }), frame35), frame35);
  for (let i = 0; i < 256; i++) assert.ok(bw[i * 4] === bw[i * 4 + 1] && bw[i * 4 + 1] === bw[i * 4 + 2]);
  const c = Film.reference(flat(16, 16, [120, 120, 120]), 16, 16, Film.params(st({ halation: 0 }), frame35), frame35);
  let differ = 0;
  for (let i = 0; i < 256; i++) if (c[i * 4] !== c[i * 4 + 2]) differ++;
  assert.ok(differ > 50);
});

test('reference: grain is anchored to the export lattice (pan-stable)', () => {
  const W = 40, H = 30, p = Film.params(st({ halation: 0 }), frame35);
  const src = flat(W, H, [120, 120, 120]);
  const a = Film.reference(src, W, H, p, { D: 3060, z: 1, px: 0, py: 0 });
  const b = Film.reference(src, W, H, p, { D: 3060, z: 1, px: -5, py: -3 });   // the view moved 5 px right, 3 down
  // target pixel (x, y) in b shows export pixel (x+5, y+3), as a's (x+5, y+3): equal away from blur edges
  for (let y = 8; y < 18; y++) for (let x = 8; x < 25; x++) {
    assert.strictEqual(b[(y * W + x) * 4], a[((y + 3) * W + x + 5) * 4]);
  }
});

test('reference: halation adds red-orange glow around a bright patch, nothing far away', () => {
  const W = 64, H = 64, src = flat(W, H, [60, 60, 60]);
  for (let y = 28; y < 36; y++) for (let x = 28; x < 36; x++) src.set([255, 255, 255, 255], (y * W + x) * 4);
  const frame = { D: 600, z: 1, px: 0, py: 0 };   // R = 0.008 * 600 = 4.8 px on 35 mm
  const p = Film.params(st({ grain: 0, halation: 1 }), frame);
  const p0 = Film.params(st({ grain: 0, halation: 0 }), frame);
  const on = Film.reference(src, W, H, p, frame), off = Film.reference(src, W, H, p0, frame);
  const at = (a, x, y, c) => a[(y * W + x) * 4 + c];
  assert.ok(at(on, 39, 32, 0) - at(off, 39, 32, 0) >= 8, 'red glow next to it');
  assert.ok(at(on, 39, 32, 0) - at(off, 39, 32, 0) > at(on, 39, 32, 2) - at(off, 39, 32, 2), 'redder than blue');
  assert.strictEqual(at(on, 2, 2, 0), at(off, 2, 2, 0), 'nothing far away');
});

test('referenceBands joins bands seamlessly (equals the whole-image reference)', () => {
  const W = 50, H = 70, src = flat(W, H, [140, 110, 90]);
  const frame = { D: 3060, z: 1, px: 0, py: 0 };
  const p = Film.params(st({ gauge: 's8', halation: 0.7 }), frame);
  const whole = Film.reference(src, W, H, p, frame);
  const banded = Film.referenceBands(src, W, H, p, frame, 16);
  assert.deepStrictEqual(Array.from(banded), Array.from(whole));
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/film.test.js`
Expected: FAIL — `Film.active is not a function`.

- [ ] **Step 3: Implement** (add to `film.js`, export the names)

```js
  // -- Per-render parameters ----------------------------------------------
  const stockOf = (id) => STOCKS.find((s) => s.id === id) || null;
  const gaugeOf = (id) => GAUGES.find((g) => g.id === id) || GAUGES[2];
  function active(state) {
    return !!(state && state.film && state.film.stock !== 'off' && stockOf(state.film.stock)
      && !state.dngOutput && !state.gainOut);
  }
  const renderScale = (D, gauge) => D / REF_SHORT_PX * REF_SHORT_MM / gaugeOf(gauge).short;
  const halationRadius = (D, gauge) => HALATION.RADIUS * D * REF_SHORT_MM / gaugeOf(gauge).short;

  // frame: {D: circle diameter in export px, z: target px per export px,
  // px, py: where export pixel (0, 0)'s corner sits in the target (top-left
  // origin)}. The export: {D, z: 1, px: 0, py: 0}.
  function params(state, frame) {
    const f = state.film, stock = stockOf(f.stock);
    const z = frame.z === 1 ? 1 : quantizeScale(frame.z);
    return {
      stock, fit: fitCurve(stock),
      grain: grainSetup(stock.grain, quantizeScale(renderScale(frame.D, f.gauge)), z),
      amount: f.grain, halation: f.halation,
      haloR: halationRadius(frame.D, f.gauge) * frame.z,
      seeds: layerSeeds(seedOf(state.sourceName || '')), bw: stock.bw,
    };
  }

  // The halation field's downsample factor: blur sigma R/f at most 8 texels.
  const haloFactor = (R) => (R <= 8 ? 1 : Math.min(64, Math.pow(2, Math.ceil(Math.log2(R / 8)))));

  // -- The JS reference renderer (what the GPU passes do) -----------------
  const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const clamp01 = (v) => Math.min(1, Math.max(0, v));

  // Separable clamp-edge blur of a w x h single-channel field.
  function blur1(src, w, h, k, horizontal) {
    const r = (k.length - 1) / 2, out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let i = -r; i <= r; i++) {
          const xx = horizontal ? Math.min(w - 1, Math.max(0, x + i)) : x;
          const yy = horizontal ? y : Math.min(h - 1, Math.max(0, y + i));
          s += k[i + r] * src[yy * w + xx];
        }
        out[y * w + x] = s;
      }
    }
    return out;
  }

  // The halation field, GL y-up (row 0 = the image's bottom row).
  function haloField(src, W, H, R) {
    const f = haloFactor(R), w = Math.ceil(W / f), h = Math.ceil(H / f);
    const d = new Float32Array(w * h);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        let s = 0;
        for (let b = 0; b < f; b++) {
          for (let a = 0; a < f; a++) {
            const x = Math.min(W - 1, i * f + a), glY = Math.min(H - 1, j * f + b);
            const o = ((H - 1 - glY) * W + x) * 4;
            const Y = 0.2126 * srgbDecode(src[o] / 255) + 0.7152 * srgbDecode(src[o + 1] / 255) + 0.0722 * srgbDecode(src[o + 2] / 255);
            s += smoothstep(HALATION.LO, HALATION.HI, Y) * Y;
          }
        }
        d[j * w + i] = s / (f * f);
      }
    }
    const k = gaussianKernel(R / f);
    return { f, w, h, data: blur1(blur1(d, w, h, k, true), w, h, k, false) };
  }
  // GL texture() bilinear, clamp-to-edge, at halo-texel coords (hx, hy).
  function sampleHalo(hf, hx, hy) {
    const fx = hx - 0.5, fy = hy - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    const at = (x, y) => hf.data[Math.min(hf.h - 1, Math.max(0, y)) * hf.w + Math.min(hf.w - 1, Math.max(0, x))];
    return (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty;
  }

  // Blurred noise for target rows [top, top + rows) (top-origin), each layer
  // a separate field; B&W: layer 0 only.
  function noiseBand(W, H, top, rows, p, frame) {
    const r = p.grain.radius, t0 = Math.max(0, top - r), t1 = Math.min(H, top + rows + r), h = t1 - t0;
    const layers = p.bw ? 1 : 3, out = [];
    for (let l = 0; l < layers; l++) {
      const n = new Float32Array(W * h);
      for (let j = 0; j < h; j++) {
        const ey = Math.floor((t0 + j + 0.5 - frame.py) / frame.z);
        for (let x = 0; x < W; x++) {
          const ex = Math.floor((x + 0.5 - frame.px) / frame.z);
          n[j * W + x] = gaussian(hash4(ex, ey, p.seeds[l], 0x3C6EF372));
        }
      }
      const b = blur1(blur1(n, W, h, p.grain.weights, true), W, h, p.grain.weights, false);
      out.push(b.subarray((top - t0) * W, (top - t0 + rows) * W));
    }
    return p.bw ? [out[0], out[0], out[0]] : out;
  }

  function applyRows(src, W, H, p, top, rows, noise, hf, dst) {
    const m = p.stock.crosstalk, k = p.amount * p.grain.norm;
    for (let j = 0; j < rows; j++) {
      const r = top + j;
      for (let x = 0; x < W; x++) {
        const o = (r * W + x) * 4;
        const lin = [srgbDecode(src[o] / 255), srgbDecode(src[o + 1] / 255), srgbDecode(src[o + 2] / 255)];
        if (hf) {
          const h = sampleHalo(hf, (x + 0.5) / hf.f, (H - r - 0.5) / hf.f) * p.halation * HALATION.GAIN;
          for (let c = 0; c < 3; c++) lin[c] += h * HALATION.TINT[c];
        }
        const u = curvePixel(lin, p.stock, p.fit);
        for (let c = 0; c < 3; c++) {
          const sd = p.grain.std[Math.round(clamp01(u[c]) * STD_TABLE)];
          u[c] = clamp01(u[c] + k * sd * noise[c][j * W + x]);
        }
        for (let c = 0; c < 3; c++) {
          dst[o + c] = Math.round(clamp01(m[c * 3] * u[0] + m[c * 3 + 1] * u[1] + m[c * 3 + 2] * u[2]) * 255);
        }
        dst[o + 3] = 255;
      }
    }
  }

  const haloOf = (src, W, H, p) => (p.haloR > 0 && p.halation > 0 ? haloField(src, W, H, p.haloR) : null);

  function reference(src, W, H, p, frame) {
    const dst = new Uint8ClampedArray(W * H * 4);
    applyRows(src, W, H, p, 0, H, noiseBand(W, H, 0, H, p, frame), haloOf(src, W, H, p), dst);
    return dst;
  }
  function referenceBands(src, W, H, p, frame, bandRows) {
    const dst = new Uint8ClampedArray(W * H * 4), hf = haloOf(src, W, H, p);
    for (let top = 0; top < H; top += bandRows) {
      const rows = Math.min(bandRows, H - top);
      applyRows(src, W, H, p, top, rows, noiseBand(W, H, top, rows, p, frame), hf, dst);
    }
    return dst;
  }
```

Note on the blur at the image's real top/bottom edge: `noiseBand` clamps rows `t0..t1` to the image and the blur clamps at the band texture's edge, so the first/last `r` rows of the image see clamped noise; a band in the middle has full margins. `referenceBands` therefore equals `reference` exactly (same clamping at the real edges, full context elsewhere) — the seam test proves it.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/film.test.js`
Expected: PASS. (The stats test renders 192²; it may take a few seconds.)

- [ ] **Step 5: Commit** (only if asked) — `feat(film): render parameters and the JS reference renderer`

---

### Task 4: Settings, state, paste, panel

**Files:**
- Modify: `settings.js`, `app.js` (state default only), `test/settings.test.js`, `test/ui-settings.test.js`, `test/photos.test.js`

**Interfaces:**
- Produces: `state.film = {stock: 'off', gauge: '35', grain: 1, halation: 0.5}`; `Settings.ENUMS.stock` (`['off', ...Film stock ids]`), `Settings.ENUMS.gauge` (`['s8','s16','35','120']`); `Settings.RANGES.film = {grain: [0, 2], halation: [0, 1]}`; `'film'` in `PERSISTED_KEYS`; `'film'` in `PANEL_SECTIONS` right after `'detail'`, `DEFAULT_PANELS.film = true`.

- [ ] **Step 1: Write the failing tests**

`test/settings.test.js` (append; it already requires Settings — reuse its `require`):

```js
test('film settings: persisted, enums and ranges validated', () => {
  const defaults = { film: { stock: 'off', gauge: '35', grain: 1, halation: 0.5 } };
  assert.ok(Settings.PERSISTED_KEYS.includes('film'));
  const ok = Settings.sanitize(defaults, { film: { stock: 'portrait160', gauge: 's16', grain: 1.5, halation: 0.2 } });
  assert.deepStrictEqual(ok.film, { stock: 'portrait160', gauge: 's16', grain: 1.5, halation: 0.2 });
  const bad = Settings.sanitize(defaults, { film: { stock: 'kodak', gauge: '70', grain: 9, halation: -1 } });
  assert.deepStrictEqual(bad.film, { stock: 'off', gauge: '35', grain: 2, halation: 0 });
  assert.deepStrictEqual(Settings.ENUMS.stock, ['off', 'golden200', 'verdant400', 'portrait160', 'classic400bw', 'smooth400bw']);
  assert.deepStrictEqual(Settings.ENUMS.gauge, ['s8', 's16', '35', '120']);
});
```

`test/ui-settings.test.js` (append):

```js
test('the Film panel sits after Detail and starts open', () => {
  const i = Settings.PANEL_SECTIONS.indexOf('film');
  assert.strictEqual(Settings.PANEL_SECTIONS[i - 1], 'detail');
  assert.strictEqual(Settings.DEFAULT_PANELS.film, true);
});
```

`test/photos.test.js` (append):

```js
test('pasting edits carries the film settings', () => {
  const out = Photos.pasteable({ film: { stock: 'golden200', gauge: 's16', grain: 1, halation: 0.5 }, sun: { on: true } });
  assert.deepStrictEqual(out.film, { stock: 'golden200', gauge: 's16', grain: 1, halation: 0.5 });
  assert.ok(!('sun' in out));
});
```

If an existing ui-settings test requires every `PANEL_SECTIONS` entry to have a `data-panel` element in index.html, add the Film panel's `<details class="sec" data-panel="film" open><summary>Film</summary><div class="body"></div></details>` skeleton now (Task 7 fills it).

- [ ] **Step 2: Run to verify they fail**

Run: `npm test 2>&1 | tail -30`
Expected: the two settings tests FAIL (`film` not persisted / no `film` panel); the photos test passes already (pasteable copies any non-skipped key) — it pins the behaviour.

- [ ] **Step 3: Implement**

`settings.js`:
- `PERSISTED_KEYS`: append `'film'` after `'sun'`.
- `PANEL_SECTIONS`: `[..., 'tone', 'detail', 'film', 'output']`; `DEFAULT_PANELS`: add `film: true`.
- `ENUMS`: add (settings.js loads without Film, so the ids are listed here; the test above pins them to Film.STOCKS order):
  ```js
    // Film simulation (film.js): the stock ('off' first) and the gauge.
    stock: ['off', 'golden200', 'verdant400', 'portrait160', 'classic400bw', 'smooth400bw'],
    gauge: ['s8', 's16', '35', '120'],
  ```
- `RANGES`: add `film: { grain: [0, 2], halation: [0, 1] },` with the comment `// Film simulation: Grain 0-200 %, Halation 0-100.`

Also add to `test/film.test.js`:

```js
test('Settings.ENUMS.stock lists Off then Film.STOCKS in order', () => {
  const Settings = require('../settings.js');
  assert.deepStrictEqual(Settings.ENUMS.stock, ['off'].concat(Film.STOCKS.map((s) => s.id)));
  assert.deepStrictEqual(Settings.ENUMS.gauge, Film.GAUGES.map((g) => g.id));
});
```

`app.js` state (after the `sun:` entry, same comment style):

```js
    // Film simulation (film.js, spec 2026-10-03-film-simulation-design.md):
    // an edit of each photo, pasted with the rest. stock 'off' skips the
    // film pass entirely.
    film: { stock: 'off', gauge: '35', grain: 1, halation: 0.5 },
```

- [ ] **Step 4: Run to verify they pass**

Run: `npm test 2>&1 | tail -15`
Expected: all pass (previous 511 + new).

- [ ] **Step 5: Commit** (only if asked) — `feat(film): film settings, persisted and pasted`

---

### Task 5: Shaders

**Files:**
- Modify: `shaders.js`
- Test: `test/gl.test.js` (static shader checks; it already requires `../shaders.js`)

**Interfaces:**
- Produces: `Shaders.FILM_GLSL` (pcg, hash4, gaussian, film decode), `Shaders.FILM_HALO_DOWN_FS`, `Shaders.FILM_BLUR_FS`, `Shaders.FILM_NOISE_FS`, `Shaders.FILM_APPLY_FS`. Uniforms below are the contract Task 6 sets.

- [ ] **Step 1: Write the failing tests** (append to `test/gl.test.js`; use its existing `Shaders` require, add `const Film = require('../film.js');` if absent)

```js
test('film shaders: the PCG constants and the shared GLSL are in every film pass', () => {
  assert.match(Shaders.FILM_GLSL, /747796405u/);
  assert.match(Shaders.FILM_GLSL, /2891336453u/);
  assert.match(Shaders.FILM_GLSL, /277803737u/);
  assert.match(Shaders.FILM_GLSL, /16777216\.0/);
  for (const k of ['FILM_NOISE_FS', 'FILM_APPLY_FS']) assert.ok(Shaders[k].includes(Shaders.FILM_GLSL), k);
  for (const k of ['FILM_HALO_DOWN_FS', 'FILM_BLUR_FS', 'FILM_NOISE_FS', 'FILM_APPLY_FS']) {
    assert.match(Shaders[k], /^#version 300 es/, k);
  }
  // the blur loop bound is Film.MAX_KERNEL_RADIUS
  assert.ok(Shaders.FILM_BLUR_FS.includes('k <= ' + Film.MAX_KERNEL_RADIUS));
  // halation constants match film.js
  assert.ok(Shaders.FILM_APPLY_FS.includes('vec3(1.0, 0.28, 0.05)'));
  assert.ok(Shaders.FILM_HALO_DOWN_FS.includes('smoothstep(0.75, 1.0'));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/gl.test.js`
Expected: FAIL — `Shaders.FILM_GLSL` undefined.

- [ ] **Step 3: Implement** (in `shaders.js`, near the other shader strings; add all five to the exported object)

```js
  // -- Film simulation (film.js; spec 2026-10-03-film-simulation-design.md) --
  // The PCG hash and Box-Muller exactly as Film.pcg / Film.gaussian (32-bit
  // uint ops wrap like Kotlin's Int; 24-bit uniforms keep fp32 below 1).
  const FILM_GLSL = `
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
  float filmDecode1(float v) { return v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4); }
  vec3 filmDecode(vec3 c) { return vec3(filmDecode1(c.r), filmDecode1(c.g), filmDecode1(c.b)); }
  `;

  // Halation source, box-averaged f x f (GL y-up, clamped at the edges).
  const FILM_HALO_DOWN_FS = `#version 300 es
  precision highp float;
  uniform sampler2D uSrc;
  uniform int uF;
  uniform ivec2 uSrcSize;
  out vec4 fragColor;
  float filmDecode1(float v) { return v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4); }
  void main() {
    ivec2 o = ivec2(gl_FragCoord.xy) * uF;
    float s = 0.0;
    for (int b = 0; b < 64; b++) {
      if (b >= uF) break;
      for (int a = 0; a < 64; a++) {
        if (a >= uF) break;
        vec3 c = texelFetch(uSrc, min(o + ivec2(a, b), uSrcSize - 1), 0).rgb;
        float y = 0.2126 * filmDecode1(c.r) + 0.7152 * filmDecode1(c.g) + 0.0722 * filmDecode1(c.b);
        s += smoothstep(0.75, 1.0, y) * y;
      }
    }
    fragColor = vec4(s / float(uF * uF), 0.0, 0.0, 1.0);
  }`;

  // Separable Gaussian, clamp-edge (halation field and grain noise).
  // Weights computed here as in Film.gaussianKernel (same sigma, radius).
  const FILM_BLUR_FS = `#version 300 es
  precision highp float;
  uniform sampler2D uSrc;
  uniform ivec2 uDir;
  uniform int uR;
  uniform float uSigma;
  uniform ivec2 uSize;
  out vec4 fragColor;
  void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec4 acc = vec4(0.0);
    float wsum = 0.0;
    for (int k = -31; k <= 31; k++) {
      if (k < -uR || k > uR) continue;
      float w = exp(-float(k * k) / (2.0 * uSigma * uSigma));
      acc += w * texelFetch(uSrc, clamp(p + uDir * k, ivec2(0), uSize - 1), 0);
      wsum += w;
    }
    fragColor = acc / wsum;
  }`;

  // Unit white noise per layer on the export-pixel lattice. Band textures
  // are top-origin: texel row j is target row uTop + j.
  const FILM_NOISE_FS = `#version 300 es
  precision highp float;
  precision highp int;
  uniform int uTop;
  uniform vec2 uOrigin;   // export pixel (0,0)'s corner in target px (top-left origin)
  uniform float uZ;       // target px per export px
  uniform uvec3 uSeeds;
  uniform float uBw;
  out vec4 fragColor;
  ${FILM_GLSL}
  void main() {
    vec2 t = vec2(gl_FragCoord.x, float(uTop) + floor(gl_FragCoord.y) + 0.5);
    ivec2 e = ivec2(floor((t - uOrigin) / uZ));
    uint ex = uint(e.x), ey = uint(e.y);
    float r = filmGauss(hash4(ex, ey, uSeeds.x, 0x3C6EF372u));
    if (uBw > 0.5) { fragColor = vec4(r, r, r, 1.0); return; }
    float g = filmGauss(hash4(ex, ey, uSeeds.y, 0x3C6EF372u));
    float b = filmGauss(hash4(ex, ey, uSeeds.z, 0x3C6EF372u));
    fragColor = vec4(r, g, b, 1.0);
  }`;

  // The film itself: halation, stock curve re-centred on the edit, grain
  // per layer, crosstalk. Output rows: target rows uBandY0 .. +uBandRows,
  // the band's top row at the top of the viewport.
  const FILM_APPLY_FS = `#version 300 es
  precision highp float;
  precision highp int;
  uniform sampler2D uSrc;       // the composed image (GL y-up), uSrcSize
  uniform ivec2 uSrcSize;
  uniform sampler2D uNoise;     // blurred noise band, top-origin rows from uNoiseTop
  uniform int uNoiseTop;
  uniform int uBandY0;
  uniform int uBandRows;
  uniform sampler2D uHalo;      // halation field (LINEAR), uHaloSize texels, factor uHaloF
  uniform vec2 uHaloSize;
  uniform float uHaloF;
  uniform float uHalation;      // 0: no halation (uHalo unused)
  uniform mat3 uSens;
  uniform mat3 uCross;
  uniform vec3 uLogE0;
  uniform vec3 uK;
  uniform vec3 uUMin;
  uniform vec3 uRange;
  uniform vec3 uFit;            // b, s, uMinA
  uniform sampler2D uStd;       // 201 x 1 R32F
  uniform float uGrainK;        // amount * norm
  out vec4 fragColor;
  ${FILM_GLSL}
  float stdOf(float u) { return texelFetch(uStd, ivec2(int(clamp(u, 0.0, 1.0) * 200.0 + 0.5), 0), 0).r; }
  void main() {
    int x = int(gl_FragCoord.x);
    int r = uBandY0 + uBandRows - 1 - int(gl_FragCoord.y);
    vec3 lin = filmDecode(texelFetch(uSrc, ivec2(x, uSrcSize.y - 1 - r), 0).rgb);
    if (uHalation > 0.0) {
      vec2 hc = vec2(float(x) + 0.5, float(uSrcSize.y - r) - 0.5) / uHaloF;
      lin += uHalation * 0.6 * texture(uHalo, hc / uHaloSize).r * vec3(1.0, 0.28, 0.05);
    }
    vec3 e = uSens * lin;
    vec3 logE = log(max(e, vec3(1e-5))) / log(10.0) + uFit.x;
    vec3 u = uUMin + uRange / (1.0 + exp(-uK * (logE - uLogE0)));
    u = uFit.z + uFit.y * (u - uFit.z);
    vec3 n = texelFetch(uNoise, ivec2(x, r - uNoiseTop), 0).rgb;
    u = clamp(u + uGrainK * vec3(stdOf(u.r), stdOf(u.g), stdOf(u.b)) * n, 0.0, 1.0);
    fragColor = vec4(clamp(uCross * u, 0.0, 1.0), 1.0);
  }`;
```

(Uniform matrices are uploaded row-major with `transpose = true`, as `uJpegWb` already is.)

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/gl.test.js`
Expected: PASS.

- [ ] **Step 5: Commit** (only if asked) — `feat(film): GLSL passes for halation, noise, blur and the film apply`

---

### Task 6: gl.js — film passes, preview and banded export

**Files:**
- Modify: `gl.js`
- Test: `test/gl.test.js`

**Interfaces:**
- Consumes: `Film.params`, `Film.haloFactor`, `Film.HALATION`, Task 5 shaders.
- Produces:
  - `GL.filmFrame(state, targetW, targetH, place) → {D, z, px, py}` — D from `compositionLayout(state, g.width, g.height)` with `g = exportGeometry(state)`; with `place`: `z = place.w / g.width`, `(px, py) = (place.x, place.y)`; without: the composition fitted into the target as `compositionLayout` does (`z = min(targetW / g.width, targetH / g.height)`, centred offsets) — for the export target that is z 1 at (0, 0).
  - `GL.renderFilmed(ctx, state, W, H, place)` — preview: composition into `ctx.film.src` (W×H RGBA8), then the film into the default framebuffer.
  - `GL.filmStrips(ctx, state, src {tex, w, h}, frame, stripRows, onStrip)` — export/print/parity: halo once, then per band render into a band target and read it back top-down via `readCompositionStrips`; `onStrip(rowsRGBA, outY, rows)` same contract as `readCompositionStrips`.
  - `GL.filmBandsWith(ctx, params, src, frame, stripRows, onStrip)` — the same with explicit params (parity check uses it).
  - `GL.releaseFilm(ctx)`.

- [ ] **Step 1: Write the failing test** (`test/gl.test.js`)

```js
test('filmFrame: export is z 1 at the origin; the preview place gives z and offset', () => {
  const s = { fovDeg: 180, thetaMaxDeg: 105, sensors: 'both', orientation: 'side', gapFrac: 0, marginFrac: 0,
    sourceLensSize: 5952, uploadedLensSize: 5952, padToSensorSquare: false };
  const g = GL.exportGeometry(s);
  const f = GL.filmFrame(s, g.width, g.height, null);
  assert.strictEqual(f.z, 1);
  assert.deepStrictEqual([f.px, f.py], [0, 0]);
  assert.ok(Math.abs(f.D - g.height) < 1, 'side by side at gap/margin 0: D = height');
  const p = GL.filmFrame(s, 800, 600, { x: -100, y: 20, w: g.width / 4, h: g.height / 4 });
  assert.strictEqual(p.z, 0.25);
  assert.deepStrictEqual([p.px, p.py], [-100, 20]);
  assert.strictEqual(p.D, f.D);
  const fit = GL.filmFrame(s, g.width / 2, g.height, null);   // letterboxed: half width, centred vertically
  assert.strictEqual(fit.z, 0.5);
  assert.deepStrictEqual([fit.px, fit.py], [0, g.height / 4]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/gl.test.js`
Expected: FAIL — `GL.filmFrame is not a function`.

- [ ] **Step 3: Implement** (`gl.js`; gl.js's factory gets `Film` from the global/require the same way it gets `Edge`/`SunDetect` — follow the existing UMD header and add `Film` to the dependency list; in `createContext` add the four programs and `film: null`)

In `createContext`'s ctx literal:

```js
      // Film simulation (film.js): the post-pass programs, and its targets
      // (allocated on first use, see ensureFilmTargets).
      filmHaloDown: program(gl, Shaders.FULLSCREEN_VS, Shaders.FILM_HALO_DOWN_FS),
      filmBlur: program(gl, Shaders.FULLSCREEN_VS, Shaders.FILM_BLUR_FS),
      filmNoise: program(gl, Shaders.FULLSCREEN_VS, Shaders.FILM_NOISE_FS),
      filmApply: program(gl, Shaders.FULLSCREEN_VS, Shaders.FILM_APPLY_FS),
      film: null,
```

Then, after `renderComposition`:

```js
  // -- Film simulation (film.js; spec 2026-10-03-film-simulation-design.md) --
  // A post-pass on the composed display image. The halation field is built
  // once for the whole image at low resolution (Film.haloFactor); the grain
  // runs per band of rows (noise, blur X, blur Y, apply), the band textures
  // carrying the blur radius as margin, so an export of any size needs only
  // band-sized temporaries. Noise depends only on the export pixel, so bands
  // join without seams (Film.referenceBands).

  // Where the film's export pixels sit in a target: D the circle diameter
  // in export px, z target px per export px, (px, py) export pixel (0,0)'s
  // corner in the target (top-left origin).
  function filmFrame(state, targetW, targetH, place) {
    const g = exportGeometry(state);
    const c = compositionLayout(state, g.width, g.height).circles[0];
    if (place) return { D: c.radius * 2, z: place.w / g.width, px: place.x, py: place.y };
    // Fitted into the target, centred (compositionLayout's own rule).
    const z = Math.min(targetW / g.width, targetH / g.height);
    return { D: c.radius * 2, z, px: (targetW - g.width * z) / 2, py: (targetH - g.height * z) / 2 };
  }

  function filmTex(gl, w, h, internal, format, type, linear) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const f = linear ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!ok) { gl.deleteTexture(tex); gl.deleteFramebuffer(fbo); throw new Error('FILM_TARGET_INCOMPLETE'); }
    return { tex, fbo, w, h };
  }
  function freeT(gl, t) { if (t) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fbo); } }

  // A named film target of at least w x h, reused while it fits.
  function filmTarget(ctx, name, w, h, kind) {
    const gl = ctx.gl;
    const F = ctx.film || (ctx.film = {});
    const t = F[name];
    if (t && t.w === w && t.h === h) return t;
    freeT(gl, t);
    F[name] = kind === 'rgba8' ? filmTex(gl, w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, false)
      : filmTex(gl, w, h, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, kind === 'linear');
    return F[name];
  }

  function releaseFilm(ctx) {
    if (!ctx.film) return;
    for (const k of Object.keys(ctx.film)) {
      if (k === 'std') ctx.gl.deleteTexture(ctx.film.std.tex);
      else if (k !== 'stdKey') freeT(ctx.gl, ctx.film[k]);
    }
    ctx.film = null;
  }

  function filmPass(ctx, prog, dst, w, h, set) {
    const gl = ctx.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst ? dst.fbo : null);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.BLEND);
    gl.useProgram(prog);
    gl.bindVertexArray(ctx.vao);
    set((n) => gl.getUniformLocation(prog, n));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  function blurPass(ctx, src, dst, w, h, dir, sigma, radius) {
    const gl = ctx.gl;
    filmPass(ctx, ctx.filmBlur, dst, w, h, (u) => {
      bindTex(gl, 0, src.tex);
      gl.uniform1i(u('uSrc'), 0);
      gl.uniform2i(u('uDir'), dir[0], dir[1]);
      gl.uniform1i(u('uR'), radius);
      gl.uniform1f(u('uSigma'), sigma);
      gl.uniform2i(u('uSize'), w, h);
    });
  }

  // The halation field for the whole composed image, or null.
  function buildHalo(ctx, p, src) {
    if (!(p.haloR > 0 && p.halation > 0)) return null;
    const gl = ctx.gl, f = Film.haloFactor(p.haloR);
    const w = Math.ceil(src.w / f), h = Math.ceil(src.h / f);
    const a = filmTarget(ctx, 'haloA', w, h, 'linear'), b = filmTarget(ctx, 'haloB', w, h, 'linear');
    filmPass(ctx, ctx.filmHaloDown, a, w, h, (u) => {
      bindTex(gl, 0, src.tex);
      gl.uniform1i(u('uSrc'), 0);
      gl.uniform1i(u('uF'), f);
      gl.uniform2i(u('uSrcSize'), src.w, src.h);
    });
    const sigma = p.haloR / f, radius = (Film.gaussianKernel(sigma).length - 1) / 2;
    blurPass(ctx, a, b, w, h, [1, 0], sigma, radius);
    blurPass(ctx, b, a, w, h, [0, 1], sigma, radius);
    return { tex: a.tex, f, w, h };
  }

  function stdTexture(ctx, p) {
    const gl = ctx.gl, F = ctx.film;
    if (F.std && F.stdKey === p.grain) return F.std.tex;
    if (F.std) gl.deleteTexture(F.std.tex);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, p.grain.std.length, 1, 0, gl.RED, gl.FLOAT, p.grain.std);
    F.std = { tex };
    F.stdKey = p.grain;
    return tex;
  }

  // Film for target rows [y0, y0 + rows) of `src` into `dst` (null: the
  // default framebuffer, whose height is rows).
  function filmBand(ctx, p, src, frame, halo, y0, rows, dst) {
    const gl = ctx.gl, W = src.w, r = p.grain.radius;
    const t0 = Math.max(0, y0 - r), t1 = Math.min(src.h, y0 + rows + r), h = t1 - t0;
    const na = filmTarget(ctx, 'noiseA', W, h, 'f16'), nb = filmTarget(ctx, 'noiseB', W, h, 'f16');
    filmPass(ctx, ctx.filmNoise, na, W, h, (u) => {
      gl.uniform1i(u('uTop'), t0);
      gl.uniform2f(u('uOrigin'), frame.px, frame.py);
      gl.uniform1f(u('uZ'), frame.z);
      gl.uniform3ui(u('uSeeds'), p.seeds[0] >>> 0, p.seeds[1] >>> 0, p.seeds[2] >>> 0);
      gl.uniform1f(u('uBw'), p.bw ? 1 : 0);
    });
    blurPass(ctx, na, nb, W, h, [1, 0], p.grain.sigma, r);
    blurPass(ctx, nb, na, W, h, [0, 1], p.grain.sigma, r);
    const L = p.stock.layers, fit = p.fit;
    const std = stdTexture(ctx, p);
    filmPass(ctx, ctx.filmApply, dst, W, rows, (u) => {
      bindTex(gl, 0, src.tex); gl.uniform1i(u('uSrc'), 0);
      gl.uniform2i(u('uSrcSize'), src.w, src.h);
      bindTex(gl, 1, na.tex); gl.uniform1i(u('uNoise'), 1);
      gl.uniform1i(u('uNoiseTop'), t0);
      gl.uniform1i(u('uBandY0'), y0);
      gl.uniform1i(u('uBandRows'), rows);
      bindTex(gl, 2, halo ? halo.tex : null); gl.uniform1i(u('uHalo'), 2);
      gl.uniform2f(u('uHaloSize'), halo ? halo.w : 1, halo ? halo.h : 1);
      gl.uniform1f(u('uHaloF'), halo ? halo.f : 1);
      gl.uniform1f(u('uHalation'), halo ? p.halation : 0);
      gl.uniformMatrix3fv(u('uSens'), true, p.stock.sensitivity);
      gl.uniformMatrix3fv(u('uCross'), true, p.stock.crosstalk);
      gl.uniform3fv(u('uLogE0'), L.map((l) => l.logE0));
      gl.uniform3fv(u('uK'), L.map((l) => 4 * l.gamma / (l.uMax - l.uMin)));
      gl.uniform3fv(u('uUMin'), L.map((l) => l.uMin));
      gl.uniform3fv(u('uRange'), L.map((l) => l.uMax - l.uMin));
      gl.uniform3f(u('uFit'), fit.b, fit.s, fit.uMinA);
      bindTex(gl, 3, std); gl.uniform1i(u('uStd'), 3);
      gl.uniform1f(u('uGrainK'), p.amount * p.grain.norm);
    });
  }

  function filmBandsWith(ctx, p, src, frame, stripRows, onStrip) {
    const gl = ctx.gl;
    const halo = buildHalo(ctx, p, src);
    const out = filmTarget(ctx, 'band', src.w, stripRows, 'rgba8');
    for (let y0 = 0; y0 < src.h; y0 += stripRows) {
      const rows = Math.min(stripRows, src.h - y0);
      filmBand(ctx, p, src, frame, halo, y0, rows, out);
      // the band's rows sit at the bottom `rows` GL rows of `out`
      readCompositionStrips(gl, out.fbo, src.w, rows, rows, (rgba, oy, n) => onStrip(rgba, y0 + oy, n));
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  function filmStrips(ctx, state, src, frame, stripRows, onStrip) {
    filmBandsWith(ctx, Film.params(state, frame), src, frame, stripRows, onStrip);
  }

  // The preview with film: the composition into an offscreen texture of
  // the canvas's size, then the film onto the canvas in one band.
  function renderFilmed(ctx, state, W, H, place) {
    const src = filmTarget(ctx, 'src', W, H, 'rgba8');
    renderComposition(ctx, state, W, H, src.fbo, place);
    const frame = filmFrame(state, W, H, place);
    const p = Film.params(state, frame);
    filmBand(ctx, p, { tex: src.tex, w: W, h: H }, frame, buildHalo(ctx, p, { tex: src.tex, w: W, h: H }), 0, H, null);
    ctx.gl.bindFramebuffer(ctx.gl.FRAMEBUFFER, null);
  }
```

Check `readCompositionStrips`'s read origin before relying on it: it reads `glY = h - outY - rows` of an fbo it treats as `h` rows tall. Called with `h = rows`, `stripRows = rows`, it reads GL rows `0..rows-1` — exactly where `filmBand` drew (viewport height `rows`, the band's top row at GL y `rows-1`). If `bindTex` is not a helper visible at this point in gl.js (it is used by the tone-base code above), use the same one; do not add a second.

Add to the exported object: `filmFrame, renderFilmed, filmStrips, filmBandsWith, releaseFilm`.

- [ ] **Step 4: Run to verify it passes**

Run: `npm test 2>&1 | tail -15`
Expected: all pass.

- [ ] **Step 5: Commit** (only if asked) — `feat(film): GPU film pass for the preview and banded export`

---

### Task 7: app.js + index.html — Film panel, preview, export, print, parity check

**Files:**
- Modify: `app.js`, `index.html`

**Interfaces:**
- Consumes: Task 4 state/settings, Task 6 GL API, `Film.STOCKS`, `Film.GAUGES`.
- Produces: `App.checkFilmParity() → {maxDiff, over2, cases}`.

- [ ] **Step 1: index.html**

Script tag: `<script src="film.js"></script>` immediately before `<script src="shaders.js"></script>`.

Panel, between the Detail `</details>` and `<details class="sec" data-panel="output" open>`:

```html
    <details class="sec" data-panel="film" open>
      <summary>Film</summary>
      <div class="body">
        <div id="filmStocks" class="chips" role="radiogroup" aria-label="Film stock"></div>
        <div class="row sel"><label for="filmGauge">Format</label>
          <select id="filmGauge" title="The film format: a smaller frame is enlarged more, so its grain is coarser and its halation wider"></select></div>
        <div class="row"><label for="filmGrain">Grain</label>
          <input id="filmGrain" type="range" min="0" max="200" step="1" value="100">
          <span class="val"><input id="filmGrainOut" class="num" type="text" inputmode="decimal" aria-label="Grain amount, percent"><i>%</i></span></div>
        <div class="row"><label for="filmHalation">Halation</label>
          <input id="filmHalation" type="range" min="0" max="100" step="1" value="50">
          <span class="val"><input id="filmHalationOut" class="num" type="text" inputmode="decimal" aria-label="Halation"><i></i></span></div>
      </div>
    </details>
```

CSS (next to the `.looks` rules):

```css
  /* The Film panel's stock chips. */
  .chips { display: flex; flex-wrap: wrap; gap: 4px; margin: 2px 0 8px; }
  .chips .chip { padding: 3px 8px; border: 1px solid var(--line); border-radius: 999px; background: none;
    color: var(--fg-2); font: inherit; font-size: 11px; cursor: pointer; }
  .chips .chip:hover { color: var(--fg); border-color: var(--fg-2); }
  .chips .chip.on { color: var(--fg); border-color: var(--accent); background: color-mix(in srgb, var(--accent) 18%, transparent); }
```

(If a `.chip`/`.chips` rule already exists in index.html, reuse it instead and drop this block.)

- [ ] **Step 2: app.js wiring**

NUM definitions (after `sunStrength`):

```js
  defNum('filmGrain', { path: 'film.grain', get: () => state.film.grain, set: (v) => { state.film.grain = v; },
    range: Settings.RANGES.film.grain, scale: 100, fmt: (v) => String(Math.round(v * 100)) });
  defNum('filmHalation', { path: 'film.halation', get: () => state.film.halation, set: (v) => { state.film.halation = v; },
    range: Settings.RANGES.film.halation, scale: 100, fmt: (v) => String(Math.round(v * 100)) });
```

Panel code (near the sun-glare section):

```js
  // -- Film simulation (film.js; spec 2026-10-03-film-simulation-design.md) --
  // Stock chips (Off first), the gauge, Grain and Halation. Format, Grain
  // and Halation do nothing while the stock is Off, so they are disabled.
  const filmStocksEl = document.getElementById('filmStocks');
  const filmGaugeEl = document.getElementById('filmGauge');
  const filmChips = new Map();
  for (const s of [{ id: 'off', name: 'Off' }].concat(Film.STOCKS)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.setAttribute('role', 'radio');
    b.textContent = s.name;
    b.addEventListener('click', () => setFilm({ stock: s.id }));
    filmStocksEl.appendChild(b);
    filmChips.set(s.id, b);
  }
  for (const g of Film.GAUGES) {
    const o = document.createElement('option');
    o.value = g.id;
    o.textContent = g.name;
    filmGaugeEl.appendChild(o);
  }
  function syncFilm() {
    const f = state.film;
    for (const [id, b] of filmChips) {
      b.classList.toggle('on', id === f.stock);
      b.setAttribute('aria-checked', String(id === f.stock));
    }
    filmGaugeEl.value = f.gauge;
    const off = f.stock === 'off';
    filmGaugeEl.disabled = off;
    for (const d of [NUM.filmGrain, NUM.filmHalation]) { d.slider.disabled = off; d.out.disabled = off; }
    reflectNum(NUM.filmGrain, true);
    reflectNum(NUM.filmHalation, true);
  }
  function setFilm(patch) {
    state.film = Object.assign({}, state.film, patch);
    syncFilm();
    render();
    scheduleSave();
  }
  filmGaugeEl.addEventListener('input', () => setFilm({ gauge: filmGaugeEl.value }));
```

`syncControlsFromState`: add `syncFilm();` after `syncLook();`.

`render()`: replace

```js
      const shown = beforeView ? Object.assign({}, state, { tone: DEFAULTS.tone, detail: DEFAULTS.detail }) : state;
      GL.renderComposition(ctx, shown, canvas.width, canvas.height, null, previewPlace);
```

with

```js
      // Before / after (the \ key): the preview with Tone, Detail and Film off.
      const shown = beforeView
        ? Object.assign({}, state, { tone: DEFAULTS.tone, detail: DEFAULTS.detail, film: DEFAULTS.film }) : state;
      if (Film.active(shown)) GL.renderFilmed(ctx, shown, canvas.width, canvas.height, previewPlace);
      else GL.renderComposition(ctx, shown, canvas.width, canvas.height, null, previewPlace);
```

(and delete the old one-line "Before / after" comment it replaces). If a `FILM_TARGET_INCOMPLETE` error can reach the existing `catch`, extend its condition: `if (e.message !== 'DEVELOP_TARGET_INCOMPLETE' && e.message !== 'FILM_TARGET_INCOMPLETE') throw e;` and for the film case call `GL.releaseFilm(ctx); fail('Not enough graphics memory for the film simulation.');`.

`renderFullCanvas`: replace the `GL.readCompositionStrips(...)` call with

```js
      const toCanvas = (rowsRGBA, outY, rows) => {
        const clamped = new Uint8ClampedArray(rowsRGBA.buffer, rowsRGBA.byteOffset, rowsRGBA.length);
        c2d.putImageData(new ImageData(clamped, g.width, rows), 0, outY);
      };
      if (Film.active(renderState)) {
        // The film post-pass in bands of rows (GL.filmStrips): band-sized
        // temporaries, whatever the export's size.
        try {
          GL.filmStrips(ctx, renderState, { tex: target.tex, w: g.width, h: g.height },
            GL.filmFrame(renderState, g.width, g.height, null), EXPORT_STRIP_ROWS, toCanvas);
        } finally {
          GL.releaseFilm(ctx);   // the preview reallocates its own on the next render
        }
      } else {
        GL.readCompositionStrips(gl, target.fbo, g.width, g.height, EXPORT_STRIP_ROWS, toCanvas);
      }
```

After an export the preview's film targets were released, so call `render()` is not needed (the next render reallocates). The gain-map render passes `gainOut: true`, which `Film.active` excludes; DNG passes `dngOutput: true`, likewise.

Parity check (next to `checkSunParity`), exposed on `App` as `checkFilmParity`:

```js
  // Film: the GPU film pass (GL.filmBandsWith, bands of 24 rows) against
  // Film.reference on a synthetic image -- a gradient, a colour ramp and a
  // white patch for halation -- at export scale and at a zoomed-out preview
  // scale with an offset. maxDiff in 1/255 steps; over2: pixels off by > 2.
  function checkFilmParity() {
    ensureCtx();
    const gl = ctx.gl, W = 160, H = 120;
    const img = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      const bright = x > 100 && x < 116 && y > 40 && y < 56;
      img[o] = bright ? 255 : Math.round(255 * x / W);
      img[o + 1] = bright ? 255 : Math.round(255 * y / H);
      img[o + 2] = bright ? 255 : 128;
      img[o + 3] = 255;
    }
    // GL y-up texture of the top-down image
    const flipped = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) flipped.set(img.subarray(y * W * 4, (y + 1) * W * 4), (H - 1 - y) * W * 4);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, flipped);
    const cases = [];
    const runs = [
      { film: { stock: 'golden200', gauge: 's16', grain: 1.5, halation: 1 }, frame: { D: 1200, z: 1, px: 0, py: 0 } },
      { film: { stock: 'classic400bw', gauge: '35', grain: 1, halation: 0.5 }, frame: { D: 1200, z: 0.37, px: -13, py: 7 } },
      { film: { stock: 'verdant400', gauge: 's8', grain: 2, halation: 0 }, frame: { D: 400, z: 1, px: 0, py: 0 } },
    ];
    let maxDiff = 0, over2 = 0;
    try {
      for (const r of runs) {
        const p = Film.params({ film: r.film, sourceName: 'parity.insp' }, r.frame);
        const want = Film.reference(img, W, H, p, r.frame);
        const got = new Uint8ClampedArray(W * H * 4);
        GL.filmBandsWith(ctx, p, { tex, w: W, h: H }, r.frame, 24, (rows, y0, n) => got.set(rows.subarray(0, W * n * 4), y0 * W * 4));
        let m = 0, o2 = 0;
        for (let i = 0; i < W * H * 4; i++) {
          if ((i & 3) === 3) continue;
          const d = Math.abs(got[i] - want[i]);
          if (d > m) m = d;
          if (d > 2) o2++;
        }
        cases.push({ stock: r.film.stock, gauge: r.film.gauge, z: r.frame.z, maxDiff: m, over2: o2 });
        maxDiff = Math.max(maxDiff, m); over2 += o2;
      }
    } finally {
      gl.deleteTexture(tex);
      GL.releaseFilm(ctx);
    }
    render();
    return { maxDiff, over2, cases };
  }
```

- [ ] **Step 3: Run the suite**

Run: `npm test 2>&1 | tail -15`
Expected: all pass (no new failures; the `ui-settings` panel tests may check every `data-panel` in index.html has a PANEL_SECTIONS entry — the `film` entry from Task 4 satisfies it).

- [ ] **Step 4: Commit** (only if asked) — `feat(film): Film panel; film on the preview, export and print`

---

### Task 8: GPU verification, README

**Files:**
- Modify: `README.md`
- Scratch: scratchpad scripts (`cdp_gpu.py`, `nocache8767.py`), outputs in scratchpad only.

- [ ] **Step 1: Start the server and headless GPU Chrome** (as in earlier sessions)

Run (background): `python <scratchpad>/nocache8767.py C:/Users/Leo/Gits/Photo360` then drive with `cdp_gpu.py` (port 9344, d3d11).

- [ ] **Step 2: Parity**

Evaluate `App.checkFilmParity()`.
Expected: `maxDiff <= 3` and `over2` a small fraction (< 0.5 % of 3·160·120 = 57600 → < 288). If larger: systematic-debugging — compare one case with halation 0 and grain 0 first (curve only, expect ≤ 1), then grain only, then halo only.

- [ ] **Step 3: Off is byte-identical to HEAD**

Load a Testfiles JPEG and a DNG with stock Off; export PNG; compare against an export from `git stash`-free HEAD build (serve a `git worktree add <scratchpad>/head HEAD` copy on port 8768 with `nocache8768.py`). Expected: identical bytes (PNG) for both.

- [ ] **Step 4: Visual checks** (screenshots into the scratchpad, view them)
  - Golden 200 / 35 mm vs Super 16 vs Super 8 at 100 % zoom on the same crop: grain visibly coarser in that order.
  - Pan the 100 % view by a few pixels: grain stays put.
  - Zoomed out (fit): grain subtle, no aliasing/moire.
  - A sunny Testfiles photo with halation 1: red-orange glow around the sun, none in shadows.
  - Classic 400 B&W: grain neutral (no colour speckle).
  - Export a both-lens JPEG with Super 8: no horizontal seams every 256 rows (inspect a crop at a band boundary, y = 256, 512).

- [ ] **Step 5: Export timing and memory**

Time a full both-lens JPEG export with film on vs off (performance.now around `App.exportImage`). Note the numbers in the report; a slowdown of a few seconds is acceptable.

- [ ] **Step 6: README** — add a **Film** section after Detail:

```markdown
### Film

A film look on top of your edit: pick a **stock** (Golden 200, Verdant 400,
Portrait 160, Classic 400 B&W, Smooth 400 B&W; Off by default). Each stock
has its own colour, toe and shoulder, re-centred so mid-grey and white stay
where your edit put them, and its own grain, modelled on silver-halide
crystals (ported from Wigglecam). **Format** sets how much each lens circle
is "enlarged": Super 8 and Super 16 give coarse grain and wide halation,
35 mm medium, 120 fine. **Grain** scales the grain (0–200 %), **Halation**
the red-orange glow around bright highlights such as the sun. The preview
shows the same grain as the export at 100 % (weaker when zoomed out). JPEG,
PNG, Ultra HDR (its base image) and Print get the film; DNG does not.
```

- [ ] **Step 7: Full suite, line endings, stop servers**

Run: `npm test 2>&1 | tail -5` → all pass. Run scratchpad `eol2.py` (update its file list to this change's new files) → every modified file keeps its HEAD style, new files LF. Stop the servers (PowerShell `Get-NetTCPConnection -LocalPort 8767,8768,9344 | % { Stop-Process -Id $_.OwningProcess }`).

- [ ] **Step 8: Commit** (only if asked) — `feat: film simulation -- stocks, silver-halide grain, halation, film gauge`
