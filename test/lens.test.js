'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Lens = require('../lens.js');

test('theta max reflects the measured X5 calibration', () => {
  assert.strictEqual(Lens.THETA_MAX_DEG, 105);
});

test('180 degrees falls at 0.857 of the image-circle radius', () => {
  assert.ok(Math.abs(Lens.radiusForFov(180) - 90 / 105) < 1e-9);
});

test('the full lens FOV fills the whole image circle', () => {
  assert.ok(Math.abs(Lens.radiusForFov(210) - 1) < 1e-9);
});

test('radius and FOV round-trip', () => {
  for (const fov of [120, 160, 180, 195, 210]) {
    assert.ok(Math.abs(Lens.fovForRadius(Lens.radiusForFov(fov)) - fov) < 1e-9);
  }
});

test('an alternate calibration shifts the crop radius', () => {
  assert.ok(Math.abs(Lens.radiusForFov(180, 100) - 0.9) < 1e-9);
});

test('at 180 degrees nothing is duplicated with the other lens', () => {
  const c = Lens.coverage(180);
  assert.strictEqual(c.overlapDeg, 0);
  assert.strictEqual(c.duplicatedAreaFraction, 0);
});

test('as-shot 210 degrees duplicates about half the image area', () => {
  const c = Lens.coverage(210);
  assert.ok(Math.abs(c.overlapDeg - 30) < 1e-9);
  assert.ok(Math.abs(c.duplicatedAreaFraction - (1 - (75 / 105) ** 2)) < 1e-9);
  assert.ok(c.duplicatedAreaFraction > 0.48 && c.duplicatedAreaFraction < 0.50);
});

test('below 180 degrees there is a gap, not duplication', () => {
  const c = Lens.coverage(160);
  assert.ok(Math.abs(c.overlapDeg - -20) < 1e-9);
  assert.strictEqual(c.duplicatedAreaFraction, 0);
});

test('a full-size X5 file is detected as dual fisheye', () => {
  const l = Lens.detectLayout(11904, 5952);
  assert.strictEqual(l.kind, 'dual');
  assert.strictEqual(l.lensSize, 5952);
  assert.deepStrictEqual(l.lenses, [{ x: 0, y: 0 }, { x: 5952, y: 0 }]);
});

test('the smaller X5 file is also detected as dual fisheye', () => {
  const l = Lens.detectLayout(5888, 2944);
  assert.strictEqual(l.kind, 'dual');
  assert.strictEqual(l.lensSize, 2944);
  assert.deepStrictEqual(l.lenses, [{ x: 0, y: 0 }, { x: 2944, y: 0 }]);
});

test('a square file is detected as a single fisheye', () => {
  const l = Lens.detectLayout(3040, 3040);
  assert.strictEqual(l.kind, 'single');
  assert.strictEqual(l.lensSize, 3040);
  assert.deepStrictEqual(l.lenses, [{ x: 0, y: 0 }]);
});

test('an ordinary photo is unsupported', () => {
  assert.strictEqual(Lens.detectLayout(4000, 3000).kind, 'unsupported');
});

test('a single-lens export is square and centred', () => {
  const g = Lens.exportLayout({
    circleDiameter: 5100, sensors: 'A', orientation: 'side', gapPx: 0, marginPx: 0,
  });
  assert.strictEqual(g.width, 5100);
  assert.strictEqual(g.height, 5100);
  assert.deepStrictEqual(g.circles, [{ cx: 2550, cy: 2550, lens: 'A' }]);
});

test('a two-up export with no gap is exactly 2:1', () => {
  const g = Lens.exportLayout({
    circleDiameter: 5100, sensors: 'both', orientation: 'side', gapPx: 0, marginPx: 0,
  });
  assert.strictEqual(g.width, 10200);
  assert.strictEqual(g.height, 5100);
  assert.deepStrictEqual(g.circles, [
    { cx: 2550, cy: 2550, lens: 'A' },
    { cx: 7650, cy: 2550, lens: 'B' },
  ]);
});

