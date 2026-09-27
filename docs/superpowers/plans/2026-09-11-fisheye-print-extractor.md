# Fisheye Print Extractor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A single static web page that turns an Insta360 X5 `.insp` dual-fisheye file into print-ready 2D fisheye images — each lens cropped to a true 180° hemisphere, rolled level, and finished with a synthesized lens edge that reproduces the dispersed rim flare of the older X1.

**Architecture:** No build step, no server, no module system. `index.html` loads plain `<script src>` files that attach globals. All pixel work happens in WebGL2 in the browser; images never leave the machine. Geometry is a **concentric crop** — cropping a radially symmetric fisheye at radius `r` *is* an exact FOV change, so nothing is ever reprojected or resampled through a lens model. The two pure-math modules (`lens.js`, `edge.js`) carry no DOM or WebGL references and are unit-tested in Node.

**Tech Stack:** Vanilla ES2020, WebGL2, GLSL ES 3.00, `node:test` (built in, zero dependencies), Python 3 + Pillow + NumPy for the one-off offline preset fit.

**Spec:** `docs/superpowers/specs/2026-09-11-fisheye-print-extractor-design.md`

## Global Constraints

- **No runtime dependencies.** No npm packages ship in the page. `package.json` exists only to define the `test` script and MUST have an empty or absent `dependencies` block.
- **No build step, no bundler, no ES modules.** `index.html` must work when opened directly via `file://`. Every `.js` file uses the UMD-ish wrapper shown in Task 1 so it works both as a `<script>` global and via `require()` in Node.
- **Node 18.12.1** is the installed version. The test command is `node --test test/`. It prints an experimental-feature warning; that is expected and not a failure.
- **Lens calibration constant:** `THETA_MAX_DEG = 105` (each X5 lens sees ≈210°). Measured by correlating the two overlap annuli across three test files; peak at 104–107°, azimuth offset 180.0°.
- **180° crop radius = 0.857142857…** of the image-circle radius (`90/105`). Any test asserting this uses a tolerance of `1e-9`.
- **Lens azimuths run in opposite directions.** A camera roll of `α` appears as `+α` on lens A and `−α` on lens B.
- **Default export is native sampling.** At 180° the circle is ~5100 px on an 11904×5952 source. Never upscale by default; padding to the 5952² sensor square is opt-in and must be labelled as an upscale in the UI.
- **Tone controls default to exact pass-through.** Exposure 0 EV, contrast 0, saturation 0 must produce bit-identical pixels to tone being disabled.
- **Every commit message ends with these two lines** (blank line before them):

  ```
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_011ZiPLDAjYMrkX2uA7ERgcu
  ```

- **Test files** live in `Testfiles/` and are read-only. Do not modify or move them.

## File Structure

| File | Responsibility |
|---|---|
| `index.html` | Markup and CSS for the whole page. No logic. |
| `lens.js` | Pure math: FOV↔radius, duplication coverage, source layout detection, export canvas geometry, filenames. **Tested.** |
| `edge.js` | Pure math: terminator curve, dispersion peaks, rim bell, highlight weight, rim-profile accumulation, angular blur, presets. **Tested.** |
| `exif.js` | Pure bytes: read Make/Model/DateTimeOriginal from a source JPEG, synthesize a minimal APP1, insert it into an exported JPEG. **Tested.** |
| `shaders.js` | GLSL source strings only. No logic. |
| `gl.js` | WebGL2 context, program/texture/framebuffer management, the three render passes, render-to-canvas and render-at-export-size. |
| `app.js` | UI wiring: file load and decode, control state, preview loop, export, `localStorage`. |
| `tools/fit-x1-edge.py` | One-off offline fit of the edge preset against `Testfiles/Outputs/Flat.jpg`. Not shipped in the page. |
| `test/*.test.js` | Node tests for `lens.js`, `edge.js`, `exif.js`, and the GLSL/JS parity fixture. |
| `test/fixtures/` | Checked-in measured data (the X1 rim profile) used as ground truth. |

---

### Task 1: Repository skeleton, test harness, and the lens model

**Files:**
- Create: `package.json`, `.gitignore`, `lens.js`
- Test: `test/lens.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: global/module `Lens` with `Lens.THETA_MAX_DEG: number`, `Lens.radiusForFov(fovDeg: number, thetaMaxDeg?: number): number`, `Lens.fovForRadius(rFrac: number, thetaMaxDeg?: number): number`, `Lens.coverage(fovDeg: number, thetaMaxDeg?: number): {overlapDeg: number, duplicatedAreaFraction: number}`.

- [ ] **Step 1: Initialise the repository**

The working directory is not yet a git repository.

```bash
git init
git add docs
git commit -m "docs: add design spec and implementation plan"
```

- [ ] **Step 2: Create `package.json` and `.gitignore`**

`package.json`:

```json
{
  "name": "photo360",
  "version": "0.1.0",
  "private": true,
  "description": "Insta360 X5 single-lens fisheye print extractor",
  "scripts": {
    "test": "node --test test/"
  }
}
```

`.gitignore`:

```
node_modules/
*.local.*
scratch/
```

- [ ] **Step 3: Write the failing test**

Create `test/lens.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Lens = require('../lens.js');

test('theta max reflects the measured X5 calibration', () => {
  assert.strictEqual(Lens.THETA_MAX_DEG, 105);
});

test('180 degrees falls at 0.857 of the image-circle radius', () => {
  assert.ok(Math.abs(Lens.radiusForFov(180) - 90 / 105) < 1e-9);
});

test('the full lens FOV fills the whole image circle', () => {
  assert.ok(Math.abs(Lens.radiusForFov(210) - 1) < 1e-9);
});

test('radius and FOV round-trip', () => {
  for (const fov of [120, 160, 180, 195, 210]) {
    assert.ok(Math.abs(Lens.fovForRadius(Lens.radiusForFov(fov)) - fov) < 1e-9);
  }
});

test('an alternate calibration shifts the crop radius', () => {
  assert.ok(Math.abs(Lens.radiusForFov(180, 100) - 0.9) < 1e-9);
});

test('at 180 degrees nothing is duplicated with the other lens', () => {
  const c = Lens.coverage(180);
  assert.strictEqual(c.overlapDeg, 0);
  assert.strictEqual(c.duplicatedAreaFraction, 0);
});

test('as-shot 210 degrees duplicates about half the image area', () => {
  const c = Lens.coverage(210);
  assert.ok(Math.abs(c.overlapDeg - 30) < 1e-9);
  assert.ok(Math.abs(c.duplicatedAreaFraction - (1 - (75 / 105) ** 2)) < 1e-9);
  assert.ok(c.duplicatedAreaFraction > 0.48 && c.duplicatedAreaFraction < 0.50);
});

