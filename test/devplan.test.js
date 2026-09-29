'use strict';
const test = require('node:test');
const assert = require('node:assert');
const DevPlan = require('../devplan.js');
const Detail = require('../detail.js');

function rng(seed) {
  let s = seed >>> 0;
  const u = () => { s = (s * 1664525 + 1013904223) >>> 0; return (s + 0.5) / 4294967296; };
  return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}

const P = { sharpenAmount: 80, sharpenRadius: 1, lumaNoise: 60, colorNoise: 70 };
const SIG = [1, 0.5, 0.25, 0.12, 0.06].map((f) => [0.3 * f, 0.2 * f, 0.2 * f]);

// Develops `img` tile by tile (each tile's region developed on its own,
// its core copied out), the way the tiled GPU and CPU paths do.
function developTiled(img, w, h, tile, halo) {
  const out = new Float32Array(img.length);
  for (const t of DevPlan.tiles(w, h, tile, halo)) {
    const r = t.region, c = t.core;
    const sub = new Float32Array(r.w * r.h * 3);
    for (let y = 0; y < r.h; y++) sub.set(img.subarray(((r.y + y) * w + r.x) * 3, ((r.y + y) * w + r.x + r.w) * 3), y * r.w * 3);
    const dev = Detail.develop(sub, r.w, r.h, P, SIG);
    for (let y = 0; y < c.h; y++) {
      const from = ((c.y - r.y + y) * r.w + (c.x - r.x)) * 3;
      out.set(dev.subarray(from, from + c.w * 3), ((c.y + y) * w + c.x) * 3);
    }
  }
  return out;
}

function textured(w, h) {
  const g = rng(11);
  const img = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3;
      img[o] = (x + y < 250 ? 1 : 3) + 0.3 * g() + Math.sin(x * 0.2) * Math.cos(y * 0.13);
      img[o + 1] = 0.2 * g() + 0.3 * Math.sin(x * 0.05);
      img[o + 2] = 0.2 * g();
    }
  }
  return img;
}

test('the halo covers everything one output pixel depends on', () => {
  assert.strictEqual(DevPlan.reach(Detail.LEVELS), 78);
  assert.ok(DevPlan.HALO >= DevPlan.reach(Detail.LEVELS));
  // Measuring needs every layer (down to the coarse residual) exact.
  assert.strictEqual(DevPlan.decompReach(Detail.LEVELS), 62);
  assert.ok(DevPlan.MEASURE_HALO >= DevPlan.decompReach(Detail.LEVELS));
});

test('tiles cover the frame once, and regions stay inside it', () => {
  const w = 1000, h = 700;
  const seen = new Uint8Array(w * h);
  for (const t of DevPlan.tiles(w, h, 256, 80)) {
    const { core: c, region: r } = t;
    assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= w && r.y + r.h <= h);
    assert.ok(c.x - r.x === Math.min(80, c.x) && c.y - r.y === Math.min(80, c.y));
    assert.strictEqual(r.x % 2, 0);
    assert.strictEqual(r.y % 2, 0);
    for (let y = c.y; y < c.y + c.h; y++) for (let x = c.x; x < c.x + c.w; x++) seen[y * w + x]++;
  }
  assert.ok(seen.every((v) => v === 1));
});

test('developing in tiles gives exactly the whole-frame result', () => {
  const w = 300, h = 260;
  const img = textured(w, h);
  const full = Detail.develop(img, w, h, P, SIG);
  const tiled = developTiled(img, w, h, 96, DevPlan.HALO);
  assert.deepStrictEqual(tiled, full);
});

test('a halo short of the reach shows (the test above can fail)', () => {
  const w = 300, h = 260;
  const img = textured(w, h);
  const full = Detail.develop(img, w, h, P, SIG);
  const tiled = developTiled(img, w, h, 96, 40);
  let max = 0;
  for (let i = 0; i < full.length; i++) max = Math.max(max, Math.abs(full[i] - tiled[i]));
  assert.ok(max > 1e-4, String(max));
});

test('graphics memory: whole frame, tiled and CPU', () => {
  const x5 = [{ w: 5952, h: 5952 }, { w: 5952, h: 5952 }];
  const px = 5952 * 5952;
  assert.strictEqual(DevPlan.memory('full', x5, false), 5 * px * 8);
  const t = DevPlan.GPU_TILE + 2 * DevPlan.HALO;
  assert.strictEqual(DevPlan.memory('tiled', x5, false), 2 * px * 8 + 3 * t * t * 8);
  assert.strictEqual(DevPlan.memory('cpu', x5, false), 2 * px * 4);
  assert.strictEqual(DevPlan.memory('cpu', x5, true), 2 * px * 8);
  // A frame smaller than a tile needs no more than the frame.
  const small = [{ w: 500, h: 400 }];
  assert.strictEqual(DevPlan.memory('tiled', small, false), 2 * 500 * 400 * 8 + 2 * 500 * 400 * 8);
  assert.strictEqual(DevPlan.memory('full', [], false), 0);
});

test('the whole-frame path is used while it fits the budget, tiles above it', () => {
  assert.strictEqual(DevPlan.choosePath([{ w: 3040, h: 3040 }, { w: 3040, h: 3040 }], true), 'full');
  assert.strictEqual(DevPlan.choosePath([{ w: 5952, h: 5952 }, { w: 5952, h: 5952 }], false), 'tiled');
});

test('each path falls back to the next', () => {
  assert.strictEqual(DevPlan.fallback('full'), 'tiled');
  assert.strictEqual(DevPlan.fallback('tiled'), 'cpu');
  assert.strictEqual(DevPlan.fallback('cpu'), null);
});

test('sigma crops sit inside the frame with a measuring border', () => {
  for (const c of DevPlan.sigmaCrops(3040, 3040)) {
    const { inner: i, region: r } = c;
    assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= 3040 && r.y + r.h <= 3040);
    assert.strictEqual(i.x - r.x, Math.min(DevPlan.MEASURE_HALO, i.x));
    assert.strictEqual(r.x + r.w - (i.x + i.w), Math.min(DevPlan.MEASURE_HALO, 3040 - (i.x + i.w)));
    assert.strictEqual(i.w, 256);
  }
  // A small frame gets smaller crops.
  assert.strictEqual(DevPlan.sigmaCrops(400, 400)[0].inner.w, 100);
});

test('memory reads as MB or GB', () => {
  assert.strictEqual(DevPlan.formatBytes(1.42e9), '1.4 GB');
  assert.strictEqual(DevPlan.formatBytes(370e6), '370 MB');
});
