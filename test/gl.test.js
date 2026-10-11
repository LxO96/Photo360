'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Lens = require('../src/lens.js');
// gl.js expects a global `Lens` (as it has in the browser, via <script> load
// order) since it calls Lens.rollFor from circleDraw.
global.Lens = Lens;
const GL = require('../src/gl.js');

test('physicalLens returns the slot label unchanged when not swapped', () => {
  assert.strictEqual(GL.physicalLens({ swap: false }, 'A'), 'A');
  assert.strictEqual(GL.physicalLens({ swap: false }, 'B'), 'B');
});

test('physicalLens returns the other lens label when swapped', () => {
  assert.strictEqual(GL.physicalLens({ swap: true }, 'A'), 'B');
  assert.strictEqual(GL.physicalLens({ swap: true }, 'B'), 'A');
});

// circleDraw is the single call renderComposition makes per circle to
// decide both which texture to bind and what roll to apply. Texture and
// roll must always agree on which physical lens they came from -- that is
// exactly what regressed when the roll was looked up by slot label while
// the texture was looked up by physical lens (under swap, those disagree).
// These assertions check both together, per slot, per swap setting, so a
// regression to the old `Lens.rollFor(state, c.lens)` call breaks them.
test('the left slot shows lens A rolled as lens A when not swapped', () => {
  const state = { rollDeg: 15, nudgeDeg: { A: 1, B: -2 }, swap: false };
  assert.deepStrictEqual(GL.circleDraw(state, 'A'), { texIndex: 0, rollDeg: 16 });
});

test('the right slot shows lens B rolled as lens B when not swapped', () => {
  const state = { rollDeg: 15, nudgeDeg: { A: 1, B: -2 }, swap: false };
  assert.deepStrictEqual(GL.circleDraw(state, 'B'), { texIndex: 1, rollDeg: -17 });
});

test('the left slot shows lens B rolled as lens B when swapped', () => {
  const state = { rollDeg: 15, nudgeDeg: { A: 1, B: -2 }, swap: true };
  assert.deepStrictEqual(GL.circleDraw(state, 'A'), { texIndex: 1, rollDeg: -17 });
});

test('the right slot shows lens A rolled as lens A when swapped', () => {
  const state = { rollDeg: 15, nudgeDeg: { A: 1, B: -2 }, swap: true };
  assert.deepStrictEqual(GL.circleDraw(state, 'B'), { texIndex: 0, rollDeg: 16 });
});

// -- Task 19: preview placement (fill the stage / zoom) ---------------------
const PLACE_STATE = { sensors: 'both', orientation: 'side', gapFrac: 0.16, marginFrac: 0.08, swap: false };

test('placedLayout without a place is exactly compositionLayout (the export path)', () => {
  assert.deepStrictEqual(GL.placedLayout(PLACE_STATE, 1200, 600),
    GL.compositionLayout(PLACE_STATE, 1200, 600));
});

test('placedLayout lays the composition out in `place`, offset into the target', () => {
  const place = { x: -3000, y: -500, w: 11904, h: 5952 };
  const got = GL.placedLayout(PLACE_STATE, 1800, 1000, place);
  const ref = GL.compositionLayout(PLACE_STATE, place.w, place.h);
  for (let i = 0; i < ref.circles.length; i++) {
    assert.strictEqual(got.circles[i].cx, ref.circles[i].cx + place.x);
    assert.strictEqual(got.circles[i].cy, ref.circles[i].cy + place.y);
    assert.strictEqual(got.circles[i].radius, ref.circles[i].radius);
    assert.strictEqual(got.circles[i].lens, ref.circles[i].lens);
  }
});

test('cellViewport without clipping is the unclipped cell (export unchanged)', () => {
  const v = GL.cellViewport({ cx: 50, cy: 50, radius: 100 }, 400, 300, false);
  const cell = Math.round(200 * (1 + 2 * GL.GLOW_HEADROOM));
  assert.deepStrictEqual(v.cell, cell);
  assert.deepStrictEqual([v.vx, v.vy], [Math.round(50 - cell / 2), Math.round(300 - 50 - cell / 2)]);
  assert.deepStrictEqual(v.viewport, [v.vx, v.vy, cell, cell]);
});

test('cellViewport with clipping keeps the cell origin but clips the viewport to the target', () => {
  // A 100%-zoom circle much larger than the canvas: the viewport must never
  // exceed the framebuffer (or MAX_VIEWPORT_DIMS), while uCellOrigin/uCellSize
  // (vx, vy, cell) still describe the whole cell so the shader's geometry is
  // unchanged.
  const v = GL.cellViewport({ cx: 900, cy: 500, radius: 2500 }, 1800, 1000, true);
  assert.ok(v.vx < 0 && v.vy < 0 && v.cell > 5000);
  assert.deepStrictEqual(v.viewport, [0, 0, 1800, 1000]);
});

test('cellViewport with clipping reports an off-target cell as empty', () => {
  const v = GL.cellViewport({ cx: -5000, cy: 500, radius: 100 }, 1800, 1000, true);
  assert.strictEqual(v.viewport, null);
});

