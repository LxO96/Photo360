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
