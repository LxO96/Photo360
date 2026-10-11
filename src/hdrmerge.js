(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HdrMerge = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Merging raw exposure brackets (a still camera, a still scene) into one
  // floating-point CFA plane in the reference frame's units: 1 is the
  // reference frame's white, and the plane reaches hdrMax = t_ref / t_min
  // where only the shortest frame held the light. The reference is the
  // median exposure (the longer middle one for an even count), so the
  // merge has the middle bracket's brightness.
  //
  // Per 2x2 Bayer block, each frame counts with weight t_i (a longer
  // exposure collected more light, so it is cleaner), faded out as the
  // block's brightest sample nears clipping in that frame (KNEE..CLIP) --
  // per block, so a pixel's channels never come from different frames and
  // near-clipped highlights keep their colour. Blocks clipped in every
  // frame take the shortest frame.
  const KNEE = 0.80, CLIP = 0.95;

  // A frame's exposure: shutter time x ISO (in ISO 100 seconds). Brackets
  // may step the ISO as well as the time (the ONE X's do), and the raw
  // values follow the product -- measured on its 2 EV pairs: 3.997x for a
  // predicted 3.990x.
  const exposureOf = (m) => m.exposureTime * ((m.iso > 0 ? m.iso : 100) / 100);
  const second = (m) => String(m.dateTimeOriginal || '').slice(0, 19);
  const sameShot = (a, b) => a.model === b.model && second(a) === second(b) &&
    a.width === b.width && a.height === b.height && String(a.cfaPattern) === String(b.cfaPattern);
  const sameExposure = (a, b) => Math.abs(exposureOf(a) / exposureOf(b) - 1) < 1e-3;

  // items: [{ id, meta }] (meta as Dng.parse gives it). Sets of two or
  // more with distinct exposures (exposureOf), ids in order of exposure; a
  // second photo with an exposure already in the set is left out of it.
  function detectSets(items) {
    const sets = [], used = new Set();
    const usable = (it) => it.meta && it.meta.exposureTime > 0 && second(it.meta);
    for (const it of items) {
      if (used.has(it.id) || !usable(it)) continue;
      const group = [it];
      for (const o of items) {
        if (o === it || used.has(o.id) || !usable(o) || !sameShot(it.meta, o.meta)) continue;
        if (group.some((g) => sameExposure(g.meta, o.meta))) continue;
        group.push(o);
      }
      if (group.length < 2) continue;
      for (const g of group) used.add(g.id);
      sets.push(group.sort((a, b) => exposureOf(a.meta) - exposureOf(b.meta)).map((g) => g.id));
    }
    return sets;
  }

  // Whether these photos (Dng.parse metas) can be merged, and if not, why.
  function canMerge(metas) {
    if (metas.length < 2) return { ok: false, reason: 'Select two or more raw photos of one bracket.' };
    const a = metas[0];
    for (const m of metas) {
      if (!(m.exposureTime > 0)) return { ok: false, reason: 'A photo has no exposure time.' };
      if (m.model !== a.model) return { ok: false, reason: 'The photos are from different cameras.' };
      if (m.width !== a.width || m.height !== a.height || String(m.cfaPattern) !== String(a.cfaPattern)) {
        return { ok: false, reason: 'The photos differ in size.' };
      }
    }
    for (let i = 0; i < metas.length; i++) {
      for (let j = i + 1; j < metas.length; j++) {
        if (sameExposure(metas[i], metas[j])) return { ok: false, reason: 'Two photos have the same exposure.' };
      }
    }
    return { ok: true, reason: '' };
  }

  // The storage key of a merged photo: its members' keys (photos.js keyOf).
  const mergeKey = (keys) => 'HDR|' + [...keys].sort().join('||');

  function referenceIndex(times) {
    const order = times.map((t, i) => i).sort((a, b) => times[a] - times[b]);
    return order[Math.floor(times.length / 2)];
  }

  const smoothstep = (a, b, x) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };

  // frames: [{ plane (Uint16Array, w x h CFA), t (seconds), iso (default
  // 100), black, white }]. Scaling and the reference go by exposure (t x
  // ISO); the noise weight by t alone (the light collected -- ISO only
  // amplifies it).
  function mergePlanes(frames, w, h) {
    const n = frames.length;
    const exps = frames.map((f) => exposureOf({ exposureTime: f.t, iso: f.iso }));
    const ref = referenceIndex(exps);
    const eRef = exps[ref];
    let shortest = 0;
    for (let i = 1; i < n; i++) if (exps[i] < exps[shortest]) shortest = i;
    const hdrMax = eRef / exps[shortest];
    // Sample -> reference units: (v - black) * scale[i].
    const scale = frames.map((f, i) => eRef / (exps[i] * (f.white - f.black)));
    const out = new Float32Array(w * h);
    const weight = new Float64Array(n);
    const idx = new Int32Array(4);
    let count = 0;
    for (let by = 0; by < h; by += 2) {
      for (let bx = 0; bx < w; bx += 2) {
        // The block's samples (fewer at an odd edge).
        count = 0;
        for (let dy = 0; dy < 2 && by + dy < h; dy++) {
          for (let dx = 0; dx < 2 && bx + dx < w; dx++) idx[count++] = (by + dy) * w + bx + dx;
        }
        let total = 0;
        for (let i = 0; i < n; i++) {
          const f = frames[i], span = f.white - f.black;
          let m = 0;
          for (let k = 0; k < count; k++) {
            const v = (f.plane[idx[k]] - f.black) / span;
            if (v > m) m = v;
          }
          weight[i] = (1 - smoothstep(KNEE, CLIP, m)) * f.t;
          total += weight[i];
        }
        for (let k = 0; k < count; k++) {
          const p = idx[k];
          let r = 0;
          if (total > 0) {
            for (let i = 0; i < n; i++) {
              if (weight[i] > 0) r += weight[i] * (frames[i].plane[p] - frames[i].black) * scale[i];
            }
            r /= total;
          } else {
            r = (frames[shortest].plane[p] - frames[shortest].black) * scale[shortest];
          }
          out[p] = r;   // not clamped at 0: noise below black stays, as in the raw path
        }
      }
    }
    return { plane: out, hdrMax, ref };
  }

  return { KNEE, CLIP, exposureOf, detectSets, canMerge, mergeKey, referenceIndex, mergePlanes };
});
