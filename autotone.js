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
  // that luma, with the user's contrast), so a target the solver aims for
  // is where the pixel actually lands. Steps, in order:
  //   1. Exposure brings the median to MID_TARGET, within +-EV_LIMIT, and
  //      is not raised past the point where the 99th percentile clips; a
  //      change under EV_DEADBAND is skipped.
  //   2. Highlights pulls a bright upper tail (90th percentile) down to
  //      HIGH_TARGET; Shadows lifts a dark lower tail (10th) to LOW_TARGET.
  //   3. Whites and Blacks stretch the 99.5th / 0.5th percentiles out to
  //      near the ends, without clipping more than is already clipped.
  // Each slider has a cap well short of its range, so Auto stays a
  // starting point rather than a look. Blown pixels are left out of the
  // Highlights decision (see below).
  const MID_TARGET = 0.46;      // display value of ~18% linear grey
  const EV_LIMIT = 2;
  const EV_DEADBAND = 0.15;
  const CLIP_GUARD = 0.98;
  const HIGH_TARGET = 0.9, HIGH_CAP = -40;
  const CLIPPED = 0.985;   // a tail this bright is blown; Highlights can only grey it
  const LOW_TARGET = 0.09, SHADOW_CAP = 50;
  const WHITE_TARGET = 0.96, WHITE_CAP = 40;
  const BLACK_TARGET = 0.025, BLACK_CAP = -35;

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

  function mapLuma(y, t) {
    const out = Edge.applyTone([y, y, y], t)[0];
    return Math.min(1, Math.max(0, out));
  }

  // The value of `key` in [lo, hi] (monotone effect) that maps y closest
  // to target, by bisection. `increasing`: does raising the value raise
  // the output?
  function solveFor(t, key, y, target, lo, hi, increasing) {
    const at = (v) => mapLuma(y, Object.assign({}, t, { [key]: v }));
    let a = lo, b = hi;
    for (let i = 0; i < 40; i++) {
      const m = (a + b) / 2;
      const high = at(m) > target;
      if (high === increasing) b = m; else a = m;
    }
    return (a + b) / 2;
  }

  function solve(bins, opts) {
    const p = (q) => percentile(bins, q);
    const median = p(0.5);
    if (median === null) return null;
    const t = {
      exposureEv: 0, contrast: (opts && opts.contrast) || 0, saturation: 0,
      highlights: 0, shadows: 0, whites: 0, blacks: 0,
    };

    // 1. Exposure.
    let ev = Math.log2(MID_TARGET / Math.max(median, 1e-4));
    if (ev > 0) {
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
    const p90 = percentile(unclipped(bins), 0.9), p10 = p(0.1);
    const hi = p90 === null ? 0 : mapLuma(p90, t);
    if (hi > HIGH_TARGET && hi < CLIPPED) {
      t.highlights = Math.round(solveFor(t, 'highlights', p90, HIGH_TARGET, HIGH_CAP, 0, true));
    }
    if (mapLuma(p10, t) < LOW_TARGET) {
      t.shadows = Math.round(solveFor(t, 'shadows', p10, LOW_TARGET, 0, SHADOW_CAP, true));
    }

    // 3. Whites and blacks. Only stretch: an end that already reaches
    // (or passes) its target is left alone.
    const p995 = p(0.995), p005 = p(0.005);
    if (mapLuma(p995, t) < WHITE_TARGET) {
      t.whites = Math.round(solveFor(t, 'whites', p995, WHITE_TARGET, 0, WHITE_CAP, true));
    }
    if (mapLuma(p005, t) > BLACK_TARGET) {
      t.blacks = Math.round(solveFor(t, 'blacks', p005, BLACK_TARGET, BLACK_CAP, 0, true));
    }

    // Normalise -0 so results compare cleanly.
    return {
      exposureEv: t.exposureEv + 0, highlights: t.highlights + 0, shadows: t.shadows + 0,
      whites: t.whites + 0, blacks: t.blacks + 0,
    };
  }

  return { solve, percentile, MID_TARGET };
});
