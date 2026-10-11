(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SunDetect = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Finding the sun for the rim's sun glare (edge.js sunGlare), and where
  // it is relative to each lens.
  //
  // Positions are in a lens's "luv" space: the lens texture coordinates the
  // composite samples through (shaders.js lensUv), the image circle centred
  // at (0.5, 0.5) with radius 0.5 at thetaMax. A direction is a unit vector
  // in the camera frame: lens A looks along +z, lens B along -z with its
  // azimuths mirrored (back to back, lens.js rollFor). Raw frames sit 90
  // degrees off upright in luv space (gl.js circleDraw's sensor term);
  // `upDeg` undoes that so both lenses share one frame.

  const LUMA = [0.2126, 0.7152, 0.0722];
  const MIN_PEAK = 0.95;       // nothing this bright: no sun
  const CLIP_FRAC = 0.98;      // the sun's pixels: within 2% of the peak
  const MAX_AREA = 0.02;       // of the image circle; more is sky or a wall
  const MIN_PX = 12;           // at 256 px a lens; less is a glint
  const MIN_COMPACT = 0.4;     // area over its enclosing circle's; less is a railing or an edge

  // lenses: [{ lens: 'A'|'B', w, h, rgb: Float32Array(w*h*3) }], each over
  // its whole image circle in luv space (row 0 = v 0). Display-encoded
  // values; above 1 where a merged HDR photo recovered the light.
  // -> { lens, x, y, radius (luv), peak, tint: [r, g, b] } or null.
  //
  // The sun is the brightest thing there is, so its pixels are those
  // within 2% of the peak: clipped white in a JPEG or a single raw frame,
  // where many things clip; in a merged HDR photo only what clipped even in
  // the darkest frame. Of those, the sun is the largest compact blob: not a
  // glint (too small), a white railing or wall edge (not compact), or a
  // blown-out sky (too large).
  function detect(lenses) {
    let peak = -1;
    const lumas = lenses.map((L) => {
      const n = L.w * L.h, lum = new Float32Array(n), cx = L.w / 2, cy = L.h / 2, r2 = (L.w / 2) ** 2;
      for (let j = 0; j < L.h; j++) {
        for (let i = 0; i < L.w; i++) {
          const k = j * L.w + i;
          if ((i + 0.5 - cx) ** 2 + (j + 0.5 - cy) ** 2 > r2) { lum[k] = -1; continue; }
          const o = k * 3;
          lum[k] = LUMA[0] * L.rgb[o] + LUMA[1] * L.rgb[o + 1] + LUMA[2] * L.rgb[o + 2];
          if (lum[k] > peak) peak = lum[k];
        }
      }
      return lum;
    });
    if (peak < MIN_PEAK) return null;
    const t = CLIP_FRAC * peak;
    let best = null;
    lenses.forEach((L, li) => {
      const lum = lumas[li], seen = new Uint8Array(lum.length);
      const maxArea = MAX_AREA * Math.PI * (L.w / 2) * (L.h / 2);
      for (let k = 0; k < lum.length; k++) {
        if (seen[k] || lum[k] < t) continue;
        const blob = component(lum, L.w, L.h, k, t, seen);
        if (blob.length < MIN_PX || blob.length > maxArea) continue;
        if (best && blob.length <= best.blob.length) continue;
        let cx = 0, cy = 0;
        for (const q of blob) { cx += (q % L.w) + 0.5; cy += Math.floor(q / L.w) + 0.5; }
        cx /= blob.length; cy /= blob.length;
        let rmax = 0;
        for (const q of blob) rmax = Math.max(rmax, Math.hypot((q % L.w) + 0.5 - cx, Math.floor(q / L.w) + 0.5 - cy));
        if (blob.length / (Math.PI * (rmax + 0.5) ** 2) < MIN_COMPACT) continue;
        best = { L, lum, blob };
      }
    });
    if (!best) return null;
    const { L, lum, blob } = best;
    let sw = 0, sx = 0, sy = 0;
    for (const k of blob) {
      const w = lum[k];
      sw += w; sx += w * ((k % L.w) + 0.5); sy += w * (Math.floor(k / L.w) + 0.5);
    }
    const px = sx / sw, py = sy / sw;
    const rPx = Math.max(1, Math.sqrt(blob.length / Math.PI));
    return {
      lens: L.lens, x: px / L.w, y: py / L.h, radius: rPx / L.w, peak,
      tint: tintAround(L, lum, px, py, rPx, t),
    };
  }

  // The 8-connected pixels >= t around `seed`, marked in `seen`.
  function component(lum, w, h, seed, t, seen) {
    const out = [], stack = [seed];
    seen[seed] = 1;
    while (stack.length) {
      const k = stack.pop();
      out.push(k);
      const i = k % w, j = (k - i) / w;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const x = i + di, y = j + dj;
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          const q = y * w + x;
          if (!seen[q] && lum[q] >= t) { seen[q] = 1; stack.push(q); }
        }
      }
    }
    return out;
  }

  // Mean colour of the unclipped pixels 1.5-3 sun radii out, normalised to
  // max 1, 80% of the way to white: a hint of the light's colour.
  function tintAround(L, lum, px, py, rPx, clip) {
    const r0 = 1.5 * rPx, r1 = Math.max(3 * rPx, r0 + 2);
    const c = [0, 0, 0];
    let n = 0;
    for (let j = Math.max(0, Math.floor(py - r1)); j < Math.min(L.h, Math.ceil(py + r1)); j++) {
      for (let i = Math.max(0, Math.floor(px - r1)); i < Math.min(L.w, Math.ceil(px + r1)); i++) {
        const k = j * L.w + i, d = Math.hypot(i + 0.5 - px, j + 0.5 - py);
        if (d < r0 || d > r1 || lum[k] < 0 || lum[k] >= clip) continue;
        for (let ch = 0; ch < 3; ch++) c[ch] += L.rgb[k * 3 + ch];
        n++;
      }
    }
    const m = Math.max(c[0], c[1], c[2]);
    if (!n || !(m > 0)) return [1, 1, 1];
    return c.map((v) => 0.2 * v / m + 0.8);
  }

  // Which lens is blacked out (a lens cap, a covered lens) -- nearly black
  // over its image circle while the other one is not -- or null. Same
  // frames as detect; app.js shows the other lens alone when a photo opens.
  const BLACK_MEAN = 0.02, LIT_MEAN = 0.06;
  function blackLens(lenses) {
    if (lenses.length !== 2) return null;
    const means = lenses.map((L) => {
      const cx = L.w / 2, cy = L.h / 2, r2 = (L.w / 2) ** 2;
      let sum = 0, n = 0;
      for (let j = 0; j < L.h; j++) {
        for (let i = 0; i < L.w; i++) {
          if ((i + 0.5 - cx) ** 2 + (j + 0.5 - cy) ** 2 > r2) continue;
          const o = (j * L.w + i) * 3;
          sum += LUMA[0] * L.rgb[o] + LUMA[1] * L.rgb[o + 1] + LUMA[2] * L.rgb[o + 2];
          n++;
        }
      }
      return n ? sum / n : 0;
    });
    for (let k = 0; k < 2; k++) {
      if (means[k] < BLACK_MEAN && means[1 - k] >= LIT_MEAN) return lenses[k].lens;
    }
    return null;
  }

  const RAD = Math.PI / 180;

  // The sensor rotation lens `physical` needs undone (gl.js circleDraw).
  function upTermDeg(state, physical) {
    const s = state.sensorRotationDeg || 0;   // 0 - s: never -0
    return physical === 'A' ? 0 - s : s;
  }

  // Luv position (x, y) on lens `lensId` -> unit direction.
  function dirOf(lensId, x, y, thetaMaxDeg, upDeg) {
    const dx = x - 0.5, dy = y - 0.5;
    const theta = 2 * Math.hypot(dx, dy) * thetaMaxDeg * RAD;
    const alpha = Math.atan2(dy, dx) - upDeg * RAD;
    const s = Math.sin(theta);
    const d = [s * Math.cos(alpha), s * Math.sin(alpha), Math.cos(theta)];
    return lensId === 'A' ? d : [-d[0], d[1], -d[2]];
  }

  // Direction -> where it is seen from lens `lensId`: theta from the lens
  // axis and alpha, the luv-space azimuth (radians).
  function viewOf(dir, lensId, upDeg) {
    const d = lensId === 'A' ? dir : [-dir[0], dir[1], -dir[2]];
    return {
      theta: Math.acos(Math.max(-1, Math.min(1, d[2]))),
      alpha: Math.atan2(d[1], d[0]) + upDeg * RAD,
    };
  }

  return { MIN_PEAK, MAX_AREA, detect, blackLens, upTermDeg, dirOf, viewOf };
});
