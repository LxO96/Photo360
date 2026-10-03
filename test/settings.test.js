'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Settings = require('../settings.js');
// gl.js expects a global Lens (browser <script> load order); dragSign's
// tests exercise it together with the real GL.physicalLens, not a stand-in,
// so a regression to reading the slot label instead of the physical lens
// inside gl.js itself would also be caught here.
const Lens = require('../lens.js');
global.Lens = Lens;
const GL = require('../gl.js');

const DEFAULTS = {
  fovDeg: 180, thetaMaxDeg: 105,
  rollDeg: 0,
  nudgeDeg: { A: 0, B: 0 },
  sensors: 'A', swap: false,
  orientation: 'side',
  gapFrac: 0, marginFrac: 0,
  background: [0, 0, 0],
  sourceName: 'ignored.insp', sourceLensSize: 6000,
  edge: { edgeIntensity: 0.26, ringWidth: 0.004, dispersion: 0.002 },
  tone: { exposureEv: 0, contrast: 0, saturation: 0 },
};

// A fake localStorage: same get/set/throw shape, no browser needed.
function fakeStorage(initial) {
  const map = new Map(initial ? Object.entries(initial) : []);
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
    map,
  };
}

test('sanitize falls back to defaults when stored is null', () => {
  const out = Settings.sanitize(DEFAULTS, null);
  assert.strictEqual(out.fovDeg, 180);
  assert.deepStrictEqual(out.nudgeDeg, { A: 0, B: 0 });
  assert.deepStrictEqual(out.edge, DEFAULTS.edge);
});

test('sanitize excludes sourceName and sourceLensSize entirely', () => {
  const out = Settings.sanitize(DEFAULTS, { sourceName: 'evil.insp', sourceLensSize: 1 });
  assert.strictEqual('sourceName' in out, false);
  assert.strictEqual('sourceLensSize' in out, false);
});

test('sanitize keeps valid stored values', () => {
  const stored = { fovDeg: 190.5, rollDeg: -12.5, sensors: 'both', swap: true };
  const out = Settings.sanitize(DEFAULTS, stored);
  assert.strictEqual(out.fovDeg, 190.5);
  assert.strictEqual(out.rollDeg, -12.5);
  assert.strictEqual(out.sensors, 'both');
  assert.strictEqual(out.swap, true);
});

test('sanitize rejects an enum value outside the allowed set', () => {
  const out = Settings.sanitize(DEFAULTS, { sensors: 'C', orientation: 'diagonal' });
  assert.strictEqual(out.sensors, 'A');
  assert.strictEqual(out.orientation, 'side');
});

test('sanitize rejects non-finite numbers (NaN, Infinity, strings)', () => {
  const out = Settings.sanitize(DEFAULTS, { fovDeg: NaN, rollDeg: Infinity, gapFrac: '0.1' });
  assert.strictEqual(out.fovDeg, 180);
  assert.strictEqual(out.rollDeg, 0);
  assert.strictEqual(out.gapFrac, 0);
});

test('a stored edge of null does not wipe out the default edge object', () => {
  const out = Settings.sanitize(DEFAULTS, { edge: null });
  assert.deepStrictEqual(out.edge, DEFAULTS.edge);
});

test('a stored edge missing one key keeps the default for that key only', () => {
  const out = Settings.sanitize(DEFAULTS, { edge: { edgeIntensity: 0.9 } });
  assert.strictEqual(out.edge.edgeIntensity, 0.9);
  assert.strictEqual(out.edge.ringWidth, DEFAULTS.edge.ringWidth);
  assert.strictEqual(out.edge.dispersion, DEFAULTS.edge.dispersion);
});

test('a stored nudgeDeg with one bad field keeps the good one', () => {
  const out = Settings.sanitize(DEFAULTS, { nudgeDeg: { A: 3.5, B: 'nope' } });
  assert.strictEqual(out.nudgeDeg.A, 3.5);
  assert.strictEqual(out.nudgeDeg.B, 0);
});

