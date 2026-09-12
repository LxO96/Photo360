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

  // Placeholder for Task 13, which will actually splice the source file's
  // EXIF/orientation segment into the re-encoded bytes. Until then this is
  // an identity function so app.js's export path has something real to
  // call (not a stub living in app.js that would shadow this module).
  function reattach(bytes) { return bytes; }

  return { readJpegSize, reattach };
});
