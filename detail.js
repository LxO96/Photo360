(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Detail = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Noise reduction and sharpening: the JS reference for the develop
  // passes in shaders.js (DEV_*_FS), which mirror it step for step
  // (App.checkDetailParity compares the two). It runs once per lens, over
  // the whole source frame, before anything else -- the composite then
  // samples the result.
  //
  // The image is split with an a-trous wavelet transform (B3 spline) into
  // LEVELS detail layers, fine to coarse, plus a coarse residual. Each
  // layer is thresholded against that layer's measured noise (`sigmas`,
  // see noise.js): coefficients the size of the noise are shrunk, larger
  // ones (edges, texture) kept. The test is on the coefficient's
  // neighbourhood (3 x 3, NeighShrink), not the coefficient alone, so a
  // lone noise spike is removed with the noise around it instead of being
  // left standing as a speck, while edges -- lines of large coefficients --
  // pass. Then sharpening boosts the fine luma layers
  // that survived -- after the noise is gone, so it cannot amplify it.
  //
  // Works on an "opponent" colour split of the working values: luma
  // (R + 2G + B) / 4 and two chroma axes, so colour noise can be treated
  // harder than luma. For raw sources the working values are the camera
  // RGB after a variance-stabilising transform (noise.js), so the noise is
  // the same size at every brightness; for JPEG sources they are the
  // display-encoded RGB.
  //
  // Parameters: lumaNoise 0..100, colorNoise 0..100 (threshold, in units
  // of the measured noise: 50 is LUMA_K / 2 noise sigmas), sharpenAmount
  // 0..150 (fine-layer boost, %), sharpenRadius 0.5..2 (pixels: which
  // layers are boosted).

  const LEVELS = 5;
  const B3 = [1 / 16, 4 / 16, 6 / 16, 4 / 16, 1 / 16];
  const LUMA_K = 2;     // threshold at lumaNoise 100, in noise sigmas
  const CHROMA_K = 4;   // threshold at colorNoise 100
  const SHARPEN_FLOOR = 2;  // boost only luma detail well above this many noise sigmas
  const TINY = 1e-12;

  const DEFAULTS = { sharpenAmount: 0, sharpenRadius: 1, lumaNoise: 0, colorNoise: 0 };

  function isActive(p) {
    return p.sharpenAmount > 0 || p.lumaNoise > 0 || p.colorNoise > 0;
  }

  function toOpp(r, g, b) {
    return [(r + 2 * g + b) / 4, (r - b) / 2, (2 * g - r - b) / 4];
  }

  function fromOpp(y, c1, c2) {
    return [y + c1 - c2, y + c2, y - c1 - c2];
  }

  // Shrinks a wavelet coefficient d toward zero by its neighbourhood's
  // energy e (mean square): d * (e / (e + T^2))^2, so ~0 where the
  // neighbourhood is at or below the threshold T, ~d well above it. A
  // smooth hard threshold. T = 0 leaves it alone.
  function shrink(d, e, t) {
    if (t <= 0) return d;
    const f = e / (e + t * t);
    return d * f * f;
  }

  // How much of the sharpening goes to layer k (0 = finest) for a radius
  // in pixels: layer k holds detail around 2^k px, so the weight peaks at
  // the layer nearest the radius and falls off over the neighbours.
  function sharpenWeight(k, radius) {
    const centre = Math.log2(radius) + 1;
    return Math.max(0, 1 - 0.5 * Math.abs(k - centre));
  }

  // Per-layer settings the shader gets as uniforms: thresholds per opponent
  // channel and the luma boost.
  function levelParams(p, sigmas) {
    const out = [];
    for (let k = 0; k < LEVELS; k++) {
      const s = sigmas[k];
      const kY = LUMA_K * (p.lumaNoise / 100);
      const kC = CHROMA_K * (p.colorNoise / 100);
      out.push({
        sigma: s,
        thresh: [kY * s[0], kC * s[1], kC * s[2]],
        boost: (p.sharpenAmount / 100) * sharpenWeight(k, p.sharpenRadius),
      });
    }
    return out;
  }

  // One thresholded layer coefficient (opponent triple), given its
  // neighbourhood's mean square per channel `e`.
  function detailCoef(d, e, lp) {
    let y = shrink(d[0], e[0], lp.thresh[0]);
    const c1 = shrink(d[1], e[1], lp.thresh[1]);
    const c2 = shrink(d[2], e[2], lp.thresh[2]);
    if (lp.boost > 0) {
      // Only what stands clear of the noise is boosted.
      const y2 = y * y;
      const sy = SHARPEN_FLOOR * lp.sigma[0];
      y *= 1 + lp.boost * (y2 / (y2 + sy * sy + TINY));
    }
    return [y, c1, c2];
  }

  // One a-trous smoothing step with holes `step` px apart, clamped at the
  // edges. `img` is a Float32Array of w * h * 3 values.
  function blur(img, w, h, step) {
    const out = new Float32Array(img.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let a = 0, b = 0, c = 0;
        for (let j = -2; j <= 2; j++) {
          const yy = Math.min(h - 1, Math.max(0, y + j * step));
          for (let i = -2; i <= 2; i++) {
            const xx = Math.min(w - 1, Math.max(0, x + i * step));
            const wt = B3[i + 2] * B3[j + 2];
            const o = (yy * w + xx) * 3;
            a += wt * img[o]; b += wt * img[o + 1]; c += wt * img[o + 2];
          }
        }
        const o = (y * w + x) * 3;
        out[o] = a; out[o + 1] = b; out[o + 2] = c;
      }
    }
    return out;
  }

  // The decomposition itself: `levels` detail layers (c_k - c_k+1) and the
  // coarse residual. Summing them all gives the input back exactly.
  function atrous(img, w, h, levels) {
    const details = [];
    let c = img;
    for (let k = 0; k < levels; k++) {
      const next = blur(c, w, h, 1 << k);
      const d = new Float32Array(c.length);
      for (let i = 0; i < c.length; i++) d[i] = c[i] - next[i];
      details.push(d);
      c = next;
    }
    return { details, coarse: c };
  }

  // Denoise + sharpen an opponent image (w * h * 3). `sigmas[k]` is layer
  // k's noise per opponent channel. Returns the new opponent image.
  function develop(img, w, h, p, sigmas) {
    const lps = levelParams(p, sigmas);
    const { details, coarse } = atrous(img, w, h, LEVELS);
    const out = Float32Array.from(coarse);
    for (let k = 0; k < LEVELS; k++) {
      const d = details[k];
      const step = 1 << k;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const e = [0, 0, 0];
          for (let j = -1; j <= 1; j++) {
            const yy = Math.min(h - 1, Math.max(0, y + j * step));
            for (let i = -1; i <= 1; i++) {
              const o = (yy * w + Math.min(w - 1, Math.max(0, x + i * step))) * 3;
              e[0] += d[o] * d[o]; e[1] += d[o + 1] * d[o + 1]; e[2] += d[o + 2] * d[o + 2];
            }
          }
          const o = (y * w + x) * 3;
          const r = detailCoef([d[o], d[o + 1], d[o + 2]], [e[0] / 9, e[1] / 9, e[2] / 9], lps[k]);
          out[o] += r[0]; out[o + 1] += r[1]; out[o + 2] += r[2];
        }
      }
    }
    return out;
  }

  return {
    DEFAULTS, LEVELS, B3, LUMA_K, CHROMA_K, SHARPEN_FLOOR,
    isActive, toOpp, fromOpp, shrink, sharpenWeight, levelParams, detailCoef, blur, atrous, develop,
  };
});
