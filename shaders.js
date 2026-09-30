(function (root, factory) {
  'use strict';
  // The develop and tone-base shaders bake in detail.js's and
  // tonebase.js's constants, so those load first (index.html orders the
  // script tags accordingly).
  const node = typeof module !== 'undefined' && module.exports;
  const api = node
    ? factory(require('./detail.js'), require('./tonebase.js'))
    : factory(root.Detail, root.ToneBase);
  if (node) module.exports = api;
  else root.Shaders = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Detail, ToneBase) {
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
  uniform float uRawMax;   // brightest value in units of white (1 but for a merged HDR photo)
  vec3 sampleLensAt(sampler2D lens, float u, float theta, float cropFrac, float roll) {
    float a = theta + roll;
    vec2 off = vec2(cos(a), sin(a)) * (u * cropFrac * 0.5);
    return texture(lens, vec2(0.5) + off).rgb;
  }

  // The lens texture position for (u, theta), and the pixel there -- what
  // COMPOSITE_FS reads. RAW_SAMPLE_GLSL defines the same functions over the
  // raw plane.
  vec2 lensUv(float u, float theta, float cropFrac, float roll) {
    float a = theta + roll;
    return vec2(0.5) + vec2(cos(a), sin(a)) * (u * cropFrac * 0.5);
  }
  vec2 lensTexelSize() { return 1.0 / vec2(textureSize(uLens, 0)); }
  vec3 lensTexel(vec2 uv) { return texture(uLens, uv).rgb; }
  // The same position in texels (the tone base is laid out in them).
  vec2 lensTexelPos(vec2 uv) { return uv * vec2(textureSize(uLens, 0)); }`;

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
  uniform float uRawMax;       // brightest value in units of white: hdrMax of a merged HDR photo, else 1
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
    return (v - uBlackLevel) / (uWhiteLevel - uBlackLevel);
  }

  vec3 srgbEncode(vec3 c) {
    vec3 lo = c * 12.92;
    vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
    return mix(hi, lo, step(c, vec3(0.0031308)));
  }

  // Linearised camera RGB at p (0 = black, 1 = the sensor's white level),
  // before white balance or the colour matrix, not clamped -- noise takes
  // it a little below 0. The develop input pass reads this.
  vec3 rawCameraLinearAt(ivec2 p) {
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
    return vec3(linearizeRaw(rRaw), linearizeRaw(gRaw), linearizeRaw(bRaw));
  }

  // The same, clamped to [0, 1]: what the image is made from and the DNG
  // export writes. With DEVELOPED defined (COMPOSITE_RAW_DEV_FS) it comes
  // from the lens's developed frame (noise reduced and sharpened, same
  // pixel grid) instead of the raw plane.
#ifdef DEVELOPED
  uniform sampler2D uDeveloped;
  vec3 rawCameraAt(ivec2 p) {
    ivec2 c = clamp(p, ivec2(0), uLensSize - ivec2(1));
    return clamp(texelFetch(uDeveloped, c, 0).rgb, 0.0, uRawMax);
  }
#else
  vec3 rawCameraAt(ivec2 p) {
    return clamp(rawCameraLinearAt(p), 0.0, uRawMax);
  }
#endif

  vec3 demosaicAt(ivec2 p) {
    vec3 lin = rawCameraAt(p);
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
    // White is uRawMax for a merged HDR photo (1 otherwise).
    lin = clamp(lin / uWhiteBalance, 0.0, uRawMax);
    vec3 srgbLinear = clamp(uCamToSrgb * lin, 0.0, uRawMax);
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
    // Capped at white: the rim glow is measured from display values, and
    // a merged HDR photo's brighter-than-white light must not strengthen
    // it (a no-op for everything else, which never exceeds 1).
    return min(demosaicAt(ivec2(px, py)), vec3(1.0));
  }

  // See SAMPLE_LENS_GLSL's functions of the same names.
  vec2 lensUv(float u, float theta, float cropFrac, float roll) {
    float a = theta + roll;
    return vec2(0.5) + vec2(cos(a), sin(a)) * (u * cropFrac * 0.5);
  }
  vec2 lensTexelSize() { return 1.0 / vec2(uLensSize); }
  ivec2 lensPixel(vec2 uv) {
    return ivec2(int(floor(uv.x * float(uLensSize.x))),
                 int(floor((1.0 - uv.y) * float(uLensSize.y))));
  }
  vec3 lensTexel(vec2 uv) {
    return demosaicAt(lensPixel(uv));
  }
  vec2 lensTexelPos(vec2 uv) { return vec2(uv.x, 1.0 - uv.y) * vec2(uLensSize); }`;

  // Tone, shared by COMPOSITE_FS, the tone-base passes (lightness) and the
  // browser-side TONE_PARITY_FS so the parity check exercises this exact
  // source. Mirrors edge.js applyTone line for line (see there for the
  // method), including the pass-through guard, so uTone = vec3(0.0) and
  // uToneCurve = vec4(0.0) are bit-identical to tone being absent. The
  // strengths (0.10 / 0.25, 0.25 / 0.2 / 0.15 / 0.15) are Edge's
  // TONE_UP/TONE_DOWN/WHITE_IN/WHITE_OUT/BLACK_OUT/BLACK_IN; see edge.js
  // for why they are what they are (monotonicity bounds). `coef` is the
  // local base's (A, B) (tonebase.js), (1, 0) for the global curve.
  const TONE_GLSL = `
  const vec3 TONE_LUMA = vec3(0.2126, 0.7152, 0.0722);

  float srgbDecode1(float v) { return v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4); }
  float srgbEncode1(float x) { return x <= 0.0031308 ? x * 12.92 : 1.055 * pow(x, 1.0 / 2.4) - 0.055; }
  vec3 srgbDecode3(vec3 c) { return vec3(srgbDecode1(c.r), srgbDecode1(c.g), srgbDecode1(c.b)); }
  vec3 srgbEncode3(vec3 c) { return vec3(srgbEncode1(c.r), srgbEncode1(c.g), srgbEncode1(c.b)); }
  float toneLightness(vec3 rgb) { return srgbEncode1(dot(srgbDecode3(rgb), TONE_LUMA)); }
  // Black & white (edge.js mono).
  vec3 toneMono(vec3 rgb) { return vec3(toneLightness(clamp(rgb, 0.0, 1.0))); }

  float toneBump(float y) {
    return (256.0 / 27.0) * y * y * y * (1.0 - y);
  }

  bool toneCurveNonzero(vec4 c) {
    return c.x != 0.0 || c.y != 0.0 || c.z != 0.0 || c.w != 0.0;
  }

  // c = (highlights, shadows, whites, blacks), each -100..100.
  float hsCurve(float y, vec4 c) {
    float h = c.x / 100.0, s = c.y / 100.0;
    float aS = s > 0.0 ? 0.25 * s : 0.10 * s;
    float aH = h > 0.0 ? 0.10 * h : 0.25 * h;
    y = y + aS * toneBump(1.0 - y);
    return y + aH * toneBump(y);
  }

  float toneBumpSlope(float y) {
    return (256.0 / 27.0) * (3.0 * y * y - 4.0 * y * y * y);
  }
  float hsSlope(float y, vec4 c) {
    float h = c.x / 100.0, s = c.y / 100.0;
    float aS = s > 0.0 ? 0.25 * s : 0.10 * s;
    float aH = h > 0.0 ? 0.10 * h : 0.25 * h;
    float y1 = y + aS * toneBump(1.0 - y);
    return (1.0 - aS * toneBumpSlope(1.0 - y)) * (1.0 + aH * toneBumpSlope(y1));
  }

  float toneLevels(float y, vec4 c) {
    float w = c.z / 100.0, b = c.w / 100.0;
    float wIn = 1.0 - 0.25 * max(w, 0.0), wOut = 1.0 + 0.2 * min(w, 0.0);
    float bIn = 0.15 * max(-b, 0.0), bOut = 0.15 * max(b, 0.0);
    float t = clamp((y - bIn) / (wIn - bIn), 0.0, 1.0);
    return bOut + (wOut - bOut) * t;
  }

  float contrastCurve(float x, float contrast) {
    float p = max(0.02, 1.0 + contrast);
    float a = pow(x, p), b = pow(1.0 - x, p);
    return a / (a + b);
  }

  float cbrt1(float x) { return sign(x) * pow(abs(x), 1.0 / 3.0); }
  vec3 toOklab(vec3 c) {
    float l = cbrt1(0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b);
    float m = cbrt1(0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b);
    float s = cbrt1(0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b);
    return vec3(0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
                1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
                0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s);
  }
  vec3 fromOklab(vec3 o) {
    float l = o.x + 0.3963377774 * o.y + 0.2158037573 * o.z;
    float m = o.x - 0.1055613458 * o.y - 0.0638541728 * o.z;
    float s = o.x - 0.0894841775 * o.y - 1.2914855480 * o.z;
    l = l * l * l; m = m * m * m; s = s * s * s;
    return vec3(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
                -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
                -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
  }

  float maxChroma(float L, vec2 h) {
    float lo = 0.0, hi = 0.4;
    for (int i = 0; i < 14; i++) {
      float mid = (lo + hi) / 2.0;
      vec3 c = fromOklab(vec3(L, mid * h));
      bool inside = min(min(c.r, c.g), c.b) >= 0.0 && max(max(c.r, c.g), c.b) <= 1.0;
      if (inside) lo = mid; else hi = mid;
    }
    return lo;
  }

  vec3 saturateOklab(vec3 lin, float s) {
    vec3 o = toOklab(lin);
    float C = length(o.yz);
    if (C < 1e-6) return lin;
    float target = C * s;
    if (s > 1.0) {
      float cmax = maxChroma(o.x, o.yz / C);
      float knee = 0.8 * cmax, room = cmax - knee;
      if (target > knee) {
        target = room > 0.0 ? knee + room * (1.0 - exp(-(target - knee) / room)) : knee;
        target = max(target, C);
      }
    }
    return fromOklab(vec3(o.x, o.yz * (target / C)));
  }

  vec3 gamutMap(vec3 lin) {
    float Y = dot(lin, TONE_LUMA);
    if (Y >= 1.0) return vec3(1.0);
    if (Y <= 0.0) return vec3(0.0);
    float mx = max(max(lin.r, lin.g), lin.b), mn = min(min(lin.r, lin.g), lin.b);
    float t = 1.0;
    if (mx > 1.0) t = min(t, (1.0 - Y) / (mx - Y));
    if (mn < 0.0) t = min(t, Y / (Y - mn));
    return t < 1.0 ? Y + (lin - Y) * t : lin;
  }

  // The highlight shoulder (edge.js shoulder): brighter than white only.
  float toneShoulder(float l, float H) {
    const float K = 0.75;
    if (H <= 1.0 || l <= K) return l;
    float x = (l - K) / (1.0 - K), X = (H - K) / (1.0 - K);
    return K + (1.0 - K) * x * (1.0 + x / (X * X)) / (1.0 + x);
  }

  // tone = (exposureEv, contrast, saturation); curve as hsCurve's c;
  // rawMax as edge.js applyTone's.
  vec3 applyTone(vec3 rgb, vec3 tone, vec4 curve, vec2 coef, float rawMax) {
    bool cv = toneCurveNonzero(curve);
    float g = pow(2.0, tone.x);
    float H = rawMax > 1.0 ? srgbEncode1(rawMax) * g : 1.0;
    if (H <= 1.0 && tone.x == 0.0 && tone.y == 0.0 && tone.z == 0.0 && !cv) return rgb;
    vec3 lin = srgbDecode3(rgb * g);
    float Y = dot(lin, TONE_LUMA);
    float l = srgbEncode1(Y);
    float l2 = toneShoulder(l, H);
    if (cv) {
      float base = clamp(toneShoulder(coef.x * l + g * coef.y, H), 0.0, 1.0);
      float hb = hsCurve(base, curve);
      l2 = hb + (l2 - base) * max(1.0 + 3.0 * abs(hb - base), hsSlope(base, curve));
      float t = clamp(l2, 0.0, 1.0);
      l2 = l2 + (toneLevels(t, curve) - t);
    }
    if (tone.y != 0.0) {
      float t = clamp(l2, 0.0, 1.0);
      l2 = l2 + (contrastCurve(t, tone.y) - t);
    }
    if (l2 != l) {
      float Y2 = srgbDecode1(l2);
      if (Y > 1e-6) lin *= Y2 / Y; else lin += vec3(Y2 - Y);
    }
    if (tone.z != 0.0) lin = saturateOklab(lin, 1.0 + tone.z);
    return srgbEncode3(gamutMap(lin));
  }`;


  // The develop passes (noise reduction and sharpening), mirroring
  // detail.js step for step; see that file for the method and gl.js
  // developLens for the order they run in. Each renders one region of a
  // lens frame (the whole frame, or a tile of it: devplan.js), pixel for
  // pixel, into the bottom-left of an RGBA16F target: `rgb` holds the
  // opponent triple (luma, chroma 1, chroma 2) of detail.js's toOpp. The
  // input passes read the frame at uOrigin + the fragment; the others
  // clamp their taps to the region, (0, 0)..uHi.
  const DEV_OPP_GLSL = `
  vec3 toOpp(vec3 c) { return vec3((c.r + 2.0 * c.g + c.b) / 4.0, (c.r - c.b) / 2.0, (2.0 * c.g - c.r - c.b) / 4.0); }
  vec3 fromOpp(vec3 o) { return vec3(o.x + o.y - o.z, o.x + o.z, o.x - o.y - o.z); }`;

  // Raw input: linear camera RGB (demosaiced, not clamped at black, so the
  // noise around it stays symmetric), variance-stabilised with the lens's
  // measured noise profile uVst = (a, b) (noise.js vst, linear below 0).
  const DEV_INPUT_RAW_FS = `#version 300 es
  precision highp float;
  uniform vec2 uVst;
  uniform ivec2 uOrigin;
  out vec4 fragColor;
  ` + RAW_SAMPLE_GLSL + DEV_OPP_GLSL + `
  void main() {
    vec3 x = rawCameraLinearAt(uOrigin + ivec2(gl_FragCoord.xy));
    float y0 = (2.0 / uVst.x) * sqrt(uVst.y);
    vec3 v = mix((2.0 / uVst.x) * sqrt(max(uVst.x * x + uVst.y, 0.0)),
                 y0 + x / sqrt(uVst.y), lessThan(x, vec3(0.0)));
    fragColor = vec4(toOpp(v), 1.0);
  }`;

  // JPEG input: the display-encoded pixels as they are.
  const DEV_INPUT_RGB_FS = `#version 300 es
  precision highp float;
  uniform sampler2D uSrc;
  uniform ivec2 uOrigin;
  out vec4 fragColor;
  ` + DEV_OPP_GLSL + `
  void main() {
    fragColor = vec4(toOpp(texelFetch(uSrc, uOrigin + ivec2(gl_FragCoord.xy), 0).rgb), 1.0);
  }`;

  // One a-trous step (detail.js blur): B3 spline taps uStep px apart,
  // clamped at the region's edge.
  const DEV_BLUR_FS = `#version 300 es
  precision highp float;
  uniform sampler2D uC;
  uniform int uStep;
  uniform ivec2 uHi;
  out vec4 fragColor;
  const float B3[5] = float[5](${Detail.B3.map((v) => v.toFixed(8)).join(', ')});
  void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec3 acc = vec3(0.0);
    for (int j = -2; j <= 2; j++) {
      for (int i = -2; i <= 2; i++) {
        ivec2 q = clamp(p + ivec2(i, j) * uStep, ivec2(0), uHi);
        acc += B3[i + 2] * B3[j + 2] * texelFetch(uC, q, 0).rgb;
      }
    }
    fragColor = vec4(acc, 1.0);
  }`;

  // One layer's thresholded coefficient (detail.js detailCoef, with the
  // neighbourhood energy of develop), added into the accumulator by
  // blending. uThresh per opponent channel, uBoost the luma sharpening,
  // uSigmaY the layer's luma noise, uStep the layer's tap spacing.
  const DEV_DETAIL_FS = `#version 300 es
  precision highp float;
  uniform sampler2D uC, uNext;
  uniform vec3 uThresh;
  uniform float uBoost, uSigmaY;
  uniform int uStep;
  uniform ivec2 uHi;
  out vec4 fragColor;
  float shrink(float d, float e, float t) {
    if (t <= 0.0) return d;
    float f = e / (e + t * t);
    return d * f * f;
  }
  vec3 coefAt(ivec2 q) {
    return texelFetch(uC, q, 0).rgb - texelFetch(uNext, q, 0).rgb;
  }
  void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec3 e = vec3(0.0);
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec3 n = coefAt(clamp(p + ivec2(i, j) * uStep, ivec2(0), uHi));
        e += n * n;
      }
    }
    e /= 9.0;
    vec3 d = coefAt(p);
    float y = shrink(d.x, e.x, uThresh.x);
    float c1 = shrink(d.y, e.y, uThresh.y);
    float c2 = shrink(d.z, e.z, uThresh.z);
    if (uBoost > 0.0) {
      float y2 = y * y;
      float sy = ${Detail.SHARPEN_FLOOR.toFixed(6)} * uSigmaY;
      y *= 1.0 + uBoost * (y2 / (y2 + sy * sy + 1e-12));
    }
    fragColor = vec4(y, c1, c2, 0.0);
  }`;

  // Coarse residual + the thresholded layers, back to working RGB. uMode 0:
  // display-encoded (JPEG), clamped to [0, 1]. uMode 1: raw, inverse
  // variance-stabilising transform back to linear camera RGB.
  const DEV_FINAL_FS = `#version 300 es
  precision highp float;
  uniform sampler2D uAcc, uCoarse;
  uniform int uMode;
  uniform vec2 uVst;
  out vec4 fragColor;
  ` + DEV_OPP_GLSL + `
  void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec3 rgb = fromOpp(texelFetch(uCoarse, p, 0).rgb + texelFetch(uAcc, p, 0).rgb);
    if (uMode == 1) {
      float y0 = (2.0 / uVst.x) * sqrt(uVst.y);
      vec3 s = uVst.x * rgb / 2.0;
      rgb = mix((s * s - uVst.y) / uVst.x, (rgb - y0) * sqrt(uVst.y), lessThan(rgb, vec3(y0)));
    } else {
      rgb = clamp(rgb, 0.0, 1.0);
    }
    fragColor = vec4(rgb, 1.0);
  }`;

  // The lens edge: the terminator that runs the image out at the rim, and
  // the rim light (glow + haze, display units) derived from the per-azimuth
  // profile. Shared by COMPOSITE_FS and COMPOSITE_DNG_FS; expects their
  // uProfile/uBins/edge uniforms.
  const EDGE_GLSL = `
  const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
  const vec3 COOL = vec3(0.82, 0.92, 1.12);   // cast the last of the image picks up

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

  // Rim glow and haze at (u, theta), derived from the image next to it.
  vec3 rimLight(float u, float theta) {
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
    return glow + vec3(haze) * tint;
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
  uniform vec4  uToneCurve;     // highlights, shadows, whites, blacks (-100..100)
  // The local tone base (tonebase.js, gl.js buildToneBase): (A, B) per
  // block of lens texels; uToneBaseScale maps a texel position to its uv.
  // uToneLocal 0: the global curve.
  uniform sampler2D uToneBase;
  uniform vec2  uToneBaseScale;
  uniform float uToneLocal;
  uniform float uMono;          // 1: black & white, photo and rim alike
  // JPEG / .insp white balance (jpegwb.js matrix), linear sRGB; off for raw.
  uniform mat3  uJpegWb;
  uniform float uJpegWbOn;
  out vec4 fragColor;
  ` + SAMPLE_LENS_GLSL + TONE_GLSL + EDGE_GLSL + `

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
      vec2 uv = lensUv(u, theta, uCropFrac, uRoll);
      img = lensTexel(uv);
      if (uJpegWbOn > 0.5) img = srgbEncode3(gamutMap(uJpegWb * srgbDecode3(img)));
      vec2 toneCoef = uToneLocal > 0.5
        ? texture(uToneBase, lensTexelPos(uv) * uToneBaseScale).rg : vec2(1.0, 0.0);
      img = applyTone(img, uTone, uToneCurve, toneCoef, uRawMax);
      float term = terminator(u);
      float fade = 1.0 - term;
      img = mix(img, vec3(dot(img, LUMA)), fade * uTerminatorDesaturate);
      img = mix(img, img * COOL, fade * uTerminatorCoolShift);
      img *= term;
    }

    vec3 outColor = img + rimLight(u, theta);
    if (uMono > 0.5) outColor = toneMono(outColor);
    fragColor = vec4(outColor, 1.0);
  }`;

  // DNG export (raw sources): the same geometry and lens edge as
  // COMPOSITE_FS, but written as linear *camera* RGB for a linear-raw DNG.
  // Tone and detail are not applied -- the raw converter does that. The
  // edge is applied in linear sRGB (camera -> sRGB with this lens's white
  // balance, edge, then exactly back), so away from the edge the output is
  // the demosaiced camera data itself, unclamped by white balance or gamut.
  // The preview applies the edge to display-encoded values; the linear
  // equivalents here are pow(term, 2.2) for the fade, COOL^2.2 for the cast,
  // and the display-space rim light decoded before it is added.
  const COMPOSITE_DNG_FS = `#version 300 es
  precision highp float;
  uniform vec2  uCellOrigin;
  uniform vec2  uCellSize;
  uniform float uCircleRadius;
  uniform float uCropFrac;
  uniform float uRoll;
  uniform sampler2D uProfile;
  uniform float uBins;
  uniform float uFalloffStart, uFalloffSoftness;
  uniform float uEdgeIntensity, uRingWidth, uDispersion;
  uniform float uHazeWidth, uHazeStrength;
  uniform float uTerminatorDesaturate, uTerminatorCoolShift;
  uniform mat3  uSrgbToCam;     // linear sRGB -> camera for uNeutralOut
  uniform vec3  uNeutralOut;    // the DNG's AsShotNeutral
  out vec4 fragColor;
  ` + RAW_SAMPLE_GLSL + EDGE_GLSL + `

  vec3 srgbDecode(vec3 c) {
    c = max(c, vec3(0.0));
    vec3 lo = c / 12.92;
    vec3 hi = pow((c + 0.055) / 1.055, vec3(2.4));
    return mix(hi, lo, step(c, vec3(0.04045)));
  }

  void main() {
    vec2 p = gl_FragCoord.xy - uCellOrigin - uCellSize * 0.5;
    float r = length(p);
    float u = r / uCircleRadius;
    float theta = atan(p.y, p.x);

    vec3 lin = vec3(0.0);   // linear sRGB, unclamped
    if (u < 1.0) {
      vec3 cam = rawCameraAt(lensPixel(lensUv(u, theta, uCropFrac, uRoll)));
      // Where the sensor clipped, the pixel's colour is unknown and raw
      // converters render it magenta after white balance (blown sky goes
      // pink). Near saturation, blend to what the preview shows there --
      // each channel clipped at white after white balance -- and leave
      // everything below it untouched, so bright unclipped colours keep
      // their latitude.
      float sat = max(max(cam.r, cam.g), cam.b);
      vec3 clipped = uWhiteBalance * clamp(cam / uWhiteBalance, 0.0, 1.0);
      cam = mix(cam, clipped, smoothstep(0.9, 0.99, sat));
      lin = uCamToSrgb * (cam / uWhiteBalance);
      float term = terminator(u);
      float fade = 1.0 - term;
      lin = mix(lin, vec3(dot(lin, LUMA)), fade * uTerminatorDesaturate);
      lin = mix(lin, lin * pow(COOL, vec3(2.2)), fade * uTerminatorCoolShift);
      lin *= pow(term, 2.2);
    }
    lin += srgbDecode(rimLight(u, theta));
    // Back to camera RGB for the file's single AsShotNeutral. For the lens
    // whose white balance that is, this undoes the forward step exactly;
    // the other lens (unlinked, different balance) is re-expressed so the
    // raw converter renders it with its own balance, as the preview does.
    vec3 camOut = uNeutralOut * (uSrgbToCam * lin);
    fragColor = vec4(clamp(camOut, 0.0, 1.0), 1.0);
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
  // COMPOSITE_FS no longer calls sampleLensAt directly (it samples through
  // lensTexel, which RAW_SAMPLE_GLSL also defines), so only the profile
  // shader needs that call repointed.
  function toRawVariant(source, repointSample) {
    let s = replaceOrThrow(source, SAMPLE_LENS_GLSL, RAW_SAMPLE_GLSL);
    s = replaceOrThrow(s, 'uniform sampler2D uLens;',
      '// uLens (usampler2D) is declared by RAW_SAMPLE_GLSL above');
    if (repointSample) {
      s = replaceOrThrow(s, 'sampleLensAt(uLens, u, theta, uCropFrac, uRoll)',
        'sampleRawLensAt(u, theta, uCropFrac, uRoll)');
    }
    return s;
  }

  const COMPOSITE_RAW_FS = toRawVariant(COMPOSITE_FS, false);
  // Reads the developed frame (see RAW_SAMPLE_GLSL's rawCameraAt).
  const COMPOSITE_RAW_DEV_FS = replaceOrThrow(COMPOSITE_RAW_FS, '#version 300 es',
    '#version 300 es\n  #define DEVELOPED 1');


  // The local tone base (tonebase.js, which these mirror; gl.js
  // buildToneBase runs them): block means of lightness and its square,
  // two box passes, the guided filter's coefficients, two more box
  // passes. Low-res RGBA16F targets, one texel per BLOCK x BLOCK block
  // of lens texels.
  const TB_DOWN_BODY = `
  uniform int uBlock;
  out vec4 fragColor;
  void main() {
    ivec2 lo = ivec2(gl_FragCoord.xy) * uBlock;
    ivec2 size = tbSize();
    float a = 0.0, b = 0.0, n = 0.0;
    for (int j = 0; j < 8; j++) {
      for (int i = 0; i < 8; i++) {
        ivec2 q = lo + ivec2(i, j);
        if (i >= uBlock || j >= uBlock || q.x >= size.x || q.y >= size.y) continue;
        float l = toneLightness(tbPixel(q));
        a += l; b += l * l; n += 1.0;
      }
    }
    fragColor = vec4(a / n, b / n, 0.0, 1.0);
  }`;
  const TB_DOWN_FS = `#version 300 es
  precision highp float;
  uniform sampler2D uLens;
  ` + TONE_GLSL + `
  ivec2 tbSize() { return textureSize(uLens, 0); }
  vec3 tbPixel(ivec2 q) { return texelFetch(uLens, q, 0).rgb; }
  ` + TB_DOWN_BODY;
  const TB_DOWN_RAW_FS = `#version 300 es
  precision highp float;
  ` + RAW_SAMPLE_GLSL + TONE_GLSL + `
  ivec2 tbSize() { return uLensSize; }
  vec3 tbPixel(ivec2 q) { return demosaicAt(q); }
  ` + TB_DOWN_BODY;

  // Mean over (2 uR + 1) taps along uDir, clamped at the edges.
  const TB_BOX_FS = `#version 300 es
  precision highp float;
  uniform sampler2D uSrc;
  uniform ivec2 uDir;
  uniform int uR;
  out vec4 fragColor;
  void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    ivec2 hi = textureSize(uSrc, 0) - ivec2(1);
    vec2 acc = vec2(0.0);
    for (int k = -${ToneBase.MAX_RADIUS}; k <= ${ToneBase.MAX_RADIUS}; k++) {
      if (k < -uR || k > uR) continue;
      acc += texelFetch(uSrc, clamp(p + uDir * k, ivec2(0), hi), 0).rg;
    }
    fragColor = vec4(acc / float(2 * uR + 1), 0.0, 1.0);
  }`;

  const TB_COEF_FS = `#version 300 es
  precision highp float;
  uniform sampler2D uSrc;
  out vec4 fragColor;
  void main() {
    vec2 m = texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0).rg;
    float v = max(0.0, m.y - m.x * m.x);
    float a = v / (v + ${ToneBase.EPS.toFixed(6)});
    fragColor = vec4(a, m.x * (1.0 - a), 0.0, 1.0);
  }`;

  // Browser-side tone parity (app.js checkToneParity): TONE_GLSL's
  // applyTone over 256 synthetic inputs, one per fragment along x, written
  // to a float target so it can be compared with Edge.applyTone on the
  // same inputs (TONE_PARITY_INPUT in app.js computes them identically;
  // every value is exact in float32).
  const TONE_PARITY_FS = `#version 300 es
  precision highp float;
  uniform vec3 uTone;
  uniform vec4 uToneCurve;
  uniform float uLocal;
  uniform float uRawMax;
  uniform float uInputScale;   // srgbEncode(uRawMax): inputs brighter than white
  out vec4 fragColor;
  ` + TONE_GLSL + `
  void main() {
    float x = floor(gl_FragCoord.x);
    vec3 rgb = vec3(x / 255.0, (255.0 - x) / 255.0 * 0.8 + 0.1, mod(x * 37.0, 256.0) / 255.0) * uInputScale;
    // A local base's (A, B), varied along x (App's toneParityCoef).
    vec2 coef = uLocal > 0.5 ? vec2(mod(x * 29.0, 64.0) / 64.0, mod(x * 13.0, 32.0) / 64.0) : vec2(1.0, 0.0);
    fragColor = vec4(applyTone(rgb, uTone, uToneCurve, coef, uRawMax), 1.0);
  }`;
  const PROFILE_BUILD_RAW_FS = toRawVariant(PROFILE_BUILD_FS, true);

  // Float raw planes (a merged HDR photo, hdrmerge.js: black 0, white 1,
  // values up to hdrMax) are R32F textures, read through these: the same
  // shaders with a float sampler.
  const toFloatRaw = (s) => replaceOrThrow(s, 'uniform highp usampler2D uLens;', 'uniform highp sampler2D uLens;');
  const COMPOSITE_RAW_F_FS = toFloatRaw(COMPOSITE_RAW_FS);
  const COMPOSITE_RAW_DEV_F_FS = toFloatRaw(COMPOSITE_RAW_DEV_FS);
  const DEV_INPUT_RAW_F_FS = toFloatRaw(DEV_INPUT_RAW_FS);
  const TB_DOWN_RAW_F_FS = toFloatRaw(TB_DOWN_RAW_FS);
  const PROFILE_BUILD_RAW_F_FS = toFloatRaw(PROFILE_BUILD_RAW_FS);

  // Browser-side detail parity (app.js checkDetailParity): writes a 64 x 64
  // synthetic opponent image (App's detailParityInput computes the same
  // values, exact in float16) for the develop passes to run over.
  const DEV_PARITY_INPUT_FS = `#version 300 es
  precision highp float;
  out vec4 fragColor;
  void main() {
    vec2 p = floor(gl_FragCoord.xy);
    float edge = p.x + p.y < 64.0 ? 0.25 : 0.625;
    fragColor = vec4(
      edge + mod(p.x * 37.0 + p.y * 91.0, 17.0) / 256.0,
      (mod(p.x * 53.0 + p.y * 29.0, 13.0) - 6.0) / 256.0,
      (mod(p.x * 71.0 + p.y * 43.0, 19.0) - 9.0) / 256.0, 1.0);
  }`;

  return {
    FULLSCREEN_VS, COMPOSITE_FS, PROFILE_BUILD_FS, PROFILE_BLUR_FS, PROFILE_BUILD_PARITY_FS,
    COMPOSITE_RAW_FS, COMPOSITE_RAW_DEV_FS, COMPOSITE_DNG_FS, PROFILE_BUILD_RAW_FS, TONE_GLSL, TONE_PARITY_FS,
    DEV_INPUT_RAW_FS, DEV_INPUT_RGB_FS, DEV_BLUR_FS, DEV_DETAIL_FS, DEV_FINAL_FS, DEV_PARITY_INPUT_FS,
    TB_DOWN_FS, TB_DOWN_RAW_FS, TB_BOX_FS, TB_COEF_FS,
    COMPOSITE_RAW_F_FS, COMPOSITE_RAW_DEV_F_FS, DEV_INPUT_RAW_F_FS, TB_DOWN_RAW_F_FS, PROFILE_BUILD_RAW_F_FS,
  };
});
