'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Detail = require('../src/detail.js');
const Noise = require('../src/noise.js');

const OFF = { sharpenAmount: 0, sharpenRadius: 1, lumaNoise: 0, colorNoise: 0 };

// Seeded standard-normal noise.
function rng(seed) {
  let s = seed >>> 0;
  const u = () => { s = (s * 1664525 + 1013904223) >>> 0; return (s + 0.5) / 4294967296; };
  return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}

// An opponent image, w x h, from fn(x, y) -> [y, c1, c2].
function image(w, h, fn) {
  const img = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) img.set(fn(x, y), (y * w + x) * 3);
  return img;
}

function std(img, ch, x0, x1, y0, y1, w) {
  const v = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) v.push(img[(y * w + x) * 3 + ch]);
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  return Math.sqrt(v.reduce((a, b) => a + (b - m) * (b - m), 0) / v.length);
}

// The layer sigmas of white noise with std s in every channel.
function whiteSigmas(s) {
  const n = 64;
  const g = rng(7);
  const img = image(n, n, () => [s * g(), s * g(), s * g()]);
  const { details } = Detail.atrous(img, n, n, Detail.LEVELS);
  return details.map((d) => Noise.estimateSigma([{ d, w: n, h: n }]));
}

test('the opponent split is exactly invertible', () => {
  const o = Detail.toOpp(0.2, 0.7, 0.4);
  Detail.fromOpp(o[0], o[1], o[2]).forEach((v, i) => assert.ok(Math.abs(v - [0.2, 0.7, 0.4][i]) < 1e-12));
});

test('the wavelet layers sum back to the input', () => {
  const g = rng(1);
  const img = image(20, 13, () => [g(), g(), g()]);
  const { details, coarse } = Detail.atrous(img, 20, 13, Detail.LEVELS);
  for (let i = 0; i < img.length; i++) {
    const sum = details.reduce((a, d) => a + d[i], coarse[i]);
    assert.ok(Math.abs(sum - img[i]) < 1e-5);
  }
});

test('all zeros gives the input back', () => {
  const g = rng(2);
  const img = image(24, 24, () => [g(), g(), g()]);
  const out = Detail.develop(img, 24, 24, OFF, whiteSigmas(1));
  for (let i = 0; i < img.length; i++) assert.ok(Math.abs(out[i] - img[i]) < 1e-5);
  assert.strictEqual(Detail.isActive(OFF), false);
  assert.strictEqual(Detail.isActive({ ...OFF, colorNoise: 1 }), true);
});

test('luminance noise reduction removes most of the noise on a flat patch', () => {
  const g = rng(3);
  const n = 48;
  const img = image(n, n, () => [5 + g(), 0, 0]);
  const out = Detail.develop(img, n, n, { ...OFF, lumaNoise: 60 }, whiteSigmas(1));
  const before = std(img, 0, 8, 40, 8, 40, n), after = std(out, 0, 8, 40, 8, 40, n);
  assert.ok(after < before * 0.4, `${after} vs ${before}`);
});

test('luminance noise reduction keeps a hard edge', () => {
  const g = rng(4);
  const n = 48;
  const img = image(n, n, (x) => [(x < 24 ? 2 : 22) + g(), 0, 0]);
  const out = Detail.develop(img, n, n, { ...OFF, lumaNoise: 100 }, whiteSigmas(1));
  const col = (x) => { let s = 0; for (let y = 8; y < 40; y++) s += out[(y * n + x) * 3]; return s / 32; };
  assert.ok(col(22) < 4 && col(25) > 20, `${col(22)} ${col(25)}`);
});

test('colour noise reduction removes coarse colour blotches but not luma', () => {
  // Blotches ~8 px across -- what the camera JPEGs have left.
  const g = rng(5);
  const n = 64;
  const blot = [];
  for (let i = 0; i < 64; i++) blot.push([g(), g()]);
  const img = image(n, n, (x, y) => {
    const b = blot[(y >> 3) * 8 + (x >> 3)];
    return [5 + g(), 0.6 * b[0] + 0.5 * g(), 0.6 * b[1] + 0.5 * g()];
  });
  const sig = whiteSigmas(1);
  const out = Detail.develop(img, n, n, { ...OFF, colorNoise: 100 }, sig);
  assert.ok(std(out, 1, 8, 56, 8, 56, n) < std(img, 1, 8, 56, 8, 56, n) * 0.5);
  for (let i = 0; i < img.length; i += 3) assert.ok(Math.abs(out[i] - img[i]) < 1e-5);
});

test('sharpening raises contrast across an edge, and more with more amount', () => {
  const n = 32;
  const img = image(n, n, (x) => [x < 16 ? 3 : 6, 0, 0]);
  const sig = whiteSigmas(0.05);
  const at = (amt, x) => Detail.develop(img, n, n, { ...OFF, sharpenAmount: amt }, sig)[(16 * n + x) * 3];
  assert.ok(at(50, 15) < 3 && at(50, 16) > 6);
  assert.ok(at(150, 15) < at(50, 15) && at(150, 16) > at(50, 16));
});

test('sharpening leaves a flat area alone', () => {
  const img = image(24, 24, () => [0.4, 0.1, -0.2]);
  const out = Detail.develop(img, 24, 24, { ...OFF, sharpenAmount: 150, sharpenRadius: 2 }, whiteSigmas(1));
  for (let i = 0; i < img.length; i++) assert.ok(Math.abs(out[i] - img[i]) < 1e-5);
});

test('sharpening after noise reduction does not bring the noise back', () => {
  const g = rng(6);
  const n = 48;
  const img = image(n, n, () => [5 + g(), 0, 0]);
  const sig = whiteSigmas(1);
  const sharp = { ...OFF, sharpenAmount: 150, sharpenRadius: 1 };
  const sharpOnly = std(Detail.develop(img, n, n, sharp, sig), 0, 8, 40, 8, 40, n);
  const both = std(Detail.develop(img, n, n, { ...sharp, lumaNoise: 60 }, sig), 0, 8, 40, 8, 40, n);
  const nrOnly = std(Detail.develop(img, n, n, { ...OFF, lumaNoise: 60 }, sig), 0, 8, 40, 8, 40, n);
  assert.ok(both < sharpOnly * 0.5, `${both} vs ${sharpOnly}`);
  assert.ok(both < nrOnly * 1.25, `${both} vs ${nrOnly}`);
});

test('sharpen radius moves the boost to coarser layers', () => {
  assert.strictEqual(Detail.sharpenWeight(0, 0.5), 1);
  assert.strictEqual(Detail.sharpenWeight(1, 1), 1);
  assert.strictEqual(Detail.sharpenWeight(2, 2), 1);
  assert.ok(Detail.sharpenWeight(0, 2) < Detail.sharpenWeight(0, 0.5));
});

test('a lone noise spike goes with the noise around it', () => {
  const g = rng(8);
  const n = 48;
  const img = image(n, n, (x, y) => [5 + g() + (x === 24 && y === 24 ? 5 : 0), 0, 0]);
  const out = Detail.develop(img, n, n, { ...OFF, lumaNoise: 100 }, whiteSigmas(1));
  const at = (a, x, y) => a[(y * n + x) * 3];
  let around = 0;
  for (const [dx, dy] of [[-3, 0], [3, 0], [0, -3], [0, 3]]) around += at(out, 24 + dx, 24 + dy) / 4;
  assert.ok(at(out, 24, 24) - around < 2, `${at(out, 24, 24)} vs ${around}`);
});
