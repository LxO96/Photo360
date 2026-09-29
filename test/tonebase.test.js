'use strict';
const test = require('node:test');
const assert = require('node:assert');
const ToneBase = require('../tonebase.js');
const Edge = require('../edge.js');

const NEUTRAL = { exposureEv: 0, contrast: 0, saturation: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0 };

function frame(w, h, fn) {
  const l = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) l[y * w + x] = fn(x, y);
  return l;
}

// Tone at pixel (x, y) of a grey frame, locally (with the base) or not.
function toned(m, l, w, x, y, tone) {
  const v = l[y * w + x];
  const coef = m ? ToneBase.sample(m, x + 0.5, y + 0.5) : undefined;
  return Edge.applyTone([v, v, v], tone, coef)[0];
}

test('a flat frame is its own base', () => {
  const l = frame(64, 48, () => 0.4);
  const m = ToneBase.build(l, 64, 48);
  const [a, b] = ToneBase.sample(m, 20.5, 30.5);
  assert.ok(Math.abs(a * 0.4 + b - 0.4) < 1e-6);
});

test('partial edge blocks average what they have', () => {
  const l = frame(6, 5, (x) => (x >= 4 ? 1 : 0));
  const d = ToneBase.downsample(l, 6, 5);
  assert.deepStrictEqual([d.w, d.h], [2, 2]);
  assert.strictEqual(d.I[1], 1);
  assert.strictEqual(d.I[0], 0);
});

test('sample reads block centres exactly and blends between them', () => {
  const m = { w: 2, h: 1, A: Float32Array.from([0, 1]), B: Float32Array.from([0, 0]) };
  assert.strictEqual(ToneBase.sample(m, 2, 2)[0], 0);
  assert.strictEqual(ToneBase.sample(m, 6, 2)[0], 1);
  assert.strictEqual(ToneBase.sample(m, 4, 2)[0], 0.5);
  assert.strictEqual(ToneBase.sample(m, 0, 2)[0], 0);    // clamped
});

test('pulling Highlights keeps the texture of a bright area (the global curve flattens it)', () => {
  const w = 256, h = 256;
  const l = frame(w, h, (x) => 0.65 + 0.04 * Math.sin(x * 2 * Math.PI / 6));
  const m = ToneBase.build(l, w, h);
  const tone = { ...NEUTRAL, highlights: -100 };
  const range = (f) => {
    let lo = Infinity, hi = -Infinity;
    for (let x = 120; x < 132; x++) { const v = f(x); lo = Math.min(lo, v); hi = Math.max(hi, v); }
    return hi - lo;
  };
  const input = range((x) => l[128 * w + x]);
  const amp = (mm) => range((x) => toned(mm, l, w, x, 128, tone)) / input;
  const local = amp(m), global = amp(null);
  assert.ok(local > 0.9, `local keeps ${local}`);
  assert.ok(global < 0.75, `global keeps ${global}`);
  // ...and the area is still pulled down as a whole.
  assert.ok(toned(m, l, w, 128, 128, tone) < 0.62);
});

test('no halo: beside a hard edge the local result is the global one', () => {
  const w = 256, h = 128;
  const l = frame(w, h, (x) => (x < 128 ? 0.15 : 0.85));
  const m = ToneBase.build(l, w, h);
  for (const tone of [{ ...NEUTRAL, highlights: -100 }, { ...NEUTRAL, shadows: 100 }]) {
    for (let x = 90; x < 170; x++) {
      const d = Math.abs(toned(m, l, w, x, 64, tone) - toned(null, l, w, x, 64, tone));
      // Only the pixels right at the edge differ at all (a touch crisper).
      const lim = x >= 126 && x < 130 ? 0.045 : 0.01;
      assert.ok(d < lim, `x=${x} ${JSON.stringify(tone)}: ${d}`);
    }
  }
});

test('the base window is a fixed share of the frame', () => {
  assert.strictEqual(ToneBase.radius(1488, 1488), 30);
  assert.strictEqual(ToneBase.radius(760, 760), 15);
  assert.strictEqual(ToneBase.radius(10, 10), 1);
});

test('hsSlope is the curve\'s derivative', () => {
  const t = { highlights: -70, shadows: 55 };
  for (const y of [0.05, 0.3, 0.5, 0.8, 0.97]) {
    const d = 1e-6;
    const num = (Edge.hsCurve(y + d, t) - Edge.hsCurve(y - d, t)) / (2 * d);
    assert.ok(Math.abs(Edge.hsSlope(y, t) - num) < 1e-6, String(y));
  }
});

test('near white, pulled Highlights bring out texture at least as much as the plain curve', () => {
  // Pale cloud texture on a bright sky: the plain curve's slope there is
  // above 1, and the local version keeps that.
  const w = 256, h = 256;
  const l = frame(w, h, (x) => 0.93 + 0.03 * Math.sin(x * 2 * Math.PI / 6));
  const m = ToneBase.build(l, w, h);
  const tone = { ...NEUTRAL, highlights: -90 };
  const range = (mm) => {
    let lo = Infinity, hi = -Infinity;
    for (let x = 120; x < 132; x++) { const v = toned(mm, l, w, x, 128, tone); lo = Math.min(lo, v); hi = Math.max(hi, v); }
    return hi - lo;
  };
  assert.ok(range(m) >= range(null) * 0.95, `${range(m)} vs ${range(null)}`);
});
