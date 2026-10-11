'use strict';
const test = require('node:test');
const assert = require('node:assert');
const S = require('../src/sundetect.js');

// A lens frame over its image circle (luv space, row 0 = v 0), filled with
// `base` and with `spots` ({x, y, r, v, rgb}) painted on.
function lens(id, n, base, spots) {
  const rgb = new Float32Array(n * n * 3);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = (i + 0.5) / n, y = (j + 0.5) / n;
      let c = base;
      for (const s of spots || []) {
        if (Math.hypot(x - s.x, y - s.y) <= s.r) c = s.rgb || [s.v, s.v, s.v];
      }
      rgb.set(c, (j * n + i) * 3);
    }
  }
  return { lens: id, w: n, h: n, rgb };
}
const SKY = [0.3, 0.5, 0.8];

test('detect finds a bright compact disc and its centre', () => {
  const r = S.detect([lens('A', 128, SKY, [{ x: 0.7, y: 0.3, r: 0.02, v: 1 }]), lens('B', 128, SKY)]);
  assert.ok(r);
  assert.strictEqual(r.lens, 'A');
  assert.ok(Math.abs(r.x - 0.7) < 0.005 && Math.abs(r.y - 0.3) < 0.005, JSON.stringify(r));
  assert.ok(r.radius > 0.01 && r.radius < 0.03);
});

test('detect picks the largest compact clipped blob, not speckles that reach white first', () => {
  const speckles = [];
  for (let k = 0; k < 12; k++) speckles.push({ x: 0.3 + 0.03 * k, y: 0.2 + 0.01 * (k % 3), r: 0.004, v: 1 });
  // A clipped streak (a white railing): large but not compact.
  const streak = [];
  for (let k = 0; k < 40; k++) streak.push({ x: 0.2 + 0.008 * k, y: 0.4, r: 0.006, v: 1 });
  const r = S.detect([lens('A', 256, SKY, speckles.concat(streak, [{ x: 0.5, y: 0.85, r: 0.02, v: 1 }])), lens('B', 256, SKY)]);
  assert.ok(r);
  assert.ok(Math.abs(r.x - 0.5) < 0.005 && Math.abs(r.y - 0.85) < 0.005, JSON.stringify(r));
});

test('detect looks in lens B too', () => {
  const r = S.detect([lens('A', 128, SKY), lens('B', 128, SKY, [{ x: 0.4, y: 0.6, r: 0.02, v: 1 }])]);
  assert.strictEqual(r.lens, 'B');
  assert.ok(Math.abs(r.x - 0.4) < 0.005 && Math.abs(r.y - 0.6) < 0.005);
});

test('detect returns null when nothing reaches white', () => {
  assert.strictEqual(S.detect([lens('A', 64, [0.9, 0.9, 0.9]), lens('B', 64, SKY)]), null);
});

test('detect rejects a blown-out sky (a large clipped area), not a sun', () => {
  const r = S.detect([lens('A', 128, SKY, [{ x: 0.5, y: 0.7, r: 0.15, v: 1 }]), lens('B', 128, SKY)]);
  assert.strictEqual(r, null);
});

test('detect ignores light outside the image circle', () => {
  const r = S.detect([lens('A', 128, SKY, [{ x: 0.03, y: 0.03, r: 0.02, v: 1 }]), lens('B', 128, SKY)]);
  assert.strictEqual(r, null);
});

test('detect, HDR: a sun far brighter than a clipped sky around it is found', () => {
  const r = S.detect([lens('A', 128, SKY, [
    { x: 0.5, y: 0.7, r: 0.15, v: 1.0 },
    { x: 0.55, y: 0.72, r: 0.02, v: 6 },
  ]), lens('B', 128, SKY)]);
  assert.ok(r);
  assert.ok(Math.abs(r.x - 0.55) < 0.005 && Math.abs(r.y - 0.72) < 0.005, JSON.stringify(r));
});

test('detect tint: the colour around the sun, max 1, 80% of the way to white', () => {
  const r = S.detect([lens('A', 128, [1, 0.6, 0.2], [{ x: 0.5, y: 0.5, r: 0.02, v: 1 }]), lens('B', 128, SKY)]);
  assert.ok(r);
  assert.ok(Math.abs(r.tint[0] - 1) < 1e-6);
  assert.ok(Math.abs(r.tint[1] - 0.92) < 0.01 && Math.abs(r.tint[2] - 0.84) < 0.01, JSON.stringify(r.tint));
});

// -- Geometry --
const near = (a, b, eps) => Math.abs(a - b) < (eps || 1e-9);

test('dirOf: the centre of lens A looks along +z, of lens B along -z', () => {
  assert.deepStrictEqual(S.dirOf('A', 0.5, 0.5, 105, 0).map((v) => +v.toFixed(9)), [0, 0, 1]);
  assert.deepStrictEqual(S.dirOf('B', 0.5, 0.5, 105, 0).map((v) => +v.toFixed(9)), [-0, 0, -1].map((v) => +v.toFixed(9)));
});

test('dirOf: the circle edge is thetaMax from the axis', () => {
  const d = S.dirOf('A', 1, 0.5, 105, 0);
  assert.ok(near(Math.acos(d[2]) * 180 / Math.PI, 105, 1e-9));
});

test('viewOf round-trips dirOf on both lenses, with an upright correction', () => {
  for (const lensId of ['A', 'B']) {
    for (const up of [0, 90]) {
      const d = S.dirOf(lensId, 0.62, 0.31, 105, up);
      const v = S.viewOf(d, lensId, up);
      const r = 0.5 * v.theta / (105 * Math.PI / 180);
      assert.ok(near(0.5 + r * Math.cos(v.alpha), 0.62, 1e-9) && near(0.5 + r * Math.sin(v.alpha), 0.31, 1e-9),
        lensId + ' ' + up);
    }
  }
});

test('viewOf: a sun in lens A is behind lens B (theta > 90 deg)', () => {
  const d = S.dirOf('A', 0.6, 0.5, 105, 0);
  assert.ok(S.viewOf(d, 'B', 0).theta > Math.PI / 2);
});

test('upTerm: the sensor rotation each physical lens needs undone', () => {
  assert.strictEqual(S.upTermDeg({ sensorRotationDeg: 90 }, 'A'), -90);
  assert.strictEqual(S.upTermDeg({ sensorRotationDeg: 90 }, 'B'), 90);
  assert.strictEqual(S.upTermDeg({}, 'A'), 0);
});

// Opening a photo: both lenses unless one is blacked out (a cap, a hand).
test('blackLens: the lens that is (nearly) black while the other is not', () => {
  assert.strictEqual(S.blackLens([lens('A', 64, SKY), lens('B', 64, SKY)]), null);
  assert.strictEqual(S.blackLens([lens('A', 64, SKY), lens('B', 64, [0.004, 0.004, 0.004])]), 'B');
  assert.strictEqual(S.blackLens([lens('A', 64, [0, 0, 0]), lens('B', 64, SKY)]), 'A');
  // A night shot: both dark, neither is "blacked out".
  assert.strictEqual(S.blackLens([lens('A', 64, [0.01, 0.01, 0.01]), lens('B', 64, [0.012, 0.012, 0.012])]), null);
  assert.strictEqual(S.blackLens([lens('A', 64, SKY)]), null);
});
