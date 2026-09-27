'use strict';
// Task 18: pure logic behind the darkroom UI -- persisted section open/closed
// state, editable numeric readouts, and keyboard fine-adjust on sliders.
const test = require('node:test');
const assert = require('node:assert');
const Settings = require('../settings.js');

const DEFAULTS = { panels: { ...Settings.DEFAULT_PANELS } };

test('panels is persisted and every section has a boolean default', () => {
  assert.ok(Settings.PERSISTED_KEYS.includes('panels'));
  assert.deepStrictEqual(Object.keys(Settings.DEFAULT_PANELS), Settings.PANEL_SECTIONS);
  for (const k of Settings.PANEL_SECTIONS) {
    assert.strictEqual(typeof Settings.DEFAULT_PANELS[k], 'boolean');
  }
});

test('sanitize keeps valid stored panel booleans', () => {
  const out = Settings.sanitize(DEFAULTS, { panels: { edge: true, tone: false } });
  assert.strictEqual(out.panels.edge, true);
  assert.strictEqual(out.panels.tone, false);
  assert.strictEqual(out.panels.framing, Settings.DEFAULT_PANELS.framing);
});

test('sanitize rejects non-boolean panel values and unknown sections', () => {
  const out = Settings.sanitize(DEFAULTS,
    { panels: { edge: 'yes', framing: 0, level: null, bogus: true } });
  assert.deepStrictEqual(out.panels, Settings.DEFAULT_PANELS);
  assert.ok(!('bogus' in out.panels));
});

test('sanitize survives a panels value that is not an object', () => {
  for (const bad of [null, 'open', 7, [true, false]]) {
    const out = Settings.sanitize(DEFAULTS, { panels: bad });
    assert.deepStrictEqual(out.panels, Settings.DEFAULT_PANELS);
  }
});

test('sanitize never aliases the default panels object', () => {
  const out = Settings.sanitize(DEFAULTS, null);
  out.panels.edge = !out.panels.edge;
  assert.notStrictEqual(DEFAULTS.panels.edge, out.panels.edge);
});

test('parseReadout parses plain numbers, units, signs and decimal commas', () => {
  const r = [-180, 180];
  assert.strictEqual(Settings.parseReadout('12.5', r, 1), 12.5);
  assert.strictEqual(Settings.parseReadout('  -3.2° ', r, 1), -3.2);
  assert.strictEqual(Settings.parseReadout('+4', r, 1), 4);
  assert.strictEqual(Settings.parseReadout('1,5', r, 1), 1.5);
  assert.strictEqual(Settings.parseReadout('.5', r, 1), 0.5);
  assert.strictEqual(Settings.parseReadout('0.50 EV', [-3, 3], 1), 0.5);
});

test('parseReadout clamps through the given RANGES entry', () => {
  assert.strictEqual(Settings.parseReadout('999', Settings.RANGES.fovDeg, 1), 300);
  // The FOV readout itself clamps through the current calibration's range
  // (Task 19): 2 x theta-max, e.g. 190 for the ONE X.
  assert.strictEqual(Settings.parseReadout('999', require('../lens.js').fovRangeFor(95), 1), 190);
  assert.strictEqual(Settings.parseReadout('-5', Settings.RANGES.fovDeg, 1), 120);
  assert.strictEqual(Settings.parseReadout('20000', Settings.RANGES.rawWb.A.kelvin, 1), 12000);
  assert.strictEqual(Settings.parseReadout('-400', Settings.RANGES.rawWb.A.tint, 1), -150);
});

test('parseReadout applies the display scale (percent sliders)', () => {
  assert.strictEqual(Settings.parseReadout('16%', Settings.RANGES.gapFrac, 100), 0.16);
  assert.strictEqual(Settings.parseReadout('40', Settings.RANGES.marginFrac, 100), 0.25);
});

test('parseReadout returns null for non-numbers', () => {
  for (const bad of ['', 'abc', '-', '.', 'NaN', 'Infinity', null, undefined, 5]) {
    assert.strictEqual(Settings.parseReadout(bad, [0, 1], 1), null, String(bad));
  }
});

test('decimalsForStep handles plain and exponent steps', () => {
  assert.strictEqual(Settings.decimalsForStep('1'), 0);
  assert.strictEqual(Settings.decimalsForStep('0.5'), 1);
  assert.strictEqual(Settings.decimalsForStep('0.00001'), 5);
  assert.strictEqual(Settings.decimalsForStep(1e-7), 7);
});

test('nudgeSliderValue: arrows move 1/200 of the span, snapped to step', () => {
  // fov: 120..210, step 0.5 -> span/200 = 0.45, never less than a step -> 0.5
  assert.strictEqual(Settings.nudgeSliderValue(180, 120, 210, 0.5, 'ArrowRight'), 180.5);
  assert.strictEqual(Settings.nudgeSliderValue(180, 120, 210, 0.5, 'ArrowDown'), 179.5);
  // edgeIntensity: 0..4, step 0.00001 -> 0.02 per press
  assert.strictEqual(Settings.nudgeSliderValue(0.26, 0, 4, 0.00001, 'ArrowUp'), 0.28);
});

test('nudgeSliderValue: Shift is coarse, fine (Ctrl) is fine (never below one step)', () => {
  assert.strictEqual(Settings.nudgeSliderValue(0.26, 0, 4, 0.00001, 'ArrowUp', { shift: true }), 0.46);
  assert.strictEqual(Settings.nudgeSliderValue(0.26, 0, 4, 0.00001, 'ArrowUp', { fine: true }), 0.262);
  assert.strictEqual(Settings.nudgeSliderValue(180, 120, 210, 0.5, 'ArrowUp', { fine: true }), 180.5);
  assert.strictEqual(Settings.nudgeSliderValue(0, -180, 180, 0.1, 'PageUp'), 1);
});

test('nudgeSliderValue clamps to the ends and handles Home/End', () => {
  assert.strictEqual(Settings.nudgeSliderValue(209.8, 120, 210, 0.5, 'ArrowUp', { shift: true }), 210);
  assert.strictEqual(Settings.nudgeSliderValue(-9.95, -10, 10, 0.1, 'ArrowLeft'), -10);
  assert.strictEqual(Settings.nudgeSliderValue(3, 0, 25, 0.5, 'Home'), 0);
  assert.strictEqual(Settings.nudgeSliderValue(3, 0, 25, 0.5, 'End'), 25);
});

test('nudgeSliderValue ignores keys it does not handle', () => {
  assert.strictEqual(Settings.nudgeSliderValue(3, 0, 25, 0.5, 'a'), null);
  assert.strictEqual(Settings.nudgeSliderValue(3, 0, 25, 0.5, 'Tab'), null);
});

test('nudgeSliderValue keeps a usable native step (Camera roll stays at 0.1 deg)', () => {
  assert.strictEqual(Settings.nudgeSliderValue(0, -180, 180, 0.1, 'ArrowRight'), 0.1);
  assert.strictEqual(Settings.nudgeSliderValue(0, -180, 180, 0.1, 'ArrowRight', { fine: true }), 0.1);
});
