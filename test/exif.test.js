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
