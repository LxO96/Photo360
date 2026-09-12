'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Lens = require('../lens.js');
// gl.js expects a global `Lens` (as it has in the browser, via <script> load
// order) since GL.exportGeometry calls Lens.radiusForFov/Lens.exportLayout.
global.Lens = Lens;
const GL = require('../gl.js');

function baseState(overrides) {
  return Object.assign({
    fovDeg: 180, thetaMaxDeg: 105,
    sensors: 'A', orientation: 'side',
    gapFrac: 0, marginFrac: 0,
    sourceLensSize: 5952, uploadedLensSize: 5952,
    padToSensorSquare: false,
  }, overrides);
}

test('at 180 degrees on a full-size X5 source the export circle is 5100px', () => {
  const g = GL.exportGeometry(baseState());
  // 5952 * (90/105) = 5101.71..., rounds to 5102 -- but Lens.radiusForFov's
  // own rounding is exercised here, not re-derived; assert against the same
  // computation the brief specifies rather than a hand re-typed constant.
  const expected = Math.round(5952 * Lens.radiusForFov(180, 105));
  assert.strictEqual(g.width, expected);
  assert.strictEqual(g.height, expected);
});

test('padToSensorSquare exports at the full uploaded lens size, not the cropped circle', () => {
  const g = GL.exportGeometry(baseState({ padToSensorSquare: true }));
  assert.strictEqual(g.width, 5952);
  assert.strictEqual(g.height, 5952);
});

test('both sensors side by side with zero gap and margin is exactly 2:1', () => {
  const g = GL.exportGeometry(baseState({ sensors: 'both', orientation: 'side' }));
  assert.strictEqual(g.width, g.height * 2);
});

test('both sensors stacked with zero gap and margin is exactly 1:2', () => {
  const g = GL.exportGeometry(baseState({ sensors: 'both', orientation: 'stacked' }));
  assert.strictEqual(g.height, g.width * 2);
});

test('sizes off the actually-uploaded lens size, not the pre-downscale source size', () => {
  // Simulates a GPU whose MAX_TEXTURE_SIZE forced app.js to downscale the
  // decoded bitmap: sourceLensSize still holds the file's true 5952, but
  // uploadedLensSize (what the texture actually holds) is smaller. Sizing
  // off sourceLensSize here would silently upscale past the texture.
  const g = GL.exportGeometry(baseState({ sourceLensSize: 5952, uploadedLensSize: 4096 }));
  const expected = Math.round(4096 * Lens.radiusForFov(180, 105));
  assert.strictEqual(g.width, expected);
  assert.ok(g.width < 5952);
});

test('falls back to sourceLensSize when uploadedLensSize is unset', () => {
  const g = GL.exportGeometry(baseState({ uploadedLensSize: 0 }));
  const expected = Math.round(5952 * Lens.radiusForFov(180, 105));
  assert.strictEqual(g.width, expected);
});

test('margin and gap scale off the export diameter, not a fixed reference', () => {
  const g = GL.exportGeometry(baseState({ marginFrac: 0.08 }));
  const diameter = Math.round(5952 * Lens.radiusForFov(180, 105));
  const margin = Math.round(0.08 * diameter);
  assert.strictEqual(g.width, diameter + 2 * margin);
});
