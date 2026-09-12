'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Dng = require('../dng.js');

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
