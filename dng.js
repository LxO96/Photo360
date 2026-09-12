(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Dng = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Pure bytes only: no DOM, no WebGL, no file I/O. Follows exif.js's
  // idioms (bounded reads, try/catch-to-null, makeReaders/scanIfd shape) so
  // this parser meets the same fuzz-tested bar that one already does --
  // every read below is checked against bytes.length before it happens, and
  // nothing loops without an explicit, bounded count.

  // -- TIFF tag ids used here ------------------------------------------------
  const TAG_IMAGE_WIDTH = 256;
  const TAG_IMAGE_LENGTH = 257;
  const TAG_BITS_PER_SAMPLE = 258;
  const TAG_COMPRESSION = 259;
  const TAG_PHOTOMETRIC = 262;
  const TAG_MODEL = 272;
  const TAG_STRIP_OFFSETS = 273;
  const TAG_SAMPLES_PER_PIXEL = 277;
  const TAG_STRIP_BYTE_COUNTS = 279;
  const TAG_DATETIME = 306;
  const TAG_SUB_IFDS = 330;
  const TAG_CFA_PATTERN = 33422; // 0x828E
  const TAG_BLACK_LEVEL = 50714; // 0xC61A
  const TAG_WHITE_LEVEL = 50717; // 0xC61D
  const TAG_COLOR_MATRIX1 = 50721; // 0xC621
  const TAG_AS_SHOT_NEUTRAL = 50728; // 0xC628

  const PHOTOMETRIC_CFA = 32803;

  // TIFF type ids -> byte size of one value.
  const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };
  const TYPE_BYTE = 1, TYPE_ASCII = 2, TYPE_SHORT = 3, TYPE_LONG = 4, TYPE_RATIONAL = 5,
    TYPE_SBYTE = 6, TYPE_SSHORT = 8, TYPE_SLONG = 9, TYPE_SRATIONAL = 10;

  let lastReason = 'No file has been parsed yet.';

  function reject(reason) {
    lastReason = reason;
    return null;
  }

  function lastRejectionReason() {
    return lastReason;
  }

  function makeReaders(bytes, little) {
    return {
      u16(o) {
        return little ? (bytes[o] | (bytes[o + 1] << 8))
                       : ((bytes[o] << 8) | bytes[o + 1]);
      },
      // Unlike exif.js's u32 (which only ever reads IFD offsets well under
      // 2^31), this parser also reads RATIONAL denominators/numerators that
      // legitimately reach 0xFFFFFFFF (a common DNG encoding for "exactly
      // 1"), so the naive bitwise-OR composition -- which coerces through
      // signed int32 and silently corrupts anything with the top bit set --
      // is not safe here. Compose with multiplication/addition and force
      // unsigned with >>> 0 instead.
      u32(o) {
        const v = little
          ? (bytes[o] + bytes[o + 1] * 0x100 + bytes[o + 2] * 0x10000 + bytes[o + 3] * 0x1000000)
          : (bytes[o] * 0x1000000 + bytes[o + 1] * 0x10000 + bytes[o + 2] * 0x100 + bytes[o + 3]);
        return v >>> 0;
      },
      i32(o) {
        const u = this.u32(o);
        return u > 0x7fffffff ? u - 0x100000000 : u;
      },
      i16(o) {
        const u = this.u16(o);
        return u > 0x7fff ? u - 0x10000 : u;
      },
    };
  }

  // Reads `count` values of `type` starting at the value stored in the
  // 12-byte IFD entry at `entryOffset` (tiffStart-relative offsets, exactly
  // like exif.js's ASCII reader). Returns null -- never throws, never reads
  // out of range -- if the type is unrecognized or the value would fall
  // outside the buffer.
  function readValues(bytes, r, entryOffset, tiffStart, type, count) {
    const size = TYPE_SIZE[type];
    if (!size || count <= 0 || count > 1_000_000) return null;
    const total = size * count;
    let valueOffset;
    if (total <= 4) {
      valueOffset = entryOffset + 8;
    } else {
      if (entryOffset + 12 > bytes.length) return null;
      valueOffset = tiffStart + r.u32(entryOffset + 8);
    }
    if (valueOffset < 0 || valueOffset + total > bytes.length) return null;
    const out = new Array(count);
    for (let i = 0; i < count; i++) {
      const o = valueOffset + i * size;
      switch (type) {
        case TYPE_BYTE: out[i] = bytes[o]; break;
        case TYPE_SBYTE: out[i] = (bytes[o] > 127) ? bytes[o] - 256 : bytes[o]; break;
        case TYPE_SHORT: out[i] = r.u16(o); break;
        case TYPE_SSHORT: out[i] = r.i16(o); break;
        case TYPE_LONG: out[i] = r.u32(o); break;
        case TYPE_SLONG: out[i] = r.i32(o); break;
        case TYPE_RATIONAL: {
          const num = r.u32(o), den = r.u32(o + 4);
          out[i] = den === 0 ? 0 : num / den;
          break;
        }
        case TYPE_SRATIONAL: {
          const num = r.i32(o), den = r.i32(o + 4);
          out[i] = den === 0 ? 0 : num / den;
          break;
        }
        default: return null;
      }
    }
    return out;
  }

  // Scans one IFD, recording {entryOffset, type, count} for any of `wanted`
  // that are present. Bounded exactly like exif.js's scanIfd: the entry
  // count itself is read only if in range, and every entry is checked
  // before being read.
  function scanIfd(bytes, r, ifdOffset, wanted) {
    const found = {};
    if (ifdOffset < 0 || ifdOffset + 2 > bytes.length) return found;
    const entryCount = r.u16(ifdOffset);
    let p = ifdOffset + 2;
    for (let i = 0; i < entryCount; i++) {
      if (p + 12 > bytes.length) break;
      const tag = r.u16(p);
      if (wanted.has(tag)) {
        found[tag] = { entryOffset: p, type: r.u16(p + 2), count: r.u32(p + 4) };
      }
      p += 12;
    }
    return found;
  }

  function tagValues(bytes, r, tiffStart, entry) {
    if (!entry) return null;
    return readValues(bytes, r, entry.entryOffset, tiffStart, entry.type, entry.count);
  }

  // -- Colour matrix ----------------------------------------------------------
  // DNG's ColorMatrix1 maps CIE XYZ (D50) -> camera-native RGB, i.e. the
  // opposite direction from what a renderer needs. Invert it, then chain
  // with a fixed Bradford-adapted XYZ(D50)->linear-sRGB matrix (Lindbloom's
  // widely used constants) to get camera-native RGB -> linear sRGB in one
  // 3x3, computed once here on the CPU -- never per fragment.
  const XYZ_D50_TO_SRGB = [
    3.1338561, -1.6168667, -0.4906146,
    -0.9787684, 1.9161415, 0.0334540,
    0.0719453, -0.2289914, 1.4052427,
  ];

  function mat3Det(m) {
    return m[0] * (m[4] * m[8] - m[5] * m[7])
      - m[1] * (m[3] * m[8] - m[5] * m[6])
      + m[2] * (m[3] * m[7] - m[4] * m[6]);
  }

  function mat3Invert(m) {
    const det = mat3Det(m);
    if (Math.abs(det) < 1e-12) return null;
    const invDet = 1 / det;
    return [
      (m[4] * m[8] - m[5] * m[7]) * invDet,
      (m[2] * m[7] - m[1] * m[8]) * invDet,
      (m[1] * m[5] - m[2] * m[4]) * invDet,
      (m[5] * m[6] - m[3] * m[8]) * invDet,
      (m[0] * m[8] - m[2] * m[6]) * invDet,
      (m[2] * m[3] - m[0] * m[5]) * invDet,
      (m[3] * m[7] - m[4] * m[6]) * invDet,
      (m[1] * m[6] - m[0] * m[7]) * invDet,
      (m[0] * m[4] - m[1] * m[3]) * invDet,
    ];
  }

  function mat3Mul(a, b) {
    const out = new Array(9);
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        out[row * 3 + col] =
          a[row * 3 + 0] * b[0 * 3 + col] +
          a[row * 3 + 1] * b[1 * 3 + col] +
          a[row * 3 + 2] * b[2 * 3 + col];
      }
    }
    return out;
  }

  function mat3MulVec(m, v) {
    return [
      m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
      m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
      m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
    ];
  }

  // Computes white-balanced camera-native-RGB -> linear-sRGB, row-major, or
  // null if ColorMatrix1 is missing/degenerate (caller falls back to
  // identity).
  //
  // Chaining invert(ColorMatrix1) with the fixed D50 XYZ->sRGB matrix alone
  // is *not* enough to guarantee a neutral subject renders neutral: these
  // files carry no ForwardMatrix/CameraCalibration/AnalogBalance tags, so
  // there is nothing pinning the calibration illuminant's white to the D50
  // PCS white the fixed matrix assumes. Measured directly against these
  // three files: feeding a perfectly white-balanced neutral (1,1,1) through
  // invert(ColorMatrix1) then XYZ_D50_TO_SRGB alone lands at roughly
  // (2.03, 0.54, 1.46) -- nowhere near neutral. The fix applied here is a
  // one-time per-channel normalization, folded into the same 3x3: scale
  // each output row so that this specific matrix's own neutral point (its
  // row sums, i.e. what (1,1,1) maps to) lands at exactly (1,1,1). This
  // guarantees the stated requirement (a white-balanced neutral renders
  // neutral) by construction, at the cost of not being a fully rigorous
  // chromatic adaptation for saturated colors -- acceptable given this
  // renderer is deliberately neutral-only ("finish in Lightroom"), and
  // verified numerically in the task report.
  function computeCamToSrgb(colorMatrix1) {
    if (!colorMatrix1 || colorMatrix1.length !== 9) return null;
    const xyzFromCam = colorMatrix1; // XYZ -> camera
    const camToXyz = mat3Invert(xyzFromCam);
    if (!camToXyz) return null;
    const base = mat3Mul(XYZ_D50_TO_SRGB, camToXyz);
    const neutralOut = mat3MulVec(base, [1, 1, 1]);
    if (neutralOut.some((v) => Math.abs(v) < 1e-9)) return base; // degenerate; skip normalization
    const scale = neutralOut.map((v) => 1 / v);
    return [
      base[0] * scale[0], base[1] * scale[0], base[2] * scale[0],
      base[3] * scale[1], base[4] * scale[1], base[5] * scale[1],
      base[6] * scale[2], base[7] * scale[2], base[8] * scale[2],
    ];
  }

  // -- Main entry point ---------------------------------------------------
  function parse(bytes) {
    try {
      if (!bytes || bytes.length < 8) return reject('File is too short to be a TIFF/DNG.');
      const b0 = bytes[0], b1 = bytes[1];
      let little;
      if (b0 === 0x49 && b1 === 0x49) little = true;
      else if (b0 === 0x4d && b1 === 0x4d) little = false;
      else return reject('Not a TIFF/DNG file (missing II/MM byte-order mark).');

      const r = makeReaders(bytes, little);
      if (r.u16(2) !== 0x002a) return reject('Not a TIFF/DNG file (bad magic number).');
      const ifd0Offset = r.u32(4);
      if (ifd0Offset < 0 || ifd0Offset + 2 > bytes.length) {
        return reject('IFD0 offset points outside the file.');
      }

      const tiffStart = 0;
      const wanted = new Set([
        TAG_IMAGE_WIDTH, TAG_IMAGE_LENGTH, TAG_BITS_PER_SAMPLE, TAG_COMPRESSION,
        TAG_PHOTOMETRIC, TAG_MODEL, TAG_STRIP_OFFSETS, TAG_SAMPLES_PER_PIXEL,
        TAG_STRIP_BYTE_COUNTS, TAG_DATETIME, TAG_SUB_IFDS, TAG_CFA_PATTERN,
        TAG_BLACK_LEVEL, TAG_WHITE_LEVEL, TAG_COLOR_MATRIX1, TAG_AS_SHOT_NEUTRAL,
      ]);

      const found0 = scanIfd(bytes, r, ifd0Offset, wanted);

      // Metadata (model/date) usually lives in IFD0 even when the raw CFA
      // data itself sits in a SubIFD.
      const modelVals = found0[TAG_MODEL] && readAscii(bytes, r, found0[TAG_MODEL], tiffStart);
      const dateVals = (found0[TAG_DATETIME] && readAscii(bytes, r, found0[TAG_DATETIME], tiffStart)) || '';

      // Decide which IFD actually holds the CFA plane: IFD0 itself if its
      // PhotometricInterpretation already says CFA, else the first SubIFD
      // (tag 330) that does.
      let rawFound = found0;
      const photo0 = tagValues(bytes, r, tiffStart, found0[TAG_PHOTOMETRIC]);
      if (photo0 && photo0[0] !== PHOTOMETRIC_CFA) {
        // IFD0 is explicitly something other than CFA (e.g. a thumbnail) --
        // follow tag 330 to the first SubIFD that is CFA, per the brief.
        const subOffsets = tagValues(bytes, r, tiffStart, found0[TAG_SUB_IFDS]);
        rawFound = null;
        if (subOffsets) {
          for (let i = 0; i < subOffsets.length; i++) {
            const off = subOffsets[i];
            if (off < 0 || off + 2 > bytes.length) continue;
            const candidate = scanIfd(bytes, r, off, wanted);
            const photo = tagValues(bytes, r, tiffStart, candidate[TAG_PHOTOMETRIC]);
            if (photo && photo[0] === PHOTOMETRIC_CFA) { rawFound = candidate; break; }
          }
        }
        if (!rawFound) return reject('No CFA (raw Bayer) image plane found in this DNG.');
      }

      const compression = tagValues(bytes, r, tiffStart, rawFound[TAG_COMPRESSION]);
      if (!compression || compression[0] !== 1) {
        return reject('Unsupported compression (' +
          (compression ? compression[0] : 'unknown') + '); only uncompressed (1) DNGs are supported.');
      }

      const bitsPerSample = tagValues(bytes, r, tiffStart, rawFound[TAG_BITS_PER_SAMPLE]);
      if (!bitsPerSample || bitsPerSample[0] !== 16) {
        return reject('Unsupported bit depth (' +
          (bitsPerSample ? bitsPerSample[0] : 'unknown') + '); only 16-bit samples are supported.');
      }

      const samplesPerPixel = tagValues(bytes, r, tiffStart, rawFound[TAG_SAMPLES_PER_PIXEL]);
      if (!samplesPerPixel || samplesPerPixel[0] !== 1) {
        return reject('Unsupported samples per pixel (' +
          (samplesPerPixel ? samplesPerPixel[0] : 'unknown') + '); only single-channel CFA data is supported.');
      }

      const photoRaw = tagValues(bytes, r, tiffStart, rawFound[TAG_PHOTOMETRIC]);
      if (!photoRaw || photoRaw[0] !== PHOTOMETRIC_CFA) {
        return reject('Photometric interpretation is not CFA (raw Bayer); this decoder only ' +
          'handles raw sensor data, not already-demosaiced images.');
      }

      const width = tagValues(bytes, r, tiffStart, rawFound[TAG_IMAGE_WIDTH]);
      const height = tagValues(bytes, r, tiffStart, rawFound[TAG_IMAGE_LENGTH]);
      if (!width || !height) return reject('Missing image dimensions.');

      const stripOffsets = tagValues(bytes, r, tiffStart, rawFound[TAG_STRIP_OFFSETS]);
      const stripByteCounts = tagValues(bytes, r, tiffStart, rawFound[TAG_STRIP_BYTE_COUNTS]);
      if (!stripOffsets || !stripByteCounts || stripOffsets.length !== 1 || stripByteCounts.length !== 1) {
        return reject('Expected exactly one strip; multi-strip/tiled DNGs are not supported.');
      }
      const stripOffset = stripOffsets[0];
      const stripByteCount = stripByteCounts[0];
      const expectedBytes = width[0] * height[0] * 2;
      if (stripByteCount !== expectedBytes) {
        return reject('Strip byte count (' + stripByteCount + ') does not match width*height*2 (' +
          expectedBytes + '); this decoder only handles a plain uncompressed 16-bit plane.');
      }
      if (stripOffset < 0 || stripOffset + stripByteCount > bytes.length) {
        return reject('Strip data extends past the end of the file.');
      }

      const cfaPatternVals = tagValues(bytes, r, tiffStart, rawFound[TAG_CFA_PATTERN]);
      if (!cfaPatternVals || cfaPatternVals.length !== 4) {
        return reject('Unsupported or missing CFA pattern (expected a 2x2 Bayer pattern).');
      }

      const blackLevelVals = tagValues(bytes, r, tiffStart, rawFound[TAG_BLACK_LEVEL]);
      const whiteLevelVals = tagValues(bytes, r, tiffStart, rawFound[TAG_WHITE_LEVEL]);
      const blackLevel = blackLevelVals ? blackLevelVals[0] : 0;
      const whiteLevel = whiteLevelVals ? whiteLevelVals[0] : 65535;

      const asShotNeutralVals = tagValues(bytes, r, tiffStart, rawFound[TAG_AS_SHOT_NEUTRAL]);
      const asShotNeutral = (asShotNeutralVals && asShotNeutralVals.length === 3)
        ? asShotNeutralVals.slice() : [1, 1, 1];

      const colorMatrix1Vals = tagValues(bytes, r, tiffStart, rawFound[TAG_COLOR_MATRIX1]);
      const camToSrgb = computeCamToSrgb(colorMatrix1Vals) ||
        [1, 0, 0, 0, 1, 0, 0, 0, 1]; // identity fallback if the tag is absent/degenerate

      return {
        width: width[0],
        height: height[0],
        littleEndian: little,
        bitsPerSample: bitsPerSample[0],
        cfaPattern: cfaPatternVals,
        blackLevel,
        whiteLevel,
        asShotNeutral,
        camToSrgb,
        stripOffset,
        stripByteCount,
        model: modelVals ? modelVals.replace(/\0+$/, '').trim() : '',
        dateTimeOriginal: dateVals ? String(dateVals).replace(/\0+$/, '').trim() : '',
      };
    } catch (e) {
      return reject('Unexpected error while parsing: ' + e.message);
    }
  }

  function readAscii(bytes, r, entry, tiffStart) {
    if (!entry || entry.type !== TYPE_ASCII || entry.count <= 0) return '';
    const count = entry.count;
    let valueOffset;
    if (count <= 4) valueOffset = entry.entryOffset + 8;
    else valueOffset = tiffStart + r.u32(entry.entryOffset + 8);
    if (valueOffset < 0 || valueOffset + count > bytes.length) return '';
    let s = '';
    for (let i = 0; i < count; i++) s += String.fromCharCode(bytes[valueOffset + i]);
    return s;
  }

  return { parse, lastRejectionReason };
});
