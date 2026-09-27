(function () {
  'use strict';

  const canvas = document.getElementById('view');
  const guidesCanvas = document.getElementById('guides');
  const stageEl = document.getElementById('stage');
  const showGuidesEl = document.getElementById('showGuides');
  const dropEl = document.getElementById('drop');
  const fileEl = document.getElementById('file');
  const calibrationEl = document.getElementById('calibration');
  const sensorsEl = document.getElementById('sensors');
  const orientationEl = document.getElementById('orientation');
  const swapEl = document.getElementById('swap');
  const readout = document.getElementById('readout');
  const errorEl = document.getElementById('error');
  const formatEl = document.getElementById('format');
  const qualityEl = document.getElementById('quality');
  const padToSensorSquareEl = document.getElementById('padToSensorSquare');
  const exportSizeEl = document.getElementById('exportSize');
  const exportDimsEl = document.getElementById('exportDims');
  const exportNoteEl = document.getElementById('exportNote');
  const fileNameEl = document.getElementById('fileName');
  const fileMetaEl = document.getElementById('fileMeta');
  const exportBtn = document.getElementById('export');
  const whiteBalanceGroupEl = document.getElementById('whiteBalanceGroup');
  const swapHintEl = document.getElementById('swapHint');
  const kelvinAEl = document.getElementById('kelvinA');
  const kelvinAOutEl = document.getElementById('kelvinAOut');
  const tintAEl = document.getElementById('tintA');
  const tintAOutEl = document.getElementById('tintAOut');
  const kelvinBEl = document.getElementById('kelvinB');
  const kelvinBOutEl = document.getElementById('kelvinBOut');
  const tintBEl = document.getElementById('tintB');
  const tintBOutEl = document.getElementById('tintBOut');
  const wbLinkEl = document.getElementById('wbLink');
  const wbResetEl = document.getElementById('wbReset');
  const openBtnEl = document.getElementById('openFile');
  const warningEl = document.getElementById('warning');

  const state = {
    fovDeg: 180, thetaMaxDeg: Lens.THETA_MAX_DEG,
    // Describes the currently loaded file's camera, not a user preference --
    // like sourceName/sourceLensSize, deliberately not persisted (see
    // settings.js PERSISTED_KEYS). Null until a file has been loaded.
    calibration: null,
    // True only when calibration.thetaMaxDeg came from Lens.calibrationFor's
    // layout-shape guess (no EXIF model at all, on a stacked file) rather
    // than from a recognized model tag -- lets the UI say plainly that the
    // camera was never identified and the number is inferred from the
    // file's shape, not read off the file.
    calibrationGuessedFromShape: false,
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
    // How many lenses the currently loaded file actually has (1 or 0 before
    // any file is loaded, 2 for a dual source). Not persisted -- like
    // sourceName/sourceLensSize, this describes the loaded file, not a
    // preference. Drives constraining `sensors` to 'A' and disabling the
    // Lens B / Both options for a single-lens file (see
    // updateSensorsAvailability) -- the fix for the Critical finding that a
    // 1:1 file inherited the previous file's lens B when Sensors was left on
    // Both/B.
    lensCount: 0,
    edge: { ...Edge.PRESETS.x1classic },
    tone: { exposureEv: 0, contrast: 0, saturation: 0 },
    // Task 12 output options. Not part of Settings.PERSISTED_KEYS -- these
    // describe how to write the next file, not a framing preference worth
    // resurrecting across a reload the way fovDeg/edge/tone are.
    padToSensorSquare: false,
    format: 'jpeg',
    quality: 95,
    // -- Raw (DNG) source state (Task 16) -----------------------------
    // True only while the currently loaded file is an uncompressed DNG.
    // Drives which shader program renderComposition/buildProfile pick
    // (GL.js) and whether the White balance panel is shown at all.
    isRaw: false,
    // The loaded raw file's own fixed calibration -- describes the file,
    // like calibration/sourceName above, so deliberately not persisted.
    // {cfaPattern, blackLevel, whiteLevel, camToSrgb} or null.
    rawMeta: null,
    // A fixed sensor-orientation correction, not a user preference: the ONE
    // X's raw frame is stored 90 degrees off from how the camera's own JPEG
    // pipeline presents it (its DNG Orientation tag says "normal" -- it
    // does not record this), so raw sources need a base rotation JPEG/.insp
    // sources don't. Composed into the roll GL.circleDraw hands the shader,
    // on top of (never instead of) rollDeg -- see that function's own
    // comment for why this can't just be a different rollDeg default. Like
    // calibration/isRaw, this describes the loaded file, not a preference,
    // so it is deliberately not persisted; every load path sets it
    // explicitly (90 for raw, 0 otherwise).
    sensorRotationDeg: 0,
    // The file's own AsShotNeutral, kept aside (untouched by the sliders)
    // so "Reset to as-shot" always has something to return to even after
    // both lenses have been pulled apart. Not persisted, describes the file.
    rawAsShotNeutral: null,
    // Task 17: per-lens white balance as classic Kelvin + tint (replacing
    // Task 16's raw red/blue multipliers) -- keyed by *physical* lens (A/B),
    // exactly like nudgeDeg above. Persisted through Settings
    // (PERSISTED_KEYS/RANGES in settings.js) exactly like every other
    // numeric control, but a freshly loaded raw file's own AsShotNeutral
    // (converted through Wb.kelvinTintFromNeutral) always overwrites it on
    // load (applyLoadedDescriptor), the same precedence Task 15 established
    // for thetaMaxDeg, so a stored value only ever surfaces before any file
    // (or a non-raw file) is loaded.
    rawWb: { A: { kelvin: 6500, tint: 0 }, B: { kelvin: 6500, tint: 0 } },
    // The camera-space neutral triple (green = 1) the shader's uWhiteBalance
    // uniform actually consumes (see gl.js setRawUniforms) -- derived from
    // rawWb + rawMeta.colorMatrix1 via Wb.neutralFromKelvinTint every time
    // either changes (recomputeRawWhiteBalance, below). Deliberately not
    // persisted and not user-editable directly: it is pure derived state,
    // kept in this shape only so gl.js's existing per-physical-lens lookup
    // (state.rawWhiteBalance[physicalLens]) needs no change at all -- this
    // task changes how the neutral is produced, never the shader path that
    // consumes it.
    rawWhiteBalance: { A: [1, 1, 1], B: [1, 1, 1] },
    // Whether moving one lens's white-balance sliders moves both. A plain
    // user preference, persisted the same way, with no file ever overriding
    // it (unlike rawWb itself).
    rawWbLinked: true,
    // Task 18: which collapsible panel sections are open. A plain UI
    // preference, persisted and validated through Settings like the rest.
    panels: { ...Settings.DEFAULT_PANELS },
  };
  let ctx = null;

  // Errors and warnings are deliberately separate channels: `fail` used to
  // double as both (app.js:332's non-fatal downscale notice went through
  // the same #error element as a real failure), so a red error from an
  // earlier problem could persist across a fully successful later
  // operation, and a successful export never cleared a stale one either.
  function fail(msg) { errorEl.textContent = msg; warningEl.textContent = ''; }
  function warn(msg) { warningEl.textContent = msg; errorEl.textContent = ''; }
  function clearMessages() { errorEl.textContent = ''; warningEl.textContent = ''; }

  // Shows the camera and calibration the current file loaded with, right by
  // the FOV readout. A provisional calibration (confident: false) must never
  // read as measured fact -- see Lens.CALIBRATIONS' comment for why the ONE
  // X figure is a single-file estimate. The advanced thetaMax slider stays
  // visible regardless, so a provisional number can always be corrected by
  // eye.
  function updateCalibrationReadout() {
    const c = state.calibration;
    if (!c) { calibrationEl.textContent = ''; return; }
    const fullFov = c.thetaMaxDeg * 2;
    if (c.confident) {
      calibrationEl.textContent = `${c.model} — ${fullFov.toFixed(1)}° lens (measured calibration).`;
    } else if (c.model) {
      calibrationEl.textContent =
        `${c.model} — ${fullFov.toFixed(1)}° lens ` +
        '(provisional calibration; adjust the slider below if the 180° crop looks wrong).';
    } else if (state.calibrationGuessedFromShape) {
      calibrationEl.textContent =
        `Camera not identified — guessing a ${fullFov.toFixed(1)}° lens from the stacked 1:2 ` +
        'layout (this shape is never written by the X5; adjust the slider below if the 180° ' +
        'crop looks wrong).';
    } else {
      calibrationEl.textContent =
        `Unknown camera — using the default ${fullFov.toFixed(1)}° lens ` +
        '(provisional calibration; adjust the slider below if the 180° crop looks wrong).';
    }
  }

  // Shows/hides the White balance panel -- it only makes sense for a raw
  // source, since a JPEG/.insp file has already been demosaiced and white
  // balanced by the camera. #whiteBalanceGroup is the whole collapsible
  // section (its <summary> is #whiteBalanceHeading), so one toggle covers
  // both; whether it is expanded is state.panels.whiteBalance's business.
  function updateWbVisibility() {
    whiteBalanceGroupEl.classList.toggle('hidden', !state.isRaw);
  }

  // Header bar (Task 18): the loaded file's name plus a terse description
  // of what it is. Presentation only -- reads state, never writes it.
  function updateFileHeader() {
    const has = !!state.sourceName;
    fileNameEl.textContent = has ? state.sourceName : 'No file open';
    fileNameEl.classList.toggle('empty', !has);
    fileNameEl.title = has ? state.sourceName : '';
    if (!has) { fileMetaEl.textContent = ''; return; }
    const parts = [];
    if (state.calibration && state.calibration.model) parts.push(state.calibration.model);
    parts.push(state.isRaw ? 'raw DNG' : (/\.insp$/i.test(state.sourceName) ? '.insp' : 'JPEG'));
    parts.push(state.lensCount === 1 ? 'single lens' : 'dual lens');
    if (state.sourceLensSize) parts.push(state.sourceLensSize + ' px/lens');
    fileMetaEl.textContent = parts.join(' · ');
  }

  // Recomputes the derived camera-space neutral triples (state.rawWhiteBalance,
  // green = 1) that gl.js's setRawUniforms actually reads, from the
  // user-facing state.rawWb (Kelvin/tint) plus this file's own
  // rawMeta.colorMatrix1. Must run after every change to rawWb -- render()
  // alone would otherwise keep drawing with a stale neutral. Falls back to
  // an identity-ish (1,1,1) neutral when there's no raw file loaded yet
  // (colorMatrix1 null); Wb.neutralFromKelvinTint itself already treats a
  // missing matrix as identity, so this is purely defensive.
  function recomputeRawWhiteBalance() {
    const m = state.rawMeta && state.rawMeta.colorMatrix1;
    state.rawWhiteBalance = {
      A: Wb.neutralFromKelvinTint(state.rawWb.A.kelvin, state.rawWb.A.tint, m),
      B: Wb.neutralFromKelvinTint(state.rawWb.B.kelvin, state.rawWb.B.tint, m),
    };
  }

  // Reflects state.rawWb into the Kelvin/tint sliders and their editable
  // numeric readouts, and recomputes the derived neutral triple gl.js
  // consumes. state.rawWb is always a concrete {A,B} object (see its
  // default above), never null, so this needs no guard -- it runs
  // harmlessly even while the panel is hidden (no raw source loaded).
  function syncWbControls() {
    kelvinAEl.value = Wb.kelvinToSlider(state.rawWb.A.kelvin);
    kelvinAOutEl.value = Math.round(state.rawWb.A.kelvin);
    tintAEl.value = Wb.tintToSlider(state.rawWb.A.tint);
    tintAOutEl.value = Math.round(state.rawWb.A.tint);
    kelvinBEl.value = Wb.kelvinToSlider(state.rawWb.B.kelvin);
    kelvinBOutEl.value = Math.round(state.rawWb.B.kelvin);
    tintBEl.value = Wb.tintToSlider(state.rawWb.B.tint);
    tintBOutEl.value = Math.round(state.rawWb.B.tint);
    wbLinkEl.checked = state.rawWbLinked;
    recomputeRawWhiteBalance();
  }

  // Shows/hides (and value-restricts) the Sensors control to match the
  // currently loaded file's lens count -- a 1:1 file has no lens B to show,
  // so 'B' and 'both' are disabled rather than left selectable with nothing
  // behind them. Part of the Critical fix: state.sensors is forced to 'A'
  // for a single-lens file at commit time (see applyLoadedDescriptor), and
  // this keeps the control itself from immediately offering to undo that.
  function updateSensorsAvailability() {
    const single = state.lensCount === 1;
    for (const opt of sensorsEl.options) {
      opt.disabled = single && opt.value !== 'A';
    }
  }

  // Swap + single-lens fix (final review residual): a 1:1 file has no lens
  // B to swap in, so `swap` is forced off (see applyLoadedDescriptor) and
  // the checkbox itself disabled here -- re-enabled the moment a dual file
  // loads. Without this, a 1:1 file loaded with `swap` left on from a
  // previous dual file rendered no circle and exported a blank `_B_` image,
  // because `sensors` was forced to 'A' but `swap` still pointed
  // lensTextureIndex at the released slot 1 (GL.physicalLens/circleDraw).
  function updateSwapAvailability() {
    const single = state.lensCount === 1;
    swapEl.disabled = single;
    swapHintEl.classList.toggle('hidden', !single);
  }

  // Maps a thrown Error to the text shown in #error. `e.formatted` (set by
  // source.js) marks a message that is already a complete, human-readable
  // sentence -- a known rejection reason, not a raw JS exception -- so it is
  // shown verbatim instead of getting the generic "Could not read..." prefix.
  function describeLoadError(e) {
    if (e.message === 'WEBGL2_UNAVAILABLE') return 'This browser has no WebGL2 support.';
    if (e.message === 'FLOAT_FBO_UNAVAILABLE') {
      return 'This GPU/browser lacks floating-point render targets ' +
        '(EXT_color_buffer_float), needed for the rim glow.';
    }
    return e.formatted ? e.message : 'Could not read that file: ' + e.message;
  }

  // Commits a fully-decoded Source descriptor into `state` in one
  // assignment, plus whatever DOM reflection every previous load path did
  // piecemeal. Called only after every one of the descriptor's lenses has
  // already been uploaded to the GPU and GL.commitLenses has run -- by the
  // time this runs, the load can no longer fail, so state is never observed
  // half-updated between two files (the Critical finding, and Important #2:
  // a throw partway through a load used to leave textures from two
  // different files, or a texture uploaded under the wrong shader's
  // assumptions, mixed together).
  function applyLoadedDescriptor(descriptor) {
    const patch = {
      calibration: descriptor.calibration,
      calibrationGuessedFromShape: descriptor.calibrationGuessedFromShape,
      thetaMaxDeg: descriptor.thetaMaxDeg,
      isRaw: descriptor.isRaw,
      rawMeta: descriptor.rawMeta,
      rawAsShotNeutral: descriptor.rawAsShotNeutral,
      // Only the sensor-rotation *correction* is ever forced by a load, not
      // rawWhiteBalance itself for a non-raw file -- rawWhiteBalance is a
      // persisted user setting (see its state comment above), not per-file
      // data, and a JPEG/.insp source has no AsShotNeutral of its own to
      // overwrite it with. It simply sits unused while the White balance
      // panel is hidden. A raw file's own AsShotNeutral (below) is the one
      // exception, exactly as before.
      sensorRotationDeg: descriptor.sensorRotationDeg,
      sourceName: descriptor.sourceName,
      sourceExif: descriptor.sourceExif,
      sourceLensSize: descriptor.lensSize,
      uploadedLensSize: descriptor.uploadedLensSize,
      lensCount: descriptor.lensCount,
    };
    if (descriptor.isRaw) patch.rawWb = descriptor.rawWb;
    // Constrain Sensors to the file's own lens count -- a 1:1 file has no
    // lens B, so a `sensors` of 'B' or 'both' left over from a previous
    // dual file must not silently keep pointing at a texture slot this file
    // never populated (see GL.releaseLens's own comment for the bug this
    // closes on the texture side).
    if (descriptor.lensCount === 1) patch.sensors = 'A';
    // Swap + single-lens fix: a 1:1 file has no lens B to swap in, so any
    // `swap` left on from a previous dual file must be forced off here --
    // see Settings.resolveSwapForLoad's own comment for the bug this
    // closes.
    patch.swap = Settings.resolveSwapForLoad(state.swap, descriptor.lensCount);
    if (descriptor.orientationDefault) patch.orientation = descriptor.orientationDefault;
    Object.assign(state, patch);
    zoom = null;   // zoom is per view, not per file: every load starts at Fit

    dropEl.classList.add('hidden');
    reflectNum(NUM.thetaMax, true);
    sensorsEl.value = state.sensors;
    orientationEl.value = state.orientation;
    swapEl.checked = state.swap;
    updateSensorsAvailability();
    updateSwapAvailability();
    updateCalibrationReadout();
    updateWbVisibility();
    syncWbControls();
    updateFileHeader();
    exportBtn.disabled = false;
    document.body.classList.add('loaded');
    render();
    scheduleSave();
  }

  // The single load entry point for every source kind (.insp/.jpg/.dng).
  // Decoding/validation (Source.decode) and GPU upload both happen into
  // local variables only -- ctx.textures and state are touched nowhere
  // before the final GL.commitLenses + applyLoadedDescriptor pair, so a
  // throw at any point before that leaves whatever was loaded previously
  // (if anything) completely intact; a throw after would have nothing left
  // to fail on. See source.js's own top-of-file comment for the fuller
  // rationale.
  async function loadFile(file) {
    clearMessages();
    let builtTextures = null;
    try {
      const buf = await file.arrayBuffer();
      if (!ctx) ctx = GL.create(canvas);
      const descriptor = await Source.decode(file, buf, ctx.maxTextureSize);
      const gl = ctx.gl;
      builtTextures = [];
      try {
        if (descriptor.kind === 'dng') {
          for (const plane of descriptor.planes) {
            builtTextures.push(GL.makeBayerTexture(gl, plane, descriptor.lensSize, descriptor.lensSize));
          }
        } else {
          for (const bitmap of descriptor.bitmaps) {
            builtTextures.push(GL.makeLensTexture(gl, bitmap));
          }
        }
      } finally {
        if (descriptor.bitmaps) for (const b of descriptor.bitmaps) b.close();
      }
      if (descriptor.overLimit) {
        warn('This GPU caps textures at ' + ctx.maxTextureSize +
             ' px; the image is being downscaled from ' + descriptor.lensSize + ' px.');
      }
      // Nothing below this line can throw before ctx/state are consistent
      // again -- see this function's own top comment.
      GL.commitLenses(ctx, builtTextures);
      // Final review residual: clear the local reference the instant the
      // textures are live in ctx, so a throw from anything below (e.g.
      // applyLoadedDescriptor) hits the catch block's `if (builtTextures)`
      // guard as false and can never delete textures that GL.commitLenses
      // has already committed and this file now depends on.
      builtTextures = null;
      applyLoadedDescriptor(descriptor);
    } catch (e) {
      // A throw after some (but not all) textures were built -- e.g. the
      // second of two lenses failing to decode -- must not leak the ones
      // that did succeed, and must never reach GL.commitLenses (which would
      // otherwise commit an incomplete set).
      if (builtTextures) for (const b of builtTextures) ctx.gl.deleteTexture(b.tex);
      fail(describeLoadError(e));
    }
  }

  // -- Preview placement (Task 19) ---------------------------------------
  // The stage's drawable area in CSS and device pixels (inside #stage's
  // padding). Device pixels -- CSS times devicePixelRatio -- are what the
  // canvas's drawing buffer is sized in, so the preview is sharp on HiDPI.
  function stageMetrics() {
    const cs = getComputedStyle(stageEl);
    const padL = parseFloat(cs.paddingLeft) || 0, padR = parseFloat(cs.paddingRight) || 0;
    const padT = parseFloat(cs.paddingTop) || 0, padB = parseFloat(cs.paddingBottom) || 0;
    const dpr = window.devicePixelRatio || 1;
    const cssW = Math.max(1, stageEl.clientWidth - padL - padR);
    const cssH = Math.max(1, stageEl.clientHeight - padT - padB);
    return {
      padL, padT, dpr,
      availW: Math.max(1, Math.round(cssW * dpr)), availH: Math.max(1, Math.round(cssH * dpr)),
    };
  }

  // Preview zoom (Task 19): null means Fit (follows the stage size);
  // otherwise a View {scale, ox, oy} in stage device pixels, where scale 1
  // is 100% -- one device pixel per pixel of the export the Output settings
  // would write. Preview only: never persisted, never read by export, and
  // reset to Fit on every file load.
  let zoom = null;

  // Where the composition sits on the stage right now. Its size is
  // GL.exportGeometry's, the pixels an export would write, so the preview
  // has the output's true aspect ratio at any zoom. A zoomed view is
  // re-clamped here (and written back) so a resize can never leave it
  // off screen or past the zoom limits.
  function currentView(m, g) {
    if (!zoom) return View.fitView(m.availW, m.availH, g.width, g.height);
    const fit = View.fitScale(m.availW, m.availH, g.width, g.height);
    const scale = View.clampScale(zoom.scale, fit);
    zoom = View.clampPan(Object.assign({}, zoom, { scale }), m.availW, m.availH, g.width, g.height);
    return zoom;
  }

  // The composition's rect inside the canvas (device pixels), set by
  // render() and read by the guides overlay and drag-to-roll so all three
  // agree on where each circle is.
  let previewPlace = null;
  function previewLayout() {
    return GL.placedLayout(state, canvas.width, canvas.height, previewPlace);
  }

  function render() {
    if (!ctx || !state.sourceLensSize) return;
    const m = stageMetrics();
    const g = GL.exportGeometry(state);
    const r = View.visibleRect(currentView(m, g), m.availW, m.availH, g.width, g.height);
    // The canvas covers exactly the visible part of the composition, at one
    // buffer pixel per device pixel.
    canvas.width = Math.max(1, r.w);
    canvas.height = Math.max(1, r.h);
    canvas.style.left = (m.padL + r.x / m.dpr) + 'px';
    canvas.style.top = (m.padT + r.y / m.dpr) + 'px';
    canvas.style.width = (canvas.width / m.dpr) + 'px';
    canvas.style.height = (canvas.height / m.dpr) + 'px';
    previewPlace = r.place;
    GL.renderComposition(ctx, state, canvas.width, canvas.height, null, previewPlace);
    updateZoomControls(m, g);
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
    if (!state.sourceLensSize) {
      exportDimsEl.textContent = '—';
      exportNoteEl.textContent = 'No file loaded';
      exportSizeEl.title = '';
      return;
    }
    const g = GL.exportGeometry(state);
    const downscaled = state.uploadedLensSize && state.uploadedLensSize < state.sourceLensSize;
    const note = state.padToSensorSquare
      ? (downscaled ? 'upscaled to this GPU’s capped texture size' : 'upscaled to sensor square')
      : (downscaled ? 'native to this GPU’s capped texture size' : 'native, no invented resolution');
    const ratio = aspectRatioLabel(g.width, g.height);
    // Dimensions and ratio on the first line, beside the Export button; the
    // provenance note under it. The full sentence the old single-line
    // readout carried stays available as the tooltip.
    exportDimsEl.textContent = `${g.width} × ${g.height} px`;
    const ratioEl = document.createElement('span');
    ratioEl.className = 'ratio';
    ratioEl.textContent = ratio;
    exportDimsEl.appendChild(ratioEl);
    exportNoteEl.textContent = note;
    exportSizeEl.title = `Exports at ${g.width} × ${g.height} px (${note}) — ${ratio}`;
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
  // optical axis projects to a straight line in a fisheye.
  //
  // Deliberately does NOT use GL.circleDraw(...).rollDeg here (Task 16 fix
  // round, Finding: guide leaked the sensor term). circleDraw's rollDeg is
  // the *total* rotation actually applied to the pixels -- rollDeg + nudge
  // + the raw sensor-orientation correction (state.sensorRotationDeg) --
  // which is exactly right for rendering (COMPOSITE_FS's uRoll) but wrong
  // for this overlay: the guide represents the *user's own levelling*, and
  // a raw source's fixed 90 degree sensor correction is not something the
  // user did or should see reflected in the guide. At rollDeg=0 the image
  // is already sensor-corrected to upright by circleDraw, so the guide must
  // read exactly horizontal there regardless of source type -- using
  // Lens.rollFor(state, physical) directly (the same call circleDraw itself
  // makes, just without circleDraw's added sensor term) guarantees that.
  function drawGuides() {
    if (!ctx || !state.sourceLensSize) return;
    positionGuides();
    const g = guidesCanvas.getContext('2d');
    g.clearRect(0, 0, guidesCanvas.width, guidesCanvas.height);
    if (!showGuidesEl.checked) return;
    // Same layout render() drew with -- guidesCanvas has #view's own pixel
    // size (positionGuides), so it tracks fit, zoom and pan exactly.
    const layout = previewLayout();
    for (const circ of layout.circles) {
      const physical = GL.physicalLens(state, circ.lens);
      // Sign convention: COMPOSITE_FS's theta is measured in a y-up frame,
      // so screen-space clockwise there is the same direction as increasing
      // atan2(dy, dx) here, in y-down canvas coordinates -- the two
      // conventions are mirror images of each other in exactly the way that
      // cancels out, so this can be drawn with cos/sin directly, no sign
      // flip, exactly as when this used circleDraw's rollDeg.
      const rollRad = Lens.rollFor(state, physical) * Math.PI / 180;
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

  // -- Zoom and pan (Task 19) -------------------------------------------
  const zoomInEl = document.getElementById('zoomIn');
  const zoomOutEl = document.getElementById('zoomOut');
  const zoomFitEl = document.getElementById('zoomFit');
  const zoom100El = document.getElementById('zoom100');
  const zoomPctEl = document.getElementById('zoomPct');

  function zoomContext() {
    const m = stageMetrics();
    const g = GL.exportGeometry(state);
    return { m, g, fit: View.fitScale(m.availW, m.availH, g.width, g.height) };
  }

  // A client-space point as stage device pixels (the View's own space).
  function pointerToStage(e, m) {
    const rect = stageEl.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left - stageEl.clientLeft - m.padL) * m.dpr,
      y: (e.clientY - rect.top - stageEl.clientTop - m.padT) * m.dpr,
    };
  }

  function isZoomedIn() {
    if (!zoom || !ctx || !state.sourceLensSize) return false;
    return zoom.scale > zoomContext().fit * (1 + 1e-6);
  }

  // Zooms to `scale` keeping the stage point (px, py) -- the stage centre
  // if omitted -- fixed. Landing exactly on fit returns to Fit mode, so the
  // view follows stage resizes again.
  function setZoom(scale, px, py) {
    if (!ctx || !state.sourceLensSize) return;
    const { m, g, fit } = zoomContext();
    const s = View.clampScale(scale, fit);
    if (Math.abs(s - fit) <= fit * 1e-9) { zoom = null; render(); return; }
    const base = currentView(m, g);
    if (px === undefined) { px = m.availW / 2; py = m.availH / 2; }
    zoom = View.clampPan(View.zoomAbout(base, s, px, py), m.availW, m.availH, g.width, g.height);
    render();
  }

  function zoomToFit() { zoom = null; render(); }

  function stepZoomBy(dir) {
    if (!ctx || !state.sourceLensSize) return;
    const { m, g, fit } = zoomContext();
    setZoom(View.stepZoom(currentView(m, g).scale, dir, fit));
  }

  function updateZoomControls(m, g) {
    const scale = currentView(m, g).scale;
    const pct = scale * 100;
    zoomPctEl.textContent = (pct < 10 ? pct.toFixed(1) : String(Math.round(pct))) + '%';
    zoomFitEl.setAttribute('aria-pressed', String(!zoom));
    zoom100El.setAttribute('aria-pressed', String(!!zoom && Math.abs(scale - 1) < 1e-9));
    stageEl.classList.toggle('zoomed', isZoomedIn());
  }

  zoomInEl.addEventListener('click', () => stepZoomBy(1));
  zoomOutEl.addEventListener('click', () => stepZoomBy(-1));
  zoomFitEl.addEventListener('click', zoomToFit);
  zoom100El.addEventListener('click', () => setZoom(1));

  stageEl.addEventListener('wheel', (e) => {
    if (!ctx || !state.sourceLensSize) return;
    e.preventDefault();
    const { m, g, fit } = zoomContext();
    // deltaMode 1 is lines, 2 pages (some mice/browsers); normalise to px.
    const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 800 : e.deltaY;
    const p = pointerToStage(e, m);
    setZoom(View.wheelScale(currentView(m, g).scale, dy, fit), p.x, p.y);
  }, { passive: false });

  // Double-click toggles Fit and 100%, zooming in about the pointer.
  stageEl.addEventListener('dblclick', (e) => {
    if (!ctx || !state.sourceLensSize) return;
    if (zoom) { zoomToFit(); return; }
    const p = pointerToStage(e, stageMetrics());
    setZoom(1, p.x, p.y);
  });

  let drag = null;

  // At Fit, a plain drag on a circle rolls it, exactly as before. Zoomed
  // in, a plain drag pans and Shift-drag rolls.
  stageEl.addEventListener('pointerdown', (e) => {
    if (!ctx || !state.sourceLensSize) return;
    if (e.button !== 0) return;
    if (isZoomedIn() && !e.shiftKey) {
      drag = {
        kind: 'pan', pointerId: e.pointerId, x: e.clientX, y: e.clientY,
        ox: zoom.ox, oy: zoom.oy,
      };
      stageEl.classList.add('panning');
      e.target.setPointerCapture(e.pointerId);
      return;
    }
    const p = pointerToCanvas(e);
    const layout = previewLayout();
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
      kind: 'roll',
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
    if (drag.kind === 'pan') {
      const { m, g } = zoomContext();
      zoom = View.clampPan({
        scale: zoom.scale,
        ox: drag.ox + (e.clientX - drag.x) * m.dpr,
        oy: drag.oy + (e.clientY - drag.y) * m.dpr,
      }, m.availW, m.availH, g.width, g.height);
      render();
      return;
    }
    // A roll drag never moves the canvas (render() only re-places it when
    // the zoom or pan changes), so canvas coordinates stay valid throughout.
    const p = pointerToCanvas(e);
    const angleDeg = Math.atan2(p.y - drag.cy, p.x - drag.cx) * 180 / Math.PI;
    state.rollDeg = Settings.rollForDrag(drag.startRollDeg, drag.sign, angleDeg - drag.startAngleDeg);
    reflectNum(NUM.roll, true);
    render();
    scheduleSave();
  });

  function endDrag(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag = null;
    stageEl.classList.remove('panning');
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

  // -- Numeric controls: slider + editable readout (Task 18) ---------------
  // Every slider and the numeric readout beside it, driven from one table
  // instead of one hand-written listener pair per control. Each entry says
  // how to read and write its field of `state` (in state units), how the
  // readout displays it, and the Settings.RANGES entry a typed value is
  // clamped through. `scale` converts state units to the units shown in the
  // readout and used by the slider (percent for gap/margin); the Kelvin/tint
  // sliders are nonlinear, so they supply their own toSlider/fromSlider and
  // route every change through setWbField (which also handles A/B linking).
  // What a slider's `input` event did before this task is exactly what
  // commitNum does now: set the state field, update the readout, render(),
  // scheduleSave() -- or, for JPEG quality (not persisted, not rendered),
  // just set state.quality.
  const EDGE_KEYS = ['edgeIntensity', 'ringWidth', 'dispersion', 'glowSpreadDeg',
                     'highlightKnee', 'falloffStart', 'falloffSoftness'];
  const TONE_KEYS = ['exposureEv', 'contrast', 'saturation'];

  const fmtDeg = (v) => v.toFixed(1);
  const fmtPct = (v) => (v * 100).toFixed(1).replace(/\.0$/, '');

  const NUM = {};
  function defNum(id, def) {
    NUM[id] = Object.assign({
      id,
      slider: document.getElementById(id),
      out: document.getElementById(id + 'Out'),
      scale: 1,
      live: true,
    }, def);
  }

  defNum('fov', { get: () => state.fovDeg, set: (v) => { state.fovDeg = v; },
    range: Settings.RANGES.fovDeg, fmt: fmtDeg });
  defNum('thetaMax', { get: () => state.thetaMaxDeg, set: (v) => { state.thetaMaxDeg = v; },
    range: Settings.RANGES.thetaMaxDeg, fmt: fmtDeg });
  defNum('gap', { get: () => state.gapFrac, set: (v) => { state.gapFrac = v; },
    range: Settings.RANGES.gapFrac, scale: 100, fmt: fmtPct });
  defNum('margin', { get: () => state.marginFrac, set: (v) => { state.marginFrac = v; },
    range: Settings.RANGES.marginFrac, scale: 100, fmt: fmtPct });
  defNum('roll', { get: () => state.rollDeg, set: (v) => { state.rollDeg = v; },
    range: Settings.RANGES.rollDeg, fmt: fmtDeg });
  defNum('nudgeA', { get: () => state.nudgeDeg.A, set: (v) => { state.nudgeDeg.A = v; },
    range: Settings.RANGES.nudgeDeg.A, fmt: fmtDeg });
  defNum('nudgeB', { get: () => state.nudgeDeg.B, set: (v) => { state.nudgeDeg.B = v; },
    range: Settings.RANGES.nudgeDeg.B, fmt: fmtDeg });
  for (const k of EDGE_KEYS) {
    defNum(k, { get: () => state.edge[k], set: (v) => { state.edge[k] = v; },
      range: Settings.RANGES.edge[k], fmt: (v) => formatEdgeValue(k, v) });
  }
  for (const k of TONE_KEYS) {
    defNum(k, { get: () => state.tone[k], set: (v) => { state.tone[k] = v; },
      range: Settings.RANGES.tone[k], fmt: (v) => v.toFixed(2) });
  }
  for (const lens of ['A', 'B']) {
    defNum('kelvin' + lens, {
      get: () => state.rawWb[lens].kelvin,
      range: Settings.RANGES.rawWb[lens].kelvin,
      toSlider: Wb.kelvinToSlider, fromSlider: Wb.sliderToKelvin,
      fmt: (v) => String(Math.round(v)),
      apply: (v) => setWbField(lens, 'kelvin', v),
    });
    defNum('tint' + lens, {
      get: () => state.rawWb[lens].tint,
      range: Settings.RANGES.rawWb[lens].tint,
      toSlider: Wb.tintToSlider, fromSlider: Wb.sliderToTint,
      fmt: (v) => String(Math.round(v)),
      apply: (v) => setWbField(lens, 'tint', v),
    });
  }
  // JPEG quality is an output option, not a persisted/rendered setting, and
  // has no Settings.RANGES entry -- its own slider bounds are the range.
  defNum('quality', { get: () => state.quality, set: (v) => { state.quality = v; },
    range: [parseFloat(qualityEl.min), parseFloat(qualityEl.max)],
    fmt: (v) => String(Math.round(v)), live: false });

  function toSlider(d, v) { return d.toSlider ? d.toSlider(v) : v * d.scale; }
  function fromSlider(d, x) { return d.fromSlider ? d.fromSlider(x) : x / d.scale; }

  // Writes the state value into the slider and readout. Skips the readout
  // while someone is typing in it (unless forced), so a render-triggered
  // refresh can never overwrite a half-typed number.
  function reflectNum(d, force) {
    const v = d.get();
    d.slider.value = toSlider(d, v);
    if (force || document.activeElement !== d.out) d.out.value = d.fmt(v);
  }

  function commitNum(d, v) {
    if (d.apply) { d.apply(v); return; }
    d.set(v);
    reflectNum(d, true);
    if (d.live) { render(); scheduleSave(); }
  }

  // Applies what was typed into a readout: parsed and clamped through the
  // control's Settings.RANGES entry, or reverted if it is not a number.
  function commitReadout(d) {
    const v = Settings.parseReadout(d.out.value, d.range, d.scale);
    if (v === null) { reflectNum(d, true); return; }
    // Unchanged text (e.g. blur after Enter already applied it) is a no-op,
    // so it never triggers a redundant render.
    if (d.out.value === d.fmt(d.get())) return;
    commitNum(d, v);
    reflectNum(d, true);
  }

  // Keyboard fine-adjust (Settings.nudgeSliderValue): arrows move a
  // sensible fraction of the slider's span, Shift is coarse, Ctrl (or Alt)
  // is fine. Works from the slider itself or from its readout.
  function nudgeKey(d, e) {
    const s = d.slider;
    const x = Settings.nudgeSliderValue(parseFloat(s.value), parseFloat(s.min), parseFloat(s.max),
      parseFloat(s.step), e.key, { shift: e.shiftKey, fine: e.ctrlKey || e.metaKey || e.altKey });
    if (x === null) return false;
    e.preventDefault();
    s.value = x;
    commitNum(d, fromSlider(d, parseFloat(s.value)));
    return true;
  }

  for (const d of Object.values(NUM)) {
    d.slider.addEventListener('input', () => commitNum(d, fromSlider(d, parseFloat(d.slider.value))));
    d.slider.addEventListener('keydown', (e) => nudgeKey(d, e));
    // 'change' fires on blur (and on Enter in most browsers); Enter is also
    // handled explicitly below so it applies everywhere.
    d.out.addEventListener('change', () => commitReadout(d));
    d.out.addEventListener('blur', () => reflectNum(d, true));
    d.out.addEventListener('focus', () => d.out.select());
    d.out.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commitReadout(d); d.out.select(); }
      else if (e.key === 'Escape') { e.preventDefault(); reflectNum(d, true); d.out.blur(); }
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        commitReadout(d);
        if (nudgeKey(d, e)) { reflectNum(d, true); d.out.select(); }
      }
    });
  }

  // -- Collapsible panel sections (Task 18) -------------------------------
  // Open/closed state lives in state.panels, persisted through
  // Settings.PERSISTED_KEYS (validated per section as a boolean by
  // Settings.sanitize). The White balance section's visibility is separate
  // (updateWbVisibility, raw sources only); this only remembers whether it
  // is expanded when it is shown.
  const panelEls = Array.from(document.querySelectorAll('details[data-panel]'));
  function syncPanels() {
    for (const el of panelEls) el.open = !!state.panels[el.dataset.panel];
  }
  for (const el of panelEls) {
    el.addEventListener('toggle', () => {
      if (state.panels[el.dataset.panel] === el.open) return;
      state.panels[el.dataset.panel] = el.open;
      scheduleSave();
    });
  }

  // Reflects `state` (whatever loadSettings just merged in, or the built-in
  // defaults if there was nothing to load) into every control's value and
  // its adjacent readout.
  function syncControlsFromState() {
    sensorsEl.value = state.sensors;
    orientationEl.value = state.orientation;
    swapEl.checked = state.swap;
    for (const d of Object.values(NUM)) if (!d.apply) reflectNum(d, true);
    // syncWbControls is a hoisted function declaration -- reflects whatever
    // rawWb/rawWbLinked Settings.load just restored, even though the panel
    // itself stays hidden until a raw file is loaded.
    syncWbControls();
    syncPanels();
  }

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

  // -- White balance: Kelvin + tint (Task 17) -------------------------
  // Each control edits one field (kelvin or tint) of one physical lens's
  // {kelvin, tint} pair. When linked, editing either lens's control moves
  // both, since the motivating case (one lens in sun, the other in shade)
  // needs them independent only when the user deliberately pulls them
  // apart -- exactly Task 16's linking behaviour, just over a different
  // field shape. The sliders and typed readouts reach this through the NUM
  // table above (their `apply`).
  function setWbField(lens, field, value) {
    // Typed readouts can hold anything; keep values inside the slider
    // domain (Settings.RANGES.rawWb, identical to Wb.KELVIN_MIN/MAX and
    // Wb.TINT_MAX).
    if (!Number.isFinite(value)) { syncWbControls(); return; }
    const range = Settings.RANGES.rawWb[lens][field];
    value = Math.max(range[0], Math.min(range[1], value));
    state.rawWb[lens][field] = value;
    if (state.rawWbLinked) {
      const other = lens === 'A' ? 'B' : 'A';
      state.rawWb[other][field] = value;
    }
    syncWbControls();
    render();
    scheduleSave();
  }

  wbLinkEl.addEventListener('input', () => {
    state.rawWbLinked = wbLinkEl.checked;
    // Turning the link on snaps B to A immediately, rather than leaving
    // them apart until the next slider move -- "linked" should mean linked
    // the instant it's turned on.
    if (state.rawWbLinked) {
      state.rawWb.B = { ...state.rawWb.A };
    }
    syncWbControls();
    render();
    scheduleSave();
  });

  wbResetEl.addEventListener('click', () => {
    if (!state.rawAsShotNeutral) return;
    const m = state.rawMeta && state.rawMeta.colorMatrix1;
    const kt = Wb.kelvinTintFromNeutral(state.rawAsShotNeutral, m);
    state.rawWb = {
      A: { kelvin: kt.kelvin, tint: kt.tint },
      B: { kelvin: kt.kelvin, tint: kt.tint },
    };
    syncWbControls();
    render();
    scheduleSave();
  });

  // Formats an edge slider's value to its own <input step>'s decimal
  // precision instead of JS's default number-to-string, which printed raw
  // values like 0.93693 or 0.26024 next to a thumb whose step (0.005/0.01)
  // couldn't actually land there -- the readout and the slider silently
  // disagreed about what value was in effect. index.html's step attributes
  // for edgeIntensity/ringWidth/dispersion/falloffStart were tightened to
  // 0.00001 precisely so the fitted x1classic preset's five decimal digits
  // are representable at all; this keeps the printed text matching that
  // same precision.
  function formatEdgeValue(k, v) {
    return v.toFixed(Settings.decimalsForStep(document.getElementById(k).step));
  }

  function applyEdgePreset() {
    state.edge = Object.assign({}, Edge.PRESETS.x1classic);
    for (const k of EDGE_KEYS) reflectNum(NUM[k], true);
    render();
    scheduleSave();
  }
  document.getElementById('resetEdge').addEventListener('click', applyEdgePreset);

  function updateExportLabel() {
    exportBtn.textContent = state.format === 'png' ? 'Export PNG' : 'Export JPEG';
  }

  formatEl.addEventListener('input', () => {
    state.format = formatEl.value;
    updateExportLabel();
  });

  padToSensorSquareEl.addEventListener('input', () => {
    state.padToSensorSquare = padToSensorSquareEl.checked;
    // Changes the export's pixel size, which is what "100%" is measured
    // against, so the zoom readout (and a zoomed view) follow it.
    render();
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
    clearMessages();
    // Deliberately does not write opts back into `state`: this used to mean
    // a bare `App.exportImage({...})` call from outside the Export button's
    // own handler mutated persisted state as a side effect of just
    // rendering a file. `exportState` is a throwaway shallow copy carrying
    // this export's own format/quality/padToSensorSquare, used for every
    // geometry/render call below instead of `state` itself; the on-screen
    // controls (and their persisted values) are untouched.
    const exportState = Object.assign({}, state, {
      format: opts.format, quality: opts.quality, padToSensorSquare: opts.padToSensorSquare,
    });
    const g = GL.exportGeometry(exportState);
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
      // The 2D canvas's own (browser-specific, but generous) area limit is
      // distinct from the WebGL drawing-buffer clamp checked above; checked
      // here, *before* the full-resolution render below, so a browser that
      // would silently shrink the canvas is caught before spending time on
      // a render whose result can't be read back anyway.
      const outCanvas = document.createElement('canvas');
      outCanvas.width = g.width;
      outCanvas.height = g.height;
      if (outCanvas.width !== g.width || outCanvas.height !== g.height) {
        fail(`This browser's 2D canvas cannot hold a ${g.width}x${g.height} image ` +
          `(it gave ${outCanvas.width}x${outCanvas.height} instead). Try a smaller FOV, ` +
          'remove padding, or export one lens at a time.');
        return;
      }
      target = GL.makeExportTarget(gl, g.width, g.height);
      if (!target.complete) {
        fail(`This GPU could not allocate a ${g.width}x${g.height} render target ` +
          `(framebuffer status ${target.status}). Try a smaller FOV, remove padding, ` +
          'or export one lens at a time.');
        return;
      }
      GL.renderComposition(ctx, exportState, g.width, g.height, target.fbo);

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
      // PNG carries no EXIF -- Exif.reattach only applies to the JPEG
      // container, so a PNG export has no capture time or camera embedded
      // (see README's Output section).
      const out = opts.format === 'jpeg' ? Exif.reattach(bytes, state.sourceExif) : bytes;
      const label = GL.exportLabel(state);
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
  updateExportLabel();
  updateExportSize();
  updateFileHeader();

  dropEl.addEventListener('click', () => fileEl.click());
  // #drop is hidden the moment a file loads (both load paths), so it was
  // the *only* way to click for a file picker -- after the first load, drag
  // and drop still worked but there was no other affordance to open a
  // different file, contradicting README's "or click to choose one". This
  // button stays visible in the header bar regardless of whether a file is
  // loaded.
  openBtnEl.addEventListener('click', () => fileEl.click());
  fileEl.addEventListener('change', () => fileEl.files[0] && loadFile(fileEl.files[0]));
  document.addEventListener('dragover', (e) => { e.preventDefault(); });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
  });
  window.addEventListener('resize', render);
  // The stage can change size without the window doing so (the panel's
  // scrollbar appearing, devtools docking); coalesce to one render a frame.
  let resizeFrame = 0;
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => {
      if (resizeFrame) return;
      resizeFrame = requestAnimationFrame(() => { resizeFrame = 0; render(); });
    }).observe(stageEl);
  }

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
    setZoom, zoomToFit, getZoom: () => (zoom ? Object.assign({}, zoom) : null),
    saveSettings, loadSettings, exportImage,
  };
})();
