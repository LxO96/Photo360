(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Lens = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Measured by correlating the two overlap annuli of the X5 test files:
  // each lens sees about 210 degrees, i.e. a half-angle of 105 degrees at
  // the rim of the image circle.
  const THETA_MAX_DEG = 105;

  // Fraction of the image-circle radius at which a given full FOV falls.
  // Equidistant model: theta is proportional to radius.
  function radiusForFov(fovDeg, thetaMaxDeg) {
    const tm = thetaMaxDeg === undefined ? THETA_MAX_DEG : thetaMaxDeg;
    return fovDeg / 2 / tm;
  }

  function fovForRadius(rFrac, thetaMaxDeg) {
    const tm = thetaMaxDeg === undefined ? THETA_MAX_DEG : thetaMaxDeg;
    return rFrac * tm * 2;
  }

  // How much of this lens's cropped image is also seen by the other lens.
  function coverage(fovDeg, thetaMaxDeg) {
    const tm = thetaMaxDeg === undefined ? THETA_MAX_DEG : thetaMaxDeg;
    const overlapDeg = fovDeg - 180;
    let duplicatedAreaFraction = 0;
    if (overlapDeg > 0) {
      const rOut = radiusForFov(fovDeg, tm);
      const rInner = (180 - fovDeg / 2) / tm;
      duplicatedAreaFraction = 1 - (rInner / rOut) ** 2;
    }
    return { overlapDeg, duplicatedAreaFraction };
  }

  const ASPECT_TOLERANCE = 0.02;

  // `arrangement` distinguishes the two physically different dual-fisheye
  // shapes ('side' 2:1, 'stacked' 1:2) for callers -- like calibrationFor's
  // layout-based inference below -- that need to know which one a file is
  // without re-deriving it from width/height themselves. 'single' for a 1:1
  // file, null when unsupported.
  function detectLayout(width, height) {
    const aspect = width / height;
    // The 1:1 check must come before either dual case: a square image's
    // aspect is 1, not 2 or 0.5, so this ordering is not load-bearing for
    // correctness here, but it is the guard the brief asks for against a
    // square image ever falling into a dual branch.
    if (Math.abs(aspect - 1) < ASPECT_TOLERANCE) {
      return { kind: 'single', lensSize: height, lenses: [{ x: 0, y: 0 }], arrangement: 'single' };
    }
    if (Math.abs(aspect - 2) < ASPECT_TOLERANCE) {
      return {
        kind: 'dual', lensSize: height, lenses: [{ x: 0, y: 0 }, { x: height, y: 0 }],
        arrangement: 'side',
      };
    }
    if (Math.abs(aspect - 0.5) < ASPECT_TOLERANCE) {
      return {
        kind: 'dual', lensSize: width, lenses: [{ x: 0, y: 0 }, { x: 0, y: width }],
        arrangement: 'stacked',
      };
    }
    return { kind: 'unsupported', lensSize: 0, lenses: [], arrangement: null };
  }

  // theta-max per camera body, measured by correlating the two lenses' overlap
  // annuli. The X5 figure is corroborated by three files agreeing at
  // 104-107 degrees; the ONE X figure comes from a single usable reference
  // (peak correlation 0.60), so it is applied but flagged unconfident.
  const CALIBRATIONS = {
    'Insta360 X5': { thetaMaxDeg: 105, confident: true },
    'Insta360 One2': { thetaMaxDeg: 112.5, confident: false },
  };

  // `arrangement` (from Lens.detectLayout) lets the fallback for a file with
  // no usable EXIF model do better than always assuming the X5: a stacked
  // 1:2 file cannot physically be an X5, which only ever writes 2:1
  // side-by-side dual fisheye, so a ONE X-shaped guess is a strictly better
  // default than the X5's narrower calibration for that shape. This is only
  // ever a fallback -- a recognized model (`hit`) always wins over the
  // layout guess, in either arrangement, including the deliberately
  // contrary case of an X5 tag on a stacked file. A present-but-unrecognized
  // model (some other camera name) still falls through to the plain X5
  // default below, unaffected by arrangement, since the model in that case
  // *is* known -- just not one this tool has measured.
  function calibrationFor(model, arrangement) {
    const key = (model || '').replace(/\0+$/, '').trim();
    const hit = CALIBRATIONS[key];
    if (hit) return { thetaMaxDeg: hit.thetaMaxDeg, model: key, confident: hit.confident };
    if (!key && arrangement === 'stacked') {
      const guess = CALIBRATIONS['Insta360 One2'];
      return { thetaMaxDeg: guess.thetaMaxDeg, model: key, confident: false };
    }
    return { thetaMaxDeg: THETA_MAX_DEG, model: key, confident: false };
  }

  function exportLayout(opts) {
    const d = opts.circleDiameter;
    const m = opts.marginPx;
    const both = opts.sensors === 'both';
    const gap = both ? opts.gapPx : 0;
    const stacked = opts.orientation === 'stacked';
    const along = m + d + gap + d + m;   // long axis when two-up
    const across = m + d + m;
    const width = both ? (stacked ? across : along) : d + 2 * m;
    const height = both ? (stacked ? along : across) : d + 2 * m;
    const first = m + d / 2;
    const second = m + d + gap + d / 2;
    let circles;
    if (!both) {
      circles = [{ cx: width / 2, cy: height / 2, lens: opts.sensors }];
    } else if (stacked) {
      circles = [
        { cx: width / 2, cy: first, lens: 'A' },
        { cx: width / 2, cy: second, lens: 'B' },
      ];
    } else {
      circles = [
        { cx: first, cy: height / 2, lens: 'A' },
        { cx: second, cy: height / 2, lens: 'B' },
      ];
    }
    return { width, height, circles };
  }

  // The two lenses are back-to-back and their azimuths run in opposite
  // directions, so a single camera roll appears mirrored between them.
  function rollFor(state, lens) {
    const base = lens === 'A' ? state.rollDeg : -state.rollDeg;
    return base + state.nudgeDeg[lens];
  }

  function exportFilename(sourceName, lensLabel, fovDeg, ext) {
    const stem = sourceName.replace(/\.[^.]+$/, '');
    const fov = String(Math.round(fovDeg * 10) / 10).replace('.', '-');
    return `${stem}_${lensLabel}_${fov}deg.${ext}`;
  }

  return {
    THETA_MAX_DEG, radiusForFov, fovForRadius, coverage, detectLayout, exportLayout,
    exportFilename, rollFor, CALIBRATIONS, calibrationFor,
  };
});
