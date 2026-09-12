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
    const gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, preserveDrawingBuffer: true,
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
      composite: program(gl, Shaders.FULLSCREEN_VS, Shaders.COMPOSITE_FS),
      profileBuild: program(gl, Shaders.FULLSCREEN_VS, Shaders.PROFILE_BUILD_FS),
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

  // Renders the two rim-profile passes (build, then angular blur) for one
  // lens circle into a bins x 1 RGBA16F texture and returns it. The
  // returned texture belongs to ctx's ping-pong pair and is reused on the
  // next call -- callers must finish using it (e.g. bind it for the
  // composite draw) before calling buildProfile again.
  function buildProfile(ctx, state, texIndex, rollRad) {
    const gl = ctx.gl;
    const bins = Edge.PROFILE_BINS;
    ensureProfileTargets(ctx, bins);
    const [a, b] = ctx.profileTargets;

    gl.bindVertexArray(ctx.vao);
    gl.disable(gl.BLEND);
    gl.viewport(0, 0, bins, 1);

    // Pass 1: build the raw per-bin highlight-weighted profile. Samples the
    // lens the same way COMPOSITE_FS does (same uCropFrac, same roll
    // convention) so the glow this drives lines up with the image it came
    // from -- see PROFILE_BUILD_FS / sampleLens in shaders.js.
    gl.bindFramebuffer(gl.FRAMEBUFFER, a.fbo);
    gl.useProgram(ctx.profileBuild);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, ctx.textures[texIndex]);
    const ub = (n) => gl.getUniformLocation(ctx.profileBuild, n);
    gl.uniform1i(ub('uLens'), 0);
    gl.uniform1f(ub('uBins'), bins);
    gl.uniform1i(ub('uRadialSamples'), RADIAL_SAMPLES);
    gl.uniform1f(ub('uUMin'), U_MIN);
    gl.uniform1f(ub('uUMax'), U_MAX);
    gl.uniform1f(ub('uKnee'), state.edge.highlightKnee);
    gl.uniform1f(ub('uExponent'), state.edge.highlightExponent);
    gl.uniform1f(ub('uCropFrac'), Lens.radiusForFov(state.fovDeg, state.thetaMaxDeg));
    gl.uniform1f(ub('uRoll'), rollRad);
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

  function uploadLens(ctx, index, bitmap) {
    const gl = ctx.gl;
    if (ctx.textures[index]) gl.deleteTexture(ctx.textures[index]);
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // Orientation note: the bitmap handed in here must already be decoded
    // with { imageOrientation: 'flipY' } (see app.js) so that texture t=0
    // lands at the bottom of the image, matching GL's convention that
    // gl_FragCoord.y increases upward. gl.pixelStorei(UNPACK_FLIP_Y_WEBGL)
    // was tried first but has no effect on ImageBitmap sources in this
    // engine -- verified empirically with an isolated 2x2-texel texture.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    ctx.textures[index] = t;
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
    gl.bindFramebuffer(gl.FRAMEBUFFER, targetFbo || null);
    gl.bindVertexArray(ctx.vao);
    gl.useProgram(ctx.composite);
    gl.clearColor(state.background[0], state.background[1], state.background[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);

    for (const c of layout.circles) {
      const draw = circleDraw(state, c.lens);
      if (!ctx.textures[draw.texIndex]) continue;
      const rollRad = draw.rollDeg * Math.PI / 180;
      // buildProfile renders into ctx's own bins x 1 framebuffer (its own
      // coordinate frame, unrelated to this viewport) before the composite
      // draw below reclaims the GL state (program, viewport, vao) it needs.
      // It always ends by unbinding to the default framebuffer, so this
      // draw's own target -- the canvas by default, or targetFbo for an
      // export -- has to be re-bound afterward, every time round this loop.
      const profileTex = buildProfile(ctx, state, draw.texIndex, rollRad);
      gl.bindFramebuffer(gl.FRAMEBUFFER, targetFbo || null);
      // Cell reaches diameter * (1 + 2*GLOW_HEADROOM) so a later task's rim
      // glow, which extends past the crop edge, has room to render.
      const cell = Math.round(c.radius * 2 * (1 + 2 * GLOW_HEADROOM));
      const vx = Math.round(c.cx - cell / 2);
      const vy = Math.round(targetH - c.cy - cell / 2);
      gl.bindVertexArray(ctx.vao);
      gl.useProgram(ctx.composite);
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
      const u = (n) => gl.getUniformLocation(ctx.composite, n);
      gl.uniform1i(u('uLens'), 0);
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
  function circleDraw(state, slotLens) {
    const physical = physicalLens(state, slotLens);
    return {
      texIndex: lensTextureIndex(state, slotLens),
      rollDeg: Lens.rollFor(state, physical),
    };
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
    create, uploadLens, renderComposition, compositionLayout, lensTextureIndex,
    physicalLens, circleDraw, program, buildProfile, readProfile, makeProfileTarget,
    exportGeometry, makeExportTarget, deleteExportTarget, readCompositionStrips,
  };
});
