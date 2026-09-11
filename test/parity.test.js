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