test('gap and margin add real pixels around the circles', () => {
  const g = Lens.exportLayout({
    circleDiameter: 5100, sensors: 'both', orientation: 'side', gapPx: 100, marginPx: 50,
  });
  assert.strictEqual(g.width, 50 + 5100 + 100 + 5100 + 50);
  assert.strictEqual(g.height, 50 + 5100 + 50);
  assert.strictEqual(g.circles[0].cx, 2600);
  assert.strictEqual(g.circles[1].cx, 7800);
  assert.strictEqual(g.circles[0].cy, 2600);
});

test('a stacked two-up export is exactly 1:2', () => {
  const g = Lens.exportLayout({
    circleDiameter: 5100, sensors: 'both', orientation: 'stacked', gapPx: 0, marginPx: 0,
  });
  assert.strictEqual(g.width, 5100);
  assert.strictEqual(g.height, 10200);
  assert.deepStrictEqual(g.circles, [
    { cx: 2550, cy: 2550, lens: 'A' },
    { cx: 2550, cy: 7650, lens: 'B' },
  ]);
});

test('exporting lens B alone still yields one centred circle labelled B', () => {
  const g = Lens.exportLayout({
    circleDiameter: 4000, sensors: 'B', orientation: 'side', gapPx: 999, marginPx: 0,
  });
  assert.strictEqual(g.width, 4000);
  assert.deepStrictEqual(g.circles, [{ cx: 2000, cy: 2000, lens: 'B' }]);
});

// -- Task 12 follow-up: the stated output requirement is a circle on a
// black square, either 1:1 (one lens) or exactly 2:1 (side by side) /
// 1:2 (stacked). A single lens is square under any margin (equal on all
// four sides), but the two-up layout is
// width = 2*diameter + gap + 2*margin, height = diameter + 2*margin, which
// is exactly 2:1 only when gap == 2*margin. app.js's shipped defaults
// (gapFrac 0.16, marginFrac 0.08) rely on exactly this relationship to stay
// on 2:1/1:2 while still leaving room for the rim glow -- these tests pin
// it so a future change to either default can't quietly break it again.
test('side-by-side is exactly 2:1 whenever gap equals twice the margin', () => {
  for (const [diameter, marginPx] of [[5100, 0], [5100, 408], [4000, 250], [2000, 500]]) {
    const gapPx = 2 * marginPx;
    const g = Lens.exportLayout({
      circleDiameter: diameter, sensors: 'both', orientation: 'side', gapPx, marginPx,
    });
    assert.strictEqual(g.width, g.height * 2,
      `diameter=${diameter} margin=${marginPx}: expected exactly 2:1, got ${g.width}x${g.height}`);
  }
});

test('stacked is exactly 1:2 whenever gap equals twice the margin', () => {
  for (const [diameter, marginPx] of [[5100, 0], [5100, 408], [4000, 250], [2000, 500]]) {
    const gapPx = 2 * marginPx;
    const g = Lens.exportLayout({
      circleDiameter: diameter, sensors: 'both', orientation: 'stacked', gapPx, marginPx,
    });
    assert.strictEqual(g.height, g.width * 2,
      `diameter=${diameter} margin=${marginPx}: expected exactly 1:2, got ${g.width}x${g.height}`);
  }
});

test('the shipped defaults (gapFrac 0, marginFrac 0) land on exactly 2:1 / 1:2', () => {
  const diameter = 5100; // an arbitrary but representative circle size
  const marginPx = 0;
  const gapPx = 0;
  const side = Lens.exportLayout({
    circleDiameter: diameter, sensors: 'both', orientation: 'side', gapPx, marginPx,
  });
  assert.strictEqual(side.width, side.height * 2);
  const stacked = Lens.exportLayout({
    circleDiameter: diameter, sensors: 'both', orientation: 'stacked', gapPx, marginPx,
  });
  assert.strictEqual(stacked.height, stacked.width * 2);
});

