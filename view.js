(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.View = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Preview placement maths (Task 19): where the composition sits on the
  // stage and at what scale. Pure -- no DOM, no GL -- so app.js's fit, zoom
  // and pan behaviour is unit-testable in Node.
  //
  // Units: the stage is `availW x availH` *device* pixels (CSS pixels times
  // devicePixelRatio, inside the stage padding). The composition is
  // `contentW x contentH` *export* pixels -- GL.exportGeometry's size, i.e.
  // exactly what Export would write with the current Output settings. A
  // view is { scale, ox, oy }: `scale` device pixels per export pixel (so
  // scale 1 is "100%"), and (ox, oy) the device-pixel position of the
  // composition's top-left corner relative to the stage's top-left.

  // The largest scale at which the whole composition fits the stage.
  function fitScale(availW, availH, contentW, contentH) {
    if (!(availW > 0 && availH > 0 && contentW > 0 && contentH > 0)) return 0;
    return Math.min(availW / contentW, availH / contentH);
  }

  // The composition at fit scale, centred -- its true aspect ratio, as large
  // as the stage allows.
  function fitView(availW, availH, contentW, contentH) {
    const scale = fitScale(availW, availH, contentW, contentH);
    return {
      scale,
      ox: (availW - contentW * scale) / 2,
      oy: (availH - contentH * scale) / 2,
    };
  }

  // The part of the stage the composition actually covers under `view`,
  // snapped outward to whole device pixels: that is the size and position
  // of the preview canvas, so a zoomed-in preview only ever allocates (and
  // renders) the visible region, at true resolution. `place` is the whole
  // composition's rect relative to that canvas's own top-left -- usually
  // partly off-canvas when zoomed -- which is what GL.renderComposition's
  // `place` argument lays the circles out in.
  function visibleRect(view, availW, availH, contentW, contentH) {
    const w = contentW * view.scale, h = contentH * view.scale;
    const x0 = Math.max(0, Math.floor(view.ox));
    const y0 = Math.max(0, Math.floor(view.oy));
    const x1 = Math.min(availW, Math.ceil(view.ox + w));
    const y1 = Math.min(availH, Math.ceil(view.oy + h));
    return {
      x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0),
      place: { x: view.ox - x0, y: view.oy - y0, w, h },
    };
  }

  // -- Zoom and pan --------------------------------------------------------
  // Beyond 100% the preview samples the lens texture finer than the export
  // would; 800% is plenty for checking the rim and focus.
  const MAX_SCALE = 8;
  const ZOOM_STEPS = [1 / 16, 1 / 8, 1 / 4, 1 / 3, 1 / 2, 2 / 3, 1, 2, 3, 4, 6, 8];

  // Zooming out stops at fit -- or at 100%, for a composition so small that
  // it fits the stage above 100%.
  function clampScale(scale, fit) {
    return Math.min(MAX_SCALE, Math.max(Math.min(fit, 1), scale));
  }

  // The view at `scale` that keeps the content point under the stage point
  // (px, py) exactly where it is.
  function zoomAbout(view, scale, px, py) {
    const k = scale / view.scale;
    return { scale, ox: px - (px - view.ox) * k, oy: py - (py - view.oy) * k };
  }

  // Per axis: content wider than the stage may be panned only until one of
  // its edges reaches the stage edge (so it always covers the stage, and
  // can never be dragged fully off); content narrower than the stage is
  // centred on that axis.
  function clampAxis(o, avail, size) {
    if (size <= avail) return (avail - size) / 2;
    return Math.min(0, Math.max(avail - size, o));
  }

  function clampPan(view, availW, availH, contentW, contentH) {
    return {
      scale: view.scale,
      ox: clampAxis(view.ox, availW, contentW * view.scale),
      oy: clampAxis(view.oy, availH, contentH * view.scale),
    };
  }

  // The next preset zoom level in direction `dir` (+1 in, -1 out), clamped.
  function stepZoom(scale, dir, fit) {
    const eps = 1e-6;
    let next;
    if (dir > 0) next = ZOOM_STEPS.find((z) => z > scale * (1 + eps));
    else next = ZOOM_STEPS.slice().reverse().find((z) => z < scale * (1 - eps));
    if (next === undefined) next = dir > 0 ? MAX_SCALE : 0;
    return clampScale(next, fit);
  }

  // Continuous zoom for a wheel event's deltaY (pixels; negative = wheel up
  // = zoom in). About 15% per ordinary 100px notch.
  function wheelScale(scale, deltaY, fit) {
    return clampScale(scale * Math.exp(-deltaY * 0.0015), fit);
  }

  return {
    fitScale, fitView, visibleRect,
    MAX_SCALE, ZOOM_STEPS, clampScale, zoomAbout, clampPan, stepZoom, wheelScale,
  };
});
