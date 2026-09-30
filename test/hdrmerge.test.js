'use strict';
const test = require('node:test');
const assert = require('node:assert');
const H = require('../hdrmerge.js');

const meta = (o) => Object.assign({ model: 'X', dateTimeOriginal: '2024:08:25 17:49:07', iso: 100,
  exposureTime: 1 / 200, width: 8, height: 4, cfaPattern: [0, 1, 1, 2] }, o);

test('detectSets groups same second / model / ISO / size, distinct exposures', () => {
  const items = [
    { id: 1, meta: meta({ exposureTime: 1 / 800 }) },
    { id: 2, meta: meta({ exposureTime: 1 / 200 }) },
    { id: 3, meta: meta({ exposureTime: 1 / 200 }) },                 // duplicate exposure
    { id: 4, meta: meta({ exposureTime: 1 / 50 }) },
    { id: 5, meta: meta({ dateTimeOriginal: '2024:08:25 17:49:08' }) }, // another second, alone
    { id: 6, meta: meta({ iso: 200, exposureTime: 1 / 800 }) },         // another ISO, alone
    { id: 7, meta: meta({ exposureTime: null }) },                      // no exposure: never grouped
  ];
  assert.deepStrictEqual(H.detectSets(items), [[1, 2, 4]]);
});

test('canMerge explains why not', () => {
  assert.ok(H.canMerge([meta({ exposureTime: 1 / 800 }), meta()]).ok);
  assert.match(H.canMerge([meta()]).reason, /two/i);
  assert.match(H.canMerge([meta(), meta()]).reason, /exposure/i);
  assert.match(H.canMerge([meta({ exposureTime: 1 / 800 }), meta({ width: 16 })]).reason, /size/i);
  assert.match(H.canMerge([meta({ exposureTime: 1 / 800 }), meta({ iso: 400 })]).reason, /ISO/);
});

test('mergeKey is order independent', () => {
  assert.strictEqual(H.mergeKey(['b', 'a']), 'HDR|a||b');
});

test('the reference is the median exposure (the longer middle one for an even count)', () => {
  assert.strictEqual(H.referenceIndex([0.01, 0.04, 0.0025]), 0);
  assert.strictEqual(H.referenceIndex([0.04, 0.01]), 0);
});

// A w x h RGGB scene in reference units, exposed at `k` x the reference.
function expose(scene, k, black = 100, white = 4100) {
  return Uint16Array.from(scene, (v) => Math.round(black + Math.min(1, v * k) * (white - black)));
}
const W = 8, Hh = 4, CFA = [0, 1, 1, 2];

test('a ramp exposed at t and 4t merges back to the ramp, in reference units', () => {
  const scene = Float32Array.from({ length: W * Hh }, (_, i) => 0.02 + 3.5 * i / (W * Hh));  // up to ~3.5x white
  const frames = [
    { plane: expose(scene, 0.25), t: 0.25, black: 100, white: 4100 },   // short
    { plane: expose(scene, 1), t: 1, black: 100, white: 4100 },         // reference (longer of two)
  ];
  const m = H.mergePlanes(frames, W, Hh, CFA);
  assert.strictEqual(m.ref, 1);
  assert.strictEqual(m.hdrMax, 4);
  for (let i = 0; i < scene.length; i++) {
    assert.ok(Math.abs(m.plane[i] - scene[i]) <= 0.01 * scene[i] + 0.002, i + ': ' + m.plane[i] + ' vs ' + scene[i]);
  }
});

test('a near-clipped block keeps its colour (all four samples from one frame)', () => {
  // One 2x2 block: R and B bright, G just under the long frame's clip.
  const scene = new Float32Array(W * Hh).fill(0.1);
  scene[0] = 0.5; scene[1] = 0.97; scene[W] = 0.97; scene[W + 1] = 0.5;   // R, G, G, B of block (0,0)
  const frames = [
    { plane: expose(scene, 0.25), t: 0.25, black: 100, white: 4100 },
    { plane: expose(scene, 1), t: 1, black: 100, white: 4100 },
  ];
  const m = H.mergePlanes(frames, W, Hh, CFA);
  const ratio = m.plane[0] / m.plane[1];
  assert.ok(Math.abs(ratio - 0.5 / 0.97) < 0.01, 'R/G ' + ratio);
});

test('clipped in every frame falls back to the shortest', () => {
  const scene = new Float32Array(W * Hh).fill(9);   // beyond both frames
  const frames = [
    { plane: expose(scene, 0.25), t: 0.25, black: 100, white: 4100 },
    { plane: expose(scene, 1), t: 1, black: 100, white: 4100 },
  ];
  const m = H.mergePlanes(frames, W, Hh, CFA);
  for (const v of m.plane) assert.ok(Math.abs(v - 4) < 1e-3, String(v));   // the short frame's white, in reference units
});

test('longer exposures weigh more where both are usable', () => {
  const scene = new Float32Array(W * Hh).fill(0.2);
  const long = expose(scene, 1), short = expose(scene, 0.25);
  short[0] += 40;                                    // noise in the short frame only
  const m = H.mergePlanes([{ plane: short, t: 0.25, black: 100, white: 4100 },
    { plane: long, t: 1, black: 100, white: 4100 }], W, Hh, CFA);
  // weights 0.25 : 1, the short frame's error (40 / 4000 / 0.25 = 0.04) is cut to a fifth
  assert.ok(Math.abs(m.plane[0] - (0.2 + 0.04 / 5)) < 2e-3, String(m.plane[0]));
});
