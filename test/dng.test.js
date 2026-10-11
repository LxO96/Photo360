'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Dng = require('../src/dng.js');

// Testfiles/ is git-ignored (85MB of local-only test media -- see README);
// these tests read the real files and will not find them in CI without that
// directory populated locally, exactly like test/exif.test.js's fixtures.
const DIR = path.join(__dirname, '..', 'Testfiles');
const FILES = [
  'IMG_20180101_044910_00_030.dng',
  'IMG_20240825_174323_00_010.dng',
  'IMG_20240825_174907_00_020.dng',
];

function load(name) {
  return new Uint8Array(fs.readFileSync(path.join(DIR, name)));
}

test('it parses the geometry of every supplied ONE X raw', () => {
  for (const name of FILES) {
    const d = Dng.parse(load(name));
    assert.ok(d, name + ' should parse');
    assert.strictEqual(d.width, 3040);
    assert.strictEqual(d.height, 6080);
    assert.strictEqual(d.bitsPerSample, 16);
  }
});

test('it reports the sensor calibration needed to linearise', () => {
  const d = Dng.parse(load(FILES[1]));
  assert.strictEqual(d.blackLevel, 1026);
  assert.strictEqual(d.whiteLevel, 16383);
  assert.deepStrictEqual(Array.from(d.cfaPattern), [1, 0, 2, 1]);
});

test('the strip is exactly an uncompressed 16-bit plane', () => {
  const d = Dng.parse(load(FILES[1]));
  assert.strictEqual(d.stripByteCount, d.width * d.height * 2);
});

test('it reads the as-shot white balance, which differs per shot', () => {
  const a = Dng.parse(load(FILES[0])).asShotNeutral;
  const b = Dng.parse(load(FILES[1])).asShotNeutral;
  for (const wb of [a, b]) {
    assert.strictEqual(wb.length, 3);
    assert.ok(Math.abs(wb[1] - 1) < 1e-6, 'green is the reference channel and should be 1');
    assert.ok(wb[0] > 0.3 && wb[0] < 0.8, 'red multiplier out of plausible range: ' + wb[0]);
  }
  assert.notDeepStrictEqual(a, b, 'these two shots have different as-shot white balance');
});

test('it identifies the camera so the ONE X calibration applies', () => {
  assert.strictEqual(Dng.parse(load(FILES[1])).model, 'Insta360 One2');
});

test('a non-DNG returns null rather than throwing', () => {
  assert.strictEqual(Dng.parse(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0])), null);
  assert.strictEqual(Dng.parse(new Uint8Array(0)), null);
});

// Build a minimal little-endian TIFF whose Compression tag (259) is 7
// (JPEG) rather than 1 (uncompressed) -- the only IFD0 entry needed to
// trigger the rejection this decoder must make deliberately, not by
// accident. IFD0 layout: 2-byte entry count, one 12-byte entry, 4-byte
// "next IFD" terminator.
function buildRejectableTiff() {
  const TIFF_HEADER = 8;
  const IFD0_OFFSET = TIFF_HEADER;
  const IFD0_SIZE = 2 + 1 * 12 + 4;
  const buf = new Uint8Array(IFD0_OFFSET + IFD0_SIZE);
  let p = 0;
  function u16(v) { buf[p] = v & 0xff; buf[p + 1] = (v >> 8) & 0xff; p += 2; }
  function u32(v) {
    buf[p] = v & 0xff; buf[p + 1] = (v >> 8) & 0xff;
    buf[p + 2] = (v >> 16) & 0xff; buf[p + 3] = (v >>> 24) & 0xff; p += 4;
  }
  buf[0] = 0x49; buf[1] = 0x49; p = 2; // 'II'
  u16(0x002a);
  u32(IFD0_OFFSET);
  p = IFD0_OFFSET;
  u16(1); // one entry
  u16(259); // Compression
  u16(3); // SHORT
  u32(1); // count
  u16(7); // value: JPEG compression -- not supported
  u16(0); // pad the 4-byte value slot
  u32(0); // next IFD offset: none
  return buf;
}

test('a compressed DNG is rejected with a reason mentioning compression', () => {
  const bytes = buildRejectableTiff();
  assert.strictEqual(Dng.parse(bytes), null);
  assert.ok(/compression/i.test(Dng.lastRejectionReason()),
    'rejection reason should mention compression: ' + Dng.lastRejectionReason());
});

// -- camToSrgbForNeutral: the DNG-spec camera -> linear sRGB matrix -------
// Reference values computed independently in NumPy from the DNG spec's
// no-ForwardMatrix path: inv(ColorMatrix1) . diag(neutral), Bradford-adapted
// from the neutral's own white to D65, then XYZ(D65) -> sRGB, scaled so a
// white-balanced (1,1,1) lands at (1,1,1).
const ONE_X_CM1 = [0.9312000274337828, -0.12380000163046644, -0.08460000114729628,
  -0.5823000071487855, 1.4648000003224972, 0.35859999030763284,
  -0.09690000074771232, 0.17900000474369154, 0.8560000061318278];

