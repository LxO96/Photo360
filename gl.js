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
      textures: [null, null],
      // Per-texture size, populated by uploadBayer (uploadLens doesn't need
      // it -- the JPEG path samples with normalized UVs via `texture()`,
      // not `texelFetch`, so it never needs to know pixel dimensions).
      textureSize: [null, null],
      composite: program(gl, Shaders.FULLSCREEN_VS, Shaders.COMPOSITE_FS),
      compositeRaw: program(gl, Shaders.FULLSCREEN_VS, Shaders.COMPOSITE_RAW_FS),
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
    gl.uniformMatrix3fv(u('uCamToSrgb'), true, meta.camToSrgb);
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
    return { tex: t, size: null };
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
  function commitLenses(ctx, built) {
    for (let i = 0; i < 2; i++) {
      if (i < built.length) {
        releaseLens(ctx, i);
        ctx.textures[i] = built[i].tex;
        ctx.textureSize[i] = built[i].size;
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

  const GLOW_HEADROOM = 0.08;   // fraction of the circle radius reserved outside the edge

  // `targetFbo` is optional: omitted (or null/undefined), this renders to
  // the default framebuffer -- the canvas -- exactly as before. Passed a
  // framebuffer (see makeExportTarget below), it renders there instead, at
  // whatever size targetW/targetH describe, independent of the canvas's own
  // size or of any drawing-buffer limit the canvas is subject to. This is
  // still the single render path for both preview and export -- export just
  // supplies a different destination framebuffer, not a second
  // implementation of any of the logic below.
  function renderComposition(ctx, state, targetW, targetH, targetFbo) {
    const gl = ctx.gl;
    const layout = compositionLayout(state, targetW, targetH);
    const compositeProgram = state.isRaw ? ctx.compositeRaw : ctx.composite;
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
      // Cell reaches diameter * (1 + 2*GLOW_HEADROOM) so a later task's rim
      // glow, which extends past the crop edge, has room to render.
      const cell = Math.round(c.radius * 2 * (1 + 2 * GLOW_HEADROOM));
      const vx = Math.round(c.cx - cell / 2);
      const vy = Math.round(targetH - c.cy - cell / 2);
      gl.bindVertexArray(ctx.vao);
      gl.useProgram(compositeProgram);
      // buildProfile disables blending for its own passes; the composite
      // draw below needs it back on (additive, so overlapping cells don't
      // clobber each other's background-filled corners).
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.viewport(vx, vy, cell, cell);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, ctx.textures[draw.texIndex]);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, profileTex);
      const u = (n) => gl.getUniformLocation(compositeProgram, n);
      gl.uniform1i(u('uLens'), 0);
      if (state.isRaw) setRawUniforms(gl, compositeProgram, ctx, draw.texIndex, state, physical);
      // gl_FragCoord is in absolute framebuffer pixels (see shaders.js), so
      // the shader needs this cell's viewport origin to recover local
      // center-relative coordinates. Use the same rounded values as the
      // viewport call so the uniform and the actual raster agree.
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
    commitLenses, renderComposition, compositionLayout, lensTextureIndex,
    physicalLens, circleDraw, exportLabel, program, buildProfile, readProfile, makeProfileTarget,
    exportGeometry, makeExportTarget, deleteExportTarget, readCompositionStrips,
  };
});
