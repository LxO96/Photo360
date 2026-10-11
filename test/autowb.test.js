'use strict';
const test = require('node:test');
const assert = require('node:assert');
const AutoWb = require('../src/autowb.js');
const Wb = require('../src/wb.js');

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return (s + 0.5) / 4294967296; };
}

// Camera samples of surfaces (balanced colours, 0..1) under light `n`.
function scene(n, surfaces, count, seed) {
  const u = rng(seed);
  const out = [];
  for (let i = 0; i < count; i++) {
    let r = u(), acc = 0, s = surfaces[surfaces.length - 1];
    for (const x of surfaces) { acc += x.share; if (r < acc) { s = x; break; } }
    const k = 0.2 + 0.6 * u();
    const jitter = () => 1 + 0.03 * (u() - 0.5);
    out.push([s.rgb[0] * k * n[0] * jitter(), s.rgb[1] * k * jitter(), s.rgb[2] * k * n[2] * jitter()]);
  }
  return out;
}

const close = (a, b, rel) => a.every((v, i) => Math.abs(v - b[i]) <= rel * Math.abs(b[i]));
const GREY = { rgb: [0.8, 0.8, 0.8] };

test('a grey scene gives the light back', () => {
  for (const n of [[2.1, 1, 1.4], [1.5, 1, 2.2], [1.9, 1, 1.9]]) {
    const r = AutoWb.estimate(scene(n, [{ ...GREY, share: 1 }], 4000, 1));
    assert.ok(close(r.neutral, n, 0.03), `${r.neutral} vs ${n}`);
    assert.strictEqual(r.method, 'grey pixels');
  }
});

test('a big green lawn does not pull it (a plain average would)', () => {
  const n = [2.0, 1, 1.5];
  const s = scene(n, [{ rgb: [0.25, 0.7, 0.15], share: 0.6 }, { ...GREY, share: 0.25 }, { rgb: [0.3, 0.45, 0.8], share: 0.15 }], 6000, 2);
  const r = AutoWb.estimate(s);
  assert.ok(close(r.neutral, n, 0.05), `grey pixels: ${r.neutral}`);
  // Grey world, for comparison: far off.
  const m = [0, 1, 2].map((k) => s.reduce((a, c) => a + c[k], 0));
  const gw = [m[0] / m[1], 1, m[2] / m[1]];
  assert.ok(!close(gw, n, 0.15), `grey world: ${gw}`);
});

test('a scene of one strong colour cannot land on a strong green or magenta cast', () => {
  // Any estimate reads a one-colour scene as grey; the locus limit is what
  // keeps the damage down.
  const m = [0.8, -0.2, -0.1, -0.4, 1.2, 0.2, -0.05, 0.1, 0.6];
  const n = Wb.neutralFromKelvinTint(5500, 0, m);
  const r = AutoWb.estimate(scene(n, [{ rgb: [0.2, 0.8, 0.1], share: 1 }], 2000, 3));
  const kt = AutoWb.toKelvinTint(r.neutral, m);
  assert.ok(Math.abs(kt.tint) <= AutoWb.TINT_LIMIT, JSON.stringify(kt));
  assert.strictEqual(AutoWb.estimate([]), null);
});

test('starting from the camera, a blue sky stays out of the grey average', () => {
  const n = [2.0, 1, 1.6];
  const sky = { rgb: [0.45, 0.62, 0.85], share: 0.5 };
  const s = scene(n, [sky, { ...GREY, share: 0.2 }, { rgb: [0.3, 0.55, 0.2], share: 0.3 }], 6000, 5);
  const fromCamera = AutoWb.estimate(s, [2.1, 1, 1.5]);
  assert.ok(close(fromCamera.neutral, n, 0.04), `from as-shot: ${fromCamera.neutral}`);
  assert.strictEqual(fromCamera.method, 'grey pixels');
});

test('too few near-grey samples keeps the shades-of-grey answer', () => {
  // Two equal, strongly coloured halves: nothing is near grey under their
  // shades-of-grey mean.
  const s = scene([1, 1, 1], [{ rgb: [0.9, 0.2, 0.1], share: 0.5 }, { rgb: [0.1, 0.3, 0.9], share: 0.5 }], 2000, 4);
  assert.strictEqual(AutoWb.estimate(s).method, 'shades-of-grey');
});

test('sampling keeps the photo circle and drops clipped and dark cells', () => {
  const w = 64, h = 64, black = 100, white = 4100;
  const cfa = [1, 0, 2, 1];   // GRBG
  const plane = new Uint16Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ch = cfa[(y % 2) * 2 + (x % 2)];
      let v = [0.4, 0.2, 0.3][ch];
      if (x < 8 && y < 8) v = 0.9;                // outside the circle anyway
      if (x >= 28 && x < 32 && y >= 28 && y < 32) v = ch === 0 ? 0.99 : 0.5;   // clipped red
      if (x >= 36 && x < 40 && y >= 28 && y < 32) v = 0.01;                    // dark
      plane[y * w + x] = Math.round(black + v * (white - black));
    }
  }
  const s = AutoWb.sample(plane, w, h, cfa, black, white, 30);
  assert.ok(s.length > 100);
  for (const c of s) assert.ok(close(c, [0.4, 0.2, 0.3], 0.01), String(c));
});

test('the result stays near the daylight / lamp locus', () => {
  const m = [0.8, -0.2, -0.1, -0.4, 1.2, 0.2, -0.05, 0.1, 0.6];
  const n = Wb.neutralFromKelvinTint(5000, 60, m);   // a strong magenta
  const kt = AutoWb.toKelvinTint(n, m);
  assert.strictEqual(kt.tint, AutoWb.TINT_LIMIT);
  assert.ok(Math.abs(kt.kelvin - 5000) < 300, String(kt.kelvin));
  const ok = AutoWb.toKelvinTint(Wb.neutralFromKelvinTint(3200, -8, m), m);
  assert.ok(Math.abs(ok.tint + 8) < 0.5 && Math.abs(ok.kelvin - 3200) < 50, JSON.stringify(ok));
  // Around the camera's own as-shot tint (where its greys sit) instead.
  const cam = AutoWb.toKelvinTint(Wb.neutralFromKelvinTint(5000, 60, m), m, 75);
  assert.ok(Math.abs(cam.tint - 60) < 0.5, JSON.stringify(cam));
  const far = AutoWb.toKelvinTint(Wb.neutralFromKelvinTint(5000, 10, m), m, 75);
  assert.strictEqual(far.tint, 75 - AutoWb.TINT_LIMIT);
});
