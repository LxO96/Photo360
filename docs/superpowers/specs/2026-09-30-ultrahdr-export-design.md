# Ultra HDR JPEG export — design

Date: 2026-09-30. Sub-project 3 of 3 (1. file strip, 2. bracket merge —
both done; 3. HDR output).

## Goal

Export raw photos as Ultra HDR JPEG: an ordinary JPEG (today's picture)
with a gain map, so phones, Chrome, macOS and iOS show the highlights
brighter on HDR screens, and everything else shows the normal JPEG.

## What the user said / decided

- HDR results are for phone / social viewing. So: Ultra HDR JPEG export
  only — no in-app HDR monitor preview (WebGL can't present
  brighter-than-white; only WebGPU "extended" canvases can) and no
  floating-point DNG. Either can come later.
- Available for all raw photos (single DNGs and merged HDR photos), not
  JPEG/.insp sources.

## The HDR rendition

The SDR picture is exactly today's export. The HDR rendition is defined
per pixel from it, so it never invents light the scene didn't have:

- `Ysdr`: the SDR pixel's linear luminance after tone (what is written
  today, before the rim is added).
- `Yscene`: the same pixel's linear luminance after Exposure but before
  the tone curve, shoulder and final clamp (`srgbDecode(rgb · 2^EV)`
  luminance in `applyTone`) — the light the edit compressed.
- Boost `b = clamp(Yscene / Ysdr, 1, D)`, faded in over the bright tones:
  `w = smoothstep(0.6, 0.9, lsdr)` with `lsdr` the SDR lightness;
  `gain = b^w` (so mid-tones and faces are exactly the SDR picture).
- `D = 2^headroom`, `headroom` the new **HDR headroom** Output setting:
  1, 2 or 3 stops (default 2).
- The rim glow gets no boost: the gain map is computed from the photo
  (tone step) only; where the rim is added, the gain stays that of the
  photo pixel under it (the rim is additive and faint over bright areas).
- What this means per photo: a merged photo's recovered highlights reach
  up to D× brighter than white; a single DNG gains where Highlights,
  Whites, the shoulder or Exposure compressed or clipped light; an
  unedited single DNG looks almost the same.

## The file (Ultra HDR v1.1 + ISO 21496-1)

Following the Android Ultra HDR v1.1 spec
(developer.android.com/media/platform/hdr-image-format):

- Primary JPEG: today's export (EXIF as now) plus
  - APP1 XMP: `hdrgm:Version="1.0"` and a `Container:Directory` with a
    `Primary` item and a `GainMap` item (`Item:Mime="image/jpeg"`,
    `Item:Length` = gain map JPEG bytes);
  - APP2 ISO 21496-1 version-only segment (`urn:iso:std:iso:ts:21496:-1`);
  - APP2 MPF with two entries (primary, gain map) giving the gain map's
    offset.
- Gain map JPEG, appended: single-channel gain (written as a grey JPEG)
  at a quarter of the width and height, quality 85, bilinear
  downsampled, with
  - APP1 XMP: `hdrgm:Version="1.0"`, `GainMapMin=0`,
    `GainMapMax=log2(max gain in the image)` (at most `headroom`),
    `Gamma=1`, `OffsetSDR=OffsetHDR=1/64`, `HDRCapacityMin=0`,
    `HDRCapacityMax=GainMapMax`, `BaseRenditionIsHDR="False"`;
  - APP2 ISO 21496-1 gain map metadata carrying the same values, in the
    binary layout libultrahdr writes (the plan pins the exact bytes).
- Encoding per the spec: `pixel_gain = (Yhdr + 1/64) / (Ysdr + 1/64)`
  with `Yhdr = Ysdr · gain`, `recovery = clamp((log2(pixel_gain) −
  GainMapMin) / (GainMapMax − GainMapMin), 0, 1)`, stored as
  `round(recovery · 255)`.
- A photo whose gain is 1 everywhere (nothing to boost) is still written
  as Ultra HDR with `GainMapMax` = a tiny positive value (valid file, no
  visible change).

## Where it lives

- `ultrahdr.js` (pure, UMD): XMP builders, ISO 21496-1 blocks, MPF
  builder, `assemble(primaryJpeg, gainJpeg, meta) -> Uint8Array`,
  `parse(bytes)` (for tests: finds the gain map through MPF, reads both
  metadata sets), and the gain encode/decode maths.
- GPU: a gain-map pass — the composite shader in a mode that outputs the
  gain's `recovery` value instead of colour, rendered at a quarter of the
  export size (bilinear from a full-size render is not needed: rendering
  the composite at the smaller size samples the lens directly). The JS
  reference of the gain lives in `edge.js` next to `applyTone`
  (`toneGain(rgb, tone, coef, rawMax, D)`), with a parity check like the
  tone one.
- Output panel: Format gains **Ultra HDR JPEG** (raw photos only; hidden
  for JPEG/.insp sources, which fall back to JPEG as DNG does) and, while
  it is chosen, an **HDR headroom** select (1 / 2 / 3 stops). Quality is
  the JPEG quality slider as for JPEG. The file name is the JPEG
  export's (`.jpg`); the gain map is inside the file.
- Export N: an Ultra HDR choice exports raw photos as Ultra HDR and the
  others as plain JPEG.

## Error handling

- Encoding the gain map fails (toBlob null): the export fails with the
  existing message; nothing half-written.
- Very large exports: the gain-map pass is 1/16 of the pixels; no new
  size limit.

## Not included

- In-app HDR preview, float DNG, AVIF/HEIC HDR, per-channel (RGB) gain
  maps, HDR for JPEG/.insp sources.

## Testing

- Unit (node):
  - `toneGain`: 1 for mid-tones (lsdr < 0.6), 1 for an unedited ordinary
    pixel, capped at D, never above `Yscene / Ysdr`; equals the merged
    photo's real ratio for a highlight inside the shoulder;
  - gain encode/decode round trip within 1/255 in log space;
  - `assemble` → `parse`: the MPF offset lands on the gain map's SOI, XMP
    `Item:Length` equals its size, primary and gain map XMP / ISO values
    read back, the primary JPEG before the gain map is byte-identical
    apart from the inserted segments;
  - applying our own gain map (decode formula at full weight) to the SDR
    reproduces `toneGain`'s HDR luminance within 2%.
- GPU parity (headless): gain-map pass vs `Edge.toneGain`, max diff
  < 2/255 in recovery.
- Headless: Ultra HDR export of `_020` and of the merged `_HDR` photo;
  Chrome decodes both (`createImageBitmap`), `parse` finds a gain map
  whose bright-sky mean recovery is higher for the merged photo.
- On a device (user): open the exported files on the phone / an HDR
  screen in Chrome; highlights brighten, mid-tones unchanged.
