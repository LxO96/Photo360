(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.UltraHdr = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Ultra HDR JPEG (Android Ultra HDR v1.1, with ISO 21496-1 metadata as
  // well, which Apple devices read): the SDR JPEG as it is, plus a gain map
  // -- a small grey JPEG of how much brighter each spot may be shown on an
  // HDR screen -- appended as a second image and indexed by MPF. The
  // segment order and the ISO byte layout follow libultrahdr:
  //   primary:  SOI, APP0/EXIF..., XMP, ISO (versions only), MPF, DQT... EOI
  //   gain map: SOI, XMP, ISO (the gain map metadata), then its own data.
  // The gain map holds log2 gain from 0 (GainMapMin) to maxLog
  // (GainMapMax), linearly (Gamma 1), with the spec's 1/64 offsets already
  // in the values the renderer writes (gl.js gain mode).
  const OFFSET = 1 / 64;
  const XMP_NS = 'http://ns.adobe.com/xap/1.0/\0';
  const ISO_NS = 'urn:iso:std:iso:ts:21496:-1\0';
  const DEN = 100000;

  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  const num = (x) => String(+x.toFixed(6));
  const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0) & 255);
  const utf8 = (s) => Array.from(new TextEncoder().encode(s));

  // log2 gains (offsets applied) -> 8-bit recovery values and GainMapMax.
  function recoveryBytes(logGain) {
    let max = 0;
    for (let i = 0; i < logGain.length; i++) if (logGain[i] > max) max = logGain[i];
    const maxLog = Math.max(OFFSET, max);
    const bytes = new Uint8Array(logGain.length);
    for (let i = 0; i < logGain.length; i++) bytes[i] = Math.round(clamp01(logGain[i] / maxLog) * 255);
    return { bytes, maxLog };
  }
  const logGainOf = (b, maxLog) => b / 255 * maxLog;

  function app(marker, payload) {
    const len = payload.length + 2;
    if (len > 0xffff) throw new Error('segment too long');
    return Uint8Array.from([0xff, marker, len >> 8, len & 255, ...payload]);
  }

  function primaryXmp(gainLength) {
    return app(0xe1, ascii(XMP_NS).concat(utf8(
      '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
      '<rdf:Description rdf:about="" xmlns:Container="http://ns.google.com/photos/1.0/container/" ' +
      'xmlns:Item="http://ns.google.com/photos/1.0/container/item/" ' +
      'xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/" hdrgm:Version="1.0">' +
      '<Container:Directory><rdf:Seq>' +
      '<rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="Primary" Item:Mime="image/jpeg"/></rdf:li>' +
      '<rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="GainMap" Item:Mime="image/jpeg" ' +
      'Item:Length="' + gainLength + '"/></rdf:li>' +
      '</rdf:Seq></Container:Directory></rdf:Description></rdf:RDF></x:xmpmeta>')));
  }

  function gainXmp(maxLog) {
    return app(0xe1, ascii(XMP_NS).concat(utf8(
      '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
      '<rdf:Description rdf:about="" xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/" hdrgm:Version="1.0" ' +
      'hdrgm:GainMapMin="0" hdrgm:GainMapMax="' + num(maxLog) + '" hdrgm:Gamma="1" ' +
      'hdrgm:OffsetSDR="' + num(OFFSET) + '" hdrgm:OffsetHDR="' + num(OFFSET) + '" ' +
      'hdrgm:HDRCapacityMin="0" hdrgm:HDRCapacityMax="' + num(maxLog) + '" ' +
      'hdrgm:BaseRenditionIsHDR="False"/></rdf:RDF></x:xmpmeta>')));
  }

  const u16 = (v) => [(v >>> 8) & 255, v & 255];
  const u32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  const frac = (x) => u32(Math.round(x * DEN) >>> 0).concat(u32(DEN));

  const isoPrimary = () => app(0xe2, ascii(ISO_NS).concat(u16(0), u16(0)));
  function isoGainMap(maxLog) {
    return app(0xe2, ascii(ISO_NS).concat(
      u16(0), u16(0),          // minimum_version, writer_version
      [0],                     // flags: one channel, base colour space not used
      frac(0),                 // base_hdr_headroom (log2): the base is SDR
      frac(maxLog),            // alternate_hdr_headroom (log2)
      frac(0),                 // gain_map_min
      frac(maxLog),            // gain_map_max
      frac(1),                 // gamma
      frac(OFFSET),            // base_offset
      frac(OFFSET)));          // alternate_offset
  }

  // CIPA DC-007 MP index: two entries, the gain map's offset relative to
  // the MPF TIFF header (8 bytes into this segment's payload start).
  const MPF_SIZE = 90;
  function mpf(primaryLength, gainLength, gainOffset) {
    const ifdEntries = 3;
    const entriesAt = 8 + 2 + ifdEntries * 12 + 4;   // from the TIFF header
    const payload = ascii('MPF\0').concat(
      [0x4d, 0x4d, 0x00, 0x2a], u32(8),
      u16(ifdEntries),
      u16(0xb000), u16(7), u32(4), ascii('0100'),
      u16(0xb001), u16(4), u32(1), u32(2),
      u16(0xb002), u16(7), u32(32), u32(entriesAt),
      u32(0),
      u32(0x00030000), u32(primaryLength), u32(0), u16(0), u16(0),
      u32(0x00000000), u32(gainLength), u32(gainOffset), u16(0), u16(0));
    const seg = app(0xe2, payload);
    if (seg.length !== MPF_SIZE) throw new Error('MPF size ' + seg.length);
    return seg;
  }

  // Offset of the first marker after SOI that is not an APPn segment.
  function afterApps(bytes) {
    let o = 2;
    while (o + 4 <= bytes.length && bytes[o] === 0xff && bytes[o + 1] >= 0xe0 && bytes[o + 1] <= 0xef) {
      o += 2 + ((bytes[o + 2] << 8) | bytes[o + 3]);
    }
    return o;
  }

  function concat(parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  function assemble(primary, gain, maxLog) {
    const gainFile = concat([gain.subarray(0, 2), gainXmp(maxLog), isoGainMap(maxLog), gain.subarray(2)]);
    const ins = afterApps(primary);
    const xmp = primaryXmp(gainFile.length), iso = isoPrimary();
    const primaryLength = primary.length + xmp.length + iso.length + MPF_SIZE;
    const tiffStart = ins + xmp.length + iso.length + 8;
    return concat([primary.subarray(0, ins), xmp, iso,
      mpf(primaryLength, gainFile.length, primaryLength - tiffStart),
      primary.subarray(ins), gainFile]);
  }

  // -- Reading one back (tests) ----------------------------------------------
  const startsWith = (b, o, s) => { for (let i = 0; i < s.length; i++) if (b[o + i] !== s.charCodeAt(i)) return false; return true; };
  const rd32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const rd16 = (b, o) => (b[o] << 8) | b[o + 1];

  function segments(bytes, from) {
    const out = [];
    let o = from + 2;
    while (o + 4 <= bytes.length && bytes[o] === 0xff && bytes[o + 1] !== 0xda) {
      const len = rd16(bytes, o + 2);
      out.push({ marker: bytes[o + 1], at: o, body: o + 4, end: o + 2 + len });
      o += 2 + len;
    }
    return out;
  }

  function readIso(b, s) {
    const p = s.body + ISO_NS.length;
    if (s.end - p <= 4) return { versionOnly: true };
    let o = p + 4;
    const flags = b[o++];
    const f = () => { const n = rd32(b, o) | 0, d = rd32(b, o + 4); o += 8; return n / d; };
    return { flags, baseHeadroom: f(), altHeadroom: f(), min: f(), max: f(), gamma: f(), baseOffset: f(), altOffset: f() };
  }

  function parse(bytes) {
    const res = { primaryXmp: '', gainXmp: '', iso: { primary: false, gain: null }, mpfEntries: [] };
    let tiffStart = -1;
    for (const s of segments(bytes, 0)) {
      if (s.marker === 0xe1 && startsWith(bytes, s.body, XMP_NS)) {
        res.primaryXmp = new TextDecoder().decode(bytes.subarray(s.body + XMP_NS.length, s.end));
      } else if (s.marker === 0xe2 && startsWith(bytes, s.body, ISO_NS)) {
        res.iso.primary = !!readIso(bytes, s).versionOnly;
      } else if (s.marker === 0xe2 && startsWith(bytes, s.body, 'MPF\0')) {
        tiffStart = s.body + 4;
        const mpEntry = tiffStart + 8 + 2 + 2 * 12;                  // the third IFD entry (0xB002)
        const n = rd32(bytes, mpEntry + 4);                             // its byte count
        const at = tiffStart + rd32(bytes, mpEntry + 8);
        for (let i = 0; i < n / 16; i++) {
          const e = at + i * 16;
          res.mpfEntries.push({ attr: rd32(bytes, e), size: rd32(bytes, e + 4), offset: rd32(bytes, e + 8) });
        }
      }
    }
    if (tiffStart < 0 || res.mpfEntries.length < 2) return null;
    res.primaryLength = res.mpfEntries[0].size;
    res.gainLength = res.mpfEntries[1].size;
    res.gainOffset = tiffStart + res.mpfEntries[1].offset;
    for (const s of segments(bytes, res.gainOffset)) {
      if (s.marker === 0xe1 && startsWith(bytes, s.body, XMP_NS)) {
        res.gainXmp = new TextDecoder().decode(bytes.subarray(s.body + XMP_NS.length, s.end));
      } else if (s.marker === 0xe2 && startsWith(bytes, s.body, ISO_NS)) {
        res.iso.gain = readIso(bytes, s);
      }
    }
    return res;
  }

  return { OFFSET, recoveryBytes, logGainOf, primaryXmp, gainXmp, isoPrimary, isoGainMap, mpf, assemble, parse };
});
