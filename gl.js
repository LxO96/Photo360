(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GL = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src.trim());
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error('shader: ' + gl.getShaderInfoLog(s));
    }
    return s;
  }

  function program(gl, vsSrc, fsSrc) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error('link: ' + gl.getProgramInfoLog(p));
    }
    return p;
  }

  function create(canvas) {
    // preserveDrawingBuffer is deliberately omitted: export renders to an
    // offscreen FBO (makeExportTarget/readCompositionStrips), never reads
    // back from the visible canvas, so there is nothing left that needs the
    // drawing buffer preserved between frames -- letting the browser clear
    // it after presentation is the default and typically cheaper path.
    const gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false,
      premultipliedAlpha: false,
    });
    if (!gl) throw new Error('WEBGL2_UNAVAILABLE');
    // An RGBA16F render target (the profile passes' output) needs this --
    // without it, framebuffers with a float colour attachment are
    // incomplete and rendering to them silently fails.
    if (!gl.getExtension('EXT_color_buffer_float')) {
      throw new Error('FLOAT_FBO_UNAVAILABLE');
    }
    const ctx = {
      gl,
      canvas,
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      maxRenderbufferSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
      // Blending into an RGBA32F target (the DNG export) needs this; without
      // it the export falls back to RGBA16F (11-bit mantissa).
      floatBlend: !!gl.getExtension('EXT_float_blend'),
      textures: [null, null],
      // Per-texture size, populated by uploadBayer (uploadLens doesn't need
      // it -- the JPEG path samples with normalized UVs via `texture()`,
      // not `texelFetch`, so it never needs to know pixel dimensions).
      textureSize: [null, null],
      // Per lens slot: { id, noise: {a, b} (raw) | null, sigmas } -- what
      // the develop passes need to know about the frame (see developLens).
      lensInfo: [null, null],
      dev: { scratch: [], out: [null, null], key: [null, null] },
      composite: program(gl, Shaders.FULLSCREEN_VS, Shaders.COMPOSITE_FS),
      compositeRaw: program(gl, Shaders.FULLSCREEN_VS, Shaders.COMPOSITE_RAW_FS),
      compositeDng: program(gl, Shaders.FULLSCREEN_VS, Shaders.COMPOSITE_DNG_FS),
      compositeRawDev: program(gl, Shaders.FULLSCREEN_VS, Shaders.COMPOSITE_RAW_DEV_FS),
      devInputRaw: program(gl, Shaders.FULLSCREEN_VS, Shaders.DEV_INPUT_RAW_FS),
      devInputRgb: program(gl, Shaders.FULLSCREEN_VS, Shaders.DEV_INPUT_RGB_FS),
      devBlur: program(gl, Shaders.FULLSCREEN_VS, Shaders.DEV_BLUR_FS),
      devDetail: program(gl, Shaders.FULLSCREEN_VS, Shaders.DEV_DETAIL_FS),
      devFinal: program(gl, Shaders.FULLSCREEN_VS, Shaders.DEV_FINAL_FS),
      profileBuild: program(gl, Shaders.FULLSCREEN_VS, Shaders.PROFILE_BUILD_FS),
      profileBuildRaw: program(gl, Shaders.FULLSCREEN_VS, Shaders.PROFILE_BUILD_RAW_FS),
      profileBlur: program(gl, Shaders.FULLSCREEN_VS, Shaders.PROFILE_BLUR_FS),
      vao: gl.createVertexArray(),
      profileTargets: [null, null],  // lazily allocated ping-pong RGBA16F targets
    };
    return ctx;
  }

  // Allocate one bins x 1 RGBA16F texture + framebuffer pair. NEAREST
  // filtering only: LINEAR on a float texture needs the
  // OES_texture_float_linear extension (not guaranteed), and the consuming
  // shader floors the bin index anyway, so linear filtering buys nothing.
  // The texture is tagged with its own bin count (`tex.bins`) so
  // `readProfile` can size its readback without a separate bins argument --
  // useful since the parity check (app.js) renders profiles at a different
  // bin count than the running app's `Edge.PROFILE_BINS`.
  function makeProfileTarget(gl, bins) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, bins, 1, 0, gl.RGBA, gl.FLOAT, null);
    tex.bins = bins;
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fbo, bins };
  }

  function ensureProfileTargets(ctx, bins) {
    if (ctx.profileTargets[0] && ctx.profileTargets[0].bins === bins) return;
    const gl = ctx.gl;
    for (let i = 0; i < 2; i++) {
      if (ctx.profileTargets[i]) {
        gl.deleteTexture(ctx.profileTargets[i].tex);
        gl.deleteFramebuffer(ctx.profileTargets[i].fbo);
      }
      ctx.profileTargets[i] = makeProfileTarget(gl, bins);
    }
  }

  // Radial sampling window for the rim measurement: a thin annulus just
  // inside the crop edge (u=1.0), matched to the values baked into
  // test/fixtures/parity-input.json so the parity check exercises the same
  // sampling density this pass actually uses.
  const RADIAL_SAMPLES = 8;
  const U_MIN = 0.94;
  const U_MAX = 1.0;

  // Sets the raw-path-only uniforms (demosaic/linearise/white-balance/
  // colour-matrix inputs) shared by COMPOSITE_RAW_FS and PROFILE_BUILD_RAW_FS
  // -- one place for both, so they can never disagree about which lens's
  // white balance or which camera's calibration is in effect, the same
  // reasoning as GL.circleDraw for texture/roll. `physicalLens` must be the
  // *physical* lens ('A'/'B'), not the output slot label -- see circleDraw's
  // own comment for why that distinction matters under `swap`.
  function setRawUniforms(gl, program, ctx, texIndex, state, physicalLens) {
    const meta = state.rawMeta;
    const size = ctx.textureSize[texIndex];
    const wb = (state.rawWhiteBalance && state.rawWhiteBalance[physicalLens]) || [1, 1, 1];
    const u = (n) => gl.getUniformLocation(program, n);
    gl.uniform2i(u('uLensSize'), size ? size.width : 1, size ? size.height : 1);
    gl.uniform4i(u('uCfaPattern'), meta.cfaPattern[0], meta.cfaPattern[1], meta.cfaPattern[2], meta.cfaPattern[3]);
    gl.uniform1f(u('uBlackLevel'), meta.blackLevel);
    gl.uniform1f(u('uWhiteLevel'), meta.whiteLevel);
    gl.uniform3f(u('uWhiteBalance'), wb[0], wb[1], wb[2]);
    // uCamToSrgb is row-major (dng.js); WebGL2 allows `transpose: true` on
    // uniformMatrix3fv (unlike WebGL1), so it can be uploaded as-is instead
    // of being transposed into GLSL's column-major convention by hand.
    // The matrix depends on the neutral (Dng.camToSrgbForNeutral), so it is
    // per lens, like the white balance itself.
    const camToSrgb = (state.rawCamToSrgb && state.rawCamToSrgb[physicalLens]) || meta.camToSrgb;
    gl.uniformMatrix3fv(u('uCamToSrgb'), true, camToSrgb);
    // DNG export only (COMPOSITE_DNG_FS): the way back to camera RGB, for
    // the file's one neutral (state.dngNeutral).
    const back = u('uSrgbToCam');
    if (back) {
      const n = state.dngNeutral || wb;
      const m = Dng.camToSrgbForNeutral(meta.colorMatrix1, n);
      gl.uniformMatrix3fv(back, true, Dng.mat3Invert(m) || [1, 0, 0, 0, 1, 0, 0, 0, 1]);
      gl.uniform3f(u('uNeutralOut'), n[0], n[1], n[2]);
    }
  }

  // Renders the two rim-profile passes (build, then angular blur) for one
  // lens circle into a bins x 1 RGBA16F texture and returns it. The
  // returned texture belongs to ctx's ping-pong pair and is reused on the
  // next call -- callers must finish using it (e.g. bind it for the
  // composite draw) before calling buildProfile again. `physicalLens` is
  // only used (and only required) when state.isRaw -- see setRawUniforms.
  function buildProfile(ctx, state, texIndex, rollRad, physicalLens) {
    const gl = ctx.gl;
    const bins = Edge.PROFILE_BINS;
    ensureProfileTargets(ctx, bins);
    const [a, b] = ctx.profileTargets;
    const profileProgram = state.isRaw ? ctx.profileBuildRaw : ctx.profileBuild;

    gl.bindVertexArray(ctx.vao);
    gl.disable(gl.BLEND);
    gl.viewport(0, 0, bins, 1);

    // Pass 1: build the raw per-bin highlight-weighted profile. Samples the
    // lens the same way COMPOSITE_FS does (same uCropFrac, same roll
    // convention) so the glow this drives lines up with the image it came
    // from -- see PROFILE_BUILD_FS / sampleLens in shaders.js.
    gl.bindFramebuffer(gl.FRAMEBUFFER, a.fbo);
    gl.useProgram(profileProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, ctx.textures[texIndex]);
    const ub = (n) => gl.getUniformLocation(profileProgram, n);
    gl.uniform1i(ub('uLens'), 0);
    gl.uniform1f(ub('uBins'), bins);
    gl.uniform1i(ub('uRadialSamples'), RADIAL_SAMPLES);
    gl.uniform1f(ub('uUMin'), U_MIN);
    gl.uniform1f(ub('uUMax'), U_MAX);
    gl.uniform1f(ub('uKnee'), state.edge.highlightKnee);
    gl.uniform1f(ub('uExponent'), state.edge.highlightExponent);
    gl.uniform1f(ub('uCropFrac'), Lens.radiusForFov(state.fovDeg, state.thetaMaxDeg));
    gl.uniform1f(ub('uRoll'), rollRad);
    if (state.isRaw) setRawUniforms(gl, profileProgram, ctx, texIndex, state, physicalLens);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Pass 2: blur the raw profile angularly, wrapping around the circle.
    gl.bindFramebuffer(gl.FRAMEBUFFER, b.fbo);
    gl.useProgram(ctx.profileBlur);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, a.tex);
    const uu = (n) => gl.getUniformLocation(ctx.profileBlur, n);
    gl.uniform1i(uu('uProfile'), 0);
    gl.uniform1f(uu('uBins'), bins);
    const spreadBins = (state.edge.glowSpreadDeg || 0) / 360 * bins;
    gl.uniform1f(uu('uSpreadBins'), spreadBins);
    // The single place this constant is threaded into the shader -- see
    // Edge.MAX_BLUR_RADIUS_BINS for why the GLSL loop bound and the JS
    // kernel-radius clamp must always agree.
    gl.uniform1f(uu('uMaxRadiusBins'), Edge.MAX_BLUR_RADIUS_BINS);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return b.tex;
  }

  // Reads a bins x 1 profile texture back as a Float32Array of bins*4
  // floats (RGBA per bin). `tex.bins` is set by makeProfileTarget; used by
  // the browser-side parity check and by nothing else in the running app.
  function readProfile(ctx, tex) {
    const gl = ctx.gl;
    const bins = tex.bins || Edge.PROFILE_BINS;
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const out = new Float32Array(bins * 4);
    gl.readPixels(0, 0, bins, 1, gl.RGBA, gl.FLOAT, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
    return out;
  }

  // Creates a lens texture from a decoded ImageBitmap *without* touching
  // ctx.textures -- the atomic-load fix (final review round) builds every
  // new lens's texture this way first, and only calls commitLenses (below)
  // once all of them have succeeded, so a throw partway through a multi-lens
  // load can never leave ctx.textures holding a mix of the old and new
  // file's textures.
  function makeLensTexture(gl, bitmap) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // Orientation note: the bitmap handed in here must already be decoded
    // with { imageOrientation: 'flipY' } (see app.js/source.js) so that
    // texture t=0 lands at the bottom of the image, matching GL's
    // convention that gl_FragCoord.y increases upward.
    // gl.pixelStorei(UNPACK_FLIP_Y_WEBGL) was tried first but has no effect
    // on ImageBitmap sources in this engine -- verified empirically with an
    // isolated 2x2-texel texture.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    return { tex: t, size: { width: bitmap.width, height: bitmap.height } };
  }

  // Creates one lens's raw CFA (Bayer) plane texture -- a Uint16Array of
  // width*height sensor readings, one integer per pixel, no colour of its
  // own yet -- as a single-channel 16-bit *integer* texture, without
  // touching ctx.textures (see makeLensTexture's comment).
  // R16UI/RED_INTEGER/UNSIGNED_SHORT is the only combination WebGL2 allows
  // for an integer texture; such textures cannot be linearly filtered by
  // the hardware at all (only NEAREST is legal), which is exactly what the
  // raw shader path wants anyway -- it demosaics with its own explicit
  // neighbour sampling (texelFetch), not GPU bilinear filtering. `plane` is
  // uploaded exactly as given, in the DNG's own row order (row 0 = the top
  // of the image) -- see shaders.js's sampleRawLensAt for why the vertical
  // flip the JPEG path needs is handled in the sampling math instead of
  // here.
  function makeBayerTexture(gl, plane, width, height) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16UI, width, height, 0, gl.RED_INTEGER, gl.UNSIGNED_SHORT, plane);
    return { tex: t, size: { width, height } };
  }

  // Frees the GPU texture at slot `i`, if any, and clears the slot. This is
  // the fix for the Critical finding: nothing used to clear ctx.textures[1]
  // when a newly loaded file had only one lens, so a 1:1 file loaded after a
  // dual one kept rendering the *previous* photograph's lens B, at the
  // previous resolution, into slot B -- silently, with no error, and the
  // export would contain a mix of two different photographs.
  function releaseLens(ctx, i) {
    if (ctx.textures[i]) ctx.gl.deleteTexture(ctx.textures[i]);
    ctx.textures[i] = null;
    ctx.textureSize[i] = null;
    ctx.lensInfo[i] = null;
    if (ctx.dev) {
      freeDevTarget(ctx.gl, ctx.dev.out[i]);
      ctx.dev.out[i] = null;
      ctx.dev.key[i] = null;
    }
  }

  // Atomically replaces every uploaded lens texture. `built` is an array (as
  // returned by makeLensTexture/makeBayerTexture) of length 1 or 2, one
  // entry per lens the newly loaded file actually has. Any slot at or past
  // built.length is released (see releaseLens), so a 1:1 file loaded on top
  // of a 2:1 one never leaves a stale lens-B texture bound. Callers must
  // build every entry of `built` successfully *before* calling this -- see
  // app.js's loadFile/loadDngFile, which build the full set into a local
  // array first, so a throw while decoding/uploading a later lens never
  // reaches here and never touches ctx.textures at all, leaving whatever
  // file was loaded before (if any) fully intact.
  let lensSerial = 0;

  function commitLenses(ctx, built) {
    for (let i = 0; i < 2; i++) {
      if (i < built.length) {
        releaseLens(ctx, i);
        ctx.textures[i] = built[i].tex;
        ctx.textureSize[i] = built[i].size;
        ctx.lensInfo[i] = { id: ++lensSerial, noise: built[i].noise || null, sigmas: null };
      } else {
        releaseLens(ctx, i);
      }
    }
  }

  // Back-compat single-call wrappers, kept for anything (tests, tools) that
  // still wants "decode straight into ctx.textures[index]" in one step; the
  // atomic app.js load path above uses makeLensTexture/makeBayerTexture +
  // commitLenses instead.
  function uploadLens(ctx, index, bitmap) {
    const built = makeLensTexture(ctx.gl, bitmap);
    if (ctx.textures[index]) ctx.gl.deleteTexture(ctx.textures[index]);
    ctx.textures[index] = built.tex;
    ctx.textureSize[index] = built.size;
  }

  function uploadBayer(ctx, index, plane, width, height) {
    const built = makeBayerTexture(ctx.gl, plane, width, height);
    if (ctx.textures[index]) ctx.gl.deleteTexture(ctx.textures[index]);
    ctx.textures[index] = built.tex;
    ctx.textureSize[index] = built.size;
  }

  // -- Develop: noise reduction and sharpening (detail.js) ---------------
  // Each lens's whole source frame is developed once into an RGBA16F
  // texture (ctx.dev.out[i]) that the composite then samples instead of the
  // source: raw -> linear camera RGB, JPEG -> display-encoded RGB. It is
  // redone only when the Detail settings or the file change (ctx.dev.key),
  // so panning, zooming, white balance, tone and exports reuse it. The
  // passes: input (to opponent values; raw is variance-stabilised first),
  // then per wavelet layer a blur and a thresholded-detail pass blended
  // into an accumulator, then the final pass back to RGB. Three scratch
  // targets the size of the frame, kept while Detail is on.
  const DEV_CROP = 256;

  function makeDevTarget(gl, w, h) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // LINEAR for the JPEG composite, which samples with texture() the way
    // it samples the source; the passes themselves use texelFetch.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fbo, w, h, complete };
  }

  function freeDevTarget(gl, t) {
    if (!t) return;
    gl.deleteTexture(t.tex);
    gl.deleteFramebuffer(t.fbo);
  }

  // Frees every develop texture (Detail turned off, or a new file).
  function releaseDeveloped(ctx) {
    const gl = ctx.gl, dev = ctx.dev;
    for (const t of dev.scratch) freeDevTarget(gl, t);
    for (const t of dev.out) freeDevTarget(gl, t);
    dev.scratch = [];
    dev.out = [null, null];
    dev.key = [null, null];
  }

  function devScratch(ctx, w, h) {
    const gl = ctx.gl, dev = ctx.dev;
    if (dev.scratch.length !== 3 || dev.scratch[0].w !== w || dev.scratch[0].h !== h) {
      for (const t of dev.scratch) freeDevTarget(gl, t);
      dev.scratch = [makeDevTarget(gl, w, h), makeDevTarget(gl, w, h), makeDevTarget(gl, w, h)];
    }
    if (!dev.scratch.every((t) => t.complete)) throw new Error('DEVELOP_TARGET_INCOMPLETE');
    return dev.scratch;
  }

  function devPass(ctx, prog, target, setup) {
    const gl = ctx.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, target.w, target.h);
    gl.useProgram(prog);
    setup((n) => gl.getUniformLocation(prog, n));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function bindTex(gl, unit, tex) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  }

  // Five crops inside the image circle, for measuring the noise.
  function devCrops(w, h) {
    const c = Math.min(DEV_CROP, Math.floor(w / 4), Math.floor(h / 4));
    return [[0.5, 0.5], [0.3, 0.5], [0.7, 0.5], [0.5, 0.3], [0.5, 0.7]].map(([fx, fy]) => ({
      x: Math.round(fx * w - c / 2), y: Math.round(fy * h - c / 2), w: c, h: c,
    }));
  }

  function readDevRect(gl, target, r) {
    const out = new Float32Array(r.w * r.h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.readPixels(r.x, r.y, r.w, r.h, gl.RGBA, gl.FLOAT, out);
    return out;
  }

  // The wavelet passes over scratch[0], which holds the input (opponent
  // values). `sigmas` is null to measure each layer's noise on the way
  // (a JPEG: Noise.estimateSigma over devCrops, then capLuma and
  // jpegSigma), else detail.js-shaped. `mode` and
  // `vst` are DEV_FINAL_FS's. Returns { out, sigmas }: `out` is the
  // scratch target holding the result.
  function runDevelop(ctx, scratch, params, sigmas, mode, vst) {
    const gl = ctx.gl;
    const [A, B, acc] = scratch;
    const w = A.w, h = A.h;
    const measured = sigmas ? sigmas.slice() : [];
    gl.bindVertexArray(ctx.vao);
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, acc.fbo);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    let cur = A, next = B;
    for (let k = 0; k < Detail.LEVELS; k++) {
      devPass(ctx, ctx.devBlur, next, (u) => {
        bindTex(gl, 0, cur.tex);
        gl.uniform1i(u('uC'), 0);
        gl.uniform1i(u('uStep'), 1 << k);
      });
      if (!sigmas) {
        const crops = devCrops(w, h).map((r) => {
          const c = readDevRect(gl, cur, r), n = readDevRect(gl, next, r);
          for (let i = 0; i < c.length; i++) c[i] -= n[i];
          return { d: c, w: r.w, h: r.h, stride: 4 };
        });
        measured[k] = Noise.jpegSigma(k, Noise.capLuma(Noise.estimateSigma(crops, 3), measured[k - 1]));
      }
      while (measured.length < Detail.LEVELS) measured.push([0, 0, 0]);
      const lp = Detail.levelParams(params, measured)[k];
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      devPass(ctx, ctx.devDetail, acc, (u) => {
        bindTex(gl, 0, cur.tex);
        bindTex(gl, 1, next.tex);
        gl.uniform1i(u('uC'), 0);
        gl.uniform1i(u('uNext'), 1);
        gl.uniform3f(u('uThresh'), lp.thresh[0], lp.thresh[1], lp.thresh[2]);
        gl.uniform1f(u('uBoost'), lp.boost);
        gl.uniform1f(u('uSigmaY'), lp.sigma[0]);
        gl.uniform1i(u('uStep'), 1 << k);
      });
      gl.disable(gl.BLEND);
      const t = cur; cur = next; next = t;
    }
    // `cur` holds the coarse residual; `next` is free for the result.
    devPass(ctx, ctx.devFinal, next, (u) => {
      bindTex(gl, 0, acc.tex);
      bindTex(gl, 1, cur.tex);
      gl.uniform1i(u('uAcc'), 0);
      gl.uniform1i(u('uCoarse'), 1);
      gl.uniform1i(u('uMode'), mode);
      gl.uniform2f(u('uVst'), vst ? vst.a : 1, vst ? vst.b : 0);
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { out: next, sigmas: measured.slice(0, Detail.LEVELS) };
  }

  // Develops lens texture `texIndex` for state.detail, unless the one
  // already there is current. Returns its texture, or null if there is no
  // lens there.
  function developLens(ctx, state, texIndex) {
    const gl = ctx.gl, dev = ctx.dev;
    const info = ctx.lensInfo[texIndex];
    const size = ctx.textureSize[texIndex];
    if (!ctx.textures[texIndex] || !info || !size) return null;
    if (state.isRaw && !info.noise) return null;
    const d = state.detail;
    const key = [info.id, d.sharpenAmount, d.sharpenRadius, d.lumaNoise, d.colorNoise].join('|');
    if (dev.key[texIndex] === key && dev.out[texIndex]) return dev.out[texIndex].tex;
    const scratch = devScratch(ctx, size.width, size.height);
    gl.bindVertexArray(ctx.vao);
    gl.disable(gl.BLEND);
    const raw = !!state.isRaw;
    const input = raw ? ctx.devInputRaw : ctx.devInputRgb;
    devPass(ctx, input, scratch[0], (u) => {
      bindTex(gl, 0, ctx.textures[texIndex]);
      if (raw) {
        gl.uniform1i(u('uLens'), 0);
        setRawUniforms(gl, input, ctx, texIndex, state, 'A');
        gl.uniform2f(u('uVst'), info.noise.a, info.noise.b);
      } else {
        gl.uniform1i(u('uSrc'), 0);
      }
    });
    // Raw: the layers' noise is known exactly after the transform
    // (Noise.rawLevelSigmas). JPEG: measured on the first run.
    if (raw && !info.sigmas) info.sigmas = Noise.rawLevelSigmas(Detail);
    const r = runDevelop(ctx, scratch, d, info.sigmas, raw ? 1 : 0, raw ? info.noise : null);
    info.sigmas = r.sigmas;
    // Keep the result: it trades places with this lens's previous output
    // (or a fresh target), which becomes scratch.
    const i = scratch.indexOf(r.out);
    const old = dev.out[texIndex];
    dev.out[texIndex] = r.out;
    scratch[i] = old && old.w === r.out.w && old.h === r.out.h ? old : makeDevTarget(gl, r.out.w, r.out.h);
    if (old && scratch[i] !== old) freeDevTarget(gl, old);
    dev.key[texIndex] = key;
    return r.out.tex;
  }

  const GLOW_HEADROOM = 0.08;   // fraction of the circle radius reserved outside the edge

  // `targetFbo` is optional: omitted (or null/undefined), this renders to
  // the default framebuffer -- the canvas -- exactly as before. Passed a
  // framebuffer (see makeExportTarget below), it renders there instead, at
  // whatever size targetW/targetH describe, independent of the canvas's own
  // size or of any drawing-buffer limit the canvas is subject to. This is
  // still the single render path for both preview and export -- export just
  // supplies a different destination framebuffer, not a second
  // implementation of any of the logic below.
  //
  // `place` (Task 19, preview only) is optional too: a rect {x, y, w, h}, in
  // top-left-origin target pixels, to lay the whole composition out in
  // instead of fitting it to the target. The on-screen preview passes it
  // when zoomed, so the canvas only covers the visible region and the
  // composition is drawn offset into it at true resolution; each circle's
  // viewport is then clipped to the target (see cellViewport). Export never
  // passes it, so its geometry and viewports are exactly what they were.
  function renderComposition(ctx, state, targetW, targetH, targetFbo, place) {
    const gl = ctx.gl;
    const layout = placedLayout(state, targetW, targetH, place);
    // state.dngOutput (raw only; set on the DNG export's own state copy)
    // renders linear camera RGB for DngWrite instead of the display image.
    // Noise reduction / sharpening: develop each lens drawn first (cached;
    // see developLens). Not for the DNG export, which is left to the raw
    // converter.
    const developed = [null, null];
    if (!state.dngOutput && state.detail && Detail.isActive(state.detail)) {
      for (const c of layout.circles) {
        const ti = circleDraw(state, c.lens).texIndex;
        if (!developed[ti]) developed[ti] = developLens(ctx, state, ti);
      }
    }
    // All or nothing: one composite program serves every circle.
    const anyDeveloped = layout.circles.length > 0 && layout.circles.every((c) => {
      const ti = circleDraw(state, c.lens).texIndex;
      return !ctx.textures[ti] || developed[ti];
    }) && !!(developed[0] || developed[1]);
    const compositeProgram = state.isRaw
      ? (state.dngOutput ? ctx.compositeDng : (anyDeveloped ? ctx.compositeRawDev : ctx.compositeRaw))
      : ctx.composite;
    gl.bindFramebuffer(gl.FRAMEBUFFER, targetFbo || null);
    gl.bindVertexArray(ctx.vao);
    gl.useProgram(compositeProgram);
    gl.clearColor(state.background[0], state.background[1], state.background[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);

    for (const c of layout.circles) {
      const draw = circleDraw(state, c.lens);
      if (!ctx.textures[draw.texIndex]) continue;
      const cv = cellViewport(c, targetW, targetH, !!place);
      if (!cv.viewport) continue;   // zoomed preview: this circle is off screen
      const physical = physicalLens(state, c.lens);
      const rollRad = draw.rollDeg * Math.PI / 180;
      // buildProfile renders into ctx's own bins x 1 framebuffer (its own
      // coordinate frame, unrelated to this viewport) before the composite
      // draw below reclaims the GL state (program, viewport, vao) it needs.
      // It always ends by unbinding to the default framebuffer, so this
      // draw's own target -- the canvas by default, or targetFbo for an
      // export -- has to be re-bound afterward, every time round this loop.
      const profileTex = buildProfile(ctx, state, draw.texIndex, rollRad, physical);
      gl.bindFramebuffer(gl.FRAMEBUFFER, targetFbo || null);
      const { cell, vx, vy } = cv;
      gl.bindVertexArray(ctx.vao);
      gl.useProgram(compositeProgram);
      // buildProfile disables blending for its own passes; the composite
      // draw below needs it back on (additive, so overlapping cells don't
      // clobber each other's background-filled corners).
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.viewport(cv.viewport[0], cv.viewport[1], cv.viewport[2], cv.viewport[3]);
      // A JPEG lens's developed frame simply stands in for its source; a
      // raw one's is read beside the raw plane (uDeveloped, see
      // RAW_SAMPLE_GLSL).
      const dev = anyDeveloped ? developed[draw.texIndex] : null;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, dev && !state.isRaw ? dev : ctx.textures[draw.texIndex]);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, profileTex);
      const u = (n) => gl.getUniformLocation(compositeProgram, n);
      gl.uniform1i(u('uLens'), 0);
      if (state.isRaw && dev) {
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, dev);
        gl.uniform1i(u('uDeveloped'), 2);
      }
      if (state.isRaw) setRawUniforms(gl, compositeProgram, ctx, draw.texIndex, state, physical);
      // gl_FragCoord is in absolute framebuffer pixels (see shaders.js), so
      // the shader needs this cell's origin to recover local
      // center-relative coordinates. These are the whole (unclipped) cell's
      // rounded values from cellViewport, the same ones an unclipped
      // viewport uses, so the uniform and the raster agree either way.
      gl.uniform2f(u('uCellOrigin'), vx, vy);
      gl.uniform2f(u('uCellSize'), cell, cell);
      gl.uniform1f(u('uCircleRadius'), c.radius);
      gl.uniform1f(u('uCropFrac'), Lens.radiusForFov(state.fovDeg, state.thetaMaxDeg));
      gl.uniform1f(u('uRoll'), rollRad);
      gl.uniform1i(u('uProfile'), 1);
      gl.uniform1f(u('uBins'), Edge.PROFILE_BINS);
      gl.uniform1f(u('uFalloffStart'), state.edge.falloffStart);
      gl.uniform1f(u('uFalloffSoftness'), state.edge.falloffSoftness);
      gl.uniform1f(u('uEdgeIntensity'), state.edge.edgeIntensity);
      gl.uniform1f(u('uRingWidth'), state.edge.ringWidth);
      gl.uniform1f(u('uDispersion'), state.edge.dispersion);
      gl.uniform1f(u('uHazeWidth'), state.edge.hazeWidth);
      gl.uniform1f(u('uHazeStrength'), state.edge.hazeStrength);
      gl.uniform1f(u('uTerminatorDesaturate'), state.edge.terminatorDesaturate);
      gl.uniform1f(u('uTerminatorCoolShift'), state.edge.terminatorCoolShift);
      gl.uniform3f(u('uTone'), state.tone.exposureEv, state.tone.contrast, state.tone.saturation);
      gl.uniform4f(u('uToneCurve'), state.tone.highlights || 0, state.tone.shadows || 0,
        state.tone.whites || 0, state.tone.blacks || 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // Which uploaded texture backs a given output slot, honouring the swap.
  function lensTextureIndex(state, lens) {
    const base = lens === 'A' ? 0 : 1;
    return state.swap ? 1 - base : base;
  }

  // Which physical lens (A or B) backs a given output slot, honouring the
  // swap. Unlike lensTextureIndex (a texture-array index), this returns the
  // physical lens label so callers can look up lens-specific properties --
  // such as the roll mirror -- that belong to the optics, not the layout.
  function physicalLens(state, slotLens) {
    if (!state.swap) return slotLens;
    return slotLens === 'A' ? 'B' : 'A';
  }

  // The single source of truth for what a given output slot draws: which
  // texture backs it, and what roll its pixels need. Both are driven by the
  // same physical lens, so they can never disagree the way they did before
  // (texture chosen by physical lens via the swap, roll looked up by the
  // slot label -- a bug once those diverged under swap).
  // state.sensorRotationDeg (Task 16, fix round) is a fixed *sensor*
  // orientation correction, not a user levelling preference like rollDeg:
  // Insta360 ONE X raw frames store the sensor data rotated 90 degrees
  // relative to how the camera's own JPEG pipeline presents it (the DNG's
  // own Orientation tag says "normal" -- it does not record this), and the
  // two lenses being back-to-back means they need *opposite* corrections,
  // exactly the same mirrored relationship Lens.rollFor already gives
  // rollDeg between physical lens A (+) and B (-). Composed on top of
  // Lens.rollFor's result (which already folds in rollDeg and nudgeDeg)
  // rather than by defaulting rollDeg itself, so the roll slider stays a
  // pure levelling control that reads 0 at "as the sensor is corrected to
  // upright" -- zeroing it must never re-introduce the sideways rotation.
  // Defaults to 0 (via `|| 0`) so callers/tests that don't set the field at
  // all -- every existing gl.test.js case, and every JPEG source -- see no
  // change in behaviour.
  function circleDraw(state, slotLens) {
    const physical = physicalLens(state, slotLens);
    const sensorRotationDeg = state.sensorRotationDeg || 0;
    const sensorTerm = physical === 'A' ? -sensorRotationDeg : sensorRotationDeg;
    return {
      texIndex: lensTextureIndex(state, slotLens),
      rollDeg: Lens.rollFor(state, physical) + sensorTerm,
    };
  }

  // The filename label for an export: 'AB'/'BA' for a both-sensors export
  // (honouring swap), or the *physical* lens label for a single-sensor
  // export. Must go through physicalLens, not the raw `state.sensors` slot
  // label, for exactly the reason circleDraw's own texture lookup does
  // (see that function's comment): with sensors:'A' and swap:true,
  // circleDraw binds the physical B lens's texture into slot A, so a
  // filename naming the slot ('A') rather than the physical lens actually
  // drawn ('B') would be wrong. This was the one call site still doing that
  // (Important finding #3, final review round) -- app.js's exportImage now
  // calls this instead of re-deriving the label inline.
  function exportLabel(state) {
    return state.sensors === 'both'
      ? (state.swap ? 'BA' : 'AB')
      : physicalLens(state, state.sensors);
  }

  // compositionLayout, optionally laid out in `place` (see
  // renderComposition) and translated into the target. Without `place` it
  // *is* compositionLayout -- the export path's layout, untouched.
  function placedLayout(state, targetW, targetH, place) {
    if (!place) return compositionLayout(state, targetW, targetH);
    const l = compositionLayout(state, place.w, place.h);
    return {
      circles: l.circles.map((c) => ({
        lens: c.lens, cx: c.cx + place.x, cy: c.cy + place.y, radius: c.radius,
      })),
    };
  }

  // One circle's composite cell: a square reaching diameter *
  // (1 + 2*GLOW_HEADROOM) so the rim glow, which extends past the crop
  // edge, has room to render. (vx, vy) is its bottom-left corner in GL's
  // y-up framebuffer pixels and `cell` its size -- the uCellOrigin/uCellSize
  // the shader recovers local coordinates from. `viewport` is what
  // gl.viewport gets: the whole cell unless `clip` is set, in which case it
  // is the cell's intersection with the target (null if they don't
  // overlap). The shader's geometry depends only on uCellOrigin/uCellSize
  // and gl_FragCoord, so clipping the viewport changes which fragments run,
  // never what any of them computes -- it just keeps a 100%+ zoom's huge
  // cells inside the canvas and under MAX_VIEWPORT_DIMS.
  function cellViewport(c, targetW, targetH, clip) {
    const cell = Math.round(c.radius * 2 * (1 + 2 * GLOW_HEADROOM));
    const vx = Math.round(c.cx - cell / 2);
    const vy = Math.round(targetH - c.cy - cell / 2);
    if (!clip) return { cell, vx, vy, viewport: [vx, vy, cell, cell] };
    const x0 = Math.max(0, vx), y0 = Math.max(0, vy);
    const x1 = Math.min(targetW, vx + cell), y1 = Math.min(targetH, vy + cell);
    return { cell, vx, vy, viewport: x1 > x0 && y1 > y0 ? [x0, y0, x1 - x0, y1 - y0] : null };
  }

  // Scale Lens.exportLayout's pixel geometry to fit the given target.
  function compositionLayout(state, targetW, targetH) {
    const d = 1000;  // arbitrary reference diameter; everything is scaled below
    const g = Lens.exportLayout({
      circleDiameter: d,
      sensors: state.sensors,
      orientation: state.orientation,
      gapPx: state.gapFrac * d,
      marginPx: state.marginFrac * d,
    });
    const s = Math.min(targetW / g.width, targetH / g.height);
    const offX = (targetW - g.width * s) / 2;
    const offY = (targetH - g.height * s) / 2;
    return {
      circles: g.circles.map((c) => ({
        lens: c.lens, cx: offX + c.cx * s, cy: offY + c.cy * s, radius: (d / 2) * s,
      })),
    };
  }

  // A texture-backed offscreen framebuffer at the export's full pixel size.
  // Unlike the visible canvas, an offscreen FBO's colour attachment is not
  // subject to whatever drawing-buffer allocation limit the browser/driver
  // imposes on the canvas itself -- only to MAX_TEXTURE_SIZE /
  // MAX_RENDERBUFFER_SIZE (checked by the caller before this is created)
  // and to the GPU's actual available memory (checked here, via
  // checkFramebufferStatus, since that's the only way to find out).
  // NEAREST filtering: this texture is only ever written once by
  // renderComposition and then read back pixel-for-pixel, never resampled.
  function makeExportTarget(gl, w, h) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fbo, width: w, height: h, complete: status === gl.FRAMEBUFFER_COMPLETE, status };
  }

  // A float export target for the DNG export's linear values: RGBA32F when
  // it can be blended into (`full`), else RGBA16F.
  function makeFloatExportTarget(gl, w, h, full) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, full ? gl.RGBA32F : gl.RGBA16F, w, h, 0, gl.RGBA, gl.FLOAT, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fbo, width: w, height: h, complete: status === gl.FRAMEBUFFER_COMPLETE, status };
  }

  // readCompositionStrips for a float target: `rowsRGBA` is a Float32Array.
  function readCompositionStripsFloat(gl, fbo, w, h, stripRows, onStrip) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    const buf = new Float32Array(w * stripRows * 4);
    const rowLen = w * 4;
    const tmp = new Float32Array(rowLen);
    for (let outY = 0; outY < h; outY += stripRows) {
      const rows = Math.min(stripRows, h - outY);
      const glY = h - outY - rows;
      const view = rows === stripRows ? buf : buf.subarray(0, rowLen * rows);
      gl.readPixels(0, glY, w, rows, gl.RGBA, gl.FLOAT, view);
      for (let i = 0, j = rows - 1; i < j; i++, j--) {
        tmp.set(view.subarray(i * rowLen, i * rowLen + rowLen));
        view.set(view.subarray(j * rowLen, j * rowLen + rowLen), i * rowLen);
        view.set(tmp, j * rowLen);
      }
      onStrip(view, outY, rows);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  function deleteExportTarget(gl, target) {
    gl.deleteTexture(target.tex);
    gl.deleteFramebuffer(target.fbo);
  }

  // Reads an export target back top-down, in horizontal strips of at most
  // `stripRows` rows, calling `onStrip(rowsRGBA, outY, rows)` for each --
  // `rowsRGBA` is a Uint8Array of `w * rows * 4` bytes, already flipped into
  // top-down (ImageData) row order, `outY` is that strip's first row in the
  // final top-down image. Bounds peak memory to one strip (plus whatever the
  // caller does with it) instead of the whole image: a two-lens side-by-side
  // export can be ~11900px wide, and a naive single readPixels there would
  // be ~283MB for the raw bytes alone, then as much again once copied into
  // an ImageData. gl.readPixels fills the framebuffer's own bottom-up row
  // order (GL y=0 is the bottom), the opposite of ImageData/canvas's
  // top-down order, so each strip is read from the matching bottom-up
  // y-range and then has its rows reversed in place before the callback
  // sees it -- getting this flip backwards would export every image upside
  // down, so callers must not skip it and should verify against a known
  // pixel (see test/export.test.js and the live check in the task report).
  //
  // `onStrip`'s `rowsRGBA` argument is a *view* onto one scratch buffer
  // (`buf` below) allocated once for the whole call and reused for every
  // strip -- it is only valid for the duration of that one `onStrip`
  // invocation. A caller that needs the bytes afterward (rather than
  // consuming them synchronously, as app.js's putImageData does) must copy
  // them; holding onto `rowsRGBA` across the next strip will see it
  // overwritten.
  function readCompositionStrips(gl, fbo, w, h, stripRows, onStrip) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    const buf = new Uint8Array(w * stripRows * 4);
    for (let outY = 0; outY < h; outY += stripRows) {
      const rows = Math.min(stripRows, h - outY);
      const glY = h - outY - rows; // bottom edge of this slice, in GL's own y-up coords
      const view = rows === stripRows ? buf : buf.subarray(0, w * rows * 4);
      gl.readPixels(0, glY, w, rows, gl.RGBA, gl.UNSIGNED_BYTE, view);
      const rowBytes = w * 4;
      const tmp = new Uint8Array(rowBytes);
      for (let i = 0, j = rows - 1; i < j; i++, j--) {
        tmp.set(view.subarray(i * rowBytes, i * rowBytes + rowBytes));
        view.set(view.subarray(j * rowBytes, j * rowBytes + rowBytes), i * rowBytes);
        view.set(tmp, j * rowBytes);
      }
      onStrip(view, outY, rows);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // Pixel geometry for the exported file -- same crop math the preview
  // uses, but sized off the frame actually decoded onto the GPU
  // (state.uploadedLensSize), not the source file's own lens size
  // (state.sourceLensSize). The two differ when this GPU's MAX_TEXTURE_SIZE
  // is below the file's lens size: app.js downscales the decoded bitmap at
  // load time, but sourceLensSize still holds the pre-downscale value.
  // Sizing exports off sourceLensSize in that case would silently request
  // more pixels than the texture holds -- an invented-resolution upscale of
  // exactly the kind this exporter otherwise refuses to do. uploadedLensSize
  // falls back to sourceLensSize so this still works before any texture has
  // been uploaded (e.g. a unit test constructing state by hand).
  //
  // Kept here, not in lens.js, because lens.js is the calibration-geometry
  // module (radiusForFov, exportLayout) with no notion of "state" or of a
  // GPU's texture limits; this function's job is combining that geometry
  // with render-time facts (state, the actual uploaded size), which is
  // exactly gl.js's role for compositionLayout above. It is pure (no gl
  // calls) so it's unit-testable the same way as the rest of this file.
  function exportGeometry(state) {
    const lensSize = state.uploadedLensSize || state.sourceLensSize;
    const cropFrac = Lens.radiusForFov(state.fovDeg, state.thetaMaxDeg);
    const nativeDiameter = Math.round(lensSize * cropFrac);
    const diameter = state.padToSensorSquare ? lensSize : nativeDiameter;
    return Lens.exportLayout({
      circleDiameter: diameter,
      sensors: state.sensors,
      orientation: state.orientation,
      gapPx: Math.round(state.gapFrac * diameter),
      marginPx: Math.round(state.marginFrac * diameter),
    });
  }

  return {
    create, uploadLens, uploadBayer, makeLensTexture, makeBayerTexture, releaseLens,
    commitLenses, renderComposition, compositionLayout, placedLayout, cellViewport, GLOW_HEADROOM,
    lensTextureIndex,
    physicalLens, circleDraw, exportLabel, program, buildProfile, readProfile, makeProfileTarget,
    exportGeometry, makeExportTarget, deleteExportTarget, readCompositionStrips,
    makeFloatExportTarget, readCompositionStripsFloat,
    developLens, releaseDeveloped, runDevelop, makeDevTarget, freeDevTarget,
  };
});