test('below 180 degrees there is a gap, not duplication', () => {
  const c = Lens.coverage(160);
  assert.ok(Math.abs(c.overlapDeg - -20) < 1e-9);
  assert.strictEqual(c.duplicatedAreaFraction, 0);
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `node --test test/`
Expected: FAIL — `Cannot find module '../lens.js'`

- [ ] **Step 5: Write the minimal implementation**

Create `lens.js`. Note the wrapper — every `.js` file in this project uses it so the same file works as a browser global and as a Node module:

```js
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Lens = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Measured by correlating the two overlap annuli of the X5 test files:
  // each lens sees about 210 degrees, i.e. a half-angle of 105 degrees at
  // the rim of the image circle.
  const THETA_MAX_DEG = 105;

  // Fraction of the image-circle radius at which a given full FOV falls.
  // Equidistant model: theta is proportional to radius.
  function radiusForFov(fovDeg, thetaMaxDeg) {
    const tm = thetaMaxDeg === undefined ? THETA_MAX_DEG : thetaMaxDeg;
    return fovDeg / 2 / tm;
  }

  function fovForRadius(rFrac, thetaMaxDeg) {
    const tm = thetaMaxDeg === undefined ? THETA_MAX_DEG : thetaMaxDeg;
    return rFrac * tm * 2;
  }

  // How much of this lens's cropped image is also seen by the other lens.
  function coverage(fovDeg, thetaMaxDeg) {
    const tm = thetaMaxDeg === undefined ? THETA_MAX_DEG : thetaMaxDeg;
    const overlapDeg = fovDeg - 180;
    let duplicatedAreaFraction = 0;
    if (overlapDeg > 0) {
      const rOut = radiusForFov(fovDeg, tm);
      const rInner = (180 - fovDeg / 2) / tm;
      duplicatedAreaFraction = 1 - (rInner / rOut) ** 2;
    }
    return { overlapDeg, duplicatedAreaFraction };
  }

  return { THETA_MAX_DEG, radiusForFov, fovForRadius, coverage };
});
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --test test/`
Expected: PASS — 8 passing, 0 failing.

- [ ] **Step 7: Commit**

```bash
git add package.json .gitignore lens.js test/lens.test.js
git commit -m "feat: add lens model with measured X5 calibration"
```

---

### Task 2: Source layout detection and export canvas geometry

**Files:**
- Modify: `lens.js`
- Modify: `test/lens.test.js`

**Interfaces:**
- Consumes: `Lens.radiusForFov` from Task 1.
- Produces:
  - `Lens.detectLayout(width: number, height: number): {kind: 'dual'|'single'|'unsupported', lensSize: number, lenses: Array<{x: number, y: number}>}` — `lenses` are the top-left pixel offsets of each square lens frame in the source image, in order A then B.
  - `Lens.exportLayout(opts: {circleDiameter: number, sensors: 'A'|'B'|'both', orientation: 'side'|'stacked', gapPx: number, marginPx: number}): {width: number, height: number, circles: Array<{cx: number, cy: number, lens: 'A'|'B'}>}`
  - `Lens.exportFilename(sourceName: string, lensLabel: string, fovDeg: number, ext: string): string`

- [ ] **Step 1: Write the failing tests**

Append to `test/lens.test.js`:

```js
test('a full-size X5 file is detected as dual fisheye', () => {
  const l = Lens.detectLayout(11904, 5952);
  assert.strictEqual(l.kind, 'dual');
  assert.strictEqual(l.lensSize, 5952);
  assert.deepStrictEqual(l.lenses, [{ x: 0, y: 0 }, { x: 5952, y: 0 }]);
});

test('the smaller X5 file is also detected as dual fisheye', () => {
  const l = Lens.detectLayout(5888, 2944);
  assert.strictEqual(l.kind, 'dual');
  assert.strictEqual(l.lensSize, 2944);
  assert.deepStrictEqual(l.lenses, [{ x: 0, y: 0 }, { x: 2944, y: 0 }]);
});

test('a square file is detected as a single fisheye', () => {
  const l = Lens.detectLayout(3040, 3040);
  assert.strictEqual(l.kind, 'single');
  assert.strictEqual(l.lensSize, 3040);
  assert.deepStrictEqual(l.lenses, [{ x: 0, y: 0 }]);
});

test('an ordinary photo is unsupported', () => {
  assert.strictEqual(Lens.detectLayout(4000, 3000).kind, 'unsupported');
});

test('a single-lens export is square and centred', () => {
  const g = Lens.exportLayout({
    circleDiameter: 5100, sensors: 'A', orientation: 'side', gapPx: 0, marginPx: 0,
  });
  assert.strictEqual(g.width, 5100);
  assert.strictEqual(g.height, 5100);
  assert.deepStrictEqual(g.circles, [{ cx: 2550, cy: 2550, lens: 'A' }]);
});

test('a two-up export with no gap is exactly 2:1', () => {
  const g = Lens.exportLayout({
    circleDiameter: 5100, sensors: 'both', orientation: 'side', gapPx: 0, marginPx: 0,
  });
  assert.strictEqual(g.width, 10200);
  assert.strictEqual(g.height, 5100);
  assert.deepStrictEqual(g.circles, [
    { cx: 2550, cy: 2550, lens: 'A' },
    { cx: 7650, cy: 2550, lens: 'B' },
  ]);
});

test('gap and margin add real pixels around the circles', () => {
  const g = Lens.exportLayout({
    circleDiameter: 5100, sensors: 'both', orientation: 'side', gapPx: 100, marginPx: 50,
  });
  assert.strictEqual(g.width, 50 + 5100 + 100 + 5100 + 50);
  assert.strictEqual(g.height, 50 + 5100 + 50);
  assert.strictEqual(g.circles[0].cx, 2600);
  assert.strictEqual(g.circles[1].cx, 7800);
  assert.strictEqual(g.circles[0].cy, 2600);
});

test('a stacked two-up export is exactly 1:2', () => {
  const g = Lens.exportLayout({
    circleDiameter: 5100, sensors: 'both', orientation: 'stacked', gapPx: 0, marginPx: 0,
  });
  assert.strictEqual(g.width, 5100);
  assert.strictEqual(g.height, 10200);
  assert.deepStrictEqual(g.circles, [
    { cx: 2550, cy: 2550, lens: 'A' },
    { cx: 2550, cy: 7650, lens: 'B' },
  ]);
});

test('exporting lens B alone still yields one centred circle labelled B', () => {
  const g = Lens.exportLayout({
    circleDiameter: 4000, sensors: 'B', orientation: 'side', gapPx: 999, marginPx: 0,
  });
  assert.strictEqual(g.width, 4000);
  assert.deepStrictEqual(g.circles, [{ cx: 2000, cy: 2000, lens: 'B' }]);
});

test('filenames record the source, lens and FOV', () => {
  assert.strictEqual(
    Lens.exportFilename('Sunscreen.insp', 'A', 180, 'jpg'),
    'Sunscreen_A_180deg.jpg'
  );
  assert.strictEqual(
    Lens.exportFilename('IMG_20260511_094146_00_004.insp', 'AB', 177.5, 'png'),
    'IMG_20260511_094146_00_004_AB_177-5deg.png'
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/`
Expected: FAIL — `Lens.detectLayout is not a function`

- [ ] **Step 3: Write the minimal implementation**

Add to `lens.js`, inside the factory, before the `return`:

```js
  const ASPECT_TOLERANCE = 0.02;

  function detectLayout(width, height) {
    const aspect = width / height;
    if (Math.abs(aspect - 2) < ASPECT_TOLERANCE) {
      return { kind: 'dual', lensSize: height, lenses: [{ x: 0, y: 0 }, { x: height, y: 0 }] };
    }
    if (Math.abs(aspect - 1) < ASPECT_TOLERANCE) {
      return { kind: 'single', lensSize: height, lenses: [{ x: 0, y: 0 }] };
    }
    return { kind: 'unsupported', lensSize: 0, lenses: [] };
  }

  function exportLayout(opts) {
    const d = opts.circleDiameter;
    const m = opts.marginPx;
    const both = opts.sensors === 'both';
    const gap = both ? opts.gapPx : 0;
    const stacked = opts.orientation === 'stacked';
    const along = m + d + gap + d + m;   // long axis when two-up
    const across = m + d + m;
    const width = both ? (stacked ? across : along) : d + 2 * m;
    const height = both ? (stacked ? along : across) : d + 2 * m;
    const first = m + d / 2;
    const second = m + d + gap + d / 2;
    let circles;
    if (!both) {
      circles = [{ cx: width / 2, cy: height / 2, lens: opts.sensors }];
    } else if (stacked) {
      circles = [
        { cx: width / 2, cy: first, lens: 'A' },
        { cx: width / 2, cy: second, lens: 'B' },
      ];
    } else {
      circles = [
        { cx: first, cy: height / 2, lens: 'A' },
        { cx: second, cy: height / 2, lens: 'B' },
      ];
    }
    return { width, height, circles };
  }

  function exportFilename(sourceName, lensLabel, fovDeg, ext) {
    const stem = sourceName.replace(/\.[^.]+$/, '');
    const fov = String(Math.round(fovDeg * 10) / 10).replace('.', '-');
    return `${stem}_${lensLabel}_${fov}deg.${ext}`;
  }
```

Extend the returned object to `{ THETA_MAX_DEG, radiusForFov, fovForRadius, coverage, detectLayout, exportLayout, exportFilename }`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/`
Expected: PASS — 18 passing, 0 failing.

- [ ] **Step 5: Commit**

```bash
git add lens.js test/lens.test.js
git commit -m "feat: add layout detection and export geometry"
```

---

### Task 3: Edge model primitives

**Files:**
- Create: `edge.js`
- Test: `test/edge.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: global/module `Edge` with `Edge.terminator(u, start, softness): number`, `Edge.dispersionPeaks(amount): {r: number, g: number, b: number}`, `Edge.rimBell(u, peak, width): number`, `Edge.highlightWeight(luma, knee, exponent): number`, `Edge.DISPERSION_RATIO: {r: number, g: number, b: number}`.

`u` is always the output radius normalised so that `u = 1` is the nominal crop edge.

- [ ] **Step 1: Write the failing tests**

Create `test/edge.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Edge = require('../edge.js');

test('the terminator is fully open inside the falloff start', () => {
  assert.strictEqual(Edge.terminator(0.0, 0.9, 1), 1);
  assert.strictEqual(Edge.terminator(0.5, 0.9, 1), 1);
  assert.strictEqual(Edge.terminator(0.9, 0.9, 1), 1);
});

test('the terminator closes completely at the edge and beyond', () => {
  assert.strictEqual(Edge.terminator(1.0, 0.9, 1), 0);
  assert.strictEqual(Edge.terminator(1.4, 0.9, 1), 0);
});

test('the terminator decreases monotonically across the falloff band', () => {
  let prev = Infinity;
  for (let u = 0.9; u <= 1.0001; u += 0.005) {
    const v = Edge.terminator(u, 0.9, 1);
    assert.ok(v <= prev + 1e-12, `not monotonic at u=${u}`);
    prev = v;
  }
});

test('higher softness closes the terminator earlier', () => {
  assert.ok(Edge.terminator(0.95, 0.9, 3) < Edge.terminator(0.95, 0.9, 1));
});

test('dispersion puts red innermost and blue outermost', () => {
  const p = Edge.dispersionPeaks(0.02);
  assert.ok(p.r < p.g, 'red must peak inside green');
  assert.ok(p.g < p.b, 'green must peak inside blue');
  assert.strictEqual(p.g, 1);
});

test('zero dispersion collapses all three channels onto the edge', () => {
  const p = Edge.dispersionPeaks(0);
  assert.strictEqual(p.r, 1);
  assert.strictEqual(p.g, 1);
  assert.strictEqual(p.b, 1);
});

test('the rim bell peaks at its peak radius and decays away from it', () => {
  assert.ok(Math.abs(Edge.rimBell(1.0, 1.0, 0.02) - 1) < 1e-12);
  assert.ok(Edge.rimBell(1.02, 1.0, 0.02) < 0.5);
  assert.ok(Edge.rimBell(1.10, 1.0, 0.02) < 1e-6);
  assert.ok(Math.abs(Edge.rimBell(0.98, 1.0, 0.02) - Edge.rimBell(1.02, 1.0, 0.02)) < 1e-12);
});

test('content below the highlight knee contributes nothing to the glow', () => {
  assert.strictEqual(Edge.highlightWeight(0.0, 0.5, 2), 0);
  assert.strictEqual(Edge.highlightWeight(0.5, 0.5, 2), 0);
  assert.ok(Edge.highlightWeight(0.9, 0.5, 2) > 0);
});

test('the highlight weight is superlinear above the knee', () => {
  const a = Edge.highlightWeight(0.6, 0.5, 2);
  const b = Edge.highlightWeight(0.7, 0.5, 2);
  assert.ok(b / a > 2, 'a 0.1 rise past the knee should more than double the weight');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/`
Expected: FAIL — `Cannot find module '../edge.js'`

- [ ] **Step 3: Write the minimal implementation**

Create `edge.js`:

```js
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Edge = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Radial offsets of each channel's glow ring, in multiples of the
  // dispersion amount. Measured from the X1 reference: the rim reads
  // cream -> yellow -> green -> cyan -> violet going outward, i.e. red
  // peaks innermost and blue outermost.
  const DISPERSION_RATIO = { r: -1, g: 0, b: 1 };

  // Image brightness multiplier as the image runs out at the lens edge.
  // 1 inside `start`, 0 at u = 1.
  function terminator(u, start, softness) {
    if (u <= start) return 1;
    if (u >= 1) return 0;
    const t = (u - start) / (1 - start);
    const eased = t * t * (3 - 2 * t);
    return Math.pow(1 - eased, softness);
  }

  function dispersionPeaks(amount) {
    return {
      r: 1 + DISPERSION_RATIO.r * amount,
      g: 1 + DISPERSION_RATIO.g * amount,
      b: 1 + DISPERSION_RATIO.b * amount,
    };
  }

  function rimBell(u, peak, width) {
    const t = (u - peak) / width;
    return Math.exp(-t * t);
  }

  function highlightWeight(luma, knee, exponent) {
    return Math.pow(Math.max(0, luma - knee), exponent);
  }

  return { DISPERSION_RATIO, terminator, dispersionPeaks, rimBell, highlightWeight };
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/`
Expected: PASS — 27 passing, 0 failing.

- [ ] **Step 5: Commit**

```bash
git add edge.js test/edge.test.js
git commit -m "feat: add edge model primitives"
```

---

### Task 4: Rim profile accumulation and angular blur

**Files:**
- Modify: `edge.js`
- Modify: `test/edge.test.js`

**Interfaces:**
- Consumes: `Edge.highlightWeight` from Task 3.
- Produces:
  - `Edge.PROFILE_BINS: number` (2048)
  - `Edge.buildRimProfile(sample, opts): Float32Array` where `sample(thetaRad, u) -> [r, g, b]` with components in 0..1, `opts = {bins, radialSamples, uMin, uMax, knee, exponent}`, and the result is `bins * 4` floats laid out as `[intensity, meanR, meanG, meanB]` per bin.
  - `Edge.blurProfileAngular(profile, bins, spreadBins): Float32Array` — circular Gaussian blur along the azimuth axis, applied to all four components.
  - `Edge.PRESETS: {x1classic: {...}}` (values filled in by Task 9; this task ships placeholders that the tests do not assert on).

- [ ] **Step 1: Write the failing tests**

Append to `test/edge.test.js`:

```js
function bandSampler(hiFrom, hiTo) {
  // white inside the azimuth band [hiFrom, hiTo) radians, black elsewhere
  return (theta) => {
    const t = ((theta % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    return t >= hiFrom && t < hiTo ? [1, 1, 1] : [0, 0, 0];
  };
}

const PROFILE_OPTS = {
  bins: 64, radialSamples: 4, uMin: 0.94, uMax: 1.0, knee: 0.5, exponent: 2,
};

test('the rim profile lights up only where the content is bright', () => {
  const p = Edge.buildRimProfile(bandSampler(0, Math.PI), PROFILE_OPTS);
  assert.strictEqual(p.length, 64 * 4);
  const expected = Edge.highlightWeight(1, 0.5, 2);
  assert.ok(Math.abs(p[0 * 4] - expected) < 1e-6, 'first bin should be lit');
  assert.strictEqual(p[48 * 4], 0, 'a bin in the dark half must be zero');
});

test('the rim profile records the mean colour of its annulus', () => {
  const p = Edge.buildRimProfile(() => [0.2, 0.4, 0.8], PROFILE_OPTS);
  assert.ok(Math.abs(p[1] - 0.2) < 1e-6);
  assert.ok(Math.abs(p[2] - 0.4) < 1e-6);
  assert.ok(Math.abs(p[3] - 0.8) < 1e-6);
});

test('content below the knee produces a completely dark rim', () => {
  const p = Edge.buildRimProfile(() => [0.3, 0.3, 0.3], PROFILE_OPTS);
  for (let i = 0; i < 64; i++) assert.strictEqual(p[i * 4], 0);
});

test('the angular blur spreads an impulse into its neighbours', () => {
  const bins = 64;
  const p = new Float32Array(bins * 4);
  p[0] = 1;
  const b = Edge.blurProfileAngular(p, bins, 3);
  assert.ok(b[0] < 1, 'the impulse must be reduced');
  assert.ok(b[1 * 4] > 0, 'the next bin must receive energy');
  assert.ok(b[1 * 4] < b[0], 'energy must fall off with distance');
});

test('the angular blur wraps around the circle', () => {
  const bins = 64;
  const p = new Float32Array(bins * 4);
  p[0] = 1;
  const b = Edge.blurProfileAngular(p, bins, 3);
  assert.ok(b[63 * 4] > 0, 'the bin before zero must receive energy');
  assert.ok(Math.abs(b[63 * 4] - b[1 * 4]) < 1e-6, 'the blur must be symmetric');
});

test('the angular blur conserves total energy', () => {
  const bins = 64;
  const p = new Float32Array(bins * 4);
  for (let i = 0; i < bins; i++) p[i * 4] = Math.random();
  const before = p.filter((_, i) => i % 4 === 0).reduce((a, b) => a + b, 0);
  const b = Edge.blurProfileAngular(p, bins, 4);
  const after = b.filter((_, i) => i % 4 === 0).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(after - before) < 1e-4, `${after} vs ${before}`);
});

test('a zero spread leaves the profile untouched', () => {
  const bins = 8;
  const p = new Float32Array(bins * 4);
  p[0] = 1; p[4] = 0.5;
  const b = Edge.blurProfileAngular(p, bins, 0);
  assert.deepStrictEqual(Array.from(b), Array.from(p));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/`
Expected: FAIL — `Edge.buildRimProfile is not a function`

- [ ] **Step 3: Write the minimal implementation**

Add to `edge.js`, inside the factory before the `return`:

```js
  const PROFILE_BINS = 2048;
  const LUMA = { r: 0.2126, g: 0.7152, b: 0.0722 };

  // Reference implementation of render pass 1. The GLSL in shaders.js
  // mirrors this; test/parity.test.js keeps the two honest.
  function buildRimProfile(sample, opts) {
    const { bins, radialSamples, uMin, uMax, knee, exponent } = opts;
    const out = new Float32Array(bins * 4);
    for (let i = 0; i < bins; i++) {
      const theta = ((i + 0.5) / bins) * Math.PI * 2;
      let acc = 0, cr = 0, cg = 0, cb = 0;
      for (let j = 0; j < radialSamples; j++) {
        const u = uMin + (uMax - uMin) * ((j + 0.5) / radialSamples);
        const c = sample(theta, u);
        const luma = LUMA.r * c[0] + LUMA.g * c[1] + LUMA.b * c[2];
        acc += highlightWeight(luma, knee, exponent);
        cr += c[0]; cg += c[1]; cb += c[2];
      }
      out[i * 4] = acc / radialSamples;
      out[i * 4 + 1] = cr / radialSamples;
      out[i * 4 + 2] = cg / radialSamples;
      out[i * 4 + 3] = cb / radialSamples;
    }
    return out;
  }

  function blurProfileAngular(profile, bins, spreadBins) {
    if (spreadBins <= 0) return profile.slice();
    const radius = Math.max(1, Math.ceil(spreadBins * 3));
    const kernel = new Float64Array(radius * 2 + 1);
    let sum = 0;
    for (let k = -radius; k <= radius; k++) {
      const w = Math.exp(-(k * k) / (2 * spreadBins * spreadBins));
      kernel[k + radius] = w;
      sum += w;
    }
    for (let k = 0; k < kernel.length; k++) kernel[k] /= sum;

    const out = new Float32Array(bins * 4);
    for (let i = 0; i < bins; i++) {
      let a = 0, r = 0, g = 0, b = 0;
      for (let k = -radius; k <= radius; k++) {
        const j = ((i + k) % bins + bins) % bins;
        const w = kernel[k + radius];
        a += profile[j * 4] * w;
        r += profile[j * 4 + 1] * w;
        g += profile[j * 4 + 2] * w;
        b += profile[j * 4 + 3] * w;
      }
      out[i * 4] = a; out[i * 4 + 1] = r; out[i * 4 + 2] = g; out[i * 4 + 3] = b;
    }
    return out;
  }

  // Replaced with fitted values in Task 9.
  const PRESETS = {
    x1classic: {
      falloffStart: 0.90,
      falloffSoftness: 1.0,
      edgeIntensity: 1.0,
      ringWidth: 0.012,
      dispersion: 0.010,
      glowSpreadDeg: 8,
      highlightKnee: 0.45,
      highlightExponent: 2.0,
      hazeWidth: 0.06,
      hazeStrength: 0.15,
      terminatorDesaturate: 0.6,
      terminatorCoolShift: 0.25,
    },
  };
```

Extend the returned object with `PROFILE_BINS`, `buildRimProfile`, `blurProfileAngular`, `PRESETS`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/`
Expected: PASS — 34 passing, 0 failing.

- [ ] **Step 5: Commit**

```bash
git add edge.js test/edge.test.js
git commit -m "feat: add rim profile accumulation and angular blur"
```

---

### Task 5: Page shell, file loading, and a first cropped render

**Files:**
- Create: `index.html`, `shaders.js`, `gl.js`, `app.js`

**Interfaces:**
- Consumes: `Lens.detectLayout`, `Lens.radiusForFov`.
- Produces:
  - `GL.create(canvas): {gl, maxTextureSize}` — throws `Error('WEBGL2_UNAVAILABLE')` if unsupported.
  - `GL.uploadLens(ctx, index: 0|1, bitmap: ImageBitmap): void`
  - `GL.renderPreview(ctx, state): void` where `state` is the object described in Task 6's Interfaces; in this task it is `{fovDeg, thetaMaxDeg, sensors, sourceLensSize}`.
  - `Shaders.FULLSCREEN_VS: string`, `Shaders.COMPOSITE_FS: string`
  - `App.loadFile(file: File): Promise<void>`

This task's deliverable is visible: dropping `Testfiles/Sunscreen.insp` on the page shows lens A cropped to 180° as a hard-edged circle on black.

- [ ] **Step 1: Write `index.html`**

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fisheye Print Extractor</title>
<style>
  :root { color-scheme: dark; --bg:#141416; --panel:#1d1d20; --line:#2e2e33; --fg:#e8e8ea; --mut:#8b8b93; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
         font:14px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
         display:flex; height:100vh; overflow:hidden; }
  #stage { flex:1; display:grid; place-items:center; position:relative; padding:24px; min-width:0; }
  #view { max-width:100%; max-height:100%; background:#000; }
  #drop { position:absolute; inset:24px; border:2px dashed var(--line); border-radius:8px;
          display:grid; place-items:center; color:var(--mut); text-align:center; }
  #drop.hidden { display:none; }
  #panel { width:320px; flex:none; border-left:1px solid var(--line); background:var(--panel);
           overflow-y:auto; padding:16px; }
  #panel h2 { font-size:11px; text-transform:uppercase; letter-spacing:.08em;
              color:var(--mut); margin:20px 0 8px; }
  #panel h2:first-child { margin-top:0; }
  label { display:block; margin:10px 0; }
  label span { display:flex; justify-content:space-between; color:var(--mut); font-size:12px; }
  input[type=range] { width:100%; }
  #readout { color:var(--mut); font-size:12px; margin-top:4px; }
  #error { color:#ff7a6b; font-size:12px; margin-top:8px; white-space:pre-wrap; }
</style>
</head>
<body>
  <div id="stage">
    <canvas id="view"></canvas>
    <div id="drop">Drop an .insp or .jpg fisheye file here<br>(or click to choose)</div>
    <input id="file" type="file" accept=".insp,.jpg,.jpeg,image/jpeg" hidden>
  </div>
  <aside id="panel">
    <h2>Framing</h2>
    <label><span>Field of view <output id="fovOut">180.0°</output></span>
      <input id="fov" type="range" min="120" max="210" step="0.5" value="180"></label>
    <div id="readout"></div>
    <div id="error"></div>
  </aside>

  <script src="lens.js"></script>
  <script src="edge.js"></script>
  <script src="exif.js"></script>
  <script src="shaders.js"></script>
  <script src="gl.js"></script>
  <script src="app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Write `shaders.js` with a fullscreen vertex shader and a crop-only fragment shader**

```js
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Shaders = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const FULLSCREEN_VS = `#version 300 es
  void main() {
    vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
  }`;

  const COMPOSITE_FS = `#version 300 es
  precision highp float;
  uniform sampler2D uLens;      // one square lens frame, S x S
  uniform vec2  uCellSize;      // viewport size in pixels
  uniform float uCircleRadius;  // output circle radius in pixels
  uniform float uCropFrac;      // crop radius as a fraction of the image circle
  uniform float uRoll;          // radians
  out vec4 fragColor;

  // Sample the source lens at output polar coordinates.
  // u is normalised so u = 1.0 is the crop edge.
  vec3 sampleLens(float u, float theta) {
    float a = theta + uRoll;
    vec2 off = vec2(cos(a), sin(a)) * (u * uCropFrac * 0.5);
    return texture(uLens, vec2(0.5) + off).rgb;
  }

  void main() {
    vec2 p = gl_FragCoord.xy - uCellSize * 0.5;
    float r = length(p);
    float u = r / uCircleRadius;
    if (u > 1.0) { fragColor = vec4(0.0); return; }
    float theta = atan(p.y, p.x);
    fragColor = vec4(sampleLens(u, theta), 1.0);
  }`;

  return { FULLSCREEN_VS, COMPOSITE_FS };
});
```

- [ ] **Step 3: Write `gl.js`**

```js
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GL = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src.trim());
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error('shader: ' + gl.getShaderInfoLog(s));
    }
    return s;
  }

  function program(gl, vsSrc, fsSrc) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error('link: ' + gl.getProgramInfoLog(p));
    }
    return p;
  }

  function create(canvas) {
    const gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, preserveDrawingBuffer: true,
      premultipliedAlpha: false,
    });
    if (!gl) throw new Error('WEBGL2_UNAVAILABLE');
    const ctx = {
      gl,
      canvas,
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      textures: [null, null],
      composite: program(gl, Shaders.FULLSCREEN_VS, Shaders.COMPOSITE_FS),
      vao: gl.createVertexArray(),
    };
    return ctx;
  }

  function uploadLens(ctx, index, bitmap) {
    const gl = ctx.gl;
    if (ctx.textures[index]) gl.deleteTexture(ctx.textures[index]);
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    ctx.textures[index] = t;
  }

  function renderPreview(ctx, state) {
    const gl = ctx.gl;
    gl.bindVertexArray(ctx.vao);
    gl.useProgram(ctx.composite);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const w = ctx.canvas.width, h = ctx.canvas.height;
    gl.viewport(0, 0, w, h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, ctx.textures[0]);
    gl.uniform1i(gl.getUniformLocation(ctx.composite, 'uLens'), 0);
    gl.uniform2f(gl.getUniformLocation(ctx.composite, 'uCellSize'), w, h);
    gl.uniform1f(gl.getUniformLocation(ctx.composite, 'uCircleRadius'), Math.min(w, h) / 2);
    gl.uniform1f(gl.getUniformLocation(ctx.composite, 'uCropFrac'),
      Lens.radiusForFov(state.fovDeg, state.thetaMaxDeg));
    gl.uniform1f(gl.getUniformLocation(ctx.composite, 'uRoll'), 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  return { create, uploadLens, renderPreview, program };
});
```

- [ ] **Step 4: Write `app.js` with file loading and per-half decode**

```js
(function () {
  'use strict';

  const canvas = document.getElementById('view');
  const dropEl = document.getElementById('drop');
  const fileEl = document.getElementById('file');
  const fovEl = document.getElementById('fov');
  const fovOut = document.getElementById('fovOut');
  const readout = document.getElementById('readout');
  const errorEl = document.getElementById('error');

  const state = {
    fovDeg: 180, thetaMaxDeg: Lens.THETA_MAX_DEG,
    sensors: 'A', sourceName: '', sourceLensSize: 0,
  };
  let ctx = null;

  function fail(msg) { errorEl.textContent = msg; }

  async function loadFile(file) {
    errorEl.textContent = '';
    try {
      const buf = await file.arrayBuffer();
      const blob = new Blob([buf], { type: 'image/jpeg' });  // .insp has no MIME type
      const probe = await createImageBitmap(blob);
      const layout = Lens.detectLayout(probe.width, probe.height);
      probe.close();
      if (layout.kind === 'unsupported') {
        fail('Not a fisheye file: expected a 2:1 dual fisheye or a 1:1 single fisheye.');
        return;
      }
      if (!ctx) ctx = GL.create(canvas);
      if (layout.lensSize > ctx.maxTextureSize) {
        fail('This GPU caps textures at ' + ctx.maxTextureSize +
             ' px; the image will be downscaled from ' + layout.lensSize + ' px.');
      }
      for (let i = 0; i < layout.lenses.length; i++) {
        const o = layout.lenses[i];
        const half = await createImageBitmap(blob, o.x, o.y, layout.lensSize, layout.lensSize);
        GL.uploadLens(ctx, i, half);
        half.close();
      }
      state.sourceName = file.name;
      state.sourceLensSize = layout.lensSize;
      dropEl.classList.add('hidden');
      render();
    } catch (e) {
      fail(e.message === 'WEBGL2_UNAVAILABLE'
        ? 'This browser has no WebGL2 support.'
        : 'Could not read that file: ' + e.message);
    }
  }

  function render() {
    if (!ctx || !state.sourceLensSize) return;
    const side = Math.min(canvas.parentElement.clientWidth, canvas.parentElement.clientHeight) - 48;
    canvas.width = canvas.height = Math.max(256, Math.floor(side));
    canvas.style.width = canvas.style.height = canvas.width + 'px';
    GL.renderPreview(ctx, state);
    const c = Lens.coverage(state.fovDeg, state.thetaMaxDeg);
    readout.textContent = c.overlapDeg === 0
      ? 'Exactly one hemisphere — nothing duplicated with the other lens.'
      : c.overlapDeg > 0
        ? `${c.overlapDeg.toFixed(1)}° past the hemisphere — ` +
          `${(c.duplicatedAreaFraction * 100).toFixed(0)}% of this image also appears in the other lens.`
        : `${(-c.overlapDeg).toFixed(1)}° short of the hemisphere — a gap between the two lenses.`;
  }

  fovEl.addEventListener('input', () => {
    state.fovDeg = parseFloat(fovEl.value);
    fovOut.textContent = state.fovDeg.toFixed(1) + '°';
    render();
  });

  dropEl.addEventListener('click', () => fileEl.click());
  fileEl.addEventListener('change', () => fileEl.files[0] && loadFile(fileEl.files[0]));
  document.addEventListener('dragover', (e) => { e.preventDefault(); });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
  });
  window.addEventListener('resize', render);

  window.App = { loadFile, state, render };
})();
```

- [ ] **Step 5: Verify in the browser**

Open `index.html` directly (double-click, or `start index.html`). Drop `Testfiles/Sunscreen.insp` onto it.

Expected: a single circular fisheye of the left lens on black, filling the canvas, with **no doubled content at the rim** and the readout reading *"Exactly one hemisphere — nothing duplicated with the other lens."* Dragging the FOV slider to 210 should visibly push the rim content outward and change the readout to ~49% duplicated.

Check the browser console is free of errors.

- [ ] **Step 6: Commit**

```bash
git add index.html shaders.js gl.js app.js
git commit -m "feat: load .insp files and render a cropped single lens"
```

---

### Task 6: Roll, sensor selection, and two-up composition

**Files:**
- Modify: `index.html`, `gl.js`, `app.js`, `shaders.js`

**Interfaces:**
- Consumes: `Lens.exportLayout`, `Lens.radiusForFov`.
- Produces: the canonical render `state` object used by every later task:

```js
{
  fovDeg: number, thetaMaxDeg: number,
  rollDeg: number,                       // camera roll; +rollDeg on A, -rollDeg on B
  nudgeDeg: { A: number, B: number },    // per-lens offset added after the mirror
  sensors: 'A'|'B'|'both', swap: boolean,
  orientation: 'side'|'stacked',
  gapFrac: number, marginFrac: number,   // fractions of the circle diameter
  background: [number, number, number],  // 0..1 linear RGB
  sourceName: string, sourceLensSize: number,
  edge: { ...Edge.PRESETS.x1classic },   // Task 8
  tone: { exposureEv: 0, contrast: 0, saturation: 0 },  // Task 10
}
```
- Produces: `GL.renderComposition(ctx, state, targetWidth, targetHeight): void` — replaces `GL.renderPreview`, drawing every selected circle into the current draw buffer. Used for both preview and export.
- Produces: `App.rollFor(state, lens: 'A'|'B'): number` — degrees, mirrored and nudged.

- [ ] **Step 1: Write the failing test for the roll mirror**

Create `test/roll.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Lens = require('../lens.js');

