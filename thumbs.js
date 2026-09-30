(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Thumbs = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Quick thumbnails for the strip, made without the GPU pipeline: the
  // camera's own EXIF thumbnail for a JPEG/.insp, and for a DNG (these carry
  // no preview) a coarse read of the raw plane -- one 2x2 Bayer block every
  // `step` pixels, only the rows it needs. They show the capture as shot
  // (both fisheye circles); app.js swaps in a snapshot of the edited
  // composition once a photo has been opened.
  const SIZE = 256;

  // The JPEG thumbnail in the Exif APP1 segment (IFD1's JPEGInterchangeFormat
  // and ...Length), as absolute offsets into `bytes`, or null.
  function exifThumbnail(bytes) {
    try {
      if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
      let o = 2;
      while (o + 4 <= bytes.length && bytes[o] === 0xff) {
        const marker = bytes[o + 1];
        const len = (bytes[o + 2] << 8) | bytes[o + 3];
        if (marker === 0xda || len < 2) return null;
        const seg = o + 4;
        if (marker === 0xe1 && bytes[seg] === 0x45 && bytes[seg + 1] === 0x78 && bytes[seg + 2] === 0x69 &&
            bytes[seg + 3] === 0x66 && bytes[seg + 4] === 0 && bytes[seg + 5] === 0) {
          const t = seg + 6;
          const le = bytes[t] === 0x49;
          const u16 = (p) => (le ? bytes[p] | (bytes[p + 1] << 8) : (bytes[p] << 8) | bytes[p + 1]);
          const u32 = (p) => (le
            ? (bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16) | (bytes[p + 3] << 24)) >>> 0
            : ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) >>> 0);
          const ifd0 = t + u32(t + 4);
          const ifd1Rel = u32(ifd0 + 2 + 12 * u16(ifd0));
          if (!ifd1Rel) return null;
          const ifd1 = t + ifd1Rel;
          let off = 0, n = 0;
          for (let i = 0; i < u16(ifd1); i++) {
            const e = ifd1 + 2 + 12 * i, tag = u16(e);
            if (tag === 0x0201) off = u32(e + 8);
            if (tag === 0x0202) n = u32(e + 8);
          }
          if (!off || !n || t + off + n > bytes.length) return null;
          return { offset: t + off, length: n };
        }
        o += 2 + len;
      }
      return null;
    } catch (e) { return null; }
  }

  const srgb = (v) => {
    const c = Math.min(1, Math.max(0, v));
    return 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
  };

  // `readPair(y)`: rows y and y+1 of the CFA plane (y even), as a Uint16Array.
  function dngDecimate(meta, readPair, size) {
    const w = meta.width, h = meta.height, long = size || SIZE;
    const step = 2 * Math.max(1, Math.ceil(Math.max(w, h) / (2 * long)));
    const ow = Math.max(1, Math.floor(w / step)), oh = Math.max(1, Math.floor(h / step));
    const rgba = new Uint8ClampedArray(ow * oh * 4);
    const span = Math.max(1, meta.whiteLevel - meta.blackLevel);
    const n = meta.asShotNeutral;
    const gain = [1 / n[0], 1 / n[1], 1 / n[2]];
    const gmax = Math.max(gain[0], gain[1], gain[2]);
    for (let c = 0; c < 3; c++) gain[c] /= gmax;
    // cfaPattern: the colour (0 R, 1 G, 2 B) at (0,0), (1,0), (0,1), (1,1).
    const cfa = meta.cfaPattern;
    for (let oy = 0; oy < oh; oy++) {
      const rows = readPair(oy * step);
      for (let ox = 0; ox < ow; ox++) {
        const x = ox * step;
        const sum = [0, 0, 0], cnt = [0, 0, 0];
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
          const c = cfa[dy * 2 + dx];
          sum[c] += (rows[dy * w + x + dx] - meta.blackLevel) / span;
          cnt[c]++;
        }
        const i = (oy * ow + ox) * 4;
        for (let c = 0; c < 3; c++) rgba[i + c] = srgb(cnt[c] ? (sum[c] / cnt[c]) * gain[c] : 0);
        rgba[i + 3] = 255;
      }
    }
    return { width: ow, height: oh, rgba };
  }

  // -- Browser only ---------------------------------------------------------
  const HEAD = 1 << 18;   // an .insp's Exif thumbnail sits in its first 256 KB

  async function bytesOf(file, start, end) {
    return new Uint8Array(await file.slice(start, end).arrayBuffer());
  }

  function canvasBlob(width, height, draw) {
    const c = document.createElement('canvas');
    c.width = width; c.height = height;
    draw(c.getContext('2d'));
    return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('thumbnail encode failed'))), 'image/jpeg', 0.85));
  }

  async function quickJpeg(file) {
    const head = await bytesOf(file, 0, HEAD);
    const t = exifThumbnail(head);
    const src = t ? new Blob([head.subarray(t.offset, t.offset + t.length)], { type: 'image/jpeg' })
      : file.slice(0, file.size, 'image/jpeg');
    const bmp = await createImageBitmap(src, { resizeWidth: SIZE * 2, resizeQuality: 'medium' });
    try {
      const s = Math.min(1, (SIZE * 2) / Math.max(bmp.width, bmp.height));
      return await canvasBlob(Math.round(bmp.width * s), Math.round(bmp.height * s),
        (g) => g.drawImage(bmp, 0, 0, Math.round(bmp.width * s), Math.round(bmp.height * s)));
    } finally { bmp.close(); }
  }

  // The DNG header and IFDs, without reading the 37 MB plane: a zero-filled
  // buffer the size of the file (untouched pages cost nothing), with the
  // first 64 KB and the IFD region copied in, is enough for Dng.parse.
  // Falls back to the whole file when that does not parse.
  async function dngMeta(file) {
    const first = await bytesOf(file, 0, Math.min(file.size, 1 << 16));
    const le = first[0] === 0x49;
    const ifd0 = le ? (first[4] | (first[5] << 8) | (first[6] << 16) | (first[7] << 24)) >>> 0
      : ((first[4] << 24) | (first[5] << 16) | (first[6] << 8) | first[7]) >>> 0;
    const sparse = new Uint8Array(file.size);
    sparse.set(first, 0);
    if (ifd0 >= first.length) {
      const tailEnd = Math.min(file.size, ifd0 + (1 << 20));
      sparse.set(await bytesOf(file, ifd0, tailEnd), ifd0);
    }
    let meta = globalThis.Dng.parse(sparse);
    if (!meta) meta = globalThis.Dng.parse(new Uint8Array(await file.arrayBuffer()));
    return meta;
  }

  async function quickDng(file) {
    const meta = await dngMeta(file);
    if (!meta) throw new Error('not a supported DNG');
    const rowBytes = meta.width * 2;
    const step = 2 * Math.max(1, Math.ceil(Math.max(meta.width, meta.height) / (2 * SIZE)));
    const pairs = new Map();
    const oh = Math.floor(meta.height / step);
    await Promise.all(Array.from({ length: oh }, async (_, oy) => {
      const y = oy * step;
      const b = await bytesOf(file, meta.stripOffset + y * rowBytes, meta.stripOffset + (y + 2) * rowBytes);
      const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
      const u = new Uint16Array(meta.width * 2);
      for (let i = 0; i < u.length; i++) u[i] = dv.getUint16(i * 2, meta.littleEndian);
      pairs.set(y, u);
    }));
    const out = dngDecimate(meta, (y) => pairs.get(y));
    return canvasBlob(out.width, out.height, (g) => g.putImageData(new ImageData(out.rgba, out.width, out.height), 0, 0));
  }

  function quick(file) {
    return /\.dng$/i.test(file.name) ? quickDng(file) : quickJpeg(file);
  }

  // A DNG's header (Dng.parse) without reading its plane, or null.
  async function dngHeader(file) {
    try { return await dngMeta(file); } catch (e) { return null; }
  }

  return { SIZE, exifThumbnail, dngDecimate, quick, dngHeader };
});
