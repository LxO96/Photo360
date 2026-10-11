'use strict';
// GL.circleDraw's raw-source sensor-rotation composition (Task 16 fix
// round, Finding 1). Lives in its own file rather than test/gl.test.js:
// that file already exists and this task's operating instructions say not
// to modify any existing test file -- only to add to test/dng.test.js or a
// new file. This is a new file, covering the same function (GL.circleDraw)
// that test/gl.test.js already tests, specifically for the new
// state.sensorRotationDeg term.
const test = require('node:test');
const assert = require('node:assert');
const Lens = require('../src/lens.js');
global.Lens = Lens;
const GL = require('../src/gl.js');

// Insta360 ONE X raw frames are stored 90 degrees off from how the camera's
// own JPEG pipeline presents them; the two lenses are back-to-back, so they
// need *opposite* corrections -- the same mirrored relationship rollDeg
// already has between physical lens A (+) and B (-) via Lens.rollFor.

// Sign verified in the browser against all three supplied raw files (see
// the task report): physical lens A needs -90, physical lens B needs +90
// for both circles to render upright at rollDeg=0. This was found
// empirically, not derived -- an initial +90/-90 assignment (physical A
// visually "on top" of the stacked composition) rendered *both* circles
// upside down, which only makes sense if the visual top slot is actually
// backed by physical B by default, not physical A as first assumed.

test('a raw source composes sensorRotationDeg on top of rollFor, mirrored between physical lenses', () => {
  const state = { rollDeg: 0, nudgeDeg: { A: 0, B: 0 }, swap: false, sensorRotationDeg: 90 };
  assert.strictEqual(GL.circleDraw(state, 'A').rollDeg, -90);
  assert.strictEqual(GL.circleDraw(state, 'B').rollDeg, 90);
});

test('the user\'s roll (and nudge) adds on top of the sensor term for both lenses', () => {
  const state = { rollDeg: 15, nudgeDeg: { A: 1, B: -2 }, swap: false, sensorRotationDeg: 90 };
  // Lens.rollFor gives A: rollDeg + nudgeDeg.A = 16, B: -rollDeg + nudgeDeg.B = -17.
  assert.strictEqual(GL.circleDraw(state, 'A').rollDeg, 16 - 90);
  assert.strictEqual(GL.circleDraw(state, 'B').rollDeg, -17 + 90);
});

test('the sensor term follows the physical lens, not the slot, under swap', () => {
  const state = { rollDeg: 0, nudgeDeg: { A: 0, B: 0 }, swap: true, sensorRotationDeg: 90 };
  // Under swap, slot A shows physical B (gets +90) and slot B shows
  // physical A (gets -90) -- the opposite of the unswapped case above,
  // exactly mirroring how circleDraw already resolves texIndex/roll by
  // physical lens rather than by slot label.
  const drawA = GL.circleDraw(state, 'A');
  const drawB = GL.circleDraw(state, 'B');
  assert.strictEqual(drawA.texIndex, 1);
  assert.strictEqual(drawA.rollDeg, 90);
  assert.strictEqual(drawB.texIndex, 0);
  assert.strictEqual(drawB.rollDeg, -90);
});

test('a JPEG/.insp source (sensorRotationDeg absent) is unaffected', () => {
  const state = { rollDeg: 15, nudgeDeg: { A: 1, B: -2 }, swap: false };
  assert.strictEqual(GL.circleDraw(state, 'A').rollDeg, 16);
  assert.strictEqual(GL.circleDraw(state, 'B').rollDeg, -17);
});

test('an explicit sensorRotationDeg of 0 (non-raw sources set this explicitly) is a no-op', () => {
  const state = { rollDeg: 15, nudgeDeg: { A: 1, B: -2 }, swap: false, sensorRotationDeg: 0 };
  assert.strictEqual(GL.circleDraw(state, 'A').rollDeg, 16);
  assert.strictEqual(GL.circleDraw(state, 'B').rollDeg, -17);
});

// The levelling guide overlay (app.js drawGuides) must use Lens.rollFor
// directly, NOT GL.circleDraw(...).rollDeg -- circleDraw's rollDeg is the
// *total* rotation actually applied to the pixels (the user's roll/nudge
// plus the fixed raw sensor-orientation correction), which is exactly right
// for rendering but wrong for the guide: the guide represents the user's
// own levelling, and a raw source's fixed sensor correction is not
// something the user did. These pin that distinction directly against the
// two real call sites (GL.circleDraw for rendering, Lens.rollFor for the
// guide) rather than against app.js's DOM-dependent drawGuides itself.
test('render rotation and the pure user-roll (what the guide must use) differ by exactly the sensor term', () => {
  const state = { rollDeg: 15, nudgeDeg: { A: 1, B: -2 }, swap: false, sensorRotationDeg: 90 };
  const renderA = GL.circleDraw(state, 'A').rollDeg;
  const renderB = GL.circleDraw(state, 'B').rollDeg;
  const guideA = Lens.rollFor(state, GL.physicalLens(state, 'A'));
  const guideB = Lens.rollFor(state, GL.physicalLens(state, 'B'));
  assert.strictEqual(renderA - guideA, -90);
  assert.strictEqual(renderB - guideB, 90);
  // At the user's rollDeg=0, the guide must therefore be exactly 0 (plus
  // nudge) regardless of sensorRotationDeg -- horizontal on an upright
  // image -- which is the concrete behaviour this bug broke.
  const level = { rollDeg: 0, nudgeDeg: { A: 0, B: 0 }, swap: false, sensorRotationDeg: 90 };
  assert.strictEqual(Lens.rollFor(level, GL.physicalLens(level, 'A')), 0);
  assert.strictEqual(Lens.rollFor(level, GL.physicalLens(level, 'B')), 0);
});

test('with no sensor rotation, render rotation and the guide rotation are identical', () => {
  const state = { rollDeg: 15, nudgeDeg: { A: 1, B: -2 }, swap: false, sensorRotationDeg: 0 };
  assert.strictEqual(
    GL.circleDraw(state, 'A').rollDeg,
    Lens.rollFor(state, GL.physicalLens(state, 'A')));
  assert.strictEqual(
    GL.circleDraw(state, 'B').rollDeg,
    Lens.rollFor(state, GL.physicalLens(state, 'B')));
});
