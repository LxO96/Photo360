(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Scopes = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Waveform and vectorscope binning. Pure -- no DOM -- so app.js only reads
  // pixels and paints the bins. Input is an RGBA8 buffer (what getImageData
  // returns), treated as gamma-encoded R'G'B' exactly as broadcast scopes do.
  // Bins are plain count arrays; `intensity` turns a count into display
  // brightness.

  const LUMA = [0.2126, 0.7152, 0.0722]; // Rec.709
  const CB_DIV = 2 * (1 - LUMA[2]);      // 1.8556
  const CR_DIV = 2 * (1 - LUMA[0]);      // 1.5748
  // Largest chroma magnitude any in-gamut colour reaches (green/magenta,
  // about 0.596), plus a little room, so the plot never clips.
  const CHROMA_FULL = 0.62;
  // The skin-tone line (the "I" axis) sits at about 123 degrees, Cr up, Cb
  // right -- between the red and yellow targets.
  const SKIN_DEG = 123;

  function chroma(r, g, b) {
    const y = LUMA[0] * r + LUMA[1] * g + LUMA[2] * b;
    return { cb: (b - y) / CB_DIV, cr: (r - y) / CR_DIV };
  }

  // Plot position in a size x size vectorscope; y grows downward (canvas).
  function vectorPoint(c, size) {
    const mid = (size - 1) / 2;
    const k = mid / CHROMA_FULL;
    return { x: mid + c.cb * k, y: mid - c.cr * k };
  }

  function vectorscope(px, w, h, opts) {
    const size = opts.size;
    const include = opts.include;
    const bins = new Uint32Array(size * size);
    const mid = (size - 1) / 2;
    const k = mid / CHROMA_FULL;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (include && !include(x, y)) continue;
        const i = (y * w + x) * 4;
        const r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255;
        const lum = LUMA[0] * r + LUMA[1] * g + LUMA[2] * b;
        const bx = Math.round(mid + ((b - lum) / CB_DIV) * k);
        const by = Math.round(mid - ((r - lum) / CR_DIV) * k);
        if (bx < 0 || by < 0 || bx >= size || by >= size) continue;
        bins[by * size + bx]++;
      }
    }
    return bins;
  }

  // The six 75% colour-bar targets, in the conventional order.
  function targets(size) {
    const bars = [
      ['R', [1, 0, 0]], ['Mg', [1, 0, 1]], ['B', [0, 0, 1]],
      ['Cy', [0, 1, 1]], ['G', [0, 1, 0]], ['Yl', [1, 1, 0]],
    ];
    return bars.map(([name, rgb]) => {
      const p = vectorPoint(chroma(rgb[0] * 0.75, rgb[1] * 0.75, rgb[2] * 0.75), size);
      return { name, x: p.x, y: p.y };
    });
  }

  function skinLine(size) {
    const mid = (size - 1) / 2;
    const a = SKIN_DEG * Math.PI / 180;
    return { x1: mid, y1: mid, x2: mid + Math.cos(a) * mid, y2: mid - Math.sin(a) * mid };
  }

  // Column-by-column level histogram. Level 0 is black (the bottom of the
  // plot). mode 'luma' gives one channel; 'parade' gives R, G and B.
  function waveform(px, w, h, opts) {
    const levels = opts.levels;
    const include = opts.include;
    const parade = opts.mode === 'parade';
    const channels = parade
      ? [new Uint32Array(w * levels), new Uint32Array(w * levels), new Uint32Array(w * levels)]
      : [new Uint32Array(w * levels)];
    const top = levels - 1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (include && !include(x, y)) continue;
        const i = (y * w + x) * 4;
        if (parade) {
          for (let c = 0; c < 3; c++) {
            channels[c][Math.round(px[i + c] / 255 * top) * w + x]++;
          }
        } else {
          const lum = (LUMA[0] * px[i] + LUMA[1] * px[i + 1] + LUMA[2] * px[i + 2]) / 255;
          channels[0][Math.round(lum * top) * w + x]++;
        }
      }
    }
    return { cols: w, levels, channels };
  }

  // Predicate for "pixel (x, y) lies inside one of these circles", tested
  // at the pixel centre. Used to leave the black surround out of the scopes.
  function insideCircles(circles) {
    return (x, y) => {
      const px = x + 0.5, py = y + 0.5;
      for (const c of circles) {
        const dx = px - c.cx, dy = py - c.cy;
        if (dx * dx + dy * dy <= c.radius * c.radius) return true;
      }
      return false;
    };
  }

  // Display brightness for a bin: logarithmic, so sparse traces stay visible
  // next to dense ones; `ref` is the count that reaches full brightness.
  function intensity(count, ref) {
    if (count <= 0) return 0;
    return Math.min(1, Math.log1p(count) / Math.log1p(Math.max(1, ref)));
  }

  return {
    LUMA, chroma, vectorPoint, vectorscope, targets, skinLine,
    waveform, insideCircles, intensity,
  };
});
