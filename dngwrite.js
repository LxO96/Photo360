(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DngWrite = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Writes a little-endian, uncompressed, 16-bit "linear raw" DNG: three
  // samples per pixel (camera RGB, already demosaiced), PhotometricInterpretation
  // LinearRaw (34892). `data` holds width * height * 3 values, row-major,
  // top row first, where 0 is black and 65535 is the sensor's white level.
  // The colour tags tell a raw converter how to render it: ColorMatrix1
  // (XYZ -> camera, from the source), its CalibrationIlluminant1 (D65 if the
  // source didn't say), and AsShotNeutral (the white balance chosen here).
  // A single IFD, no preview image.
  const PHOTOMETRIC_LINEAR_RAW = 34892;
  const ILLUMINANT_D65 = 21;
  const ROWS_PER_STRIP = 64;
  const T = { BYTE: 1, ASCII: 2, SHORT: 3, LONG: 4, RATIONAL: 5, SRATIONAL: 10 };
  const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 10: 8 };

  function write(opts) {
    const { width, height, data } = opts;
    if (!data || data.length !== width * height * 3) {
      throw new Error(`pixel data length ${data && data.length} does not match ${width} x ${height} x 3`);
    }
    const make = opts.make || '';
    const model = opts.model || '';
    const unique = [make, model].filter(Boolean).join(' ') || 'Fisheye Print Extractor';
    const neutral = opts.asShotNeutral || [1, 1, 1];

    const rowBytes = width * 6;
    const strips = [];
    for (let y = 0; y < height; y += ROWS_PER_STRIP) strips.push(Math.min(ROWS_PER_STRIP, height - y) * rowBytes);

    const entries = [
      [254, T.LONG, [0]],
      [256, T.LONG, [width]],
      [257, T.LONG, [height]],
      [258, T.SHORT, [16, 16, 16]],
      [259, T.SHORT, [1]],
      [262, T.SHORT, [PHOTOMETRIC_LINEAR_RAW]],
      make && [271, T.ASCII, make],
      model && [272, T.ASCII, model],
      [273, T.LONG, strips.map(() => 0)],   // filled in below
      [274, T.SHORT, [1]],
      [277, T.SHORT, [3]],
      [278, T.LONG, [ROWS_PER_STRIP]],
      [279, T.LONG, strips],
      [284, T.SHORT, [1]],
      [305, T.ASCII, 'Fisheye Print Extractor'],
      opts.dateTime && [306, T.ASCII, opts.dateTime],
      [50706, T.BYTE, [1, 4, 0, 0]],
      [50707, T.BYTE, [1, 1, 0, 0]],
      [50708, T.ASCII, unique],
      [50717, T.LONG, [65535]],
      opts.colorMatrix1 && [50721, T.SRATIONAL, opts.colorMatrix1.map((v) => [Math.round(v * 10000), 10000])],
      [50728, T.RATIONAL, neutral.map((v) => [Math.round(v * 1000000), 1000000])],
      [50778, T.SHORT, [opts.calibrationIlluminant1 || ILLUMINANT_D65]],
    ].filter(Boolean).sort((a, b) => a[0] - b[0]);

    const count = (e) => (e[1] === T.ASCII ? e[2].length + 1 : e[2].length);
    const ifdOffset = 8;
    const ifdSize = 2 + entries.length * 12 + 4;
    let extra = ifdOffset + ifdSize;
    const placed = entries.map((e) => {
      const size = SIZE[e[1]] * count(e);
      let at = null;
      if (size > 4) { at = extra; extra += size + (size & 1); }
      return { e, size, at };
    });
    const pixelStart = extra;
    const total = pixelStart + width * height * 6;

    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    out[0] = 0x49; out[1] = 0x49;
    dv.setUint16(2, 42, true);
    dv.setUint32(4, ifdOffset, true);
    dv.setUint16(ifdOffset, entries.length, true);

    // Strip offsets are known now.
    const stripOffsets = [];
    for (let i = 0, o = pixelStart; i < strips.length; o += strips[i], i++) stripOffsets.push(o);
    for (const p of placed) if (p.e[0] === 273) p.e[2] = stripOffsets;

    placed.forEach((p, i) => {
      const [tag, type, vals] = p.e;
      const at = ifdOffset + 2 + i * 12;
      dv.setUint16(at, tag, true);
      dv.setUint16(at + 2, type, true);
      dv.setUint32(at + 4, count(p.e), true);
      let o = p.at === null ? at + 8 : p.at;
      if (p.at !== null) dv.setUint32(at + 8, p.at, true);
      if (type === T.ASCII) {
        for (let k = 0; k < vals.length; k++) out[o + k] = vals.charCodeAt(k) & 0x7f;
        return;
      }
      for (const v of vals) {
        if (type === T.BYTE) { out[o] = v; o += 1; }
        else if (type === T.SHORT) { dv.setUint16(o, v, true); o += 2; }
        else if (type === T.LONG) { dv.setUint32(o, v, true); o += 4; }
        else if (type === T.RATIONAL) { dv.setUint32(o, v[0], true); dv.setUint32(o + 4, v[1], true); o += 8; }
        else if (type === T.SRATIONAL) { dv.setInt32(o, v[0], true); dv.setInt32(o + 4, v[1], true); o += 8; }
      }
    });
    dv.setUint32(ifdOffset + 2 + entries.length * 12, 0, true);

    // Pixels: a straight byte copy on little-endian hosts (all browsers in
    // practice), else sample by sample.
    const littleHost = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
    if (littleHost) {
      out.set(new Uint8Array(data.buffer, data.byteOffset, data.length * 2), pixelStart);
    } else {
      for (let i = 0; i < data.length; i++) dv.setUint16(pixelStart + i * 2, data[i], true);
    }
    return out;
  }

  return { write, PHOTOMETRIC_LINEAR_RAW };
});