test('a two-up export is NOT exactly 2:1 when gap does not equal twice the margin', () => {
  // Confirms the assertions above are actually testing something -- gap and
  // margin chosen away from the 2*margin relationship must not coincide
  // with 2:1 by accident.
  const g = Lens.exportLayout({
    circleDiameter: 5100, sensors: 'both', orientation: 'side', gapPx: 0, marginPx: 408,
  });
  assert.notStrictEqual(g.width, g.height * 2);
});

test('single-lens export stays exactly 1:1 for any margin', () => {
  for (const marginPx of [0, 1, 100, 408, 1000, 2500]) {
    const g = Lens.exportLayout({
      circleDiameter: 5100, sensors: 'A', orientation: 'side', gapPx: 999, marginPx,
    });
    assert.strictEqual(g.width, g.height,
      `marginPx=${marginPx}: expected square, got ${g.width}x${g.height}`);
  }
});

test('a stacked 1:2 file is detected as dual fisheye', () => {
  const l = Lens.detectLayout(1520, 3040);
  assert.strictEqual(l.kind, 'dual');
  assert.strictEqual(l.lensSize, 1520);
  assert.deepStrictEqual(l.lenses, [{ x: 0, y: 0 }, { x: 0, y: 1520 }]);
});

test('the full-size stacked reference is detected as dual fisheye', () => {
  const l = Lens.detectLayout(3040, 6080);
  assert.strictEqual(l.kind, 'dual');
  assert.strictEqual(l.lensSize, 3040);
  assert.deepStrictEqual(l.lenses, [{ x: 0, y: 0 }, { x: 0, y: 3040 }]);
});

// Final whole-branch review, Minor finding: ASPECT_TOLERANCE used to be an
// absolute margin (0.02) applied to the *aspect ratio*, which is four times
// looser for the 1:2/2:1 checks than for the 1:1 check in relative terms.
// A 3040x6160 file (80px off an exact 3040x6080 1:2 split) used to pass as
// 'stacked' and sample its second lens 80px off the true split. The
// tolerance is now relative and applied to the pixel dimensions directly,
// so this near-miss is correctly refused.
test('a near-miss 1:2 shape (80px off an exact split) is not detected as dual fisheye', () => {
  const l = Lens.detectLayout(3040, 6160);
  assert.strictEqual(l.kind, 'unsupported');
});

test('side-by-side detection is unchanged by the stacked case', () => {
  const l = Lens.detectLayout(11904, 5952);
  assert.strictEqual(l.kind, 'dual');
  assert.deepStrictEqual(l.lenses, [{ x: 0, y: 0 }, { x: 5952, y: 0 }]);
});

test('the X5 calibration is the measured 105 degrees', () => {
  const c = Lens.calibrationFor('Insta360 X5');
  assert.strictEqual(c.thetaMaxDeg, 105);
  assert.strictEqual(c.confident, true);
  assert.strictEqual(c.source, 'measured');
});

test('the ONE X calibration is the user-reported 95 degrees (190 full), not measured', () => {
  const c = Lens.calibrationFor('Insta360 One2');
  assert.strictEqual(c.thetaMaxDeg, 95);
  assert.strictEqual(c.confident, false);
  assert.strictEqual(c.source, 'user-reported');
});

test('every calibration names its source', () => {
  for (const [model, cal] of Object.entries(Lens.CALIBRATIONS)) {
    assert.ok(typeof cal.source === 'string' && cal.source.length > 0, model);
    assert.ok(typeof cal.label === 'string' && cal.label.length > 0, model);
  }
});

test('no camera model strings are invented: only the two seen in real files', () => {
  // X5 (the .insp test files) and One2 (the ONE X DNGs and reference
  // JPEGs). ONE X2/X3/X4 are deliberately absent until their exact EXIF
  // model strings are confirmed from real files -- see the Task 19 report.
  assert.deepStrictEqual(Object.keys(Lens.CALIBRATIONS).sort(), ['Insta360 One2', 'Insta360 X5']);
});

