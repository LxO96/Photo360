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

// -- Task 19: Highlights, Shadows, Whites, Blacks -------------------------
// Edge.toneCurve(y, tone) is the global luminance curve the four sliders
// build (each -100..100); applyTone applies it as a luminance ratio after
// exposure and before contrast/saturation. shaders.js mirrors both exactly.
const CURVE_KEYS = ['highlights', 'shadows', 'whites', 'blacks'];
const ZERO4 = { highlights: 0, shadows: 0, whites: 0, blacks: 0 };
const YS = Array.from({ length: 1001 }, (_, i) => i / 1000);

test('the tone curve is exactly the identity with all four sliders at zero', () => {
  for (const y of YS) assert.strictEqual(Edge.toneCurve(y, ZERO4), y);
  // ...and missing keys (an old tone object) count as zero.
  for (const y of YS) assert.strictEqual(Edge.toneCurve(y, NEUTRAL), y);
});

test('applyTone with all seven controls at zero is an exact pass-through', () => {
  const c = [0.2, 0.5, 0.9];
  assert.deepStrictEqual(Edge.applyTone(c, { ...NEUTRAL, ...ZERO4 }), c);
});

test('applyTone is unchanged for exposure/contrast/saturation when the four new sliders are zero', () => {
  const t = { exposureEv: 0.7, contrast: 0.3, saturation: -0.2 };
  const c = [0.3, 0.45, 0.12];
  assert.deepStrictEqual(Edge.applyTone(c, { ...t, ...ZERO4 }), Edge.applyTone(c, t));
});

function assertMonotoneInRange(tone, label) {
  let prev = -Infinity;
  for (const y of YS) {
    const v = Edge.toneCurve(y, tone);
    assert.ok(v >= prev - 1e-12, `${label}: not monotonic at ${y} (${v} < ${prev})`);
    assert.ok(v >= 0 && v <= 1, `${label}: ${v} out of [0, 1] at ${y}`);
    prev = v;
  }
}

test('each slider alone keeps the curve monotonic and inside [0, 1] across its range', () => {
  for (const k of CURVE_KEYS) {
    for (let v = -100; v <= 100; v += 5) assertMonotoneInRange({ ...ZERO4, [k]: v }, `${k}=${v}`);
  }
});

test('every combination of the four sliders at -100 / 0 / +100 stays monotonic and in [0, 1]', () => {
  const vals = [-100, 0, 100];
  for (const h of vals) for (const s of vals) for (const w of vals) for (const b of vals) {
    assertMonotoneInRange({ highlights: h, shadows: s, whites: w, blacks: b }, `h${h} s${s} w${w} b${b}`);
  }
});

test('direction: each slider moves its own part of the curve the right way', () => {
  const f = (k, v, y) => Edge.toneCurve(y, { ...ZERO4, [k]: v });
  for (const v of [25, 100]) {
    assert.ok(f('highlights', v, 0.8) > 0.8, `+highlights ${v}`);
    assert.ok(f('highlights', -v, 0.8) < 0.8, `-highlights ${v}`);
    assert.ok(f('shadows', v, 0.2) > 0.2, `+shadows ${v}`);
    assert.ok(f('shadows', -v, 0.2) < 0.2, `-shadows ${v}`);
    assert.ok(f('whites', v, 0.95) > 0.95, `+whites ${v}`);
    assert.ok(f('whites', -v, 0.95) < 0.95, `-whites ${v}`);
    assert.ok(f('blacks', v, 0.05) > 0.05, `+blacks ${v}`);
    assert.ok(f('blacks', -v, 0.05) < 0.05, `-blacks ${v}`);
  }
});

test('Highlights barely touch deep shadows, and Shadows barely touch bright highlights', () => {
  for (const v of [-100, 100]) {
    assert.ok(Math.abs(Edge.toneCurve(0.1, { ...ZERO4, highlights: v }) - 0.1) < 0.005, `highlights ${v}`);
    assert.ok(Math.abs(Edge.toneCurve(0.9, { ...ZERO4, shadows: v }) - 0.9) < 0.005, `shadows ${v}`);
  }
});

test('Whites and Blacks move the end points', () => {
  assert.strictEqual(Edge.toneCurve(1, { ...ZERO4, whites: -100 }) < 1, true);
  assert.strictEqual(Edge.toneCurve(0, { ...ZERO4, blacks: 100 }) > 0, true);
  // Highlights and Shadows alone leave both end points exactly where they are.
  for (const k of ['highlights', 'shadows']) {
    for (const v of [-100, 100]) {
      assert.strictEqual(Edge.toneCurve(0, { ...ZERO4, [k]: v }), 0);
      assert.strictEqual(Edge.toneCurve(1, { ...ZERO4, [k]: v }), 1);
    }
  }
});

const lin = (c) => c.map(Edge.srgbDecode);

test('the curve and contrast scale linear light, so hue and saturation (linear ratios) are kept', () => {
  const c = [0.6, 0.3, 0.15];
  for (const t of [{ ...NEUTRAL, highlights: -60, shadows: 40 }, { ...NEUTRAL, contrast: 0.8 }, { ...NEUTRAL, contrast: -0.6 }]) {
    const a = lin(c), b = lin(Edge.applyTone(c, t));
    assert.ok(Math.abs(b[0] / b[1] - a[0] / a[1]) < 1e-9, JSON.stringify(t));
    assert.ok(Math.abs(b[2] / b[1] - a[2] / a[1]) < 1e-9, JSON.stringify(t));
    assert.notStrictEqual(b[1], a[1]);
  }
});

