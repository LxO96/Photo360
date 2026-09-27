'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Lens = require('../lens.js');
// gl.js expects a global `Lens` (as it has in the browser, via <script> load
// order) since it calls Lens.rollFor from circleDraw.
global.Lens = Lens;
const GL = require('../gl.js');

test('physicalLens returns the slot label unchanged when not swapped', () => {
  assert.strictEqual(GL.physicalLens({ swap: false }, 'A'), 'A');
  assert.strictEqual(GL.physicalLens({ swap: false }, 'B'), 'B');
});

test('physicalLens returns the other lens label when swapped', () => {
  assert.strictEqual(GL.physicalLens({ swap: true }, 'A'), 'B');
  assert.strictEqual(GL.physicalLens({ swap: true }, 'B'), 'A');
});

// circleDraw is the single call renderComposition makes per circle to
// decide both which texture to bind and what roll to apply. Texture and
// roll must always agree on which physical lens they came from -- that is
// exactly what regressed when the roll was looked up by slot label while
// the texture was looked up by physical lens (under swap, those disagree).
// These assertions check both together, per slot, per swap setting, so a
// regression to the old `Lens.rollFor(state, c.lens)` call breaks them.
test('the left slot shows lens A rolled as lens A when not swapped', () => {
  const state = { rollDeg: 15, nudgeDeg: { A: 1, B: -2 }, swap: false };
  assert.deepStrictEqual(GL.circleDraw(state, 'A'), { texIndex: 0, rollDeg: 16 });
});

test('the right slot shows lens B rolled as lens B when not swapped', () => {
  const state = { rollDeg: 15, nudgeDeg: { A: 1, B: -2 }, swap: false };
  assert.deepStrictEqual(GL.circleDraw(state, 'B'), { texIndex: 1, rollDeg: -17 });
});

test('the left slot shows lens B rolled as lens B when swapped', () => {
  const state = { rollDeg: 15, nudgeDeg: { A: 1, B: -2 }, swap: true };
  assert.deepStrictEqual(GL.circleDraw(state, 'A'), { texIndex: 1, rollDeg: -17 });
});

test('the right slot shows lens A rolled as lens A when swapped', () => {
  const state = { rollDeg: 15, nudgeDeg: { A: 1, B: -2 }, swap: true };
  assert.deepStrictEqual(GL.circleDraw(state, 'B'), { texIndex: 0, rollDeg: 16 });
});

// -- Task 19: preview placement (fill the stage / zoom) ---------------------
const PLACE_STATE = { sensors: 'both', orientation: 'side', gapFrac: 0.16, marginFrac: 0.08, swap: false };

test('placedLayout without a place is exactly compositionLayout (the export path)', () => {
  assert.deepStrictEqual(GL.placedLayout(PLACE_STATE, 1200, 600),
    GL.compositionLayout(PLACE_STATE, 1200, 600));
});

test('placedLayout lays the composition out in `place`, offset into the target', () => {
  const place = { x: -3000, y: -500, w: 11904, h: 5952 };
  const got = GL.placedLayout(PLACE_STATE, 1800, 1000, place);
  const ref = GL.compositionLayout(PLACE_STATE, place.w, place.h);
  for (let i = 0; i < ref.circles.length; i++) {
    assert.strictEqual(got.circles[i].cx, ref.circles[i].cx + place.x);
    assert.strictEqual(got.circles[i].cy, ref.circles[i].cy + place.y);
    assert.strictEqual(got.circles[i].radius, ref.circles[i].radius);
    assert.strictEqual(got.circles[i].lens, ref.circles[i].lens);
  }
});

test('cellViewport without clipping is the unclipped cell (export unchanged)', () => {
  const v = GL.cellViewport({ cx: 50, cy: 50, radius: 100 }, 400, 300, false);
  const cell = Math.round(200 * (1 + 2 * GL.GLOW_HEADROOM));
  assert.deepStrictEqual(v.cell, cell);
  assert.deepStrictEqual([v.vx, v.vy], [Math.round(50 - cell / 2), Math.round(300 - 50 - cell / 2)]);
  assert.deepStrictEqual(v.viewport, [v.vx, v.vy, cell, cell]);
});

test('cellViewport with clipping keeps the cell origin but clips the viewport to the target', () => {
  // A 100%-zoom circle much larger than the canvas: the viewport must never
  // exceed the framebuffer (or MAX_VIEWPORT_DIMS), while uCellOrigin/uCellSize
  // (vx, vy, cell) still describe the whole cell so the shader's geometry is
  // unchanged.
  const v = GL.cellViewport({ cx: 900, cy: 500, radius: 2500 }, 1800, 1000, true);
  assert.ok(v.vx < 0 && v.vy < 0 && v.cell > 5000);
  assert.deepStrictEqual(v.viewport, [0, 0, 1800, 1000]);
});

test('cellViewport with clipping reports an off-target cell as empty', () => {
  const v = GL.cellViewport({ cx: -5000, cy: 500, radius: 100 }, 1800, 1000, true);
  assert.strictEqual(v.viewport, null);
});
