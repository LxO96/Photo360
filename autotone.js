(function (root, factory) {
  const api = factory(typeof module !== 'undefined' && module.exports ? require('./edge.js') : root.Edge);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AutoTone = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Edge) {
  'use strict';

  // Auto tone: picks Exposure, Highlights, Shadows, Whites and Blacks from
  // a luma histogram of the photograph as rendered with tone off (display
  // values; bin i of N holds values nearest i / (N - 1), as
  // Scopes.histogram bins them). The caller builds that histogram from
  // photo pixels only -- inside the circles and the Edge falloff start --
  // so the black around the circles can't make it brighten.
  //
  // Every step simulates the real tone curve (Edge.applyTone on a grey of
  // that luma), so a target the solver aims for is where the pixel
  // actually lands. Steps, in order:
  //   1. Exposure brings the median to MID_TARGET -- all the way up, but
  //      only EV_SHARE_DOWN of the way (in stops) down: a bright scene
  //      should stay bright, its sky brought back by Highlights, not the
  //      whole picture dimmed -- within +-EV_LIMIT, not raised past the
  //      point where the 99th percentile clips; a change under
  //      EV_DEADBAND is skipped.
  //   2. Highlights pulls the upper tail (90th percentile) down to
  //      HIGH_TARGET, and Shadows lifts the lower tail (10th) to
  //      LOW_TARGET -- the recovery that gives the open, "HDR" look. Since
  //      Highlights and Shadows are local (tonebase.js) they keep texture,
  //      so they can go further than a plain curve could; any tail at all
  //      gets at least HIGH_MIN / SHADOW_MIN.
  //   3. Contrast then puts back the punch the recovery takes out: the
  //      middle half (25th..75th percentile) is spread to IQR_TARGET.
  //   4. Whites and Blacks stretch the 99.5th / 0.5th percentiles out to
  //      near the ends, without clipping more than is already clipped.
  //   5. If all that left the middle darker than it started (up to
  //      KEEP_MAX), exposure brings it back: Auto opens a photo up, it
  //      doesn't dim it.
  // Each slider has a cap short of its range, so Auto stays a starting
  // point rather than a look. Blown pixels are left out of the Highlights
  // decision (see below).
  const MID_TARGET = 0.46;      // display value of ~18% linear grey
  const EV_LIMIT = 2;
  const EV_DEADBAND = 0.15;
  const EV_SHARE_DOWN = 0.25;
  const CLIP_GUARD = 0.98;
  const HIGH_TARGET = 0.8, HIGH_CAP = -70, HIGH_MIN = -20, HIGH_FROM = 0.6;
  const CLIPPED = 0.985;   // a tail this bright is blown; Highlights can only grey it
  const LOW_TARGET = 0.17, SHADOW_CAP = 60, SHADOW_MIN = 25, SHADOW_FROM = 0.35;
  const IQR_TARGET = 0.32, CONTRAST_MIN = -0.1, CONTRAST_MAX = 0.3;
  // The middle may not end up darker than it was (or than KEEP_MAX).
  const KEEP_MAX = 0.62, KEEP_SLACK = 0.02;
  const WHITE_TARGET = 0.97, WHITE_CAP = 50;
  const BLACK_TARGET = 0.02, BLACK_CAP = -30;

  // The value at fraction p (0..1) of the histogram's mass.
  function percentile(bins, p) {
    let total = 0;
    for (let i = 0; i < bins.length; i++) total += bins[i];
    if (!total) return null;
    const want = p * total;
    let acc = 0;
    for (let i = 0; i < bins.length; i++) {
      acc += bins[i];
      if (acc >= want && bins[i]) return i / (bins.length - 1);
    }
    return 1;
  }

  // The histogram without its clipped top bins.
  function unclipped(bins) {
    const top = Math.floor(CLIPPED * (bins.length - 1));
    return Array.from(bins, (v, i) => (i > top ? 0 : v));
  }

  // Where a grey of lightness y lands with tone t (rawMax: a merged HDR
  // photo's, so the highlight shoulder is simulated too).
  function mapLumaR(y, t, rawMax) {
    const out = Edge.applyTone([y, y, y], t, undefined, rawMax)[0];
    return Math.min(1, Math.max(0, out));
  }

  // The value of `key` in [lo, hi] (monotone effect) that maps y closest
  // to target, by bisection. `increasing`: does raising the value raise
  // the output?
  function solveForR(t, key, y, target, lo, hi, increasing, rawMax) {
    const at = (v) => mapLumaR(y, Object.assign({}, t, { [key]: v }), rawMax);
    let a = lo, b = hi;
    for (let i = 0; i < 40; i++) {
      const m = (a + b) / 2;
      const high = at(m) > target;
      if (high === increasing) b = m; else a = m;
    }
    return (a + b) / 2;
  }

  // opts (a merged HDR photo): { rawMax, scale } -- `bins` hold lightness
  // / scale (scale = srgbEncode(rawMax), so its tone-off frame fits in 8
  // bits); percentiles are read back in the photo's real range, and its
  // top bin is not clipping.
  function solve(bins, opts) {
    const S = (opts && opts.scale) || 1, R = (opts && opts.rawMax) || 1;
    const mapLuma = (y, t) => mapLumaR(y, t, R);
    const solveFor = (t, key, y, target, lo, hi, inc) => solveForR(t, key, y, target, lo, hi, inc, R);
    const pct = (b, q) => { const v = percentile(b, q); return v === null ? null : v * S; };
    const p = (q) => pct(bins, q);
    const median = p(0.5);
    if (median === null) return null;
    const t = {
      exposureEv: 0, contrast: 0, saturation: 0,
      highlights: 0, shadows: 0, whites: 0, blacks: 0,
    };

    // 1. Exposure.
    let ev = Math.log2(MID_TARGET / Math.max(median, 1e-4));
    if (ev < 0) ev *= EV_SHARE_DOWN;
    if (ev > 0 && R <= 1) {   // (with headroom, the shoulder keeps it from clipping)
      const p99 = p(0.99);
      if (p99 > 0) ev = Math.min(ev, Math.max(0, Math.log2(CLIP_GUARD / p99)));
    }
    ev = Math.max(-EV_LIMIT, Math.min(EV_LIMIT, ev));
    // A median already close to the target is left where it is, rather
    // than nudged and then compensated for by the other sliders.
    if (Math.abs(ev) < EV_DEADBAND) ev = 0;
    t.exposureEv = Math.round(ev * 100) / 100;

    // 2. Highlights and shadows.
    // Highlights only for a bright tail that still has detail: in this
    // display-space pipeline a clipped value has none to recover, and
    // pulling it down just turns blown sky grey. The 90th percentile is
    // taken over the unclipped pixels.
    const p90 = pct(S === 1 ? unclipped(bins) : bins, 0.9), p10 = p(0.1);
    const hi = p90 === null ? 0 : mapLuma(p90, t);
    if (hi > HIGH_FROM && hi < CLIPPED) {
      const h = hi > HIGH_TARGET ? solveFor(t, 'highlights', p90, HIGH_TARGET, HIGH_CAP, 0, true) : 0;
      t.highlights = Math.round(Math.min(HIGH_MIN, h));
    }
    const lo = mapLuma(p10, t);
    if (lo < SHADOW_FROM) {
      const s = lo < LOW_TARGET ? solveFor(t, 'shadows', p10, LOW_TARGET, 0, SHADOW_CAP, true) : 0;
      t.shadows = Math.round(Math.max(SHADOW_MIN, s));
    }

    // 3. Contrast: the middle half spread to IQR_TARGET (contrast only
    // widens it, so bisection works).
    const p25 = p(0.25), p75 = p(0.75);
    const iqr = (c) => { const u = Object.assign({}, t, { contrast: c }); return mapLuma(p75, u) - mapLuma(p25, u); };
    if (p75 > p25) {
      let a = CONTRAST_MIN, b = CONTRAST_MAX;
      if (iqr(a) >= IQR_TARGET) t.contrast = a;
      else if (iqr(b) <= IQR_TARGET) t.contrast = b;
      else {
        for (let i = 0; i < 40; i++) { const m = (a + b) / 2; if (iqr(m) > IQR_TARGET) b = m; else a = m; }
        t.contrast = (a + b) / 2;
      }
      t.contrast = Math.round(t.contrast * 100) / 100;
    }

    // 4. Whites and blacks. Only stretch: an end that already reaches
    // (or passes) its target is left alone.
    const p995 = p(0.995), p005 = p(0.005);
    if (mapLuma(p995, t) < WHITE_TARGET) {
      t.whites = Math.round(solveFor(t, 'whites', p995, WHITE_TARGET, 0, WHITE_CAP, true));
    }
    if (mapLuma(p005, t) > BLACK_TARGET) {
      t.blacks = Math.round(solveFor(t, 'blacks', p005, BLACK_TARGET, BLACK_CAP, 0, true));
    }

    // 5. Keep the brightness: if the steps above left the median darker
    // than it started (up to KEEP_MAX), exposure brings it back.
    const keep = Math.min(median, KEEP_MAX) - KEEP_SLACK;
    if (mapLuma(median, t) < keep) {
      t.exposureEv = Math.round(solveFor(t, 'exposureEv', median, keep, t.exposureEv, EV_LIMIT, true) * 100) / 100;
    }

    // Normalise -0 so results compare cleanly.
    return {
      exposureEv: t.exposureEv + 0, contrast: t.contrast + 0, highlights: t.highlights + 0,
      shadows: t.shadows + 0, whites: t.whites + 0, blacks: t.blacks + 0,
    };
  }

  return { solve, percentile, MID_TARGET };
});
