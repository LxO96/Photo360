(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Shaders = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const FULLSCREEN_VS = `#version 300 es
  void main() {
    vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
  }`;

  const COMPOSITE_FS = `#version 300 es
  precision highp float;
  uniform sampler2D uLens;      // one square lens frame, S x S
  uniform vec2  uCellOrigin;    // viewport origin in absolute framebuffer pixels
  uniform vec2  uCellSize;      // viewport size in pixels
  uniform float uCircleRadius;  // output circle radius in pixels
  uniform float uCropFrac;      // crop radius as a fraction of the image circle
  uniform float uRoll;          // radians
  out vec4 fragColor;

  // Sample the source lens at output polar coordinates.
  // u is normalised so u = 1.0 is the crop edge.
  vec3 sampleLens(float u, float theta) {
    float a = theta + uRoll;
    vec2 off = vec2(cos(a), sin(a)) * (u * uCropFrac * 0.5);
    return texture(uLens, vec2(0.5) + off).rgb;
  }

  void main() {
    // gl_FragCoord.xy is in absolute framebuffer pixels, not relative to the
    // current viewport -- when the composition draws several circles into
    // their own sub-viewports (Task 6), the cell's origin must be
    // subtracted first to recover the cell-local, center-relative position.
    vec2 p = gl_FragCoord.xy - uCellOrigin - uCellSize * 0.5;
    float r = length(p);
    float u = r / uCircleRadius;
    if (u > 1.0) { fragColor = vec4(0.0); return; }
    float theta = atan(p.y, p.x);
    fragColor = vec4(sampleLens(u, theta), 1.0);
  }`;

  return { FULLSCREEN_VS, COMPOSITE_FS };
});
