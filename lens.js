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

  return { THETA_MAX_DEG, radiusForFov, fovForRadius, coverage };
});
