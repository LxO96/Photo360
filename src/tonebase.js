(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ToneBase = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // The local base lightness Highlights and Shadows act on (edge.js
  // applyTone): an edge-aware smooth of each lens frame's lightness, so a
  // region is lifted or pulled as a whole while its texture -- the
  // pixel's offset from the base -- is kept, and a hard edge (a horizon)
  // is followed rather than blurred across, so nothing glows beside it.
  //
  // A fast guided filter (He & Sun), guided by the lightness itself: the
  // frame is averaged in BLOCK x BLOCK blocks, and over a box of radius r
  // (low-res px) around each block the filter fits base = a l + b with
  //   a = var / (var + EPS),  b = mean (1 - a):
  // flat or finely textured areas (var << EPS) get a ~ 0, the local mean;
  // across an edge (var >> EPS) a ~ 1, the pixel itself. a and b are
  // box-averaged again and read back bilinearly at full resolution
  // (sample), so the base follows edges at full sharpness. The GPU passes
  // (gl.js buildToneBase, shaders.js TB_*) mirror this step for step.

  const BLOCK = 4;
  const RADIUS_FRAC = 0.02;   // of the frame's longer side
  // lightness^2: texture well below ~0.05 (skin, fabric) counts as detail
  // and keeps its contrast; busier texture (clouds on blue, leaves on sky)
  // leans toward the per-pixel curve, whose slope brings its contrast out.
  const EPS = 0.003;
  const MAX_RADIUS = 64;      // the box shader's loop bound

  function lowSize(w, h) {
    return { w: Math.ceil(w / BLOCK), h: Math.ceil(h / BLOCK) };
  }

  function radius(lw, lh) {
    return Math.min(MAX_RADIUS, Math.max(1, Math.round(RADIUS_FRAC * Math.max(lw, lh))));
  }

  // Block means of l and l^2 (a partial block at the edge averages what
  // it has). `light` is w x h, row-major.
  function downsample(light, w, h) {
    const s = lowSize(w, h);
    const I = new Float32Array(s.w * s.h), II = new Float32Array(s.w * s.h);
    for (let j = 0; j < s.h; j++) {
      for (let i = 0; i < s.w; i++) {
        let a = 0, b = 0, n = 0;
        for (let y = j * BLOCK; y < Math.min(h, (j + 1) * BLOCK); y++) {
          for (let x = i * BLOCK; x < Math.min(w, (i + 1) * BLOCK); x++) {
            const v = light[y * w + x];
            a += v; b += v * v; n++;
          }
        }
        I[j * s.w + i] = a / n;
        II[j * s.w + i] = b / n;
      }
    }
    return { I, II, w: s.w, h: s.h };
  }

  // Mean over (2r + 1) taps along x (dx = 1) or y, clamped at the edges.
  function box1(src, w, h, r, dx) {
    const out = new Float32Array(src.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let acc = 0;
        for (let k = -r; k <= r; k++) {
          const xx = dx ? Math.min(w - 1, Math.max(0, x + k)) : x;
          const yy = dx ? y : Math.min(h - 1, Math.max(0, y + k));
          acc += src[yy * w + xx];
        }
        out[y * w + x] = acc / (2 * r + 1);
      }
    }
    return out;
  }

  function box(src, w, h, r) {
    return box1(box1(src, w, h, r, 1), w, h, r, 0);
  }

  // The low-res coefficient maps { A, B, w, h } for a w x h lightness frame.
  function build(light, w, h) {
    const d = downsample(light, w, h);
    const r = radius(d.w, d.h);
    const mI = box(d.I, d.w, d.h, r), mII = box(d.II, d.w, d.h, r);
    const a = new Float32Array(mI.length), b = new Float32Array(mI.length);
    for (let i = 0; i < mI.length; i++) {
      const v = Math.max(0, mII[i] - mI[i] * mI[i]);
      a[i] = v / (v + EPS);
      b[i] = mI[i] * (1 - a[i]);
    }
    return { A: box(a, d.w, d.h, r), B: box(b, d.w, d.h, r), w: d.w, h: d.h };
  }

  // [A, B] at full-res position (qx, qy) (pixel units, pixel centres at
  // +0.5), bilinear between block centres and clamped at the edges -- what
  // a LINEAR texture lookup at qx / (BLOCK w) gives.
  function sample(m, qx, qy) {
    const u = qx / BLOCK - 0.5, v = qy / BLOCK - 0.5;
    const x0 = Math.floor(u), y0 = Math.floor(v);
    const fx = u - x0, fy = v - y0;
    const at = (map, x, y) => map[Math.min(m.h - 1, Math.max(0, y)) * m.w + Math.min(m.w - 1, Math.max(0, x))];
    const lerp2 = (map) => {
      const top = at(map, x0, y0) * (1 - fx) + at(map, x0 + 1, y0) * fx;
      const bot = at(map, x0, y0 + 1) * (1 - fx) + at(map, x0 + 1, y0 + 1) * fx;
      return top * (1 - fy) + bot * fy;
    };
    return [lerp2(m.A), lerp2(m.B)];
  }

  return { BLOCK, RADIUS_FRAC, EPS, MAX_RADIUS, lowSize, radius, downsample, box, build, sample };
});
