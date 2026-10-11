(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Exif = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Markers that are not Start-Of-Frame despite falling in the 0xFFC0-0xFFCF
  // range: DHT (0xC4), JPG extension (0xC8), and DAC (0xCC).
  const NON_SOF = new Set([0xc4, 0xc8, 0xcc]);

  // Parse the dimensions out of a JPEG's marker segments, without decoding
  // any pixel data. `bytes` need only contain the file's head (the SOF
  // marker is always near the start, well before any scan data).
  function readJpegSize(bytes) {
    if (!bytes || bytes.length < 4) return null;
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null; // SOI

    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) return null; // malformed marker stream
      const marker = bytes[offset + 1];
      offset += 2;

      if (marker === 0xd8 || marker === 0xd9) continue; // SOI/EOI, no length
      if (marker >= 0xd0 && marker <= 0xd7) continue; // RSTn, no length

      const length = (bytes[offset] << 8) | bytes[offset + 1];
      if (marker >= 0xc0 && marker <= 0xcf && !NON_SOF.has(marker)) {
        if (offset + 7 > bytes.length) return null;
        const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
        const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
        return { width, height };
      }
      offset += length;
    }
    return null;
  }

  const TAG_MAKE = 0x010f;
  const TAG_MODEL = 0x0110;
  const TAG_DATETIME = 0x0132;
  const TAG_EXIF_IFD = 0x8769;
  const TAG_DATETIME_ORIGINAL = 0x9003;
  // Shutter time (RATIONAL, seconds) and ISO (SHORT), for the photo strip.
  const TAG_EXPOSURE_TIME = 0x829a;
  const TAG_ISO = 0x8827;
  const TYPE_ASCII = 2;

  // Strip a trailing run of NUL bytes (and any stray whitespace) off a
  // decoded ASCII value. EXIF ASCII values are NUL-terminated, and some
  // encoders (e.g. this camera) leave the rest of the padded field zeroed
  // too, which String.trim() would not remove since \0 is not whitespace.
  function stripNuls(s) {
    return s.replace(/\0+$/, '');
  }

  // Locate the first APP1 (0xFFE1) marker carrying an "Exif\0\0" signature,
  // scanning from just after the SOI. Returns the offset of the segment's
  // payload (immediately after the 6-byte "Exif\0\0" signature) plus the
  // segment's declared length, or null if none is found.
  function findExifApp1(bytes) {
    if (!bytes || bytes.length < 4) return null;
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null; // SOI

    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) return null;
      const marker = bytes[offset + 1];
      offset += 2;

      if (marker === 0xd8 || marker === 0xd9) continue;
      if (marker >= 0xd0 && marker <= 0xd7) continue;
      if (offset + 2 > bytes.length) return null;

      const length = (bytes[offset] << 8) | bytes[offset + 1];
      if (length < 2 || offset + length > bytes.length) return null;

      if (marker === 0xe1 && length >= 8 &&
          bytes[offset + 2] === 0x45 && bytes[offset + 3] === 0x78 &&
          bytes[offset + 4] === 0x69 && bytes[offset + 5] === 0x66 &&
          bytes[offset + 6] === 0x00 && bytes[offset + 7] === 0x00) {
        return { tiffStart: offset + 8, segmentEnd: offset + length };
      }

      // Stop once we hit the scan data / a marker that can't precede EXIF
      // meaningfully -- SOS (0xDA) starts entropy-coded data.
      if (marker === 0xda) return null;
      offset += length;
    }
    return null;
  }

  // Read a 16/32-bit value at `offset` honouring the TIFF byte order.
  function makeReaders(bytes, little) {
    return {
      u16(o) {
        return little ? (bytes[o] | (bytes[o + 1] << 8))
                       : ((bytes[o] << 8) | bytes[o + 1]);
      },
      u32(o) {
        return little
          ? ((bytes[o]) | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] * 0x1000000))
          : ((bytes[o] * 0x1000000) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]);
      },
    };
  }

  // Decode an ASCII tag value out of one IFD entry. `entryOffset` points at
  // the start of the 12-byte entry; `tiffStart` is the base all offsets
  // inside the TIFF are relative to.
  function readAsciiValue(bytes, r, entryOffset, tiffStart) {
    const type = r.u16(entryOffset + 2);
    const count = r.u32(entryOffset + 4);
    if (type !== TYPE_ASCII || count <= 0) return '';
    let valueOffset;
    if (count <= 4) {
      valueOffset = entryOffset + 8;
    } else {
      valueOffset = tiffStart + r.u32(entryOffset + 8);
    }
    if (valueOffset < 0 || valueOffset + count > bytes.length) return '';
    let s = '';
    for (let i = 0; i < count; i++) s += String.fromCharCode(bytes[valueOffset + i]);
    return stripNuls(s);
  }

  // Scan one IFD for the tags we care about, returning a map of
  // tagId -> {entryOffset} for any of `wanted` that are present, plus the
  // offset of the next IFD (or 0 if none).
  function scanIfd(bytes, r, ifdOffset, tiffStart, wanted) {
    const found = {};
    if (ifdOffset + 2 > bytes.length) return { found, next: 0 };
    const entryCount = r.u16(ifdOffset);
    let p = ifdOffset + 2;
    for (let i = 0; i < entryCount; i++) {
      if (p + 12 > bytes.length) break;
      const tag = r.u16(p);
      if (wanted.has(tag)) found[tag] = p;
      p += 12;
    }
    const next = (p + 4 <= bytes.length) ? r.u32(p) : 0;
    return { found, next };
  }

  // Read the camera identity and capture time out of a JPEG's EXIF block.
  // Returns empty strings for anything absent, never throws on malformed
  // input.
  function readTags(bytes) {
    const empty = { make: '', model: '', dateTimeOriginal: '', exposureTime: null, iso: null };
    try {
      const loc = findExifApp1(bytes);
      if (!loc) return empty;
      const { tiffStart } = loc;
      if (tiffStart + 8 > bytes.length) return empty;

      const b0 = bytes[tiffStart], b1 = bytes[tiffStart + 1];
      let little;
      if (b0 === 0x49 && b1 === 0x49) little = true; // 'II'
      else if (b0 === 0x4d && b1 === 0x4d) little = false; // 'MM'
      else return empty;

      const r = makeReaders(bytes, little);
      if (r.u16(tiffStart + 2) !== 0x002a) return empty; // magic 42
      const ifd0Offset = tiffStart + r.u32(tiffStart + 4);

      const wanted0 = new Set([TAG_MAKE, TAG_MODEL, TAG_DATETIME, TAG_EXIF_IFD]);
      const { found: found0 } = scanIfd(bytes, r, ifd0Offset, tiffStart, wanted0);

      const result = { make: '', model: '', dateTimeOriginal: '', exposureTime: null, iso: null };
      if (found0[TAG_MAKE] !== undefined) result.make = readAsciiValue(bytes, r, found0[TAG_MAKE], tiffStart);
      if (found0[TAG_MODEL] !== undefined) result.model = readAsciiValue(bytes, r, found0[TAG_MODEL], tiffStart);
      if (found0[TAG_EXIF_IFD] !== undefined) {
        const exifIfdOffset = tiffStart + r.u32(found0[TAG_EXIF_IFD] + 8);
        const { found: foundExif } = scanIfd(
          bytes, r, exifIfdOffset, tiffStart, new Set([TAG_DATETIME_ORIGINAL, TAG_EXPOSURE_TIME, TAG_ISO]));
        const et = foundExif[TAG_EXPOSURE_TIME];
        if (et !== undefined && r.u16(et + 2) === 5) {
          const at = tiffStart + r.u32(et + 8);
          if (at + 8 <= bytes.length) {
            const num = r.u32(at), den = r.u32(at + 4);
            if (num > 0 && den > 0) result.exposureTime = num / den;
          }
        }
        const iso = foundExif[TAG_ISO];
        if (iso !== undefined && r.u16(iso + 2) === 3) {
          const v = r.u16(iso + 8);
          if (v > 0) result.iso = v;
        }
        if (foundExif[TAG_DATETIME_ORIGINAL] !== undefined) {
          result.dateTimeOriginal = readAsciiValue(bytes, r, foundExif[TAG_DATETIME_ORIGINAL], tiffStart);
        }
      }
      if (!result.dateTimeOriginal && found0[TAG_DATETIME] !== undefined) {
        result.dateTimeOriginal = readAsciiValue(bytes, r, found0[TAG_DATETIME], tiffStart);
      }

      return result;
    } catch (e) {
      return empty;
    }
  }

  // Build a minimal little-endian TIFF APP1 segment carrying just the four
  // tags we know how to round-trip. Deliberately does not copy anything
  // from a source file's own APP1 -- that would drag in the wrong
  // dimensions/thumbnail for a re-rendered image.
  function buildApp1(tags) {
    const make = String((tags && tags.make) || '') + '\0';
    const model = String((tags && tags.model) || '') + '\0';
    const dateTime = String((tags && tags.dateTimeOriginal) || '') + '\0';
    const dateTimeOriginal = dateTime;

    // Layout (all offsets relative to the start of the TIFF header, i.e.
    // right after "Exif\0\0"):
    //   0: TIFF header (8 bytes)
    //   8: IFD0 (2 + 4*12 + 4 = 54 bytes) -- Make, Model, DateTime, ExifIFD ptr
    //   62: ExifIFD (2 + 1*12 + 4 = 18 bytes) -- DateTimeOriginal
    //   80: string pool -- make, model, dateTime, dateTimeOriginal
    const TIFF_HEADER = 8;
    const IFD0_OFFSET = TIFF_HEADER;
    const IFD0_ENTRY_COUNT = 4;
    const IFD0_SIZE = 2 + IFD0_ENTRY_COUNT * 12 + 4;
    const EXIF_IFD_OFFSET = IFD0_OFFSET + IFD0_SIZE;
    const EXIF_IFD_ENTRY_COUNT = 1;
    const EXIF_IFD_SIZE = 2 + EXIF_IFD_ENTRY_COUNT * 12 + 4;
    const POOL_OFFSET = EXIF_IFD_OFFSET + EXIF_IFD_SIZE;

    const strings = [
      { bytes: make, offset: POOL_OFFSET },
    ];
    strings.push({ bytes: model, offset: strings[0].offset + strings[0].bytes.length });
    strings.push({ bytes: dateTime, offset: strings[1].offset + strings[1].bytes.length });
    strings.push({ bytes: dateTimeOriginal, offset: strings[2].offset + strings[2].bytes.length });
    const [makeStr, modelStr, dateTimeStr, dateTimeOriginalStr] = strings;

    const tiffLength = dateTimeOriginalStr.offset + dateTimeOriginalStr.bytes.length;
    const tiff = new Uint8Array(tiffLength);
    let p = 0;
    function u8(v) { tiff[p++] = v & 0xff; }
    function u16(v) { tiff[p] = v & 0xff; tiff[p + 1] = (v >> 8) & 0xff; p += 2; }
    function u32(v) { tiff[p] = v & 0xff; tiff[p + 1] = (v >> 8) & 0xff; tiff[p + 2] = (v >> 16) & 0xff; tiff[p + 3] = (v >>> 24) & 0xff; p += 4; }
    function ascii(s) { for (let i = 0; i < s.length; i++) tiff[p++] = s.charCodeAt(i) & 0xff; }

    // TIFF header: 'II', magic 42, IFD0 offset.
    u8(0x49); u8(0x49);
    u16(0x002a);
    u32(IFD0_OFFSET);

    // IFD0.
    p = IFD0_OFFSET;
    u16(IFD0_ENTRY_COUNT);

    function writeAsciiEntry(tag, str) {
      u16(tag);
      u16(TYPE_ASCII);
      u32(str.bytes.length);
      if (str.bytes.length <= 4) {
        const save = p;
        ascii(str.bytes);
        p = save + 4;
      } else {
        u32(str.offset);
      }
    }

    writeAsciiEntry(TAG_MAKE, makeStr);
    writeAsciiEntry(TAG_MODEL, modelStr);
    writeAsciiEntry(TAG_DATETIME, dateTimeStr);
    // ExifIFD pointer (type LONG).
    u16(TAG_EXIF_IFD);
    u16(4); // LONG
    u32(1);
    u32(EXIF_IFD_OFFSET);
    u32(0); // next IFD offset (none)

    // ExifIFD.
    p = EXIF_IFD_OFFSET;
    u16(EXIF_IFD_ENTRY_COUNT);
    writeAsciiEntry(TAG_DATETIME_ORIGINAL, dateTimeOriginalStr);
    u32(0); // next IFD offset (none)

    // String pool.
    p = makeStr.offset; ascii(makeStr.bytes);
    p = modelStr.offset; ascii(modelStr.bytes);
    p = dateTimeStr.offset; ascii(dateTimeStr.bytes);
    p = dateTimeOriginalStr.offset; ascii(dateTimeOriginalStr.bytes);

    // Wrap in an APP1 segment: FF E1, length (big-endian, excludes marker
    // bytes but includes itself), "Exif\0\0", then the TIFF.
    const signature = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"
    const segmentLength = 2 + signature.length + tiff.length; // excludes FF E1
    const app1 = new Uint8Array(2 + 2 + signature.length + tiff.length);
    app1[0] = 0xff; app1[1] = 0xe1;
    app1[2] = (segmentLength >> 8) & 0xff;
    app1[3] = segmentLength & 0xff;
    app1.set(signature, 4);
    app1.set(tiff, 4 + signature.length);
    return app1;
  }

  // Insert `app1` directly after the SOI marker, dropping any APP1 the
  // encoder already wrote so the output never carries two. Returns
  // `jpegBytes` unchanged when `app1` is null (used for PNG exports, where
  // there is no APP1 concept and nothing to attach).
  function reattach(jpegBytes, app1) {
    if (!app1) return jpegBytes;
    if (!jpegBytes || jpegBytes.length < 2 || jpegBytes[0] !== 0xff || jpegBytes[1] !== 0xd8) {
      return jpegBytes;
    }

    // Find an existing APP1 (any signature, not just Exif) sitting right
    // after SOI, so we can drop it.
    let cut = 2;
    if (cut + 4 <= jpegBytes.length && jpegBytes[cut] === 0xff && jpegBytes[cut + 1] === 0xe1) {
      const length = (jpegBytes[cut + 2] << 8) | jpegBytes[cut + 3];
      if (length >= 2 && cut + 2 + length <= jpegBytes.length) {
        cut = cut + 2 + length;
      }
    }

    const out = new Uint8Array(2 + app1.length + (jpegBytes.length - cut));
    out.set(jpegBytes.subarray(0, 2), 0);
    out.set(app1, 2);
    out.set(jpegBytes.subarray(cut), 2 + app1.length);
    return out;
  }

  return { readJpegSize, readTags, buildApp1, reattach };
});
