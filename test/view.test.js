'use strict';
const test = require('node:test');
const assert = require('node:assert');
const View = require('../src/view.js');

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// -- Fill the stage (Task 19, part 1) --------------------------------------

test('fitScale fits a 2:1 composition by width in a wide stage', () => {
  // 11904 x 5952 into 1800 x 1000: width-limited (1800/11904 < 1000/5952).
  assert.ok(near(View.fitScale(1800, 1000, 11904, 5952), 1800 / 11904));
});

test('fitScale fits a 2:1 composition by height in a tall stage', () => {
  assert.ok(near(View.fitScale(1800, 600, 11904, 5952), 600 / 5952));
});

test('fitScale is 0 for an empty stage or empty content instead of NaN/Infinity', () => {
  assert.strictEqual(View.fitScale(0, 500, 100, 100), 0);
  assert.strictEqual(View.fitScale(500, 500, 0, 100), 0);
});

test('fitView keeps the true aspect ratio and centres the composition', () => {
  const v = View.fitView(1800, 1000, 11904, 5952);
  const w = 11904 * v.scale, h = 5952 * v.scale;
  assert.ok(near(w / h, 2), 'aspect must stay exactly 2:1');
  assert.ok(near(w, 1800), 'a 2:1 composition fills the full stage width');
  assert.ok(near(v.ox, 0));
  assert.ok(near(v.oy, (1000 - h) / 2));
});

test('fitView fills far more of a wide stage than the old min(width,height) square', () => {
  // The old render() fitted the long side to min(stageW, stageH), so a 2:1
  // two-up in a 1800x1000 stage was 1000 px wide. It must now use the width.
  const v = View.fitView(1800, 1000, 2000, 1000);
  assert.ok(2000 * v.scale > 1000 * 1.7);
});

test('visibleRect at fit is the whole composition, snapped to device pixels', () => {
  const v = View.fitView(1800, 1000, 11904, 5952);
  const r = View.visibleRect(v, 1800, 1000, 11904, 5952);
  assert.strictEqual(r.x, 0);
  assert.strictEqual(r.w, 1800);
  assert.ok(Number.isInteger(r.y) && Number.isInteger(r.h));
  // The composition rect relative to the canvas (`place`) is what gets
  // drawn; at fit it covers the canvas to within the pixel snap.
  assert.ok(Math.abs(r.place.w - r.w) < 1 && Math.abs(r.place.h - r.h) < 1);
  assert.ok(r.place.x <= 0 && r.place.y <= 0 && r.place.x > -1 && r.place.y > -1);
});

test('visibleRect of a zoomed view is clipped to the stage', () => {
  // 100% on an 11904 x 5952 composition in a 1800 x 1000 stage, panned so
  // the composition origin sits at (-5000, -2000).
  const v = { scale: 1, ox: -5000, oy: -2000 };
  const r = View.visibleRect(v, 1800, 1000, 11904, 5952);
  assert.deepStrictEqual([r.x, r.y, r.w, r.h], [0, 0, 1800, 1000]);
  assert.deepStrictEqual(r.place, { x: -5000, y: -2000, w: 11904, h: 5952 });
});

test('visibleRect of a partly visible composition only covers the overlap', () => {
  const v = { scale: 0.5, ox: 300.4, oy: -100 };
  const r = View.visibleRect(v, 1800, 1000, 2000, 1000);
  // Composition spans x 300.4..1300.4, y -100..400.
  assert.deepStrictEqual([r.x, r.y, r.w, r.h], [300, 0, 1001, 400]);
  assert.ok(near(r.place.x, 0.4) && near(r.place.y, -100));
  assert.ok(near(r.place.w, 1000) && near(r.place.h, 500));
});

test('visibleRect is empty (w or h 0) when the composition is off stage', () => {
  const r = View.visibleRect({ scale: 1, ox: 5000, oy: 0 }, 1800, 1000, 100, 100);
  assert.ok(r.w === 0 || r.h === 0);
});

// -- Preview zoom (Task 19, part 2) ----------------------------------------

