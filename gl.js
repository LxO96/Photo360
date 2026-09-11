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
    const ctx = {
      gl,
      canvas,
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      textures: [null, null],
      composite: program(gl, Shaders.FULLSCREEN_VS, Shaders.COMPOSITE_FS),
      vao: gl.createVertexArray(),
    };
    return ctx;
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
      const texIndex = lensTextureIndex(state, c.lens);
      if (!ctx.textures[texIndex]) continue;
      const cell = c.radius * (1 + GLOW_HEADROOM) * 2;
      const vx = Math.round(c.cx - cell / 2);
      const vy = Math.round(targetH - c.cy - cell / 2);
      const vw = Math.round(cell);
      const vh = Math.round(cell);
      gl.viewport(vx, vy, vw, vh);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, ctx.textures[texIndex]);
      const u = (n) => gl.getUniformLocation(ctx.composite, n);
      gl.uniform1i(u('uLens'), 0);
      // gl_FragCoord is in absolute framebuffer pixels (see shaders.js), so
      // the shader needs this cell's viewport origin to recover local
      // center-relative coordinates.
      gl.uniform2f(u('uCellOrigin'), vx, vy);
      gl.uniform2f(u('uCellSize'), cell, cell);
      gl.uniform1f(u('uCircleRadius'), c.radius);
      gl.uniform1f(u('uCropFrac'), Lens.radiusForFov(state.fovDeg, state.thetaMaxDeg));
      gl.uniform1f(u('uRoll'), Lens.rollFor(state, c.lens) * Math.PI / 180);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.disable(gl.BLEND);
  }

  // Which uploaded texture backs a given output slot, honouring the swap.
  function lensTextureIndex(state, lens) {
    const base = lens === 'A' ? 0 : 1;
    return state.swap ? 1 - base : base;
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

  return { create, uploadLens, renderComposition, compositionLayout, program };
});