test('the curve runs after exposure and before contrast', () => {
  const t = { exposureEv: 1, contrast: 0.4, saturation: 0, ...ZERO4, shadows: 50 };
  const c = [0.1, 0.1, 0.1];
  const y = Edge.toneCurve(0.2, t);           // exposure first: 0.1 -> 0.2
  const expected = Edge.contrastCurve(y, 0.4); // then contrast
  const out = Edge.applyTone(c, t);
  assert.ok(Math.abs(out[0] - expected) < 1e-12, `${out[0]} vs ${expected}`);
});

test('contrast is a smooth S-curve: slope 1 + contrast at mid grey, never clipping', () => {
  for (const k of [-0.9, -0.5, 0.5, 1]) {
    const d = 1e-6;
    const slope = (Edge.contrastCurve(0.5 + d, k) - Edge.contrastCurve(0.5 - d, k)) / (2 * d);
    assert.ok(Math.abs(slope - (1 + k)) < 1e-4, `${k}: ${slope}`);
    let prev = -1;
    for (const y of YS) {
      const v = Edge.contrastCurve(y, k);
      assert.ok(v >= prev && v >= 0 && v <= 1, `${k} at ${y}`);
      prev = v;
    }
    // Highlights and shadows are compressed, not cut off.
    assert.ok(Edge.contrastCurve(0.95, k) < 1 && Edge.contrastCurve(0.05, k) > 0);
  }
});

test('saturation keeps OKLab lightness and hue', () => {
  const c = [0.7, 0.45, 0.3];
  for (const s of [-0.5, 0.5, 1]) {
    const a = Edge.toOklab(lin(c)), b = Edge.toOklab(lin(Edge.applyTone(c, { ...NEUTRAL, saturation: s })));
    assert.ok(Math.abs(a[0] - b[0]) < 1e-6, `L at ${s}`);
    assert.ok(Math.abs(Math.atan2(a[2], a[1]) - Math.atan2(b[2], b[1])) < 1e-6, `hue at ${s}`);
    const ca = Math.hypot(a[1], a[2]), cb = Math.hypot(b[1], b[2]);
    assert.ok(s > 0 ? cb > ca : cb < ca, `chroma at ${s}`);
  }
});

test('raised saturation eases off at the gamut instead of clipping into another hue', () => {
  // Already vivid colours: no channel is cut, hue stays.
  for (const c of [[0.95, 0.2, 0.1], [0.1, 0.8, 0.2], [0.2, 0.3, 0.95], [0.9, 0.85, 0.1]]) {
    const out = Edge.applyTone(c, { ...NEUTRAL, saturation: 1 });
    const l = lin(out);
    assert.ok(Math.min(...l) >= -1e-9 && Math.max(...l) <= 1 + 1e-9, JSON.stringify(out));
    const a = Edge.toOklab(lin(c)), b = Edge.toOklab(l);
    assert.ok(Math.abs(Math.atan2(a[2], a[1]) - Math.atan2(b[2], b[1])) < 1e-3, JSON.stringify(c));
    assert.ok(Math.hypot(b[1], b[2]) >= Math.hypot(a[1], a[2]) - 1e-9, 'never less saturated');
  }
});

test('colours pushed past white by exposure fade toward white, not into another hue', () => {
  const c = [0.9, 0.6, 0.3];
  const out = Edge.applyTone(c, { ...NEUTRAL, exposureEv: 0.6 });
  assert.ok(Math.max(...out) <= 1 && Math.min(...out) >= 0);
  // Order of the channels (so the hue family) is kept, and it is lighter.
  assert.ok(out[0] >= out[1] && out[1] >= out[2]);
  assert.ok(Edge.lightness(out) > Edge.lightness(c));
});

test('black input with lifted Blacks becomes a neutral grey (no division by zero)', () => {
  const out = Edge.applyTone([0, 0, 0], { ...NEUTRAL, ...ZERO4, blacks: 100 });
  assert.ok(out[0] > 0 && out[0] === out[1] && out[1] === out[2]);
});

test('luminance above 1 (after exposure) passes through the curve and ends as white', () => {
  const t = { ...NEUTRAL, ...ZERO4, exposureEv: 1, highlights: -50 };
  const a = Edge.applyTone([0.6, 0.6, 0.6], t);
  assert.deepStrictEqual(a.map((v) => Math.round(v * 1e9) / 1e9), [1, 1, 1]);
});

// The GPU half of the tone parity check (App.checkToneParity) renders
// Shaders.TONE_PARITY_FS; it only proves anything about the shipped
// shaders if that is the very same TONE_GLSL both composite shaders use.
test('both composite shaders and the tone parity shader share one TONE_GLSL', () => {
  const Shaders = require('../shaders.js');
  for (const name of ['COMPOSITE_FS', 'COMPOSITE_RAW_FS', 'TONE_PARITY_FS']) {
    assert.ok(Shaders[name].includes(Shaders.TONE_GLSL), name);
  }
  for (const name of ['COMPOSITE_FS', 'COMPOSITE_RAW_FS']) {
    assert.ok(Shaders[name].includes('applyTone(img, uTone, uToneCurve, toneCoef'), name);
  }
});
