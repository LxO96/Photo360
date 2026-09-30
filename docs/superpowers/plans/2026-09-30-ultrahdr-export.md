# Ultra HDR Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Export raw photos as Ultra HDR JPEG (today's JPEG + a gain map with Ultra HDR v1.1 and ISO 21496-1 metadata) so HDR screens show the compressed highlights brighter.

**Architecture:** `Edge.toneGain` (JS reference) ⇄ `toneGain` in TONE_GLSL define the per-pixel gain. The composite shader gets a gain mode (`uGainOut`) that writes `log2(gain)` into a half-float target at a quarter of the export size. `ultrahdr.js` (pure, UMD) turns log-gains into 8-bit recovery, builds XMP / ISO 21496-1 / MPF segments and assembles the file. `app.js` adds the Ultra HDR format and HDR headroom to the Output panel and runs the two renders on export.

**Tech Stack:** Plain browser JS (UMD, no build), WebGL2, node:test (`npm test`), headless Chrome via scratchpad `cdp.py` + `nocache.py` (serve the repo on 8766).

**Spec:** `docs/superpowers/specs/2026-09-30-ultrahdr-export-design.md`

## Global Constraints

- `Testfiles/` read-only. Commit only when the user asks; trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` / `Claude-Session: https://claude.ai/code/session_01NAsU7VqpR8gJ3VXdXEEAus`. Branch `feature/ultrahdr` from `feature/hdr-merge`.
- Gain: `b = clamp(Yscene / Ysdr, 1, D)`, `w = smoothstep(0.6, 0.9, lsdr)`, `gain = b^w`; `D = 2^headroom`, headroom ∈ {1, 2, 3} stops, default 2. Rim glow not boosted (gain from the tone step only).
- File: offsets `OffsetSDR = OffsetHDR = 1/64`, `GainMapMin = 0`, `GainMapMax = max(log2 gain in the map, 1/64)`, `Gamma = 1`, `HDRCapacityMin = 0`, `HDRCapacityMax = GainMapMax`, `BaseRenditionIsHDR = False`; recovery `round(clamp((log2(pixel_gain) − min)/(max − min), 0, 1)·255)` with `pixel_gain = (Ysdr·gain + 1/64) / (Ysdr + 1/64)`.
- Gain map: ¼ width and height of the export, JPEG quality 85, grey (R = G = B).
- Primary segment order (libultrahdr): EXIF → XMP → ISO version-only → MPF → rest (DQT/SOF/…/SOS). Gain map: SOI → XMP → ISO full → rest.
- ISO 21496-1: APP2, namespace `urn:iso:std:iso:ts:21496:-1` + NUL; all integers big-endian; primary payload = u16 min_version 0, u16 writer_version 0; gain map payload = versions, u8 flags (0: single channel, base colour space not used), u32 base_hdr_headroom N/D (0/1), u32 alternate_hdr_headroom N/D (= GainMapMax, log2), then per channel (1): s32/u32 gain_map_min, s32/u32 gain_map_max, u32/u32 gamma, s32/u32 base_offset, s32/u32 alternate_offset. Fractions with denominator 100000.
- MPF (CIPA DC-007): APP2 `MPF\0`, big-endian TIFF header `MM 00 2A 00 00 00 08`, index IFD of 3 entries (0xB000 MPFVersion UNDEFINED 4 "0100"; 0xB001 NumberOfImages LONG 1 = 2; 0xB002 MPEntry UNDEFINED 32 → offset), next-IFD 0, then two 16-byte MP entries: (attribute 0x00030000, size = primary length, offset 0, 0, 0) and (attribute 0x00000000, size = gain length, offset = gain SOI − MPF TIFF header start, 0, 0).
- Ordinary exports (JPEG/PNG/DNG) unchanged; ordinary tone unchanged (gain pass is a separate mode).

## Review Focus

