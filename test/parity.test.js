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

// Task 7 review, Finding 1: the small fixture above (bins=64, spreadBins=2.5,
// radius=8) never exercises the blur's radius clamp -- it is nowhere near
// PROFILE_BINS (2048) or the glowSpreadDeg slider's max (45deg, which is
// spreadBins=256, radius=768, exactly Edge.MAX_BLUR_RADIUS_BINS). This
// second fixture pins the JS reference at that production scale, so a
// regression to the clamp (or its removal) would be caught here even
// though this file can't execute the GLSL side (see App.checkParity for
// the browser-side half of this check, run against both fixtures).
const largeFixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'parity-input-large.json'), 'utf8')
);

test('the JS rim profile matches the production-scale parity fixture (2048 bins, max blur radius)', () => {
  assert.strictEqual(largeFixture.opts.bins, Edge.PROFILE_BINS);
  assert.strictEqual(Math.ceil(largeFixture.spreadBins * 3), Edge.MAX_BLUR_RADIUS_BINS,
    'this fixture is only meaningful if it actually reaches the clamp ceiling');
  const raw = Edge.buildRimProfile(sample, largeFixture.opts);
  const blurred = Edge.blurProfileAngular(raw, largeFixture.opts.bins, largeFixture.spreadBins);
  for (let i = 0; i < largeFixture.expected.length; i++) {
    assert.ok(Math.abs(blurred[i] - largeFixture.expected[i]) < 1e-5,
      `index ${i}: ${blurred[i]} vs ${largeFixture.expected[i]}`);
  }
});
