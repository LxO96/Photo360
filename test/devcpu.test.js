'use strict';
const test = require('node:test');
const assert = require('node:assert');
const DevCpu = require('../devcpu.js');
const DevPlan = require('../devplan.js');
const Detail = require('../detail.js');
const Noise = require('../noise.js');

function rng(seed) {
  let s = seed >>> 0;
  const u = () => { s = (s * 1664525 + 1013904223) >>> 0; return (s + 0.5) / 4294967296; };
  return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}

const P = { sharpenAmount: 60, sharpenRadius: 1, lumaNoise: 70, colorNoise: 80 };
const RAW = { cfa: [1, 0, 2, 1], black: 1026, white: 16383, a: 1.3e-4, b: 1.5e-7 };

function rawPlane(w, h) {
  const g = rng(21);
  const plane = new Uint16Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = 0.05 + 0.3 * (x > 90 ? 1 : 0) + 0.1 * Math.sin(y * 0.3);
      const v = RAW.black + (RAW.white - RAW.black) * (s + Math.sqrt(RAW.a * s + RAW.b) * g());
      plane[y * w + x] = Math.max(0, Math.min(RAW.white, Math.round(v)));
    }
  }
  return plane;
}

// The whole-frame reference: raw -> opponent (demosaic, linearise, VST) ->
// develop -> linear RGB.
function rawReference(plane, w, h, sigmas) {
  const img = new Float32Array(w * h * 3);
  const range = RAW.white - RAW.black;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = Noise.demosaicAt(plane, w, h, RAW.cfa, x, y).map((v) => Noise.vst((v - RAW.black) / range, RAW.a, RAW.b));
      img.set(Detail.toOpp(c[0], c[1], c[2]), (y * w + x) * 3);
    }
  }
  const d = Detail.develop(img, w, h, P, sigmas);
  const out = new Float32Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const rgb = Detail.fromOpp(d[i * 3], d[i * 3 + 1], d[i * 3 + 2]).map((v) => Noise.vstInverse(v, RAW.a, RAW.b));
    out.set([rgb[0], rgb[1], rgb[2], 1], i * 4);
  }
  return out;
}

test('raw tiles developed on the CPU make up the whole-frame result', () => {
  const w = 200, h = 170;
  const plane = rawPlane(w, h);
  const sigmas = Noise.rawLevelSigmas(Detail);
  const want = rawReference(plane, w, h, sigmas);
  const got = new Float32Array(w * h * 4);
  for (const t of DevPlan.tiles(w, h, 64, DevPlan.HALO)) {
    const job = { kind: 'raw', region: t.region, core: t.core, params: P, sigmas,
      raw: Object.assign(DevCpu.rawSub(plane, w, h, t.region), RAW) };
    const r = DevCpu.developTile(job);
    assert.ok(r.data instanceof Float32Array);
    for (let y = 0; y < t.core.h; y++) got.set(r.data.subarray(y * t.core.w * 4, (y + 1) * t.core.w * 4), ((t.core.y + y) * w + t.core.x) * 4);
  }
  let max = 0;
  for (let i = 0; i < want.length; i++) max = Math.max(max, Math.abs(want[i] - got[i]));
  assert.ok(max < 1e-6, String(max));
});

test('a JPEG tile comes back as display bytes, clamped and rounded', () => {
  const w = 40, h = 30;
  const g = rng(22);
  const rgba = new Uint8Array(w * h * 4).map((_, i) => (i % 4 === 3 ? 255 : Math.max(0, Math.min(255, Math.round(128 + 40 * g())))));
  const sigmas = [0, 1, 2, 3, 4].map((k) => Noise.JPEG_FLOOR[k]);
  const region = { x: 0, y: 0, w, h }, core = { x: 5, y: 4, w: 20, h: 10 };
  const r = DevCpu.developTile({ kind: 'rgba', region, core, params: P, sigmas, rgba });
  assert.ok(r.data instanceof Uint8Array);
  assert.strictEqual(r.data.length, 20 * 10 * 4);
  // Same as developing the frame and encoding it.
  const img = DevCpu.rgbaInput(rgba, w, h);
  const d = Detail.develop(img, w, h, P, sigmas);
  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < 20; x++) {
      const i = (y + 4) * w + (x + 5);
      const want = Detail.fromOpp(d[i * 3], d[i * 3 + 1], d[i * 3 + 2]).map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255));
      assert.deepStrictEqual(Array.from(r.data.subarray((y * 20 + x) * 4, (y * 20 + x) * 4 + 4)), [...want, 255]);
    }
  }
});

test('rawSub keeps a 2 px margin (clamped at the frame) at an even origin', () => {
  const plane = rawPlane(100, 80);
  const s = DevCpu.rawSub(plane, 100, 80, { x: 20, y: 0, w: 50, h: 30 });
  assert.deepStrictEqual([s.px, s.py, s.pw, s.ph], [18, 0, 54, 32]);
  assert.strictEqual(s.plane[0], plane[18]);
  assert.strictEqual(s.plane[s.pw + 1], plane[100 + 19]);
});

