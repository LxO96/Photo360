(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DevPlan = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Where and how the develop step (noise reduction and sharpening,
  // detail.js) runs, and what graphics memory it takes. Three paths, each
  // the fallback of the one before:
  //
  //   full  -- the GPU develops each lens's whole frame at once: fastest,
  //            but three working copies the size of the frame (RGBA16F,
  //            8 bytes a pixel) plus each lens's result.
  //   tiled -- the same GPU passes over TILE-sized pieces, each with a
  //            HALO of the frame around it, the piece's core copied into
  //            the lens's result. The working copies are tile-sized.
  //   cpu   -- detail.js itself, in tiles, on worker threads; the GPU
  //            holds only the results. Seconds per change, not live.
  //
  // Tiling changes nothing in the result: an output pixel depends on the
  // input no further than reach() away, so a core pixel sees exactly the
  // pixels it would in the whole frame (test/devplan.test.js).

  // How far (px) one output pixel of detail.js develop reaches into the
  // input with `levels` wavelet layers. Layer k's smoothed image c_k
  // reaches 2 (2^k - 1); its coefficient, with the 3 x 3 neighbourhood at
  // step 2^k and the next smoothing (2 * 2^k), another 3 * 2^k. The
  // coarsest layer dominates: 5 * 2^(levels-1) - 2.
  function reach(levels) {
    let r = 2 * ((1 << levels) - 1);
    for (let k = 0; k < levels; k++) r = Math.max(r, 5 * (1 << k) - 2);
    return r;
  }

  // How far the decomposition alone (every layer and the residual, no
  // thresholding) reaches: what measuring the noise needs.
  function decompReach(levels) {
    return 2 * ((1 << levels) - 1);
  }

  const HALO = 80;           // >= reach(5) = 78, even (keeps the CFA phase)
  const MEASURE_HALO = 64;   // >= decompReach(5) = 62
  const GPU_TILE = 1024;
  const CPU_TILE = 768;
  const BYTES_F16 = 8;       // RGBA16F
  // Above this, the whole-frame path is not tried: some GPUs lose the
  // WebGL context outright rather than fail an allocation politely.
  const FULL_BUDGET = 1e9;
  const MEASURE_CROP = 256;

  // The tiles of a w x h frame: `core` (tile x tile, less at the right
  // and top) is what a tile delivers; `region` is the core plus up to
  // `halo` of the frame around it, what the tile develops.
  function tiles(w, h, tile, halo) {
    const out = [];
    for (let y = 0; y < h; y += tile) {
      for (let x = 0; x < w; x += tile) {
        const core = { x, y, w: Math.min(tile, w - x), h: Math.min(tile, h - y) };
        const x0 = Math.max(0, x - halo), y0 = Math.max(0, y - halo);
        const x1 = Math.min(w, x + core.w + halo), y1 = Math.min(h, y + core.h + halo);
        out.push({ core, region: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } });
      }
    }
    return out;
  }

  // Graphics memory (bytes) for developing `lenses` ([{ w, h }], the
  // lenses drawn) on `path`. The CPU path's results are RGBA8 for a JPEG
  // (display values) and RGBA16F for raw (linear values).
  function memory(path, lenses, raw) {
    if (!lenses.length) return 0;
    const out = lenses.reduce((s, l) => s + l.w * l.h, 0);
    const maxW = Math.max(...lenses.map((l) => l.w)), maxH = Math.max(...lenses.map((l) => l.h));
    if (path === 'cpu') return out * (raw ? BYTES_F16 : 4);
    const t = GPU_TILE + 2 * HALO;
    const scratch = path === 'full' ? maxW * maxH : Math.min(maxW, t) * Math.min(maxH, t);
    return (out + 3 * scratch) * BYTES_F16;
  }

  function choosePath(lenses, raw) {
    return memory('full', lenses, raw) <= FULL_BUDGET ? 'full' : 'tiled';
  }

  function fallback(path) {
    return path === 'full' ? 'tiled' : path === 'tiled' ? 'cpu' : null;
  }

  // Five crops inside the image circle for measuring a JPEG's noise:
  // `inner` is measured, `region` is what is decomposed for it.
  function sigmaCrops(w, h) {
    const c = Math.min(MEASURE_CROP, Math.floor(w / 4), Math.floor(h / 4));
    return [[0.5, 0.5], [0.3, 0.5], [0.7, 0.5], [0.5, 0.3], [0.5, 0.7]].map(([fx, fy]) => {
      const inner = { x: Math.round(fx * w - c / 2), y: Math.round(fy * h - c / 2), w: c, h: c };
      const x0 = Math.max(0, inner.x - MEASURE_HALO), y0 = Math.max(0, inner.y - MEASURE_HALO);
      const x1 = Math.min(w, inner.x + c + MEASURE_HALO), y1 = Math.min(h, inner.y + c + MEASURE_HALO);
      return { inner, region: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
    });
  }

  function formatBytes(n) {
    return n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : Math.round(n / 1e6) + ' MB';
  }

  return {
    HALO, MEASURE_HALO, GPU_TILE, CPU_TILE, FULL_BUDGET,
    reach, decompReach, tiles, memory, choosePath, fallback, sigmaCrops, formatBytes,
  };
});
