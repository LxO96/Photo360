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
  // applyLoadedDescriptor);  a stored value only ever surfaces before any file (or a
  // non-raw file) is loaded. rawWbLinked is a plain preference with no such
  // override. An old stored blob's `rawWhiteBalance` key (Task 16's shape)
  // is simply not in this list any more, so sanitize() below never looks at
  // it -- it is silently ignored rather than crashing anything.
  const PERSISTED_KEYS = [
    'fovDeg', 'rollDeg', 'nudgeDeg', 'sensors', 'swap',
    'orientation', 'gapFrac', 'marginFrac', 'background', 'edge', 'tone', 'detail',
    'rawWb', 'rawWbLinked', 'panels', 'scopesShown', 'scopeMode', 'scopeChannels', 'scopeScale',
    'keyLayout', 'jpegWb', 'stripShown', 'sun', 'film',
  ];

  // Task 18: the side panel's collapsible sections, in display order, and
  // whether each starts open. `panels` in the render state is a plain
  // {section: boolean} object persisted through PERSISTED_KEYS like any
  // other preference -- sanitize()'s boolean branch rejects anything that is
  // not a real boolean (falling back to this default for that one section)
  // and drops keys not listed here, so a corrupt or stale blob can never
  // hide a section for good or invent a new one. Edge starts closed: its
  // seven fitted parameters are the most specialised controls on the page
  // and the X1-classic preset is the intended starting point.
  // edgeAdjust: the Edge panel's sliders, under the look gallery.
  const PANEL_SECTIONS = ['framing', 'level', 'whiteBalance', 'edge', 'edgeAdjust', 'tone', 'detail', 'film', 'output'];
  const DEFAULT_PANELS = {
    framing: true, level: true, whiteBalance: true, edge: false, edgeAdjust: false, tone: true, detail: true, film: true, output: true,
  };

  const ENUMS = {
    sensors: ['A', 'B', 'both'], orientation: ['side', 'stacked'],
    scopeMode: ['histogram', 'waveform', 'vectorscope'], scopeChannels: ['luma', 'rgb'],
    keyLayout: ['standard', 'swedish'],
    // sun.status: not looked for yet, found, placed by hand, looked for and none.
    status: ['pending', 'auto', 'manual', 'none'],
    // Film simulation (film.js): the stock ('off' first) and the gauge.
    stock: ['off', 'portrait160', 'golden200', 'vivid100', 'pastel400', 'verdant400', 'tungsten800',
      'classic400bw', 'smooth400bw'],
    gauge: ['s8', 's16', '35', '120'],
  };

  // Single source of truth for the valid domain of every numeric field.
  // Shaped like the state itself so mergeValue can walk both trees together.
  // Keep these in sync with the matching <input min max> in index.html --
  // there is no shared source at build time (no build step), so a slider's
  // range and this table are two places that must agree by hand:
  //   fovDeg 120..300 (a superset; the slider's own max is dynamic), rollDeg -180..180, nudgeDeg.A/B -10..10,
  //   gapFrac/marginFrac 0..0.25 (the 0-25% sliders), edge.edgeIntensity
  //   0..4, edge.ringWidth 0.002..0.06, edge.dispersion 0..0.05,
  //   edge.glowSpreadDeg 0..45, edge.highlightKnee 0..1,
  //   edge.falloffStart 0.6..0.99, edge.falloffSoftness 0.3..4,
  //   tone.exposureEv -3..3, tone.contrast/saturation -1..1,
  //   tone.highlights/shadows/whites/blacks -100..100.
  // thetaMaxDeg (set only from the camera model, never persisted) and the
  // five edge keys with no slider (highlightExponent,
  // hazeWidth, hazeStrength, terminatorDesaturate, terminatorCoolShift) have
  // no UI control to mirror; their bounds below are chosen generously around
  // the fitted X1-classic preset (see edge.js PRESETS.x1classic) so a
  // corrupt-but-plausible stored value can't push the renderer somewhere the
  // UI would never let a person reach, without pretending to know a tighter
  // "correct" range than the preset-fitting task established.
  const RANGES = {
    // Task 19: the FOV slider's max is 2 x the current theta-max (set by
    // app.js via Lens.fovRangeFor), so this is the superset over the whole
    // thetaMaxDeg range below -- test/slider-ranges.test.js holds it there.
    fovDeg: [120, 300],
    thetaMaxDeg: [60, 150],
    rollDeg: [-180, 180],
    nudgeDeg: { A: [-10, 10], B: [-10, 10] },
    gapFrac: [0, 0.25],
    marginFrac: [0, 0.25],
    background: [0, 1],
    // The scopes overlay's zoom factor (1 = the 320px box).
    scopeScale: [0.75, 2.5],
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
      // Rim looks (edge.js LOOKS): no slider.
      castColor: [0, 2],
      fringeColor: [0, 1],
      fringeStrength: [0, 1],
      fringeWidth: [0.002, 0.15],
      ringSun: [0, 1],
    },
    tone: {
      exposureEv: [-3, 3], contrast: [-1, 1], saturation: [-1, 1],
      // Task 19: the luminance-curve sliders (Edge.toneCurve).
      highlights: [-100, 100], shadows: [-100, 100], whites: [-100, 100], blacks: [-100, 100],
    },
    // Sun glare (edge.js sunGlare): Strength 0-200%, a unit direction, a tint.
    sun: { strength: [0, 2], dir: [-1, 1], tint: [0, 1] },
    // Film simulation: Grain 0-200 %, Halation 0-100.
    film: { grain: [0, 2], halation: [0, 1] },
    // Sharpening and noise reduction (detail.js).
    detail: {
      sharpenAmount: [0, 150], sharpenRadius: [0.5, 2], lumaNoise: [0, 100], colorNoise: [0, 100],
    },
    // Task 17: Kelvin/tint replaces the raw red/blue multipliers. Matches
    // Wb.KELVIN_MIN/MAX and Wb.TINT_MAX exactly.
    rawWb: {
      A: { kelvin: [2000, 12000], tint: [-150, 150] },
      B: { kelvin: [2000, 12000], tint: [-150, 150] },
    },
    // JPEG / .insp white balance (jpegwb.js): relative, 0 = as shot.
    jpegWb: {
      A: { temp: [-100, 100], tint: [-100, 100] },
      B: { temp: [-100, 100], tint: [-100, 100] },
    },
  };

  // The value at a dotted path ('tone.contrast', 'nudgeDeg.A') in a state-
  // shaped object, or undefined if any step is missing. app.js uses it to
  // find a slider's default for double-click reset.
  function valueAt(obj, path) {
    let v = obj;
    for (const k of path.split('.')) {
      if (!v || typeof v !== 'object' || !(k in v)) return undefined;
      v = v[k];
    }
    return v;
  }

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
  // The physical lenses currently on screen -- what the lens-specific
  // controls (nudge, white balance) are shown for. Like dragSign, goes
  // through the injected GL.physicalLens so swap is honoured.
  // The scopes overlay's scale, clamped to RANGES.scopeScale and so the box
  // (boxW x boxH at scale 1) takes at most SCOPE_MAX_STAGE_SHARE of the
  // stage's width and height. The range minimum wins over the stage limit,
  // so a tiny window still gets a usable box.
  const SCOPE_MAX_STAGE_SHARE = 0.6;
  function fitScopeScale(scale, boxW, boxH, stageW, stageH) {
    const [lo, hi] = RANGES.scopeScale;
    const room = Math.min(stageW * SCOPE_MAX_STAGE_SHARE / boxW, stageH * SCOPE_MAX_STAGE_SHARE / boxH);
    return Math.max(lo, Math.min(hi, room, scale));
  }

  function visibleLenses(state, physicalLensFn) {
    if (state.sensors === 'both') return ['A', 'B'];
    return [physicalLensFn(state, state.sensors)];
  }

  function resolveSwapForLoad(currentSwap, lensCount) {
    return lensCount === 1 ? false : currentSwap;
  }

  // -- Editable readouts and keyboard fine-adjust (Task 18) ----------------
  // Pure helpers behind app.js's typed numeric readouts and slider arrow
  // keys, kept here so the parsing/clamping rules are unit-testable
  // without a DOM.

  // Parses what a person typed into a readout (in the readout's *display*
  // units -- e.g. percent for gap/margin, where `scale` is 100) and returns
  // the value in state units, clamped through `range` (a Settings.RANGES
  // entry). Tolerates surrounding whitespace, a trailing unit ("12 %",
  // "180°", "0.5 EV"), a leading "+", and a decimal comma. Returns null for
  // anything that does not start with a number, so the caller can revert
  // the readout instead of applying NaN.
  function parseReadout(text, range, scale) {
    if (typeof text !== 'string') return null;
    const m = text.trim().replace(',', '.').match(/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i);
    if (!m) return null;
    const v = parseFloat(m[0]) / (scale || 1);
    return Number.isFinite(v) ? clamp(v, range) : null;
  }

  // Number of decimals a range input's step can express (0.005 -> 3).
  function decimalsForStep(step) {
    const s = String(step);
    if (/e-/i.test(s)) return parseInt(s.split(/e-/i)[1], 10);
    const i = s.indexOf('.');
    return i === -1 ? 0 : s.length - i - 1;
  }

  // Keyboard fine-adjust for a focused slider, in the slider's own units.
  // Several sliders carry a very fine `step` (0.00001, so fitted presets
  // are representable -- see index.html), which makes the browser's native
  // one-step-per-arrow useless; instead one arrow press on such a slider moves
  // 1/200th of its span (others move one native step), Shift moves 10x that, and
  // `mods.fine` moves 1/10th of it (down to a single step) for fine work.
  // app.js maps Ctrl or Alt to `fine` -- Ctrl is the one to document, since
  // Alt+Left is Back in Windows browsers. PageUp/Down are the coarse
  // (Shift) move, Home/End jump to the ends. The result is
  // snapped to the step grid and clamped to [min, max]. Returns null for
  // keys this does not handle, so the caller leaves those alone.
  function nudgeSliderValue(value, min, max, step, key, mods) {
    mods = mods || {};
    let dir = 0, coarse = !!mods.shift;
    if (key === 'ArrowUp' || key === 'ArrowRight') dir = 1;
    else if (key === 'ArrowDown' || key === 'ArrowLeft') dir = -1;
    else if (key === 'PageUp') { dir = 1; coarse = true; }
    else if (key === 'PageDown') { dir = -1; coarse = true; }
    else if (key === 'Home') return min;
    else if (key === 'End') return max;
    else return null;
    step = step > 0 ? step : (max - min) / 1000;
    // Only sliders whose step is too fine to be usable (under 1/5000 of the
    // span, i.e. the fitted Edge presets) get the 1/200-span move; a slider
    // with a workable native step (Camera roll at 0.1 deg) keeps it.
    let delta = step >= (max - min) / 5000 ? step : (max - min) / 200;
    if (coarse) delta *= 10;
    else if (mods.fine) delta = Math.max(step, delta / 10);
    let v = value + dir * delta;
    v = min + Math.round((v - min) / step) * step;
    const d = Math.min(12, decimalsForStep(step) + 2);
    v = parseFloat(v.toFixed(d));
    return Math.min(max, Math.max(min, v));
  }

  return {
    valueAt, visibleLenses, fitScopeScale, STORAGE_KEY, PERSISTED_KEYS, RANGES, ENUMS, PANEL_SECTIONS, DEFAULT_PANELS,
    sanitize, serialize, save, load,
    normalizeAngleDeltaDeg, rollForDrag, dragSign, resolveSwapForLoad,
    parseReadout, decimalsForStep, nudgeSliderValue,
  };
});