test('roll is mirrored between the two back-to-back lenses', () => {
  const s = { rollDeg: 12, nudgeDeg: { A: 0, B: 0 } };
  assert.strictEqual(Lens.rollFor(s, 'A'), 12);
  assert.strictEqual(Lens.rollFor(s, 'B'), -12);
});

test('the per-lens nudge is added after the mirror', () => {
  const s = { rollDeg: 12, nudgeDeg: { A: 1.5, B: -0.5 } };
  assert.strictEqual(Lens.rollFor(s, 'A'), 13.5);
  assert.strictEqual(Lens.rollFor(s, 'B'), -12.5);
});

test('a zero roll with zero nudge leaves both lenses untouched', () => {
  const s = { rollDeg: 0, nudgeDeg: { A: 0, B: 0 } };
  assert.strictEqual(Lens.rollFor(s, 'A'), 0);
  assert.strictEqual(Lens.rollFor(s, 'B'), 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/`
Expected: FAIL — `Lens.rollFor is not a function`

- [ ] **Step 3: Implement `rollFor` in `lens.js`**

Add inside the factory and to the returned object:

```js
  // The two lenses are back-to-back and their azimuths run in opposite
  // directions, so a single camera roll appears mirrored between them.
  function rollFor(state, lens) {
    const base = lens === 'A' ? state.rollDeg : -state.rollDeg;
    return base + state.nudgeDeg[lens];
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/`
Expected: PASS — 37 passing, 0 failing.

- [ ] **Step 5: Replace `GL.renderPreview` with `GL.renderComposition`**

Each circle is drawn with its own `gl.viewport` covering a square cell centred on that circle, sized `circleDiameter * (1 + 2 * GLOW_HEADROOM)` so the rim glow of Task 8 has room. Cells may overlap when the gap is zero, so drawing is **additive** over the cleared background; the image regions themselves never overlap, so nothing is double-exposed.

In `gl.js`, replace `renderPreview` with:

```js
  const GLOW_HEADROOM = 0.08;   // fraction of the circle radius reserved outside the edge

  function renderComposition(ctx, state, targetW, targetH) {
    const gl = ctx.gl;
    const layout = compositionLayout(state, targetW, targetH);
    gl.bindVertexArray(ctx.vao);
    gl.useProgram(ctx.composite);
    gl.clearColor(state.background[0], state.background[1], state.background[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);

    for (const c of layout.circles) {
      const texIndex = lensTextureIndex(state, c.lens);
      if (!ctx.textures[texIndex]) continue;
      const cell = c.radius * (1 + GLOW_HEADROOM) * 2;
      gl.viewport(Math.round(c.cx - cell / 2), Math.round(targetH - c.cy - cell / 2),
                  Math.round(cell), Math.round(cell));
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, ctx.textures[texIndex]);
      const u = (n) => gl.getUniformLocation(ctx.composite, n);
      gl.uniform1i(u('uLens'), 0);
      gl.uniform2f(u('uCellSize'), cell, cell);
      gl.uniform1f(u('uCircleRadius'), c.radius);
      gl.uniform1f(u('uCropFrac'), Lens.radiusForFov(state.fovDeg, state.thetaMaxDeg));
      gl.uniform1f(u('uRoll'), Lens.rollFor(state, c.lens) * Math.PI / 180);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.disable(gl.BLEND);
  }

  // Which uploaded texture backs a given output slot, honouring the swap.
  function lensTextureIndex(state, lens) {
    const base = lens === 'A' ? 0 : 1;
    return state.swap ? 1 - base : base;
  }

  // Scale Lens.exportLayout's pixel geometry to fit the given target.
  function compositionLayout(state, targetW, targetH) {
    const d = 1000;  // arbitrary reference diameter; everything is scaled below
    const g = Lens.exportLayout({
      circleDiameter: d,
      sensors: state.sensors,
      orientation: state.orientation,
      gapPx: state.gapFrac * d,
      marginPx: state.marginFrac * d,
    });
    const s = Math.min(targetW / g.width, targetH / g.height);
    const offX = (targetW - g.width * s) / 2;
    const offY = (targetH - g.height * s) / 2;
    return {
      circles: g.circles.map((c) => ({
        lens: c.lens, cx: offX + c.cx * s, cy: offY + c.cy * s, radius: (d / 2) * s,
      })),
    };
  }

  return { create, uploadLens, renderComposition, compositionLayout, program };
```

Delete the old `renderPreview` and its export.

- [ ] **Step 6: Size the preview canvas to the composition aspect and wire the new controls**

In `app.js`, replace `render()` with a version that computes the canvas size from `Lens.exportLayout` so the preview has the same aspect as the export, then calls `GL.renderComposition(ctx, state, canvas.width, canvas.height)`.

Add to `index.html`'s panel, under Framing:

```html
    <label><span>Sensors</span>
      <select id="sensors">
        <option value="A">Lens A only</option>
        <option value="B">Lens B only</option>
        <option value="both">Both</option>
      </select></label>
    <label><span>Layout</span>
      <select id="orientation">
        <option value="side">Side by side (2:1)</option>
        <option value="stacked">Stacked (1:2)</option>
      </select></label>
    <label><span><input id="swap" type="checkbox"> Swap A and B</span></label>
    <label><span>Gap <output id="gapOut">0%</output></span>
      <input id="gap" type="range" min="0" max="25" step="0.5" value="0"></label>
    <label><span>Margin <output id="marginOut">0%</output></span>
      <input id="margin" type="range" min="0" max="25" step="0.5" value="0"></label>

    <h2>Level</h2>
    <label><span>Camera roll <output id="rollOut">0.0°</output></span>
      <input id="roll" type="range" min="-180" max="180" step="0.1" value="0"></label>
    <label><span>Lens A nudge <output id="nudgeAOut">0.0°</output></span>
      <input id="nudgeA" type="range" min="-10" max="10" step="0.1" value="0"></label>
    <label><span>Lens B nudge <output id="nudgeBOut">0.0°</output></span>
      <input id="nudgeB" type="range" min="-10" max="10" step="0.1" value="0"></label>
```

Wire each control to mutate `state` and call `render()`, mirroring the existing FOV handler.

- [ ] **Step 7: Verify in the browser**

Open `index.html`, drop `Testfiles/Sunscreen.insp`.

Expected:
- *Both* + *side by side* with gap 0 gives an exactly 2:1 canvas with two touching circles.
- *Stacked* gives 1:2.
- Raising the gap slider separates them with background between.
- Dragging **Camera roll** spins the two circles in **opposite** directions — if the horizon goes level in one, it goes level in the other too. This is the key thing to confirm.
- *Swap A and B* exchanges which circle is on the left.
- Rolling never reveals black inside a circle at 180°.

- [ ] **Step 8: Commit**

```bash
git add index.html gl.js app.js lens.js test/roll.test.js
git commit -m "feat: add mirrored roll, sensor selection and two-up composition"
```

---

### Task 7: Rim profile passes in GLSL, with JS parity

**Files:**
- Modify: `shaders.js`, `gl.js`
- Create: `test/parity.test.js`, `test/fixtures/parity-input.json`

**Interfaces:**
- Consumes: `Edge.buildRimProfile`, `Edge.blurProfileAngular`, `Edge.PROFILE_BINS`.
- Produces:
  - `Shaders.PROFILE_BUILD_FS: string`, `Shaders.PROFILE_BLUR_FS: string`
  - `GL.buildProfile(ctx, state, texIndex, rollRad): WebGLTexture` — renders the two profile passes into a `PROFILE_BINS × 1` RGBA16F texture and returns it.
  - `GL.readProfile(ctx, tex): Float32Array` — reads a profile texture back as `bins * 4` floats. Used by the parity check and by nothing else.

- [ ] **Step 1: Write the parity fixture and its test**

The GLSL and the JS must agree. Rather than run WebGL in Node, this test pins the **JS reference** against a checked-in fixture; a browser-side assertion (Step 6) compares the shader to the same fixture, so any drift in either implementation shows up.

Create `test/fixtures/parity-input.json` by running this once and saving the output:

```bash
node -e "
const Edge = require('./edge.js');
const sample = (theta, u) => {
  const s = 0.5 + 0.5 * Math.sin(theta * 3.0);
  return [s * u, s * 0.5, 1.0 - s];
};
const opts = {bins: 64, radialSamples: 8, uMin: 0.94, uMax: 1.0, knee: 0.45, exponent: 2};
const raw = Edge.buildRimProfile(sample, opts);
const blurred = Edge.blurProfileAngular(raw, opts.bins, 2.5);
console.log(JSON.stringify({opts, spreadBins: 2.5, expected: Array.from(blurred, v => +v.toFixed(6))}));
" > test/fixtures/parity-input.json
```

Create `test/parity.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Edge = require('../edge.js');

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'parity-input.json'), 'utf8')
);

// Must match the sampler baked into the fixture and into PARITY_SAMPLER in shaders.js.
function sample(theta, u) {
  const s = 0.5 + 0.5 * Math.sin(theta * 3.0);
  return [s * u, s * 0.5, 1.0 - s];
}

test('the JS rim profile still matches the checked-in parity fixture', () => {
  const raw = Edge.buildRimProfile(sample, fixture.opts);
  const blurred = Edge.blurProfileAngular(raw, fixture.opts.bins, fixture.spreadBins);
  for (let i = 0; i < fixture.expected.length; i++) {
    assert.ok(Math.abs(blurred[i] - fixture.expected[i]) < 1e-5,
      `index ${i}: ${blurred[i]} vs ${fixture.expected[i]}`);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails, then generate the fixture**

Run: `node --test test/`
Expected: FAIL — `ENOENT ... parity-input.json`

Then run the fixture generator from Step 1 and re-run. Expected: PASS.

- [ ] **Step 3: Add the two profile shaders to `shaders.js`**

```js
  const PROFILE_BUILD_FS = `#version 300 es
  precision highp float;
  uniform sampler2D uLens;
  uniform float uBins;
  uniform int   uRadialSamples;
  uniform float uUMin, uUMax;
  uniform float uKnee, uExponent;
  uniform float uCropFrac, uRoll;
  out vec4 fragColor;

  const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

  void main() {
    float bin = floor(gl_FragCoord.x);
    float theta = ((bin + 0.5) / uBins) * 6.283185307179586;
    float acc = 0.0;
    vec3 col = vec3(0.0);
    for (int j = 0; j < 64; j++) {
      if (j >= uRadialSamples) break;
      float u = uUMin + (uUMax - uUMin) * ((float(j) + 0.5) / float(uRadialSamples));
      float a = theta + uRoll;
      vec2 off = vec2(cos(a), sin(a)) * (u * uCropFrac * 0.5);
      vec3 c = texture(uLens, vec2(0.5) + off).rgb;
      acc += pow(max(0.0, dot(c, LUMA) - uKnee), uExponent);
      col += c;
    }
    float n = float(uRadialSamples);
    fragColor = vec4(acc / n, col / n);
  }`;

  const PROFILE_BLUR_FS = `#version 300 es
  precision highp float;
  uniform sampler2D uProfile;
  uniform float uBins;
  uniform float uSpreadBins;
  out vec4 fragColor;

  void main() {
    if (uSpreadBins <= 0.0) {
      fragColor = texelFetch(uProfile, ivec2(int(gl_FragCoord.x), 0), 0);
      return;
    }
    int radius = int(ceil(uSpreadBins * 3.0));
    float bin = floor(gl_FragCoord.x);
    vec4 acc = vec4(0.0);
    float wsum = 0.0;
    for (int k = -192; k <= 192; k++) {
      if (k < -radius || k > radius) continue;
      float w = exp(-float(k * k) / (2.0 * uSpreadBins * uSpreadBins));
      int j = int(mod(bin + float(k) + uBins, uBins));
      acc += texelFetch(uProfile, ivec2(j, 0), 0) * w;
      wsum += w;
    }
    fragColor = acc / wsum;
  }`;
```

Also add a `PARITY_SAMPLER` define used only by the browser-side check in Step 6 — a copy of `PROFILE_BUILD_FS` whose `texture(uLens, ...)` call is replaced by the analytic sampler from the fixture:

```js
  const PROFILE_BUILD_PARITY_FS = PROFILE_BUILD_FS.replace(
    'vec3 c = texture(uLens, vec2(0.5) + off).rgb;',
    'float sv = 0.5 + 0.5 * sin(theta * 3.0); vec3 c = vec3(sv * u, sv * 0.5, 1.0 - sv);'
  );
```

Export `PROFILE_BUILD_FS`, `PROFILE_BLUR_FS`, `PROFILE_BUILD_PARITY_FS`.

- [ ] **Step 4: Add profile rendering to `gl.js`**

Create the two programs in `GL.create`, plus a helper that allocates a `bins × 1` RGBA16F texture and framebuffer (requires the `EXT_color_buffer_float` extension — enable it in `create` and throw `Error('FLOAT_FBO_UNAVAILABLE')` if missing). Implement `buildProfile(ctx, state, texIndex, rollRad)` running build then blur into two ping-pong targets, and `readProfile(ctx, tex)` using `gl.readPixels` with `gl.FLOAT`.

- [ ] **Step 5: Wire the profile into the composite pass as a bindable texture**

`renderComposition` now calls `buildProfile` per circle and binds the result to texture unit 1 for the composite program. The composite shader does not use it yet; Task 8 consumes it.

- [ ] **Step 6: Add the browser-side parity assertion**

In `app.js`, expose `window.App.checkParity()` which renders `PROFILE_BUILD_PARITY_FS` + `PROFILE_BLUR_FS` with the fixture's `opts` and `spreadBins`, reads the result back, fetches `test/fixtures/parity-input.json`, and logs the maximum absolute difference.

Run it from the browser console: `await App.checkParity()`.
Expected: max difference below `2e-3` (half-float precision). If it exceeds that, the GLSL and JS have diverged — fix before continuing.

Note: `fetch` of a local JSON file fails under `file://`. For this check only, serve the directory with `npx --yes http-server -p 8080 .` or paste the fixture inline.

- [ ] **Step 7: Commit**

```bash
git add shaders.js gl.js app.js test/parity.test.js test/fixtures/parity-input.json
git commit -m "feat: add rim profile passes with JS/GLSL parity check"
```

---

### Task 8: The edge composite — terminator, dispersed glow, and haze

**Files:**
- Modify: `shaders.js`, `gl.js`, `app.js`, `index.html`

**Interfaces:**
- Consumes: the profile texture from Task 7, `Edge.PRESETS.x1classic`, `Edge.DISPERSION_RATIO`.
- Produces: an updated `Shaders.COMPOSITE_FS` consuming `state.edge` via uniforms: `uFalloffStart`, `uFalloffSoftness`, `uEdgeIntensity`, `uRingWidth`, `uDispersion`, `uHazeWidth`, `uHazeStrength`, `uTerminatorDesaturate`, `uTerminatorCoolShift`.

- [ ] **Step 1: Replace the composite fragment shader body**

In `shaders.js`, replace `COMPOSITE_FS`'s `main` with the full edge model. This mirrors `edge.js` exactly:

```glsl
  uniform sampler2D uProfile;
  uniform float uBins;
  uniform float uFalloffStart, uFalloffSoftness;
  uniform float uEdgeIntensity, uRingWidth, uDispersion;
  uniform float uHazeWidth, uHazeStrength;
  uniform float uTerminatorDesaturate, uTerminatorCoolShift;

  const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
  const vec3 COOL = vec3(0.82, 0.92, 1.12);   // cast the last of the image picks up

  float terminator(float u) {
    if (u <= uFalloffStart) return 1.0;
    if (u >= 1.0) return 0.0;
    float t = (u - uFalloffStart) / (1.0 - uFalloffStart);
    float eased = t * t * (3.0 - 2.0 * t);
    return pow(1.0 - eased, uFalloffSoftness);
  }

  float rimBell(float u, float peak, float width) {
    float t = (u - peak) / width;
    return exp(-t * t);
  }

  void main() {
    vec2 p = gl_FragCoord.xy - uCellSize * 0.5;
    float r = length(p);
    float u = r / uCircleRadius;
    float theta = atan(p.y, p.x);

    // --- image, with the terminator running it out at the lens edge ---
    vec3 img = vec3(0.0);
    if (u < 1.0) {
      img = sampleLens(u, theta);
      float term = terminator(u);
      float fade = 1.0 - term;
      img = mix(img, vec3(dot(img, LUMA)), fade * uTerminatorDesaturate);
      img = mix(img, img * COOL, fade * uTerminatorCoolShift);
      img *= term;
    }

    // --- rim glow, derived from the image next to it ---
    float bin = mod(theta / 6.283185307179586, 1.0) * uBins;
    vec4 prof = texture(uProfile, vec2((floor(bin) + 0.5) / uBins, 0.5));
    float intensity = prof.r * uEdgeIntensity;
    vec3 tint = prof.gba;
    float tmax = max(max(tint.r, tint.g), tint.b);
    tint = tmax > 0.0 ? tint / tmax : vec3(1.0);

    vec3 glow = vec3(
      rimBell(u, 1.0 - uDispersion, uRingWidth),
      rimBell(u, 1.0,               uRingWidth),
      rimBell(u, 1.0 + uDispersion, uRingWidth)
    ) * intensity * tint;

    float haze = rimBell(u, 1.0, uHazeWidth) * intensity * uHazeStrength;

    fragColor = vec4(img + glow + vec3(haze) * tint, 1.0);
  }
```

Delete the old early-return `if (u > 1.0)` — the glow lives outside `u = 1`, so the shader must keep shading out to the cell edge.

- [ ] **Step 2: Pass the edge uniforms in `gl.js`**

Extend the uniform block in `renderComposition` to set all nine edge uniforms from `state.edge`, plus `uBins` and `uProfile` (texture unit 1).

- [ ] **Step 3: Add the Edge control group to `index.html`**

```html
    <h2>Edge</h2>
    <label><span>Intensity <output id="edgeIntensityOut"></output></span>
      <input id="edgeIntensity" type="range" min="0" max="4" step="0.01"></label>
    <label><span>Ring width <output id="ringWidthOut"></output></span>
      <input id="ringWidth" type="range" min="0.002" max="0.06" step="0.001"></label>
    <label><span>Dispersion <output id="dispersionOut"></output></span>
      <input id="dispersion" type="range" min="0" max="0.05" step="0.001"></label>
    <label><span>Glow spread <output id="glowSpreadDegOut"></output></span>
      <input id="glowSpreadDeg" type="range" min="0" max="45" step="0.5"></label>
    <label><span>Highlight knee <output id="highlightKneeOut"></output></span>
      <input id="highlightKnee" type="range" min="0" max="1" step="0.01"></label>
    <label><span>Falloff start <output id="falloffStartOut"></output></span>
      <input id="falloffStart" type="range" min="0.6" max="0.99" step="0.005"></label>
    <label><span>Falloff softness <output id="falloffSoftnessOut"></output></span>
      <input id="falloffSoftness" type="range" min="0.3" max="4" step="0.05"></label>
    <button id="resetEdge" type="button">Reset to X1 classic</button>
```

- [ ] **Step 4: Wire the edge controls generically in `app.js`**

```js
  const EDGE_KEYS = ['edgeIntensity', 'ringWidth', 'dispersion', 'glowSpreadDeg',
                     'highlightKnee', 'falloffStart', 'falloffSoftness'];

  function applyEdgePreset() {
    state.edge = Object.assign({}, Edge.PRESETS.x1classic);
    for (const k of EDGE_KEYS) {
      document.getElementById(k).value = state.edge[k];
      document.getElementById(k + 'Out').textContent = state.edge[k];
    }
    render();
  }

  for (const k of EDGE_KEYS) {
    document.getElementById(k).addEventListener('input', (e) => {
      state.edge[k] = parseFloat(e.target.value);
      document.getElementById(k + 'Out').textContent = e.target.value;
      render();
    });
  }
  document.getElementById('resetEdge').addEventListener('click', applyEdgePreset);
  applyEdgePreset();
```

- [ ] **Step 5: Verify in the browser**

Drop `Testfiles/Sunscreen.insp`.

Expected, with the placeholder preset: a visible coloured rim whose brightness follows the content — strong where the circle borders bright sky, faint where it borders the dark stone wall — and which shows red/violet separation as **Dispersion** is raised. Setting **Intensity** to 0 must leave a clean dark terminator with no ring. The numbers will not match the X1 yet; Task 9 fixes that.

- [ ] **Step 6: Commit**

```bash
git add shaders.js gl.js app.js index.html
git commit -m "feat: render the dispersed lens edge"
```

---

### Task 9: Fit the X1 classic preset against the reference

**Files:**
- Create: `tools/fit-x1-edge.py`, `test/fixtures/x1-rim-profile.json`
- Modify: `edge.js`
- Modify: `test/edge.test.js`

**Interfaces:**
- Consumes: `Edge.terminator`, `Edge.rimBell`, `Edge.dispersionPeaks`.
- Produces: fitted numeric values in `Edge.PRESETS.x1classic`, and `test/fixtures/x1-rim-profile.json` containing the measured radial rim profile of `Testfiles/Outputs/Flat.jpg` as `{uSamples: number[], sky: {r,g,b}[], shadow: {r,g,b}[]}` — `sky` is the azimuth-averaged profile over the bright-sky azimuths (180°–300° in image coordinates), `shadow` over the dark-foliage azimuths (0°–90°).

- [ ] **Step 1: Write `tools/fit-x1-edge.py` to measure the reference**

The script reads `Testfiles/Outputs/Flat.jpg`, samples the RGB radial profile from `u = 0.80` to `u = 1.10` (where `u = 1.0` is the frame half-width) separately over the bright and dark azimuth ranges, writes `test/fixtures/x1-rim-profile.json`, then does a coarse grid search over `falloffStart`, `falloffSoftness`, `edgeIntensity`, `ringWidth`, `dispersion`, `hazeWidth`, `hazeStrength`, `terminatorDesaturate` and `terminatorCoolShift`, minimising RMS error between the model and the measured `sky` profile while requiring the model to also stay within tolerance on the `shadow` profile. It prints the fitted parameters as a JSON object and the final RMS.

Run: `python tools/fit-x1-edge.py`

- [ ] **Step 2: Write the failing test**

Append to `test/edge.test.js`:

```js
const fs = require('node:fs');
const path = require('node:path');

test('the X1 preset reproduces the measured reference rim profile', () => {
  const ref = JSON.parse(fs.readFileSync(
    path.join(__dirname, 'fixtures', 'x1-rim-profile.json'), 'utf8'));
  const p = Edge.PRESETS.x1classic;
  const peaks = Edge.dispersionPeaks(p.dispersion);

  // Reconstruct the model's rim for the bright-sky azimuths and compare.
  let sumSq = 0;
  for (let i = 0; i < ref.uSamples.length; i++) {
    const u = ref.uSamples[i];
    const term = Edge.terminator(u, p.falloffStart, p.falloffSoftness);
    const glow = {
      r: Edge.rimBell(u, peaks.r, p.ringWidth),
      g: Edge.rimBell(u, peaks.g, p.ringWidth),
      b: Edge.rimBell(u, peaks.b, p.ringWidth),
    };
    const haze = Edge.rimBell(u, 1.0, p.hazeWidth) * p.hazeStrength;
    for (const ch of ['r', 'g', 'b']) {
      const model = ref.skyBase[ch] * term + p.edgeIntensity * ref.skyTint[ch] * (glow[ch] + haze);
      const d = model - ref.sky[i][ch];
      sumSq += d * d;
    }
  }
  const rms = Math.sqrt(sumSq / (ref.uSamples.length * 3));
  assert.ok(rms < 0.06, `model RMS error ${rms.toFixed(4)} exceeds tolerance`);
});

test('the X1 preset starts its falloff near where the reference does', () => {
  assert.ok(Edge.PRESETS.x1classic.falloffStart > 0.85);
  assert.ok(Edge.PRESETS.x1classic.falloffStart < 0.95);
});

test('the X1 preset disperses the rim by a visible but small amount', () => {
  const d = Edge.PRESETS.x1classic.dispersion;
  assert.ok(d > 0.002 && d < 0.04, `dispersion ${d} is outside a plausible range`);
});
```

The fixture must therefore also carry `skyBase` and `skyTint` — the azimuth-averaged image colour just inside the falloff, and the normalised rim tint. Add both to the script's output in Step 1.

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test test/`
Expected: FAIL — the placeholder preset from Task 4 misses the reference, RMS above 0.06.

- [ ] **Step 4: Paste the fitted values into `edge.js`**

Replace the `PRESETS.x1classic` placeholder object with the JSON the script printed, keeping a comment recording that the values were fitted against `Testfiles/Outputs/Flat.jpg` and naming the script.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/`
Expected: PASS — all tests, including the RMS check.

- [ ] **Step 6: Verify in the browser**

Open `index.html`, drop `Testfiles/Sunscreen.insp`, select **Lens A only**. Compare the rim side by side with `Testfiles/Outputs/Flat.jpg` opened in an image viewer.

Expected: the sky-facing side of the circle carries a warm-to-violet dispersed rim; the wall-facing side is nearly black with only a faint haze. If the ring reads as a uniform halo all the way round, the profile texture is not reaching the shader — debug before continuing.

- [ ] **Step 7: Commit**

```bash
git add tools/fit-x1-edge.py edge.js test/edge.test.js test/fixtures/x1-rim-profile.json
git commit -m "feat: fit the X1 classic edge preset to the reference image"
```

---

### Task 10: Tone controls

**Files:**
- Modify: `shaders.js`, `gl.js`, `app.js`, `index.html`
- Create: `test/tone.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `Edge.applyTone(rgb: [number,number,number], tone: {exposureEv, contrast, saturation}): [number,number,number]` — the JS reference for the GLSL, and the thing the pass-through test asserts on.

- [ ] **Step 1: Write the failing test**

Create `test/tone.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Edge = require('../edge.js');

const NEUTRAL = { exposureEv: 0, contrast: 0, saturation: 0 };

test('neutral tone is an exact pass-through', () => {
  for (const c of [[0, 0, 0], [0.2, 0.5, 0.9], [1, 1, 1], [0.37, 0.37, 0.37]]) {
    assert.deepStrictEqual(Edge.applyTone(c, NEUTRAL), c);
  }
});

test('one stop of exposure doubles the signal', () => {
  const out = Edge.applyTone([0.25, 0.25, 0.25], { ...NEUTRAL, exposureEv: 1 });
  assert.ok(Math.abs(out[0] - 0.5) < 1e-9);
});

test('contrast pivots around mid grey', () => {
  const mid = Edge.applyTone([0.5, 0.5, 0.5], { ...NEUTRAL, contrast: 0.5 });
  assert.ok(Math.abs(mid[0] - 0.5) < 1e-9, 'mid grey must not move');
  const hi = Edge.applyTone([0.8, 0.8, 0.8], { ...NEUTRAL, contrast: 0.5 });
  assert.ok(hi[0] > 0.8, 'highlights must rise');
  const lo = Edge.applyTone([0.2, 0.2, 0.2], { ...NEUTRAL, contrast: 0.5 });
  assert.ok(lo[0] < 0.2, 'shadows must fall');
});

test('saturation leaves neutral colours neutral', () => {
  const out = Edge.applyTone([0.4, 0.4, 0.4], { ...NEUTRAL, saturation: 1 });
  assert.ok(Math.abs(out[0] - out[1]) < 1e-9 && Math.abs(out[1] - out[2]) < 1e-9);
});

test('full desaturation collapses to luma', () => {
  const out = Edge.applyTone([0.2, 0.6, 0.4], { ...NEUTRAL, saturation: -1 });
  assert.ok(Math.abs(out[0] - out[1]) < 1e-9 && Math.abs(out[1] - out[2]) < 1e-9);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/`
Expected: FAIL — `Edge.applyTone is not a function`

- [ ] **Step 3: Implement `applyTone` in `edge.js`**

```js
  function applyTone(rgb, tone) {
    if (tone.exposureEv === 0 && tone.contrast === 0 && tone.saturation === 0) {
      return rgb.slice ? rgb.slice() : [rgb[0], rgb[1], rgb[2]];
    }
    const gain = Math.pow(2, tone.exposureEv);
    const k = 1 + tone.contrast;
    const out = [];
    for (let i = 0; i < 3; i++) out[i] = (rgb[i] * gain - 0.5) * k + 0.5;
    const luma = LUMA.r * out[0] + LUMA.g * out[1] + LUMA.b * out[2];
    const s = 1 + tone.saturation;
    for (let i = 0; i < 3; i++) out[i] = luma + (out[i] - luma) * s;
    return out;
  }
```

Note the pass-through branch: it is what makes the neutral test pass exactly rather than within an epsilon, satisfying the global constraint.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/`
Expected: PASS.

- [ ] **Step 5: Mirror it in GLSL and add the controls**

In `COMPOSITE_FS`, add `uniform vec3 uTone;` (exposure EV, contrast, saturation) and apply the same maths to `img` immediately after `sampleLens`, **before** the terminator — tone belongs to the photograph, the edge is added on top.

Add to `index.html`:

```html
    <h2>Tone</h2>
    <label><span>Exposure <output id="exposureEvOut">0.00 EV</output></span>
      <input id="exposureEv" type="range" min="-3" max="3" step="0.01" value="0"></label>
    <label><span>Contrast <output id="contrastOut">0.00</output></span>
      <input id="contrast" type="range" min="-1" max="1" step="0.01" value="0"></label>
    <label><span>Saturation <output id="saturationOut">0.00</output></span>
      <input id="saturation" type="range" min="-1" max="1" step="0.01" value="0"></label>
```

Wire the three to `state.tone` and `render()`.

- [ ] **Step 6: Verify in the browser**

Expected: all three at zero looks identical to before this task (toggle by setting and resetting). Each slider does the obvious thing and the edge glow tracks the tone, since the profile is built from the same image.

- [ ] **Step 7: Commit**

```bash
git add edge.js shaders.js gl.js app.js index.html test/tone.test.js
git commit -m "feat: add exposure, contrast and saturation"
```

---

### Task 11: Horizon guide, drag-to-roll, and settings persistence

**Files:**
- Modify: `index.html`, `app.js`

**Interfaces:**
- Consumes: the render `state`.
- Produces: `App.saveSettings(): void`, `App.loadSettings(): void` — persist every field of `state` except `sourceName` and `sourceLensSize` to `localStorage` under the key `photo360.settings.v1`.

- [ ] **Step 1: Add the guide overlay**

Add a second, transparent `<canvas id="guides">` absolutely positioned over `#view` at the same CSS size, plus a checkbox `#showGuides`. Draw on it with the 2D context: a straight line through each circle centre at the lens's current roll angle, a faint circle at `u = 1`, and optional thirds. A straight line is correct — a horizon through the optical axis projects to a straight line in a fisheye.

Redraw the guides at the end of `render()`.

- [ ] **Step 2: Add drag-to-roll**

On `pointerdown` over `#stage`, record the angle from the nearest circle centre to the pointer; on `pointermove`, add the angular delta to `state.rollDeg` (negated when the grabbed circle is lens B, so the circle follows the pointer), clamp to ±180, update the slider, and `render()`. Release on `pointerup`. Use `setPointerCapture`.

- [ ] **Step 3: Add persistence**

`saveSettings` on every control change (debounced to 250 ms); `loadSettings` on startup before the first render, falling back silently to defaults if the stored JSON is missing, unparseable, or from an older key.

- [ ] **Step 4: Verify in the browser**

Expected: the guide line tracks roll on both circles and stays level relative to each lens's own rotation. Dragging on a circle spins the composition and moves the roll slider. Reloading the page restores every slider, and dropping the same file reproduces the previous look exactly.

- [ ] **Step 5: Commit**

```bash
git add index.html app.js
git commit -m "feat: add horizon guide, drag-to-roll and settings persistence"
```

---

### Task 12: Export

**Files:**
- Modify: `index.html`, `app.js`, `gl.js`

**Interfaces:**
- Consumes: `Lens.exportLayout`, `Lens.exportFilename`, `Lens.radiusForFov`, `GL.renderComposition`.
- Produces: `App.exportImage(opts: {format: 'jpeg'|'png', quality: number, padToSensorSquare: boolean}): Promise<void>`

- [ ] **Step 1: Add the Output control group**

```html
    <h2>Output</h2>
    <label><span>Format</span>
      <select id="format">
        <option value="jpeg">JPEG</option>
        <option value="png">PNG (lossless)</option>
      </select></label>
    <label><span>JPEG quality <output id="qualityOut">95</output></span>
      <input id="quality" type="range" min="60" max="100" step="1" value="95"></label>
    <label><span><input id="padToSensorSquare" type="checkbox">
      Pad to sensor square (upscales)</span></label>
    <div id="exportSize"></div>
    <button id="export" type="button">Export</button>
```

`#exportSize` continuously reports the pixel dimensions that will be written, so the native-sampling default is visible rather than implied.

- [ ] **Step 2: Compute the export size**

```js
  function exportGeometry() {
    const cropFrac = Lens.radiusForFov(state.fovDeg, state.thetaMaxDeg);
    const nativeDiameter = Math.round(state.sourceLensSize * cropFrac);
    const diameter = state.padToSensorSquare ? state.sourceLensSize : nativeDiameter;
    return Lens.exportLayout({
      circleDiameter: diameter,
      sensors: state.sensors,
      orientation: state.orientation,
      gapPx: Math.round(state.gapFrac * diameter),
      marginPx: Math.round(state.marginFrac * diameter),
    });
  }
```

At 180° on an 11904×5952 source this yields a 5100 px circle — native sampling, no invented resolution.

- [ ] **Step 3: Render at export size and write the file**

```js
  async function exportImage(opts) {
    const g = exportGeometry();
    const prevW = canvas.width, prevH = canvas.height;
    const prevStyle = [canvas.style.width, canvas.style.height];
    try {
      canvas.width = g.width;
      canvas.height = g.height;
      GL.renderComposition(ctx, state, g.width, g.height);
      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error('TOBLOB_FAILED'))),
          opts.format === 'png' ? 'image/png' : 'image/jpeg',
          opts.quality / 100
        );
      });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const out = opts.format === 'jpeg' ? Exif.reattach(bytes, state.sourceExif) : bytes;
      const label = state.sensors === 'both' ? (state.swap ? 'BA' : 'AB') : state.sensors;
      download(new Blob([out], { type: blob.type }),
        Lens.exportFilename(state.sourceName, label, state.fovDeg,
          opts.format === 'png' ? 'png' : 'jpg'));
    } catch (e) {
      fail(e.message === 'TOBLOB_FAILED'
        ? `The browser could not encode a ${g.width}x${g.height} image. ` +
          'Try PNG, a smaller FOV, or exporting one lens at a time.'
        : 'Export failed: ' + e.message);
    } finally {
      canvas.width = prevW; canvas.height = prevH;
      canvas.style.width = prevStyle[0]; canvas.style.height = prevStyle[1];
      render();
    }
  }

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
```

`Exif.reattach` arrives in Task 13; until then, stub it as `const Exif = { reattach: (b) => b };` inside `app.js` and delete the stub in Task 13.

- [ ] **Step 4: Verify in the browser**

Drop `Testfiles/Sunscreen.insp`, leave everything at defaults, export as JPEG.

Expected: a 5100×5100 file named `Sunscreen_A_180deg.jpg`. Switch to **Both** with gap 0: a 10200×5100 file named `Sunscreen_AB_180deg.jpg`. Tick **Pad to sensor square**: 5952×5952. Open each and confirm the edge renders at full resolution rather than being a scaled-up preview.

- [ ] **Step 5: Commit**

```bash
git add index.html app.js gl.js
git commit -m "feat: export at native resolution as JPEG or PNG"
```

---

### Task 13: EXIF passthrough

**Files:**
- Create: `exif.js`, `test/exif.test.js`
- Modify: `app.js`

**Interfaces:**
- Consumes: nothing.
- Produces: global/module `Exif` with:
  - `Exif.readTags(bytes: Uint8Array): {make: string, model: string, dateTimeOriginal: string}` — empty strings for anything absent.
  - `Exif.buildApp1(tags): Uint8Array` — a complete `FFE1` segment containing a minimal little-endian TIFF IFD0 with `Make` (0x010F), `Model` (0x0110), `DateTime` (0x0132) and an ExifIFD pointer (0x8769) carrying `DateTimeOriginal` (0x9003).
  - `Exif.reattach(jpegBytes: Uint8Array, app1: Uint8Array|null): Uint8Array` — inserts `app1` directly after the SOI marker, dropping any APP1 the encoder already wrote. Returns `jpegBytes` unchanged when `app1` is null.

- [ ] **Step 1: Write the failing test**

Create `test/exif.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Exif = require('../exif.js');

const SOURCE = path.join(__dirname, '..', 'Testfiles', 'Sunscreen.insp');

test('it reads the camera identity out of a real .insp file', () => {
  const tags = Exif.readTags(new Uint8Array(fs.readFileSync(SOURCE)));
  assert.strictEqual(tags.make.trim(), 'Arashi Vision');
  assert.strictEqual(tags.model.trim(), 'Insta360 X5');
  assert.match(tags.dateTimeOriginal, /^2026:05:14 11:37:39/);
});

test('a built APP1 segment is well formed', () => {
  const app1 = Exif.buildApp1({
    make: 'Arashi Vision', model: 'Insta360 X5', dateTimeOriginal: '2026:05:14 11:37:39',
  });
  assert.strictEqual(app1[0], 0xff);
  assert.strictEqual(app1[1], 0xe1);
  const declared = (app1[2] << 8) | app1[3];
  assert.strictEqual(declared, app1.length - 2, 'segment length must exclude the marker');
  assert.strictEqual(
    Buffer.from(app1.slice(4, 10)).toString('latin1'), 'Exif\0\0');
});

test('tags survive a build and re-read round trip', () => {
  const tags = {
    make: 'Arashi Vision', model: 'Insta360 X5', dateTimeOriginal: '2026:05:14 11:37:39',
  };
  const app1 = Exif.buildApp1(tags);
  // wrap it in a minimal JPEG: SOI + APP1 + EOI
  const jpeg = new Uint8Array(2 + app1.length + 2);
  jpeg.set([0xff, 0xd8], 0);
  jpeg.set(app1, 2);
  jpeg.set([0xff, 0xd9], 2 + app1.length);
  const back = Exif.readTags(jpeg);
  assert.strictEqual(back.make, tags.make);
  assert.strictEqual(back.model, tags.model);
  assert.strictEqual(back.dateTimeOriginal, tags.dateTimeOriginal);
});

test('reattach puts the segment straight after SOI', () => {
  const app1 = Exif.buildApp1({ make: 'M', model: 'X', dateTimeOriginal: '2026:01:01 00:00:00' });
  const encoded = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x03, 0x00, 0xff, 0xd9]);
  const out = Exif.reattach(encoded, app1);
  assert.strictEqual(out[0], 0xff);
  assert.strictEqual(out[1], 0xd8);
  assert.strictEqual(out[2], 0xff);
  assert.strictEqual(out[3], 0xe1);
  assert.strictEqual(out.length, encoded.length + app1.length);
});

test('reattach strips an APP1 the encoder already wrote', () => {
  const mine = Exif.buildApp1({ make: 'M', model: 'X', dateTimeOriginal: '2026:01:01 00:00:00' });
  const theirs = new Uint8Array([0xff, 0xe1, 0x00, 0x04, 0x41, 0x42]);
  const encoded = new Uint8Array(2 + theirs.length + 2);
  encoded.set([0xff, 0xd8], 0);
  encoded.set(theirs, 2);
  encoded.set([0xff, 0xd9], 2 + theirs.length);
  const out = Exif.reattach(encoded, mine);
  assert.strictEqual(out.length, 2 + mine.length + 2);
});

test('reattach with no segment is a no-op', () => {
  const encoded = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  assert.strictEqual(Exif.reattach(encoded, null), encoded);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/`
Expected: FAIL — `Cannot find module '../exif.js'`

- [ ] **Step 3: Implement `exif.js`**

Use the standard UMD wrapper. `readTags` walks JPEG markers from offset 2 looking for `FFE1` with the `Exif\0\0` signature, reads the TIFF header's byte order and IFD0 offset, scans IFD0 for 0x010F, 0x0110, 0x0132 and 0x8769, follows the ExifIFD pointer for 0x9003, and decodes ASCII values (inline when the 4-byte value field suffices, otherwise at the stored offset). `buildApp1` writes a little-endian (`II*\0`) TIFF with a four-entry IFD0 and a one-entry ExifIFD, packing the ASCII strings after the IFDs. `reattach` skips an existing APP1 after SOI, then splices.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/`
Expected: PASS.

- [ ] **Step 5: Wire it into the app**

In `app.js`: delete the `Exif` stub from Task 12, store `state.sourceExif = Exif.buildApp1(Exif.readTags(new Uint8Array(buf)))` during `loadFile`, and confirm `exportImage` passes it to `Exif.reattach`.

- [ ] **Step 6: Verify**

Export a JPEG and inspect it:

```bash
python -c "
from PIL import Image
im = Image.open(r'<path to the exported file>')
print(im.size, {k: v for k, v in im.getexif().items()})
"
```

Expected: the exported file reports Make `Arashi Vision`, Model `Insta360 X5`, and the original capture time.

- [ ] **Step 7: Commit**

```bash
git add exif.js app.js test/exif.test.js
git commit -m "feat: carry camera identity and capture time into exports"
```

---

### Task 14: Full verification pass and README

**Files:**
- Create: `README.md`, `tools/verify-rim.py`

- [ ] **Step 1: Run the whole test suite**

Run: `node --test test/`
Expected: every test passes. Record the counts; do not proceed past a failure.

- [ ] **Step 2: Export all four test files**

Open `index.html`. For each of `Sunscreen.insp`, `IMG_20260511_094146_00_004.insp`, `IMG_20260511_094316_00_005.insp` and `IMG_20260512_143942_00_011.insp`, export lens A and lens B at 180° with the X1 preset into a scratch directory.

Confirm for each: no doubled content at the rim, correct pixel dimensions (5100² for the full-size files, 2523² for the 5888×2944 one), and a rim whose brightness varies with the adjacent content.

- [ ] **Step 3: Compare the rendered rim against the reference numerically**

Write `tools/verify-rim.py`, which measures the same radial rim profile from an exported file as `fit-x1-edge.py` measures from `Flat.jpg` and prints, per file, the RMS difference between the two normalised profiles over the bright azimuths.

Run: `python tools/verify-rim.py <exported files...>`
Expected: RMS below 0.10 for each. A larger value means the shipped shader is not reproducing the fitted model — investigate before finishing.

- [ ] **Step 4: Write `README.md`**

Cover: what the tool does and why the X5 needs it; that it is a static page with no build step and no upload; how to open it; the meaning of every control; the calibration constant `THETA_MAX_DEG = 105` with a note on how it was measured and how to change it; export sizing and the native-sampling default; how to run the tests; and the browser requirement (WebGL2 plus `EXT_color_buffer_float`).

- [ ] **Step 5: Commit**

```bash
git add README.md tools/verify-rim.py
git commit -m "docs: add README and rim verification tool"
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: purpose and measured facts → Tasks 1 and 9; architecture and file structure → the File Structure table; concentric crop and lens model → Task 1; loading and per-half decode → Task 5; roll mirroring → Task 6; the three edge passes → Tasks 7 and 8; the X1 preset fit → Task 9; UI groups → Tasks 5, 6, 8, 10, 11; export sizing, format, filenames → Task 12; EXIF → Task 13; the testing section → Tasks 1–4, 7, 9, 10, 13 and the verification in Task 14; the risk table → the `maxTextureSize` warning in Task 5, the `TOBLOB_FAILED` handler in Task 12, and the adjustable `thetaMaxDeg` threaded through every `Lens` call.

**Type consistency.** `state` is defined once in Task 6 and every later task reads the same field names. `Lens.rollFor`, `Lens.exportLayout`, `Lens.exportFilename`, `Edge.terminator`, `Edge.rimBell`, `Edge.dispersionPeaks`, `Edge.applyTone`, `Exif.readTags`, `Exif.buildApp1` and `Exif.reattach` are each defined in exactly one task and used under those exact names afterwards. `GL.renderPreview` exists only in Task 5 and is explicitly deleted in Task 6, which is called out in that task's steps.

**Known forward references, each resolved in its own step:** `Exif.reattach` is stubbed in Task 12 Step 3 and the stub is deleted in Task 13 Step 5. `Edge.PRESETS.x1classic` ships placeholder numbers in Task 4 and is overwritten with fitted values in Task 9 Step 4.

---

### Task 15: Stacked 1:2 input and per-camera lens calibration

**Added 2026-09-12**, after the user supplied two Insta360 ONE X reference files and asked that
the tool accept them as input, not merely use them as references for the edge look.

**Files:**
- Modify: `lens.js`, `test/lens.test.js`, `app.js`, `README.md` (if it exists by then)
- Test: `test/lens.test.js`

**Interfaces:**
- Consumes: `Exif.readJpegSize`, `Lens.detectLayout`.
- Produces:
  - `Lens.detectLayout(width, height)` gains a **stacked dual** case: aspect 1:2 → `{kind: 'dual', lensSize: width, lenses: [{x: 0, y: 0}, {x: 0, y: width}]}`. The existing 2:1 and 1:1 cases are unchanged.
  - `Lens.CALIBRATIONS: {[model: string]: number}` mapping an EXIF camera model to its `thetaMaxDeg`.
  - `Lens.calibrationFor(model: string|null): {thetaMaxDeg: number, model: string, confident: boolean}` — falls back to the X5 default with `confident: false` when the model is unknown.

**Why this task exists:** the two ONE X files are stacked 1:2, which `detectLayout` rejects as
unsupported. Accepting them also means the FOV slider's degree labels are only honest if the
calibration follows the camera: the two bodies have materially different lenses.

**Measured calibration** (same overlap-correlation method as the X5, run on
`Testfiles/Outputs/IMG_20210605_193319_00_019.jpg`):

| Camera | EXIF `Model` | θmax | Full FOV | 180° at | Confidence |
|---|---|---|---|---|---|
| Insta360 X5 | `Insta360 X5` | 105° | 210° | 0.857 R | Good — three files agree at 104–107° |
| Insta360 ONE X | `Insta360 One2` | 112.5° | 225° | 0.800 R | **Provisional** — one usable file, peak correlation 0.60 |

The ONE X figure is a single-file estimate and must be presented as such: the other ONE X
reference has a circle clipped by its frame, so its true circle radius cannot be recovered and
it cannot corroborate the fit. Do not present 112.5° with the same confidence as 105°.

- [ ] **Step 1: Write the failing tests**

Append to `test/lens.test.js`:

```js
test('a stacked 1:2 file is detected as dual fisheye', () => {
  const l = Lens.detectLayout(1520, 3040);
  assert.strictEqual(l.kind, 'dual');
  assert.strictEqual(l.lensSize, 1520);
  assert.deepStrictEqual(l.lenses, [{ x: 0, y: 0 }, { x: 0, y: 1520 }]);
});

test('the full-size stacked reference is detected as dual fisheye', () => {
  const l = Lens.detectLayout(3040, 6080);
  assert.strictEqual(l.kind, 'dual');
  assert.strictEqual(l.lensSize, 3040);
  assert.deepStrictEqual(l.lenses, [{ x: 0, y: 0 }, { x: 0, y: 3040 }]);
});

test('side-by-side detection is unchanged by the stacked case', () => {
  const l = Lens.detectLayout(11904, 5952);
  assert.strictEqual(l.kind, 'dual');
  assert.deepStrictEqual(l.lenses, [{ x: 0, y: 0 }, { x: 5952, y: 0 }]);
});

test('the X5 calibration is the measured 105 degrees', () => {
  const c = Lens.calibrationFor('Insta360 X5');
  assert.strictEqual(c.thetaMaxDeg, 105);
  assert.strictEqual(c.confident, true);
});

test('the ONE X calibration is applied but flagged as provisional', () => {
  const c = Lens.calibrationFor('Insta360 One2');
  assert.strictEqual(c.thetaMaxDeg, 112.5);
  assert.strictEqual(c.confident, false);
});

test('an unknown camera falls back to the X5 default, unconfidently', () => {
  const c = Lens.calibrationFor('Some Other Camera');
  assert.strictEqual(c.thetaMaxDeg, Lens.THETA_MAX_DEG);
  assert.strictEqual(c.confident, false);
});

test('a missing model falls back the same way', () => {
  assert.strictEqual(Lens.calibrationFor(null).thetaMaxDeg, Lens.THETA_MAX_DEG);
});

test('the two calibrations put 180 degrees at different crop radii', () => {
  const x5 = Lens.radiusForFov(180, Lens.calibrationFor('Insta360 X5').thetaMaxDeg);
  const one = Lens.radiusForFov(180, Lens.calibrationFor('Insta360 One2').thetaMaxDeg);
  assert.ok(Math.abs(x5 - 90 / 105) < 1e-9);
  assert.ok(Math.abs(one - 0.8) < 1e-9);
  assert.ok(one < x5, 'the wider ONE X lens must crop deeper for the same FOV');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — stacked detection returns `unsupported`; `Lens.calibrationFor` is not a function.

- [ ] **Step 3: Implement in `lens.js`**

Extend `detectLayout` with the stacked branch (guarding that the 1:1 case is tested before
either 2:1 or 1:2, so a square image cannot fall into a dual branch), and add:

```js
  // theta-max per camera body, measured by correlating the two lenses' overlap
  // annuli. The X5 figure is corroborated by three files; the ONE X figure comes
  // from a single usable reference, so it is applied but flagged unconfident.
  const CALIBRATIONS = {
    'Insta360 X5': { thetaMaxDeg: 105, confident: true },
    'Insta360 One2': { thetaMaxDeg: 112.5, confident: false },
  };

  function calibrationFor(model) {
    const key = (model || '').replace(/\0+$/, '').trim();
    const hit = CALIBRATIONS[key];
    if (hit) return { thetaMaxDeg: hit.thetaMaxDeg, model: key, confident: hit.confident };
    return { thetaMaxDeg: THETA_MAX_DEG, model: key, confident: false };
  }
```

Note the trailing-NUL strip: EXIF ASCII values are NUL-padded in the real files.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, with the count risen by 8.

- [ ] **Step 5: Wire it into `app.js`**

On load, read the camera model from the source file's EXIF (`exif.js` already parses JPEG
markers; extend it to expose `Model` if it does not already, or reuse `Exif.readTags` once
Task 13 lands — whichever exists at the time), set `state.thetaMaxDeg` from
`Lens.calibrationFor`, and show the camera and calibration in the UI near the FOV readout.

When `confident` is false, say so plainly in the UI — e.g. *"Insta360 ONE X — 225° lens
(provisional calibration; adjust below if the 180° crop looks wrong)"* — and make sure the
advanced `thetaMaxDeg` override is reachable. Never present a provisional number as measured
fact.

- [ ] **Step 6: Verify in the browser**

Serve over HTTP and load each of: `Testfiles/Sunscreen.insp` (2:1), 
`Testfiles/Outputs/IMG_20210605_193319_00_019.jpg` (1:2 stacked), and
`Testfiles/Outputs/IMG_20210721_192852_00_141.jpg` (1:2 stacked).

Expected: all three load; the stacked files produce two circles; the FOV readout and
calibration line reflect the right camera for each; the roll mirror still behaves correctly on
the stacked files (the ONE X lenses are back-to-back with the same mirrored azimuth
relationship — measured offset 183°, mirrored).

Report the detected layout, lens size, calibration and duplication readout for each file.

- [ ] **Step 7: Commit**

```bash
git add lens.js test/lens.test.js app.js
git commit -m "feat: accept stacked 1:2 dual fisheye and calibrate per camera"
```

---

### Task 16: Uncompressed DNG input with per-lens white balance

**Added 2026-09-12**, after the user supplied three Insta360 ONE X raw files and asked to be able
to set white balance separately for them.

**Files:**
- Create: `dng.js`, `test/dng.test.js`
- Modify: `shaders.js`, `gl.js`, `app.js`, `index.html`, `README.md`
- Test: `test/dng.test.js`

**Interfaces:**
- Consumes: `Lens.detectLayout`, `Lens.calibrationFor`, `GL.renderComposition`.
- Produces:
  - `Dng.parse(bytes)` returning `{width, height, bitsPerSample, cfaPattern, blackLevel, whiteLevel, asShotNeutral, camToSrgb, stripOffset, stripByteCount, model, dateTimeOriginal}` or `null` when the file is not a DNG this decoder supports, so the caller can fall back to the JPEG path.
  - `Dng.lastRejectionReason()` returning a human-readable explanation of the most recent `null`, for the UI.
  - `GL.uploadBayer(ctx, index, plane, width, height)` uploading a raw CFA plane as a single-channel integer texture.
  - `state.rawWhiteBalance` as `{A: [r, g, b], B: [r, g, b]}` or `null`, and `state.rawWbLinked` as a boolean.

**Why this is tractable:** these files are the easy case, confirmed by direct inspection of all
three. They are **uncompressed** (`Compression = 1`), so no lossless-JPEG decoder is needed — the
Bayer plane is a plain strip whose byte count is exactly `width * height * 2`.

| Property | Value (identical across all three files) |
|---|---|
| Dimensions | 3040 x 6080 — **1:2 stacked**, two 3040-square circles |
| Model | `Insta360 One2` (the ONE X) |
| Compression | `1` — uncompressed |
| BitsPerSample / SamplesPerPixel | 16 / 1 |
| PhotometricInterpretation | 32803 (CFA) |
| CFAPattern | `(1, 0, 2, 1)` = GRBG |
| BlackLevel / WhiteLevel | 1026 / 16383 |
| AsShotNeutral | present, varies per shot (0.4995 / 0.5049 / 0.5032) |
| StripByteCounts | 36966400 = 3040 x 6080 x 2 exactly |

The stacked-1:2 geometry and the ONE X calibration already exist from Task 15, so this task adds
**only** the decode and the white balance. The existing `state.thetaMaxDeg` path handles the rest.

**User decisions (asked and answered):**
- **Per-lens white balance, independent**, seeded from the file's `AsShotNeutral`, with a link
  toggle to move both together. The motivating case is one lens in sun and the other in shade,
  which a single white balance cannot fix.
- **Neutral render, finish in Lightroom**: demosaic, white balance, the camera's colour matrix,
  plain sRGB gamma. **No creative tone curve.**

**Design constraint that makes white balance live:** upload the raw CFA plane to the GPU as a
single-channel texture and do demosaic, white balance, colour matrix and gamma **in the shader**.
White balance then costs nothing to change. Do not demosaic on the CPU and re-upload per change.

- [ ] **Step 1: Write the failing parser tests**

Create `test/dng.test.js`. These read the real files, which are git-ignored — note that in the
file, as `test/exif.test.js` already does.

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Dng = require('../dng.js');

const DIR = path.join(__dirname, '..', 'Testfiles');
const FILES = [
  'IMG_20180101_044910_00_030.dng',
  'IMG_20240825_174323_00_010.dng',
  'IMG_20240825_174907_00_020.dng',
];

function load(name) {
  return new Uint8Array(fs.readFileSync(path.join(DIR, name)));
}

test('it parses the geometry of every supplied ONE X raw', () => {
  for (const name of FILES) {
    const d = Dng.parse(load(name));
    assert.ok(d, name + ' should parse');
    assert.strictEqual(d.width, 3040);
    assert.strictEqual(d.height, 6080);
    assert.strictEqual(d.bitsPerSample, 16);
  }
});

test('it reports the sensor calibration needed to linearise', () => {
  const d = Dng.parse(load(FILES[1]));
  assert.strictEqual(d.blackLevel, 1026);
  assert.strictEqual(d.whiteLevel, 16383);
  assert.deepStrictEqual(Array.from(d.cfaPattern), [1, 0, 2, 1]);
});

test('the strip is exactly an uncompressed 16-bit plane', () => {
  const d = Dng.parse(load(FILES[1]));
  assert.strictEqual(d.stripByteCount, d.width * d.height * 2);
});

test('it reads the as-shot white balance, which differs per shot', () => {
  const a = Dng.parse(load(FILES[0])).asShotNeutral;
  const b = Dng.parse(load(FILES[1])).asShotNeutral;
  for (const wb of [a, b]) {
    assert.strictEqual(wb.length, 3);
    assert.ok(Math.abs(wb[1] - 1) < 1e-6, 'green is the reference channel and should be 1');
    assert.ok(wb[0] > 0.3 && wb[0] < 0.8, 'red multiplier out of plausible range: ' + wb[0]);
  }
  assert.notDeepStrictEqual(a, b, 'these two shots have different as-shot white balance');
});

test('it identifies the camera so the ONE X calibration applies', () => {
  assert.strictEqual(Dng.parse(load(FILES[1])).model, 'Insta360 One2');
});

test('a non-DNG returns null rather than throwing', () => {
  assert.strictEqual(Dng.parse(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0])), null);
  assert.strictEqual(Dng.parse(new Uint8Array(0)), null);
});
```

Add one more test of your own for the rejection path: build a minimal little-endian TIFF in the
test whose `Compression` tag is 7 (JPEG), assert `Dng.parse` returns `null`, and assert
`Dng.lastRejectionReason()` mentions compression. Write that header bytes-in-test rather than
adding a test-only export to `dng.js`.

- [ ] **Step 2: Run to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../dng.js'`

- [ ] **Step 3: Implement `dng.js`**

Same UMD-ish wrapper as the other modules, attaching `root.Dng`. Pure bytes — no DOM, no WebGL,
no file I/O.

Parse the TIFF header (`II`/`MM`, honour both), walk IFD0, and read the tags in the table above.
DNG puts the CFA data in IFD0 for these files, but real-world DNGs often use SubIFDs — follow tag
330 when IFD0's `PhotometricInterpretation` is not 32803, and take the first SubIFD that is.
Bound every read against the buffer length exactly as `exif.js` does; an earlier review fuzzed
that parser with truncated and junk input and this must meet the same bar.

**Reject rather than guess.** Return `null` and record a reason when: compression is anything but
1, bits per sample is not 16, samples per pixel is not 1, the photometric interpretation is not
CFA, or the strip byte count does not equal `width * height * 2`. Mis-decoding a raw file
silently is far worse than declining it.

Compute `camToSrgb` on the CPU here: DNG's `ColorMatrix1` maps **XYZ to camera**, so it must be
inverted and chained with the XYZ-to-sRGB matrix. Do that once at parse time and expose the
resulting 3x3 — never invert per fragment.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test`
Expected: PASS, count risen by 7.

- [ ] **Step 5: Upload the CFA plane and demosaic in the shader**

In `gl.js`, add `uploadBayer` creating an `R16UI` texture (`gl.R16UI` / `gl.RED_INTEGER` /
`gl.UNSIGNED_SHORT`, `NEAREST` filtering — integer textures cannot be linearly filtered) from the
lens's half of the plane. Split the stacked frame into two 3040-square planes, matching
`Lens.detectLayout`'s stacked arrangement.

In `shaders.js`, add a raw sampling path used in place of `sampleLensAt` when the source is raw:

1. **Demosaic** with bilinear interpolation appropriate to the GRBG pattern, using `texelFetch`,
   which needs no filtering.
2. **Linearise**: `(value - blackLevel) / (whiteLevel - blackLevel)`, clamped at zero.
3. **White balance**: divide by the per-lens neutral triple (green is 1, so this is a red and blue
   gain). This is the control the user asked for and it must be a uniform, not baked in.
4. **Colour matrix**: apply `camToSrgb` from `dng.js`.
5. **Gamma**: plain sRGB transfer function. No creative curve.

The existing tone controls, the terminator and the rim glow apply on top of this exactly as they
do for JPEG sources — the raw path replaces only how a pixel is fetched and coloured, so the rim
profile still measures the rendered image.

- [ ] **Step 6: Wire the UI**

`app.js`: when `Dng.parse` succeeds, take the geometry from it rather than `Exif.readJpegSize`,
seed `state.rawWhiteBalance.A` and `.B` from `asShotNeutral`, and set the calibration from the
parsed `model` through `Lens.calibrationFor`, falling back to the stacked-layout inference Task 15
added. When `Dng.parse` returns `null` for a file whose name ends `.dng`, show
`Dng.lastRejectionReason()` rather than a generic failure.

`index.html`: a **White balance** group, shown only for raw sources, with per-lens red and blue
multipliers (or temperature/tint derived from them — implementer's choice, but say which and
why), a **Link A and B** checkbox defaulting to on, and a **Reset to as-shot** button. When
linked, moving either lens's control moves both.

Persist the white balance through `settings.js`'s existing mechanism, range-validated like every
other numeric — but **`AsShotNeutral` from a freshly loaded file must win over a stored value**,
the same precedence Task 15 established for `thetaMaxDeg`.

- [ ] **Step 7: Default the output layout to the source's arrangement**

A finding handed over from Task 14: the output Layout control is independent of the source file's
own arrangement, so a stacked source exports side-by-side by default. With raw files also being
stacked, fix the default: on load, set `state.orientation` to match the detected arrangement.
The control stays free afterwards; this is a default, not a constraint.

- [ ] **Step 8: Verify in the browser**

Serve over HTTP and load each of the three `.dng` files plus one `.insp` and one ONE X `.jpg` to
confirm nothing regressed. Report per file: parsed geometry, camera, calibration and confidence,
the as-shot white balance, and the exported dimensions.

Check specifically:
- the demosaic produces no visible maze or zipper artefacts along high-contrast edges — sample a
  region across the horizon and report the values;
- changing a white-balance control visibly changes the render **without re-decoding** (time it);
- the two lenses can be given genuinely different white balance, and the link toggle couples them;
- a neutral subject renders neutral at the as-shot white balance — find a grey area and report R,
  G and B;
- an `.insp` file still renders identically to before this task.

- [ ] **Step 9: Update the README and commit**

Document raw support: which DNGs are accepted (uncompressed, 16-bit, CFA) and that others are
declined with a reason rather than mis-decoded; that the render is deliberately neutral with no
creative curve; and that white balance is per lens, seeded from the file and overridable.

```bash
git add dng.js test/dng.test.js shaders.js gl.js app.js index.html README.md
git commit -m "feat: decode uncompressed DNG with per-lens white balance"
```

---

### Task 17: Kelvin/tint white balance, and the swap + single-lens fix

**Added 2026-09-27** at the user's request: white balance must be a classic Kelvin slider plus
tint, with the Kelvin control logarithmic. Also closes the residual left by the final review.

**Files:**
- Create: `wb.js`, `test/wb.test.js`
- Modify: `app.js`, `index.html`, `settings.js`, `test/settings.test.js` (append only), `README.md`

**Interfaces:**
- Produces global/module `Wb`:
  - `Wb.kelvinTintToXy(kelvin, tint): {x, y}`
  - `Wb.xyToKelvinTint(x, y): {kelvin, tint}`
  - `Wb.neutralFromKelvinTint(kelvin, tint, colorMatrix1): [r, g, b]` — camera-space neutral, normalised so g = 1, directly usable as the existing per-lens white-balance uniform.
  - `Wb.kelvinTintFromNeutral(neutral, colorMatrix1): {kelvin, tint}` — the inverse, used to seed the sliders from `AsShotNeutral`.
  - `Wb.sliderToKelvin(s)` / `Wb.kelvinToSlider(k)` and `Wb.sliderToTint(s)` / `Wb.tintToSlider(t)` — the UI mappings.
- `state.rawWb: {A: {kelvin, tint}, B: {kelvin, tint}} | null` replaces `state.rawWhiteBalance`; the camera neutral fed to the shader is derived from it.

**Colour science (follow this; it is the DNG/Adobe convention):**
1. Kelvin → chromaticity on the Planckian locus using a published approximation valid for
   1667–25000 K (Kim et al. cubic, or Krystek). State which.
2. Tint displaces the point **perpendicular to the locus in CIE 1960 (u, v)**, with
   `Δuv = tint / 3000` (Adobe's scale: ±150 ≈ ±0.05 Duv). **Positive tint = magenta**, negative =
   green, matching Lightroom.
3. (x, y) → XYZ with Y = 1 → camera neutral = `ColorMatrix1 · XYZ` (DNG's ColorMatrix1 maps
   XYZ → camera; do **not** invert here) → normalise so green = 1.
4. Inverse: camera neutral → XYZ via the inverse of `ColorMatrix1` → (x, y) → nearest (K, tint)
   by Robertson's method or a bounded 1-D search along the locus. Must round-trip.

**Slider mappings:**
- Kelvin: logarithmic, 2000–12000 K. `K = 2000 · 6^(s)` for `s ∈ [0, 1]`. The readout shows K,
  and typing a Kelvin value into it must set the slider through the inverse.
- Tint: signed, −150…+150. A logarithmic scale is undefined across zero, so use a curve that is
  finer near zero and symmetric: `tint = 150 · s · |s|` for `s ∈ [−1, 1]`. Readout shows the
  signed integer, and typing a value into it must set the slider through the inverse.

**Tests (TDD, write first):**
- Kelvin → xy lands on published locus points within 0.002 (e.g. 2856 K ≈ Illuminant A,
  6504 K ≈ D65 region — use tabulated Planckian values, not D-series daylight).
- Tint 0 stays on the locus; positive tint moves toward magenta (v decreases), negative toward
  green, both by the expected Duv.
- `kelvinTintFromNeutral(neutralFromKelvinTint(K, t, M), M)` round-trips within 20 K and 1 tint
  unit across 2500–10000 K and −100…+100, using the real `ColorMatrix1` from a test DNG.
- The real `AsShotNeutral` of each of the three DNGs maps to a plausible daylight-ish Kelvin
  (report the three values; they should sit roughly 4500–6500 K for outdoor shots).
- Slider mappings are monotonic, hit their endpoints exactly, and invert exactly.
- Swap fix (below): a 1:1 descriptor forces `swap = false`.

**UI:** per-lens Kelvin and tint sliders with editable readouts, the existing **Link A and B**
toggle (linked by default), and **Reset to as-shot**, which re-derives K/tint from
`AsShotNeutral`. When linked, moving either lens's control moves both.

**Persistence:** `settings.js` persists `rawWb` range-validated (kelvin 2000–12000, tint
−150…150) in place of `rawWhiteBalance`; a freshly loaded file's as-shot values still win over
stored ones. Old stored `rawWhiteBalance` blobs must be ignored gracefully, not crash.

**Swap + single-lens residual (from the final review):**
- A 1:1 file loaded with `swap = true` renders no circle and exports a blank `_B_` image, because
  `sensors` is forced to `'A'` but `swap` is left on and `lensTextureIndex` then points at the
  released slot 1. Fix: when `lensCount === 1`, set `swap = false` in the load patch and disable
  the swap checkbox; re-enable it for dual files. Test it.
- In `loadFile`, set `builtTextures = null` immediately after `GL.commitLenses(...)`, so a throw in
  anything after the commit cannot delete textures that are now live.

**Verification:** load all three DNGs; report as-shot K/tint per file; confirm the render at the
seeded K/tint is identical to before this task (the neutral fed to the shader must equal
`AsShotNeutral`); drag Kelvin and confirm warmer/cooler in the expected direction; confirm tint
direction; confirm per-lens independence and linking; confirm the 1:1 + swap case now renders.

---

### Task 18: Darkroom UI and the back-to-back-circles logo

**Added 2026-09-27** at the user's request. Direction chosen by the user: **Darkroom / pro tool**
— near-black, neutral greys so nothing biases colour judgement, one warm accent, dense precise
controls in the spirit of Lightroom or Capture One. Logo chosen: **two back-to-back circles** —
two overlapping circles with the shared region cut away, showing the duplicated content the tool
removes.

**Files:**
- Create: `logo.svg` (standalone source of the mark)
- Modify: `index.html`, `app.js` (UI wiring only), `README.md` (add the logo at the top)

**Requirements:**
- **Neutrality is a hard constraint.** Everything around the image must be achromatic — the
  canvas surround and all chrome in neutral greys (equal R=G=B), because a tinted surround biases
  white-balance judgement. The single accent colour is for interactive state only (focus, active
  slider, primary button), never large areas.
- **Header bar**: the logo, the product name, the current file name, and a persistent **Open…**
  button.
- **Panel**: collapsible sections — Framing, Level, White balance (raw only), Edge, Tone, Output —
  with open/closed state persisted through the existing settings mechanism. Every numeric readout
  is editable (type a value, Enter or blur applies it, out-of-range values clamp through the same
  `Settings.RANGES`). Keyboard fine-adjust on focused sliders.
- **Export** is a prominent primary action at the bottom of the panel, with the size/ratio readout
  beside it.
- **Logo**: an inline SVG, no external assets, used in the header and as the favicon (inline data
  URI). It must read at 16 px. Keep it geometric and precise; the cut-away overlap is the idea.
- Typography: a system font stack only (no web fonts — the page must work offline from
  `file://`). Tabular numerals for all readouts.
- Responsive enough that the panel remains usable at 1280 px wide; no requirement for mobile.
- **No behaviour changes.** This task restyles and restructures presentation. Every existing
  control keeps its `id` or its wiring is updated in the same change; `test/slider-ranges.test.js`
  must keep passing, which proves the slider ranges did not drift.

**Verification:** screenshots of the empty state, an X5 `.insp` loaded two-up, and a DNG loaded
with the white-balance section open; the logo rendered at 16 px and at 64 px; `npm test` green;
no console errors; export still produces identical dimensions to before.
