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
  const PERSISTED_KEYS = [
    'fovDeg', 'thetaMaxDeg', 'rollDeg', 'nudgeDeg', 'sensors', 'swap',
    'orientation', 'gapFrac', 'marginFrac', 'background', 'edge', 'tone',
  ];

  const ENUMS = { sensors: ['A', 'B', 'both'], orientation: ['side', 'stacked'] };

  function isFiniteNumber(v) { return typeof v === 'number' && Number.isFinite(v); }

  // Merge one field of untrusted stored JSON (`val`) over the matching
  // default (`def`), recursing into plain objects and fixed-length arrays.
  // Any value that doesn't match the *shape* of its default -- wrong type,
  // NaN/Infinity, an enum outside its allowed set, a missing sub-key -- is
  // replaced by the default for that leaf, not the whole object, so a
  // stored blob missing (or corrupting) one field can't take out its
  // siblings. `key` is only used to look up enum constraints.
  function mergeValue(def, val, key) {
    if (ENUMS[key]) {
      return (typeof val === 'string' && ENUMS[key].includes(val)) ? val : def;
    }
    if (typeof def === 'boolean') {
      return typeof val === 'boolean' ? val : def;
    }
    if (isFiniteNumber(def)) {
      return isFiniteNumber(val) ? val : def;
    }
    if (Array.isArray(def)) {
      if (!Array.isArray(val) || val.length !== def.length) return def.slice();
      return def.map((dv, i) => (isFiniteNumber(val[i]) ? val[i] : dv));
    }
    if (def && typeof def === 'object') {
      if (!val || typeof val !== 'object') return { ...def };
      const out = {};
      for (const k of Object.keys(def)) out[k] = mergeValue(def[k], val[k], k);
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
      out[key] = mergeValue(defaults[key], stored && typeof stored === 'object' ? stored[key] : undefined, key);
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

  return {
    STORAGE_KEY, PERSISTED_KEYS, sanitize, serialize, save, load,
    normalizeAngleDeltaDeg, rollForDrag,
  };
});
