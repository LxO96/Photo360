'use strict';
const test = require('node:test');
const assert = require('node:assert');
const AutoTone = require('../autotone.js');
const Edge = require('../edge.js');
const Scopes = require('../scopes.js');

const N = 256;

// A luma histogram of display values drawn from `values` (0..1), binned
// like Scopes.histogram: bin i holds the values nearest i / (N - 1).
function hist(values) {
  const bins = new Array(N).fill(0);
  for (const v of values) bins[Math.min(N - 1, Math.max(0, Math.round(v * (N - 1))))]++;
  return bins;
}

// Evenly spread values between lo and hi, `n` of them.
function spread(lo, hi, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(lo + (hi - lo) * (i + 0.5) / n);
  return out;
}

// Where display luma y lands with the solved tone applied.
function mapped(y, t) {
  const full = Object.assign({ contrast: 0, saturation: 0 }, t);
  return Math.min(1, Math.max(0, Edge.applyTone([y, y, y], full)[0]));
}

test('percentile reads the histogram at bin values', () => {
  const b = hist(spread(0, 1, 1000));
  assert.ok(Math.abs(AutoTone.percentile(b, 0.5) - 0.5) < 0.01);
  assert.ok(Math.abs(AutoTone.percentile(b, 0.1) - 0.1) < 0.01);
});

test('an empty histogram has nothing to solve', () => {
  assert.strictEqual(AutoTone.solve(new Array(N).fill(0)), null);
});

test('a dark image is brightened towards mid grey', () => {
  const t = AutoTone.solve(hist(spread(0.05, 0.35, 2000)));
  assert.ok(t.exposureEv > 0.5, JSON.stringify(t));
  const b = hist(spread(0.05, 0.35, 2000));
  const med = mapped(AutoTone.percentile(b, 0.5), t);
  assert.ok(med > 0.38 && med < 0.56, `median lands at ${med}`);
});

test('a bright image is eased down a little, its highlights recovered, its middle kept', () => {
  const t = AutoTone.solve(hist(spread(0.55, 0.95, 2000)));
  assert.ok(t.exposureEv < 0 && t.exposureEv > -0.3, JSON.stringify(t));
  assert.ok(t.highlights < 0, JSON.stringify(t));
  assert.ok(mapped(0.75, Object.assign({ saturation: 0 }, t)) >= 0.6, JSON.stringify(t));
});

test('a well-exposed full-range image is left nearly alone', () => {
  const t = AutoTone.solve(hist(spread(0.01, 0.97, 4000)));
  assert.ok(Math.abs(t.exposureEv) < 0.15, JSON.stringify(t));
  // The ends already reach: no stretch.
  for (const k of ['whites', 'blacks']) assert.ok(Math.abs(t[k]) <= 15, `${k} = ${t[k]}`);
  // Only the usual moderate recovery, and contrast to match.
  assert.ok(t.highlights >= -45 && t.shadows <= 45, JSON.stringify(t));
  assert.ok(t.contrast <= 0.3, JSON.stringify(t));
});

test('a flat, low-contrast image is stretched with whites and blacks', () => {
  const t = AutoTone.solve(hist(spread(0.3, 0.62, 3000)));
  assert.ok(t.whites > 0, JSON.stringify(t));
  assert.ok(t.blacks < 0, JSON.stringify(t));
});

test('exposure never exceeds the +-2 EV limit and values are slider-ready', () => {
  const t = AutoTone.solve(hist(spread(0.001, 0.02, 500)));
  assert.ok(t.exposureEv <= 2 && t.exposureEv >= -2);
  for (const k of ['highlights', 'shadows', 'whites', 'blacks']) {
    assert.ok(Number.isInteger(t[k]) && t[k] >= -100 && t[k] <= 100, `${k} = ${t[k]}`);
  }
  assert.strictEqual(Math.round(t.exposureEv * 100) / 100, t.exposureEv);
});

test('a dark image with a few bright highlights does not blow them out', () => {
  const vals = spread(0.05, 0.3, 1900).concat(spread(0.85, 0.95, 100));
  const t = AutoTone.solve(hist(vals));
  assert.ok(mapped(0.9, t) < 1, JSON.stringify(t));
});

test('black outside the photo circles does not change the result', () => {
  // A 64 x 64 frame: a mid-grey-ish disc inside a black surround. With the
  // circle mask the surround is ignored; without it the black would drag
  // the median down and auto tone would brighten.
  const w = 64, h = 64, px = new Uint8ClampedArray(w * h * 4);
  const cx = 32, cy = 32, rad = 20;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const inside = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= rad;
    const v = inside ? 90 + ((x * 7 + y * 3) % 80) : 0;
    px[i] = px[i + 1] = px[i + 2] = v; px[i + 3] = 255;
  }
  const include = Scopes.insideCircles([{ cx, cy, radius: rad }]);
  const lumaHist = (opts) => Scopes.histogram(px, w, h, Object.assign({ bins: N, mode: 'luma' }, opts)).channels[0];
  const masked = AutoTone.solve(lumaHist({ include }));
  // The disc's pixels alone, as a one-row image.
  const disc = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (include(x, y)) disc.push(...px.slice((y * w + x) * 4, (y * w + x) * 4 + 4));
  }
  const discPx = Uint8ClampedArray.from(disc);
  const reference = AutoTone.solve(
    Scopes.histogram(discPx, discPx.length / 4, 1, { bins: N, mode: 'luma' }).channels[0]);
  assert.deepStrictEqual(masked, reference);
  const unmasked = AutoTone.solve(lumaHist({}));
  assert.ok(unmasked.exposureEv > masked.exposureEv);
});

test('Auto recovers the ends and puts contrast back in the middle', () => {
  // A bright, hazy scene: a bright tail to recover, a flat middle.
  const t = AutoTone.solve(hist(spread(0.3, 0.9, 3000)));
  assert.ok(t.contrast > 0.1, JSON.stringify(t));
  // The middle half ends up spread to the target.
  const full = Object.assign({ saturation: 0 }, t);
  const iqr = mapped(0.75, full) - mapped(0.25, full);
  assert.ok(iqr > 0.3, String(iqr));
  // A contrasty scene gets no more contrast.
  const hard = AutoTone.solve(hist(spread(0.02, 0.12, 1000).concat(spread(0.85, 0.97, 1000))));
  assert.ok(hard.contrast <= 0, JSON.stringify(hard));
});

test('clipped sky is not pulled grey by Highlights, and blacks stay gentle', () => {
  // A mid-toned scene with 10% blown to white.
  const vals = spread(0.08, 0.7, 1800).concat(new Array(200).fill(1));
  const t = AutoTone.solve(hist(vals));
  // Highlights never moves pure white, so the blown sky stays white.
  assert.ok(mapped(1, Object.assign({ saturation: 0 }, t)) > 0.99, JSON.stringify(t));
  assert.ok(t.highlights >= -30, JSON.stringify(t));
  assert.ok(t.blacks >= -45, JSON.stringify(t));
});
