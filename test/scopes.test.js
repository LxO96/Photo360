'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Scopes = require('../scopes.js');

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// A w x h RGBA8 buffer filled by fn(x, y) -> [r, g, b] (0..255).
function image(w, h, fn) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = fn(x, y);
      const i = (y * w + x) * 4;
      px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
    }
  }
  return px;
}

function sum(a) { let s = 0; for (const v of a) s += v; return s; }

// -- chroma -----------------------------------------------------------------

test('chroma is zero for any grey', () => {
  for (const v of [0, 0.2, 0.5, 1]) {
    const c = Scopes.chroma(v, v, v);
    assert.ok(near(c.cb, 0) && near(c.cr, 0));
  }
});

test('chroma follows Rec.709: red is +Cr, blue is +Cb', () => {
  const red = Scopes.chroma(1, 0, 0);
  assert.ok(near(red.cr, 0.5, 1e-9), String(red.cr));
  assert.ok(red.cb < 0);
  const blue = Scopes.chroma(0, 0, 1);
  assert.ok(near(blue.cb, 0.5, 1e-9), String(blue.cb));
  assert.ok(blue.cr < 0);
});

// -- vectorscope --------------------------------------------------------------

test('vectorscope puts every grey pixel in the centre bin', () => {
  const size = 65;
  const px = image(10, 10, (x) => [x * 25, x * 25, x * 25]);
  const bins = Scopes.vectorscope(px, 10, 10, { size });
  const c = (size - 1) / 2;
  assert.strictEqual(bins[c * size + c], 100);
  assert.strictEqual(sum(bins), 100);
});

test('vectorscope: red lands up and left of centre, blue right and down', () => {
  const size = 101;
  const c = (size - 1) / 2;
  const red = Scopes.vectorPoint(Scopes.chroma(1, 0, 0), size);
  assert.ok(red.y < c && red.x < c, JSON.stringify(red));
  const blue = Scopes.vectorPoint(Scopes.chroma(0, 0, 1), size);
  assert.ok(blue.x > c && blue.y > c, JSON.stringify(blue));
  // Fully saturated primaries stay inside the plot.
  for (const rgb of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0], [0, 1, 1], [1, 0, 1]]) {
    const p = Scopes.vectorPoint(Scopes.chroma(...rgb), size);
    assert.ok(p.x >= 0 && p.x <= size - 1 && p.y >= 0 && p.y <= size - 1, JSON.stringify(p));
  }
});

test('vectorscope honours the include mask', () => {
  const px = image(4, 4, () => [255, 0, 0]);
  const bins = Scopes.vectorscope(px, 4, 4, { size: 33, include: (x) => x < 1 });
  assert.strictEqual(sum(bins), 4);
});

test('targets are the six 75% colours, and the skin line sits between red and yellow', () => {
  const size = 201;
  const t = Scopes.targets(size);
  assert.deepStrictEqual(t.map((p) => p.name), ['R', 'Mg', 'B', 'Cy', 'G', 'Yl']);
  const c = (size - 1) / 2;
  const ang = (p) => Math.atan2(c - p.y, p.x - c) * 180 / Math.PI;
  const red = ang(t[0]);
  const yellow = ang(t[5]);
  const skin = Scopes.skinLine(size);
  const s = ang({ x: skin.x2, y: skin.y2 });
  assert.ok(near(skin.x1, c) && near(skin.y1, c));
  assert.ok(s > red && s < yellow, `red ${red}, skin ${s}, yellow ${yellow}`);
});

// -- waveform -----------------------------------------------------------------

test('luma waveform bins each column by its luma level', () => {
  const levels = 256;
  // Left half black, right half white.
  const px = image(4, 3, (x) => (x < 2 ? [0, 0, 0] : [255, 255, 255]));
  const wf = Scopes.waveform(px, 4, 3, { levels, mode: 'luma' });
  assert.strictEqual(wf.channels.length, 1);
  assert.strictEqual(wf.cols, 4);
  const ch = wf.channels[0];
  assert.strictEqual(ch[0 * 4 + 0], 3);            // column 0 at level 0
  assert.strictEqual(ch[255 * 4 + 3], 3);          // column 3 at the top level
  assert.strictEqual(sum(ch), 12);
});

test('luma waveform uses Rec.709 weights', () => {
  const px = image(1, 1, () => [0, 255, 0]);
  const wf = Scopes.waveform(px, 1, 1, { levels: 1001, mode: 'luma' });
  const lvl = wf.channels[0].findIndex((v) => v > 0);
  assert.strictEqual(lvl, Math.round(0.7152 * 1000));
});

test('parade splits R, G and B into three channels', () => {
  const px = image(2, 2, () => [255, 0, 128]);
  const wf = Scopes.waveform(px, 2, 2, { levels: 256, mode: 'parade' });
  assert.strictEqual(wf.channels.length, 3);
  const [r, g, b] = wf.channels;
  assert.strictEqual(r[255 * 2 + 0], 2);
  assert.strictEqual(g[0 * 2 + 1], 2);
  assert.strictEqual(b[128 * 2 + 0], 2);
});

test('waveform honours the include mask', () => {
  const px = image(4, 4, () => [100, 100, 100]);
  const wf = Scopes.waveform(px, 4, 4, { levels: 64, mode: 'luma', include: (x, y) => y === 0 });
  assert.strictEqual(sum(wf.channels[0]), 4);
});

// -- mask and display ---------------------------------------------------------

test('insideCircles includes pixel centres within a circle only', () => {
  const inc = Scopes.insideCircles([{ cx: 5, cy: 5, radius: 2 }]);
  assert.ok(inc(4, 4));        // centre (4.5, 4.5)
  assert.ok(!inc(0, 0));
  assert.ok(!inc(8, 5));
  assert.ok(Scopes.insideCircles([])(3, 3) === false);
});

test('intensity is 0 for empty bins, monotonic, and capped at 1', () => {
  assert.strictEqual(Scopes.intensity(0, 10), 0);
  let prev = 0;
  for (let n = 1; n < 1000; n++) {
    const v = Scopes.intensity(n, 10);
    assert.ok(v >= prev && v <= 1);
    prev = v;
  }
  assert.strictEqual(Scopes.intensity(1e9, 10), 1);
});
