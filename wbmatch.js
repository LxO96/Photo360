(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WbMatch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Match lenses (the White balance panel): two sampling circles, a target
  // on one lens and a source on the other, and the source lens's white
  // balance that makes its circle's colour match the target's.
  //
  // A circle is pinned to the photo, not the screen: { lens (physical
  // 'A' | 'B'), uv (lens texture position, what COMPOSITE_FS's lensUv
  // gives), r (radius in the same uv units) }, so it follows zoom, pan
  // and roll. `disc` below is a lens circle on the canvas: { cx, cy,
  // radius } in canvas pixels (y down), plus the lens's roll (radians, as
  // the composite gets it) and the crop fraction (Lens.radiusForFov).

  // Canvas point -> lens uv (the inverse of lensToScreen), mirroring
  // COMPOSITE_FS: p is y-up from the circle centre, u = |p| / radius,
  // uv = 0.5 + (cos, sin)(theta + roll) * u * crop / 2.
  function screenToLens(pt, disc) {
    const px = pt.x - disc.cx, py = -(pt.y - disc.cy);
    const u = Math.hypot(px, py) / disc.radius;
    const a = Math.atan2(py, px) + disc.roll;
    const k = u * disc.crop / 2;
    return [0.5 + Math.cos(a) * k, 0.5 + Math.sin(a) * k];
  }

  function lensToScreen(uv, disc) {
    const dx = uv[0] - 0.5, dy = uv[1] - 0.5;
    const u = Math.hypot(dx, dy) * 2 / disc.crop;
    const a = Math.atan2(dy, dx) - disc.roll;
    return { x: disc.cx + Math.cos(a) * u * disc.radius, y: disc.cy - Math.sin(a) * u * disc.radius };
  }

  // Radius in canvas pixels <-> uv units.
  const radiusToLens = (px, disc) => px / disc.radius * disc.crop / 2;
  const radiusToScreen = (r, disc) => r * 2 / disc.crop * disc.radius;

  // The source lens's new neutral (camera RGB, green 1) that renders the
  // source colour with the target's chromaticity. `source` / `target`:
  // mean linear sRGB as rendered now; `camToSrgb` and `neutral`: the
  // source lens's current matrix and neutral. The camera value behind the
  // source colour is neutral * M^-1 source; under a new neutral n' it
  // renders as M (cam / n'), which is proportional to the target when
  // n' = cam / (M^-1 target). (M itself follows the neutral, so the
  // caller measures and solves again until it settles.) Null if a colour
  // leaves nothing to solve with.
  function solve(source, target, camToSrgb, neutral, invert) {
    const inv = invert(camToSrgb);
    if (!inv) return null;
    const mul = (m, v) => [0, 1, 2].map((r) => m[r * 3] * v[0] + m[r * 3 + 1] * v[1] + m[r * 3 + 2] * v[2]);
    const camS = mul(inv, source).map((v, i) => v * neutral[i]);
    const camT = mul(inv, target);
    if (!camS.every((v) => v > 1e-6) || !camT.every((v) => v > 1e-6)) return null;
    const n = camS.map((v, i) => v / camT[i]);
    return [n[0] / n[1], 1, n[2] / n[1]];
  }

  // Chromaticity distance of two linear colours (log r/g, b/g), for the
  // note and the tests.
  function chromaDistance(a, b) {
    const c = (v) => [Math.log(v[0] / v[1]), Math.log(v[2] / v[1])];
    const x = c(a), y = c(b);
    return Math.hypot(x[0] - y[0], x[1] - y[1]);
  }

  // The two circles must sit on different lenses.
  function differentLenses(a, b) {
    return !!a && !!b && a.lens !== b.lens;
  }

  const MIN_R = 0.01, MAX_R = 0.2;   // uv units
  const clampRadius = (r) => Math.min(MAX_R, Math.max(MIN_R, r));

  return {
    screenToLens, lensToScreen, radiusToLens, radiusToScreen, solve, chromaDistance, differentLenses,
    MIN_R, MAX_R, clampRadius,
  };
});
