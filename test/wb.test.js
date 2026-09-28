'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Wb = require('../wb.js');
global.Lens = require('../lens.js');
global.Exif = require('../exif.js');
global.Dng = require('../dng.js');
global.Wb = Wb;
const Source = require('../source.js');

const DIR = path.join(__dirname, '..', 'Testfiles');
const FILES = [
  'IMG_20180101_044910_00_030.dng',
  'IMG_20240825_174323_00_010.dng',
  'IMG_20240825_174907_00_020.dng',
];

function load(name) {
  return new Uint8Array(fs.readFileSync(path.join(DIR, name)));
}

// -- 1. Kelvin -> xy lands on published Planckian-locus points ------------
test('2856 K (illuminant A) lands near its published chromaticity', () => {
  const xy = Wb.kelvinToXyOnLocus(2856);
  assert.ok(Math.abs(xy.x - 0.4476) < 0.002, 'x=' + xy.x);
  assert.ok(Math.abs(xy.y - 0.4074) < 0.002, 'y=' + xy.y);
});

test('6504 K lands near the D65-region chromaticity', () => {
  // The published Planckian-locus point at 6500-6504 K (e.g. Kim et al.'s
  // own worked table) is (0.3135, 0.3237) -- distinct from the D65
  // *illuminant*'s (0.3127, 0.3290), which sits off the pure-blackbody
  // locus by design (a small positive Duv); that offset is exactly what
  // this task's tint control models, so this test checks against the
  // locus itself, not the illuminant.
  const xy = Wb.kelvinToXyOnLocus(6504);
  assert.ok(Math.abs(xy.x - 0.3135) < 0.002, 'x=' + xy.x);
  assert.ok(Math.abs(xy.y - 0.3237) < 0.002, 'y=' + xy.y);
});

// -- 2. Tint direction and magnitude ---------------------------------------
test('tint 0 stays exactly on the locus', () => {
  const kelvin = 5500;
  const locus = Wb.kelvinToXyOnLocus(kelvin);
  const displaced = Wb.kelvinTintToXy(kelvin, 0);
  assert.ok(Math.abs(displaced.x - locus.x) < 1e-9);
  assert.ok(Math.abs(displaced.y - locus.y) < 1e-9);
});

test('positive tint moves toward magenta (v decreases) by the expected Duv', () => {
  const kelvin = 5500;
  const locusUv = Wb.xyToUv(Wb.kelvinToXyOnLocus(kelvin).x, Wb.kelvinToXyOnLocus(kelvin).y);
  const plusXy = Wb.kelvinTintToXy(kelvin, 30);
  const plusUv = Wb.xyToUv(plusXy.x, plusXy.y);
  assert.ok(plusUv.v < locusUv.v, 'v should decrease for positive tint');
  const duv = Math.hypot(plusUv.u - locusUv.u, plusUv.v - locusUv.v);
  assert.ok(Math.abs(duv - 30 / 3000) < 1e-6, 'Duv=' + duv);
});

test('negative tint moves toward green (v increases) by the expected Duv', () => {
  const kelvin = 5500;
  const locusUv = Wb.xyToUv(Wb.kelvinToXyOnLocus(kelvin).x, Wb.kelvinToXyOnLocus(kelvin).y);
  const minusXy = Wb.kelvinTintToXy(kelvin, -30);
  const minusUv = Wb.xyToUv(minusXy.x, minusXy.y);
  assert.ok(minusUv.v > locusUv.v, 'v should increase for negative tint');
  const duv = Math.hypot(minusUv.u - locusUv.u, minusUv.v - locusUv.v);
  assert.ok(Math.abs(duv - 30 / 3000) < 1e-6, 'Duv=' + duv);
});

// -- 3/4. Round-trip through a real ColorMatrix1 ---------------------------
const REAL_MATRIX = global.Dng.parse(load(FILES[0])).colorMatrix1;

test('a real DNG actually has a ColorMatrix1 to test against', () => {
  assert.ok(REAL_MATRIX && REAL_MATRIX.length === 9, 'ColorMatrix1 should be a 9-element array');
});

test('kelvinTintFromNeutral(neutralFromKelvinTint(K, t)) round-trips within 20 K and 1 tint unit', () => {
  const kelvins = [2500, 3500, 5000, 6500, 8000, 10000];
  const tints = [-100, -50, 0, 50, 100];
  for (const k of kelvins) {
    for (const t of tints) {
      const neutral = Wb.neutralFromKelvinTint(k, t, REAL_MATRIX);
      const back = Wb.kelvinTintFromNeutral(neutral, REAL_MATRIX);
      assert.ok(Math.abs(back.kelvin - k) < 20,
        `kelvin round-trip: ${k} -> ${back.kelvin}`);
      assert.ok(Math.abs(back.tint - t) < 1,
        `tint round-trip: ${t} -> ${back.tint} (K=${k})`);
    }
  }
});