// Sun glare (spec 2026-10-02-sun-glare-design): the per-lens uniform.
test('sunUniform: off, not found, or not detected yet -> strength 0', () => {
  global.SunDetect = require('../src/sundetect.js');
  global.Edge = require('../src/edge.js');
  const base = { thetaMaxDeg: 105, sensorRotationDeg: 0 };
  assert.strictEqual(GL.sunUniform(base, 'A')[2], 0);
  const sun = { on: false, status: 'auto', dir: [0, 0, 1], strength: 1, tint: [1, 1, 1] };
  assert.strictEqual(GL.sunUniform(Object.assign({ sun }, base), 'A')[2], 0);
  for (const status of ['pending', 'none']) {
    assert.strictEqual(GL.sunUniform(Object.assign({ sun: Object.assign({}, sun, { on: true, status }) }, base), 'A')[2], 0);
  }
});

test('sunView: the sun from a lens whatever the glare switch; unknown when not found', () => {
  const SunDetect = require('../src/sundetect.js');
  const state = { thetaMaxDeg: 105, sensorRotationDeg: 0 };
  const dir = SunDetect.dirOf('A', 0.7, 0.4, 105, 0);
  state.sun = { on: false, status: 'manual', dir, strength: 0, tint: [1, 1, 1] };
  const v = GL.sunView(state, 'A'), w = SunDetect.viewOf(dir, 'A', 0);
  assert.deepStrictEqual(v, [w.theta, w.alpha, 1]);
  state.sun.status = 'none';
  assert.deepStrictEqual(GL.sunView(state, 'A'), [0, 0, 0]);
});

test('sunUniform: where the sun is from each physical lens, in luv azimuth', () => {
  const SunDetect = require('../src/sundetect.js');
  const state = { thetaMaxDeg: 105, sensorRotationDeg: 90 };
  const dir = SunDetect.dirOf('A', 0.7, 0.4, 105, SunDetect.upTermDeg(state, 'A'));
  state.sun = { on: true, status: 'auto', dir, strength: 1.5, tint: [1, 1, 1] };
  const a = GL.sunUniform(state, 'A');
  const back = SunDetect.viewOf(dir, 'A', -90);
  assert.ok(Math.abs(a[0] - back.theta) < 1e-12 && Math.abs(a[1] - back.alpha) < 1e-12);
  assert.strictEqual(a[2], 1.5);
  assert.strictEqual(a[3], 105);
  assert.ok(GL.sunUniform(state, 'B')[0] > Math.PI / 2);
});

test('film shaders: the PCG constants and the shared GLSL are in every film pass', () => {
  const Shaders = require('../src/shaders.js');
  const Film = require('../src/film.js');
  assert.match(Shaders.FILM_GLSL, /747796405u/);
  assert.match(Shaders.FILM_GLSL, /2891336453u/);
  assert.match(Shaders.FILM_GLSL, /277803737u/);
  assert.match(Shaders.FILM_GLSL, /16777216\.0/);
  for (const k of ['FILM_NOISE_FS', 'FILM_APPLY_FS']) assert.ok(Shaders[k].includes(Shaders.FILM_GLSL), k);
  for (const k of ['FILM_HALO_DOWN_FS', 'FILM_BLUR_FS', 'FILM_NOISE_FS', 'FILM_APPLY_FS']) {
    assert.match(Shaders[k], /^#version 300 es/, k);
  }
  // the blur loop bound is Film.MAX_KERNEL_RADIUS
  assert.ok(Shaders.FILM_BLUR_FS.includes('k <= ' + Film.MAX_KERNEL_RADIUS));
  // halation constants match film.js
  // halation strength and colour are the stock's (uniforms), not constants
  assert.match(Shaders.FILM_APPLY_FS, /uniform vec3 uHaloTint;/);
  assert.ok(!Shaders.FILM_APPLY_FS.includes('vec3(1.0, 0.28, 0.05)'));
  assert.ok(Shaders.FILM_HALO_DOWN_FS.includes('smoothstep(0.75, 1.0'));
});

test('filmFrame: export is z 1 at the origin; the preview place gives z and offset', () => {
  const s = { fovDeg: 180, thetaMaxDeg: 105, sensors: 'both', orientation: 'side', gapFrac: 0, marginFrac: 0,
    sourceLensSize: 5952, uploadedLensSize: 5952, padToSensorSquare: false };
  const g = GL.exportGeometry(s);
  const f = GL.filmFrame(s, g.width, g.height, null);
  assert.strictEqual(f.z, 1);
  assert.deepStrictEqual([f.px, f.py], [0, 0]);
  assert.ok(Math.abs(f.D - g.height) < 1, 'side by side at gap/margin 0: D = height');
  const p = GL.filmFrame(s, 800, 600, { x: -100, y: 20, w: g.width / 4, h: g.height / 4 });
  assert.strictEqual(p.z, 0.25);
  assert.deepStrictEqual([p.px, p.py], [-100, 20]);
  assert.strictEqual(p.D, f.D);
  const fit = GL.filmFrame(s, g.width / 2, g.height, null);   // letterboxed: half width, centred vertically
  assert.strictEqual(fit.z, 0.5);
  assert.deepStrictEqual([fit.px, fit.py], [0, g.height / 4]);
});
