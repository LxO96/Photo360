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

  return { fitScale, fitView, visibleRect };
});
