'use strict';
const test = require('node:test');
const assert = require('node:assert');
const DngWrite = require('../dngwrite.js');

// A minimal little-endian TIFF reader: IFD0's tags as { tag: values[] }.
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 10: 8 };
function readIfd0(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.strictEqual(String.fromCharCode(bytes[0], bytes[1]), 'II');
  assert.strictEqual(dv.getUint16(2, true), 42);
  const ifd = dv.getUint32(4, true);
  const n = dv.getUint16(ifd, true);
  const tags = {};
  let prev = -1;
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    const tag = dv.getUint16(e, true), type = dv.getUint16(e + 2, true), count = dv.getUint32(e + 4, true);
    assert.ok(tag > prev, `tags sorted (${tag} after ${prev})`);
    prev = tag;
    const size = TYPE_SIZE[type] * count;
    const off = size <= 4 ? e + 8 : dv.getUint32(e + 8, true);
    if (size > 4) assert.strictEqual(off % 2, 0, `tag ${tag} value is word aligned`);
    const vals = [];
    for (let k = 0; k < count; k++) {
      if (type === 1 || type === 7) vals.push(dv.getUint8(off + k));
      else if (type === 2) vals.push(dv.getUint8(off + k));
      else if (type === 3) vals.push(dv.getUint16(off + k * 2, true));
      else if (type === 4) vals.push(dv.getUint32(off + k * 4, true));
      else if (type === 5) vals.push(dv.getUint32(off + k * 8, true) / dv.getUint32(off + k * 8 + 4, true));
      else if (type === 10) vals.push(dv.getInt32(off + k * 8, true) / dv.getInt32(off + k * 8 + 4, true));
    }
    tags[tag] = type === 2 ? String.fromCharCode(...vals).replace(/\0+$/, '') : vals;
  }
  assert.strictEqual(dv.getUint32(ifd + 2 + n * 12, true), 0, 'single IFD');
  return { tags, dv };
}

function sample(w, h) {
  const data = new Uint16Array(w * h * 3);
  for (let i = 0; i < data.length; i++) data[i] = (i * 2654435761) % 65536;
  return data;
}

const META = {
  colorMatrix1: [0.9, -0.3, -0.1, -0.4, 1.2, 0.2, -0.05, 0.15, 0.6],
  asShotNeutral: [0.52, 1, 0.71],
  calibrationIlluminant1: 21,
  make: 'Insta360',
  model: 'ONE X',
  dateTime: '2024:08:25 17:43:23',
};

test('writes a linear-raw DNG with the tags Lightroom needs', () => {
  const w = 5, h = 3;
  const bytes = DngWrite.write(Object.assign({ width: w, height: h, data: sample(w, h) }, META));
  const { tags } = readIfd0(bytes);
  assert.deepStrictEqual(tags[256], [w]);
  assert.deepStrictEqual(tags[257], [h]);
  assert.deepStrictEqual(tags[258], [16, 16, 16]);
  assert.deepStrictEqual(tags[259], [1]);
  assert.deepStrictEqual(tags[262], [34892]);     // LinearRaw
  assert.deepStrictEqual(tags[277], [3]);
  assert.deepStrictEqual(tags[284], [1]);
  assert.deepStrictEqual(tags[50706], [1, 4, 0, 0]);
  assert.deepStrictEqual(tags[50707], [1, 1, 0, 0]);
  assert.deepStrictEqual(tags[50717], [65535]);
  assert.deepStrictEqual(tags[50778], [21]);
  assert.strictEqual(tags[271], 'Insta360');
  assert.strictEqual(tags[272], 'ONE X');
  assert.strictEqual(tags[50708], 'Insta360 ONE X');
  assert.strictEqual(tags[306], '2024:08:25 17:43:23');
  tags[50721].forEach((v, i) => assert.ok(Math.abs(v - META.colorMatrix1[i]) < 1e-4));
  tags[50728].forEach((v, i) => assert.ok(Math.abs(v - META.asShotNeutral[i]) < 1e-6));
});

test('pixel data round-trips through the strips exactly', () => {
  const w = 7, h = 150;   // more rows than one strip
  const data = sample(w, h);
  const bytes = DngWrite.write(Object.assign({ width: w, height: h, data }, META));
  const { tags, dv } = readIfd0(bytes);
  const offsets = tags[273], counts = tags[279], rowsPerStrip = tags[278][0];
  assert.ok(offsets.length > 1);
  assert.strictEqual(counts.reduce((a, b) => a + b, 0), w * h * 6);
  let i = 0;
  for (let s = 0; s < offsets.length; s++) {
    assert.strictEqual(counts[s], Math.min(rowsPerStrip, h - s * rowsPerStrip) * w * 6);
    for (let k = 0; k < counts[s]; k += 2) {
      assert.strictEqual(dv.getUint16(offsets[s] + k, true), data[i++]);
    }
  }
  assert.strictEqual(i, data.length);
});

test('missing metadata falls back to safe defaults', () => {
  const bytes = DngWrite.write({ width: 1, height: 1, data: new Uint16Array(3) });
  const { tags } = readIfd0(bytes);
  assert.deepStrictEqual(tags[50728], [1, 1, 1]);
  assert.deepStrictEqual(tags[50778], [21]);
  assert.strictEqual(tags[50721], undefined);   // no matrix: none is invented
  assert.ok(typeof tags[50708] === 'string' && tags[50708].length > 0);
});

test('rejects data of the wrong length', () => {
  assert.throws(() => DngWrite.write({ width: 2, height: 2, data: new Uint16Array(5) }), /length/);
});
