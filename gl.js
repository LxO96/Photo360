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

  function renderComposition(ctx, state, targetW, targetH) {
    const gl = ctx.gl;
    const layout = compositionLayout(state, targetW, targetH);
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
      const profileTex = buildProfile(ctx, state, draw.texIndex, rollRad);
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
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.disable(gl.BLEND);
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

  return {
    create, uploadLens, renderComposition, compositionLayout, lensTextureIndex,
    physicalLens, circleDraw, program, buildProfile, readProfile, makeProfileTarget,
  };
});
