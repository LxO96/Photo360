'use strict';
// Source.extractBayerPlane used to live in app.js, untested (Important
// finding #7 in the final whole-branch review): it is pure byte math that
// silently swaps R and B on a lens if handed an odd {x,y} offset, exactly
// the class of "plausible-looking wrong image" dng.js otherwise refuses to
// produce. Moved here (source.js is now the pure decode/validate module
// app.js's load path uses) with an explicit even-offset guard; this file
// covers both the guard and the plain extraction against a small synthetic
// strip so the byte math itself has a test independent of any real DNG.
const test = require('node:test');
const assert = require('node:assert');
// source.js expects Lens/Exif/Dng as globals (browser <script> load order);
// mirror the pattern test/gl.test.js already uses for gl.js's Lens global.
global.Lens = require('../lens.js');
global.Exif = require('../exif.js');
global.Dng = require('../dng.js');
const Source = require('../source.js');

// A synthetic 4-wide x 8-tall single-strip "sensor": pixel value = row*4 +
// col, stored as little-endian uint16, row-major -- mimicking two 4x4 lenses
// stacked vertically (o = {x:0,y:0} and {x:0,y:4}).
function buildStrip(width, height) {
  const buf = new ArrayBuffer(width * height * 2);
  const dv = new DataView(buf);
  let p = 0;
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      dv.setUint16(p, row * width + col, true);
      p += 2;
    }
  }
  return new Uint8Array(buf);
}

test('extractBayerPlane reads the top lens of a stacked strip', () => {
  const bytes = buildStrip(4, 8);
  const d = { stripOffset: 0, width: 4, littleEndian: true };
  const plane = Source.extractBayerPlane(bytes, d, { x: 0, y: 0 }, 4);
  assert.deepStrictEqual(Array.from(plane), [
    0, 1, 2, 3,
    4, 5, 6, 7,
    8, 9, 10, 11,
    12, 13, 14, 15,
  ]);
});

test('extractBayerPlane reads the bottom lens of a stacked strip', () => {
  const bytes = buildStrip(4, 8);
  const d = { stripOffset: 0, width: 4, littleEndian: true };
  const plane = Source.extractBayerPlane(bytes, d, { x: 0, y: 4 }, 4);
  assert.deepStrictEqual(Array.from(plane), [
    16, 17, 18, 19,
    20, 21, 22, 23,
    24, 25, 26, 27,
    28, 29, 30, 31,
  ]);
});

test('extractBayerPlane honours big-endian strips too', () => {
  const width = 4, height = 4;
  const buf = new ArrayBuffer(width * height * 2);
  const dv = new DataView(buf);
  let p = 0;
  for (let i = 0; i < width * height; i++) { dv.setUint16(p, i, false); p += 2; }
  const bytes = new Uint8Array(buf);
  const d = { stripOffset: 0, width, littleEndian: false };
  const plane = Source.extractBayerPlane(bytes, d, { x: 0, y: 0 }, 4);
  assert.deepStrictEqual(Array.from(plane), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
});

test('extractBayerPlane rejects an odd x offset instead of silently shifting the CFA phase', () => {
  const bytes = buildStrip(6, 4);
  const d = { stripOffset: 0, width: 6, littleEndian: true };
  assert.strictEqual(Source.extractBayerPlane(bytes, d, { x: 1, y: 0 }, 4), null);
});

test('extractBayerPlane rejects an odd y offset instead of silently shifting the CFA phase', () => {
  const bytes = buildStrip(4, 6);
  const d = { stripOffset: 0, width: 4, littleEndian: true };
  assert.strictEqual(Source.extractBayerPlane(bytes, d, { x: 0, y: 1 }, 4), null);
});

test('extractBayerPlane accepts an even, non-zero offset', () => {
  const bytes = buildStrip(8, 4);
  const d = { stripOffset: 0, width: 8, littleEndian: true };
  const plane = Source.extractBayerPlane(bytes, d, { x: 4, y: 0 }, 4);
  assert.deepStrictEqual(Array.from(plane), [
    4, 5, 6, 7,
    12, 13, 14, 15,
    20, 21, 22, 23,
    28, 29, 30, 31,
  ]);
});

test('Source.decode dispatches DNGs by extension', async () => {
  await assert.rejects(
    () => Source.decode({ name: 'broken.dng' }, new ArrayBuffer(4), 8192),
    /too short/i);
});

test('Source.UNSUPPORTED_MSG matches the message decodeDng throws for an unsupported shape', async () => {
  // A minimal-but-valid-enough TIFF header that Dng.parse will accept far
  // enough to reach the layout check with an unsupported (e.g. 4:3) shape
  // is out of scope for this pure-JS test; decodeDng's own rejection-reason
  // passthrough is covered indirectly by dng.test.js. This just pins the
  // exported constant's text so app.js's error copy and this module agree.
  assert.match(Source.UNSUPPORTED_MSG, /2:1 or 1:2 dual fisheye/);
});

// -- HDR: merging a bracket set (hdrmerge.js) ------------------------------
test('decodeMerged merges the 174907 bracket pair into float planes', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  global.Wb = global.Wb || require('../wb.js');
  global.HdrMerge = global.HdrMerge || require('../hdrmerge.js');
  const DIR = path.join(__dirname, '..', 'Testfiles');
  const fileOf = (p) => ({ name: path.basename(p), arrayBuffer: async () => {
    const b = fs.readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); } });
  const shortP = path.join(DIR, 'Noise test files', 'IMG_20240825_174907_00_019.dng');
  const refP = path.join(DIR, 'IMG_20240825_174907_00_020.dng');
  const d = await Source.decodeMerged([fileOf(shortP), fileOf(refP)], 16384);
  assert.strictEqual(d.kind, 'dng');
  assert.ok(d.planes[0] instanceof Float32Array);
  assert.ok(d.rawMeta.floatPlanes);
  assert.strictEqual(d.rawMeta.blackLevel, 0);
  assert.strictEqual(d.rawMeta.whiteLevel, 1);
  const ref = Source.dngFrame(new Uint8Array(fs.readFileSync(refP)));
  const sh = Source.dngFrame(new Uint8Array(fs.readFileSync(shortP)));
  const ratio = ref.d.exposureTime / sh.d.exposureTime;
  assert.ok(Math.abs(d.rawMeta.hdrMax - ratio) < 1e-9, String(d.rawMeta.hdrMax));
  assert.strictEqual(d.sourceName, 'IMG_20240825_174907_00_019_HDR.dng');
  // Where _020 (the reference) is clipped, the merge holds _019 x the ratio.
  let checked = 0;
  for (let i = 0; i < ref.planes[0].length && checked < 2000; i += 97) {
    const nRef = (ref.planes[0][i] - ref.d.blackLevel) / (ref.d.whiteLevel - ref.d.blackLevel);
    if (nRef < 0.99) continue;
    const nSh = (sh.planes[0][i] - sh.d.blackLevel) / (sh.d.whiteLevel - sh.d.blackLevel);
    if (nSh > 0.75 || nSh < 0.3) continue;
    const want = nSh * ratio;
    assert.ok(Math.abs(d.planes[0][i] - want) <= 0.03 * want, i + ': ' + d.planes[0][i] + ' vs ' + want);
    checked++;
  }
  assert.ok(checked > 50, 'clipped samples checked: ' + checked);
});