1. Unedited ordinary DNG: gain must be 1 almost everywhere (no invented light) → Task 1 test "an unedited pixel has gain 1" and Task 5 headless "unedited _020 mean recovery ≈ 0".
2. A JPEG/.insp source with Ultra HDR chosen must export a plain JPEG, not fail → Task 4 step (effectiveFormat) and Task 5 headless step.
3. MPF offset must land exactly on the gain map's SOI in the final bytes (off-by-8 is the classic bug) → Task 2 test "MPF offset lands on the gain map SOI".
4. Mono (B&W) photos: gain from luminance still valid, no colour → Task 1 test with a grey pixel; nothing extra.
5. Export N with Ultra HDR over mixed sources → Task 5 headless step.

---

### Task 1: `Edge.toneGain` and its GLSL twin

**Files:** Modify `edge.js`, `shaders.js` (TONE_GLSL `toneGain`; TONE_PARITY_FS gain mode), `app.js` (`checkGainParity`); Test `test/tone.test.js`.

**Interfaces:** `Edge.toneGain(rgb, tone, coef, rawMax, D) -> number` (≥ 1, ≤ D); GLSL `float toneGain(vec3 rgb, vec3 tone, vec4 curve, vec2 coef, float rawMax, float D)`; `App.checkGainParity() -> { maxDiff }`.

- [ ] **Step 1: failing tests** (append to `test/tone.test.js`):

```js
const ZT = { exposureEv: 0, contrast: 0, saturation: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0 };

test('toneGain: an unedited pixel has gain 1', () => {
  for (const v of [0.1, 0.5, 0.9, 1]) assert.strictEqual(Edge.toneGain([v, v, v], ZT, undefined, 1, 4), 1);
});

test('toneGain: mid-tones stay 1 even when highlights were pulled down', () => {
  const t = { ...ZT, highlights: -80 };
  assert.strictEqual(Edge.toneGain([0.4, 0.4, 0.4], t, undefined, 1, 4), 1);
});

test('toneGain: a compressed highlight gets back its real ratio, capped at D', () => {
  const t = { ...ZT, highlights: -80 };
  const rgb = [0.95, 0.95, 0.95];
  const sdr = Edge.applyTone(rgb, t)[0];
  const ratio = Edge.srgbDecode(0.95) / Edge.srgbDecode(sdr);
  const w = (x) => { const k = Math.min(1, Math.max(0, (x - 0.6) / 0.3)); return k * k * (3 - 2 * k); };
  const g = Edge.toneGain(rgb, t, undefined, 1, 4);
  assert.ok(Math.abs(g - Math.pow(Math.min(4, ratio), w(sdr))) < 1e-9, g);
  assert.ok(g > 1.05, 'visible boost ' + g);
});

test('toneGain: a merged photo highlight is capped at D', () => {
  const enc = Edge.srgbEncode(8);                          // 8x white in an hdrMax-16 photo
  assert.ok(Math.abs(Edge.toneGain([enc, enc, enc], ZT, undefined, 16, 4) - 4) < 1e-9);
  assert.ok(Math.abs(Edge.toneGain([enc, enc, enc], ZT, undefined, 16, 2) - 2) < 1e-9);
});
```
- [ ] **Step 2:** `npm test` → fail (`toneGain` undefined).
- [ ] **Step 3: implement** in `edge.js` (export it):