test('an unknown camera falls back to the X5 default, unconfidently', () => {
  const c = Lens.calibrationFor('Some Other Camera');
  assert.strictEqual(c.thetaMaxDeg, Lens.THETA_MAX_DEG);
  assert.strictEqual(c.confident, false);
});

test('a missing model falls back the same way', () => {
  assert.strictEqual(Lens.calibrationFor(null).thetaMaxDeg, Lens.THETA_MAX_DEG);
});

test('the two calibrations put 180 degrees at different crop radii', () => {
  const x5 = Lens.radiusForFov(180, Lens.calibrationFor('Insta360 X5').thetaMaxDeg);
  const one = Lens.radiusForFov(180, Lens.calibrationFor('Insta360 One2').thetaMaxDeg);
  assert.ok(Math.abs(x5 - 90 / 105) < 1e-9);
  assert.ok(Math.abs(one - 90 / 95) < 1e-9, 'ONE X 180 degrees is 0.947 R');
  assert.ok(one > x5, 'the narrower (190 degree) ONE X lens crops closer to its rim than the X5');
});

test('an unrecognized model in a stacked file still gets the plain X5 default', () => {
  // "no usable model" (empty/null) is what triggers the layout guess below --
  // a present-but-unrecognized model name is still a known model, just not
  // one this tool has measured, so it must not be treated the same way.
  const c = Lens.calibrationFor('Some Other Camera', 'stacked');
  assert.strictEqual(c.thetaMaxDeg, Lens.THETA_MAX_DEG);
  assert.strictEqual(c.confident, false);
});

test('an unknown model in a stacked file infers the ONE X calibration', () => {
  const c = Lens.calibrationFor(null, 'stacked');
  assert.strictEqual(c.thetaMaxDeg, 95);
  assert.strictEqual(c.source, 'guessed from stacked layout');
  assert.strictEqual(c.confident, false);
});

test('an unknown model in a side-by-side file keeps the X5 default', () => {
  const c = Lens.calibrationFor(null, 'side');
  assert.strictEqual(c.thetaMaxDeg, Lens.THETA_MAX_DEG);
  assert.strictEqual(c.confident, false);
});

test('a known model overrides the layout inference in a stacked file', () => {
  // The deliberately contrary case: an X5 tag on a stacked file (physically
  // impossible for a real X5, but the model, once known, must still win).
  const c = Lens.calibrationFor('Insta360 X5', 'stacked');
  assert.strictEqual(c.thetaMaxDeg, 105);
  assert.strictEqual(c.confident, true);
});

test('a known model overrides the layout inference in a side-by-side file', () => {
  const c = Lens.calibrationFor('Insta360 One2', 'side');
  assert.strictEqual(c.thetaMaxDeg, 95);
  assert.strictEqual(c.confident, false);
});

test('filenames record the source, lens and FOV', () => {
  assert.strictEqual(
    Lens.exportFilename('Sunscreen.insp', 'A', 180, 'jpg'),
    'Sunscreen_A_180deg.jpg'
  );
  assert.strictEqual(
    Lens.exportFilename('IMG_20260511_094146_00_004.insp', 'AB', 177.5, 'png'),
    'IMG_20260511_094146_00_004_AB_177-5deg.png'
  );
});

// -- Task 19: FOV slider per camera model ---------------------------------

test('fovRangeFor: the FOV slider runs from 120 to twice theta-max', () => {
  assert.deepStrictEqual(Lens.fovRangeFor(105), [120, 210]);
  assert.deepStrictEqual(Lens.fovRangeFor(95), [120, 190]);
  // Never an inverted range, even for a calibration narrower than 120 full.
  assert.deepStrictEqual(Lens.fovRangeFor(55), [120, 120]);
});