test('zoomAbout keeps the content point under the cursor fixed', () => {
  const v = { scale: 0.15, ox: 12, oy: 80 };
  const px = 700, py = 333;
  const before = { x: (px - v.ox) / v.scale, y: (py - v.oy) / v.scale };
  for (const s of [0.05, 0.3, 1, 4.5]) {
    const z = View.zoomAbout(v, s, px, py);
    assert.strictEqual(z.scale, s);
    const after = { x: (px - z.ox) / z.scale, y: (py - z.oy) / z.scale };
    assert.ok(near(after.x, before.x, 1e-6) && near(after.y, before.y, 1e-6), `scale ${s}`);
  }
});

test('zoomAbout there and back returns the original view', () => {
  const v = { scale: 0.2, ox: -40, oy: 15 };
  const back = View.zoomAbout(View.zoomAbout(v, 1, 500, 400), 0.2, 500, 400);
  assert.ok(near(back.ox, v.ox, 1e-9) && near(back.oy, v.oy, 1e-9));
});

test('clampScale keeps zoom between fit (or 100%, if smaller) and the maximum', () => {
  assert.strictEqual(View.clampScale(0.01, 0.15), 0.15);
  assert.strictEqual(View.clampScale(100, 0.15), View.MAX_SCALE);
  assert.strictEqual(View.clampScale(0.5, 0.15), 0.5);
  // A tiny composition whose fit is above 100% can still reach 100%.
  assert.strictEqual(View.clampScale(0.5, 2), 1);
});

test('clampPan: a composition larger than the stage cannot leave a gap at either edge', () => {
  const W = 11904, H = 5952, aw = 1800, ah = 1000;
  const right = View.clampPan({ scale: 1, ox: 500, oy: 300 }, aw, ah, W, H);
  assert.deepStrictEqual([right.ox, right.oy], [0, 0]);
  const left = View.clampPan({ scale: 1, ox: -1e6, oy: -1e6 }, aw, ah, W, H);
  assert.deepStrictEqual([left.ox, left.oy], [aw - W, ah - H]);
  const inside = View.clampPan({ scale: 1, ox: -3000, oy: -2000 }, aw, ah, W, H);
  assert.deepStrictEqual([inside.ox, inside.oy], [-3000, -2000]);
});

test('clampPan: an axis smaller than the stage is centred on it', () => {
  // 2000 x 1000 at 0.5 is 1000 x 500 in an 1800 x 1000 stage: both axes fit.
  const v = View.clampPan({ scale: 0.5, ox: -9999, oy: 9999 }, 1800, 1000, 2000, 1000);
  assert.deepStrictEqual([v.ox, v.oy], [400, 250]);
});

test('clampPan never lets the composition be dragged fully off screen', () => {
  for (const [ox, oy] of [[1e5, 0], [-1e5, 0], [0, 1e5], [0, -1e5], [1e5, -1e5]]) {
    for (const scale of [0.1, 0.5, 1, 3]) {
      const v = View.clampPan({ scale, ox, oy }, 1800, 1000, 11904, 5952);
      const r = View.visibleRect(v, 1800, 1000, 11904, 5952);
      assert.ok(r.w > 0 && r.h > 0, `scale ${scale} (${ox}, ${oy})`);
    }
  }
});

test('stepZoom moves to the next preset level in each direction, from fit too', () => {
  assert.strictEqual(View.stepZoom(1, 1, 0.15), 2);
  assert.strictEqual(View.stepZoom(1, -1, 0.15), 2 / 3);
  assert.strictEqual(View.stepZoom(0.15, 1, 0.15), 0.25);
  // Stepping out below fit lands on fit, not below it.
  assert.strictEqual(View.stepZoom(0.25, -1, 0.15), 0.15);
  assert.strictEqual(View.stepZoom(View.MAX_SCALE, 1, 0.15), View.MAX_SCALE);
});

test('wheelScale zooms in for wheel-up and out for wheel-down, clamped', () => {
  assert.ok(View.wheelScale(0.5, -100, 0.15) > 0.5);
  assert.ok(View.wheelScale(0.5, 100, 0.15) < 0.5);
  assert.strictEqual(View.wheelScale(0.15, 1e4, 0.15), 0.15);
  assert.strictEqual(View.wheelScale(View.MAX_SCALE, -1e4, 0.15), View.MAX_SCALE);
});

