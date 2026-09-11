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