test('JPEG noise measured from crops equals measuring the whole frame', () => {
  const w = 600, h = 520;
  const g = rng(23);
  const img = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const x = i % w;
    img.set([0.4 + 0.004 * g() + 0.1 * Math.sin(x * 0.02), 0.003 * g(), 0.003 * g()], i * 3);
  }
  const crops = DevPlan.sigmaCrops(w, h).map((c) => {
    const r = c.region;
    const opp = new Float32Array(r.w * r.h * 3);
    for (let y = 0; y < r.h; y++) opp.set(img.subarray(((r.y + y) * w + r.x) * 3, ((r.y + y) * w + r.x + r.w) * 3), y * r.w * 3);
    return { opp, w: r.w, h: r.h, inner: { x: c.inner.x - r.x, y: c.inner.y - r.y, w: c.inner.w, h: c.inner.h } };
  });
  const got = DevCpu.measureJpegSigmas(crops);
  // Reference: the whole frame's layers, read at the same crops.
  const { details } = Detail.atrous(img, w, h, Detail.LEVELS);
  const want = [];
  for (let k = 0; k < Detail.LEVELS; k++) {
    const parts = DevPlan.sigmaCrops(w, h).map(({ inner: c }) => {
      const d = new Float32Array(c.w * c.h * 3);
      for (let y = 0; y < c.h; y++) d.set(details[k].subarray(((c.y + y) * w + c.x) * 3, ((c.y + y) * w + c.x + c.w) * 3), y * c.w * 3);
      return { d, w: c.w, h: c.h };
    });
    want.push(Noise.jpegSigma(k, Noise.capLuma(Noise.estimateSigma(parts, 3), want[k - 1])));
  }
  assert.deepStrictEqual(got, want);
});

test('the pool runs jobs without workers too (node), in order', async () => {
  const pool = DevCpu.createPool({ size: 2 });
  const w = 30, h = 30;
  const rgba = new Uint8Array(w * h * 4).fill(100);
  const sigmas = [0, 1, 2, 3, 4].map((k) => Noise.JPEG_FLOOR[k]);
  const job = (x) => ({ kind: 'rgba', region: { x: 0, y: 0, w, h }, core: { x, y: 0, w: 10, h: 10 }, params: P, sigmas, rgba });
  const rs = await Promise.all([pool.run(job(0)), pool.run(job(10))]);
  assert.deepStrictEqual(rs.map((r) => r.core.x), [0, 10]);
  assert.strictEqual(rs[0].data[0], 100);
  // Queued jobs that are cleared resolve to null.
  const a = pool.run(job(0)), b = pool.run(job(10)), c = pool.run(job(20));
  pool.clear();
  const done = await Promise.all([a, b, c]);
  assert.strictEqual(done[2], null);
  // Or only the jobs a predicate picks.
  const d = pool.run(job(0)), e = pool.run(job(10));
  pool.clear((j) => j.core.x === 10);
  const [rd, re] = await Promise.all([d, e]);
  assert.strictEqual(rd.core.x, 0);
  assert.strictEqual(re, null);
  pool.close();
});

// A merged HDR photo (hdrmerge.js) is a float plane, black 0, white 1.
test('a float raw plane develops like its integer twin', () => {
  const w = 120, h = 90;
  const plane = rawPlane(w, h);
  const range = RAW.white - RAW.black;
  const fplane = Float32Array.from(plane, (v) => (v - RAW.black) / range);
  const FRAW = Object.assign({}, RAW, { black: 0, white: 1 });
  const sigmas = Noise.rawLevelSigmas(Detail);
  const region = { x: 0, y: 0, w, h }, core = { x: 10, y: 10, w: 60, h: 50 };
  const a = DevCpu.developTile({ kind: 'raw', region, core, params: P, sigmas,
    raw: Object.assign(DevCpu.rawSub(plane, w, h, region), RAW) });
  const sub = DevCpu.rawSub(fplane, w, h, region);
  assert.ok(sub.plane instanceof Float32Array, 'rawSub keeps the float type');
  const b = DevCpu.developTile({ kind: 'raw', region, core, params: P, sigmas, raw: Object.assign(sub, FRAW) });
  let max = 0;
  for (let i = 0; i < a.data.length; i++) max = Math.max(max, Math.abs(a.data[i] - b.data[i]));
  assert.ok(max < 1e-5, String(max));
});

test('the noise fit reads a float plane the same', () => {
  const w = 400, h = 300;
  const plane = rawPlane(w, h);
  const range = RAW.white - RAW.black;
  const fplane = Float32Array.from(plane, (v) => (v - RAW.black) / range);
  const a = Noise.fitProfile(plane, w, h, RAW.cfa, RAW.black, RAW.white);
  const b = Noise.fitProfile(fplane, w, h, RAW.cfa, 0, 1);
  assert.ok(Math.abs(b.a - a.a) <= 0.01 * Math.abs(a.a) + 1e-9, a.a + ' vs ' + b.a);
  assert.ok(Math.abs(b.b - a.b) <= 0.01 * Math.abs(a.b) + 1e-9, a.b + ' vs ' + b.b);
});
