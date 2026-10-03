(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Film = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Film simulation (spec docs/superpowers/specs/2026-10-03-film-simulation-design.md),
  // ported from the user's Wigglecam app (film/ and filmgpu/): stocks, the
  // characteristic curve, grain calibrated to a silver-halide crystal model,
  // plus halation and the film gauge, which Wigglecam does not have. The GPU
  // passes are shaders.js FILM_*; this module holds the maths, the per-render
  // parameters and a JS reference renderer the GPU is checked against.

  // Halation strength and colour, per stock (the Halation slider scales it):
  // light through the emulsion, back off the film base, re-exposing mostly
  // the red layer. Tungsten 800 has no anti-halation layer: far stronger.
  const HALO_STD = { gain: 0.6, tint: [1, 0.28, 0.05] };

  // Wigglecam's five (golden200 ... smooth400bw) verbatim from its
  // film/src/main/resources/stocks/*.json, plus this app's own. Chip order:
  // colour negatives, tungsten, B&W. sensitivity and crosstalk are
  // 3x3, row-major.
  const STOCKS = [
    { id: 'portrait160', name: 'Portrait 160', bw: false,
      sensitivity: [1.02, -0.01, -0.01, 0.00, 1.00, 0.00, -0.01, -0.02, 0.96],
      layers: [
        { gamma: 0.50, logE0: -0.82, uMin: 0.040, uMax: 0.960 },
        { gamma: 0.50, logE0: -0.82, uMin: 0.040, uMax: 0.960 },
        { gamma: 0.49, logE0: -0.80, uMin: 0.045, uMax: 0.955 },
      ],
      grain: { radiusMedianPx: 0.09, radiusLogSigma: 0.30, filterSigmaPx: 0.8 },
      crosstalk: [1.04, -0.03, -0.01, -0.02, 1.04, -0.02, -0.01, -0.03, 1.04],
      halation: HALO_STD },
    { id: 'golden200', name: 'Golden 200', bw: false,
      sensitivity: [1.06, -0.02, -0.04, -0.01, 1.00, 0.01, -0.03, -0.05, 0.92],
      layers: [
        { gamma: 0.62, logE0: -0.80, uMin: 0.035, uMax: 0.965 },
        { gamma: 0.62, logE0: -0.79, uMin: 0.030, uMax: 0.965 },
        { gamma: 0.60, logE0: -0.76, uMin: 0.045, uMax: 0.950 },
      ],
      grain: { radiusMedianPx: 0.12, radiusLogSigma: 0.35, filterSigmaPx: 0.8 },
      crosstalk: [1.12, -0.08, -0.04, -0.06, 1.10, -0.04, -0.03, -0.09, 1.12],
      halation: HALO_STD },
    // The stocks below are this app's own (2026-10-03), in Wigglecam's form.
    // Fine-grained, saturated colour negative (an Ektar-like look).
    { id: 'vivid100', name: 'Vivid 100', bw: false,
      sensitivity: [1.08, -0.05, -0.03, -0.04, 1.08, -0.04, -0.03, -0.06, 1.09],
      layers: [
        { gamma: 0.70, logE0: -0.80, uMin: 0.030, uMax: 0.970 },
        { gamma: 0.70, logE0: -0.79, uMin: 0.028, uMax: 0.970 },
        { gamma: 0.68, logE0: -0.78, uMin: 0.035, uMax: 0.960 },
      ],
      grain: { radiusMedianPx: 0.07, radiusLogSigma: 0.30, filterSigmaPx: 0.8 },
      crosstalk: [1.16, -0.10, -0.06, -0.07, 1.15, -0.08, -0.04, -0.11, 1.15],
      halation: HALO_STD },
    // Soft, low-contrast negative with lifted shadows and minty greens
    // (a 400H-like look, as often shot overexposed).
    { id: 'pastel400', name: 'Pastel 400', bw: false,
      sensitivity: [0.96, 0.02, 0.02, 0.00, 0.99, 0.05, 0.02, 0.04, 0.98],
      layers: [
        { gamma: 0.41, logE0: -0.90, uMin: 0.085, uMax: 0.952 },
        { gamma: 0.41, logE0: -0.92, uMin: 0.090, uMax: 0.952 },
        { gamma: 0.40, logE0: -0.88, uMin: 0.095, uMax: 0.948 },
      ],
      grain: { radiusMedianPx: 0.15, radiusLogSigma: 0.35, filterSigmaPx: 0.8 },
      crosstalk: [0.95, 0.03, 0.02, 0.03, 0.95, 0.02, 0.02, 0.03, 0.95],
      halation: HALO_STD },
    { id: 'verdant400', name: 'Verdant 400', bw: false,
      sensitivity: [0.97, -0.01, -0.01, -0.01, 1.04, -0.01, -0.01, 0.00, 1.04],
      layers: [
        { gamma: 0.60, logE0: -0.76, uMin: 0.030, uMax: 0.960 },
        { gamma: 0.58, logE0: -0.85, uMin: 0.055, uMax: 0.960 },
        { gamma: 0.60, logE0: -0.80, uMin: 0.040, uMax: 0.955 },
      ],
      grain: { radiusMedianPx: 0.16, radiusLogSigma: 0.35, filterSigmaPx: 0.8 },
      crosstalk: [1.08, -0.05, -0.03, -0.04, 1.08, -0.04, -0.02, -0.06, 1.08],
      halation: HALO_STD },
    // Tungsten-balanced cinema film without its anti-halation layer (a
    // CineStill 800T-like look): cool in daylight, coarse grain, and a strong
    // red glow around bright light.
    { id: 'tungsten800', name: 'Tungsten 800', bw: false,
      sensitivity: [0.80, -0.01, -0.01, -0.02, 1.00, 0.02, 0.00, 0.05, 1.22],
      layers: [
        { gamma: 0.58, logE0: -0.82, uMin: 0.045, uMax: 0.955 },
        { gamma: 0.58, logE0: -0.80, uMin: 0.040, uMax: 0.955 },
        { gamma: 0.56, logE0: -0.78, uMin: 0.050, uMax: 0.950 },
      ],
      grain: { radiusMedianPx: 0.20, radiusLogSigma: 0.40, filterSigmaPx: 0.8 },
      crosstalk: [1.10, -0.06, -0.04, -0.05, 1.09, -0.04, -0.03, -0.08, 1.11],
      halation: { gain: 1.8, tint: [1, 0.15, 0.02] } },
    { id: 'classic400bw', name: 'Classic 400 B&W', bw: true,
      sensitivity: [0.30, 0.59, 0.11, 0.30, 0.59, 0.11, 0.30, 0.59, 0.11],
      layers: [
        { gamma: 0.78, logE0: -0.74, uMin: 0.020, uMax: 0.980 },
        { gamma: 0.78, logE0: -0.74, uMin: 0.020, uMax: 0.980 },
        { gamma: 0.78, logE0: -0.74, uMin: 0.020, uMax: 0.980 },
      ],
      grain: { radiusMedianPx: 0.22, radiusLogSigma: 0.40, filterSigmaPx: 0.8 },
      crosstalk: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      halation: HALO_STD },
    { id: 'smooth400bw', name: 'Smooth 400 B&W', bw: true,
      sensitivity: [0.25, 0.62, 0.13, 0.25, 0.62, 0.13, 0.25, 0.62, 0.13],
      layers: [
        { gamma: 0.56, logE0: -0.78, uMin: 0.040, uMax: 0.960 },
        { gamma: 0.56, logE0: -0.78, uMin: 0.040, uMax: 0.960 },
        { gamma: 0.56, logE0: -0.78, uMin: 0.040, uMax: 0.960 },
      ],
      grain: { radiusMedianPx: 0.13, radiusLogSigma: 0.30, filterSigmaPx: 0.8 },
      crosstalk: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      halation: HALO_STD },
  ];

  // Film gauges: the gate's short side (mm). Each lens circle stands for one
  // frame, its diameter spanning the short side, so a smaller gate means
  // coarser grain and wider halation at the same export size.
  const GAUGES = [
    { id: 's8', name: 'Super 8', short: 4.01 },
    { id: 's16', name: 'Super 16', short: 7.41 },
    { id: '35', name: '35 mm', short: 24 },
    { id: '120', name: '120 (6×6)', short: 56 },
  ];
  // Wigglecam's grain sizes are for a 4:3 frame 4080 px long: 3060 px on the
  // short side. That frame is taken as Super 8's gate (4.01 mm): Wigglecam's
  // grain is the coarsest here and the bigger gauges finer (the user, 2026-10-03:
  // the first cut, which took it as 35 mm, was far too grainy). Halation keeps
  // its own size, relative to 35 mm's 24 mm.
  const REF_SHORT_PX = 3060;
  const REF_SHORT_MM = 4.01;
  const HALATION_REF_MM = 24;

  const srgbDecode = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  const srgbEncode = (x) => (x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);
  const MID = 0.18;
  const MID_OUT = srgbEncode(MID);   // 0.46135612950044164
  const WHITE_OUT = 0.96;
  const HALATION = { LO: 0.75, HI: 1.0, RADIUS: 0.008 };   // gain and tint: each stock's

  // Wigglecam ToneCurve.develop: developed fraction (display lightness) for
  // log10 exposure, a logistic with slope gamma at logE0.
  function develop(logE, l) {
    const range = l.uMax - l.uMin;
    const k = 4 * l.gamma / range;
    return l.uMin + range / (1 + Math.exp(-k * (logE - l.logE0)));
  }

  // The curve re-centred on the edit (the input is already a finished
  // image): one exposure shift b and one stretch s per stock, fitted on the
  // anchor layer so linear 0.18 -> MID_OUT and 1.0 -> WHITE_OUT. The other
  // layers share b and s, so the stock's own layer differences stay as its
  // colour. b by bisection: the stretched mid rises monotonically with b.
  const fitCache = new Map();
  function fitCurve(stock) {
    if (fitCache.has(stock.id)) return fitCache.get(stock.id);
    const l = stock.layers[stock.bw ? 0 : 1];
    const at = (e, b) => develop(Math.log10(e) + b, l);
    const midFor = (b) => {
      const s = (WHITE_OUT - l.uMin) / (at(1, b) - l.uMin);
      return { s, mid: l.uMin + s * (at(MID, b) - l.uMin) };
    };
    let lo = -4, hi = 4;
    for (let i = 0; i < 80; i++) {
      const m = (lo + hi) / 2;
      if (midFor(m).mid < MID_OUT) lo = m; else hi = m;
    }
    const b = (lo + hi) / 2;
    const fit = { b, s: midFor(b).s, uMinA: l.uMin };
    fitCache.set(stock.id, fit);
    return fit;
  }

  // Linear rgb -> the three developed layers (display values, before grain).
  function curvePixel(lin, stock, fit) {
    const m = stock.sensitivity, out = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      const e = m[i * 3] * lin[0] + m[i * 3 + 1] * lin[1] + m[i * 3 + 2] * lin[2];
      const u = develop(Math.log10(Math.max(e, 1e-5)) + fit.b, stock.layers[i]);
      out[i] = fit.uMinA + fit.s * (u - fit.uMinA);
    }
    return out;
  }

  // Wigglecam Rng.hash (PCG), 32-bit integer ops only so the shader
  // (FILM_GLSL pcg) reproduces it exactly. Returns a signed int32.
  function pcg(v) {
    const state = (Math.imul(v | 0, 747796405) - 1403630843) | 0;
    const word = Math.imul((state >>> ((state >>> 28) + 4)) ^ state, 277803737);
    return ((word >>> 22) ^ word) | 0;
  }
  const hash4 = (a, b, c, d) => pcg(a ^ pcg(b ^ pcg(c ^ pcg(d))));
  // Box-Muller from 24-bit uniforms, as Wigglecam's GPU uniform01 (fp32
  // safe); the shader does the same.
  const U24 = 1 / 16777216;
  function gaussian(h) {
    const h1 = pcg(h), h2 = pcg(h1);
    const u1 = Math.max((h1 >>> 8) * U24, U24);
    const u2 = (h2 >>> 8) * U24;
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
  // The photo's grain seed: FNV-1a of its file name, so a photo always
  // develops the same and two photos differ.
  function seedOf(name) {
    let h = 0x811c9dc5 | 0;
    for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 0x01000193);
    return h | 0;
  }
  // Wigglecam FilmPipeline.layerSeed with frame 0.
  const layerSeeds = (seed) => [0, 1, 2].map((l) => hash4(seed, 0, l, 0x51));

  // -- Grain: Wigglecam GrainModel / FastGrain, line for line --------------
  // Boolean model of silver-halide crystals: disks with log-normal radii at
  // Poisson centres, seen through a Gaussian filter (scan blur). Lengths in
  // render pixels.
  const MAX_U = 0.995;
  const QUANTILES = 32;

  // Inverse standard normal CDF (Acklam, |error| < 1.2e-9).
  function inverseNormal(p) {
    const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
    const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
    const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
    const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
    const low = 0.02425;
    if (p < low) {
      const q = Math.sqrt(-2 * Math.log(p));
      return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
    if (p <= 1 - low) {
      const q = p - 0.5, r = q * q;
      return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
    }
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }

  // e^-z I0(z), z >= 0 (Abramowitz & Stegun 9.8.1-9.8.2).
  function i0e(z) {
    if (z <= 3.75) {
      const t = (z / 3.75) * (z / 3.75);
      const i0 = 1 + t * (3.5156229 + t * (3.0899424 + t * (1.2067492 + t * (0.2659732 + t * (0.0360768 + t * 0.0045813)))));
      return i0 * Math.exp(-z);
    }
    const t = 3.75 / z;
    return (0.39894228 + t * (0.01328592 + t * (0.00225319 + t * (-0.00157565 + t * (0.00916281 + t * (-0.02057706 + t * (0.02635537 + t * (-0.01647633 + t * 0.00392377)))))))) / Math.sqrt(z);
  }

  // Overlap area of two disks of radius r whose centres are d apart.
  function lensArea(r, d) {
    if (d >= 2 * r) return 0;
    return 2 * r * r * Math.acos(d / (2 * r)) - d / 2 * Math.sqrt(4 * r * r - d * d);
  }

  function grainModel(radiusMedian, radiusLogSigma, filterSigma) {
    const meanArea = Math.PI * radiusMedian * radiusMedian * Math.exp(2 * radiusLogSigma * radiusLogSigma);
    const maxRadius = radiusMedian * Math.exp(2.5 * radiusLogSigma);
    const radii = Array.from({ length: QUANTILES }, (_, i) => radiusMedian * Math.exp(radiusLogSigma * inverseNormal((i + 0.5) / QUANTILES)));
    const rMax = Math.max(...radii);
    const lambda = (u) => -Math.log(1 - Math.min(Math.max(u, 0), MAX_U)) / meanArea;
    function covariance(u, d) {
      if (u <= 0) return 0;
      const q = 1 - Math.min(Math.max(u, 0), MAX_U);
      let overlap = 0;
      for (const r of radii) overlap += lensArea(r, d);
      overlap /= radii.length;
      return q * q * (Math.exp(lambda(u) * overlap) - 1);
    }
    function filteredCovariance(u, delta) {
      if (u <= 0) return 0;
      const upper = 2 * rMax, n = 400, h = upper / n, s2 = filterSigma * filterSigma;
      const f = (r) => covariance(u, r) * Math.exp(-(r - delta) * (r - delta) / (4 * s2)) * i0e(r * delta / (2 * s2)) * r / (2 * s2);
      let sum = f(0) + f(upper);
      for (let i = 1; i < n; i++) sum += (i % 2 === 1 ? 4 : 2) * f(i * h);
      return sum * h / 3;
    }
    const filteredVariance = (u) => filteredCovariance(u, 0);
    function lagOneCorrelation(u = 0.5) {
      const v = filteredCovariance(u, 0);
      return v <= 0 ? 0 : filteredCovariance(u, 1) / v;
    }
    const forRenderScale = (s) => grainModel(radiusMedian * s, radiusLogSigma,
      Math.sqrt(filterSigma * filterSigma * s * s + Math.max(0, 1 - s * s) / 12));
    return { radiusMedian, radiusLogSigma, filterSigma, meanArea, maxRadius, lambda, covariance,
      filteredCovariance, filteredVariance, lagOneCorrelation, forRenderScale };
  }

  // Separable kernels in the shader loop at most this many taps each side.
  const MAX_KERNEL_RADIUS = 31;
  function gaussianKernel(sigma) {
    const r = Math.min(MAX_KERNEL_RADIUS, Math.max(1, Math.ceil(3 * sigma)));
    const k = new Float64Array(2 * r + 1);
    let sum = 0;
    for (let i = 0; i < k.length; i++) { k[i] = Math.exp(-((i - r) * (i - r)) / (2 * sigma * sigma)); sum += k[i]; }
    for (let i = 0; i < k.length; i++) k[i] /= sum;
    return k;
  }
  function kernelLagOne(sigma) {
    const k = gaussianKernel(sigma);
    let num = 0, den = 0;
    for (let i = 0; i < k.length; i++) { den += k[i] * k[i]; if (i < k.length - 1) num += k[i] * k[i + 1]; }
    return num / den;
  }
  function calibrateNoiseSigma(target) {
    let lo = 0.05, hi = 20;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (kernelLagOne(mid) < target) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  const STD_TABLE = 200;
  const quantizeScale = (v) => Math.pow(2, Math.round(8 * Math.log2(v)) / 8);
  // Everything a render needs for one stock's grain at export scale
  // `scaleExport` seen at `z` screen px per export px (1 for the export).
  // Building one costs tens of ms, so they are cached.
  const setupCache = new Map();
  function grainSetup(p, scaleExport, z) {
    const key = [p.radiusMedianPx, p.radiusLogSigma, p.filterSigmaPx, scaleExport, z].join('|');
    if (setupCache.has(key)) return setupCache.get(key);
    let model = grainModel(p.radiusMedianPx, p.radiusLogSigma, p.filterSigmaPx).forRenderScale(scaleExport);
    if (z !== 1) model = model.forRenderScale(z);
    const sigma = calibrateNoiseSigma(model.lagOneCorrelation());
    const k = gaussianKernel(sigma);
    let sw2 = 0;
    for (const w of k) sw2 += w * w;
    const std = new Float32Array(STD_TABLE + 1);
    for (let i = 0; i <= STD_TABLE; i++) std[i] = Math.sqrt(Math.max(0, model.filteredVariance(i / STD_TABLE)));
    const setup = { model, sigma, radius: (k.length - 1) / 2, weights: Float32Array.from(k), norm: 1 / sw2, std };
    if (setupCache.size > 16) setupCache.delete(setupCache.keys().next().value);
    setupCache.set(key, setup);
    return setup;
  }

  // -- Per-render parameters ----------------------------------------------
  const stockOf = (id) => STOCKS.find((s) => s.id === id) || null;
  const gaugeOf = (id) => GAUGES.find((g) => g.id === id) || GAUGES[2];
  function active(state) {
    return !!(state && state.film && state.film.stock !== 'off' && stockOf(state.film.stock)
      && !state.dngOutput && !state.gainOut);
  }
  const renderScale = (D, gauge) => D / REF_SHORT_PX * REF_SHORT_MM / gaugeOf(gauge).short;
  const halationRadius = (D, gauge) => HALATION.RADIUS * D * HALATION_REF_MM / gaugeOf(gauge).short;

  // frame: {D: circle diameter in export px, z: target px per export px,
  // px, py: where export pixel (0, 0)'s corner sits in the target (top-left
  // origin)}. The export: {D, z: 1, px: 0, py: 0}.
  function params(state, frame) {
    const f = state.film, stock = stockOf(f.stock);
    // Zoomed in (z > 1) the preview magnifies the export's own grain
    // (noiseBand), so its setup is the export's.
    const z = frame.z >= 1 ? 1 : quantizeScale(frame.z);
    return {
      stock, fit: fitCurve(stock),
      grain: grainSetup(stock.grain, quantizeScale(renderScale(frame.D, f.gauge)), z),
      amount: f.grain, halation: f.halation,
      haloR: halationRadius(frame.D, f.gauge) * frame.z,
      seeds: layerSeeds(seedOf(state.sourceName || '')), bw: stock.bw,
    };
  }

  // The halation field's downsample factor: blur sigma R/f at most 8 texels.
  const haloFactor = (R) => (R <= 8 ? 1 : Math.min(64, Math.pow(2, Math.ceil(Math.log2(R / 8)))));

  // -- The JS reference renderer (what the GPU passes do) -----------------
  const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const clamp01 = (v) => Math.min(1, Math.max(0, v));

  // Separable clamp-edge blur of a w x h single-channel field.
  function blur1(src, w, h, k, horizontal) {
    const r = (k.length - 1) / 2, out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let i = -r; i <= r; i++) {
          const xx = horizontal ? Math.min(w - 1, Math.max(0, x + i)) : x;
          const yy = horizontal ? y : Math.min(h - 1, Math.max(0, y + i));
          s += k[i + r] * src[yy * w + xx];
        }
        out[y * w + x] = s;
      }
    }
    return out;
  }

  // The halation field, GL y-up (row 0 = the image's bottom row).
  function haloField(src, W, H, R) {
    const f = haloFactor(R), w = Math.ceil(W / f), h = Math.ceil(H / f);
    const d = new Float32Array(w * h);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        let s = 0;
        for (let b = 0; b < f; b++) {
          for (let a = 0; a < f; a++) {
            const x = Math.min(W - 1, i * f + a), glY = Math.min(H - 1, j * f + b);
            const o = ((H - 1 - glY) * W + x) * 4;
            const Y = 0.2126 * srgbDecode(src[o] / 255) + 0.7152 * srgbDecode(src[o + 1] / 255) + 0.0722 * srgbDecode(src[o + 2] / 255);
            s += smoothstep(HALATION.LO, HALATION.HI, Y) * Y;
          }
        }
        d[j * w + i] = s / (f * f);
      }
    }
    const k = gaussianKernel(R / f);
    return { f, w, h, data: blur1(blur1(d, w, h, k, true), w, h, k, false) };
  }
  // GL texture() bilinear, clamp-to-edge, at halo-texel coords (hx, hy).
  function sampleHalo(hf, hx, hy) {
    const fx = hx - 0.5, fy = hy - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    const at = (x, y) => hf.data[Math.min(hf.h - 1, Math.max(0, y)) * hf.w + Math.min(hf.w - 1, Math.max(0, x))];
    return (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty;
  }

  // The noise lattice for target rows [top, top + rows): at z <= 1 the
  // target's own pixels (noise hashed on the export pixel under each); at
  // z > 1 the export pixels themselves -- {x0, y0} the first export pixel,
  // w x h, with the blur margin, clamped to the image -- magnified to the
  // target afterwards. map: target px -> lattice texel is
  // floor((t + 0.5 - (ox, oy)) / z).
  function noiseLattice(W, H, top, rows, p, frame) {
    const r = p.grain.radius;
    if (frame.z <= 1) {
      const t0 = Math.max(0, top - r), t1 = Math.min(H, top + rows + r);
      return { x0: 0, y0: t0, w: W, h: t1 - t0, z: 1, ox: 0, oy: t0, hashOrigin: [frame.px, frame.py], hashZ: frame.z };
    }
    const z = frame.z, ex = (t, o) => Math.floor((t + 0.5 - o) / z);
    const x0 = ex(0, frame.px), x1 = ex(W - 1, frame.px);
    const y0 = Math.max(ex(0, frame.py), ex(top, frame.py) - r);
    const y1 = Math.min(ex(H - 1, frame.py), ex(top + rows - 1, frame.py) + r);
    return { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1, z, ox: frame.px + x0 * z, oy: frame.py + y0 * z,
      hashOrigin: [-x0, 0], hashZ: 1 };
  }

  // Blurred noise for target rows [top, top + rows) (top-origin), each layer
  // a separate field; B&W: layer 0 only.
  function noiseBand(W, H, top, rows, p, frame) {
    const L = noiseLattice(W, H, top, rows, p, frame);
    const layers = p.bw ? 1 : 3, out = [];
    for (let l = 0; l < layers; l++) {
      const n = new Float32Array(L.w * L.h);
      for (let j = 0; j < L.h; j++) {
        const ey = Math.floor((L.y0 + j + 0.5 - L.hashOrigin[1]) / L.hashZ);
        for (let i = 0; i < L.w; i++) {
          const exx = Math.floor((i + 0.5 - L.hashOrigin[0]) / L.hashZ);
          n[j * L.w + i] = gaussian(hash4(exx, ey, p.seeds[l], 0x3C6EF372));
        }
      }
      const b = blur1(blur1(n, L.w, L.h, p.grain.weights, true), L.w, L.h, p.grain.weights, false);
      const o = new Float32Array(W * rows);
      for (let j = 0; j < rows; j++) {
        const ly = Math.floor((top + j + 0.5 - L.oy) / L.z);
        for (let x = 0; x < W; x++) o[j * W + x] = b[ly * L.w + Math.floor((x + 0.5 - L.ox) / L.z)];
      }
      out.push(o);
    }
    return p.bw ? [out[0], out[0], out[0]] : out;
  }

  function applyRows(src, W, H, p, top, rows, noise, hf, dst) {
    const m = p.stock.crosstalk, k = p.amount * p.grain.norm;
    for (let j = 0; j < rows; j++) {
      const r = top + j;
      for (let x = 0; x < W; x++) {
        const o = (r * W + x) * 4;
        const lin = [srgbDecode(src[o] / 255), srgbDecode(src[o + 1] / 255), srgbDecode(src[o + 2] / 255)];
        if (hf) {
          const h = sampleHalo(hf, (x + 0.5) / hf.f, (H - r - 0.5) / hf.f) * p.halation * p.stock.halation.gain;
          for (let c = 0; c < 3; c++) lin[c] += h * p.stock.halation.tint[c];
        }
        const u = curvePixel(lin, p.stock, p.fit);
        for (let c = 0; c < 3; c++) {
          const sd = p.grain.std[Math.round(clamp01(u[c]) * STD_TABLE)];
          u[c] = clamp01(u[c] + k * sd * noise[c][j * W + x]);
        }
        for (let c = 0; c < 3; c++) {
          dst[o + c] = Math.round(clamp01(m[c * 3] * u[0] + m[c * 3 + 1] * u[1] + m[c * 3 + 2] * u[2]) * 255);
        }
        dst[o + 3] = 255;
      }
    }
  }

  const haloOf = (src, W, H, p) => (p.haloR > 0 && p.halation > 0 && p.stock.halation.gain > 0 ? haloField(src, W, H, p.haloR) : null);

  function reference(src, W, H, p, frame) {
    const dst = new Uint8ClampedArray(W * H * 4);
    applyRows(src, W, H, p, 0, H, noiseBand(W, H, 0, H, p, frame), haloOf(src, W, H, p), dst);
    return dst;
  }
  function referenceBands(src, W, H, p, frame, bandRows) {
    const dst = new Uint8ClampedArray(W * H * 4), hf = haloOf(src, W, H, p);
    for (let top = 0; top < H; top += bandRows) {
      const rows = Math.min(bandRows, H - top);
      applyRows(src, W, H, p, top, rows, noiseBand(W, H, top, rows, p, frame), hf, dst);
    }
    return dst;
  }

  return {
    STOCKS, GAUGES, REF_SHORT_PX, REF_SHORT_MM, MID_OUT, WHITE_OUT, HALATION,
    srgbDecode, srgbEncode, develop, fitCurve, curvePixel,
    pcg, hash4, gaussian, seedOf, layerSeeds,
    stockOf, gaugeOf, active, renderScale, halationRadius, params, haloFactor, reference, referenceBands, noiseLattice,
    inverseNormal, i0e, grainModel, gaussianKernel, kernelLagOne, calibrateNoiseSigma, MAX_KERNEL_RADIUS, STD_TABLE, grainSetup, quantizeScale,
  };
});
