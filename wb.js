(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Wb = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Pure colour-science maths only: no DOM, no WebGL, no file I/O. Replaces
  // Task 16's raw red/blue multiplier sliders with a classic Kelvin + tint
  // control (Lightroom convention), operating on the same per-lens
  // camera-space neutral triple (green = 1) the shader already consumes --
  // this module only changes *how that triple is produced*, never the
  // shader's own white-balance maths.
  //
  // Colour science, per the task brief:
  //  1. Kelvin -> chromaticity (x, y) on the Planckian locus via the Kim,
  //     Chang, Hong, Lee & Park cubic approximation ("Kim et al." -- the
  //     widely used piecewise-cubic fit to the CIE 1931 blackbody locus),
  //     valid 1667-25000 K.
  //  2. Tint displaces that point perpendicular to the locus in CIE 1960
  //     (u, v), Delta-uv = tint / 3000 (Adobe's scale: +-150 ~= +-0.05 Duv).
  //     Positive tint = magenta, negative = green (Lightroom convention).
  //  3. (x, y) -> XYZ with Y = 1 -> camera neutral = ColorMatrix1 . XYZ
  //     (DNG's ColorMatrix1 maps XYZ -> camera; never inverted for this
  //     direction) -> normalised so green = 1.
  //  4. Inverse: camera neutral -> XYZ via inverse(ColorMatrix1) -> (x, y)
  //     -> nearest (K, tint) via a bounded 1-D search along the locus (in
  //     CIE 1960 uv) plus a perpendicular projection for tint.

  // -- Small 3x3 helpers (row-major, same convention as dng.js) -----------
  function mat3Invert(m) {
    const det = m[0] * (m[4] * m[8] - m[5] * m[7])
      - m[1] * (m[3] * m[8] - m[5] * m[6])
      + m[2] * (m[3] * m[7] - m[4] * m[6]);
    if (Math.abs(det) < 1e-12) return null;
    const invDet = 1 / det;
    return [
      (m[4] * m[8] - m[5] * m[7]) * invDet,
      (m[2] * m[7] - m[1] * m[8]) * invDet,
      (m[1] * m[5] - m[2] * m[4]) * invDet,
      (m[5] * m[6] - m[3] * m[8]) * invDet,
      (m[0] * m[8] - m[2] * m[6]) * invDet,
      (m[2] * m[3] - m[0] * m[5]) * invDet,
      (m[3] * m[7] - m[4] * m[6]) * invDet,
      (m[1] * m[6] - m[0] * m[7]) * invDet,
      (m[0] * m[4] - m[1] * m[3]) * invDet,
    ];
  }

  function mat3MulVec(m, v) {
    return [
      m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
      m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
      m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
    ];
  }

  const IDENTITY3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

  // -- Kelvin -> chromaticity on the Planckian locus -----------------------
  // Kim, Chang, Hong, Lee & Park's cubic approximation (as tabulated on the
  // Planckian-locus reference pages this task's brief points at), valid for
  // 1667 K <= T <= 25000 K. Two x-domains, three y-domains, matching the
  // locus's own inflection near 4000 K/2222 K.
  function kelvinToXyOnLocus(kelvin) {
    const T = Math.max(1667, Math.min(25000, kelvin));
    let x;
    if (T <= 4000) {
      x = -0.2661239e9 / (T * T * T) - 0.2343589e6 / (T * T) + 0.8776956e3 / T + 0.179910;
    } else {
      x = -3.0258469e9 / (T * T * T) + 2.1070379e6 / (T * T) + 0.2226347e3 / T + 0.240390;
    }
    let y;
    if (T <= 2222) {
      y = -1.1063814 * x * x * x - 1.34811020 * x * x + 2.18555832 * x - 0.20219683;
    } else if (T <= 4000) {
      y = -0.9549476 * x * x * x - 1.37418593 * x * x + 2.09137015 * x - 0.16748867;
    } else {
      y = 3.0817580 * x * x * x - 5.87338670 * x * x + 3.75112997 * x - 0.37001483;
    }
    return { x, y };
  }

  // -- (x, y) <-> CIE 1960 (u, v) -------------------------------------------
  function xyToUv(x, y) {
    const denom = -2 * x + 12 * y + 3;
    return { u: 4 * x / denom, v: 6 * y / denom };
  }

  function uvToXy(u, v) {
    const denom = 2 * u - 8 * v + 4;
    return { x: 3 * u / denom, y: 2 * v / denom };
  }

  // The locus's own tangent direction at `kelvin`, in (u, v), by central
  // finite difference -- used both to displace by tint (encode) and to
  // project a displaced point back onto tint (decode). Returns a unit
  // vector perpendicular to the locus, oriented so its v-component is
  // always negative: this is what pins down "positive tint = magenta (v
  // decreases)" as a single fixed sign convention shared by both
  // directions, rather than something each call site has to re-derive.
  function perpUnitAt(kelvin) {
    const dT = Math.max(1, kelvin * 1e-4);
    const lo = xyToUv(kelvinToXyOnLocus(kelvin - dT).x, kelvinToXyOnLocus(kelvin - dT).y);
    const hi = xyToUv(kelvinToXyOnLocus(kelvin + dT).x, kelvinToXyOnLocus(kelvin + dT).y);
    const du = hi.u - lo.u, dv = hi.v - lo.v;
    const len = Math.hypot(du, dv) || 1;
    const tangent = { u: du / len, v: dv / len };
    // Rotate the tangent -90 degrees: (u, v) -> (v, -u). Pick whichever of
    // that or its negation has a negative v-component.
    const cand = { u: tangent.v, v: -tangent.u };
    return cand.v <= 0 ? cand : { u: -cand.u, v: -cand.v };
  }

  // -- Public: Kelvin/tint <-> (x, y) --------------------------------------
  function kelvinTintToXy(kelvin, tint) {
    const locus = kelvinToXyOnLocus(kelvin);
    const uv0 = xyToUv(locus.x, locus.y);
    const perp = perpUnitAt(kelvin);
    const duv = tint / 3000;
    const u = uv0.u + duv * perp.u;
    const v = uv0.v + duv * perp.v;
    return uvToXy(u, v);
  }

  // Bounded 1-D search for the nearest Planckian-locus point to (x, y) in
  // CIE 1960 (u, v) -- a coarse log-spaced scan (the locus is far from
  // linear in Kelvin) followed by golden-section refinement within the
  // best bracket, standing in for a full Robertson-table lookup.
  function nearestKelvinOnLocus(x, y) {
    const target = xyToUv(x, y);
    function dist2(k) {
      const p = kelvinToXyOnLocus(k);
      const uv = xyToUv(p.x, p.y);
      const du = uv.u - target.u, dv = uv.v - target.v;
      return du * du + dv * dv;
    }
    const KMIN = 1667, KMAX = 25000;
    const STEPS = 400;
    let bestI = 0, bestD = Infinity;
    const logMin = Math.log(KMIN), logMax = Math.log(KMAX);
    const ks = new Array(STEPS + 1);
    for (let i = 0; i <= STEPS; i++) {
      ks[i] = Math.exp(logMin + (logMax - logMin) * (i / STEPS));
      const d = dist2(ks[i]);
      if (d < bestD) { bestD = d; bestI = i; }
    }
    let lo = ks[Math.max(0, bestI - 1)];
    let hi = ks[Math.min(STEPS, bestI + 1)];
    // Golden-section search for the minimum of dist2 on [lo, hi].
    const gr = (Math.sqrt(5) - 1) / 2;
    let a = lo, b = hi;
    let c = b - gr * (b - a);
    let d = a + gr * (b - a);
    for (let i = 0; i < 100; i++) {
      if (dist2(c) < dist2(d)) { b = d; } else { a = c; }
      c = b - gr * (b - a);
      d = a + gr * (b - a);
      if (Math.abs(b - a) < 1e-6) break;
    }
    return (a + b) / 2;
  }

  function xyToKelvinTint(x, y) {
    const kelvin = nearestKelvinOnLocus(x, y);
    const locus = kelvinToXyOnLocus(kelvin);
    const uv0 = xyToUv(locus.x, locus.y);
    const uv = xyToUv(x, y);
    const perp = perpUnitAt(kelvin);
    const duv = (uv.u - uv0.u) * perp.u + (uv.v - uv0.v) * perp.v;
    return { kelvin, tint: duv * 3000 };
  }

  // -- (x, y) <-> XYZ (Y = 1) -----------------------------------------------
  function xyToXyz(x, y) {
    if (Math.abs(y) < 1e-12) return { X: 0, Y: 1, Z: 0 };
    return { X: x / y, Y: 1, Z: (1 - x - y) / y };
  }

  // -- Public: Kelvin/tint <-> camera-space neutral -------------------------
  // `colorMatrix1` is the DNG's ColorMatrix1, XYZ -> camera, row-major
  // [m0..m8] (see dng.js's own TAG_COLOR_MATRIX1 comment); never inverted
  // for this direction.
  //
  // Sign note: kelvinTintToXy/xyToKelvinTint's `tint` is the *assumed
  // illuminant's* displacement off the locus (matching the brief's own
  // wording and this module's chromaticity-level tests verbatim: positive
  // tint there moves the illuminant toward magenta, v decreases). But the
  // neutral this function builds is then *divided into* the raw pixel (the
  // shader's uWhiteBalance path, unchanged from Task 16) -- a subtractive
  // correction, not a direct push: assuming a magenta illuminant and
  // correcting for it makes the corrected image look *greener* (removing
  // the assumed magenta cast), and vice versa. Verified directly against
  // this camera's real ColorMatrix1 (task report): feeding the assumed-
  // illuminant tint straight through renders +tint as a green cast and
  // -tint as magenta -- backwards from the task's own requirement
  // ("positive tint = magenta ... matching Lightroom", checked in the
  // browser against the actual rendered pixels, not just the abstract
  // locus maths). The user-facing control here is the *rendered-result*
  // tint (that's what "matching Lightroom" means -- dragging toward
  // Magenta makes the photo look magenta), so it is the negation of the
  // illuminant tint: this pair of functions flips the sign at exactly this
  // boundary, nowhere else.
  function neutralFromKelvinTint(kelvin, tint, colorMatrix1) {
    const m = (colorMatrix1 && colorMatrix1.length === 9) ? colorMatrix1 : IDENTITY3;
    const xy = kelvinTintToXy(kelvin, -tint);
    const xyz = xyToXyz(xy.x, xy.y);
    const cam = mat3MulVec(m, [xyz.X, xyz.Y, xyz.Z]);
    const g = cam[1] || 1;
    return [cam[0] / g, cam[1] / g, cam[2] / g];
  }

  function kelvinTintFromNeutral(neutral, colorMatrix1) {
    const m = (colorMatrix1 && colorMatrix1.length === 9) ? colorMatrix1 : IDENTITY3;
    const inv = mat3Invert(m) || IDENTITY3;
    const xyz = mat3MulVec(inv, neutral);
    const sum = xyz[0] + xyz[1] + xyz[2];
    if (Math.abs(sum) < 1e-12 || xyz[1] <= 0) return { kelvin: 6500, tint: 0 };
    const x = xyz[0] / sum, y = xyz[1] / sum;
    const kt = xyToKelvinTint(x, y);
    return { kelvin: kt.kelvin, tint: -kt.tint };
  }

  // -- Slider mappings -------------------------------------------------------
  // Kelvin: logarithmic, 2000-12000 K. K = 2000 * 6^s, s in [0, 1].
  const KELVIN_MIN = 2000, KELVIN_MAX = 12000, KELVIN_RATIO = KELVIN_MAX / KELVIN_MIN;

  function sliderToKelvin(s) {
    const clamped = Math.max(0, Math.min(1, s));
    return KELVIN_MIN * Math.pow(KELVIN_RATIO, clamped);
  }

  function kelvinToSlider(k) {
    const clamped = Math.max(KELVIN_MIN, Math.min(KELVIN_MAX, k));
    return Math.log(clamped / KELVIN_MIN) / Math.log(KELVIN_RATIO);
  }

  // Tint: signed, -150..+150. tint = 150 * s * |s|, s in [-1, 1] -- finer
  // near zero, symmetric, and (unlike a log scale) defined across zero.
  const TINT_MAX = 150;

  function sliderToTint(s) {
    const clamped = Math.max(-1, Math.min(1, s));
    return TINT_MAX * clamped * Math.abs(clamped);
  }

  function tintToSlider(t) {
    const clamped = Math.max(-TINT_MAX, Math.min(TINT_MAX, t));
    const sign = clamped < 0 ? -1 : 1;
    return sign * Math.sqrt(Math.abs(clamped) / TINT_MAX);
  }

  // White-balance pipette. `srgb` is a spot's rendered linear-sRGB colour
  // (before tone), `camToSrgb` the row-major matrix that rendered it and
  // `neutral` the white balance in effect. The raw shader computes
  // srgb = camToSrgb . (camera / neutral), so the spot's camera colour is
  // neutral * inv(camToSrgb) . srgb; using that colour (green = 1) as the
  // new neutral makes the spot render grey. Null if the spot has no usable
  // colour (black, or a channel at or below zero).
  function neutralFromRendered(srgb, camToSrgb, neutral) {
    const inv = mat3Invert(camToSrgb);
    if (!inv) return null;
    const cam = [0, 1, 2].map((r) =>
      neutral[r] * (inv[r * 3] * srgb[0] + inv[r * 3 + 1] * srgb[1] + inv[r * 3 + 2] * srgb[2]));
    if (!cam.every((v) => v > 1e-6)) return null;
    return [cam[0] / cam[1], 1, cam[2] / cam[1]];
  }

  function srgbDecode(v) {
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }

  return {
    kelvinToXyOnLocus,
    neutralFromRendered, srgbDecode, kelvinTintToXy, xyToKelvinTint,
    xyToUv, uvToXy, xyToXyz,
    neutralFromKelvinTint, kelvinTintFromNeutral,
    sliderToKelvin, kelvinToSlider, sliderToTint, tintToSlider,
    KELVIN_MIN, KELVIN_MAX, TINT_MAX,
  };
});
