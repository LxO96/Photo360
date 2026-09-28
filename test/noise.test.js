'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Noise = require('../noise.js');
const Detail = require('../detail.js');

function rng(seed) {
  let s = seed >>> 0;
  const u = () => { s = (s * 1664525 + 1013904223) >>> 0; return (s + 0.5) / 4294967296; };
  return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}

const close = (a, b, rel) => Math.abs(a - b) <= rel * Math.abs(b);

test('vst and its inverse round-trip', () => {
  const a = 1e-4, b = 2e-7;
  for (const x of [0, 0.001, 0.05, 0.5, 1]) assert.ok(Math.abs(Noise.vstInverse(Noise.vst(x, a, b), a, b) - x) < 1e-9);
});

test('vst makes shot + read noise the same size at every level', () => {
  const a = 1e-4, b = 2e-7;
  const g = rng(1);
  for (const x of [0.002, 0.03, 0.3, 0.9]) {
    const s = Math.sqrt(a * x + b);
    const v = [];
    for (let i = 0; i < 4000; i++) v.push(Noise.vst(x + s * g(), a, b));
    const m = v.reduce((p, q) => p + q, 0) / v.length;
    const sd = Math.sqrt(v.reduce((p, q) => p + (q - m) * (q - m), 0) / v.length);
    assert.ok(close(sd, 1, 0.08), `x=${x}: ${sd}`);
  }
});

test('fitProfile recovers the noise model from a synthetic raw plane', () => {
  // GRBG, 14-bit, black 1026 -- like the ONE X files. The scene is a set of
  // smooth patches over the whole range, plus some texture.
  const w = 1024, h = 1024, black = 1026, white = 16383, range = white - black;
  const a = 1e-4, b = 1.7e-7;
  const g = rng(2);
  const plane = new Uint16Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const patch = ((y >> 6) * 16 + (x >> 6)) / 256;
      let s = 0.9 * Math.pow(patch, 2.5) + 0.0005 * (x & 63) / 64;
      if ((x >> 6) % 5 === 3) s += 0.05 * Math.sin(x * 1.3) * Math.sin(y * 0.7);   // texture
      const v = black + range * (s + Math.sqrt(a * Math.max(s, 0) + b) * g());
      plane[y * w + x] = Math.max(0, Math.min(white, Math.round(v)));
    }
  }
  const p = Noise.fitProfile(plane, w, h, [1, 0, 2, 1], black, white);
  assert.ok(close(p.a, a, 0.15), `a ${p.a}`);
  assert.ok(close(p.b, b, 0.3), `b ${p.b}`);
});

test('estimateSigma measures white noise in each wavelet layer', () => {
  const n = 256;
  const g = rng(3);
  const img = new Float32Array(n * n * 3).map(() => g());
  const { details } = Detail.atrous(img, n, n, 3);
  // Level 0 of the B3 a-trous for unit white noise: sqrt(1 - 2 * 0.140625 + 0.0748).
  const s = Noise.estimateSigma([{ d: details[0], w: n, h: n }]);
  s.forEach((v) => assert.ok(close(v, 0.891, 0.06), String(v)));
});

test('estimateSigma is not fooled by texture in part of the image', () => {
  const n = 256;
  const g = rng(4);
  const img = new Float32Array(n * n * 3);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const tex = x >= 128 ? 4 * Math.sin(x * 0.9) * Math.cos(y * 1.1) : 0;
      for (let c = 0; c < 3; c++) img[(y * n + x) * 3 + c] = g() + tex;
    }
  }
  const { details } = Detail.atrous(img, n, n, 1);
  Noise.estimateSigma([{ d: details[0], w: n, h: n }]).forEach((v) => assert.ok(close(v, 0.891, 0.1), String(v)));
});

test('estimateSigma reads a strided (RGBA) buffer', () => {
  const n = 64;
  const g = rng(5);
  const d = new Float32Array(n * n * 4).map((_, i) => (i % 4 === 3 ? 100 : g()));
  Noise.estimateSigma([{ d, w: n, h: n, stride: 4 }]).forEach((v) => assert.ok(close(v, 1, 0.12), String(v)));
});

test('vst keeps read noise around black symmetric', () => {
  const a = 1.33e-4, b = 1.3e-7;
  const g = rng(9);
  const v = [];
  for (let i = 0; i < 20000; i++) v.push(Noise.vst(Math.sqrt(b) * g(), a, b));
  const m = v.reduce((p, q) => p + q, 0) / v.length;
  const sd = Math.sqrt(v.reduce((p, q) => p + (q - m) * (q - m), 0) / v.length);
  const low = v.filter((x) => x < m - 4 * sd).length, high = v.filter((x) => x > m + 4 * sd).length;
  assert.ok(close(sd, 1, 0.1), String(sd));
  assert.ok(low <= high + 5, `${low} low vs ${high} high beyond 4 sigma`);
  for (const x of [-3e-3, -1e-4]) assert.ok(Math.abs(Noise.vstInverse(Noise.vst(x, a, b), a, b) - x) < 1e-12);
});

test('demosaicAt matches the shader for a green and a red site (GRBG)', () => {
  // 4 x 4 plane, value = index.
  const p = Float64Array.from({ length: 16 }, (_, i) => i);
  const cfa = [1, 0, 2, 1];
  // (1,1) is green with R left/right? Row 1 is B G B G: left neighbour (0,1) is B.
  assert.deepStrictEqual(Noise.demosaicAt(p, 4, 4, cfa, 1, 1), [(1 + 9) / 2, 5, (4 + 6) / 2]);
  // (1,0) is red: G orthogonal, B diagonal (the row above clamps to row 0).
  assert.deepStrictEqual(Noise.demosaicAt(p, 4, 4, cfa, 1, 0), [1, (0 + 2 + 1 + 5) / 4, (0 + 2 + 4 + 6) / 4]);
});

test('raw layer noise falls off from fine to coarse', () => {
  const s = Noise.rawLevelSigmas(Detail);
  assert.strictEqual(s.length, Detail.LEVELS);
  for (let k = 1; k < s.length; k++) for (let c = 0; c < 3; c++) assert.ok(s[k][c] < s[k - 1][c] * 0.75);
  // Luma averages four sensor pixels' worth of noise: well under 1.
  assert.ok(s[0][0] > 0.2 && s[0][0] < 0.5, String(s[0][0]));
});

test('capLuma limits coarse luma to a fraction of the finer layer, not chroma', () => {
  assert.deepStrictEqual(Noise.capLuma([1, 2, 3], [1, 1, 1]), [0.6, 2, 3]);
  assert.deepStrictEqual(Noise.capLuma([0.1, 2, 3], [1, 1, 1]), [0.1, 2, 3]);
  assert.deepStrictEqual(Noise.capLuma([1, 2, 3], undefined), [1, 2, 3]);
});

test('jpegSigma never goes below the JPEG floor', () => {
  assert.deepStrictEqual(Noise.jpegSigma(0, [0, 0, 0]), Noise.JPEG_FLOOR[0]);
  assert.deepStrictEqual(Noise.jpegSigma(2, [1, 0, 1]), [1, Noise.JPEG_FLOOR[2][1], 1]);
});
