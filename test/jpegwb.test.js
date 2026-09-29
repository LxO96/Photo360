'use strict';
const test = require('node:test');
const assert = require('node:assert');
const JpegWb = require('../jpegwb.js');

const grey = [0.4, 0.4, 0.4];
const chroma = (v) => [v[0] / v[1], v[2] / v[1]];

test('0 / 0 changes nothing', () => {
  assert.deepStrictEqual(JpegWb.matrix(0, 0), [1, 0, 0, 0, 1, 0, 0, 0, 1]);
  // And a hair off zero is a hair off identity.
  JpegWb.matrix(1e-6, 0).forEach((v, i) => assert.ok(Math.abs(v - [1, 0, 0, 0, 1, 0, 0, 0, 1][i]) < 1e-6));
});

test('Temperature warms, Tint turns magenta, as for raw', () => {
  const warm = JpegWb.apply(JpegWb.matrix(50, 0), grey);
  assert.ok(warm[0] > warm[1] && warm[1] > warm[2], String(warm));
  const cool = JpegWb.apply(JpegWb.matrix(-50, 0), grey);
  assert.ok(cool[2] > cool[1] && cool[1] > cool[0], String(cool));
  const magenta = JpegWb.apply(JpegWb.matrix(0, 50), grey);
  assert.ok(magenta[1] < magenta[0] && magenta[1] < magenta[2], String(magenta));
  const green = JpegWb.apply(JpegWb.matrix(0, -50), grey);
  assert.ok(green[1] > green[0] && green[1] > green[2], String(green));
});

test('white keeps its luminance', () => {
  for (const [t, n] of [[80, 0], [-60, 30], [20, -90]]) {
    const w = JpegWb.apply(JpegWb.matrix(t, n), [1, 1, 1]);
    const Y = 0.2126729 * w[0] + 0.7151522 * w[1] + 0.072175 * w[2];
    assert.ok(Math.abs(Y - 1) < 1e-9, `${t} ${n}: ${Y}`);
  }
});

test('Pick neutral: the solved setting renders the picked colour grey', () => {
  for (const c of [[0.5, 0.42, 0.3], [0.3, 0.35, 0.5], [0.4, 0.33, 0.4]]) {
    const s = JpegWb.solve(c, grey);
    const out = JpegWb.apply(JpegWb.matrix(s.temp, s.tint), c);
    const [rg, bg] = chroma(out);
    assert.ok(Math.abs(rg - 1) < 2e-3 && Math.abs(bg - 1) < 2e-3, `${c} -> ${out} (${JSON.stringify(s)})`);
  }
});

test('Match: the solved setting renders one colour as another', () => {
  const target = [0.45, 0.4, 0.3];               // the target lens's wall
  const source = [0.38, 0.4, 0.42];              // the same wall, cooler, in the other lens
  const s = JpegWb.solve(source, target);
  const out = JpegWb.apply(JpegWb.matrix(s.temp, s.tint), source);
  chroma(out).forEach((v, i) => assert.ok(Math.abs(v - chroma(target)[i]) < 3e-3, `${out} vs ${target}`));
});

test('the solve round-trips a setting', () => {
  for (const [t, n] of [[30, 10], [-45, -20], [70, 40]]) {
    const light = JpegWb.apply(JpegWb.inv(JpegWb.matrix(t, n)), grey);   // what renders grey under it
    const s = JpegWb.solve(light, grey);
    assert.ok(Math.abs(s.temp - t) < 0.5 && Math.abs(s.tint - n) < 0.5, `${t} ${n}: ${JSON.stringify(s)}`);
  }
});

test('settings past the sliders are clamped and say so', () => {
  const s = JpegWb.solve([0.9, 0.3, 0.05], grey);
  assert.ok(s.atLimit);
  assert.ok(Math.abs(s.temp) <= 100 && Math.abs(s.tint) <= 100);
});
