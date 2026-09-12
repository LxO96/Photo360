'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Edge = require('../edge.js');

const NEUTRAL = { exposureEv: 0, contrast: 0, saturation: 0 };

test('neutral tone is an exact pass-through', () => {
  for (const c of [[0, 0, 0], [0.2, 0.5, 0.9], [1, 1, 1], [0.37, 0.37, 0.37]]) {
    assert.deepStrictEqual(Edge.applyTone(c, NEUTRAL), c);
  }
});

test('one stop of exposure doubles the signal', () => {
  const out = Edge.applyTone([0.25, 0.25, 0.25], { ...NEUTRAL, exposureEv: 1 });
  assert.ok(Math.abs(out[0] - 0.5) < 1e-9);
});

test('contrast pivots around mid grey', () => {
  const mid = Edge.applyTone([0.5, 0.5, 0.5], { ...NEUTRAL, contrast: 0.5 });
  assert.ok(Math.abs(mid[0] - 0.5) < 1e-9, 'mid grey must not move');
  const hi = Edge.applyTone([0.8, 0.8, 0.8], { ...NEUTRAL, contrast: 0.5 });
  assert.ok(hi[0] > 0.8, 'highlights must rise');
  const lo = Edge.applyTone([0.2, 0.2, 0.2], { ...NEUTRAL, contrast: 0.5 });
  assert.ok(lo[0] < 0.2, 'shadows must fall');
});

test('saturation leaves neutral colours neutral', () => {
  const out = Edge.applyTone([0.4, 0.4, 0.4], { ...NEUTRAL, saturation: 1 });
  assert.ok(Math.abs(out[0] - out[1]) < 1e-9 && Math.abs(out[1] - out[2]) < 1e-9);
});

test('full desaturation collapses to luma', () => {
  const out = Edge.applyTone([0.2, 0.6, 0.4], { ...NEUTRAL, saturation: -1 });
  assert.ok(Math.abs(out[0] - out[1]) < 1e-9 && Math.abs(out[1] - out[2]) < 1e-9);
});
