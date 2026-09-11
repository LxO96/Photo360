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

function bandSampler(hiFrom, hiTo) {
  // white inside the azimuth band [hiFrom, hiTo) radians, black elsewhere
  return (theta) => {
    const t = ((theta % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    return t >= hiFrom && t < hiTo ? [1, 1, 1] : [0, 0, 0];
  };
}

const PROFILE_OPTS = {
  bins: 64, radialSamples: 4, uMin: 0.94, uMax: 1.0, knee: 0.5, exponent: 2,
};

test('the rim profile lights up only where the content is bright', () => {
  const p = Edge.buildRimProfile(bandSampler(0, Math.PI), PROFILE_OPTS);
  assert.strictEqual(p.length, 64 * 4);
  const expected = Edge.highlightWeight(1, 0.5, 2);
  assert.ok(Math.abs(p[0 * 4] - expected) < 1e-6, 'first bin should be lit');
  assert.strictEqual(p[48 * 4], 0, 'a bin in the dark half must be zero');
});

test('the rim profile records the mean colour of its annulus', () => {
  const p = Edge.buildRimProfile(() => [0.2, 0.4, 0.8], PROFILE_OPTS);
  assert.ok(Math.abs(p[1] - 0.2) < 1e-6);
  assert.ok(Math.abs(p[2] - 0.4) < 1e-6);
  assert.ok(Math.abs(p[3] - 0.8) < 1e-6);
});

test('content below the knee produces a completely dark rim', () => {
  const p = Edge.buildRimProfile(() => [0.3, 0.3, 0.3], PROFILE_OPTS);
  for (let i = 0; i < 64; i++) assert.strictEqual(p[i * 4], 0);
});

test('the angular blur spreads an impulse into its neighbours', () => {
  const bins = 64;
  const p = new Float32Array(bins * 4);
  p[0] = 1;
  const b = Edge.blurProfileAngular(p, bins, 3);
  assert.ok(b[0] < 1, 'the impulse must be reduced');
  assert.ok(b[1 * 4] > 0, 'the next bin must receive energy');
  assert.ok(b[1 * 4] < b[0], 'energy must fall off with distance');
});

test('the angular blur wraps around the circle', () => {
  const bins = 64;
  const p = new Float32Array(bins * 4);
  p[0] = 1;
  const b = Edge.blurProfileAngular(p, bins, 3);
  assert.ok(b[63 * 4] > 0, 'the bin before zero must receive energy');
  assert.ok(Math.abs(b[63 * 4] - b[1 * 4]) < 1e-6, 'the blur must be symmetric');
});

test('the angular blur conserves total energy', () => {
  const bins = 64;
  const p = new Float32Array(bins * 4);
  for (let i = 0; i < bins; i++) p[i * 4] = Math.random();
  const before = p.filter((_, i) => i % 4 === 0).reduce((a, b) => a + b, 0);
  const b = Edge.blurProfileAngular(p, bins, 4);
  const after = b.filter((_, i) => i % 4 === 0).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(after - before) < 1e-4, `${after} vs ${before}`);
});

test('a zero spread leaves the profile untouched', () => {
  const bins = 8;
  const p = new Float32Array(bins * 4);
  p[0] = 1; p[4] = 0.5;
  const b = Edge.blurProfileAngular(p, bins, 0);
  assert.deepStrictEqual(Array.from(b), Array.from(p));
});

// Task 7 review, Finding 1: PROFILE_BLUR_FS's GLSL loop has a bounded
// extent (it must -- GPU loops can't be unbounded), so blurProfileAngular's
// kernel radius must be clamped to the exact same ceiling or a wide enough
// glowSpreadDeg silently diverges between the shader and this reference
// (no NaN, no crash -- the glow just quietly stops widening in the GLSL
// while the JS reference keeps going). These tests pin that the clamp
// exists, and that gl.js wires the *same* constant into the shader rather
// than a second hardcoded number that could drift from this one.
test('MAX_BLUR_RADIUS_BINS is a sane, finite bound', () => {
  assert.ok(Number.isFinite(Edge.MAX_BLUR_RADIUS_BINS));
  assert.ok(Edge.MAX_BLUR_RADIUS_BINS > 0);
});

test('blurProfileAngular clamps its kernel radius to MAX_BLUR_RADIUS_BINS instead of growing unboundedly', () => {
  const bins = 2048;
  const p = new Float32Array(bins * 4);
  p[0] = 1;
  // An unclamped radius here would be far larger than MAX_BLUR_RADIUS_BINS
  // (ceil(100000 * 3) = 300000), and the O(bins * radius) double loop over
  // 2048 * 300000 pairs would take seconds; a clamped radius keeps this
  // fast. This is a behavioural proxy for "the clamp actually fires",
  // since blurProfileAngular does not expose its kernel radius directly.
  const start = Date.now();
  const b = Edge.blurProfileAngular(p, bins, 100000);
  const elapsedMs = Date.now() - start;
  assert.ok(elapsedMs < 2000,
    `blurProfileAngular took ${elapsedMs}ms for an extreme spreadBins -- ` +
    'the radius clamp does not appear to be firing');
  assert.strictEqual(b.length, bins * 4);
});

test('gl.js wires PROFILE_BLUR_FS\'s uMaxRadiusBins from Edge.MAX_BLUR_RADIUS_BINS, not a duplicated literal', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const glSrc = fs.readFileSync(path.join(__dirname, '..', 'gl.js'), 'utf8');
  assert.ok(glSrc.includes('Edge.MAX_BLUR_RADIUS_BINS'),
    'gl.js must reference Edge.MAX_BLUR_RADIUS_BINS when setting the blur uniform, ' +
    'so the GLSL loop bound and the JS kernel clamp can never drift apart');
});
