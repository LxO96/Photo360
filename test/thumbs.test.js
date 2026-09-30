'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Thumbs = require('../thumbs.js');

// A JPEG with an APP1 Exif segment whose IFD1 points at a 4-byte "thumbnail".
function jpegWithThumb() {
  const tiff = [];
  const u16 = (v) => tiff.push(v & 255, v >> 8);
  const u32 = (v) => tiff.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, v >>> 24);
  tiff.push(0x49, 0x49); u16(42); u32(8);          // II, magic, IFD0 at 8
  u16(0); u32(14);                                   // IFD0: no entries, next IFD at 14
  u16(2);                                            // IFD1: 2 entries
  u16(0x0201); u16(4); u32(1); u32(44);              // JPEGInterchangeFormat -> 44
  u16(0x0202); u16(4); u32(1); u32(4);               // ...Length -> 4
  u32(0);                                            // no next IFD
  while (tiff.length < 44) tiff.push(0);
  tiff.push(0xff, 0xd8, 0xff, 0xd9);                 // the "thumbnail"
  const payload = [0x45, 0x78, 0x69, 0x66, 0, 0].concat(tiff);
  const len = payload.length + 2;
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, len >> 8, len & 255].concat(payload, [0xff, 0xda, 0, 2]));
}

test('exifThumbnail finds the IFD1 JPEG', () => {
  const b = jpegWithThumb();
  const t = Thumbs.exifThumbnail(b);
  assert.ok(t);
  assert.strictEqual(t.length, 4);
  assert.deepStrictEqual(Array.from(b.subarray(t.offset, t.offset + 4)), [0xff, 0xd8, 0xff, 0xd9]);
});

test('exifThumbnail is null without Exif or without IFD1', () => {
  assert.strictEqual(Thumbs.exifThumbnail(Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0, 2])), null);
  assert.strictEqual(Thumbs.exifThumbnail(Uint8Array.from([1, 2, 3])), null);
});

// An RGGB plane: the left half red light, the right half blue, 16 x 8.
function plane(w, h) {
  const p = new Uint16Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const red = x < w / 2;
    const c = (y % 2) * 2 + (x % 2);                  // 0 R, 1 G, 2 G, 3 B
    const v = c === 0 ? (red ? 4000 : 100) : c === 3 ? (red ? 100 : 4000) : 100;
    p[y * w + x] = 100 + v;                           // black level 100
  }
  return p;
}

test('dngDecimate samples Bayer blocks into colours and size', () => {
  const w = 16, h = 8, p = plane(w, h);
  const meta = { width: w, height: h, cfaPattern: [0, 1, 1, 2], blackLevel: 100, whiteLevel: 4100,
    asShotNeutral: [1, 1, 1] };
  const rows = [];
  const out = Thumbs.dngDecimate(meta, (y) => { rows.push(y); return p.subarray(y * w, (y + 2) * w); }, 4);
  assert.strictEqual(out.width, 4);
  assert.strictEqual(out.height, 2);
  assert.ok(rows.every((y) => y % 2 === 0), 'reads start on even rows');
  const px = (x, y) => Array.from(out.rgba.subarray((y * out.width + x) * 4, (y * out.width + x) * 4 + 4));
  const left = px(0, 0), right = px(3, 1);
  assert.ok(left[0] > 200 && left[2] < 80, 'left is red: ' + left);
  assert.ok(right[2] > 200 && right[0] < 80, 'right is blue: ' + right);
  assert.strictEqual(left[3], 255);
});

test('dngDecimate reads far fewer rows than the plane has', () => {
  const w = 512, h = 256, p = new Uint16Array(w * h);
  const meta = { width: w, height: h, cfaPattern: [0, 1, 1, 2], blackLevel: 0, whiteLevel: 65535, asShotNeutral: [1, 1, 1] };
  let reads = 0;
  Thumbs.dngDecimate(meta, (y) => { reads++; return p.subarray(y * w, (y + 2) * w); }, 64);
  assert.ok(reads <= 32, 'reads ' + reads);
});

test('dngDecimate applies the as-shot neutral', () => {
  const w = 4, h = 4, p = new Uint16Array(w * h).fill(1100);   // flat grey sensor values
  const meta = { width: w, height: h, cfaPattern: [0, 1, 1, 2], blackLevel: 100, whiteLevel: 4100,
    asShotNeutral: [0.5, 1, 1] };                                 // red sensor is half as sensitive
  const out = Thumbs.dngDecimate(meta, (y) => p.subarray(y * w, (y + 2) * w), 2);
  const [r, g, b] = out.rgba;
  assert.ok(r > g && Math.abs(g - b) <= 1, [r, g, b].join());
});
