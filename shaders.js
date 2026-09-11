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

  const PROFILE_BUILD_FS = `#version 300 es
  precision highp float;
  uniform sampler2D uLens;
  uniform float uBins;
  uniform int   uRadialSamples;
  uniform float uUMin, uUMax;
  uniform float uKnee, uExponent;
  uniform float uCropFrac, uRoll;
  out vec4 fragColor;

  const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

  void main() {
    float bin = floor(gl_FragCoord.x);
    float theta = ((bin + 0.5) / uBins) * 6.283185307179586;
    float acc = 0.0;
    vec3 col = vec3(0.0);
    for (int j = 0; j < 64; j++) {
      if (j >= uRadialSamples) break;
      float u = uUMin + (uUMax - uUMin) * ((float(j) + 0.5) / float(uRadialSamples));
      float a = theta + uRoll;
      vec2 off = vec2(cos(a), sin(a)) * (u * uCropFrac * 0.5);
      vec3 c = texture(uLens, vec2(0.5) + off).rgb;
      acc += pow(max(0.0, dot(c, LUMA) - uKnee), uExponent);
      col += c;
    }
    float n = float(uRadialSamples);
    fragColor = vec4(acc / n, col / n);
  }`;

  const PROFILE_BLUR_FS = `#version 300 es
  precision highp float;
  uniform sampler2D uProfile;
  uniform float uBins;
  uniform float uSpreadBins;
  out vec4 fragColor;

  void main() {
    if (uSpreadBins <= 0.0) {
      fragColor = texelFetch(uProfile, ivec2(int(gl_FragCoord.x), 0), 0);
      return;
    }
    int radius = int(ceil(uSpreadBins * 3.0));
    float bin = floor(gl_FragCoord.x);
    vec4 acc = vec4(0.0);
    float wsum = 0.0;
    for (int k = -192; k <= 192; k++) {
      if (k < -radius || k > radius) continue;
      float w = exp(-float(k * k) / (2.0 * uSpreadBins * uSpreadBins));
      int j = int(mod(bin + float(k) + uBins, uBins));
      acc += texelFetch(uProfile, ivec2(j, 0), 0) * w;
      wsum += w;
    }
    fragColor = acc / wsum;
  }`;

  // Used only by the browser-side parity check (app.js `checkParity`): a
  // copy of PROFILE_BUILD_FS with the lens texture lookup replaced by the
  // same analytic sampler baked into test/fixtures/parity-input.json, so
  // the shader can be exercised against the JS reference without a real
  // photo.
  const PROFILE_BUILD_PARITY_FS = PROFILE_BUILD_FS.replace(
    'vec3 c = texture(uLens, vec2(0.5) + off).rgb;',
    'float sv = 0.5 + 0.5 * sin(theta * 3.0); vec3 c = vec3(sv * u, sv * 0.5, 1.0 - sv);'
  );

  return { FULLSCREEN_VS, COMPOSITE_FS, PROFILE_BUILD_FS, PROFILE_BLUR_FS, PROFILE_BUILD_PARITY_FS };
});
