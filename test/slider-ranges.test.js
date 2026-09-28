'use strict';
// Final whole-branch review, Important finding #4: the parameter-bounds
// table exists in three places (settings.js RANGES, index.html's slider
// min/max, tools/fit-x1-edge.py's SLIDER_RANGE) with no shared source at
// build time. RANGES and index.html happened to agree when this test was
// written; this test is what keeps that true going forward by reading
// index.html itself and regexing the min/max off each <input type=range>,
// the same source-grep precedent test/edge.test.js already established for
// gl.js/Edge.MAX_BLUR_RADIUS_BINS.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Settings = require('../settings.js');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// Pulls {min, max} off `<input id="ID" ... type="range" ... min="X" ...
// max="Y" ...>` regardless of attribute order, for one slider id.
function sliderRange(id) {
  const re = new RegExp(`<input id="${id}"[^>]*>`);
  const m = html.match(re);
  assert.ok(m, `no <input id="${id}"> found in index.html`);
  const tag = m[0];
  assert.ok(/type="range"/.test(tag), `#${id} is not a type="range" input`);
  const min = tag.match(/\bmin="([^"]+)"/);
  const max = tag.match(/\bmax="([^"]+)"/);
  assert.ok(min && max, `#${id} is missing a min or max attribute`);
  return [parseFloat(min[1]), parseFloat(max[1])];
}

// Maps a slider id to the [range, scale] this test should check it against:
// `scale` converts the slider's own units (e.g. gap/margin sliders are 0-25,
// meaning percent) into the fractional units RANGES stores.
const SLIDER_TO_RANGE = {
  // fov is deliberately absent (Task 19): its max is dynamic, 2 x the
  // current Calibration (theta-max), set by app.js -- see the dedicated
  // tests at the bottom of this file.
  roll: [Settings.RANGES.rollDeg, 1],
  nudgeA: [Settings.RANGES.nudgeDeg.A, 1],
  nudgeB: [Settings.RANGES.nudgeDeg.B, 1],
  gap: [Settings.RANGES.gapFrac, 100],
  margin: [Settings.RANGES.marginFrac, 100],
  edgeIntensity: [Settings.RANGES.edge.edgeIntensity, 1],
  ringWidth: [Settings.RANGES.edge.ringWidth, 1],
  dispersion: [Settings.RANGES.edge.dispersion, 1],
  glowSpreadDeg: [Settings.RANGES.edge.glowSpreadDeg, 1],
  highlightKnee: [Settings.RANGES.edge.highlightKnee, 1],
  falloffStart: [Settings.RANGES.edge.falloffStart, 1],
  falloffSoftness: [Settings.RANGES.edge.falloffSoftness, 1],
  exposureEv: [Settings.RANGES.tone.exposureEv, 1],
  contrast: [Settings.RANGES.tone.contrast, 1],
  saturation: [Settings.RANGES.tone.saturation, 1],
  highlights: [Settings.RANGES.tone.highlights, 1],
  shadows: [Settings.RANGES.tone.shadows, 1],
  whites: [Settings.RANGES.tone.whites, 1],
  blacks: [Settings.RANGES.tone.blacks, 1],
  sharpenAmount: [Settings.RANGES.detail.sharpenAmount, 1],
  sharpenRadius: [Settings.RANGES.detail.sharpenRadius, 1],
  lumaNoise: [Settings.RANGES.detail.lumaNoise, 1],
  colorNoise: [Settings.RANGES.detail.colorNoise, 1],
  // Task 17 replaced the raw red/blue multiplier sliders (wbRedA/wbBlueA/
  // wbRedB/wbBlueB, a linear 0.2-1.5 range that matched Settings.RANGES
  // directly) with Kelvin/tint controls. Those are deliberately
  // *nonlinear* (Kelvin logarithmic, tint a signed power curve -- see
  // wb.js), so the <input type=range> itself always spans a plain 0..1 (or
  // -1..1) slider-position domain, not the Kelvin/tint domain in
  // Settings.RANGES.rawWb -- this test's premise (the DOM slider's own
  // min/max literally *is* the persisted range) no longer holds for them,
  // so they are intentionally left out of this table rather than compared
  // against a scale that doesn't apply. Settings.RANGES.rawWb is still
  // exercised directly in test/settings.test.js.
};

for (const [id, [range, scale]] of Object.entries(SLIDER_TO_RANGE)) {
  test(`index.html's #${id} slider matches Settings.RANGES`, () => {
    const [min, max] = sliderRange(id);
    assert.ok(Math.abs(min / scale - range[0]) < 1e-9,
      `#${id} min=${min} (=${min / scale} after scale) does not match RANGES ${range[0]}`);
    assert.ok(Math.abs(max / scale - range[1]) < 1e-9,
      `#${id} max=${max} (=${max / scale} after scale) does not match RANGES ${range[1]}`);
  });
}

// Task 19: the FOV slider's max follows the Calibration slider (2 x
// theta-max, Lens.fovRangeFor), so neither its static HTML max nor
// Settings.RANGES.fovDeg can be "the" range any more. What must hold:
//   - RANGES.fovDeg is a superset of every range fovRangeFor can produce
//     over the whole Calibration range, so a stored fovDeg that was valid
//     under some calibration is never clamped by persistence validation
//     (the app clamps it to the current calibration itself);
//   - the static HTML max is what app.js would set for the default
//     calibration (2 x Lens.THETA_MAX_DEG = 210), so the slider does not
//     jump before app.js runs, and its min is fovRangeFor's fixed 120.
const Lens = require('../lens.js');

test('Settings.RANGES.fovDeg covers the FOV range at every calibration', () => {
  const [tLo, tHi] = Settings.RANGES.thetaMaxDeg;
  for (let t = tLo; t <= tHi; t += 0.5) {
    const [lo, hi] = Lens.fovRangeFor(t);
    assert.ok(lo >= Settings.RANGES.fovDeg[0] && hi <= Settings.RANGES.fovDeg[1], `theta-max ${t}`);
  }
  assert.strictEqual(Settings.RANGES.fovDeg[1], 2 * tHi, 'no wider than the widest calibration needs');
});

test("index.html's #fov slider is the default calibration's FOV range", () => {
  assert.deepStrictEqual(sliderRange('fov'), Lens.fovRangeFor(Lens.THETA_MAX_DEG));
  assert.deepStrictEqual(sliderRange('fov'), [120, 210]);
});