test('a stored background array of the wrong length is rejected wholesale', () => {
  const out = Settings.sanitize(DEFAULTS, { background: [1, 1] });
  assert.deepStrictEqual(out.background, [0, 0, 0]);
});

test('a stored background array with one bad channel keeps the others', () => {
  const out = Settings.sanitize(DEFAULTS, { background: [0.5, 'x', 0.2] });
  assert.deepStrictEqual(out.background, [0.5, 0, 0.2]);
});

test('serialize picks exactly the persisted keys, in order', () => {
  const state = { ...DEFAULTS, rollDeg: 5 };
  const out = Settings.serialize(state);
  assert.deepStrictEqual(Object.keys(out), Settings.PERSISTED_KEYS);
  assert.strictEqual(out.rollDeg, 5);
  assert.strictEqual('sourceName' in out, false);
});

test('save then load round-trips a valid state', () => {
  const storage = fakeStorage();
  const state = { ...DEFAULTS, rollDeg: 42, sensors: 'both' };
  Settings.save(state, storage);
  const loaded = Settings.load(DEFAULTS, storage);
  assert.strictEqual(loaded.rollDeg, 42);
  assert.strictEqual(loaded.sensors, 'both');
});

test('load falls back to defaults when the key is absent', () => {
  const loaded = Settings.load(DEFAULTS, fakeStorage());
  assert.deepStrictEqual(loaded, Settings.sanitize(DEFAULTS, null));
});

test('load falls back to defaults when the stored JSON is unparseable', () => {
  const storage = fakeStorage({ [Settings.STORAGE_KEY]: '{not json' });
  const loaded = Settings.load(DEFAULTS, storage);
  assert.deepStrictEqual(loaded, Settings.sanitize(DEFAULTS, null));
});

test('load falls back to defaults, without throwing, when edge is corrupted to null', () => {
  const storage = fakeStorage({ [Settings.STORAGE_KEY]: '{"edge":null}' });
  const loaded = Settings.load(DEFAULTS, storage);
  assert.deepStrictEqual(loaded.edge, DEFAULTS.edge);
  assert.strictEqual(loaded.fovDeg, 180);
});

test('load never throws even when storage access itself throws', () => {
  const storage = {
    getItem: () => { throw new Error('SecurityError'); },
    setItem: () => { throw new Error('SecurityError'); },
  };
  assert.doesNotThrow(() => Settings.load(DEFAULTS, storage));
  const loaded = Settings.load(DEFAULTS, storage);
  assert.deepStrictEqual(loaded, Settings.sanitize(DEFAULTS, null));
});

test('save never throws even when storage.setItem throws', () => {
  const storage = { setItem: () => { throw new Error('QuotaExceededError'); } };
  assert.doesNotThrow(() => Settings.save(DEFAULTS, storage));
});

// -- drag-to-roll angle maths --------------------------------------------

test('normalizeAngleDeltaDeg leaves small deltas unchanged', () => {
  assert.strictEqual(Settings.normalizeAngleDeltaDeg(10), 10);
  assert.strictEqual(Settings.normalizeAngleDeltaDeg(-10), -10);
});

test('normalizeAngleDeltaDeg collapses the +-180 wraparound to a small delta', () => {
  // Pointer swept from +179 to -179: a raw diff of -358 should read as +2.
  assert.strictEqual(Settings.normalizeAngleDeltaDeg(-358), 2);
  assert.strictEqual(Settings.normalizeAngleDeltaDeg(358), -2);
});

test('rollForDrag applies the delta directly for lens A (sign +1)', () => {
  assert.strictEqual(Settings.rollForDrag(10, 1, 5), 15);
});

test('rollForDrag negates the delta for lens B (sign -1), so it follows the pointer', () => {
  assert.strictEqual(Settings.rollForDrag(10, -1, 5), 5);
});

test('rollForDrag clamps to +-180', () => {
  assert.strictEqual(Settings.rollForDrag(170, 1, 30), 180);
  assert.strictEqual(Settings.rollForDrag(-170, -1, 30), -180);
});