function mulVec(m, v) {
  return [0, 1, 2].map((r) => m[r * 3] * v[0] + m[r * 3 + 1] * v[1] + m[r * 3 + 2] * v[2]);
}

test('camToSrgbForNeutral matches the DNG-spec reference matrix', () => {
  const cases = [
    { n: [0.5031940935885519, 1, 0.5459149478808779],
      want: [1.8543, -0.8303, -0.024, -0.1631, 1.5069, -0.3438, 0.0278, -0.5362, 1.5083] },
    { n: [0.7, 1, 0.4],
      want: [1.9533, -0.9629, 0.0096, -0.1876, 1.4422, -0.2546, 0.0867, -0.7402, 1.6535] },
  ];
  for (const { n, want } of cases) {
    const m = Dng.camToSrgbForNeutral(ONE_X_CM1, n);
    m.forEach((v, i) => assert.ok(Math.abs(v - want[i]) < 1e-3, `m[${i}] = ${v}, want ${want[i]}`));
  }
});

test('camToSrgbForNeutral maps a white-balanced neutral to exactly white', () => {
  for (const n of [[0.5, 1, 0.53], [0.7, 1, 0.4], [0.4, 1, 0.8]]) {
    mulVec(Dng.camToSrgbForNeutral(ONE_X_CM1, n), [1, 1, 1])
      .forEach((v) => assert.ok(Math.abs(v - 1) < 1e-6, String(v)));
  }
});

test('camToSrgbForNeutral falls back to identity without a usable matrix', () => {
  assert.deepStrictEqual(Dng.camToSrgbForNeutral(null, [0.5, 1, 0.5]), [1, 0, 0, 0, 1, 0, 0, 0, 1]);
});

test('parse seeds camToSrgb from the file\'s own AsShotNeutral', () => {
  const d = Dng.parse(load(FILES[2]));
  assert.deepStrictEqual(d.camToSrgb, Dng.camToSrgbForNeutral(d.colorMatrix1, d.asShotNeutral));
});

test('it reads Make and CalibrationIlluminant1 for the DNG export', () => {
  for (const f of FILES) {
    const d = Dng.parse(load(f));
    assert.strictEqual(typeof d.make, 'string');
    assert.ok(Number.isInteger(d.calibrationIlluminant1) && d.calibrationIlluminant1 > 0, f);
  }
});

// A minimal uncompressed 4x4 CFA TIFF with no Exif IFD (so no exposure).
function buildMinimalCfaTiff() {
  const entries = [
    [256, 3, 1, 4], [257, 3, 1, 4], [258, 3, 1, 16], [259, 3, 1, 1], [262, 3, 1, 32803],
    [273, 4, 1, 0 /* patched */], [277, 3, 1, 1], [279, 4, 1, 32], [33422, 1, 4, 0x02010100],
  ];
  const ifdSize = 2 + entries.length * 12 + 4;
  const planeOffset = 8 + ifdSize;
  const buf = new Uint8Array(planeOffset + 32);
  const dv = new DataView(buf.buffer);
  buf[0] = 0x49; buf[1] = 0x49; dv.setUint16(2, 42, true); dv.setUint32(4, 8, true);
  dv.setUint16(8, entries.length, true);
  entries.forEach(([tag, type, count, value], i) => {
    const e = 10 + i * 12;
    dv.setUint16(e, tag, true); dv.setUint16(e + 2, type, true); dv.setUint32(e + 4, count, true);
    if (tag === 273) value = planeOffset;
    if (type === 3) dv.setUint16(e + 8, value, true); else dv.setUint32(e + 8, value, true);
  });
  return buf;
}

test('it reads exposure time and ISO from the Exif IFD', () => {
  const a = Dng.parse(load('IMG_20240825_174907_00_020.dng'));
  assert.ok(Math.abs(1 / a.exposureTime - 217) < 1, String(1 / a.exposureTime));
  assert.strictEqual(a.iso, 100);
  const b = Dng.parse(new Uint8Array(fs.readFileSync(path.join(DIR, 'Noise test files', 'IMG_20240825_174907_00_019.dng'))));
  assert.ok(Math.abs(1 / b.exposureTime - 867) < 2, String(1 / b.exposureTime));
});

test('a DNG without an Exif IFD gives null exposure and ISO', () => {
  const d = Dng.parse(buildMinimalCfaTiff());
  assert.ok(d, Dng.lastRejectionReason());
  assert.strictEqual(d.exposureTime, null);
  assert.strictEqual(d.iso, null);
});
