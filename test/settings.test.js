'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Settings = require('../settings.js');

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