// -- dragSign: the sign selection app.js's pointerdown handler must call
// directly, not re-derive. All four slot x swap combinations, checking the
// resolved physical lens and its sign together -- the bug this pins is
// precisely those two disagreeing (a slot's sign coming from its label
// instead of the physical lens the swap put behind it).
test('dragSign: slot A, swap off -> physical A, sign +1', () => {
  const state = { swap: false };
  assert.deepStrictEqual(Settings.dragSign(state, 'A', GL.physicalLens), { physical: 'A', sign: 1 });
});

test('dragSign: slot B, swap off -> physical B, sign -1', () => {
  const state = { swap: false };
  assert.deepStrictEqual(Settings.dragSign(state, 'B', GL.physicalLens), { physical: 'B', sign: -1 });
});

test('dragSign: slot A, swap on -> physical B, sign -1', () => {
  const state = { swap: true };
  assert.deepStrictEqual(Settings.dragSign(state, 'A', GL.physicalLens), { physical: 'B', sign: -1 });
});

test('dragSign: slot B, swap on -> physical A, sign +1', () => {
  const state = { swap: true };
  assert.deepStrictEqual(Settings.dragSign(state, 'B', GL.physicalLens), { physical: 'A', sign: 1 });
});

// -- range validation ------------------------------------------------------

test('an out-of-range finite number clamps into its RANGES domain instead of passing through', () => {
  const out = Settings.sanitize(DEFAULTS, { fovDeg: 99999, gapFrac: 5, rollDeg: 1e12 });
  assert.strictEqual(out.fovDeg, 300);  // RANGES.fovDeg is the superset over every calibration (Task 19)
  assert.strictEqual(out.gapFrac, 0.25);
  assert.strictEqual(out.rollDeg, 180);
});

test('a negative-going out-of-range number clamps to the low bound', () => {
  const out = Settings.sanitize(DEFAULTS, { fovDeg: -50, rollDeg: -1e9 });
  assert.strictEqual(out.fovDeg, 120);
  assert.strictEqual(out.rollDeg, -180);
});

test('range clamping applies inside nested objects (edge, tone, nudgeDeg)', () => {
  const out = Settings.sanitize(DEFAULTS, {
    edge: { edgeIntensity: 999, ringWidth: -1 },
    tone: { exposureEv: 50, contrast: -50 },
    nudgeDeg: { A: 999, B: -999 },
  });
  assert.strictEqual(out.edge.edgeIntensity, 4);
  assert.strictEqual(out.edge.ringWidth, 0.002);
  assert.strictEqual(out.tone.exposureEv, 3);
  assert.strictEqual(out.tone.contrast, -1);
  assert.strictEqual(out.nudgeDeg.A, 10);
  assert.strictEqual(out.nudgeDeg.B, -10);
});

test('a value within range is left untouched by clamping', () => {
  const out = Settings.sanitize(DEFAULTS, { fovDeg: 190.5, rollDeg: -12.5 });
  assert.strictEqual(out.fovDeg, 190.5);
  assert.strictEqual(out.rollDeg, -12.5);
});

test('NaN and Infinity are still rejected outright (not clamped)', () => {
  const out = Settings.sanitize(DEFAULTS, { fovDeg: NaN, rollDeg: Infinity, gapFrac: -Infinity });
  assert.strictEqual(out.fovDeg, DEFAULTS.fovDeg);
  assert.strictEqual(out.rollDeg, DEFAULTS.rollDeg);
  assert.strictEqual(out.gapFrac, DEFAULTS.gapFrac);
});

test('a wrong-typed value still falls back to the default without disturbing siblings', () => {
  const out = Settings.sanitize(DEFAULTS, { edge: { edgeIntensity: '9999', ringWidth: 0.01 } });
  assert.strictEqual(out.edge.edgeIntensity, DEFAULTS.edge.edgeIntensity);
  assert.strictEqual(out.edge.ringWidth, 0.01);
});