test('calibrationNote: model, full FOV and source', () => {
  assert.strictEqual(Lens.calibrationNote(Lens.calibrationFor('Insta360 X5'), 105),
    'X5 · 210° full · measured');
  assert.strictEqual(Lens.calibrationNote(Lens.calibrationFor('Insta360 One2'), 95),
    'ONE X · 190° full · user-reported');
  assert.strictEqual(Lens.calibrationNote(Lens.calibrationFor(null, 'stacked'), 95),
    'Camera not identified · 190° full · guessed from stacked layout');
  assert.strictEqual(Lens.calibrationNote(Lens.calibrationFor('Some Camera'), 105),
    'Some Camera · 210° full · X5 default, unverified');
  assert.strictEqual(Lens.calibrationNote(Lens.calibrationFor(''), 105),
    'Camera not identified · 210° full · X5 default, unverified');
});

test('calibrationNote says so when the Calibration slider has moved off the model value', () => {
  assert.strictEqual(Lens.calibrationNote(Lens.calibrationFor('Insta360 One2'), 97.5),
    'ONE X · 190° full · user-reported · set to 195°');
});

// -- Straighten tool ------------------------------------------------------
// Builds a 3D line, projects its two ends through the equidistant lens
// (half-FOV `half`), rolls the displayed image by `rollDeg` (counter-
// clockwise, y up), and checks straightenDelta recovers the roll.
function project(v, halfDeg) {
  const len = Math.hypot(v[0], v[1], v[2]);
  const theta = Math.acos(v[2] / len) * 180 / Math.PI;
  const psi = Math.atan2(v[1], v[0]);
  const r = theta / halfDeg;
  return { x: r * Math.cos(psi), y: r * Math.sin(psi) };
}
function rotate(p, deg) {
  const a = deg * Math.PI / 180;
  return { x: p.x * Math.cos(a) - p.y * Math.sin(a), y: p.x * Math.sin(a) + p.y * Math.cos(a) };
}

test('straightenDelta levels a vertical line, even off-centre where it curves', () => {
  for (const roll of [-20, -3, 0, 7.5, 30]) {
    for (const x of [0, 0.4, -1.2]) {
      const a = rotate(project([x, -0.6, 1], 90), roll);
      const b = rotate(project([x, 0.8, 1], 90), roll);
      const s = Lens.straightenDelta(a, b, 90);
      assert.strictEqual(s.kind, 'vertical');
      assert.ok(Math.abs(s.deltaDeg + roll) < 1e-9, `roll ${roll} x ${x}: ${s.deltaDeg}`);
    }
  }
});

test('straightenDelta levels a horizontal line and the horizon', () => {
  for (const roll of [-25, 4, 12]) {
    // A horizontal edge facing the camera, above centre.
    let a = rotate(project([-0.9, 0.5, 1], 95), roll);
    let b = rotate(project([0.7, 0.5, 1], 95), roll);
    let s = Lens.straightenDelta(a, b, 95);
    assert.strictEqual(s.kind, 'horizontal');
    assert.ok(Math.abs(s.deltaDeg + roll) < 1e-9, `edge roll ${roll}: ${s.deltaDeg}`);
    // The horizon: horizontal directions at any depth.
    a = rotate(project([-1, 0, 0.3], 95), roll);
    b = rotate(project([1, 0, 2], 95), roll);
    s = Lens.straightenDelta(a, b, 95);
    assert.strictEqual(s.kind, 'horizontal');
    assert.ok(Math.abs(s.deltaDeg + roll) < 1e-9, `horizon roll ${roll}: ${s.deltaDeg}`);
  }
});

test('straightenDelta returns null for a zero-length line', () => {
  assert.strictEqual(Lens.straightenDelta({ x: 0.2, y: 0.1 }, { x: 0.2, y: 0.1 }, 90), null);
});

test('print orientation follows the image: wide is landscape, square or tall is portrait', () => {
  assert.strictEqual(Lens.printOrientation(11904, 5952), 'landscape');
  assert.strictEqual(Lens.printOrientation(5952, 5952), 'portrait');
  assert.strictEqual(Lens.printOrientation(4000, 6000), 'portrait');
});
