'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Detail = require('../detail.js');

const OFF = { sharpenAmount: 0, sharpenRadius: 1, lumaNoise: 0, colorNoise: 0 };
const LUMA = [0.2126, 0.7152, 0.0722];
const lum = (c) => LUMA[0] * c[0] + LUMA[1] * c[1] + LUMA[2] * c[2];

// Deterministic noise in [-1, 1].
function hash(x, y, k) {
  const s = Math.sin(x * 12.9898 + y * 78.233 + k * 37.719) * 43758.5453;
  return (s - Math.floor(s)) * 2 - 1;
}

// A sampler over an infinite synthetic image: fn(x, y) -> [r, g, b].
function at(fn, x0, y0) { return (dx, dy) => fn(x0 + dx, y0 + dy); }

function variance(values) {
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  return values.reduce((a, b) => a + (b - m) * (b - m), 0) / values.length;
}

test('all zeros is an exact pass-through', () => {
  const fn = (x, y) => [0.5 + 0.3 * hash(x, y, 0), 0.4, 0.2 + 0.1 * hash(x, y, 1)];
  for (let i = 0; i < 20; i++) {
    assert.deepStrictEqual(Detail.apply(at(fn, i, 2 * i), OFF), fn(i, 2 * i));
  }
  assert.strictEqual(Detail.isActive(OFF), false);
  assert.strictEqual(Detail.isActive({ ...OFF, colorNoise: 1 }), true);
});

test('luminance noise reduction lowers luma noise on a flat grey patch', () => {
  const fn = (x, y) => { const v = 0.5 + 0.04 * hash(x, y, 0); return [v, v, v]; };
  const p = { ...OFF, lumaNoise: 60 };
  const before = [], after = [];
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      before.push(lum(fn(x, y)));
      after.push(lum(Detail.apply(at(fn, x, y), p)));
    }
  }
  assert.ok(variance(after) < variance(before) * 0.4, `${variance(after)} vs ${variance(before)}`);
});

test('luminance noise reduction keeps a hard edge', () => {
  const fn = (x) => (x < 0 ? [0.1, 0.1, 0.1] : [0.9, 0.9, 0.9]);
  const p = { ...OFF, lumaNoise: 100 };
  assert.ok(lum(Detail.apply(at(fn, -1, 0), p)) < 0.15);
  assert.ok(lum(Detail.apply(at(fn, 0, 0), p)) > 0.85);
});

test('colour noise reduction lowers chroma noise and leaves luma close', () => {
  // Grey with random chroma that sums to zero luma change.
  const fn = (x, y) => {
    const a = 0.05 * hash(x, y, 2), b = 0.05 * hash(x, y, 3);
    return [0.5 + a, 0.5 - (LUMA[0] * a + LUMA[2] * b) / LUMA[1], 0.5 + b];
  };
  const p = { ...OFF, colorNoise: 80 };
  const cb = (c) => c[2] - lum(c);
  const before = [], after = [];
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      before.push(cb(fn(x, y)));
      const out = Detail.apply(at(fn, x, y), p);
      after.push(cb(out));
      assert.ok(Math.abs(lum(out) - lum(fn(x, y))) < 1e-9);
    }
  }
  assert.ok(variance(after) < variance(before) * 0.4, `${variance(after)} vs ${variance(before)}`);
});

test('sharpening raises contrast across an edge, and more with more amount', () => {
  const fn = (x) => (x < 0 ? [0.3, 0.3, 0.3] : [0.6, 0.6, 0.6]);
  const dark = (amt) => lum(Detail.apply(at(fn, -1, 0), { ...OFF, sharpenAmount: amt }));
  const light = (amt) => lum(Detail.apply(at(fn, 0, 0), { ...OFF, sharpenAmount: amt }));
  assert.ok(dark(50) < 0.3 && light(50) > 0.6);
  assert.ok(dark(150) < dark(50) && light(150) > light(50));
});

test('sharpening leaves a flat area alone', () => {
  const fn = () => [0.4, 0.5, 0.6];
  const out = Detail.apply(at(fn, 0, 0), { ...OFF, sharpenAmount: 150, sharpenRadius: 2 });
  out.forEach((v, i) => assert.ok(Math.abs(v - fn()[i]) < 1e-9));
});

test('output stays within [0, 1]', () => {
  const fn = (x, y) => [(x + y) % 2 ? 1 : 0, (x % 3) / 2, y % 2];
  const p = { sharpenAmount: 150, sharpenRadius: 2, lumaNoise: 30, colorNoise: 30 };
  for (let i = 0; i < 30; i++) {
    for (const v of Detail.apply(at(fn, i, i * 3), p)) assert.ok(v >= 0 && v <= 1, String(v));
  }
});
