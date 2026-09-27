(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Settings = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const STORAGE_KEY = 'photo360.settings.v1';

  // Fields of the canonical render state that are persisted. sourceName and
  // sourceLensSize describe the loaded file, not a user preference, and are
  // deliberately excluded -- reloading a stored blob must never resurrect a
  // stale filename with no matching pixels behind it.
  // rawWb/rawWbLinked (Task 17, replacing Task 16's raw red/blue
  // multipliers) are per-lens white-balance state, now expressed as
  // Kelvin/tint: rawWb is a genuine per-file value that a freshly loaded
  // raw file's own AsShotNeutral always overwrites on load (app.js
  // applyLoadedDescriptor), the same precedence thetaMaxDeg already has
  // above; a stored value only ever surfaces before any file (or a
  // non-raw file) is loaded. rawWbLinked is a plain preference with no such
  // override. An old stored blob's `rawWhiteBalance` key (Task 16's shape)
  // is simply not in this list any more, so sanitize() below never looks at
  // it -- it is silently ignored rather than crashing anything.
  const PERSISTED_KEYS = [
    'fovDeg', 'thetaMaxDeg', 'rollDeg', 'nudgeDeg', 'sensors', 'swap',
    'orientation', 'gapFrac', 'marginFrac', 'background', 'edge', 'tone',
    'rawWb', 'rawWbLinked',
  ];

  const ENUMS = { sensors: ['A', 'B', 'both'], orientation: ['side', 'stacked'] };

  // Single source of truth for the valid domain of every numeric field.
  // Shaped like the state itself so mergeValue can walk both trees together.
  // Keep these in sync with the matching <input min max> in index.html --
  // there is no shared source at build time (no build step), so a slider's
  // range and this table are two places that must agree by hand:
  //   fovDeg 120..210, rollDeg -180..180, nudgeDeg.A/B -10..10,
  //   gapFrac/marginFrac 0..0.25 (the 0-25% sliders), edge.edgeIntensity
  //   0..4, edge.ringWidth 0.002..0.06, edge.dispersion 0..0.05,
  //   edge.glowSpreadDeg 0..45, edge.highlightKnee 0..1,
  //   edge.falloffStart 0.6..0.99, edge.falloffSoftness 0.3..4,
  //   tone.exposureEv -3..3, tone.contrast/saturation -1..1.
  // thetaMaxDeg and the five edge keys with no slider (highlightExponent,
  // hazeWidth, hazeStrength, terminatorDesaturate, terminatorCoolShift) have
  // no UI control to mirror; their bounds below are chosen generously around
  // the fitted X1-classic preset (see edge.js PRESETS.x1classic) so a
  // corrupt-but-plausible stored value can't push the renderer somewhere the
  // UI would never let a person reach, without pretending to know a tighter
  // "correct" range than the preset-fitting task established.
  const RANGES = {
    fovDeg: [120, 210],
    thetaMaxDeg: [60, 150],
    rollDeg: [-180, 180],
    nudgeDeg: { A: [-10, 10], B: [-10, 10] },
    gapFrac: [0, 0.25],
    marginFrac: [0, 0.25],
    background: [0, 1],
    edge: {
      edgeIntensity: [0, 4],
      ringWidth: [0.002, 0.06],
      dispersion: [0, 0.05],
      glowSpreadDeg: [0, 45],
      highlightKnee: [0, 1],
      highlightExponent: [0.5, 8],
      falloffStart: [0.6, 0.99],
      falloffSoftness: [0.3, 4],
      hazeWidth: [0, 0.3],
      hazeStrength: [0, 4],
      terminatorDesaturate: [0, 1],
      terminatorCoolShift: [0, 1],
    },
    tone: { exposureEv: [-3, 3], contrast: [-1, 1], saturation: [-1, 1] },
    // Task 17: Kelvin/tint replaces the raw red/blue multipliers. Matches
    // Wb.KELVIN_MIN/MAX and Wb.TINT_MAX exactly.
    rawWb: {
      A: { kelvin: [2000, 12000], tint: [-150, 150] },
      B: { kelvin: [2000, 12000], tint: [-150, 150] },
    },
  };

  function isFiniteNumber(v) { return typeof v === 'number' && Number.isFinite(v); }

  function clamp(v, range) {
    return range ? Math.min(range[1], Math.max(range[0], v)) : v;
  }

  // Merge one field of untrusted stored JSON (`val`) over the matching
  // default (`def`), recursing into plain objects and fixed-length arrays.
  // Any value that doesn't match the *shape* of its default -- wrong type,
  // NaN/Infinity, an enum outside its allowed set, a missing sub-key -- is
  // replaced by the default for that leaf, not the whole object, so a
  // stored blob missing (or corrupting) one field can't take out its
  // siblings. A finite number outside its RANGES entry is clamped rather
  // than accepted outright, so a corrupt-but-plausible value (a fovDeg of
  // 99999, a negative gapFrac) can't reach GL.compositionLayout or the
  // shaders unchecked. `key` looks up enum constraints; `range` is this
  // field's slice of RANGES, threaded down from the caller since a plain
  // key lookup can't tell `edge.ringWidth` from `tone.contrast`.
  function mergeValue(def, val, key, range) {
    if (ENUMS[key]) {
      return (typeof val === 'string' && ENUMS[key].includes(val)) ? val : def;
    }
    if (typeof def === 'boolean') {
      return typeof val === 'boolean' ? val : def;
    }
    if (isFiniteNumber(def)) {
      return isFiniteNumber(val) ? clamp(val, range) : def;
    }
    if (Array.isArray(def)) {
      if (!Array.isArray(val) || val.length !== def.length) return def.slice();
      return def.map((dv, i) => (isFiniteNumber(val[i]) ? clamp(val[i], range) : dv));
    }
    if (def && typeof def === 'object') {
      // Recurse even when nothing is stored, so nested defaults (rawWb.A/B) are
      // cloned rather than aliased.
      if (!val || typeof val !== 'object') val = {};
      const out = {};
      for (const k of Object.keys(def)) {
        out[k] = mergeValue(def[k], val[k], k, range && range[k]);
      }
      return out;
    }
    return def;
  }

  // Returns a full, valid settings object: every field of `defaults`,
  // overridden field-by-field by whatever in `stored` passes validation.
  // `stored` may be anything -- null, a stray primitive, an object missing
  // half its keys, one whose `edge` is literally `null` -- sanitize never
  // throws and never omits a key `defaults` has.
  function sanitize(defaults, stored) {
    const out = {};
    for (const key of PERSISTED_KEYS) {
      out[key] = mergeValue(
        defaults[key],
        stored && typeof stored === 'object' ? stored[key] : undefined,
        key, RANGES[key]);
    }
    return out;
  }

  function serialize(state) {
    const out = {};
    for (const key of PERSISTED_KEYS) out[key] = state[key];
    return out;
  }

  // Persists every field of `state` except sourceName/sourceLensSize. Never
  // throws: a full/disabled/absent storage must not break the caller.
  function save(state, storage) {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(serialize(state)));
    } catch (e) { /* quota exceeded, storage disabled, etc. -- ignore */ }
  }

  // Loads and sanitizes the stored settings, falling back silently to
  // `defaults` (merged through the same sanitize pass, so the return shape
  // is identical either way) if the key is missing, the JSON is
  // unparseable, or storage access itself throws (e.g. a locked-down
  // file:// profile).
  function load(defaults, storage) {
    let raw = null;
    try {
      raw = storage.getItem(STORAGE_KEY);
    } catch (e) { /* storage inaccessible -- fall through to defaults */ }
    if (!raw) return sanitize(defaults, null);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) { return sanitize(defaults, null); }
    return sanitize(defaults, parsed);
  }

  // -- Drag-to-roll angle maths --------------------------------------------
  // Pure helpers factored out of the pointer handlers in app.js so the sign
  // flip for lens B and the wraparound/clamp logic can be unit tested
  // without a DOM.

  // Normalizes an angle difference (degrees) to (-180, 180], so a drag that
  // crosses the +180/-180 seam registers as a small delta instead of a
  // ~360 degree jump.
  function normalizeAngleDeltaDeg(deltaDeg) {
    return ((deltaDeg + 180) % 360 + 360) % 360 - 180;
  }

  // The new state.rollDeg for a drag that has swept `deltaDeg` (raw, not yet
  // normalized) since pointerdown, starting from `startRollDeg`. `sign` is
  // +1 for lens A, -1 for lens B -- lens B's applied roll is the negation of
  // state.rollDeg (see Lens.rollFor), so without this flip the circle would
  // spin opposite the pointer under a plain drag.
  function rollForDrag(startRollDeg, sign, deltaDeg) {
    const delta = normalizeAngleDeltaDeg(deltaDeg);
    return Math.max(-180, Math.min(180, startRollDeg + sign * delta));
  }

  // The one place that decides which way a grabbed circle's roll runs. Takes
  // the physical-lens lookup (GL.physicalLens in the running app) as an
  // injected function so this stays DOM/GL-free and testable in isolation --
  // but the point of extracting it is that app.js's pointerdown handler must
  // call exactly this, not re-derive the sign inline, so this decision has
  // exactly one implementation to regress. `slotLens` is the output slot the
  // pointer landed on ('A' or 'B' from GL.compositionLayout); the sign must
  // come from the *physical* lens that slot currently shows (which the swap
  // can make different from the slot label), never from the slot label
  // itself -- that mismatch is the bug an earlier task found and fixed in
  // GL.circleDraw, and this is the same trap for drag-to-roll.
  function dragSign(state, slotLens, physicalLensFn) {
    const physical = physicalLensFn(state, slotLens);
    return { physical, sign: physical === 'B' ? -1 : 1 };
  }

  // Swap + single-lens fix (Task 17, closing the final review's residual
  // finding): a 1:1 file has no lens B to swap in, so `swap` must never be
  // left on for one -- otherwise `sensors` gets forced to 'A' (see
  // app.js's applyLoadedDescriptor) while `swap` still points
  // lensTextureIndex at the released slot 1 (GL.physicalLens/circleDraw),
  // rendering no circle and exporting a blank `_B_` image. Pulled out as a
  // pure function -- like dragSign above -- purely so app.js's load patch
  // has exactly one implementation of this decision to regress, and it is
  // unit-testable without a DOM. For a dual (or not-yet-loaded) file,
  // `swap` is left exactly as it was.
  function resolveSwapForLoad(currentSwap, lensCount) {
    return lensCount === 1 ? false : currentSwap;
  }

  return {
    STORAGE_KEY, PERSISTED_KEYS, RANGES, sanitize, serialize, save, load,
    normalizeAngleDeltaDeg, rollForDrag, dragSign, resolveSwapForLoad,
  };
});
