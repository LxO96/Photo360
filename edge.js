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

  // Task 9: fitted by tools/fit-x1-edge.py against the user's own Insta360
  // ONE X reference photos -- Testfiles/Outputs/IMG_20210605_193319_00_019.jpg
  // and IMG_20210721_192852_00_141.jpg, two stacked dual-fisheye frames, four
  // image circles between them. Each circle's edge is registered per azimuth
  // (1440 rays, a robust 3-harmonic Fourier fit to the half-plateau landmark,
  // residual scatter 0.1-0.6% of the radius) before anything is measured,
  // because frame-relative radii compare different physical angles across
  // circles that sit differently in their frames, and because a rim only ~3%
  // of the radius wide is smeared into a broad ramp by a 3% registration
  // error. Aggregate sky-band RMS 0.0335 across the four, every one of them
  // inside the brief's 0.06 (0.034, 0.024, 0.030, 0.043); with Flat.jpg
  // included the aggregate is still 0.0497, though Flat's own 0.0886 is not.
  //
  // Testfiles/Outputs/Flat.jpg is measured and stored in the fixture but held
  // out of the fit: it is EXIF-tagged Adobe Lightroom 12.5, is the only
  // reference with a lifted black point, and even on its own registered radius
  // axis its run-out is about twice as wide as any ONE X circle's. One
  // terminator cannot be both, and averaging them fits neither.
  //
  // SHADOW-BAND OPTIMIZATION: The fit was constrained to the sky band only
  // (BAND_WEIGHT = [1.0, 0.0] in tools/fit-x1-edge.py). The shadow bands are
  // measured and stored but deliberately excluded from the fit objective.
  // Their out-of-circle content is sun-positioned veiling glare, which the
  // model's content-driven glow cannot reproduce, so including them would only
  // corrupt the fitted parameters. The resulting shadow-band RMS per circle
  // ranges from 0.0359 to 0.0709, exceeding the brief's stated 0.06 bar:
  // onex1_top=0.0359, onex1_bot=0.0408, onex2_top=0.0553, onex2_bot=0.0709.
  // This is a known intentional deviation from the brief's requirement.
  //
  // KNOWN LIMITATION -- the rendered ring is less saturated than the
  // references. `dispersion` and `ringWidth` are only weakly constrained: the
  // radial objective is luminance-dominated and cannot see a thin chromatic
  // ring at all (pinning either to either end of its slider moves the
  // objective by under 0.0004, and sometimes slightly *improves* it), so both
  // come from a direct chromatic measurement rather than from the fit. They
  // are honest measurements of the references' channel separation, but they
  // are small, and the rendered ring reads softer and less coloured than the
  // real thing. Part of that is structural: the references' saturated blue
  // fringe sits *inside* the run-out, where this model's only chromatic lever
  // is the achromatic terminator plus COOL, and COOL (fixed in shaders.js)
  // tops out around b = 0.41 of the RGB sum where the references reach 0.65.
  // Raising the Dispersion and Ring width sliders to taste is the intended
  // remedy; these defaults are the measured floor, not a ceiling.
  //
  // Not every value here is fitted, and the ones that are not say so. The
  // bracketed numbers are what it costs the 0.0335 objective to pin that
  // parameter to each end of its slider and re-optimise everything else --
  // the script prints the whole table.
  //
  //   falloffStart          FITTED, strongly [+0.143 / +0.022].
  //   falloffSoftness       BOUNDARY-PEGGED at the slider's 4.0 ceiling
  //                         [+0.004 / +0.00000]. The ONE X run-out is sharper
  //                         than a smoothstep to any power the slider allows,
  //                         so the fit asks for all of it and would take more.
  //                         Reported rather than quietly clamped.
  //   edgeIntensity         FITTED [+0.004 / +0.040]. This is the renderer's
  //                         own edgeIntensity, multiplying prof.r -- not the
  //                         product. Folding prof.r in here is what made an
  //                         earlier attempt's rim invisible.
  //   ringWidth             UNCONSTRAINED by the fit [-0.0001 / -0.0004];
  //                         rimBell(u,1,ringWidth) and the haze bell sit on
  //                         the same radius, so the objective cannot separate
  //                         them. Set to 2x the measured dispersion so the
  //                         measured colour fringe is resolvable at all
  //                         instead of averaging to grey.
  //   dispersion            MEASURED, not fitted [-0.00003 / +0.00004 -- the
  //                         fit is blind to it]: half the radial offset
  //                         between blue's and red's own edge landmarks,
  //                         averaged over the four circles' sky bands
  //                         (per-circle 0.0008-0.0032). Blue lands outside
  //                         green on all five circles, which is the sign
  //                         DISPERSION_RATIO assumes; red's offset is the
  //                         noisier half.
  //   glowSpreadDeg         UNCONSTRAINED -- left at the Task 4 default. On
  //   highlightKnee         all four ONE X circles the light outside the image
  //   highlightExponent     circle is *brighter* on the dark azimuths than on
  //                         the bright-sky ones (ratios 0.02-0.80): it is
  //                         sun-positioned veiling glare, not a local
  //                         content-driven glow, so the azimuthal half of the
  //                         model has nothing here to calibrate against. Best
  //                         pooled R^2 over the whole (knee, exponent, spread)
  //                         grid is 0.18, with the correlation's sign flipping
  //                         between circles. A reference set without a low sun
  //                         would be needed to measure these.
  //   hazeWidth             FITTED [+0.003 / +0.002].
  //   hazeStrength          FIXED at 1.0 by construction: it multiplies the
  //                         same `intensity` edgeIntensity sets, so only their
  //                         product is identifiable once ringWidth is narrow,
  //                         and left free it simply runs to whatever bound it
  //                         is given.
  //   terminatorDesaturate  MEASURED from how chromaticity drifts through the
  //   terminatorCoolShift   fade (15125 samples, weighted by fade depth since
  //                         both act in proportion to it). Weakly determined
  //                         on their own -- 5% off the chromaticity residual
  //                         against no treatment at all -- but the luminance
  //                         fit independently prefers the same direction
  //                         (adopting them took the aggregate from 0.0345 to
  //                         0.0335), so the two agree rather than trade off.
  const PRESETS = {
    x1classic: {
      falloffStart: 0.93693,
      falloffSoftness: 4.0,
      edgeIntensity: 0.26024,
      ringWidth: 0.00398,
      dispersion: 0.00199,
      glowSpreadDeg: 8,
      highlightKnee: 0.45,
      highlightExponent: 2.0,
      hazeWidth: 0.04685,
      hazeStrength: 1.0,
      terminatorDesaturate: 0.46,
      terminatorCoolShift: 0.70,
    },
  };

  // Task 10: global tone -- exposure, contrast, saturation. Applied to the
  // photograph itself (COMPOSITE_FS, right after sampling, before the
  // terminator); this is the JS reference the GLSL mirrors.
  function applyTone(rgb, tone) {
    if (tone.exposureEv === 0 && tone.contrast === 0 && tone.saturation === 0) {
      return rgb.slice ? rgb.slice() : [rgb[0], rgb[1], rgb[2]];
    }
    const gain = Math.pow(2, tone.exposureEv);
    const k = 1 + tone.contrast;
    const out = [];
    for (let i = 0; i < 3; i++) out[i] = (rgb[i] * gain - 0.5) * k + 0.5;
    const luma = LUMA.r * out[0] + LUMA.g * out[1] + LUMA.b * out[2];
    const s = 1 + tone.saturation;
    for (let i = 0; i < 3; i++) out[i] = luma + (out[i] - luma) * s;
    return out;
  }

  return {
    DISPERSION_RATIO, terminator, dispersionPeaks, rimBell, highlightWeight,
    PROFILE_BINS, MAX_BLUR_RADIUS_BINS, buildRimProfile, blurProfileAngular, PRESETS,
    applyTone,
  };
});
