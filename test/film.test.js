'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Film = require('../film.js');

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} ${a} vs ${b}`);

test('the five Wigglecam stocks, transcribed exactly', () => {
  assert.deepStrictEqual(Film.STOCKS.map((s) => s.id),
    ['golden200', 'verdant400', 'portrait160', 'classic400bw', 'smooth400bw']);
  const g = Film.STOCKS[0];
  assert.deepStrictEqual(g, {
    id: 'golden200', name: 'Golden 200', bw: false,
    sensitivity: [1.06, -0.02, -0.04, -0.01, 1.00, 0.01, -0.03, -0.05, 0.92],
    layers: [
      { gamma: 0.62, logE0: -0.80, uMin: 0.035, uMax: 0.965 },
      { gamma: 0.62, logE0: -0.79, uMin: 0.030, uMax: 0.965 },
      { gamma: 0.60, logE0: -0.76, uMin: 0.045, uMax: 0.950 },
    ],
    grain: { radiusMedianPx: 0.12, radiusLogSigma: 0.35, filterSigmaPx: 0.8 },
    crosstalk: [1.12, -0.08, -0.04, -0.06, 1.10, -0.04, -0.03, -0.09, 1.12],
  });
  const v = Film.STOCKS[1];
  assert.deepStrictEqual(v.sensitivity, [0.97, -0.01, -0.01, -0.01, 1.04, -0.01, -0.01, 0.00, 1.04]);
  assert.deepStrictEqual(v.layers[1], { gamma: 0.58, logE0: -0.85, uMin: 0.055, uMax: 0.960 });
  assert.deepStrictEqual(v.grain, { radiusMedianPx: 0.16, radiusLogSigma: 0.35, filterSigmaPx: 0.8 });
  assert.deepStrictEqual(v.crosstalk, [1.08, -0.05, -0.03, -0.04, 1.08, -0.04, -0.02, -0.06, 1.08]);
  const p = Film.STOCKS[2];
  assert.deepStrictEqual(p.layers[2], { gamma: 0.49, logE0: -0.80, uMin: 0.045, uMax: 0.955 });
  assert.deepStrictEqual(p.grain, { radiusMedianPx: 0.09, radiusLogSigma: 0.30, filterSigmaPx: 0.8 });
  const c = Film.STOCKS[3];
  assert.strictEqual(c.bw, true);
  assert.deepStrictEqual(c.sensitivity, [0.30, 0.59, 0.11, 0.30, 0.59, 0.11, 0.30, 0.59, 0.11]);
  assert.deepStrictEqual(c.layers[0], { gamma: 0.78, logE0: -0.74, uMin: 0.020, uMax: 0.980 });
  assert.deepStrictEqual(c.grain, { radiusMedianPx: 0.22, radiusLogSigma: 0.40, filterSigmaPx: 0.8 });
  const s = Film.STOCKS[4];
  assert.deepStrictEqual(s.sensitivity.slice(0, 3), [0.25, 0.62, 0.13]);
  assert.deepStrictEqual(s.layers[0], { gamma: 0.56, logE0: -0.78, uMin: 0.040, uMax: 0.960 });
  assert.deepStrictEqual(s.crosstalk, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
});

test('every colour stock\'s crosstalk rows sum to 1 (neutrals stay neutral)', () => {
  for (const s of Film.STOCKS) {
    for (let r = 0; r < 3; r++) near(s.crosstalk[r * 3] + s.crosstalk[r * 3 + 1] + s.crosstalk[r * 3 + 2], 1, 1e-9, s.id);
  }
});

test('gauges: short sides of the gate', () => {
  assert.deepStrictEqual(Film.GAUGES.map((g) => [g.id, g.short]),
    [['s8', 4.01], ['s16', 7.41], ['35', 24], ['120', 56]]);
});

test('develop: Wigglecam\'s logistic, mid-range at logE0 with slope gamma', () => {
  const l = { gamma: 0.62, logE0: -0.8, uMin: 0.035, uMax: 0.965 };
  near(Film.develop(-0.8, l), 0.5, 1e-12);
  const d = 1e-6;
  near((Film.develop(-0.8 + d, l) - Film.develop(-0.8 - d, l)) / (2 * d), 0.62, 1e-6);
});

test('fitCurve pins mid-grey and white on the anchor layer for every stock', () => {
  for (const s of Film.STOCKS) {
    const f = Film.fitCurve(s);
    const a = s.bw ? 0 : 1;
    const out = (x) => Film.curvePixel([x, x, x], { ...s, sensitivity: [1, 0, 0, 0, 1, 0, 0, 0, 1] }, f)[a];
    near(out(0.18), Film.MID_OUT, 1e-6, s.id + ' mid');
    near(out(1.0), Film.WHITE_OUT, 1e-6, s.id + ' white');
    assert.ok(out(0.01) < out(0.18) && out(0.18) < out(1), s.id + ' monotone');
  }
  near(Film.MID_OUT, 0.46135612950044164, 1e-12);
});

// 32-bit reference with BigInt: the PCG hash as Wigglecam's Rng.hash (Int wraps).
function pcgRef(v) {
  const M = 0xFFFFFFFFn;
  const st = (BigInt.asUintN(32, BigInt(v)) * 747796405n + 2891336453n) & M;
  const word = (((st >> ((st >> 28n) + 4n)) ^ st) * 277803737n) & M;
  return Number(BigInt.asIntN(32, (word >> 22n) ^ word));
}

test('pcg matches a 32-bit BigInt reference, negative inputs included', () => {
  for (const v of [0, 1, 2, 12345, -1, -987654, 0x7fffffff, -0x80000000, 3141592653 | 0]) {
    assert.strictEqual(Film.pcg(v), pcgRef(v), String(v));
  }
});

test('hash4 nests as Wigglecam: hash(a ^ hash(b ^ hash(c ^ hash(d))))', () => {
  const want = pcgRef(5 ^ pcgRef(-7 ^ pcgRef(11 ^ pcgRef(0x51))));
  assert.strictEqual(Film.hash4(5, -7, 11, 0x51), want);
});

test('gaussian: 24-bit uniforms (as on the GPU), unit normal statistics', () => {
  let s = 0, s2 = 0;
  const n = 200000;
  for (let i = 0; i < n; i++) { const g = Film.gaussian(Film.hash4(i, 3, 9, 1)); s += g; s2 += g * g; }
  near(s / n, 0, 0.01, 'mean');
  near(s2 / n, 1, 0.02, 'variance');
});

test('seedOf: deterministic, differs between names; three layer seeds differ', () => {
  assert.strictEqual(Film.seedOf('IMG_1.insp'), Film.seedOf('IMG_1.insp'));
  assert.notStrictEqual(Film.seedOf('IMG_1.insp'), Film.seedOf('IMG_2.insp'));
  const l = Film.layerSeeds(Film.seedOf('x'));
  assert.strictEqual(new Set(l).size, 3);
  assert.ok(l.every((v) => Number.isInteger(v) && v === (v | 0)));
});

test('grainModel: coverage from lambda, point covariance u(1-u), zero beyond reach', () => {
  const m = Film.grainModel(0.3, 0.35, 0.8);
  for (const u of [0.1, 0.5, 0.9]) near(1 - Math.exp(-m.lambda(u) * m.meanArea), u, 1e-9);
  for (const u of [0.2, 0.5, 0.8]) near(m.covariance(u, 0), u * (1 - u), 0.03 * u * (1 - u));
  assert.strictEqual(m.covariance(0.5, 2.5 * m.maxRadius), 0);
});

test('grainModel: filtered variance peaks mid-tone, zero at u=0', () => {
  const m = Film.grainModel(0.3, 0.35, 0.8);
  const mid = m.filteredVariance(0.5);
  assert.ok(mid > m.filteredVariance(0.1) && mid > m.filteredVariance(0.95) && mid < 0.25);
  assert.strictEqual(m.filteredVariance(0), 0);
});

test('forRenderScale as Wigglecam (its GrainModelTest numbers)', () => {
  const m = Film.grainModel(1.2, 0.35, 0.9);
  const same = m.forRenderScale(1);
  assert.deepStrictEqual([same.radiusMedian, same.radiusLogSigma, same.filterSigma], [1.2, 0.35, 0.9]);
  const q = m.forRenderScale(0.25);
  near(q.radiusMedian, 0.3, 1e-12);
  near(q.filterSigma, Math.sqrt(0.9 * 0.9 * 0.0625 + (1 - 0.0625) / 12), 1e-12);
});

test('inverseNormal and i0e', () => {
  near(Film.inverseNormal(0.5), 0, 1e-9);
  near(Film.inverseNormal(0.975), 1.959964, 1e-5);
  near(Film.inverseNormal(0.01), -2.326348, 1e-5);
  near(Film.i0e(0), 1, 1e-7);
  near(Film.i0e(1), 1.2660658777520082 * Math.exp(-1), 1e-6);
  near(Film.i0e(10), 2815.716628466254 * Math.exp(-10), 1e-6);
});

test('calibrateNoiseSigma inverts kernelLagOne', () => {
  for (const t of [0.2, 0.5, 0.8]) near(Film.kernelLagOne(Film.calibrateNoiseSigma(t)), t, 1e-6);
});

test('gaussianKernel: normalised, radius max(1, ceil(3 sigma)) capped at 31', () => {
  const k = Film.gaussianKernel(1.4);
  assert.strictEqual(k.length, 2 * 5 + 1);
  near(k.reduce((a, b) => a + b, 0), 1, 1e-12);
  assert.strictEqual(Film.gaussianKernel(0.1).length, 3);
  assert.strictEqual(Film.gaussianKernel(40).length, 2 * Film.MAX_KERNEL_RADIUS + 1);
});

test('grainSetup: std table from the scaled model, unit-variance normalisation, cached', () => {
  const p = Film.STOCKS[0].grain;
  const a = Film.grainSetup(p, 1.6, 1);
  assert.strictEqual(a, Film.grainSetup(p, 1.6, 1));
  assert.strictEqual(a.std.length, Film.STD_TABLE + 1);
  near(a.std[100], Math.sqrt(a.model.filteredVariance(0.5)), 1e-6);
  assert.strictEqual(a.std[0], 0);
  const sw2 = Array.from(a.weights).reduce((s, w) => s + w * w, 0);
  near(a.norm, 1 / sw2, 1e-5);
  assert.strictEqual(a.weights.length, 2 * a.radius + 1);
  // the composed model: export scale, then the preview's z
  const m = Film.grainModel(p.radiusMedianPx, p.radiusLogSigma, p.filterSigmaPx).forRenderScale(1.6).forRenderScale(0.5);
  const b = Film.grainSetup(p, 1.6, 0.5);
  near(b.model.filterSigma, m.filterSigma, 1e-12);
  assert.ok(b.std[100] < a.std[100], 'zoomed out: weaker grain');
});

test('quantizeScale: 1/8 octave steps', () => {
  assert.strictEqual(Film.quantizeScale(1), 1);
  near(Film.quantizeScale(1.05), Math.pow(2, 1 / 8), 1e-12);
});

const frame35 = { D: 3060, z: 1, px: 0, py: 0 };
const st = (film, name) => ({ film: Object.assign({ stock: 'golden200', gauge: '35', grain: 1, halation: 0.5 }, film), sourceName: name || 'a.insp' });

test('active: off, unknown stock, DNG and gain-map renders are not filmed', () => {
  assert.strictEqual(Film.active(st({ stock: 'off' })), false);
  assert.strictEqual(Film.active(st({ stock: 'nope' })), false);
  assert.strictEqual(Film.active(Object.assign(st({}), { dngOutput: true })), false);
  assert.strictEqual(Film.active(Object.assign(st({}), { gainOut: true })), false);
  assert.strictEqual(Film.active({}), false);
  assert.strictEqual(Film.active(st({})), true);
});

test('gauge scale: Super 8 is Wigglecam grain, finer gauges finer (user, 2026-10-03)', () => {
  // The user: today's 35 mm should be the coarsest -- Wigglecam's grain is now Super 8's.
  near(Film.renderScale(3060, 's8'), 1, 1e-12);
  near(Film.renderScale(3060, 's16'), 4.01 / 7.41, 1e-12);
  near(Film.renderScale(3060, '35'), 4.01 / 24, 1e-12);
  near(Film.renderScale(3060, '120'), 4.01 / 56, 1e-12);
  near(Film.renderScale(5100, 's8'), 5100 / 3060, 1e-12);
  // halation keeps its own size (0.2 mm of a 35 mm frame)
  near(Film.halationRadius(5100, '35'), 0.008 * 5100, 1e-12);
  near(Film.halationRadius(5100, 's16'), 0.008 * 5100 * 24 / 7.41, 1e-12);
});

test('params: Super 16 grain coarser than 35 mm; preview z scales the halo radius', () => {
  const a = Film.params(st({ gauge: '35' }), { D: 5100, z: 1, px: 0, py: 0 });
  const b = Film.params(st({ gauge: 's16' }), { D: 5100, z: 1, px: 0, py: 0 });
  assert.ok(b.grain.sigma > a.grain.sigma * 1.5, 'coarser');
  assert.ok(b.grain.std[100] > a.grain.std[100], 'stronger');
  const c = Film.params(st({ gauge: '35' }), { D: 5100, z: 0.25, px: 0, py: 0 });
  near(c.haloR, a.haloR * 0.25, 1e-9);
  assert.deepStrictEqual(a.seeds, Film.layerSeeds(Film.seedOf('a.insp')));
});

function flat(W, H, v) {
  const a = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) { a[i * 4] = v[0]; a[i * 4 + 1] = v[1]; a[i * 4 + 2] = v[2]; a[i * 4 + 3] = 255; }
  return a;
}

test('haloFactor: sigma at most 8 texels, factor capped at 64', () => {
  assert.strictEqual(Film.haloFactor(5), 1);
  assert.strictEqual(Film.haloFactor(41), 8);
  assert.strictEqual(Film.haloFactor(5000), 64);
});

test('reference: no grain, no halation, B&W on mid-grey gives mid-grey', () => {
  const p = Film.params(st({ stock: 'classic400bw', grain: 0, halation: 0 }), frame35);
  const g = Math.round(Film.MID_OUT * 255);
  const out = Film.reference(flat(8, 8, [g, g, g]), 8, 8, p, frame35);
  for (let i = 0; i < 64; i++) assert.ok(Math.abs(out[i * 4] - g) <= 1 && out[i * 4] === out[i * 4 + 2]);
});

test('reference grain statistics match the model (std within 8%, lag-1 within 0.05)', () => {
  const p = Film.params(st({ stock: 'smooth400bw', gauge: 's16', halation: 0 }), frame35);
  const W = 192, H = 192, g = 118;
  const out = Film.reference(flat(W, H, [g, g, g]), W, H, p, frame35);
  const base = Film.reference(flat(W, H, [g, g, g]), W, H, Object.assign({}, p, { amount: 0 }), frame35);
  let s2 = 0, lag = 0, n = 0, nl = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = (out[(y * W + x) * 4] - base[(y * W + x) * 4]) / 255;
      s2 += d * d; n++;
      if (x + 1 < W) { lag += d * (out[(y * W + x + 1) * 4] - base[(y * W + x + 1) * 4]) / 255; nl++; }
    }
  }
  const u0 = base[0] / 255;
  const want = p.grain.std[Math.round(u0 * 200)];
  near(Math.sqrt(s2 / n), want, 0.08 * want, 'std');
  near((lag / nl) / (s2 / n), p.grain.model.lagOneCorrelation(), 0.05, 'lag-1');
});

test('reference: B&W grain is monochrome, colour grain is not', () => {
  const bw = Film.reference(flat(16, 16, [120, 120, 120]), 16, 16, Film.params(st({ stock: 'classic400bw', halation: 0 }), frame35), frame35);
  for (let i = 0; i < 256; i++) assert.ok(bw[i * 4] === bw[i * 4 + 1] && bw[i * 4 + 1] === bw[i * 4 + 2]);
  const c = Film.reference(flat(16, 16, [120, 120, 120]), 16, 16, Film.params(st({ halation: 0 }), frame35), frame35);
  let differ = 0;
  for (let i = 0; i < 256; i++) if (c[i * 4] !== c[i * 4 + 2]) differ++;
  assert.ok(differ > 50);
});

test('reference: grain is anchored to the export lattice (pan-stable)', () => {
  const W = 40, H = 30, p = Film.params(st({ halation: 0 }), frame35);
  const src = flat(W, H, [120, 120, 120]);
  const a = Film.reference(src, W, H, p, { D: 3060, z: 1, px: 0, py: 0 });
  const b = Film.reference(src, W, H, p, { D: 3060, z: 1, px: -5, py: -3 });   // the view moved 5 px right, 3 down
  // target pixel (x, y) in b shows export pixel (x+5, y+3), as a's (x+5, y+3): equal away from blur edges
  for (let y = 8; y < 18; y++) for (let x = 8; x < 25; x++) {
    assert.strictEqual(b[(y * W + x) * 4], a[((y + 3) * W + x + 5) * 4]);
  }
});

test('reference: halation adds red-orange glow around a bright patch, nothing far away', () => {
  const W = 64, H = 64, src = flat(W, H, [60, 60, 60]);
  for (let y = 28; y < 36; y++) for (let x = 28; x < 36; x++) src.set([255, 255, 255, 255], (y * W + x) * 4);
  const frame = { D: 600, z: 1, px: 0, py: 0 };   // R = 0.008 * 600 = 4.8 px on 35 mm
  const p = Film.params(st({ grain: 0, halation: 1 }), frame);
  const p0 = Film.params(st({ grain: 0, halation: 0 }), frame);
  const on = Film.reference(src, W, H, p, frame), off = Film.reference(src, W, H, p0, frame);
  const at = (a, x, y, c) => a[(y * W + x) * 4 + c];
  assert.ok(at(on, 39, 32, 0) - at(off, 39, 32, 0) >= 8, 'red glow next to it');
  assert.ok(at(on, 39, 32, 0) - at(off, 39, 32, 0) > at(on, 39, 32, 2) - at(off, 39, 32, 2), 'redder than blue');
  assert.strictEqual(at(on, 2, 2, 0), at(off, 2, 2, 0), 'nothing far away');
});

test('referenceBands joins bands seamlessly (equals the whole-image reference)', () => {
  const W = 50, H = 70, src = flat(W, H, [140, 110, 90]);
  const frame = { D: 3060, z: 1, px: 0, py: 0 };
  const p = Film.params(st({ gauge: 's8', halation: 0.7 }), frame);
  const whole = Film.reference(src, W, H, p, frame);
  const banded = Film.referenceBands(src, W, H, p, frame, 16);
  assert.deepStrictEqual(Array.from(banded), Array.from(whole));
});

test('Settings.ENUMS.stock lists Off then Film.STOCKS in order', () => {
  const Settings = require('../settings.js');
  assert.deepStrictEqual(Settings.ENUMS.stock, ['off'].concat(Film.STOCKS.map((s) => s.id)));
  assert.deepStrictEqual(Settings.ENUMS.gauge, Film.GAUGES.map((g) => g.id));
});

// Review finding: above 100 % the preview must magnify the export's grain,
// not re-blur block noise (which overstated it by about the zoom factor).
function grainStd(p, frame, W, H) {
  const g = 118, src = flat(W, H, [g, g, g]);
  const on = Film.reference(src, W, H, p, frame);
  const off = Film.reference(src, W, H, Object.assign({}, p, { amount: 0 }), frame);
  let s2 = 0;
  for (let i = 0; i < W * H; i++) { const d = (on[i * 4] - off[i * 4]) / 255; s2 += d * d; }
  return Math.sqrt(s2 / (W * H));
}

test('zoomed in, the preview shows the export grain magnified (same strength, pixel for pixel)', () => {
  const s = st({ stock: 'smooth400bw', gauge: 's8', halation: 0 });
  const f1 = { D: 3060, z: 1, px: 0, py: 0 }, f3 = { D: 3060, z: 3, px: -7, py: 5 };
  const p1 = Film.params(s, f1), p3 = Film.params(s, f3);
  const W = 96, H = 96;
  const a = grainStd(p1, f1, W, H), b = grainStd(p3, f3, 3 * W, 3 * H);
  near(b, a, 0.1 * a, 'std at 300 %');
  const src1 = flat(W, H, [118, 118, 118]), src3 = flat(3 * W, 3 * H, [118, 118, 118]);
  const o1 = Film.reference(src1, W, H, p1, f1), o3 = Film.reference(src3, 3 * W, 3 * H, p3, f3);
  for (let y = 40; y < 200; y += 7) for (let x = 40; x < 200; x += 5) {
    const ex = Math.floor((x + 0.5 + 7) / 3), ey = Math.floor((y + 0.5 - 5) / 3);
    assert.strictEqual(o3[(y * 3 * W + x) * 4], o1[(ey * W + ex) * 4], `${x},${y}`);
  }
});

test('zoomed out, the preview grain is weaker, as the scaled model says', () => {
  const s = st({ stock: 'smooth400bw', gauge: 's8', halation: 0 });
  const f1 = { D: 3060, z: 1, px: 0, py: 0 }, fq = { D: 3060, z: 0.25, px: 0, py: 0 };
  const p1 = Film.params(s, f1), pq = Film.params(s, fq);
  const a = grainStd(p1, f1, 96, 96), q = grainStd(pq, fq, 192, 192);
  assert.ok(q < a * 0.8, `${q} vs ${a}`);
  const u = Film.reference(flat(4, 4, [118, 118, 118]), 4, 4, Object.assign({}, pq, { amount: 0 }), fq)[0] / 255;
  near(q, pq.grain.std[Math.round(u * 200)], 0.1 * q, 'matches the model at 25 %');
});
