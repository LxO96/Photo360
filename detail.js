(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Detail = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Sharpening and noise reduction: the JS reference for DETAIL_GLSL in
  // shaders.js, which mirrors it line for line (App.checkDetailParity
  // compares the two). Works on one output pixel from a 5 x 5 neighbourhood
  // of *source* pixels, in the gamma-encoded values the lens sampler
  // returns, before tone.
  //
  // Order: noise reduction first, then sharpening, so the sharpening does
  // not amplify the noise. Both are split into luma (Rec.709 weights) and
  // chroma (colour minus luma):
  //  - Noise reduction is a bilateral filter: neighbours are averaged with
  //    a fixed spatial Gaussian (sigma NR_SIGMA pixels), weighted down the
  //    more they differ from the centre, so edges survive. The slider sets
  //    how big a difference still counts as noise. Luma and chroma have
  //    their own slider and their own difference test.
  //  - Sharpening is an unsharp mask on luma only (no colour fringes): the
  //    centre minus a Gaussian blur of radius `sharpenRadius`, times
  //    `sharpenAmount`, added to the denoised luma. Differences smaller
  //    than a threshold (raised along with luma noise reduction) are
  //    faded out so flat, noisy areas are not sharpened.
  //
  // Parameters: sharpenAmount 0..150, sharpenRadius 0.5..2 (pixels),
  // lumaNoise 0..100, colorNoise 0..100. All zero is an exact pass-through.

  const LUMA = [0.2126, 0.7152, 0.0722];
  const R = 2;             // kernel half-width: 5 x 5 samples
  const NR_SIGMA = 1.5;    // spatial sigma of the noise-reduction kernel, pixels
  const LUMA_RANGE = 0.12; // range sigma at lumaNoise 100
  const CHROMA_RANGE = 0.25; // range sigma at colorNoise 100
  const RANGE_FLOOR = 0.004;
  const SHARPEN_THRESHOLD = 0.004;
  const SHARPEN_THRESHOLD_NR = 0.02; // added at lumaNoise 100

  function isActive(p) {
    return p.sharpenAmount > 0 || p.lumaNoise > 0 || p.colorNoise > 0;
  }

  // `sample(dx, dy)` returns the source pixel at that offset from the
  // centre as [r, g, b].
  function apply(sample, p) {
    const c0 = sample(0, 0);
    if (!isActive(p)) return c0;
    const y0 = LUMA[0] * c0[0] + LUMA[1] * c0[1] + LUMA[2] * c0[2];
    const k0 = [c0[0] - y0, c0[1] - y0, c0[2] - y0];
    const sigY = RANGE_FLOOR + LUMA_RANGE * (p.lumaNoise / 100);
    const sigC = RANGE_FLOOR + CHROMA_RANGE * (p.colorNoise / 100);
    const radius = p.sharpenRadius;
    let sumY = 0, wY = 0, wC = 0, blur = 0, wBlur = 0;
    const sumC = [0, 0, 0];
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const c = sample(dx, dy);
        const y = LUMA[0] * c[0] + LUMA[1] * c[1] + LUMA[2] * c[2];
        const k = [c[0] - y, c[1] - y, c[2] - y];
        const d2 = dx * dx + dy * dy;
        const ws = Math.exp(-d2 / (2 * NR_SIGMA * NR_SIGMA));
        const ey = y - y0;
        const wy = ws * Math.exp(-(ey * ey) / (2 * sigY * sigY));
        const ek0 = k[0] - k0[0], ek1 = k[1] - k0[1], ek2 = k[2] - k0[2];
        const wc = ws * Math.exp(-(ek0 * ek0 + ek1 * ek1 + ek2 * ek2) / (2 * sigC * sigC));
        sumY += wy * y; wY += wy;
        sumC[0] += wc * k[0]; sumC[1] += wc * k[1]; sumC[2] += wc * k[2]; wC += wc;
        const wb = Math.exp(-d2 / (2 * radius * radius));
        blur += wb * y; wBlur += wb;
      }
    }
    let outY = p.lumaNoise > 0 ? sumY / wY : y0;
    const outK = p.colorNoise > 0 ? [sumC[0] / wC, sumC[1] / wC, sumC[2] / wC] : k0;
    if (p.sharpenAmount > 0) {
      const detail = y0 - blur / wBlur;
      const th = SHARPEN_THRESHOLD + SHARPEN_THRESHOLD_NR * (p.lumaNoise / 100);
      const d2 = detail * detail;
      outY += (p.sharpenAmount / 100) * detail * (d2 / (d2 + th * th));
    }
    return [
      Math.min(1, Math.max(0, outY + outK[0])),
      Math.min(1, Math.max(0, outY + outK[1])),
      Math.min(1, Math.max(0, outY + outK[2])),
    ];
  }

  const DEFAULTS = { sharpenAmount: 0, sharpenRadius: 1, lumaNoise: 0, colorNoise: 0 };

  return {
    apply, isActive, DEFAULTS, R, NR_SIGMA, LUMA_RANGE, CHROMA_RANGE, RANGE_FLOOR,
    SHARPEN_THRESHOLD, SHARPEN_THRESHOLD_NR,
  };
});
