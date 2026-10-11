(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else {
    root.Noise = api;
    // For the develop workers (devcpu.js workerSource).
    (root.DevFactories = root.DevFactories || {}).Noise = factory;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Measuring a photo's noise, for the noise reduction in detail.js.
  //
  // Raw sensor noise is shot noise plus read noise: its variance grows
  // linearly with the signal, var = a * x + b (x linear, 0 = black,
  // 1 = white level). fitProfile measures a and b from the raw plane
  // itself; vst then maps x so the noise has the same size (1) at every
  // brightness, which lets one threshold work in shadows and highlights
  // alike. Measured on the ONE X / One2 test files at ISO 100:
  // a ~ 1e-4, b ~ 1.7e-7 (1.5 DN per DN and a read noise of ~6 DN, 14-bit).
  //
  // estimateSigma measures the noise in each wavelet layer directly,
  // robustly: the spread of the layer's coefficients in many small blocks,
  // taken from the flattest blocks, where only noise is left.

  // Generalised Anscombe transform for var = a * x + b: unit noise.
  // Below black (x < 0) there is only read noise, of constant size sqrt(b),
  // so it continues as the straight line x / sqrt(b) (same slope at 0).
  // The square root alone would flatten out there and stretch every
  // downward read-noise swing near black into a dark speck.
  function vst(x, a, b) {
    const y0 = (2 / a) * Math.sqrt(b);
    return x < 0 ? y0 + x / Math.sqrt(b) : (2 / a) * Math.sqrt(a * x + b);
  }

  function vstInverse(y, a, b) {
    const y0 = (2 / a) * Math.sqrt(b);
    if (y < y0) return (y - y0) * Math.sqrt(b);
    const s = a * y / 2;
    return (s * s - b) / a;
  }

  // The p-quantile of a chi-square with n degrees of freedom, divided by n
  // (Wilson-Hilferty): what a block's measured variance is, as a fraction
  // of the true one, at that quantile of pure noise.
  function chiQuantileRatio(n, z) {
    const t = 2 / (9 * n);
    return Math.pow(1 - t + z * Math.sqrt(t), 3);
  }

  const FIT_BLOCK = 8;      // same-colour samples per block side
  const FIT_Q = 0.25;       // quantile of block variances used per bin
  const FIT_Z = -0.6745;    // its standard-normal z
  const FIT_DARK = 0.002;   // levels below this are black: read noise only
  const FIT_MIN_BLOCKS = 24;

  // Fits var = a * x + b to one raw plane (Uint16Array, w x h, one sensor
  // value per pixel; cfa as Dng.parse gives it). Uses one green site of
  // the 2 x 2 pattern: blocks of FIT_BLOCK^2 same-colour samples, each
  // giving a mean and a noise variance from differences of horizontal
  // neighbours (half their mean square -- the smooth image cancels out).
  // Blocks are binned by mean; in each bin the flatter blocks (a low
  // quantile, corrected for its bias) give that level's noise.
  function fitProfile(plane, w, h, cfa, black, white) {
    let ox = 0, oy = 0;
    for (let i = 0; i < 4; i++) if (cfa[i] === 1) { ox = i & 1; oy = i >> 1; break; }
    const range = white - black;
    const edges = [-1, FIT_DARK];
    for (let e = FIT_DARK; e < 0.95;) { e *= 1.4; edges.push(Math.min(e, 0.95)); }
    const bins = edges.slice(1).map(() => []);
    const span = FIT_BLOCK * 2;
    const n = FIT_BLOCK * (FIT_BLOCK - 1);
    for (let by = oy; by + span <= h; by += span) {
      for (let bx = ox; bx + span <= w; bx += span) {
        let sum = 0, sq = 0, clipped = false;
        for (let j = 0; j < FIT_BLOCK; j++) {
          const row = (by + 2 * j) * w + bx;
          let prev = plane[row];
          if (prev >= white) clipped = true;
          sum += prev;
          for (let i = 1; i < FIT_BLOCK; i++) {
            const v = plane[row + 2 * i];
            if (v >= white) clipped = true;
            sum += v;
            const d = v - prev;
            sq += d * d;
            prev = v;
          }
        }
        if (clipped) continue;
        const mean = (sum / (FIT_BLOCK * FIT_BLOCK) - black) / range;
        const v = sq / n / 2 / (range * range);
        for (let k = 0; k < bins.length; k++) {
          if (mean >= edges[k] && mean < edges[k + 1]) { bins[k].push([mean, v]); break; }
        }
      }
    }
    const pts = [];
    const ratio = chiQuantileRatio(n, FIT_Z);
    for (const b of bins) {
      if (b.length < FIT_MIN_BLOCKS) continue;
      b.sort((p, q) => p[1] - q[1]);
      const qi = Math.floor(b.length * FIT_Q);
      const m = b.reduce((s, p) => s + p[0], 0) / b.length;
      pts.push([m, b[qi][1] / ratio]);
    }
    return fitLine(pts);
  }

  // v = a * x + b through the measured (level, variance) points. Texture
  // and pixel-to-pixel gain differences only ever add variance, and more
  // of it the brighter the level, so: b is the darkest point's variance
  // (the black around the image circle -- pure read noise), and a the
  // lower quartile of the slopes from b to each other point.
  function fitLine(pts) {
    pts = pts.slice().sort((p, q) => p[0] - q[0]);
    let a = 1e-4, b = 1e-8;
    if (!pts.length) return { a, b, points: 0 };
    const dark = pts[0][0] < FIT_DARK ? pts[0] : null;
    const slopeFrom = (b0) => {
      const k = pts.filter((p) => p[0] >= FIT_DARK).map(([x, v]) => (v - b0) / x).filter((v) => v > 0);
      k.sort((p, q) => p - q);
      return k.length ? k[Math.floor((k.length - 1) * 0.25)] : a;
    };
    if (dark) {
      // The black bin still holds a little signal; take its share out.
      a = slopeFrom(dark[1]);
      b = Math.max(1e-8, dark[1] - a * Math.max(dark[0], 0));
      a = slopeFrom(b);
    } else {
      a = slopeFrom(0);
      b = Math.max(1e-8, pts[0][1] - a * pts[0][0]);
    }
    return { a, b, points: pts.length };
  }

  const SIGMA_BLOCK = 32;
  const SIGMA_Q = 0.25;

  function median(arr) {
    arr.sort((p, q) => p - q);
    const m = arr.length >> 1;
    return arr.length & 1 ? arr[m] : (arr[m - 1] + arr[m]) / 2;
  }

  // Noise sigma of one wavelet layer, per channel, from `crops`: pieces of
  // the layer ({ d: Float32Array of w * h * stride values, w, h, stride }).
  // Each SIGMA_BLOCK square gives a robust sigma (median |d| / 0.6745);
  // the SIGMA_Q quantile over all blocks is the noise, since the flattest
  // blocks hold nothing else.
  function estimateSigma(crops, channels) {
    channels = channels || 3;
    const perBlock = Array.from({ length: channels }, () => []);
    for (const c of crops) {
      const stride = c.stride || channels;
      for (let by = 0; by + SIGMA_BLOCK <= c.h; by += SIGMA_BLOCK) {
        for (let bx = 0; bx + SIGMA_BLOCK <= c.w; bx += SIGMA_BLOCK) {
          for (let ch = 0; ch < channels; ch++) {
            const vals = new Float64Array(SIGMA_BLOCK * SIGMA_BLOCK);
            let n = 0;
            for (let y = by; y < by + SIGMA_BLOCK; y++) {
              for (let x = bx; x < bx + SIGMA_BLOCK; x++) vals[n++] = Math.abs(c.d[(y * c.w + x) * stride + ch]);
            }
            perBlock[ch].push(median(vals) / 0.6745);
          }
        }
      }
    }
    return perBlock.map((b) => {
      if (!b.length) return 0;
      b.sort((p, q) => p - q);
      return b[Math.floor((b.length - 1) * SIGMA_Q)];
    });
  }

  // Bilinear demosaic of one pixel, exactly as the shaders' rawCameraAt
  // (edges clamped). `cfa` gives the colour (0 R, 1 G, 2 B) at the 2 x 2
  // cell's (0,0), (1,0), (0,1), (1,1).
  function demosaicAt(plane, w, h, cfa, x, y) {
    const at = (i, j) => plane[Math.min(h - 1, Math.max(0, j)) * w + Math.min(w - 1, Math.max(0, i))];
    const col = (i, j) => cfa[(((j % 2) + 2) % 2) * 2 + (((i % 2) + 2) % 2)];
    const c = col(x, y), here = at(x, y);
    if (c === 1) {
      const horiz = (at(x - 1, y) + at(x + 1, y)) / 2, vert = (at(x, y - 1) + at(x, y + 1)) / 2;
      return col(x - 1, y) === 0 ? [horiz, here, vert] : [vert, here, horiz];
    }
    const diag = (at(x - 1, y - 1) + at(x + 1, y - 1) + at(x - 1, y + 1) + at(x + 1, y + 1)) / 4;
    const orth = (at(x - 1, y) + at(x + 1, y) + at(x, y - 1) + at(x, y + 1)) / 4;
    return c === 0 ? [here, orth, diag] : [diag, orth, here];
  }

  // The noise in each wavelet layer (per opponent channel) of a raw frame
  // after the variance-stabilising transform, where every sensor pixel has
  // independent noise of size 1: simulated once through the same demosaic,
  // opponent split and wavelet as the develop passes. Exact, and unlike a
  // measurement never fooled by texture. `Detail` is detail.js's API.
  let rawSigmaCache = null;
  function rawLevelSigmas(Detail) {
    if (rawSigmaCache) return rawSigmaCache;
    const n = 192, cfa = [1, 0, 2, 1];
    let s = 12345;
    const u = () => { s = (s * 1664525 + 1013904223) >>> 0; return (s + 0.5) / 4294967296; };
    const plane = new Float64Array(n * n).map(() => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u()));
    const img = new Float32Array(n * n * 3);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const c = demosaicAt(plane, n, n, cfa, x, y);
        img.set(Detail.toOpp(c[0], c[1], c[2]), (y * n + x) * 3);
      }
    }
    const { details } = Detail.atrous(img, n, n, Detail.LEVELS);
    // Away from the clamped frame edge.
    const m = 40;
    rawSigmaCache = details.map((d) => [0, 1, 2].map((ch) => {
      let sq = 0, cnt = 0;
      for (let y = m; y < n - m; y++) for (let x = m; x < n - m; x++) { const v = d[(y * n + x) * 3 + ch]; sq += v * v; cnt++; }
      return Math.sqrt(sq / cnt);
    }));
    return rawSigmaCache;
  }

  // A measured layer's luma noise can't sensibly be more than
  // LUMA_STEP_CAP times the next finer layer's: noise loses energy going
  // coarser (white noise by ~0.2x per layer), texture doesn't, so anything
  // above that is image, and thresholding it would flatten real shading.
  // Chroma is left as measured -- a camera JPEG's colour noise really is
  // coarse blotches.
  const LUMA_STEP_CAP = 0.6;
  function capLuma(sigma, finer) {
    if (!finer) return sigma;
    return [Math.min(sigma[0], LUMA_STEP_CAP * finer[0]), sigma[1], sigma[2]];
  }

  // The least noise a camera JPEG's layer is taken to have (display
  // units, per opponent channel). The in-camera processing leaves only a
  // fraction of an 8-bit step of noise in flat areas -- measured on the
  // .insp test files: 0.1-0.6 steps -- and the quantisation makes smooth
  // areas read as exactly flat, so a measurement alone would switch noise
  // reduction off. What is left, and what lifting the shadows brings out,
  // is about a step of grain plus colour blotches that barely weaken at
  // coarser layers.
  const JPEG_STEP = 1 / 255;
  const JPEG_FLOOR = [[1.0, 1.0, 1.0], [0.45, 0.8, 0.8], [0.2, 0.7, 0.7], [0.1, 0.6, 0.6], [0.05, 0.5, 0.5]]
    .map((r) => r.map((v) => v * 1.5 * JPEG_STEP));
  function jpegSigma(k, measured) {
    return measured.map((v, c) => Math.max(v, JPEG_FLOOR[k][c]));
  }

  return {
    vst, vstInverse, fitProfile, fitLine, estimateSigma, chiQuantileRatio, demosaicAt, rawLevelSigmas, capLuma,
    jpegSigma, JPEG_FLOOR,
  };
});
