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
    if (width <= 0) {
      // Degenerate to an impulse at the peak
      return u === peak ? 1 : 0;
    }
    const t = (u - peak) / width;
    return Math.exp(-t * t);
  }

  function highlightWeight(luma, knee, exponent) {
    return Math.pow(Math.max(0, luma - knee), exponent);
  }

  const PROFILE_BINS = 2048;
  const LUMA = { r: 0.2126, g: 0.7152, b: 0.0722 };

  // Hard ceiling on the angular blur's kernel radius, in bins. Both
  // blurProfileAngular (below) and PROFILE_BLUR_FS (shaders.js, via the
  // uMaxRadiusBins uniform gl.js sets from this same constant) clamp to
  // it, so the two implementations can never silently diverge past this
  // point the way an unbounded JS kernel vs. a fixed-size GLSL loop once
  // could. Sized to cover the full glowSpreadDeg slider (0-45 deg) at
  // PROFILE_BINS bins: 45/360 * 2048 * 3 = 768.
  const MAX_BLUR_RADIUS_BINS = 768;

  // Reference implementation of render pass 1. The GLSL in shaders.js
  // mirrors this; test/parity.test.js keeps the two honest.
  function buildRimProfile(sample, opts) {
    const { bins, radialSamples, uMin, uMax, knee, exponent } = opts;
    const out = new Float32Array(bins * 4);
    for (let i = 0; i < bins; i++) {
      const theta = ((i + 0.5) / bins) * Math.PI * 2;
      let acc = 0, cr = 0, cg = 0, cb = 0;
      for (let j = 0; j < radialSamples; j++) {
        const u = uMin + (uMax - uMin) * ((j + 0.5) / radialSamples);
        const c = sample(theta, u);
        const luma = LUMA.r * c[0] + LUMA.g * c[1] + LUMA.b * c[2];
        acc += highlightWeight(luma, knee, exponent);
        cr += c[0]; cg += c[1]; cb += c[2];
      }
      out[i * 4] = acc / radialSamples;
      out[i * 4 + 1] = cr / radialSamples;
      out[i * 4 + 2] = cg / radialSamples;
      out[i * 4 + 3] = cb / radialSamples;
    }
    return out;
  }

  function blurProfileAngular(profile, bins, spreadBins) {
    if (spreadBins <= 0) return profile.slice();
    const radius = Math.min(MAX_BLUR_RADIUS_BINS, Math.max(1, Math.ceil(spreadBins * 3)));
    const kernel = new Float64Array(radius * 2 + 1);
    let sum = 0;
    for (let k = -radius; k <= radius; k++) {
      const w = Math.exp(-(k * k) / (2 * spreadBins * spreadBins));
      kernel[k + radius] = w;
      sum += w;
    }
    for (let k = 0; k < kernel.length; k++) kernel[k] /= sum;

    const out = new Float32Array(bins * 4);
    for (let i = 0; i < bins; i++) {
      let a = 0, r = 0, g = 0, b = 0;
      for (let k = -radius; k <= radius; k++) {
        const j = ((i + k) % bins + bins) % bins;
        const w = kernel[k + radius];
        a += profile[j * 4] * w;
        r += profile[j * 4 + 1] * w;
        g += profile[j * 4 + 2] * w;
        b += profile[j * 4 + 3] * w;
      }
      out[i * 4] = a; out[i * 4 + 1] = r; out[i * 4 + 2] = g; out[i * 4 + 3] = b;
    }
    return out;
  }

  // Replaced with fitted values in Task 9.
  const PRESETS = {
    x1classic: {
      falloffStart: 0.90,
      falloffSoftness: 1.0,
      edgeIntensity: 1.0,
      ringWidth: 0.012,
      dispersion: 0.010,
      glowSpreadDeg: 8,
      highlightKnee: 0.45,
      highlightExponent: 2.0,
      hazeWidth: 0.06,
      hazeStrength: 0.15,
      terminatorDesaturate: 0.6,
      terminatorCoolShift: 0.25,
    },
  };

  return {
    DISPERSION_RATIO, terminator, dispersionPeaks, rimBell, highlightWeight,
    PROFILE_BINS, MAX_BLUR_RADIUS_BINS, buildRimProfile, blurProfileAngular, PRESETS,
  };
});
