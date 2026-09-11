(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Edge = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Radial offsets of each channel's glow ring, in multiples of the
  // dispersion amount. Measured from the X1 reference: the rim reads
  // cream -> yellow -> green -> cyan -> violet going outward, i.e. red
  // peaks innermost and blue outermost.
  const DISPERSION_RATIO = { r: -1, g: 0, b: 1 };

  // Image brightness multiplier as the image runs out at the lens edge.
  // 1 inside `start`, 0 at u = 1.
  function terminator(u, start, softness) {
    if (u <= start) return 1;
    if (u >= 1) return 0;
    const t = (u - start) / (1 - start);
    const eased = t * t * (3 - 2 * t);
    return Math.pow(1 - eased, softness);
  }

  function dispersionPeaks(amount) {
    return {
      r: 1 + DISPERSION_RATIO.r * amount,
      g: 1 + DISPERSION_RATIO.g * amount,
      b: 1 + DISPERSION_RATIO.b * amount,
    };
  }

  function rimBell(u, peak, width) {
    const t = (u - peak) / width;
    return Math.exp(-t * t);
  }

  function highlightWeight(luma, knee, exponent) {
    return Math.pow(Math.max(0, luma - knee), exponent);
  }

  return { DISPERSION_RATIO, terminator, dispersionPeaks, rimBell, highlightWeight };
});
