'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Edge = require('../edge.js');

test('the terminator is fully open inside the falloff start', () => {
  assert.strictEqual(Edge.terminator(0.0, 0.9, 1), 1);
  assert.strictEqual(Edge.terminator(0.5, 0.9, 1), 1);
  assert.strictEqual(Edge.terminator(0.9, 0.9, 1), 1);
});

test('the terminator closes completely at the edge and beyond', () => {
  assert.strictEqual(Edge.terminator(1.0, 0.9, 1), 0);
  assert.strictEqual(Edge.terminator(1.4, 0.9, 1), 0);
});

test('the terminator decreases monotonically across the falloff band', () => {
  let prev = Infinity;
  for (let u = 0.9; u <= 1.0001; u += 0.005) {
    const v = Edge.terminator(u, 0.9, 1);
    assert.ok(v <= prev + 1e-12, `not monotonic at u=${u}`);
    prev = v;
  }
});

test('higher softness closes the terminator earlier', () => {
  assert.ok(Edge.terminator(0.95, 0.9, 3) < Edge.terminator(0.95, 0.9, 1));
});

test('dispersion puts red innermost and blue outermost', () => {
  const p = Edge.dispersionPeaks(0.02);
  assert.ok(p.r < p.g, 'red must peak inside green');
  assert.ok(p.g < p.b, 'green must peak inside blue');
  assert.strictEqual(p.g, 1);
});

test('zero dispersion collapses all three channels onto the edge', () => {
  const p = Edge.dispersionPeaks(0);
  assert.strictEqual(p.r, 1);
  assert.strictEqual(p.g, 1);
  assert.strictEqual(p.b, 1);
});

test('the rim bell peaks at its peak radius and decays away from it', () => {
  assert.ok(Math.abs(Edge.rimBell(1.0, 1.0, 0.02) - 1) < 1e-12);
  assert.ok(Edge.rimBell(1.02, 1.0, 0.02) < 0.5);
  assert.ok(Edge.rimBell(1.10, 1.0, 0.02) < 1e-6);
  assert.ok(Math.abs(Edge.rimBell(0.98, 1.0, 0.02) - Edge.rimBell(1.02, 1.0, 0.02)) < 1e-12);
});

test('content below the highlight knee contributes nothing to the glow', () => {
  assert.strictEqual(Edge.highlightWeight(0.0, 0.5, 2), 0);
  assert.strictEqual(Edge.highlightWeight(0.5, 0.5, 2), 0);
  assert.ok(Edge.highlightWeight(0.9, 0.5, 2) > 0);
});

test('the highlight weight is superlinear above the knee', () => {
  const a = Edge.highlightWeight(0.6, 0.5, 2);
  const b = Edge.highlightWeight(0.7, 0.5, 2);
  assert.ok(b / a > 2, 'a 0.1 rise past the knee should more than double the weight');
});

test('rimBell with zero width is an impulse at the peak', () => {
  assert.strictEqual(Edge.rimBell(1.0, 1.0, 0), 1);
  assert.strictEqual(Edge.rimBell(1.02, 1.0, 0), 0);
  assert.strictEqual(Edge.rimBell(0.98, 1.0, 0), 0);
});

test('rimBell zero width returns are not NaN', () => {
  const a = Edge.rimBell(1.0, 1.0, 0);
  const b = Edge.rimBell(1.02, 1.0, 0);
  assert.ok(!isNaN(a), 'rimBell(1.0, 1.0, 0) must not be NaN');
  assert.ok(!isNaN(b), 'rimBell(1.02, 1.0, 0) must not be NaN');
});