```js
  // Ultra HDR (ultrahdr.js): how much brighter an HDR screen may show this
  // pixel than the SDR picture -- the light the edit compressed (scene
  // luminance after Exposure over the toned luminance), at least 1, at most
  // D, faded in over the bright tones so mid-tones and faces stay the SDR
  // picture exactly.
  const GAIN_FROM = 0.6, GAIN_FULL = 0.9;
  function toneGain(rgb, tone, coef, rawMax, D) {
    const g = Math.pow(2, tone.exposureEv);
    const yScene = lumaOf([srgbDecode(rgb[0] * g), srgbDecode(rgb[1] * g), srgbDecode(rgb[2] * g)]);
    const out = applyTone(rgb, tone, coef, rawMax);
    const ySdr = lumaOf([srgbDecode(out[0]), srgbDecode(out[1]), srgbDecode(out[2])]);
    const b = Math.min(D, Math.max(1, yScene / Math.max(ySdr, 1e-6)));
    const k = Math.min(1, Math.max(0, (srgbEncode(ySdr) - GAIN_FROM) / (GAIN_FULL - GAIN_FROM)));
    return Math.pow(b, k * k * (3 - 2 * k));
  }
```
  (`lumaOf`, `srgbDecode`, `srgbEncode` already exist in edge.js; if `srgbDecode` of a value > 1 is used elsewhere confirm it doesn't clamp.)
- [ ] **Step 4:** GLSL twin in TONE_GLSL, right after `applyTone`:

```glsl
  float toneGain(vec3 rgb, vec3 tone, vec4 curve, vec2 coef, float rawMax, float D) {
    float g = pow(2.0, tone.x);
    float yScene = dot(srgbDecode3(rgb * g), TONE_LUMA);
    vec3 outc = applyTone(rgb, tone, curve, coef, rawMax);
    float ySdr = dot(srgbDecode3(outc), TONE_LUMA);
    float b = clamp(yScene / max(ySdr, 1e-6), 1.0, D);
    return pow(b, smoothstep(0.6, 0.9, srgbEncode1(ySdr)));
  }
```
  `TONE_PARITY_FS`: add `uniform float uGainOut; uniform float uGainD;` and, when `uGainOut > 0.5`, write `vec4(toneGain(rgb, uTone, uToneCurve, coef, uRawMax, uGainD), 0.0, 0.0, 1.0)`.
- [ ] **Step 5:** `app.js` `checkGainParity()` modelled on `checkToneParity`: same program/target/cases, loops `rawMax ∈ {1, 4, 16}`, `D ∈ {2, 4, 8}`, `local ∈ {false, true}`, `uGainOut = 1`, compares `out[x*4]` with `Edge.toneGain(input, t, coef, rawMax, D)`; returns max diff; logs `(OK, below 1e-3)` / FAIL. Export in `window.App`.
- [ ] **Step 6:** `npm test` pass; headless `App.checkGainParity().maxDiff < 1e-3` and `App.checkToneParity().maxDiff < 5e-4` (tone unchanged).

---

### Task 2: `ultrahdr.js` — recovery maths, segments, assemble, parse

**Files:** Create `ultrahdr.js`; Test `test/ultrahdr.test.js`.

**Interfaces (global `UltraHdr`):**
- `OFFSET = 1/64`
- `recoveryBytes(logGain: Float32Array) -> { bytes: Uint8Array, maxLog }` — `logGain` is already `log2(pixel_gain)` with the offsets applied (the GPU pass writes it, Task 3); `maxLog = max(max logGain, 1/64)`. (Tests pass a second `null` argument; it is ignored.)
- `logGainOf(byte, maxLog) -> number` (decode, GainMapMin 0, gamma 1).
- `primaryXmp(gainLength) -> Uint8Array` (full APP1 segment incl. marker/length), `gainXmp(maxLog) -> Uint8Array`, `isoPrimary() -> Uint8Array`, `isoGainMap(maxLog) -> Uint8Array`, `mpf(primaryLength, gainLength, gainOffset) -> Uint8Array` (APP2 segment, 2 + 2 + 4 + 8 + 2 + 3·12 + 4 + 32 = 90 bytes total).
- `assemble(primary: Uint8Array, gain: Uint8Array, maxLog) -> Uint8Array`.
- `parse(bytes) -> { primaryLength, gainOffset, gainLength, primaryXmp: string, gainXmp: string, iso: { primary: bool, gain: { flags, baseHeadroom, altHeadroom, min, max, gamma, baseOffset, altOffset } } | null, mpfEntries: [{attr, size, offset}] }`.

- [ ] **Step 1: failing tests** — `test/ultrahdr.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const U = require('../ultrahdr.js');

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
```
- [ ] **Step 2:** fail (module missing).
- [ ] **Step 3: implement `ultrahdr.js`** (UMD like the others):
  - `recoveryBytes(logGain)`: `maxLog = Math.max(1/64, max(logGain))`; for each `lg`, since `GainMapMin = 0` and the gain was defined on luminance with the offsets applied the spec way — `pixel_gain = (Ysdr·gain + 1/64)/(Ysdr + 1/64)` — the plan simplifies to `log_recovery = clamp(lg / maxLog, 0, 1)` when `ySdr` is null (offsets negligible for highlights, where gain > 1). **Ruling in plan:** the renderer bakes the offsets in by writing `log2((Ysdr·gain + 1/64)/(Ysdr + 1/64))` from the GPU (Task 3), so `recoveryBytes` never needs `ySdr`; keep the parameter out of the API (signature `recoveryBytes(logGain)`). `bytes[i] = Math.round(clamp01(lg / maxLog) * 255)`.
  - `logGainOf(b, maxLog) = b / 255 * maxLog`.
  - Segment helpers: `app(marker, payloadBytes)` → `[0xFF, marker, len>>8, len&255, ...payload]` with `len = payload.length + 2`; XMP payload = `"http://ns.adobe.com/xap/1.0/\0"` + packet (UTF-8). Primary packet (from the spec's example, `rdf:Description rdf:about=""`, attributes `hdrgm:Version="1.0"`, Container/Item namespaces, two items, second with `Item:Length`). Gain packet with `hdrgm:Version="1.0" GainMapMin="0" GainMapMax="<maxLog>" Gamma="1" OffsetSDR="0.015625" OffsetHDR="0.015625" HDRCapacityMin="0" HDRCapacityMax="<maxLog>" BaseRenditionIsHDR="False"`. Numbers written with `String(+x.toFixed(6))`.
  - ISO: payload = `"urn:iso:std:iso:ts:21496:-1\0"` + bytes as in Global Constraints; fraction helper `frac(x) = [Math.round(x * 100000), 100000]`.
  - MPF: build per Global Constraints; `gainOffset` is relative to the TIFF header start (4 bytes after the APP2 length field + 4 bytes "MPF\0").
  - `assemble(primary, gain, maxLog)`:
    1. `gainFile` = gain's SOI + `gainXmp(maxLog)` + `isoGainMap(maxLog)` + gain after its SOI.
    2. Insertion point `ins` in `primary` = offset of the first marker after SOI that is not APPn (0xE0–0xEF); walk segments by length.
    3. `xmp = primaryXmp(gainFile.length)`, `iso = isoPrimary()`, MPF size fixed (90). `primaryLength = primary.length + xmp.length + iso.length + 90`. MPF TIFF header starts at `ins + xmp.length + iso.length + 8`; `gainOffset = primaryLength − thatStart`.
    4. Output `primary[0:ins] + xmp + iso + mpf(primaryLength, gainFile.length, gainOffset) + primary[ins:] + gainFile`.
  - `parse(bytes)`: walk primary segments collecting XMP text (APP1 starting with the xap namespace), ISO APP2 (namespace), MPF APP2; decode MPF entries (big-endian); `gainOffset = mpfTiffStart + entry[1].offset`; parse the gain file's XMP and ISO similarly; ISO fractions back to floats.
- [ ] **Step 4:** `npm test` pass.

---

### Task 3: Gain pass on the GPU

**Files:** Modify `shaders.js` (COMPOSITE_FS gain mode), `gl.js` (uniforms), Test `test/tone.test.js` (source check).

**Interfaces:** `state.gainOut: true` + `state.gainD: number` on a render state make `GL.renderComposition` write, per photo pixel, `r = log2((Ysdr·gain + 1/64) / (Ysdr + 1/64))` (0 outside the photo) — into whatever target it is given (a half-float target from `GL.makeFloatExportTarget(gl, w, h, false)`).

- [ ] **Step 1: failing test**:

```js
test('the composite has a gain mode writing the offset log-gain', () => {
  const S = require('../shaders.js');
  for (const n of ['COMPOSITE_FS', 'COMPOSITE_RAW_FS', 'COMPOSITE_RAW_F_FS']) {
    assert.match(S[n], /uniform float uGainOut;/, n);
    assert.match(S[n], /toneGain\(img0, uTone, uToneCurve, toneCoef, uRawMax, uGainD\)/, n);
  }
});
```
- [ ] **Step 2:** fail.
- [ ] **Step 3: implement** — COMPOSITE_FS: declare `uniform float uGainOut; uniform float uGainD;`; in `main`, keep the pre-tone pixel `vec3 img0 = img;` right before `img = applyTone(...)`; after computing `img` (still inside `if (u < 1.0)`) and before the terminator:

```glsl
      if (uGainOut > 0.5) {
        float gn = toneGain(img0, uTone, uToneCurve, toneCoef, uRawMax, uGainD);
        float ys = dot(srgbDecode3(img), TONE_LUMA);
        fragColor = vec4(log2((ys * gn + 0.015625) / (ys + 0.015625)), 0.0, 0.0, 1.0);
        return;
      }
```
  and, before `vec3 outColor`, `if (uGainOut > 0.5) { fragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }` (outside the photo). The raw variants inherit it (toRawVariant / toFloatRaw). `gl.js` composite uniforms: `gl.uniform1f(u('uGainOut'), state.gainOut ? 1 : 0); gl.uniform1f(u('uGainD'), state.gainD || 1);`.
- [ ] **Step 4:** `npm test` pass; headless: with `_020` open, render the gain pass at 256 px with `{ gainOut: true, gainD: 4 }` and tone `{highlights: -80}` → max value > 0.05 and centre-of-face region ≈ 0; with default tone → max < 0.01 (unedited: no boost). Also `App.checkToneParity()` unchanged.

---

### Task 4: Output panel and export

**Files:** Modify `index.html` (format option, headroom row), `app.js` (state, controls, `updateExportLabel`, `effectiveFormat`, `exportImage` Ultra HDR branch, `exportSelected`), `index.html` script `ultrahdr.js` before `app.js`.

**Interfaces:** `state.format` may be `'uhdr'`; `state.hdrHeadroom` ∈ {1, 2, 3} (default 2, not persisted, like `format`/`quality`). `exportImage({ format: 'uhdr', quality, padToSensorSquare, hdrHeadroom })` returns true when written.

- [ ] **Step 1: markup** — Output format select: add `<option value="uhdr">Ultra HDR JPEG</option>` after JPEG (read the existing select in index.html and match its option markup). A row after the quality row:

```html
        <div id="hdrHeadroomRow" class="row sel hidden"><label for="hdrHeadroom">HDR headroom</label>
          <select id="hdrHeadroom" title="How much brighter than white HDR screens may show the highlights">
            <option value="1">1 stop (2×)</option>
            <option value="2" selected>2 stops (4×)</option>
            <option value="3">3 stops (8×)</option>
          </select></div>
```
- [ ] **Step 2: app.js**
  - `state.hdrHeadroom: 2` in the state object.
  - `effectiveFormat()`: `if (state.format === 'uhdr' && !state.isRaw) return 'jpeg';` before the DNG rule.
  - `updateExportLabel()`: `uhdrOpt.disabled = !state.isRaw;` `uhdrOpt.title` explaining raw only; label `{ png: 'Export PNG', dng: 'Export DNG', uhdr: 'Export Ultra HDR' }[fmt] || 'Export JPEG'`; `qualityEl.disabled = fmt !== 'jpeg' && fmt !== 'uhdr'`; `hdrHeadroomRow.classList.toggle('hidden', fmt !== 'uhdr')`.
  - `hdrHeadroomEl` input → `state.hdrHeadroom = Number(value)`.
  - Export click passes `hdrHeadroom: state.hdrHeadroom`; `exportSelected` opts too, and its per-photo format rule becomes `const f = opts.format === 'dng' && (!state.isRaw || isMergedHdr()) ? 'jpeg' : opts.format === 'uhdr' && !state.isRaw ? 'jpeg' : opts.format;`.
  - `exportImage`: after the JPEG blob path produces `out` (EXIF reattached) — only when `opts.format === 'uhdr'` encode as JPEG (`toBlob('image/jpeg', quality)` exactly like the JPEG branch; treat 'uhdr' like 'jpeg' for the SDR encode and EXIF), then:

```js
      if (opts.format === 'uhdr') {
        const gw = Math.max(1, Math.round(g.width / 4)), gh = Math.max(1, Math.round(g.height / 4));
        const t = GL.makeFloatExportTarget(ctx.gl, gw, gh, false);
        const logGain = new Float32Array(gw * gh);
        try {
          GL.renderComposition(ctx, Object.assign({}, exportState, { gainOut: true, gainD: Math.pow(2, opts.hdrHeadroom || 2) }), gw, gh, t.fbo);
          GL.readCompositionStripsFloat(ctx.gl, t.fbo, gw, gh, gh, (rows, y) => {
            for (let i = 0; i < rows.length / 4; i++) logGain[y * gw + i] = rows[i * 4];
          });
        } finally { GL.deleteExportTarget(ctx.gl, t); }
        const rec = UltraHdr.recoveryBytes(logGain);
        const gc = document.createElement('canvas'); gc.width = gw; gc.height = gh;
        const im = new ImageData(gw, gh);
        for (let i = 0; i < gw * gh; i++) { const v = rec.bytes[i]; im.data.set([v, v, v, 255], i * 4); }
        gc.getContext('2d').putImageData(im, 0, 0);
        const gb = await new Promise((res) => gc.toBlob(res, 'image/jpeg', 0.85));
        if (!gb) throw new Error('TOBLOB_FAILED');
        out = UltraHdr.assemble(out, new Uint8Array(await gb.arrayBuffer()), rec.maxLog);
      }
```
    (`out` must become `let`; `readCompositionStripsFloat` calls back with rows *already flipped* to top-first — confirm the row index math from its code: `onStrip(view, outY, rows)`; loop `for (let r = 0; r < rowsN; r++) for (let x = 0; x < gw; x++) logGain[(y + r) * gw + x] = rows[(r * gw + x) * 4]`.) The download name uses `'jpg'` for `'uhdr'`.
  - `window.App`: nothing new needed (exportImage already exported).
- [ ] **Step 3:** `npm test` pass (no unit change); headless in Task 5.

---

### Task 5: Headless end to end, README

- [ ] **Headless `uhdr_check`** (scratchpad): capture downloads by patching `HTMLAnchorElement.prototype.click` to store `this.href` blobs (`fetch(href).then(r => r.arrayBuffer())` before revoke — patch `URL.revokeObjectURL` to a no-op in the test). Steps:
  1. Open `_020`; `App.state.tone.highlights = -60` via the slider; `App.exportImage({ format: 'uhdr', quality: 90, padToSensorSquare: false, hdrHeadroom: 2 })` → true; parse the bytes in page with `UltraHdr.parse` (loaded as a script) → gain map found, `GainMapMax` > 0.1; `createImageBitmap(new Blob([bytes]))` succeeds with the export's size; decode the gain map JPEG (`createImageBitmap` of the slice) and check the sky region is brighter than the face region.
  2. Unedited `_020` (reset tone) → `GainMapMax` < 0.05 (no invented light).
  3. Add `_019` + `_020`, merge, export Ultra HDR → `GainMapMax` ≈ 2 (headroom cap reached in the recovered sky).
  4. Open `Sunscreen.insp`, format Ultra HDR shown disabled, export → a plain JPEG (no MPF).
  5. Export N over [merged, Sunscreen] with Ultra HDR chosen → two downloads, first has a gain map, second not.
  6. `App.checkGainParity()` < 1e-3, `App.checkToneParity()` < 5e-4, `App.checkFloatRawParity()` < 1e-3; strip1–4 and hdr1 still pass.
  7. Save one merged Ultra HDR file to `scratchpad/uhdr_merged.jpg` (write the bytes via a `{"js": …}` step returning base64, decoded by a small python helper) for the user to try on their phone.
- [ ] **README:** in Output, "Ultra HDR JPEG" (raw photos): what it is, HDR headroom, what brightens and what doesn't, where it shows as HDR (Android 14+, Chrome/Edge on HDR screens, iOS 18 / macOS 15), plain JPEG elsewhere; JPEG/.insp sources export plain JPEG.
- [ ] `npm test` all pass; commit when the user asks: `feat: Ultra HDR JPEG export -- gain map from the compressed highlights`.
