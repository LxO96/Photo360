(function () {
  'use strict';

  const canvas = document.getElementById('view');
  const dropEl = document.getElementById('drop');
  const fileEl = document.getElementById('file');
  const fovEl = document.getElementById('fov');
  const fovOut = document.getElementById('fovOut');
  const sensorsEl = document.getElementById('sensors');
  const orientationEl = document.getElementById('orientation');
  const swapEl = document.getElementById('swap');
  const gapEl = document.getElementById('gap');
  const gapOut = document.getElementById('gapOut');
  const marginEl = document.getElementById('margin');
  const marginOut = document.getElementById('marginOut');
  const rollEl = document.getElementById('roll');
  const rollOut = document.getElementById('rollOut');
  const nudgeAEl = document.getElementById('nudgeA');
  const nudgeAOut = document.getElementById('nudgeAOut');
  const nudgeBEl = document.getElementById('nudgeB');
  const nudgeBOut = document.getElementById('nudgeBOut');
  const readout = document.getElementById('readout');
  const errorEl = document.getElementById('error');

  const state = {
    fovDeg: 180, thetaMaxDeg: Lens.THETA_MAX_DEG,
    rollDeg: 0,
    nudgeDeg: { A: 0, B: 0 },
    sensors: 'A', swap: false,
    orientation: 'side',
    gapFrac: 0, marginFrac: 0,
    background: [0, 0, 0],
    sourceName: '', sourceLensSize: 0,
    edge: { ...Edge.PRESETS.x1classic },
    tone: { exposureEv: 0, contrast: 0, saturation: 0 },
  };
  let ctx = null;

  // The X5's own .insp files carry several megabytes of embedded metadata
  // (gain-map / preview APPn segments) before the SOF marker that carries
  // the frame size, so the probe has to read a generous head -- still
  // trivial next to decoding the full 283MB frame just to read two numbers.
  const HEAD_PROBE_BYTES = 6 * 1024 * 1024;

  function fail(msg) { errorEl.textContent = msg; }

  // Read the frame dimensions without decoding pixel data: parse the JPEG
  // header directly, and only fall back to a full decode if that fails
  // (e.g. an unusual file whose SOF sits beyond the probed head).
  async function probeSize(blob, buf) {
    const head = new Uint8Array(buf, 0, Math.min(buf.byteLength, HEAD_PROBE_BYTES));
    const size = Exif.readJpegSize(head);
    if (size) return size;
    const probe = await createImageBitmap(blob);
    const fallback = { width: probe.width, height: probe.height };
    probe.close();
    return fallback;
  }

  async function loadFile(file) {
    errorEl.textContent = '';
    try {
      const buf = await file.arrayBuffer();
      const blob = new Blob([buf], { type: 'image/jpeg' });  // .insp has no MIME type
      const size = await probeSize(blob, buf);
      const layout = Lens.detectLayout(size.width, size.height);
      if (layout.kind === 'unsupported') {
        fail('Not a fisheye file: expected a 2:1 dual fisheye or a 1:1 single fisheye.');
        return;
      }
      if (!ctx) ctx = GL.create(canvas);
      const overLimit = layout.lensSize > ctx.maxTextureSize;
      if (overLimit) {
        fail('This GPU caps textures at ' + ctx.maxTextureSize +
             ' px; the image is being downscaled from ' + layout.lensSize + ' px.');
      }
      // imageOrientation: 'flipY' makes GL texture t=0 the bottom of the
      // image, matching gl_FragCoord.y (increases upward). Tried
      // gl.pixelStorei(UNPACK_FLIP_Y_WEBGL) first, but that pixel-store
      // flag has no effect on ImageBitmap sources -- this option, baked in
      // at decode time, is what actually flips the sampled orientation.
      const decodeOpts = overLimit
        ? { imageOrientation: 'flipY', resizeWidth: ctx.maxTextureSize,
            resizeHeight: ctx.maxTextureSize, resizeQuality: 'high' }
        : { imageOrientation: 'flipY' };
      for (let i = 0; i < layout.lenses.length; i++) {
        const o = layout.lenses[i];
        const half = await createImageBitmap(
          blob, o.x, o.y, layout.lensSize, layout.lensSize, decodeOpts);
        try {
          GL.uploadLens(ctx, i, half);
        } finally {
          half.close();
        }
      }
      state.sourceName = file.name;
      state.sourceLensSize = layout.lensSize;
      dropEl.classList.add('hidden');
      render();
    } catch (e) {
      fail(e.message === 'WEBGL2_UNAVAILABLE'
        ? 'This browser has no WebGL2 support.'
        : e.message === 'FLOAT_FBO_UNAVAILABLE'
          ? 'This GPU/browser lacks floating-point render targets (EXT_color_buffer_float), needed for the rim glow.'
          : 'Could not read that file: ' + e.message);
    }
  }

  function render() {
    if (!ctx || !state.sourceLensSize) return;
    const avail = Math.min(canvas.parentElement.clientWidth, canvas.parentElement.clientHeight) - 48;
    const layout = Lens.exportLayout({
      circleDiameter: 1000,
      sensors: state.sensors,
      orientation: state.orientation,
      gapPx: state.gapFrac * 1000,
      marginPx: state.marginFrac * 1000,
    });
    const aspect = layout.width / layout.height;
    const fit = Math.max(256, Math.floor(avail));
    if (aspect >= 1) {
      canvas.width = fit;
      canvas.height = Math.round(fit / aspect);
    } else {
      canvas.height = fit;
      canvas.width = Math.round(fit * aspect);
    }
    canvas.style.width = canvas.width + 'px';
    canvas.style.height = canvas.height + 'px';
    GL.renderComposition(ctx, state, canvas.width, canvas.height);
    const c = Lens.coverage(state.fovDeg, state.thetaMaxDeg);
    readout.textContent = c.overlapDeg === 0
      ? 'Exactly one hemisphere — nothing duplicated with the other lens.'
      : c.overlapDeg > 0
        ? `${c.overlapDeg.toFixed(1)}° past the hemisphere — ` +
          `${(c.duplicatedAreaFraction * 100).toFixed(0)}% of this image also appears in the other lens.`
        : `${(-c.overlapDeg).toFixed(1)}° short of the hemisphere — a gap between the two lenses.`;
  }

  fovEl.addEventListener('input', () => {
    state.fovDeg = parseFloat(fovEl.value);
    fovOut.textContent = state.fovDeg.toFixed(1) + '°';
    render();
  });

  sensorsEl.addEventListener('input', () => {
    state.sensors = sensorsEl.value;
    render();
  });

  orientationEl.addEventListener('input', () => {
    state.orientation = orientationEl.value;
    render();
  });

  swapEl.addEventListener('input', () => {
    state.swap = swapEl.checked;
    render();
  });

  gapEl.addEventListener('input', () => {
    state.gapFrac = parseFloat(gapEl.value) / 100;
    gapOut.textContent = gapEl.value + '%';
    render();
  });

  marginEl.addEventListener('input', () => {
    state.marginFrac = parseFloat(marginEl.value) / 100;
    marginOut.textContent = marginEl.value + '%';
    render();
  });

  rollEl.addEventListener('input', () => {
    state.rollDeg = parseFloat(rollEl.value);
    rollOut.textContent = state.rollDeg.toFixed(1) + '°';
    render();
  });

  nudgeAEl.addEventListener('input', () => {
    state.nudgeDeg.A = parseFloat(nudgeAEl.value);
    nudgeAOut.textContent = state.nudgeDeg.A.toFixed(1) + '°';
    render();
  });

  nudgeBEl.addEventListener('input', () => {
    state.nudgeDeg.B = parseFloat(nudgeBEl.value);
    nudgeBOut.textContent = state.nudgeDeg.B.toFixed(1) + '°';
    render();
  });

  dropEl.addEventListener('click', () => fileEl.click());
  fileEl.addEventListener('change', () => fileEl.files[0] && loadFile(fileEl.files[0]));
  document.addEventListener('dragover', (e) => { e.preventDefault(); });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
  });
  window.addEventListener('resize', render);

  // Browser-side half of the GLSL/JS parity check (test/parity.test.js is
  // the other half). Renders PROFILE_BUILD_PARITY_FS + PROFILE_BLUR_FS --
  // the analytic-sampler variant of the real profile shaders -- with the
  // exact opts baked into test/fixtures/parity-input.json, and compares
  // the readback against that fixture's expected values. Requires the page
  // to be served over HTTP (fetch of a local file fails under file://).
  async function checkParity() {
    if (!ctx) ctx = GL.create(canvas);
    const gl = ctx.gl;
    const res = await fetch('test/fixtures/parity-input.json');
    const fixture = await res.json();
    const bins = fixture.opts.bins;

    const buildProg = GL.program(gl, Shaders.FULLSCREEN_VS, Shaders.PROFILE_BUILD_PARITY_FS);
    const blurProg = GL.program(gl, Shaders.FULLSCREEN_VS, Shaders.PROFILE_BLUR_FS);
    const a = GL.makeProfileTarget(gl, bins);
    const b = GL.makeProfileTarget(gl, bins);

    gl.bindVertexArray(ctx.vao);
    gl.disable(gl.BLEND);
    gl.viewport(0, 0, bins, 1);

    gl.bindFramebuffer(gl.FRAMEBUFFER, a.fbo);
    gl.useProgram(buildProg);
    const ub = (n) => gl.getUniformLocation(buildProg, n);
    gl.uniform1f(ub('uBins'), bins);
    gl.uniform1i(ub('uRadialSamples'), fixture.opts.radialSamples);
    gl.uniform1f(ub('uUMin'), fixture.opts.uMin);
    gl.uniform1f(ub('uUMax'), fixture.opts.uMax);
    gl.uniform1f(ub('uKnee'), fixture.opts.knee);
    gl.uniform1f(ub('uExponent'), fixture.opts.exponent);
    gl.uniform1f(ub('uCropFrac'), 1.0);
    gl.uniform1f(ub('uRoll'), 0.0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindFramebuffer(gl.FRAMEBUFFER, b.fbo);
    gl.useProgram(blurProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, a.tex);
    const uu = (n) => gl.getUniformLocation(blurProg, n);
    gl.uniform1i(uu('uProfile'), 0);
    gl.uniform1f(uu('uBins'), bins);
    gl.uniform1f(uu('uSpreadBins'), fixture.spreadBins);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    const actual = GL.readProfile(ctx, b.tex);
    let maxDiff = 0;
    for (let i = 0; i < fixture.expected.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(actual[i] - fixture.expected[i]));
    }

    gl.deleteTexture(a.tex); gl.deleteFramebuffer(a.fbo);
    gl.deleteTexture(b.tex); gl.deleteFramebuffer(b.fbo);
    gl.deleteProgram(buildProg); gl.deleteProgram(blurProg);

    console.log('rim profile parity: max abs diff =', maxDiff,
      maxDiff < 2e-3 ? '(OK, below 2e-3)' : '(FAIL, exceeds 2e-3)');
    return maxDiff;
  }

  window.App = { loadFile, state, render, rollFor: Lens.rollFor, checkParity };
})();
