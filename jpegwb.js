(function (root, factory) {
  'use strict';
  const api = factory(typeof module !== 'undefined' && module.exports ? require('./wb.js') : root.Wb);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.JpegWb = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Wb) {
  'use strict';

  // White balance for JPEG / .insp files: the camera has already white
  // balanced and rendered them, so the sliders are *relative*, as in
  // Lightroom for JPEGs: Temperature and Tint, -100..100, 0 = as the
  // camera made it.
  //
  // A setting names the light the picture is to be corrected for, as an
  // offset from D65 (the white of sRGB, what the camera's rendering was
  // balanced to): Temperature moves it along the Planckian locus by
  // TEMP_STOPS stops of Kelvin at 100 (raising it warms the picture, as
  // the raw Kelvin slider does), Tint across it by TINT_SPAN (in Wb's
  // tint units, duv * 3000) at 100 (positive = magenta, as for raw). The
  // picture is then adapted from that light to D65 -- a Bradford
  // chromatic adaptation in linear sRGB, scaled so white keeps its
  // luminance (brightness stays put) -- so 0 / 0 changes nothing.
  const TEMP_STOPS = 1;
  const TINT_SPAN = 40;
  const LIMIT = 100;

  const D65 = { x: 0.3127, y: 0.3290 };
  const REF = Wb.xyToKelvinTint(D65.x, D65.y);   // D65 as Kelvin / (illuminant) tint

  const SRGB_TO_XYZ = [0.4124564, 0.3575761, 0.1804375, 0.2126729, 0.7151522, 0.0721750, 0.0193339, 0.1191920, 0.9503041];
  const BRADFORD = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296];

  function mul(a, b) {
    const o = new Array(9);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
      o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
    return o;
  }
  function inv(m) {
    const [a, b, c, d, e, f, g, h, i] = m;
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
      B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
      C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
  }
  const XYZ_TO_SRGB = inv(SRGB_TO_XYZ);
  const BRADFORD_INV = inv(BRADFORD);
  const apply = (m, v) => [0, 1, 2].map((r) => m[r * 3] * v[0] + m[r * 3 + 1] * v[1] + m[r * 3 + 2] * v[2]);
  const xyToXyz = (p) => [p.x / p.y, 1, (1 - p.x - p.y) / p.y];

  // The light a setting corrects for, as xy.
  function whiteXy(temp, tint) {
    return Wb.kelvinTintToXy(REF.kelvin * Math.pow(2, TEMP_STOPS * temp / 100), REF.tint - TINT_SPAN * tint / 100);
  }

  // Linear sRGB -> linear sRGB for a setting (row-major 3 x 3).
  function matrix(temp, tint) {
    if (!temp && !tint) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const src = apply(BRADFORD, xyToXyz(whiteXy(temp, tint)));
    const dst = apply(BRADFORD, xyToXyz(D65));
    const gain = [dst[0] / src[0], 0, 0, 0, dst[1] / src[1], 0, 0, 0, dst[2] / src[2]];
    const m = mul(XYZ_TO_SRGB, mul(BRADFORD_INV, mul(gain, mul(BRADFORD, SRGB_TO_XYZ))));
    const w = apply(m, [1, 1, 1]);
    const Y = SRGB_TO_XYZ[3] * w[0] + SRGB_TO_XYZ[4] * w[1] + SRGB_TO_XYZ[5] * w[2];
    return m.map((v) => v / Y);
  }

  // The setting under which the light whose colour (in the camera's
  // rendering, linear sRGB) is `white` becomes neutral -- the inverse of
  // whiteXy. Clamped to the sliders; `atLimit` says if it was.
  function fromWhite(white) {
    const X = apply(SRGB_TO_XYZ, white);
    const s = X[0] + X[1] + X[2];
    if (!(s > 1e-9) || !(X[1] > 0)) return null;
    const kt = Wb.xyToKelvinTint(X[0] / s, X[1] / s);
    const temp = 100 * Math.log2(kt.kelvin / REF.kelvin) / TEMP_STOPS;
    const tint = 100 * (REF.tint - kt.tint) / TINT_SPAN;
    const c = (v) => Math.max(-LIMIT, Math.min(LIMIT, v));
    return { temp: c(temp), tint: c(tint), atLimit: c(temp) !== temp || c(tint) !== tint };
  }

  // The setting that renders `colour` (the camera's own rendering, linear
  // sRGB) with the chromaticity of `want` (linear sRGB): the light it
  // corrects for is, in Bradford cone space, colour * D65 / want.
  // want = grey is Pick neutral; want = another lens's colour is Match.
  function solve(colour, want) {
    const c = apply(BRADFORD, apply(SRGB_TO_XYZ, colour));
    const w = apply(BRADFORD, apply(SRGB_TO_XYZ, want));
    const d = apply(BRADFORD, xyToXyz(D65));
    if (!c.every((v) => v > 1e-9) || !w.every((v) => v > 1e-9)) return null;
    const white = apply(XYZ_TO_SRGB, apply(BRADFORD_INV, [0, 1, 2].map((i) => c[i] * d[i] / w[i])));
    return fromWhite(white);
  }

  return { TEMP_STOPS, TINT_SPAN, LIMIT, D65, whiteXy, matrix, fromWhite, solve, apply, inv };
});
