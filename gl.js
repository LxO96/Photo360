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

  function renderPreview(ctx, state) {
    const gl = ctx.gl;
    gl.bindVertexArray(ctx.vao);
    gl.useProgram(ctx.composite);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const w = ctx.canvas.width, h = ctx.canvas.height;
    gl.viewport(0, 0, w, h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, ctx.textures[0]);
    gl.uniform1i(gl.getUniformLocation(ctx.composite, 'uLens'), 0);
    gl.uniform2f(gl.getUniformLocation(ctx.composite, 'uCellSize'), w, h);
    gl.uniform1f(gl.getUniformLocation(ctx.composite, 'uCircleRadius'), Math.min(w, h) / 2);
    gl.uniform1f(gl.getUniformLocation(ctx.composite, 'uCropFrac'),
      Lens.radiusForFov(state.fovDeg, state.thetaMaxDeg));
    gl.uniform1f(gl.getUniformLocation(ctx.composite, 'uRoll'), 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  return { create, uploadLens, renderPreview, program };
});