test('an unknown enum value still falls back to the default', () => {
  const out = Settings.sanitize(DEFAULTS, { sensors: 'nope', orientation: 'upsidedown' });
  assert.strictEqual(out.sensors, DEFAULTS.sensors);
  assert.strictEqual(out.orientation, DEFAULTS.orientation);
});

test('background channels clamp to 0..1', () => {
  const out = Settings.sanitize(DEFAULTS, { background: [5, -5, 0.5] });
  assert.deepStrictEqual(out.background, [1, 0, 0.5]);
});

// -- Task 17: rawWb (Kelvin/tint) persistence -----------------------------
// DEFAULTS above predates rawWb (it was never given a rawWhiteBalance entry
// either -- neither is exercised by the generic tests above), so these
// tests build their own defaults with the shape settings.js actually uses.
const WB_DEFAULTS = {
  ...DEFAULTS,
  rawWb: { A: { kelvin: 6500, tint: 0 }, B: { kelvin: 6500, tint: 0 } },
  rawWbLinked: true,
};

test('sanitize keeps a valid stored rawWb', () => {
  const out = Settings.sanitize(WB_DEFAULTS, {
    rawWb: { A: { kelvin: 5200, tint: -30 }, B: { kelvin: 4800, tint: 10 } },
  });
  assert.deepStrictEqual(out.rawWb, {
    A: { kelvin: 5200, tint: -30 }, B: { kelvin: 4800, tint: 10 },
  });
});

test('sanitize clamps rawWb kelvin/tint into their RANGES domain', () => {
  const out = Settings.sanitize(WB_DEFAULTS, {
    rawWb: { A: { kelvin: 99999, tint: 9999 }, B: { kelvin: -50, tint: -9999 } },
  });
  assert.strictEqual(out.rawWb.A.kelvin, 12000);
  assert.strictEqual(out.rawWb.A.tint, 150);
  assert.strictEqual(out.rawWb.B.kelvin, 2000);
  assert.strictEqual(out.rawWb.B.tint, -150);
});

test('sanitize falls back to defaults when rawWb is missing or malformed', () => {
  const out = Settings.sanitize(WB_DEFAULTS, { rawWb: null });
  assert.deepStrictEqual(out.rawWb, WB_DEFAULTS.rawWb);
  const out2 = Settings.sanitize(WB_DEFAULTS, { rawWb: { A: { kelvin: 'nope' } } });
  assert.strictEqual(out2.rawWb.A.kelvin, WB_DEFAULTS.rawWb.A.kelvin);
  assert.strictEqual(out2.rawWb.B.kelvin, WB_DEFAULTS.rawWb.B.kelvin);
});

test('an old stored blob using Task 16\'s rawWhiteBalance key is ignored, not crashed on', () => {
  const storage = fakeStorage({
    [Settings.STORAGE_KEY]: JSON.stringify({
      fovDeg: 175, rawWhiteBalance: { A: [0.5, 1, 0.6], B: [0.5, 1, 0.6] },
    }),
  });
  assert.doesNotThrow(() => Settings.load(WB_DEFAULTS, storage));
  const loaded = Settings.load(WB_DEFAULTS, storage);
  assert.strictEqual(loaded.fovDeg, 175);
  assert.deepStrictEqual(loaded.rawWb, WB_DEFAULTS.rawWb);
  assert.strictEqual('rawWhiteBalance' in loaded, false);
});

// -- Swap + single-lens fix -------------------------------------------------
test('resolveSwapForLoad forces swap off for a 1:1 (single-lens) file', () => {
  assert.strictEqual(Settings.resolveSwapForLoad(true, 1), false);
  assert.strictEqual(Settings.resolveSwapForLoad(false, 1), false);
});

test('resolveSwapForLoad leaves swap untouched for a dual (or not-yet-loaded) file', () => {
  assert.strictEqual(Settings.resolveSwapForLoad(true, 2), true);
  assert.strictEqual(Settings.resolveSwapForLoad(false, 2), false);
  assert.strictEqual(Settings.resolveSwapForLoad(true, 0), true);
});

