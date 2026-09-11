(function () {
  'use strict';

  const canvas = document.getElementById('view');
  const dropEl = document.getElementById('drop');
  const fileEl = document.getElementById('file');
  const fovEl = document.getElementById('fov');
  const fovOut = document.getElementById('fovOut');
  const readout = document.getElementById('readout');
  const errorEl = document.getElementById('error');

  const state = {
    fovDeg: 180, thetaMaxDeg: Lens.THETA_MAX_DEG,
    sensors: 'A', sourceName: '', sourceLensSize: 0,
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
        : 'Could not read that file: ' + e.message);
    }
  }

  function render() {
    if (!ctx || !state.sourceLensSize) return;
    const side = Math.min(canvas.parentElement.clientWidth, canvas.parentElement.clientHeight) - 48;
    canvas.width = canvas.height = Math.max(256, Math.floor(side));
    canvas.style.width = canvas.style.height = canvas.width + 'px';
    GL.renderPreview(ctx, state);
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

  dropEl.addEventListener('click', () => fileEl.click());
  fileEl.addEventListener('change', () => fileEl.files[0] && loadFile(fileEl.files[0]));
  document.addEventListener('dragover', (e) => { e.preventDefault(); });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
  });
  window.addEventListener('resize', render);

  window.App = { loadFile, state, render };
})();
