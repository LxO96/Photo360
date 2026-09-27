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
  fov: [Settings.RANGES.fovDeg, 1],
  thetaMax: [Settings.RANGES.thetaMaxDeg, 1],
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
  wbRedA: [Settings.RANGES.rawWhiteBalance.A, 1],
  wbBlueA: [Settings.RANGES.rawWhiteBalance.A, 1],
  wbRedB: [Settings.RANGES.rawWhiteBalance.B, 1],
  wbBlueB: [Settings.RANGES.rawWhiteBalance.B, 1],
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
