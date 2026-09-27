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

  // Shared by COMPOSITE_FS and PROFILE_BUILD_FS: the single definition of
  // how output polar coordinates (u, theta) map to a sample of the source
  // lens texture. Both passes must agree on this geometry exactly -- if
  // they drift, the rim glow ends up rotated relative to the image it was
  // measured from (see the task-7 brief's controller decision #3). u is
  // normalised so u = 1.0 is the crop edge.
  const SAMPLE_LENS_GLSL = `
  vec3 sampleLensAt(sampler2D lens, float u, float theta, float cropFrac, float roll) {
    float a = theta + roll;
    vec2 off = vec2(cos(a), sin(a)) * (u * cropFrac * 0.5);
    return texture(lens, vec2(0.5) + off).rgb;
  }`;

  // Shared by COMPOSITE_RAW_FS and PROFILE_BUILD_RAW_FS, exactly the way
  // SAMPLE_LENS_GLSL is shared by the JPEG-source pair -- so the rim
  // profile always measures the same rendered (demosaiced, white-balanced,
  // colour-matrixed, gamma-encoded) pixels the viewer actually sees, never
  // the raw Bayer values. `sampleRawLensAt` returns a gamma-encoded sRGB
  // colour, matching what `sampleLensAt` returns when reading an ordinary
  // RGBA8 texture -- so both composite/profile passes downstream (tone,
  // terminator, glow) apply identically regardless of which sampler fed
  // them.
  //
  // Demosaic: a plain bilinear reconstruction that works for any of the
  // four standard 2x2 Bayer arrangements, not just GRBG, using one general
  // property of every valid Bayer CFA: the orthogonal (up/down/left/right)
  // neighbours of an R or B texel are always G, and the diagonal neighbours
  // of an R texel are always B (and vice versa). uCfaPattern encodes which
  // colour (0=R, 1=G, 2=B) sits at each of the 2x2 cell's four positions,
  // read directly from the DNG's CFAPattern tag (dng.js).
  const RAW_SAMPLE_GLSL = `
  uniform highp usampler2D uLens;
  uniform ivec2 uLensSize;
  uniform ivec4 uCfaPattern;   // colour (0=R,1=G,2=B) at (0,0),(1,0),(0,1),(1,1)
  uniform float uBlackLevel, uWhiteLevel;
  uniform vec3  uWhiteBalance; // per-lens neutral triple; green is 1
  uniform mat3  uCamToSrgb;

  int cfaColorAt(ivec2 p) {
    ivec2 m = ivec2(mod(vec2(p), 2.0));
    int idx = m.y * 2 + m.x;
    if (idx == 0) return uCfaPattern.x;
    if (idx == 1) return uCfaPattern.y;
    if (idx == 2) return uCfaPattern.z;
    return uCfaPattern.w;
  }

  float fetchRaw(ivec2 p) {
    ivec2 c = clamp(p, ivec2(0), uLensSize - ivec2(1));
    return float(texelFetch(uLens, c, 0).r);
  }

  float linearizeRaw(float v) {
    return clamp((v - uBlackLevel) / (uWhiteLevel - uBlackLevel), 0.0, 1.0);
  }

  vec3 srgbEncode(vec3 c) {
    vec3 lo = c * 12.92;
    vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
    return mix(hi, lo, step(c, vec3(0.0031308)));
  }

  vec3 demosaicAt(ivec2 p) {
    int c = cfaColorAt(p);
    float here = fetchRaw(p);
    float rRaw, gRaw, bRaw;
    if (c == 1) {
      gRaw = here;
      int leftColor = cfaColorAt(p + ivec2(-1, 0));
      float horiz = (fetchRaw(p + ivec2(-1, 0)) + fetchRaw(p + ivec2(1, 0))) * 0.5;
      float vert  = (fetchRaw(p + ivec2(0, -1)) + fetchRaw(p + ivec2(0, 1))) * 0.5;
      if (leftColor == 0) { rRaw = horiz; bRaw = vert; } else { bRaw = horiz; rRaw = vert; }
    } else {
      float diag = (fetchRaw(p + ivec2(-1, -1)) + fetchRaw(p + ivec2(1, -1)) +
                    fetchRaw(p + ivec2(-1, 1))  + fetchRaw(p + ivec2(1, 1))) * 0.25;
      float orth = (fetchRaw(p + ivec2(-1, 0)) + fetchRaw(p + ivec2(1, 0)) +
                    fetchRaw(p + ivec2(0, -1)) + fetchRaw(p + ivec2(0, 1))) * 0.25;
      gRaw = orth;
      if (c == 0) { rRaw = here; bRaw = diag; } else { bRaw = here; rRaw = diag; }
    }
    vec3 lin = vec3(linearizeRaw(rRaw), linearizeRaw(gRaw), linearizeRaw(bRaw));
    // Clamp *before* the colour matrix, not just after: a channel that hit
    // the sensor's white level is genuinely unknown past 1.0, and the white
    // balance gain (up to ~2x on this camera's blue channel) pushes clipped
    // highlights well past that. Feeding an ungrounded value that far out of
    // range into a 3x3 whose rows aren't all positive (this one has large
    // negative cross terms) doesn't recover detail -- it manufactures a
    // colour that was never in the scene. Measured directly against a blown
    // sky in these files: leaving the overshoot in produced a false magenta
    // patch (high R and B, near-zero G) exactly where the sky clipped;
    // clamping here first renders it a plausible white/pale blue instead.
    lin = clamp(lin / uWhiteBalance, 0.0, 1.0);
    vec3 srgbLinear = clamp(uCamToSrgb * lin, 0.0, 1.0);
    return srgbEncode(srgbLinear);
  }

  // Raw planes are uploaded to the GPU exactly as they sit in the DNG file
  // (row 0 = the top of the image, matching CFAPattern's own row order --
  // see GL.uploadBayer), unlike the JPEG path's textures, which are decoded
  // with imageOrientation:'flipY' so that texture v=0 already lands at the
  // bottom (matching gl_FragCoord.y, which increases upward). Rather than
  // flip the raw buffer itself on the CPU -- which would also require
  // swapping the two rows of uCfaPattern to keep the colour phase correct,
  // an easy way to get that subtly backwards -- flip only the vertical
  // pixel-coordinate lookup here, leaving both the buffer and uCfaPattern
  // exactly as the file provides them.
  vec3 sampleRawLensAt(float u, float theta, float cropFrac, float roll) {
    float a = theta + roll;
    vec2 off = vec2(cos(a), sin(a)) * (u * cropFrac * 0.5);
    vec2 uv = vec2(0.5) + off;
    int px = int(floor(uv.x * float(uLensSize.x)));
    int py = int(floor((1.0 - uv.y) * float(uLensSize.y)));
    return demosaicAt(ivec2(px, py));
  }`;

  const COMPOSITE_FS = `#version 300 es
  precision highp float;
  uniform sampler2D uLens;      // one square lens frame, S x S
  uniform vec2  uCellOrigin;    // viewport origin in absolute framebuffer pixels
  uniform vec2  uCellSize;      // viewport size in pixels
  uniform float uCircleRadius;  // output circle radius in pixels
  uniform float uCropFrac;      // crop radius as a fraction of the image circle
  uniform float uRoll;          // radians
  uniform sampler2D uProfile;   // per-azimuth rim profile from the Task 7 passes
  uniform float uBins;
  uniform float uFalloffStart, uFalloffSoftness;
  uniform float uEdgeIntensity, uRingWidth, uDispersion;
  uniform float uHazeWidth, uHazeStrength;
  uniform float uTerminatorDesaturate, uTerminatorCoolShift;
  uniform vec3  uTone;          // exposureEv, contrast, saturation
  out vec4 fragColor;
  ` + SAMPLE_LENS_GLSL + `

  const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
  const vec3 COOL = vec3(0.82, 0.92, 1.12);   // cast the last of the image picks up

  // Mirrors edge.js applyTone exactly, including its pass-through guard, so
  // uTone = vec3(0.0) is bit-identical to tone being absent.
  vec3 applyTone(vec3 rgb, vec3 tone) {
    if (tone.x == 0.0 && tone.y == 0.0 && tone.z == 0.0) return rgb;
    float gain = pow(2.0, tone.x);
    float k = 1.0 + tone.y;
    vec3 toned = (rgb * gain - vec3(0.5)) * k + vec3(0.5);
    float luma = dot(toned, LUMA);
    float s = 1.0 + tone.z;
    return luma + (toned - luma) * s;
  }

  float terminator(float u) {
    if (u <= uFalloffStart) return 1.0;
    if (u >= 1.0) return 0.0;
    float t = (u - uFalloffStart) / (1.0 - uFalloffStart);
    float eased = t * t * (3.0 - 2.0 * t);
    return pow(1.0 - eased, uFalloffSoftness);
  }

  float rimBell(float u, float peak, float width) {
    // Mirrors edge.js rimBell's zero-width guard: width <= 0 degenerates to
    // an impulse at the peak instead of a 0/0 NaN.
    if (width <= 0.0) return u == peak ? 1.0 : 0.0;
    float t = (u - peak) / width;
    return exp(-t * t);
  }

  void main() {
    // gl_FragCoord.xy is in absolute framebuffer pixels, not relative to the
    // current viewport -- when the composition draws several circles into
    // their own sub-viewports (Task 6), the cell's origin must be
    // subtracted first to recover the cell-local, center-relative position.
    vec2 p = gl_FragCoord.xy - uCellOrigin - uCellSize * 0.5;
    float r = length(p);
    float u = r / uCircleRadius;
    float theta = atan(p.y, p.x);

    // --- image, with the terminator running it out at the lens edge ---
    vec3 img = vec3(0.0);
    if (u < 1.0) {
      img = sampleLensAt(uLens, u, theta, uCropFrac, uRoll);
      img = applyTone(img, uTone);
      float term = terminator(u);
      float fade = 1.0 - term;
      img = mix(img, vec3(dot(img, LUMA)), fade * uTerminatorDesaturate);
      img = mix(img, img * COOL, fade * uTerminatorCoolShift);
      img *= term;
    }

    // --- rim glow, derived from the image next to it ---
    float bin = mod(theta / 6.283185307179586, 1.0) * uBins;
    vec4 prof = texture(uProfile, vec2((floor(bin) + 0.5) / uBins, 0.5));
    float intensity = prof.r * uEdgeIntensity;
    vec3 tint = prof.gba;
    float tmax = max(max(tint.r, tint.g), tint.b);
    tint = tmax > 0.0 ? tint / tmax : vec3(1.0);

    vec3 glow = vec3(
      rimBell(u, 1.0 - uDispersion, uRingWidth),
      rimBell(u, 1.0,               uRingWidth),
      rimBell(u, 1.0 + uDispersion, uRingWidth)
    ) * intensity * tint;

    float haze = rimBell(u, 1.0, uHazeWidth) * intensity * uHazeStrength;

    fragColor = vec4(img + glow + vec3(haze) * tint, 1.0);
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
  ` + SAMPLE_LENS_GLSL + `

  void main() {
    float bin = floor(gl_FragCoord.x);
    float theta = ((bin + 0.5) / uBins) * 6.283185307179586;
    float acc = 0.0;
    vec3 col = vec3(0.0);
    for (int j = 0; j < 64; j++) {
      if (j >= uRadialSamples) break;
      float u = uUMin + (uUMax - uUMin) * ((float(j) + 0.5) / float(uRadialSamples));
      vec3 c = sampleLensAt(uLens, u, theta, uCropFrac, uRoll);
      acc += pow(max(0.0, dot(c, LUMA) - uKnee), uExponent);
      col += c;
    }
    float n = float(uRadialSamples);
    fragColor = vec4(acc / n, col / n);
  }`;

  // uMaxRadiusBins mirrors Edge.MAX_BLUR_RADIUS_BINS (gl.js sets it from
  // that exact constant) and bounds the loop below. Without a shared
  // ceiling the GLSL loop's extent and the JS reference's kernel radius
  // (edge.js blurProfileAngular) can silently diverge for a wide enough
  // uSpreadBins -- see task-7 review Finding 1. The loop itself is
  // dynamically bounded (GLSL ES 3.00 allows non-constant loop bounds),
  // so there is exactly one place -- Edge.MAX_BLUR_RADIUS_BINS -- where
  // this number is written.
  const PROFILE_BLUR_FS = `#version 300 es
  precision highp float;
  uniform sampler2D uProfile;
  uniform float uBins;
  uniform float uSpreadBins;
  uniform float uMaxRadiusBins;
  out vec4 fragColor;

  void main() {
    if (uSpreadBins <= 0.0) {
      fragColor = texelFetch(uProfile, ivec2(int(gl_FragCoord.x), 0), 0);
      return;
    }
    int maxRadius = int(uMaxRadiusBins);
    int radius = int(ceil(uSpreadBins * 3.0));
    if (radius > maxRadius) radius = maxRadius;
    float bin = floor(gl_FragCoord.x);
    vec4 acc = vec4(0.0);
    float wsum = 0.0;
    for (int k = -radius; k <= radius; k++) {
      float w = exp(-float(k * k) / (2.0 * uSpreadBins * uSpreadBins));
      int j = int(mod(bin + float(k) + uBins, uBins));
      acc += texelFetch(uProfile, ivec2(j, 0), 0) * w;
      wsum += w;
    }
    fragColor = acc / wsum;
  }`;

  // Replaces `pattern` in `source` and throws if it was not found, rather
  // than silently returning `source` unchanged -- a bare String.replace()
  // would no-op if PROFILE_BUILD_FS's source ever changed, leaving the
  // real texture(uLens, ...) lookup in the "parity" shader and turning a
  // maintenance mistake into a confusing failure instead of a clean one.
  function replaceOrThrow(source, pattern, replacement) {
    const result = source.replace(pattern, replacement);
    if (result === source) {
      throw new Error('shaders.js: substitution pattern not found -- PROFILE_BUILD_FS source changed?');
    }
    return result;
  }

  // Used only by the browser-side parity check (app.js `checkParity`): a
  // copy of PROFILE_BUILD_FS with the lens texture lookup replaced by the
  // same analytic sampler baked into test/fixtures/parity-input*.json, so
  // the shader can be exercised against the JS reference without a real
  // photo.
  const PROFILE_BUILD_PARITY_FS = replaceOrThrow(
    PROFILE_BUILD_FS,
    'vec3 c = sampleLensAt(uLens, u, theta, uCropFrac, uRoll);',
    'float sv = 0.5 + 0.5 * sin(theta * 3.0); vec3 c = vec3(sv * u, sv * 0.5, 1.0 - sv);'
  );

  // Builds the raw-source variant of a COMPOSITE_FS/PROFILE_BUILD_FS-shaped
  // shader: swap the shared RGBA sampling snippet for RAW_SAMPLE_GLSL (see
  // its own comment above for why this keeps the rim profile measuring the
  // rendered image), drop the plain `sampler2D uLens` declaration those
  // shaders open with (RAW_SAMPLE_GLSL declares its own `usampler2D`
  // instead), and repoint the one `sampleLensAt(uLens, ...)` call each
  // shader makes at `sampleRawLensAt(...)`, which needs no texture argument
  // of its own -- it reads uLens itself, declared alongside it.
  function toRawVariant(source) {
    let s = replaceOrThrow(source, SAMPLE_LENS_GLSL, RAW_SAMPLE_GLSL);
    s = replaceOrThrow(s, 'uniform sampler2D uLens;',
      '// uLens (usampler2D) is declared by RAW_SAMPLE_GLSL above');
    s = replaceOrThrow(s, 'sampleLensAt(uLens, u, theta, uCropFrac, uRoll)',
      'sampleRawLensAt(u, theta, uCropFrac, uRoll)');
    return s;
  }

  const COMPOSITE_RAW_FS = toRawVariant(COMPOSITE_FS);
  const PROFILE_BUILD_RAW_FS = toRawVariant(PROFILE_BUILD_FS);

  return {
    FULLSCREEN_VS, COMPOSITE_FS, PROFILE_BUILD_FS, PROFILE_BLUR_FS, PROFILE_BUILD_PARITY_FS,
    COMPOSITE_RAW_FS, PROFILE_BUILD_RAW_FS,
  };
});
