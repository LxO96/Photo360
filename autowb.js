(function (root, factory) {
  'use strict';
  const api = factory(typeof module !== 'undefined' && module.exports ? require('./wb.js') : root.Wb);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AutoWb = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Wb) {
  'use strict';

  // Auto white balance for raw files: the camera-space neutral of the
  // light, from the raw sensor data itself (so the current white balance,
  // tone and detail play no part), as a Kelvin / tint pair.
  //
  // Samples are 2 x 2 Bayer cells (R, mean G, B, linear 0..1) inside the
  // photo only -- the lens circle out to the Edge falloff start -- leaving
  // out clipped cells (a channel at white is no longer its colour) and
  // near-black ones (all noise).
  //
  // The estimate is by grey pixels: start from the camera's as-shot
  // neutral (or, without one, a shades-of-grey average -- a p-norm mean
  // leaning on the brighter samples), then keep only the samples that
  // come out near neutral under the current estimate and re-average them,
  // narrowing the tolerance each round. Starting from the camera keeps a
  // big blue sky, which is well off grey under it, out of the average;
  // starting from an average of everything let the sky in as "grey" and
  // warmed every outdoor test file. A large coloured
  // area (a lawn, the sea) has no near-grey samples, so it cannot drag
  // the result the way a plain average of everything would. With too few
  // grey samples it keeps the shades-of-grey answer. Last, the tint is
  // held to within TINT_LIMIT of the camera's own as-shot tint -- where
  // this sensor's greys sit, which a DNG's single ColorMatrix1 does not
  // put on the daylight locus (the ONE X files read about +75) -- and the
  // Kelvin to the slider's range, so a scene with no neutral in it can't
  // land on a strong green or magenta cast.
  const MAX_CELLS = 400;          // per side: the grid is subsampled to this
  const CLIP = 0.97;              // of the white level
  const DARK = 0.02;              // brightest channel below this: noise
  const SOG_P = 6;
  const ROUNDS = [0.15, 0.11, 0.08, 0.06];   // |log chroma| tolerance per round
  const MIN_GREY = 0.02;          // share of samples that must be near grey
  const TINT_LIMIT = 20;

  // Camera RGB samples of one raw plane. `radius` (px, around the frame
  // centre) bounds the photo area.
  function sample(plane, w, h, cfa, black, white, radius) {
    const range = white - black;
    const step = Math.max(1, Math.floor(Math.max(w, h) / 2 / MAX_CELLS)) * 2;
    const cx = w / 2, cy = h / 2, r2 = radius * radius;
    const out = [];
    for (let y = 0; y + 1 < h; y += step) {
      for (let x = 0; x + 1 < w; x += step) {
        const dx = x + 1 - cx, dy = y + 1 - cy;
        if (dx * dx + dy * dy > r2) continue;
        const c = [0, 0, 0], n = [0, 0, 0];
        let clipped = false;
        for (let j = 0; j < 2; j++) {
          for (let i = 0; i < 2; i++) {
            const v = (plane[(y + j) * w + x + i] - black) / range;
            if (v >= CLIP) clipped = true;
            const ch = cfa[j * 2 + i];
            c[ch] += v; n[ch]++;
          }
        }
        if (clipped) continue;
        const rgb = [c[0] / n[0], c[1] / n[1], c[2] / n[2]];
        if (Math.max(rgb[0], rgb[1], rgb[2]) < DARK || Math.min(rgb[0], rgb[1], rgb[2]) <= 0) continue;
        out.push(rgb);
      }
    }
    return out;
  }

  // Shades of grey: the p-norm mean per channel, as a neutral (green 1).
  function shadesOfGrey(samples) {
    const s = [0, 0, 0];
    for (const c of samples) for (let k = 0; k < 3; k++) s[k] += Math.pow(c[k], SOG_P);
    const m = s.map((v) => Math.pow(v / samples.length, 1 / SOG_P));
    return [m[0] / m[1], 1, m[2] / m[1]];
  }

  // The neutral (camera RGB, green 1) of `samples`, or null if none,
  // starting from `start` (the as-shot neutral) when given.
  // Returns { neutral, grey (share of samples used), method }.
  function estimate(samples, start) {
    if (!samples.length) return null;
    let n = start ? [start[0] / start[1], 1, start[2] / start[1]] : shadesOfGrey(samples);
    let method = start ? 'as shot' : 'shades-of-grey', grey = 1;
    for (const tol of ROUNDS) {
      const sum = [0, 0, 0];
      let used = 0;
      for (const c of samples) {
        const rg = Math.log((c[0] / n[0]) / c[1]), bg = Math.log((c[2] / n[2]) / c[1]);
        if (rg * rg + bg * bg > tol * tol) continue;
        sum[0] += c[0]; sum[1] += c[1]; sum[2] += c[2];
        used++;
      }
      if (used < MIN_GREY * samples.length) break;
      n = [sum[0] / sum[1], 1, sum[2] / sum[1]];
      grey = used / samples.length;
      method = 'grey pixels';
    }
    return { neutral: n, grey, method };
  }

  // Kelvin / tint for a neutral, the tint held within TINT_LIMIT of
  // `tintCentre` (the as-shot tint; 0 without one) and the Kelvin to the
  // slider range.
  function toKelvinTint(neutral, colorMatrix1, tintCentre) {
    const kt = Wb.kelvinTintFromNeutral(neutral, colorMatrix1);
    const c = tintCentre || 0;
    return {
      kelvin: Math.min(Wb.KELVIN_MAX, Math.max(Wb.KELVIN_MIN, kt.kelvin)),
      tint: Math.min(c + TINT_LIMIT, Math.max(c - TINT_LIMIT, kt.tint)),
      rawTint: kt.tint,
    };
  }

  return { MAX_CELLS, CLIP, DARK, TINT_LIMIT, sample, shadesOfGrey, estimate, toKelvinTint };
});
