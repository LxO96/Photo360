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

  function detectLayout(width, height) {
    const aspect = width / height;
    if (Math.abs(aspect - 2) < ASPECT_TOLERANCE) {
      return { kind: 'dual', lensSize: height, lenses: [{ x: 0, y: 0 }, { x: height, y: 0 }] };
    }
    if (Math.abs(aspect - 1) < ASPECT_TOLERANCE) {
      return { kind: 'single', lensSize: height, lenses: [{ x: 0, y: 0 }] };
    }
    return { kind: 'unsupported', lensSize: 0, lenses: [] };
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

  return { THETA_MAX_DEG, radiusForFov, fovForRadius, coverage, detectLayout, exportLayout, exportFilename, rollFor };
});