// neutralFromKelvinTint's tint is the *rendered-result* tint (matching
// Lightroom: +tint looks magenta), the negation of kelvinTintToXy's own
// *assumed-illuminant* tint (+tint moves the illuminant chromaticity
// toward magenta, tested above) -- dividing the raw pixel by an
// assumed-magenta-illuminant's own neutral *removes* magenta. This is
// exactly the inversion a first implementation gets wrong, so it is
// pinned down against the real camera pipeline (colorMatrix1 + the
// as-shot neutral as a stand-in for "a neutral subject really shot under
// this file's light"), not just the abstract locus maths above.
test('positive tint renders a neutral subject more magenta (R and B up, G down), matching Lightroom', () => {
  const bytes = load(FILES[1]);
  const d = global.Dng.parse(bytes);
  const base = Wb.kelvinTintFromNeutral(d.asShotNeutral, REAL_MATRIX);
  const neutralAtBase = Wb.neutralFromKelvinTint(base.kelvin, base.tint, REAL_MATRIX);
  const neutralAtPlus = Wb.neutralFromKelvinTint(base.kelvin, base.tint + 50, REAL_MATRIX);
  const neutralAtMinus = Wb.neutralFromKelvinTint(base.kelvin, base.tint - 50, REAL_MATRIX);
  // "Rendered" R and B for a subject that is truly neutral under this
  // file's own as-shot light: d.asShotNeutral / neutral(base+-50).
  const renderedPlus = [d.asShotNeutral[0] / neutralAtPlus[0], d.asShotNeutral[2] / neutralAtPlus[2]];
  const renderedMinus = [d.asShotNeutral[0] / neutralAtMinus[0], d.asShotNeutral[2] / neutralAtMinus[2]];
  assert.ok(renderedPlus[0] > renderedMinus[0], 'positive tint should raise R relative to negative tint');
  assert.ok(renderedPlus[1] > renderedMinus[1], 'positive tint should raise B relative to negative tint');
  assert.ok(neutralAtPlus[1] === 1 && neutralAtMinus[1] === 1 && neutralAtBase[1] === 1);
});

test('neutralFromKelvinTint always normalises green to 1', () => {
  const neutral = Wb.neutralFromKelvinTint(4000, 20, REAL_MATRIX);
  assert.strictEqual(neutral[1], 1);
});

// -- The three real DNGs' as-shot Kelvin/tint ------------------------------
test('each supplied DNG maps AsShotNeutral to a plausible daylight-ish Kelvin', () => {
  for (const name of FILES) {
    const bytes = load(name);
    const d = global.Dng.parse(bytes);
    const cm1 = d.colorMatrix1;
    assert.ok(cm1, name + ' should have a ColorMatrix1');
    const kt = Wb.kelvinTintFromNeutral(d.asShotNeutral, cm1);
    console.log(`  as-shot: ${name} -> ${kt.kelvin.toFixed(0)} K, tint ${kt.tint.toFixed(1)}`);
    assert.ok(kt.kelvin > 3500 && kt.kelvin < 8000,
      `${name}: as-shot Kelvin ${kt.kelvin} is not plausible daylight`);
  }
});

// -- Slider mappings ---------------------------------------------------------
test('Kelvin slider mapping is monotonic, hits endpoints exactly, and inverts', () => {
  assert.strictEqual(Wb.sliderToKelvin(0), 2000);
  assert.strictEqual(Wb.sliderToKelvin(1), 12000);
  assert.strictEqual(Wb.kelvinToSlider(2000), 0);
  assert.ok(Math.abs(Wb.kelvinToSlider(12000) - 1) < 1e-12);
  let prev = -Infinity;
  for (let s = 0; s <= 1.0001; s += 0.05) {
    const k = Wb.sliderToKelvin(s);
    assert.ok(k > prev, 'kelvin slider mapping must be monotonic');
    prev = k;
  }
  for (let s = 0; s <= 1; s += 0.1) {
    const k = Wb.sliderToKelvin(s);
    assert.ok(Math.abs(Wb.kelvinToSlider(k) - s) < 1e-9, `s=${s} k=${k}`);
  }
});

test('Tint slider mapping is monotonic, hits endpoints exactly, and inverts', () => {
  assert.strictEqual(Wb.sliderToTint(-1), -150);
  assert.strictEqual(Wb.sliderToTint(0), 0);
  assert.strictEqual(Wb.sliderToTint(1), 150);
  assert.strictEqual(Wb.tintToSlider(-150), -1);
  assert.strictEqual(Wb.tintToSlider(0), 0);
  assert.ok(Math.abs(Wb.tintToSlider(150) - 1) < 1e-12);
  let prev = -Infinity;
  for (let s = -1; s <= 1.0001; s += 0.05) {
    const t = Wb.sliderToTint(s);
    assert.ok(t > prev, 'tint slider mapping must be monotonic');
    prev = t;
  }
  for (let s = -1; s <= 1; s += 0.1) {
    const t = Wb.sliderToTint(s);
    assert.ok(Math.abs(Wb.tintToSlider(t) - s) < 1e-9, `s=${s} t=${t}`);
  }
});

