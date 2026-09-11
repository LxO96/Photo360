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
