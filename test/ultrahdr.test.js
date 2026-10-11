'use strict';
const test = require('node:test');
const assert = require('node:assert');
const U = require('../src/ultrahdr.js');

// A tiny "JPEG": SOI, APP0 JFIF, (optional APP1 Exif), DQT, SOF0, SOS + data, EOI.
function jpeg(withExif, fill = 0x11) {
  const seg = (m, body) => [0xff, m, (body.length + 2) >> 8, (body.length + 2) & 255, ...body];
  const b = [0xff, 0xd8];
  b.push(...seg(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]));
  if (withExif) b.push(...seg(0xe1, [0x45, 0x78, 0x69, 0x66, 0, 0, 1, 2, 3, 4]));
  b.push(...seg(0xdb, new Array(65).fill(1)));
  b.push(...seg(0xc0, [8, 0, 2, 0, 2, 1, 1, 0x11, 0]));
  b.push(...seg(0xda, [1, 1, 0, 0, 0x3f, 0]), fill, fill, fill, 0xff, 0xd9);
  return Uint8Array.from(b);
}

test('recovery bytes round-trip through the decode formula', () => {
  const lg = Float32Array.from([0, 0.25, 1, 1.9, 2]);
  const r = U.recoveryBytes(lg, null);
  assert.ok(Math.abs(r.maxLog - 2) < 1e-6);
  for (let i = 0; i < lg.length; i++) assert.ok(Math.abs(U.logGainOf(r.bytes[i], r.maxLog) - lg[i]) <= 2 / 255 + 1e-6, i);
  assert.strictEqual(r.bytes[0], 0);
  assert.strictEqual(r.bytes[4], 255);
});

test('nothing to boost still gives a valid, tiny GainMapMax', () => {
  const r = U.recoveryBytes(new Float32Array(4), null);
  assert.ok(r.maxLog > 0 && r.maxLog <= 1 / 64);
  assert.deepStrictEqual(Array.from(r.bytes), [0, 0, 0, 0]);
});

test('assemble -> parse: MPF offset lands on the gain map SOI, lengths and metadata agree', () => {
  const primary = jpeg(true), gain = jpeg(false, 0x22);
  const out = U.assemble(primary, gain, 1.5);
  const p = U.parse(out);
  assert.strictEqual(out[p.gainOffset], 0xff);
  assert.strictEqual(out[p.gainOffset + 1], 0xd8);
  assert.strictEqual(p.gainOffset, p.primaryLength);
  assert.strictEqual(p.gainOffset + p.gainLength, out.length);
  assert.strictEqual(p.mpfEntries.length, 2);
  assert.strictEqual(p.mpfEntries[0].attr, 0x00030000);
  assert.strictEqual(p.mpfEntries[0].size, p.primaryLength);
  assert.strictEqual(p.mpfEntries[1].size, p.gainLength);
  assert.match(p.primaryXmp, /hdrgm:Version="1.0"/);
  assert.match(p.primaryXmp, new RegExp('Item:Length="' + p.gainLength + '"'));
  assert.match(p.gainXmp, /hdrgm:GainMapMax="1.5"/);
  assert.match(p.gainXmp, /hdrgm:BaseRenditionIsHDR="False"/);
  assert.ok(p.iso.primary);
  assert.strictEqual(p.iso.gain.flags, 0);
  assert.ok(Math.abs(p.iso.gain.max - 1.5) < 1e-5);
  assert.ok(Math.abs(p.iso.gain.altHeadroom - 1.5) < 1e-5);
  assert.strictEqual(p.iso.gain.baseHeadroom, 0);
  assert.ok(Math.abs(p.iso.gain.baseOffset - 1 / 64) < 1e-5);
});

test('the primary keeps its own bytes, with segments inserted before the first non-APP marker', () => {
  const primary = jpeg(true);
  const out = U.assemble(primary, jpeg(false), 1);
  const exifAt = 2 + 18;                       // SOI + APP0 (2 + 16)
  assert.deepStrictEqual(Array.from(out.subarray(0, exifAt + 14)), Array.from(primary.subarray(0, exifAt + 14)));
  const dqtIn = primary.indexOf(0xdb, 2) - 1;
  const tail = primary.subarray(dqtIn);
  const outTail = out.subarray(U.parse(out).primaryLength - tail.length, U.parse(out).primaryLength);
  assert.deepStrictEqual(Array.from(outTail), Array.from(tail));
  // order: XMP (APP1 "http://ns.adobe.com/xap/1.0/"), ISO APP2, MPF APP2, then DQT
  const s = Buffer.from(out.subarray(0, U.parse(out).primaryLength)).toString('latin1');
  const ix = s.indexOf('http://ns.adobe.com/xap/1.0/'), ii = s.indexOf('urn:iso:std:iso:ts:21496:-1'), im = s.indexOf('MPF\0');
  assert.ok(ix > 0 && ix < ii && ii < im && im < s.indexOf('\xff\xdb'), [ix, ii, im].join());
});
