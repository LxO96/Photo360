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

// -- Scopes overlay (histogram / waveform / vectorscope) -------------------

test('scopes are an overlay, not a panel section', () => {
  assert.ok(!Settings.PANEL_SECTIONS.includes('scopes'));
  assert.ok(Settings.PERSISTED_KEYS.includes('scopesShown'));
});

test('scope modes are persisted and validated as enums', () => {
  assert.ok(Settings.PERSISTED_KEYS.includes('scopeMode'));
  assert.ok(Settings.PERSISTED_KEYS.includes('scopeChannels'));
  const defs = { scopeMode: 'histogram', scopeChannels: 'luma', scopesShown: true };
  const ok = Settings.sanitize(defs, { scopeMode: 'vectorscope', scopeChannels: 'rgb', scopesShown: false });
  assert.strictEqual(ok.scopeMode, 'vectorscope');
  assert.strictEqual(ok.scopeChannels, 'rgb');
  assert.strictEqual(ok.scopesShown, false);
  const bad = Settings.sanitize(defs, { scopeMode: 'polar', scopeChannels: 'parade', scopesShown: 'yes' });
  assert.strictEqual(bad.scopeMode, 'histogram');
  assert.strictEqual(bad.scopeChannels, 'luma');
  assert.strictEqual(bad.scopesShown, true);
  assert.strictEqual(Settings.sanitize(defs, { scopeMode: 'histogram' }).scopeMode, 'histogram');
});

// -- Detail (sharpening / noise reduction) ---------------------------------

test('detail is persisted, clamped, and has its own panel section after Tone', () => {
  assert.ok(Settings.PERSISTED_KEYS.includes('detail'));
  const i = Settings.PANEL_SECTIONS.indexOf('detail');
  assert.strictEqual(Settings.PANEL_SECTIONS[i - 1], 'tone');
  const defs = { detail: { sharpenAmount: 0, sharpenRadius: 1, lumaNoise: 0, colorNoise: 0 } };
  const out = Settings.sanitize(defs,
    { detail: { sharpenAmount: 999, sharpenRadius: 0, lumaNoise: 40, colorNoise: 'x' } });
  assert.deepStrictEqual(out.detail, { sharpenAmount: 150, sharpenRadius: 0.5, lumaNoise: 40, colorNoise: 0 });
  // An older stored blob without detail loads with it off.
  assert.deepStrictEqual(Settings.sanitize(defs, {}).detail, defs.detail);
});

// -- Calibration comes from the camera model only ---------------------------

test('theta-max is not a persisted setting', () => {
  assert.ok(!Settings.PERSISTED_KEYS.includes('thetaMaxDeg'));
  const out = Settings.sanitize({ thetaMaxDeg: 105 }, { thetaMaxDeg: 130 });
  assert.ok(!('thetaMaxDeg' in out) || out.thetaMaxDeg === 105);
});

// -- Double-click reset -------------------------------------------------

test('valueAt reads a dotted path, or undefined when absent', () => {
  const o = { fovDeg: 180, tone: { contrast: 0.2 }, nudgeDeg: { A: -1 } };
  assert.strictEqual(Settings.valueAt(o, 'fovDeg'), 180);
  assert.strictEqual(Settings.valueAt(o, 'tone.contrast'), 0.2);
  assert.strictEqual(Settings.valueAt(o, 'nudgeDeg.A'), -1);
  assert.strictEqual(Settings.valueAt(o, 'tone.nope'), undefined);
  assert.strictEqual(Settings.valueAt(o, 'edge.ringWidth'), undefined);
});

// -- Settings follow the visible lens ---------------------------------------

test('visibleLenses lists the physical lenses on screen, honouring swap', () => {
  const phys = (s, slot) => (s.swap ? (slot === 'A' ? 'B' : 'A') : slot);
  assert.deepStrictEqual(Settings.visibleLenses({ sensors: 'both', swap: false }, phys), ['A', 'B']);
  assert.deepStrictEqual(Settings.visibleLenses({ sensors: 'both', swap: true }, phys), ['A', 'B']);
  assert.deepStrictEqual(Settings.visibleLenses({ sensors: 'A', swap: false }, phys), ['A']);
  assert.deepStrictEqual(Settings.visibleLenses({ sensors: 'A', swap: true }, phys), ['B']);
  assert.deepStrictEqual(Settings.visibleLenses({ sensors: 'B', swap: false }, phys), ['B']);
});
