'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Exif = require('../exif.js');

const testfiles = path.join(__dirname, '..', 'Testfiles');

// The X5's own .insp files carry several megabytes of embedded metadata
// (gain-map / preview APPn segments) before the SOF marker, so the "head"
// read has to be generous enough to reach it -- still trivial next to a
// full 283MB frame decode.
const HEAD_SIZE = 6 * 1024 * 1024;

function readHead(name, n) {
  const size = fs.statSync(path.join(testfiles, name)).size;
  const toRead = Math.min(n, size);
  const fd = fs.openSync(path.join(testfiles, name), 'r');
  const buf = Buffer.alloc(toRead);
  fs.readSync(fd, buf, 0, toRead, 0);
  fs.closeSync(fd);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

test('reads the size of a full-size X5 dual fisheye file', () => {
  const bytes = readHead('Sunscreen.insp', HEAD_SIZE);
  assert.deepStrictEqual(Exif.readJpegSize(bytes), { width: 11904, height: 5952 });
});

test('reads the size of another full-size X5 dual fisheye file', () => {
  const bytes = readHead('IMG_20260511_094146_00_004.insp', HEAD_SIZE);
  assert.deepStrictEqual(Exif.readJpegSize(bytes), { width: 11904, height: 5952 });
});

test('reads the size of the smaller X5 dual fisheye file', () => {
  const bytes = readHead('IMG_20260512_143942_00_011.insp', HEAD_SIZE);
  assert.deepStrictEqual(Exif.readJpegSize(bytes), { width: 5888, height: 2944 });
});

test('reads the size of a single square fisheye export', () => {
  const bytes = readHead(path.join('Outputs', 'Flat.jpg'), HEAD_SIZE);
  assert.deepStrictEqual(Exif.readJpegSize(bytes), { width: 3040, height: 3040 });
});

test('returns null for a non-JPEG byte array', () => {
  assert.strictEqual(Exif.readJpegSize(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7])), null);
});

test('returns null for an empty byte array', () => {
  assert.strictEqual(Exif.readJpegSize(new Uint8Array([])), null);
});

// --- Task 13: EXIF passthrough -------------------------------------------

const SOURCE = path.join(testfiles, 'Sunscreen.insp');

test('it reads the camera identity out of a real .insp file', () => {
  const tags = Exif.readTags(new Uint8Array(fs.readFileSync(SOURCE)));
  assert.strictEqual(tags.make.trim(), 'Arashi Vision');
  assert.strictEqual(tags.model.trim(), 'Insta360 X5');
  assert.match(tags.dateTimeOriginal, /^2026:05:14 11:37:39/);
});

test('a built APP1 segment is well formed', () => {
  const app1 = Exif.buildApp1({
    make: 'Arashi Vision', model: 'Insta360 X5', dateTimeOriginal: '2026:05:14 11:37:39',
  });
  assert.strictEqual(app1[0], 0xff);
  assert.strictEqual(app1[1], 0xe1);
  const declared = (app1[2] << 8) | app1[3];
  assert.strictEqual(declared, app1.length - 2, 'segment length must exclude the marker');
  assert.strictEqual(
    Buffer.from(app1.slice(4, 10)).toString('latin1'), 'Exif\0\0');
});

test('tags survive a build and re-read round trip', () => {
  const tags = {
    make: 'Arashi Vision', model: 'Insta360 X5', dateTimeOriginal: '2026:05:14 11:37:39',
  };
  const app1 = Exif.buildApp1(tags);
  // wrap it in a minimal JPEG: SOI + APP1 + EOI
  const jpeg = new Uint8Array(2 + app1.length + 2);
  jpeg.set([0xff, 0xd8], 0);
  jpeg.set(app1, 2);
  jpeg.set([0xff, 0xd9], 2 + app1.length);
  const back = Exif.readTags(jpeg);
  assert.strictEqual(back.make, tags.make);
  assert.strictEqual(back.model, tags.model);
  assert.strictEqual(back.dateTimeOriginal, tags.dateTimeOriginal);
});

test('reattach puts the segment straight after SOI', () => {
  const app1 = Exif.buildApp1({ make: 'M', model: 'X', dateTimeOriginal: '2026:01:01 00:00:00' });
  const encoded = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x03, 0x00, 0xff, 0xd9]);
  const out = Exif.reattach(encoded, app1);
  assert.strictEqual(out[0], 0xff);
  assert.strictEqual(out[1], 0xd8);
  assert.strictEqual(out[2], 0xff);
  assert.strictEqual(out[3], 0xe1);
  assert.strictEqual(out.length, encoded.length + app1.length);
});

test('reattach strips an APP1 the encoder already wrote', () => {
  const mine = Exif.buildApp1({ make: 'M', model: 'X', dateTimeOriginal: '2026:01:01 00:00:00' });
  const theirs = new Uint8Array([0xff, 0xe1, 0x00, 0x04, 0x41, 0x42]);
  const encoded = new Uint8Array(2 + theirs.length + 2);
  encoded.set([0xff, 0xd8], 0);
  encoded.set(theirs, 2);
  encoded.set([0xff, 0xd9], 2 + theirs.length);
  const out = Exif.reattach(encoded, mine);
  assert.strictEqual(out.length, 2 + mine.length + 2);
});

test('reattach with no segment is a no-op', () => {
  const encoded = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  assert.strictEqual(Exif.reattach(encoded, null), encoded);
});

test('it reads shutter time and ISO out of a real .insp file', () => {
  const tags = Exif.readTags(new Uint8Array(fs.readFileSync(SOURCE).subarray(0, 1 << 18)));
  assert.ok(Math.abs(tags.exposureTime - 225 / 1000000) < 1e-12, String(tags.exposureTime));
  assert.strictEqual(tags.iso, 102);
});

test('no exposure tags gives nulls', () => {
  const app1 = Exif.buildApp1({ make: 'M', model: 'X', dateTimeOriginal: '2026:01:01 00:00:00' });
  const jpeg = new Uint8Array(2 + app1.length + 2);
  jpeg.set([0xff, 0xd8], 0); jpeg.set(app1, 2); jpeg.set([0xff, 0xd9], 2 + app1.length);
  const back = Exif.readTags(jpeg);
  assert.strictEqual(back.exposureTime, null);
  assert.strictEqual(back.iso, null);
});
