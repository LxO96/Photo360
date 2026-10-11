'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Lens = require('../src/lens.js');

test('roll is mirrored between the two back-to-back lenses', () => {
  const s = { rollDeg: 12, nudgeDeg: { A: 0, B: 0 } };
  assert.strictEqual(Lens.rollFor(s, 'A'), 12);
  assert.strictEqual(Lens.rollFor(s, 'B'), -12);
});

test('the per-lens nudge is added after the mirror', () => {
  const s = { rollDeg: 12, nudgeDeg: { A: 1.5, B: -0.5 } };
  assert.strictEqual(Lens.rollFor(s, 'A'), 13.5);
  assert.strictEqual(Lens.rollFor(s, 'B'), -12.5);
});

test('a zero roll with zero nudge leaves both lenses untouched', () => {
  const s = { rollDeg: 0, nudgeDeg: { A: 0, B: 0 } };
  assert.strictEqual(Lens.rollFor(s, 'A'), 0);
  assert.strictEqual(Lens.rollFor(s, 'B'), 0);
});
