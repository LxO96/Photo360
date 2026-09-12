(function () {
  'use strict';

  const canvas = document.getElementById('view');
  const guidesCanvas = document.getElementById('guides');
  const stageEl = document.getElementById('stage');
  const showGuidesEl = document.getElementById('showGuides');
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
  const formatEl = document.getElementById('format');
  const qualityEl = document.getElementById('quality');
  const qualityOut = document.getElementById('qualityOut');
  const padToSensorSquareEl = document.getElementById('padToSensorSquare');
  const exportSizeEl = document.getElementById('exportSize');
  const exportBtn = document.getElementById('export');

  const state = {
    fovDeg: 180, thetaMaxDeg: Lens.THETA_MAX_DEG,
    rollDeg: 0,
    nudgeDeg: { A: 0, B: 0 },
    sensors: 'A', swap: false,
    orientation: 'side',
    // Task 12: at marginFrac 0 the synthesized rim glow is cropped at the
    // canvas boundary -- compositionLayout gives the circle the full
    // canvas half-width, so the glow's headroom (GL.GLOW_HEADROOM, 8% of
    // the circle radius each side) falls outside the framebuffer. That is
    // real, faithful-to-the-hardware behaviour (the X1 reference photo is
    // clipped the same way by its own sensor frame), but it should not be
    // what a first-time export silently does. Default the margin to 8% --
    // exactly GL's own glow headroom -- so the fitted edge this tool works
    // hard to produce is visible out of the box. Anyone who wants the
    // flush-to-frame look still has the Margin slider, down to 0%.
    //
    // The stated output requirement is a circle on a black square, either
    // 1:1 (one lens) or exactly 2:1/1:2 (both). A single lens stays square
    // under any margin, but the two-up layout is
    // width = 2*diameter + gap + 2*margin, height = diameter + 2*margin --
    // exactly 2:1 only when gap == 2*margin (see Lens.exportLayout and
    // test/lens.test.js). Defaulting gapFrac to twice marginFrac keeps the
    // shipped defaults on the required 2:1/1:2 while still showing the
    // fitted rim; the two sliders stay fully independent otherwise -- a
    // user who moves one away from this relationship gets a different
    // aspect ratio on purpose, which #exportSize's ratio suffix makes
    // visible rather than silent.
    gapFrac: 0.16,
    marginFrac: 0.08,
    background: [0, 0, 0],
    sourceName: '', sourceLensSize: 0,
    // The size actually uploaded to the GPU for this file's lenses -- may
    // be smaller than sourceLensSize if this GPU's MAX_TEXTURE_SIZE forced
    // a downscale at load time (see loadFile). GL.exportGeometry sizes the
    // export off this, not sourceLensSize, so export can never silently
    // upscale past what the texture actually holds.
    uploadedLensSize: 0,
    edge: { ...Edge.PRESETS.x1classic },
    tone: { exposureEv: 0, contrast: 0, saturation: 0 },
    // Task 12 output options. Not part of Settings.PERSISTED_KEYS -- these
    // describe how to write the next file, not a framing preference worth
    // resurrecting across a reload the way fovDeg/edge/tone are.
    padToSensorSquare: false,
    format: 'jpeg',
    quality: 95,
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
      state.uploadedLensSize = overLimit ? ctx.maxTextureSize : layout.lensSize;
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
    drawGuides();
    updateExportSize();
  }

  // Reports the exact pixel dimensions the next export will write, so the
  // native-sampling default (no invented resolution) is visible rather than
  // implied. Recomputed from GL.exportGeometry -- the same geometry
  // exportImage itself renders at -- so this text can never drift from what
  // actually gets written.
  function updateExportSize() {
    if (!state.sourceLensSize) { exportSizeEl.textContent = ''; return; }
    const g = GL.exportGeometry(state);
    const downscaled = state.uploadedLensSize && state.uploadedLensSize < state.sourceLensSize;
    const note = state.padToSensorSquare
      ? (downscaled ? 'upscaled to this GPU’s capped texture size' : 'upscaled to sensor square')
      : (downscaled ? 'native to this GPU’s capped texture size' : 'native, no invented resolution');
    exportSizeEl.textContent =
      `Exports at ${g.width} × ${g.height} px (${note}) — ${aspectRatioLabel(g.width, g.height)}`;
  }

  // A terse "W:H" label (e.g. "2:1", "1:2", "1.86:1") so the shipped
  // defaults' exact 2:1/1:2 requirement -- which depends on gapFrac and
  // marginFrac agreeing (gapFrac == 2*marginFrac, see the state comment
  // above and test/lens.test.js) -- stays visible the moment either slider
  // moves away from that relationship, instead of only showing up as a
  // slightly-off pixel count someone has to do the division on themselves.
  function aspectRatioLabel(w, h) {
    const trim = (n) => n.toFixed(2).replace(/\.?0+$/, '');
    return w >= h ? `${trim(w / h)}:1` : `1:${trim(h / w)}`;
  }

  // Task 11: horizon guide overlay -- a plain 2D canvas laid exactly over
  // #view, redrawn at the end of every render(). Positioned in CSS pixels
  // from #view's own bounding box (rather than assumed to fill #stage) so
  // it tracks whatever size/aspect the fit logic above just picked.
  function positionGuides() {
    const stageRect = stageEl.getBoundingClientRect();
    const viewRect = canvas.getBoundingClientRect();
    guidesCanvas.style.left = (viewRect.left - stageRect.left) + 'px';
    guidesCanvas.style.top = (viewRect.top - stageRect.top) + 'px';
    guidesCanvas.style.width = viewRect.width + 'px';
    guidesCanvas.style.height = viewRect.height + 'px';
    guidesCanvas.width = canvas.width;
    guidesCanvas.height = canvas.height;
  }

  // The guide line for one circle is a straight line through its centre at
  // that circle's own current roll -- correct because a horizon through the
  // optical axis projects to a straight line in a fisheye. draw.rollDeg
  // comes straight from GL.circleDraw, the same call renderComposition made
  // to pick this pass's uRoll, so the line can never drift from what
  // COMPOSITE_FS actually rendered. It can be drawn with cos/sin directly in
  // canvas coordinates (x right, y down) with no sign flip: COMPOSITE_FS's
  // theta is measured in a y-up frame, so screen-space clockwise there is
  // the same direction as increasing atan2(dy, dx) here, in y-down canvas
  // coordinates -- the two conventions are mirror images of each other in
  // exactly the way that cancels out.
  function drawGuides() {
    if (!ctx || !state.sourceLensSize) return;
    positionGuides();
    const g = guidesCanvas.getContext('2d');
    g.clearRect(0, 0, guidesCanvas.width, guidesCanvas.height);
    if (!showGuidesEl.checked) return;
    const layout = GL.compositionLayout(state, guidesCanvas.width, guidesCanvas.height);
    for (const circ of layout.circles) {
      const draw = GL.circleDraw(state, circ.lens);
      const rollRad = draw.rollDeg * Math.PI / 180;
      const dx = Math.cos(rollRad), dy = Math.sin(rollRad);

      g.strokeStyle = 'rgba(255,255,255,0.35)';
      g.lineWidth = 1;

      // Crop-edge circle (u = 1).
      g.beginPath();
      g.arc(circ.cx, circ.cy, circ.radius, 0, Math.PI * 2);
      g.stroke();

      // Thirds grid, axis-aligned (a compositional aid, not tied to roll).
      g.strokeStyle = 'rgba(255,255,255,0.15)';
      g.beginPath();
      for (let i = 1; i <= 2; i++) {
        const fx = circ.cx - circ.radius + (circ.radius * 2) * (i / 3);
        const fy = circ.cy - circ.radius + (circ.radius * 2) * (i / 3);
        g.moveTo(fx, circ.cy - circ.radius); g.lineTo(fx, circ.cy + circ.radius);
        g.moveTo(circ.cx - circ.radius, fy); g.lineTo(circ.cx + circ.radius, fy);
      }
      g.stroke();

      // Horizon line -- through the centre, at this circle's own roll.
      g.strokeStyle = 'rgba(255,80,80,0.85)';
      g.beginPath();
      g.moveTo(circ.cx - dx * circ.radius, circ.cy - dy * circ.radius);
      g.lineTo(circ.cx + dx * circ.radius, circ.cy + dy * circ.radius);
      g.stroke();
    }
  }

  showGuidesEl.addEventListener('input', () => drawGuides());

  // -- Drag-to-roll ----------------------------------------------------------
  // Converts a pointer event's client coordinates into #view's own canvas
  // pixel space (matching the targetW/targetH GL.compositionLayout was
  // called with), independent of which overlapping element (view or guides)
  // actually received the event.
  function pointerToCanvas(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / rect.width * canvas.width,
      y: (e.clientY - rect.top) / rect.height * canvas.height,
    };
  }

  let drag = null;

  stageEl.addEventListener('pointerdown', (e) => {
    if (!ctx || !state.sourceLensSize) return;
    const p = pointerToCanvas(e);
    const layout = GL.compositionLayout(state, canvas.width, canvas.height);
    let best = null, bestDist = Infinity;
    for (const c of layout.circles) {
      const d = Math.hypot(p.x - c.cx, p.y - c.cy);
      if (d < bestDist) { bestDist = d; best = c; }
    }
    if (!best || bestDist > best.radius * 1.15) return;
    // The sign flip belongs to the *physical* lens being grabbed, not the
    // slot label -- Settings.dragSign resolves that through GL.physicalLens,
    // exactly as circleDraw does, so a drag under `swap` doesn't reintroduce
    // the slot-vs-physical bug that circleDraw itself was created to
    // prevent. This is the one call site for that decision; it is not
    // re-derived here.
    const { sign } = Settings.dragSign(state, best.lens, GL.physicalLens);
    drag = {
      pointerId: e.pointerId,
      cx: best.cx, cy: best.cy,
      startAngleDeg: Math.atan2(p.y - best.cy, p.x - best.cx) * 180 / Math.PI,
      startRollDeg: state.rollDeg,
      sign,
    };
    e.target.setPointerCapture(e.pointerId);
  });

  stageEl.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const p = pointerToCanvas(e);
    const angleDeg = Math.atan2(p.y - drag.cy, p.x - drag.cx) * 180 / Math.PI;
    state.rollDeg = Settings.rollForDrag(drag.startRollDeg, drag.sign, angleDeg - drag.startAngleDeg);
    rollEl.value = state.rollDeg;
    rollOut.textContent = state.rollDeg.toFixed(1) + '°';
    render();
    scheduleSave();
  });

  function endDrag(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag = null;
  }
  stageEl.addEventListener('pointerup', endDrag);
  stageEl.addEventListener('pointercancel', endDrag);

  // -- Persistence -------------------------------------------------------
  // Every control listener below calls scheduleSave() alongside render() so
  // settings survive a reload; debounced so a dragged slider doesn't hit
  // localStorage on every input event.
  const SAVE_DEBOUNCE_MS = 250;
  let saveTimer = null;
  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => Settings.save(state, window.localStorage), SAVE_DEBOUNCE_MS);
  }

  function saveSettings() { Settings.save(state, window.localStorage); }

  // Merges any stored settings over the current (default) state in place,
  // then reflects the result in every control. Falls back silently to the
  // defaults already on `state` if nothing usable is stored -- see
  // settings.js for exactly what "usable" means.
  function loadSettings() {
    const loaded = Settings.load(state, window.localStorage);
    Object.assign(state, loaded);
    syncControlsFromState();
  }

  // Reflects `state` (whatever loadSettings just merged in, or the built-in
  // defaults if there was nothing to load) into every control's value and
  // its adjacent <output>. Mirrors applyEdgePreset's per-key loop below but
  // covers every slider, not just the edge ones.
  function syncControlsFromState() {
    fovEl.value = state.fovDeg;
    fovOut.textContent = state.fovDeg.toFixed(1) + '°';
    sensorsEl.value = state.sensors;
    orientationEl.value = state.orientation;
    swapEl.checked = state.swap;
    gapEl.value = state.gapFrac * 100;
    gapOut.textContent = (state.gapFrac * 100).toFixed(1).replace(/\.0$/, '') + '%';
    marginEl.value = state.marginFrac * 100;
    marginOut.textContent = (state.marginFrac * 100).toFixed(1).replace(/\.0$/, '') + '%';
    rollEl.value = state.rollDeg;
    rollOut.textContent = state.rollDeg.toFixed(1) + '°';
    nudgeAEl.value = state.nudgeDeg.A;
    nudgeAOut.textContent = state.nudgeDeg.A.toFixed(1) + '°';
    nudgeBEl.value = state.nudgeDeg.B;
    nudgeBOut.textContent = state.nudgeDeg.B.toFixed(1) + '°';
    for (const k of EDGE_KEYS) {
      document.getElementById(k).value = state.edge[k];
      document.getElementById(k + 'Out').textContent = state.edge[k];
    }
    for (const k of Object.keys(TONE_UNITS)) {
      document.getElementById(k).value = state.tone[k];
      document.getElementById(k + 'Out').textContent = state.tone[k].toFixed(2) + TONE_UNITS[k];
    }
  }

  fovEl.addEventListener('input', () => {
    state.fovDeg = parseFloat(fovEl.value);
    fovOut.textContent = state.fovDeg.toFixed(1) + '°';
    render();
    scheduleSave();
  });

  sensorsEl.addEventListener('input', () => {
    state.sensors = sensorsEl.value;
    render();
    scheduleSave();
  });

  orientationEl.addEventListener('input', () => {
    state.orientation = orientationEl.value;
    render();
    scheduleSave();
  });

  swapEl.addEventListener('input', () => {
    state.swap = swapEl.checked;
    render();
    scheduleSave();
  });

  gapEl.addEventListener('input', () => {
    state.gapFrac = parseFloat(gapEl.value) / 100;
    gapOut.textContent = gapEl.value + '%';
    render();
    scheduleSave();
  });

  marginEl.addEventListener('input', () => {
    state.marginFrac = parseFloat(marginEl.value) / 100;
    marginOut.textContent = marginEl.value + '%';
    render();
    scheduleSave();
  });

  rollEl.addEventListener('input', () => {
    state.rollDeg = parseFloat(rollEl.value);
    rollOut.textContent = state.rollDeg.toFixed(1) + '°';
    render();
    scheduleSave();
  });

  nudgeAEl.addEventListener('input', () => {
    state.nudgeDeg.A = parseFloat(nudgeAEl.value);
    nudgeAOut.textContent = state.nudgeDeg.A.toFixed(1) + '°';
    render();
    scheduleSave();
  });

  nudgeBEl.addEventListener('input', () => {
    state.nudgeDeg.B = parseFloat(nudgeBEl.value);
    nudgeBOut.textContent = state.nudgeDeg.B.toFixed(1) + '°';
    render();
    scheduleSave();
  });

  const EDGE_KEYS = ['edgeIntensity', 'ringWidth', 'dispersion', 'glowSpreadDeg',
                     'highlightKnee', 'falloffStart', 'falloffSoftness'];

  function applyEdgePreset() {
    state.edge = Object.assign({}, Edge.PRESETS.x1classic);
    for (const k of EDGE_KEYS) {
      document.getElementById(k).value = state.edge[k];
      document.getElementById(k + 'Out').textContent = state.edge[k];
    }
    render();
    scheduleSave();
  }

  for (const k of EDGE_KEYS) {
    document.getElementById(k).addEventListener('input', (e) => {
      state.edge[k] = parseFloat(e.target.value);
      document.getElementById(k + 'Out').textContent = e.target.value;
      render();
      scheduleSave();
    });
  }
  document.getElementById('resetEdge').addEventListener('click', applyEdgePreset);

  // Task 10: exposure, contrast, saturation -- three global tone sliders,
  // wired the same generic way as EDGE_KEYS above.
  const TONE_UNITS = { exposureEv: ' EV', contrast: '', saturation: '' };

  for (const k of Object.keys(TONE_UNITS)) {
    document.getElementById(k).addEventListener('input', (e) => {
      state.tone[k] = parseFloat(e.target.value);
      document.getElementById(k + 'Out').textContent = state.tone[k].toFixed(2) + TONE_UNITS[k];
      render();
      scheduleSave();
    });
  }

  formatEl.addEventListener('input', () => {
    state.format = formatEl.value;
  });

  qualityEl.addEventListener('input', () => {
    state.quality = parseFloat(qualityEl.value);
    qualityOut.textContent = qualityEl.value;
  });

  padToSensorSquareEl.addEventListener('input', () => {
    state.padToSensorSquare = padToSensorSquareEl.checked;
    updateExportSize();
  });

  // Rows read back from the export target per readPixels/putImageData call
  // (see GL.readCompositionStrips). Chosen so one strip's buffer stays a
  // small fraction of the full image even at the widest layout this tool
  // produces (two lenses side by side, ~11900px wide): 256 rows there is
  // 11900*256*4 =~ 12.2MB, versus ~283MB for the whole two-lens frame in one
  // shot. Also keeps the call count reasonable -- about 23 strips for one
  // 5952px-tall lens, not 5952 single-row calls.
  const EXPORT_STRIP_ROWS = 256;

  // The single render entry point (GL.renderComposition) used by both the
  // on-screen preview and this export -- export just points it at an
  // offscreen framebuffer instead of the canvas, so the preview is never
  // touched (no resize, no restore) and the export is never subject to
  // whatever drawing-buffer allocation limit the visible canvas has (this
  // GPU/browser clamps that well below MAX_TEXTURE_SIZE; an offscreen FBO
  // is not -- see the task report for how that was found and confirmed).
  async function exportImage(opts) {
    state.format = opts.format;
    state.quality = opts.quality;
    state.padToSensorSquare = opts.padToSensorSquare;
    const g = GL.exportGeometry(state);
    const gl = ctx.gl;
    let target = null;
    try {
      const limit = Math.min(ctx.maxTextureSize, ctx.maxRenderbufferSize);
      if (g.width > limit || g.height > limit) {
        fail(`This GPU caps render targets at ${limit}px; the requested export ` +
          `(${g.width}x${g.height}) exceeds it. Try a smaller FOV, remove padding, ` +
          'or export one lens at a time.');
        return;
      }
      target = GL.makeExportTarget(gl, g.width, g.height);
      if (!target.complete) {
        fail(`This GPU could not allocate a ${g.width}x${g.height} render target ` +
          `(framebuffer status ${target.status}). Try a smaller FOV, remove padding, ` +
          'or export one lens at a time.');
        return;
      }
      GL.renderComposition(ctx, state, g.width, g.height, target.fbo);

      const outCanvas = document.createElement('canvas');
      outCanvas.width = g.width;
      outCanvas.height = g.height;
      // A 2D canvas has its own (browser-specific, but generous) area
      // limit, distinct from the WebGL drawing-buffer clamp this replaces;
      // if it silently shrank the request the same way, that would show up
      // here exactly as it did on the WebGL canvas.
      if (outCanvas.width !== g.width || outCanvas.height !== g.height) {
        fail(`This browser's 2D canvas cannot hold a ${g.width}x${g.height} image ` +
          `(it gave ${outCanvas.width}x${outCanvas.height} instead). Try a smaller FOV, ` +
          'remove padding, or export one lens at a time.');
        return;
      }
      const c2d = outCanvas.getContext('2d');
      GL.readCompositionStrips(gl, target.fbo, g.width, g.height, EXPORT_STRIP_ROWS,
        (rowsRGBA, outY, rows) => {
          const clamped = new Uint8ClampedArray(rowsRGBA.buffer, rowsRGBA.byteOffset, rowsRGBA.length);
          c2d.putImageData(new ImageData(clamped, g.width, rows), 0, outY);
        });

      const blob = await new Promise((resolve, reject) => {
        outCanvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error('TOBLOB_FAILED'))),
          opts.format === 'png' ? 'image/png' : 'image/jpeg',
          opts.quality / 100
        );
      });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const out = opts.format === 'jpeg' ? Exif.reattach(bytes, state.sourceExif) : bytes;
      const label = state.sensors === 'both' ? (state.swap ? 'BA' : 'AB') : state.sensors;
      download(new Blob([out], { type: blob.type }),
        Lens.exportFilename(state.sourceName, label, state.fovDeg,
          opts.format === 'png' ? 'png' : 'jpg'));
    } catch (e) {
      fail(e.message === 'TOBLOB_FAILED'
        ? `The browser could not encode a ${g.width}x${g.height} image. ` +
          'Try PNG, a smaller FOV, or exporting one lens at a time.'
        : 'Export failed: ' + e.message);
    } finally {
      if (target) GL.deleteExportTarget(gl, target);
    }
  }

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  exportBtn.addEventListener('click', () => {
    if (!ctx || !state.sourceLensSize) return;
    exportImage({ format: state.format, quality: state.quality, padToSensorSquare: state.padToSensorSquare });
  });

  loadSettings();

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
  async function checkParity(fixtureUrl) {
    if (!ctx) ctx = GL.create(canvas);
    const gl = ctx.gl;
    const res = await fetch(fixtureUrl || 'test/fixtures/parity-input.json');
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
    gl.uniform1f(uu('uMaxRadiusBins'), Edge.MAX_BLUR_RADIUS_BINS);
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

  window.App = {
    loadFile, state, render, rollFor: Lens.rollFor, checkParity,
    saveSettings, loadSettings, exportImage,
  };
})();