test('Dng.parse exposes the raw ColorMatrix1 (independently verified values)', () => {
  const cm = global.Dng.parse(load(FILES[0])).colorMatrix1;
  const want = [0.9312, -0.1238, -0.0846, -0.5823, 1.4648, 0.3586, -0.0969, 0.1790, 0.8560];
  want.forEach((w, i) => assert.ok(Math.abs(cm[i] - w) < 1e-4, `cm[${i}]=${cm[i]}`));
});

// -- White-balance pipette ----------------------------------------------

test('neutralFromRendered recovers the camera colour of a rendered spot', () => {
  const Dng = require('../dng.js');
  const M1 = [0.9312, -0.1238, -0.0846, -0.5823, 1.4648, 0.3586, -0.0969, 0.179, 0.856];
  const current = [0.5, 1, 0.55];
  const m = Dng.camToSrgbForNeutral(M1, current);
  // A grey card under a warmer light: camera colour (0.3, 0.5, 0.2).
  const cam = [0.3, 0.5, 0.2];
  const wbd = cam.map((v, i) => v / current[i]);
  const s = [0, 1, 2].map((r) => m[r * 3] * wbd[0] + m[r * 3 + 1] * wbd[1] + m[r * 3 + 2] * wbd[2]);
  const n = Wb.neutralFromRendered(s, m, current);
  const want = [0.3 / 0.5, 1, 0.2 / 0.5];
  n.forEach((v, i) => assert.ok(Math.abs(v - want[i]) < 1e-9, `${i}: ${v} vs ${want[i]}`));
  // Picking with that neutral renders the spot grey.
  const m2 = Dng.camToSrgbForNeutral(M1, n);
  const w2 = cam.map((v, i) => v / n[i]);
  const s2 = [0, 1, 2].map((r) => m2[r * 3] * w2[0] + m2[r * 3 + 1] * w2[1] + m2[r * 3 + 2] * w2[2]);
  assert.ok(Math.abs(s2[0] - s2[1]) < 1e-6 && Math.abs(s2[2] - s2[1]) < 1e-6, JSON.stringify(s2));
});

test('neutralFromRendered rejects black or impossible spots', () => {
  const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  assert.strictEqual(Wb.neutralFromRendered([0, 0, 0], I, [1, 1, 1]), null);
  assert.strictEqual(Wb.neutralFromRendered([0.5, 0, 0.5], I, [1, 1, 1]), null);
  assert.strictEqual(Wb.neutralFromRendered([0.5, 0.5, -0.1], I, [1, 1, 1]), null);
});

test('srgbDecode inverts the sRGB curve', () => {
  assert.strictEqual(Wb.srgbDecode(0), 0);
  assert.ok(Math.abs(Wb.srgbDecode(1) - 1) < 1e-12);
  assert.ok(Math.abs(Wb.srgbDecode(0.5) - 0.214041) < 1e-6);
});

test('pickAverage averages usable pixels in linear light, skipping clipped and black ones', () => {
  // 2 x 2: two usable greys, one clipped white, one black.
  const px = new Uint8ClampedArray([
    128, 128, 128, 255,   255, 255, 255, 255,
    0, 0, 0, 255,         188, 188, 188, 255,
  ]);
  const r = Wb.pickAverage(px, 2, 2);
  assert.strictEqual(r.used, 2);
  assert.strictEqual(r.clipped, 1);
  assert.strictEqual(r.dark, 1);
  const want = (Wb.srgbDecode(128 / 255) + Wb.srgbDecode(188 / 255)) / 2;
  r.srgb.forEach((v) => assert.ok(Math.abs(v - want) < 1e-12));
});

test('pickAverage honours the include mask and reports nothing usable', () => {
  const px = new Uint8ClampedArray([100, 110, 120, 255, 200, 210, 220, 255]);
  const r = Wb.pickAverage(px, 2, 1, (x) => x === 1);
  assert.strictEqual(r.used, 1);
  assert.ok(Math.abs(r.srgb[0] - Wb.srgbDecode(200 / 255)) < 1e-12);
  const none = Wb.pickAverage(new Uint8ClampedArray([0, 0, 0, 255]), 1, 1);
  assert.strictEqual(none.used, 0);
  assert.strictEqual(none.srgb, null);
});
