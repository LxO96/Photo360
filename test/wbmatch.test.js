'use strict';
const test = require('node:test');
const assert = require('node:assert');
const WbMatch = require('../wbmatch.js');
const Wb = require('../wb.js');
const Dng = require('../dng.js');

const disc = (roll) => ({ cx: 400, cy: 300, radius: 250, roll, crop: 0.9 });

test('screen <-> lens uv round-trips at any roll', () => {
  for (const roll of [0, 0.7, -2.1, Math.PI]) {
    for (const pt of [{ x: 400, y: 300 }, { x: 520, y: 210 }, { x: 300, y: 450 }]) {
      const back = WbMatch.lensToScreen(WbMatch.screenToLens(pt, disc(roll)), disc(roll));
      assert.ok(Math.hypot(back.x - pt.x, back.y - pt.y) < 1e-9, `${roll} ${JSON.stringify(pt)}`);
    }
  }
});

test('lens uv follows COMPOSITE_FS: the centre is 0.5, the rim is crop / 2 away', () => {
  const d = disc(0);
  assert.deepStrictEqual(WbMatch.screenToLens({ x: 400, y: 300 }, d), [0.5, 0.5]);
  const right = WbMatch.screenToLens({ x: 650, y: 300 }, d);
  assert.ok(Math.abs(right[0] - 0.95) < 1e-12 && Math.abs(right[1] - 0.5) < 1e-12);
  // Up on screen is +v (GL y-up).
  assert.ok(WbMatch.screenToLens({ x: 400, y: 100 }, d)[1] > 0.5);
  // A roll turns what is under a screen point.
  const rolled = WbMatch.screenToLens({ x: 650, y: 300 }, disc(Math.PI / 2));
  assert.ok(Math.abs(rolled[0] - 0.5) < 1e-12 && Math.abs(rolled[1] - 0.95) < 1e-12);
  // A pinned point moves on screen with the roll.
  const uv = WbMatch.screenToLens({ x: 650, y: 300 }, d);
  const moved = WbMatch.lensToScreen(uv, disc(Math.PI / 2));
  assert.ok(Math.abs(moved.x - 400) < 1e-9 && Math.abs(moved.y - 550) < 1e-9);
});

test('circle radius converts both ways', () => {
  const d = disc(0.3);
  assert.ok(Math.abs(WbMatch.radiusToScreen(WbMatch.radiusToLens(37, d), d) - 37) < 1e-12);
});

test('the solve makes the source render as the target colour (converging with the matrix)', () => {
  const cm1 = [0.8, -0.2, -0.1, -0.4, 1.2, 0.2, -0.05, 0.1, 0.6];
  const nA = Wb.neutralFromKelvinTint(5200, 5, cm1);   // target lens's white balance
  let nB = Wb.neutralFromKelvinTint(7000, -10, cm1);   // source lens, off
  const MA = Dng.camToSrgbForNeutral(cm1, nA);
  // One surface (a warm wall), seen by both lenses in the same camera RGB.
  const cam = [0.5, 0.42, 0.25];
  const render = (M, n) => [0, 1, 2].map((r) => M[r * 3] * cam[0] / n[0] + M[r * 3 + 1] * cam[1] / n[1] + M[r * 3 + 2] * cam[2] / n[2]);
  const target = render(MA, nA);
  let dist0 = null;
  for (let pass = 0; pass < 6; pass++) {
    const MB = Dng.camToSrgbForNeutral(cm1, nB);
    const source = render(MB, nB);
    if (dist0 === null) dist0 = WbMatch.chromaDistance(source, target);
    nB = WbMatch.solve(source, target, MB, nB, Dng.mat3Invert);
  }
  const after = render(Dng.camToSrgbForNeutral(cm1, nB), nB);
  const d = WbMatch.chromaDistance(after, target);
  assert.ok(dist0 > 0.05, String(dist0));
  assert.ok(d < 1e-4, String(d));
  // Same surface, same camera: the source lens ends at the target's white balance.
  nB.forEach((v, i) => assert.ok(Math.abs(v - nA[i]) < 1e-3, `${nB} vs ${nA}`));
});

test('the circles must be on different lenses', () => {
  assert.ok(WbMatch.differentLenses({ lens: 'A' }, { lens: 'B' }));
  assert.ok(!WbMatch.differentLenses({ lens: 'A' }, { lens: 'A' }));
  assert.ok(!WbMatch.differentLenses(null, { lens: 'A' }));
});

test('circle radius stays within bounds', () => {
  assert.strictEqual(WbMatch.clampRadius(0), WbMatch.MIN_R);
  assert.strictEqual(WbMatch.clampRadius(1), WbMatch.MAX_R);
  assert.strictEqual(WbMatch.clampRadius(0.05), 0.05);
});