test('rawWb round-trips through save/load', () => {
  const storage = fakeStorage();
  const state = { ...WB_DEFAULTS, rawWb: { A: { kelvin: 3200, tint: 40 }, B: { kelvin: 7500, tint: -15 } } };
  Settings.save(state, storage);
  const loaded = Settings.load(WB_DEFAULTS, storage);
  assert.deepStrictEqual(loaded.rawWb, state.rawWb);
});

test('sanitize clones nested rawWb defaults instead of aliasing them', () => {
  const defaults = { rawWb: { A: { kelvin: 5000, tint: 0 }, B: { kelvin: 5000, tint: 0 } } };
  const out = Settings.sanitize(defaults, {});
  assert.notStrictEqual(out.rawWb.A, defaults.rawWb.A);
  assert.deepStrictEqual(out.rawWb.A, defaults.rawWb.A);
});

// Task 19: the four new Tone sliders.
test('an old stored tone without highlights/shadows/whites/blacks loads them at 0', () => {
  const defs = { ...DEFAULTS, tone: { exposureEv: 0, contrast: 0, saturation: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0 } };
  const out = Settings.sanitize(defs, { tone: { exposureEv: 1.5, contrast: 0.2, saturation: -0.1 } });
  assert.deepStrictEqual(out.tone, {
    exposureEv: 1.5, contrast: 0.2, saturation: -0.1, highlights: 0, shadows: 0, whites: 0, blacks: 0,
  });
});

test('the four new Tone sliders persist and clamp to -100..100', () => {
  const defs = { ...DEFAULTS, tone: { exposureEv: 0, contrast: 0, saturation: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0 } };
  const out = Settings.sanitize(defs, { tone: { highlights: -40, shadows: 999, whites: -999, blacks: 'x' } });
  assert.strictEqual(out.tone.highlights, -40);
  assert.strictEqual(out.tone.shadows, 100);
  assert.strictEqual(out.tone.whites, -100);
  assert.strictEqual(out.tone.blacks, 0);
});

// Sun glare: a photo's sun is one of its edits, sanitized like the rest.
test('sun is persisted and sanitized: status enum, strength range, dir and tint shapes', () => {
  const defaults = { sun: { on: true, status: 'pending', dir: [0, 0, 1], strength: 1, tint: [1, 1, 1] } };
  assert.ok(Settings.PERSISTED_KEYS.includes('sun'));
  const s = Settings.sanitize(defaults, { sun: { on: false, status: 'bogus', dir: [0.6, 0, 0.8], strength: 9, tint: [1, 0.8] } }).sun;
  assert.deepStrictEqual(s, { on: false, status: 'pending', dir: [0.6, 0, 0.8], strength: 2, tint: [1, 1, 1] });
  assert.strictEqual(Settings.sanitize(defaults, { sun: { status: 'manual' } }).sun.status, 'manual');
});

test('film settings: persisted, enums and ranges validated', () => {
  const defaults = { film: { stock: 'off', gauge: '35', grain: 1, halation: 0.5 } };
  assert.ok(Settings.PERSISTED_KEYS.includes('film'));
  const ok = Settings.sanitize(defaults, { film: { stock: 'portrait160', gauge: 's16', grain: 1.5, halation: 0.2 } });
  assert.deepStrictEqual(ok.film, { stock: 'portrait160', gauge: 's16', grain: 1.5, halation: 0.2 });
  const bad = Settings.sanitize(defaults, { film: { stock: 'kodak', gauge: '70', grain: 9, halation: -1 } });
  assert.deepStrictEqual(bad.film, { stock: 'off', gauge: '35', grain: 2, halation: 0 });
  assert.deepStrictEqual(Settings.ENUMS.stock, ['off', 'golden200', 'verdant400', 'portrait160', 'classic400bw', 'smooth400bw']);
  assert.deepStrictEqual(Settings.ENUMS.gauge, ['s8', 's16', '35', '120']);
});
