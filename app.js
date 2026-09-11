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

  function fail(msg) { errorEl.textContent = msg; }

  async function loadFile(file) {
    errorEl.textContent = '';
    try {
      const buf = await file.arrayBuffer();
      const blob = new Blob([buf], { type: 'image/jpeg' });  // .insp has no MIME type
      const probe = await createImageBitmap(blob);
      const layout = Lens.detectLayout(probe.width, probe.height);
      probe.close();
      if (layout.kind === 'unsupported') {
        fail('Not a fisheye file: expected a 2:1 dual fisheye or a 1:1 single fisheye.');
        return;
      }
      if (!ctx) ctx = GL.create(canvas);
      if (layout.lensSize > ctx.maxTextureSize) {
        fail('This GPU caps textures at ' + ctx.maxTextureSize +
             ' px; the image will be downscaled from ' + layout.lensSize + ' px.');
      }
      for (let i = 0; i < layout.lenses.length; i++) {
        const o = layout.lenses[i];
        const half = await createImageBitmap(blob, o.x, o.y, layout.lensSize, layout.lensSize);
        GL.uploadLens(ctx, i, half);
        half.close();
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
