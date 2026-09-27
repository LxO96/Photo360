(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Source = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // File bytes in, one plain descriptor out -- everything a load path needs
  // to know about the file (lens count, pixel sizes, calibration, raw
  // metadata, decoded bitmaps/planes) *before* anything touches the GPU or
  // `state`. Extracted out of app.js (final review round) so a load's
  // decode-and-validate half has no way to reach into ctx.textures or state
  // piecemeal -- app.js's job becomes "upload what this returns, then
  // commit it in one assignment", which is what closes the Critical finding
  // (a 1:1 file inheriting the previous file's lens B) and the related
  // partial-load-leaves-mixed-state bug: every failure here happens before
  // a single GPU call, so the caller's ctx/state are never touched until a
  // full, valid descriptor exists.
  //
  // Every thrown Error here carries `.formatted = true` when its message is
  // already a complete, user-facing sentence (a known rejection reason, not
  // a raw JS exception) -- app.js uses that flag to decide whether to wrap
  // the message with "Could not read that file: " or show it verbatim.

  // The X5's own .insp files carry several megabytes of embedded metadata
  // (gain-map / preview APPn segments) before the SOF marker that carries
  // the frame size, so the probe has to read a generous head -- still
  // trivial next to decoding the full 283MB frame just to read two numbers.
  const HEAD_PROBE_BYTES = 6 * 1024 * 1024;

  const UNSUPPORTED_MSG =
    'Not a fisheye file: expected a 2:1 or 1:2 dual fisheye or a 1:1 single fisheye.';

  function formattedError(msg) {
    const e = new Error(msg);
    e.formatted = true;
    return e;
  }

  // Read the frame dimensions without decoding pixel data: parse the JPEG
  // header directly, and only fall back to a full decode if that fails
  // (e.g. an unusual file whose SOF sits beyond the probed head).
  async function probeSize(blob, buf) {
    const head = new Uint8Array(buf, 0, Math.min(buf.byteLength, HEAD_PROBE_BYTES));
    const size = Exif.readJpegSize(head);
    if (size) return size;
    const probe = await createImageBitmap(blob);
    const fallback = { width: probe.width, height: probe.height };
    probe.close();
    return fallback;
  }

  // Extracts one lens's square Bayer plane out of a DNG's single strip as a
  // Uint16Array, honouring the file's own byte order (`d.littleEndian`).
  // `o` is the lens's {x, y} offset within the full stacked frame (from
  // Lens.detectLayout), in the same pixel-row/column space CFAPattern's own
  // phase is defined in. Both `o.x` and `o.y` are expected to be exact
  // multiples of the lens size -- which is itself even for every file this
  // tool has seen -- but that is a property of the *input*, not something
  // this function may assume: an odd offset would shift the CFA phase
  // relative to the tag dng.js already read, silently swapping R and B on
  // that lens with a perfectly plausible-looking result. Returns null
  // (never silently mis-decodes) if either offset is odd.
  function extractBayerPlane(bytes, d, o, size) {
    if ((o.x & 1) !== 0 || (o.y & 1) !== 0) return null;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const plane = new Uint16Array(size * size);
    const rowBytes = d.width * 2;
    for (let row = 0; row < size; row++) {
      const srcRowStart = d.stripOffset + (o.y + row) * rowBytes + o.x * 2;
      let p = row * size;
      for (let col = 0; col < size; col++) {
        plane[p++] = dv.getUint16(srcRowStart + col * 2, d.littleEndian);
      }
    }
    return plane;
  }

  // -- ColorMatrix1 extraction (Task 17) -----------------------------------
  // dng.js reads ColorMatrix1 (tag 50721) internally, but only to build the
  // display-oriented camToSrgb matrix -- already inverted, Bradford-chained
  // to sRGB, and row-normalized to its own neutral point -- and does not
  // return the raw XYZ->camera matrix itself. wb.js's
  // neutralFromKelvinTint/kelvinTintFromNeutral need exactly that raw
  // matrix (camToSrgb's per-row normalization throws away three degrees of
  // freedom, so it cannot be un-mixed back into ColorMatrix1 -- see wb.js's
  // own header comment). Rather than touch dng.js, this is a small,
  // independent re-scan of the same tag: byte-order + IFD0, following tag
  // 330 (SubIFDs) exactly like dng.js's own rawFound resolution does if
  // IFD0 itself isn't the CFA plane. Verified against all three supplied
  // DNGs (task report): ColorMatrix1 lives directly in IFD0 for these
  // files, but the SubIFD fallback is kept for robustness. Returns a
  // 9-element row-major array (XYZ -> camera) or null.
  const CM1_TAG_SUB_IFDS = 330;
  const CM1_TAG_COLOR_MATRIX1 = 50721;

  function cm1Readers(bytes, little) {
    return {
      u16(o) { return little ? (bytes[o] | (bytes[o + 1] << 8)) : ((bytes[o] << 8) | bytes[o + 1]); },
      u32(o) {
        const v = little
          ? (bytes[o] + bytes[o + 1] * 0x100 + bytes[o + 2] * 0x10000 + bytes[o + 3] * 0x1000000)
          : (bytes[o] * 0x1000000 + bytes[o + 1] * 0x10000 + bytes[o + 2] * 0x100 + bytes[o + 3]);
        return v >>> 0;
      },
      i32(o) { const u = this.u32(o); return u > 0x7fffffff ? u - 0x100000000 : u; },
    };
  }

  function cm1ScanIfd(bytes, r, ifdOffset, wanted) {
    const found = {};
    if (ifdOffset < 0 || ifdOffset + 2 > bytes.length) return found;
    const entryCount = r.u16(ifdOffset);
    let p = ifdOffset + 2;
    for (let i = 0; i < entryCount; i++) {
      if (p + 12 > bytes.length) break;
      const tag = r.u16(p);
      if (wanted.has(tag)) found[tag] = { entryOffset: p, type: r.u16(p + 2), count: r.u32(p + 4) };
      p += 12;
    }
    return found;
  }

  // Reads a 9-count SRATIONAL (type 10) tag's values -- ColorMatrix1's own
  // encoding. Bounded exactly like dng.js's own readValues.
  function cm1ReadSrational9(bytes, r, entry) {
    if (!entry || entry.count !== 9) return null;
    const size = 8, total = size * 9;
    const valueOffset = r.u32(entry.entryOffset + 8);
    if (valueOffset < 0 || valueOffset + total > bytes.length) return null;
    const out = new Array(9);
    for (let i = 0; i < 9; i++) {
      const o = valueOffset + i * size;
      const num = r.i32(o), den = r.i32(o + 4);
      out[i] = den === 0 ? 0 : num / den;
    }
    return out;
  }

  // Reads tag 330's LONG offsets -- bounded the same way dng.js's own
  // readValues is.
  function cm1ReadSubIfdOffsets(bytes, r, entry) {
    const size = 4, count = entry.count, total = size * count;
    if (count <= 0 || count > 64) return [];
    const base = total <= 4 ? entry.entryOffset + 8 : r.u32(entry.entryOffset + 8);
    if (base < 0 || base + total > bytes.length) return [];
    const out = [];
    for (let i = 0; i < count; i++) out.push(r.u32(base + i * size));
    return out;
  }

  function readColorMatrix1(bytes) {
    try {
      if (!bytes || bytes.length < 8) return null;
      const little = bytes[0] === 0x49 && bytes[1] === 0x49;
      const big = bytes[0] === 0x4d && bytes[1] === 0x4d;
      if (!little && !big) return null;
      const r = cm1Readers(bytes, little);
      const ifd0Offset = r.u32(4);
      const wanted = new Set([CM1_TAG_SUB_IFDS, CM1_TAG_COLOR_MATRIX1]);
      const found0 = cm1ScanIfd(bytes, r, ifd0Offset, wanted);
      if (found0[CM1_TAG_COLOR_MATRIX1]) {
        const cm = cm1ReadSrational9(bytes, r, found0[CM1_TAG_COLOR_MATRIX1]);
        if (cm) return cm;
      }
      if (!found0[CM1_TAG_SUB_IFDS]) return null;
      for (const off of cm1ReadSubIfdOffsets(bytes, r, found0[CM1_TAG_SUB_IFDS])) {
        const sub = cm1ScanIfd(bytes, r, off, wanted);
        if (sub[CM1_TAG_COLOR_MATRIX1]) {
          const cm = cm1ReadSrational9(bytes, r, sub[CM1_TAG_COLOR_MATRIX1]);
          if (cm) return cm;
        }
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  // Only ever a default for the output Layout control -- null (no opinion)
  // for a single-lens file, since 'side'/'stacked' describe a two-up
  // export layout that a 1:1 source has no bearing on.
  function defaultOrientationFor(arrangement) {
    return (arrangement === 'stacked' || arrangement === 'side') ? arrangement : null;
  }

  // Decodes an uncompressed DNG into a descriptor carrying one Uint16Array
  // Bayer plane per lens (`planes`), not yet uploaded to the GPU.
  async function decodeDng(file, buf, maxTextureSize) {
    const bytes = new Uint8Array(buf);
    const d = Dng.parse(bytes);
    if (!d) throw formattedError(Dng.lastRejectionReason());
    const layout = Lens.detectLayout(d.width, d.height);
    if (layout.kind === 'unsupported') throw formattedError(UNSUPPORTED_MSG);
    if (layout.lensSize > maxTextureSize) {
      throw formattedError(
        'This GPU caps textures at ' + maxTextureSize + ' px; this raw file\'s ' +
        layout.lensSize + 'px lenses cannot be downscaled without corrupting the sensor ' +
        'pattern, so this raw file cannot be loaded on this GPU.');
    }
    const planes = [];
    for (let i = 0; i < layout.lenses.length; i++) {
      const plane = extractBayerPlane(bytes, d, layout.lenses[i], layout.lensSize);
      if (!plane) {
        throw formattedError('Internal error: this raw file\'s lens offsets are not ' +
          'sensor-aligned; refusing to guess at the CFA phase.');
      }
      planes.push(plane);
    }
    const calibration = Lens.calibrationFor(d.model, layout.arrangement);
    const colorMatrix1 = readColorMatrix1(bytes);
    // Task 17: the per-lens control is Kelvin/tint, not a raw neutral
    // triple -- seed both lenses from the file's own AsShotNeutral via
    // Wb.kelvinTintFromNeutral (the inverse of the shader-uniform path), so
    // "Reset to as-shot" and the initial render both start from the same
    // real camera-measured white balance Task 16 did, just expressed as
    // Kelvin/tint now. Wb.js is a plain global here, like Lens/Exif/Dng --
    // see index.html's script order.
    const asShotKt = Wb.kelvinTintFromNeutral(d.asShotNeutral, colorMatrix1);
    return {
      kind: 'dng',
      lensCount: layout.lenses.length,
      lensSize: layout.lensSize,
      uploadedLensSize: layout.lensSize,
      overLimit: false,
      planes,
      isRaw: true,
      rawMeta: {
        cfaPattern: d.cfaPattern, blackLevel: d.blackLevel,
        whiteLevel: d.whiteLevel, camToSrgb: d.camToSrgb,
        colorMatrix1,
      },
      // Magnitude and sign (GL.circleDraw applies -90 to physical A, +90 to
      // physical B) verified in the browser against all three supplied raw
      // files -- see app.js's previous inline comment (now here) and the
      // task report.
      sensorRotationDeg: 90,
      rawAsShotNeutral: d.asShotNeutral.slice(),
      rawWb: { A: { kelvin: asShotKt.kelvin, tint: asShotKt.tint },
               B: { kelvin: asShotKt.kelvin, tint: asShotKt.tint } },
      calibration,
      calibrationGuessedFromShape: !calibration.model && layout.arrangement === 'stacked',
      thetaMaxDeg: calibration.thetaMaxDeg,
      sourceName: file.name,
      sourceExif: Exif.buildApp1({ make: '', model: d.model, dateTimeOriginal: d.dateTimeOriginal }),
      orientationDefault: defaultOrientationFor(layout.arrangement),
    };
  }

  // Decodes an .insp/.jpg into a descriptor carrying one ImageBitmap per
  // lens (`bitmaps`), not yet uploaded to the GPU. Callers must close every
  // bitmap once its pixels are uploaded (or on any later failure) -- this
  // function itself closes them if decoding a later lens throws partway
  // through, so a caller only ever sees a fully-populated `bitmaps` array
  // or a thrown error, never a half-filled one to clean up.
  async function decodeJpeg(file, buf, maxTextureSize) {
    const blob = new Blob([buf], { type: 'image/jpeg' });  // .insp has no MIME type
    const size = await probeSize(blob, buf);
    const layout = Lens.detectLayout(size.width, size.height);
    if (layout.kind === 'unsupported') throw formattedError(UNSUPPORTED_MSG);
    const overLimit = layout.lensSize > maxTextureSize;
    // imageOrientation: 'flipY' makes GL texture t=0 the bottom of the
    // image, matching gl_FragCoord.y (increases upward). See gl.js
    // uploadLens for why this can't be done with UNPACK_FLIP_Y_WEBGL.
    const decodeOpts = overLimit
      ? { imageOrientation: 'flipY', resizeWidth: maxTextureSize,
          resizeHeight: maxTextureSize, resizeQuality: 'high' }
      : { imageOrientation: 'flipY' };
    const bitmaps = [];
    try {
      for (let i = 0; i < layout.lenses.length; i++) {
        const o = layout.lenses[i];
        bitmaps.push(await createImageBitmap(
          blob, o.x, o.y, layout.lensSize, layout.lensSize, decodeOpts));
      }
    } catch (e) {
      for (const b of bitmaps) b.close();
      throw e;
    }
    const tags = Exif.readTags(new Uint8Array(buf));
    const calibration = Lens.calibrationFor(tags.model, layout.arrangement);
    return {
      kind: 'jpeg',
      lensCount: layout.lenses.length,
      lensSize: layout.lensSize,
      uploadedLensSize: overLimit ? maxTextureSize : layout.lensSize,
      overLimit,
      bitmaps,
      isRaw: false,
      rawMeta: null,
      rawAsShotNeutral: null,
      sensorRotationDeg: 0,
      calibration,
      calibrationGuessedFromShape: !calibration.model && layout.arrangement === 'stacked',
      thetaMaxDeg: calibration.thetaMaxDeg,
      sourceName: file.name,
      sourceExif: Exif.buildApp1(tags),
      orientationDefault: defaultOrientationFor(layout.arrangement),
    };
  }

  // Single entry point: dispatches on the file's extension exactly like the
  // old app.js loadFile did.
  function decode(file, buf, maxTextureSize) {
    if (/\.dng$/i.test(file.name)) return decodeDng(file, buf, maxTextureSize);
    return decodeJpeg(file, buf, maxTextureSize);
  }

  return {
    decode, decodeDng, decodeJpeg, probeSize, extractBayerPlane,
    defaultOrientationFor, HEAD_PROBE_BYTES, UNSUPPORTED_MSG, readColorMatrix1,
  };
});
