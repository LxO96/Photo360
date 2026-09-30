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
  const detailMemEl = document.getElementById('detailMem');
  const exportNoteEl = document.getElementById('exportNote');
  const fileNameEl = document.getElementById('fileName');
  const fileMetaEl = document.getElementById('fileMeta');
  const exportBtn = document.getElementById('export');
  const printBtn = document.getElementById('print');
  const printBoxEl = document.getElementById('printBox');
  const printPageEl = document.getElementById('printPage');
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
    // Task 19 adds the luminance-curve sliders (Edge.toneCurve), -100..100.
    tone: { exposureEv: 0, contrast: 0, saturation: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0, mono: false },
    // Sharpening and noise reduction (detail.js); all zero is off.
    detail: { ...Detail.DEFAULTS },
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
    // JPEG / .insp white balance (jpegwb.js), relative to the camera's
    // rendering; every JPEG load starts at 0 / 0 (as shot). Shares Link A
    // and B (rawWbLinked) with raw.
    jpegWb: { A: { temp: 0, tint: 0 }, B: { temp: 0, tint: 0 } },
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
    // Per-lens camera -> linear sRGB matrix built for that lens's neutral
    // (Dng.camToSrgbForNeutral); derived alongside rawWhiteBalance, never
    // persisted. Null until a raw file is loaded (gl.js then uses
    // rawMeta.camToSrgb).
    rawCamToSrgb: null,
    // Whether moving one lens's white-balance sliders moves both. A plain
    // user preference, persisted the same way, with no file ever overriding
    // it (unlike rawWb itself).
    rawWbLinked: true,
    // Task 18: which collapsible panel sections are open. A plain UI
    // preference, persisted and validated through Settings like the rest.
    panels: { ...Settings.DEFAULT_PANELS },
    // The scopes overlay: shown or not, which scope, and Luma or RGB for
    // the histogram and waveform. Plain preferences, persisted
    // (Settings.ENUMS for the two modes).
    scopesShown: true,
    scopeScale: 1,
    scopeMode: 'histogram',
    scopeChannels: 'luma',
    // Keyboard layout for the shortcuts (shortcuts.js LAYOUTS).
    keyLayout: 'standard',
    // The photo strip (several photos open) shown or collapsed.
    stripShown: true,
  };
  // The built-in defaults, snapshotted before stored settings are merged in:
  // what double-clicking a slider resets it to (see the NUM `path`s).
  const DEFAULTS = JSON.parse(JSON.stringify(state));
  let ctx = null;

  // Errors and warnings are deliberately separate channels: `fail` used to
  // double as both (app.js:332's non-fatal downscale notice went through
  // the same #error element as a real failure), so a red error from an
  // earlier problem could persist across a fully successful later
  // operation, and a successful export never cleared a stale one either.
  function fail(msg) { errorEl.textContent = msg; warningEl.textContent = ''; }
  function warn(msg) { warningEl.textContent = msg; errorEl.textContent = ''; }
  function clearMessages() { errorEl.textContent = ''; warningEl.textContent = ''; }

  // Task 19: the compact note under Field of view -- the camera, its full
  // FOV and where that number comes from ("X5 · 210° full · measured",
  // "ONE X · 190° full · user-reported"). theta-max itself is set only
  // from the camera model (Lens.calibrationFor) on load; there is no
  // control for it.
  // Lens.calibrationNote builds the text; a guessed or default calibration
  // says so in its source rather than reading as measured fact.
  function updateCalibrationReadout() {
    const c = state.calibration;
    calibrationEl.textContent = c ? Lens.calibrationNote(c, state.thetaMaxDeg) : '';
  }

  // Task 19: the Field of view slider runs from 120 to the lens's whole
  // image circle, 2 x the current theta-max (Lens.fovRangeFor). Loading a
  // file or restoring settings moves the max
  // and clamps the FOV into it; the typed readout clamps through the same
  // range. Settings.RANGES.fovDeg stays the superset used for persistence.
  function syncFovRange() {
    const d = NUM.fov;
    const r = Lens.fovRangeFor(state.thetaMaxDeg);
    d.range = r;
    d.slider.min = r[0];
    d.slider.max = r[1];
    state.fovDeg = Math.min(r[1], Math.max(r[0], state.fovDeg));
    reflectNum(d, true);
  }

  // Shows/hides the White balance panel -- it only makes sense for a raw
  // source, since a JPEG/.insp file has already been demosaiced and white
  // balanced by the camera. #whiteBalanceGroup is the whole collapsible
  // section (its <summary> is #whiteBalanceHeading), so one toggle covers
  // both; whether it is expanded is state.panels.whiteBalance's business.
  const wbTagEl = document.getElementById('wbTag');
  function updateWbVisibility() {
    whiteBalanceGroupEl.classList.toggle('hidden', !state.sourceLensSize);
    whiteBalanceGroupEl.dataset.mode = state.isRaw ? 'raw' : 'jpeg';
    wbTagEl.textContent = state.isRaw ? 'RAW' : 'JPEG';
    wbResetEl.textContent = state.isRaw ? 'Reset to as-shot' : 'Reset';
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
    state.rawCamToSrgb = m ? {
      A: Dng.camToSrgbForNeutral(m, state.rawWhiteBalance.A),
      B: Dng.camToSrgbForNeutral(m, state.rawWhiteBalance.B),
    } : null;
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
    for (const k of ['jwTempA', 'jwTintA', 'jwTempB', 'jwTintB']) if (NUM[k]) reflectNum(NUM[k], true);
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
  // `restore` (openPhoto): { edits, history } -- the photo's own edits and
  // undo history, when it has been opened or edited before.
  function applyLoadedDescriptor(descriptor, restore) {
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
    else patch.jpegWb = { A: { temp: 0, tint: 0 }, B: { temp: 0, tint: 0 } };
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
    // This photo's own edits, sanitized like stored settings, win over what
    // the file itself says (its as-shot white balance); the lens-count
    // guards above still apply to them.
    if (restore && restore.edits) {
      const clean = Settings.sanitize(state, Object.assign(Settings.serialize(state), restore.edits));
      for (const k of Object.keys(restore.edits)) if (k in clean) state[k] = JSON.parse(JSON.stringify(clean[k]));
      if (descriptor.lensCount === 1) state.sensors = 'A';
      state.swap = Settings.resolveSwapForLoad(state.swap, descriptor.lensCount);
      syncControlsFromState();
    }
    zoom = null;   // zoom is per view, not per file: every load starts at Fit

    dropEl.classList.add('hidden');
    syncFovRange();
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
    printBtn.disabled = false;
    updateExportLabel();
    document.body.classList.add('loaded');
    beforeView = false;
    stopMatch();
    render();
    // Saving the settings is not an edit of the photo (noteEdit).
    restoring = true;
    try { scheduleSave(); } finally { restoring = false; }
    // History is per photo: a photo opened before gets its own back.
    if (restore && restore.history) {
      editHistory = restore.history;
      if (historyTimer) { clearTimeout(historyTimer); historyTimer = null; }
      historyPending = false;
    } else {
      editHistory = History.create();
      resetHistory();
    }
  }

  // The single load entry point for every source kind (.insp/.jpg/.dng).
  // Decoding/validation (Source.decode) and GPU upload both happen into
  // local variables only -- ctx.textures and state are touched nowhere
  // before the final GL.commitLenses + applyLoadedDescriptor pair, so a
  // throw at any point before that leaves whatever was loaded previously
  // (if anything) completely intact; a throw after would have nothing left
  // to fail on. See source.js's own top-of-file comment for the fuller
  // rationale.
  function ensureCtx() {
    if (ctx) return;
    ctx = GL.create(canvas);
    // The CPU develop path (devplan.js) finishes a lens in the background.
    ctx.dev.onProgress = requestRender;
    ctx.dev.onError = (e) => fail('Noise reduction on the CPU failed: ' + e.message);
  }

  let renderFrame = 0;
  function requestRender() {
    if (renderFrame) return;
    renderFrame = requestAnimationFrame(() => { renderFrame = 0; render(); });
  }

  // Resolves true when this file is now the open one; false when it failed
  // (the error is shown) or a newer load started meanwhile (openPhoto
  // switching again before this one decoded) and it gave way.
  let loadSeq = 0;
  async function loadFile(file, restore) {
    const my = ++loadSeq;
    clearMessages();
    let builtTextures = null;
    try {
      // A merged HDR photo ({ members, name }, openPhoto) is merged from
      // its bracket's files (Source.decodeMerged); anything else is a file.
      const merged = !!file.members;
      const buf = merged ? null : await file.arrayBuffer();
      if (my !== loadSeq) return false;
      ensureCtx();
      const descriptor = merged
        ? await Source.decodeMerged(file.members, ctx.maxTextureSize, (i, n) => {
          if (my === loadSeq) stripNote('Merging ' + file.members.length + ' exposures… ' + Math.round(100 * i / n) + '%');
        })
        : await Source.decode(file, buf, ctx.maxTextureSize);
      if (merged) stripNote('');
      if (my !== loadSeq) {
        if (descriptor.bitmaps) for (const b of descriptor.bitmaps) b.close();
        return false;
      }
      const gl = ctx.gl;
      builtTextures = [];
      try {
        if (descriptor.kind === 'dng') {
          const meta = descriptor.rawMeta;
          for (const plane of descriptor.planes) {
            const built = GL.makeBayerTexture(gl, plane, descriptor.lensSize, descriptor.lensSize);
            builtTextures.push(built);
            // Kept for developing on the CPU (devcpu.js), if it comes to that.
            built.plane = plane;
            built.rawMeta = { cfa: meta.cfaPattern, black: meta.blackLevel, white: meta.whiteLevel };
            // The sensor's noise model, for noise reduction (noise.js).
            built.noise = Noise.fitProfile(plane, descriptor.lensSize, descriptor.lensSize,
              meta.cfaPattern, meta.blackLevel, meta.whiteLevel);
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
      // The photo on screen until now keeps what was done to it while this
      // one decoded (openPhoto).
      if (restore && restore.beforeCommit) restore.beforeCommit();
      // Nothing below this line can throw before ctx/state are consistent
      // again -- see this function's own top comment.
      GL.commitLenses(ctx, builtTextures);
      // Final review residual: clear the local reference the instant the
      // textures are live in ctx, so a throw from anything below (e.g.
      // applyLoadedDescriptor) hits the catch block's `if (builtTextures)`
      // guard as false and can never delete textures that GL.commitLenses
      // has already committed and this file now depends on.
      builtTextures = null;
      applyLoadedDescriptor(descriptor, restore);
      return true;
    } catch (e) {
      // A throw after some (but not all) textures were built -- e.g. the
      // second of two lenses failing to decode -- must not leak the ones
      // that did succeed, and must never reach GL.commitLenses (which would
      // otherwise commit an incomplete set).
      if (builtTextures) for (const b of builtTextures) ctx.gl.deleteTexture(b.tex);
      fail(describeLoadError(e));
      return false;
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

  let beforeView = false;
  const DEVELOP_FAILED = 'This GPU has too little memory left even to hold the result of noise ' +
    'reduction and sharpening at this image size. Set Detail to 0 to go on.';

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
    // Detail off: free the developed frames (GL.developLens) it held.
    if (!Detail.isActive(state.detail)) GL.releaseDeveloped(ctx);
    try {
      // Before / after (the \ key): the preview with Tone and Detail off.
      const shown = beforeView ? Object.assign({}, state, { tone: DEFAULTS.tone, detail: DEFAULTS.detail }) : state;
      GL.renderComposition(ctx, shown, canvas.width, canvas.height, null, previewPlace);
      if (errorEl.textContent === DEVELOP_FAILED) clearMessages();
    } catch (e) {
      if (e.message !== 'DEVELOP_TARGET_INCOMPLETE') throw e;
      GL.releaseDeveloped(ctx);
      fail(DEVELOP_FAILED);
    }
    updateDetailNote();
    sampleScopes();
    updateZoomControls(m, g);
    const c = Lens.coverage(state.fovDeg, state.thetaMaxDeg);
    readout.textContent = c.overlapDeg === 0
      ? 'Exactly one hemisphere — nothing duplicated with the other lens.'
      : c.overlapDeg > 0
        ? `${c.overlapDeg.toFixed(1)}° past the hemisphere — ` +
          `${(c.duplicatedAreaFraction * 100).toFixed(0)}% of this image also appears in the other lens.`
        : `${(-c.overlapDeg).toFixed(1)}° short of the hemisphere — a gap between the two lenses.`;
    drawGuides();
    drawMatch();
    updateLensControls();
    updateExportSize();
  }

  // Reports the exact pixel dimensions the next export will write, so the
  // native-sampling default (no invented resolution) is visible rather than
  // implied. Recomputed from GL.exportGeometry -- the same geometry
  // exportImage itself renders at -- so this text can never drift from what
  // actually gets written.
  // What Detail costs in graphics memory, and where it runs when that
  // memory ran out (GL.developInfo, devplan.js).
  function updateDetailNote() {
    const d = GL.developInfo(ctx, state);
    let text = '', warnIt = false;
    if (d && d.path === 'cpu') {
      warnIt = true;
      text = 'Not enough graphics memory: noise reduction and sharpening run on the CPU' +
        (d.workers > 1 ? ` (${d.workers} threads)` : '') + ', a few seconds per change.' +
        (d.pending ? ' Working…' : '');
    } else if (d) {
      const mem = DevPlan.formatBytes(d.bytes);
      warnIt = d.fellBack || d.bytes > DevPlan.FULL_BUDGET;
      text = d.path === 'full'
        ? `Uses about ${mem} of graphics memory.`
        : d.fellBack
          ? `Not enough graphics memory for the whole frame: working in tiles, about ${mem}.`
          : `Uses about ${mem} of graphics memory, working in tiles ` +
            `(the whole frame at once would take ${DevPlan.formatBytes(d.fullBytes)}).`;
      if (d.bytes > DevPlan.FULL_BUDGET) text += ' A GPU with little memory may not manage it.';
    }
    detailMemEl.textContent = text;
    detailMemEl.classList.toggle('warn', warnIt);
  }

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
    // Kept current here rather than set when printing: a print started
    // from the browser's menu picks the page size before `beforeprint`.
    printPageEl.textContent = `@page { size: ${Lens.printOrientation(g.width, g.height)}; margin: 0; }`;
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
  // -- Scopes (histogram / waveform / vectorscope) ------------------------
  // A floating box over the bottom-right of the stage. The scopes read the
  // rendered preview, so they show exactly what is on screen (white
  // balance, tone and edge included; only the visible part when zoomed).
  // The WebGL canvas keeps no drawing buffer between frames, so the sample
  // has to be taken right after renderComposition, in the same task --
  // hence sampleScopes() inside render(). The small sample is kept so
  // switching modes redraws without re-rendering.
  //
  // Only the photograph is counted: pixels outside the circles, and the
  // synthetic edge inside them (from the Edge falloff start outward, where
  // the terminator fades to black), are left out -- otherwise that black
  // piles up at 0% and skews every scope.
  const scopeBoxEl = document.getElementById('scopeBox');
  const scopeEl = document.getElementById('scope');
  const channelModesEl = document.getElementById('channelModes');
  const scopesToggleEl = document.getElementById('scopesToggle');
  const clipLowEl = document.getElementById('clipLow');
  const clipHighEl = document.getElementById('clipHigh');
  const scopeSample = document.createElement('canvas');
  const SCOPE_SAMPLE_MAX_PIXELS = 160000;
  let scopePixels = null;  // { px, w, h, include, n } from the last render

  function sampleScopes() {
    if (!state.scopesShown) { scopePixels = null; return; }
    const plotW = Math.max(60, Math.round(scopeEl.getBoundingClientRect().width * (window.devicePixelRatio || 1)));
    let w = Math.max(1, Math.min(canvas.width, plotW));
    let h = Math.max(1, Math.round(w * canvas.height / canvas.width));
    const k = Math.sqrt(SCOPE_SAMPLE_MAX_PIXELS / (w * h));
    if (k < 1) { w = Math.max(1, Math.floor(w * k)); h = Math.max(1, Math.floor(h * k)); }
    scopeSample.width = w;
    scopeSample.height = h;
    const g = scopeSample.getContext('2d', { willReadFrequently: true });
    g.drawImage(canvas, 0, 0, w, h);
    const sx = w / canvas.width, sy = h / canvas.height;
    const photo = state.edge.falloffStart;
    const include = Scopes.insideCircles(previewLayout().circles.map((c) => ({
      cx: c.cx * sx, cy: c.cy * sy, radius: c.radius * Math.min(sx, sy) * photo,
    })));
    let n = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (include(x, y)) n++;
    scopePixels = { px: g.getImageData(0, 0, w, h).data, w, h, include, n };
    drawScope();
  }

  function sizeScopeCanvas() {
    // The on-screen size, which includes the box's zoom (scopeScale), so the
    // plot is drawn at its real resolution instead of being stretched.
    const r = scopeEl.getBoundingClientRect();
    const dpr = (window.devicePixelRatio || 1) * (r.width / (scopeEl.clientWidth || r.width || 1));
    const w = Math.max(1, Math.round(r.width * (window.devicePixelRatio || 1)));
    const h = Math.max(1, Math.round(r.height * (window.devicePixelRatio || 1)));
    if (scopeEl.width !== w) scopeEl.width = w;
    if (scopeEl.height !== h) scopeEl.height = h;
    return { w, h, dpr };
  }

  // Paints count bins (cols x rows) into an offscreen canvas, each channel
  // in its own colour and added together, for drawImage to scale.
  // `flipRows` puts bin row 0 (level 0, black) at the bottom.
  function binsToCanvas(channels, cols, rows, colours, ref, flipRows) {
    const c = document.createElement('canvas');
    c.width = cols; c.height = rows;
    const g = c.getContext('2d');
    const img = g.createImageData(cols, rows);
    for (let row = 0; row < rows; row++) {
      const srcRow = flipRows ? rows - 1 - row : row;
      for (let x = 0; x < cols; x++) {
        const o = (row * cols + x) * 4;
        let r = 0, gg = 0, b = 0, a = 0;
        for (let ch = 0; ch < channels.length; ch++) {
          const v = Scopes.intensity(channels[ch][srcRow * cols + x], ref);
          if (!v) continue;
          r += colours[ch][0] * v; gg += colours[ch][1] * v; b += colours[ch][2] * v;
          a = Math.max(a, v);
        }
        img.data[o] = Math.min(255, r / (a || 1));
        img.data[o + 1] = Math.min(255, gg / (a || 1));
        img.data[o + 2] = Math.min(255, b / (a || 1));
        img.data[o + 3] = Math.round(a * 255);
      }
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  const SCOPE_TRACE = [235, 235, 235];
  const RGB_COLOURS = [[255, 80, 70], [80, 230, 100], [80, 140, 255]];

  // Applies state.scopeScale as the box's CSS zoom, first fitted to the
  // current stage (Settings.fitScopeScale) so a smaller window can't be
  // covered by it. The fitted value is only applied, not stored, so the
  // chosen size comes back when the window grows again.
  function applyScopeScale() {
    const fitted = Settings.fitScopeScale(state.scopeScale, SCOPE_BOX_W, scopeBoxH1(),
      stageEl.clientWidth || Infinity, stageEl.clientHeight || Infinity);
    if (scopeBoxEl.style.zoom !== String(fitted)) scopeBoxEl.style.zoom = String(fitted);
    return fitted;
  }
  const SCOPE_BOX_W = 320;
  // The box's height at scale 1 (it changes with the mode).
  function scopeBoxH1() {
    const z = parseFloat(scopeBoxEl.style.zoom) || 1;
    return (scopeBoxEl.getBoundingClientRect().height / z) || 220;
  }

  function syncScopeControls() {
    const mode = state.scopeMode;
    applyScopeScale();
    scopeBoxEl.classList.toggle('hidden', !state.scopesShown);
    scopesToggleEl.setAttribute('aria-pressed', String(state.scopesShown));
    scopeEl.classList.toggle('square', mode === 'vectorscope');
    channelModesEl.classList.toggle('hidden', mode === 'vectorscope');
    for (const b of document.querySelectorAll('[data-scope]')) {
      b.setAttribute('aria-pressed', String(b.dataset.scope === mode));
    }
    for (const b of document.querySelectorAll('[data-ch]')) {
      b.setAttribute('aria-pressed', String(b.dataset.ch === state.scopeChannels));
    }
  }

  function drawScope() {
    syncScopeControls();
    clipLowEl.textContent = '';
    clipHighEl.textContent = '';
    // Nothing to draw while the box isn't laid out (hidden, or no file
    // loaded yet); the next render draws it.
    if (!state.scopesShown || !scopeEl.clientWidth) return;
    const { w, h, dpr } = sizeScopeCanvas();
    const g = scopeEl.getContext('2d');
    g.clearRect(0, 0, w, h);
    g.imageSmoothingEnabled = true;
    const sp = scopePixels && scopePixels.n ? scopePixels : null;
    const mode = state.scopeMode;
    if (mode === 'vectorscope') {
      const size = 129;
      if (sp) {
        const bins = Scopes.vectorscope(sp.px, sp.w, sp.h, { size, include: sp.include });
        const ref = Math.max(2, (sp.n / (size * size)) * 40);
        g.drawImage(binsToCanvas([bins], size, size, [SCOPE_TRACE], ref, false), 0, 0, w, h);
      }
      drawVectorGraticule(g, w, size, dpr);
    } else if (mode === 'waveform') {
      const rgb = state.scopeChannels === 'rgb';
      const levels = Math.min(256, h);
      if (sp) {
        const wf = Scopes.waveform(sp.px, sp.w, sp.h, { levels, mode: state.scopeChannels, include: sp.include });
        const ref = Math.max(2, (sp.n / (sp.w * levels)) * 12);
        if (rgb) {
          wf.channels.forEach((ch, i) => {
            g.drawImage(binsToCanvas([ch], wf.cols, levels, [RGB_COLOURS[i]], ref, true),
              (i * w) / 3, 0, w / 3, h);
          });
        } else {
          g.drawImage(binsToCanvas(wf.channels, wf.cols, levels, [SCOPE_TRACE], ref, true), 0, 0, w, h);
        }
      }
      drawWaveformGraticule(g, w, h, dpr, rgb);
    } else {
      drawHistogramGraticule(g, w, h);
      if (sp) drawHistogram(g, w, h, sp);
    }
  }

  // Linear count per level, each channel a filled curve, scaled to the
  // tallest bin other than the two end bins -- so a clipping spike at pure
  // black or white (reported in the readout below) doesn't flatten the
  // rest. RGB curves are added ('lighter'): where all three overlap the fill
  // reads white.
  function drawHistogram(g, w, h, sp) {
    const bins = 256;
    const hg = Scopes.histogram(sp.px, sp.w, sp.h, { bins, mode: state.scopeChannels, include: sp.include });
    let peak = 1;
    for (const ch of hg.channels) for (let k = 1; k < bins - 1; k++) if (ch[k] > peak) peak = ch[k];
    const colours = hg.channels.length === 1 ? [[200, 200, 200]] : RGB_COLOURS;
    g.save();
    g.globalCompositeOperation = 'lighter';
    hg.channels.forEach((ch, i) => {
      const [r, gg, b] = colours[i];
      g.beginPath();
      g.moveTo(0, h);
      for (let k = 0; k < bins; k++) {
        const x = (k + 0.5) / bins * w;
        g.lineTo(x, h - Math.min(1, ch[k] / peak) * (h - 2));
      }
      g.lineTo(w, h);
      g.closePath();
      g.fillStyle = `rgba(${r},${gg},${b},${hg.channels.length === 1 ? 0.55 : 0.45})`;
      g.fill();
      g.strokeStyle = `rgba(${r},${gg},${b},.9)`;
      g.lineWidth = 1;
      g.stroke();
    });
    g.restore();
    const pct = (f) => (f * 100 < 0.1 && f > 0 ? '<0.1' : (f * 100).toFixed(1)) + '%';
    clipLowEl.textContent = `Black ${pct(hg.clipLow)}`;
    clipHighEl.textContent = `White ${pct(hg.clipHigh)}`;
    clipLowEl.classList.toggle('hot', hg.clipLow >= 0.005);
    clipHighEl.classList.toggle('hot', hg.clipHigh >= 0.005);
  }

  function drawHistogramGraticule(g, w, h) {
    g.lineWidth = 1;
    g.strokeStyle = 'rgba(160,160,160,.14)';
    for (const f of [0.25, 0.5, 0.75]) {
      const x = Math.round(f * w) + 0.5;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
    }
  }

  // 0-100% in 10% steps; 0, 50 and 100 are stronger and labelled.
  function drawWaveformGraticule(g, w, h, dpr, rgb) {
    g.lineWidth = 1;
    g.font = `${9 * dpr}px ui-monospace, Consolas, monospace`;
    g.textBaseline = 'middle';
    for (let p = 0; p <= 100; p += 10) {
      const y = Math.round((1 - p / 100) * (h - 1)) + 0.5;
      g.strokeStyle = p % 50 === 0 ? 'rgba(160,160,160,.35)' : 'rgba(160,160,160,.14)';
      g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
      if (p % 50 === 0) {
        g.fillStyle = 'rgba(160,160,160,.6)';
        g.fillText(String(p), 3 * dpr, Math.min(h - 6 * dpr, Math.max(6 * dpr, y)));
      }
    }
    if (rgb) {
      g.strokeStyle = 'rgba(160,160,160,.3)';
      for (const x of [w / 3, (2 * w) / 3]) {
        g.beginPath(); g.moveTo(Math.round(x) + 0.5, 0); g.lineTo(Math.round(x) + 0.5, h); g.stroke();
      }
    }
  }

  // Outer ring, centre cross, the six 75% targets and the skin-tone line.
  function drawVectorGraticule(g, w, size, dpr) {
    const s = w / size;
    const mid = w / 2;
    g.lineWidth = 1;
    g.strokeStyle = 'rgba(160,160,160,.22)';
    g.beginPath(); g.arc(mid, mid, mid - 1, 0, Math.PI * 2); g.stroke();
    g.beginPath();
    g.moveTo(mid, 0); g.lineTo(mid, w); g.moveTo(0, mid); g.lineTo(w, mid);
    g.stroke();
    const skin = Scopes.skinLine(size);
    g.strokeStyle = 'rgba(160,160,160,.35)';
    g.setLineDash([3 * dpr, 3 * dpr]);
    g.beginPath(); g.moveTo(skin.x1 * s, skin.y1 * s); g.lineTo(skin.x2 * s, skin.y2 * s); g.stroke();
    g.setLineDash([]);
    g.font = `${9 * dpr}px ui-monospace, Consolas, monospace`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const box = 5 * dpr;
    for (const t of Scopes.targets(size)) {
      const x = t.x * s, y = t.y * s;
      g.strokeStyle = 'rgba(160,160,160,.5)';
      g.strokeRect(x - box / 2, y - box / 2, box, box);
      const dx = x - mid, dy = y - mid, len = Math.hypot(dx, dy) || 1;
      g.fillStyle = 'rgba(160,160,160,.7)';
      g.fillText(t.name, x + (dx / len) * 11 * dpr, y + (dy / len) * 11 * dpr);
    }
    g.textAlign = 'start';
  }

  // Showing the box needs a fresh sample, which only a render can take.
  function setScopesShown(shown) {
    state.scopesShown = shown;
    scheduleSave();
    if (shown && state.sourceLensSize) render(); else drawScope();
  }

  for (const b of document.querySelectorAll('[data-scope]')) {
    b.addEventListener('click', () => {
      state.scopeMode = b.dataset.scope;
      drawScope();
      scheduleSave();
    });
  }
  for (const b of document.querySelectorAll('[data-ch]')) {
    b.addEventListener('click', () => {
      state.scopeChannels = b.dataset.ch;
      drawScope();
      scheduleSave();
    });
  }
  scopesToggleEl.addEventListener('click', () => setScopesShown(!state.scopesShown));
  document.getElementById('scopeHide').addEventListener('click', () => setScopesShown(false));
  // The box sits on the stage; keep its clicks and scrolls from rolling,
  // panning or zooming the image underneath.
  for (const type of ['pointerdown', 'wheel', 'dblclick']) {
    scopeBoxEl.addEventListener(type, (e) => e.stopPropagation());
  }

  // Resizing: drag the grip (top-left; the box is anchored bottom-right),
  // double-click it to reset. Scales the whole box -- plot, buttons, text.
  const scopeGripEl = document.getElementById('scopeGrip');
  let scopeResize = null;
  scopeGripEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const r = scopeBoxEl.getBoundingClientRect();
    scopeResize = { id: e.pointerId, x: e.clientX, y: e.clientY, w: r.width, h: r.height, scale: applyScopeScale() };
    scopeGripEl.setPointerCapture(e.pointerId);
    scopeBoxEl.classList.add('resizing');
  });
  scopeGripEl.addEventListener('pointermove', (e) => {
    if (!scopeResize || e.pointerId !== scopeResize.id) return;
    // Growing is up and to the left; follow whichever direction the
    // pointer has moved further, relative to the box's size.
    const kx = (scopeResize.w - (e.clientX - scopeResize.x)) / scopeResize.w;
    const ky = (scopeResize.h - (e.clientY - scopeResize.y)) / scopeResize.h;
    const k = Math.abs(kx - 1) >= Math.abs(ky - 1) ? kx : ky;
    state.scopeScale = Settings.fitScopeScale(scopeResize.scale * k, SCOPE_BOX_W, scopeBoxH1(),
      stageEl.clientWidth || Infinity, stageEl.clientHeight || Infinity);
    applyScopeScale();
    drawScope();
  });
  function endScopeResize(e) {
    if (!scopeResize || e.pointerId !== scopeResize.id) return;
    scopeResize = null;
    scopeBoxEl.classList.remove('resizing');
    // A bigger plot wants a finer sample of the image.
    if (state.sourceLensSize) render();
    scheduleSave();
  }
  scopeGripEl.addEventListener('pointerup', endScopeResize);
  scopeGripEl.addEventListener('pointercancel', endScopeResize);
  scopeGripEl.addEventListener('dblclick', () => {
    state.scopeScale = DEFAULTS.scopeScale;
    applyScopeScale();
    if (state.sourceLensSize) render(); else drawScope();
    scheduleSave();
  });

  function drawGuides() {
    if (!ctx || !state.sourceLensSize) return;
    positionGuides();
    const g = guidesCanvas.getContext('2d');
    g.clearRect(0, 0, guidesCanvas.width, guidesCanvas.height);
    updateGuidesVisibility();
    // While a Pick neutral area is being dragged out, the overlay shows
    // just that rectangle, not the levelling guides.
    if (pickRect) {
      const r = rectOf(pickRect.start, pickRect.end);
      const lw = Math.max(1, (window.devicePixelRatio || 1));
      g.lineWidth = lw;
      g.strokeStyle = 'rgba(0,0,0,0.6)';
      g.strokeRect(r.x0 - lw, r.y0 - lw, r.x1 - r.x0 + 2 * lw, r.y1 - r.y0 + 2 * lw);
      g.strokeStyle = 'rgba(240,160,75,0.95)';
      g.strokeRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
      return;
    }
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
    // The line being drawn with the Straighten tool.
    if (straightenLine && straightenLine.end) {
      const { start, end } = straightenLine;
      g.lineWidth = Math.max(1, (window.devicePixelRatio || 1) * 1.5);
      g.strokeStyle = 'rgba(240,160,75,0.95)';
      g.beginPath(); g.moveTo(start.x, start.y); g.lineTo(end.x, end.y); g.stroke();
      g.fillStyle = 'rgba(240,160,75,0.95)';
      for (const q of [start, end]) { g.beginPath(); g.arc(q.x, q.y, g.lineWidth * 2, 0, Math.PI * 2); g.fill(); }
    }
  }

  // Guides show while the user is levelling -- moving a roll or nudge
  // control, dragging a circle, or using Straighten -- and fade out a
  // moment after, unless "Always show guides" is on.
  const GUIDES_LINGER_MS = 1000;
  let guidesUntil = 0;
  let guidesTimer = null;
  function updateGuidesVisibility() {
    const levelling = (drag && drag.kind === 'roll') || tool === 'straighten';
    const show = !!pickRect || showGuidesEl.checked || levelling || performance.now() < guidesUntil;
    guidesCanvas.classList.toggle('show', show);
  }
  function pokeGuides() {
    guidesUntil = performance.now() + GUIDES_LINGER_MS;
    updateGuidesVisibility();
    clearTimeout(guidesTimer);
    guidesTimer = setTimeout(updateGuidesVisibility, GUIDES_LINGER_MS + 20);
  }

  showGuidesEl.addEventListener('input', () => drawGuides());

  // -- Controls follow the visible lens -----------------------------------
  // Lens-specific controls ([data-lens="A"|"B"]: nudge, white balance) are
  // shown only for lenses on screen; [data-lens="both"] (Link A and B) only
  // when both are.
  const lensEls = Array.from(document.querySelectorAll('[data-lens]'));
  function updateLensControls() {
    const shown = Settings.visibleLenses(state, GL.physicalLens);
    for (const el of lensEls) {
      const want = el.dataset.lens;
      el.classList.toggle('hidden', want === 'both' ? shown.length < 2 : !shown.includes(want));
    }
  }

  // -- Tools: Straighten and Pick neutral ---------------------------------
  // A tool waits for input on the image: the next drag (Straighten) or
  // click (Pick) goes to it instead of rolling or panning, then it turns
  // itself off. Esc, or its button again, cancels.
  const straightenBtnEl = document.getElementById('straightenBtn');
  const wbPickEl = document.getElementById('wbPick');
  const wbPickNoteEl = document.getElementById('wbPickNote');
  let tool = null;             // null | 'straighten' | 'pick'
  let straightenLine = null;   // { circ, start, end } in canvas pixels
  let pickRect = null;         // { circ, start, end } in canvas pixels

  // The rectangle spanned by two canvas points, corners ordered.
  function rectOf(a, b) {
    return { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
  }

  function setTool(name) {
    tool = name;
    straightenLine = null;
    pickRect = null;
    straightenBtnEl.setAttribute('aria-pressed', String(tool === 'straighten'));
    wbPickEl.setAttribute('aria-pressed', String(tool === 'pick'));
    stageEl.classList.toggle('tool-active', !!tool);
    if (tool === 'pick') wbPickNoteEl.classList.add('hidden');
    drawGuides();
  }
  straightenBtnEl.addEventListener('click', () => setTool(tool === 'straighten' ? null : 'straighten'));
  wbPickEl.addEventListener('click', () => setTool(tool === 'pick' ? null : 'pick'));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && tool) { setTool(null); pokeGuides(); }
  });

  // The circle under a canvas point, or null.
  function circleAt(p) {
    for (const c of previewLayout().circles) {
      if (Math.hypot(p.x - c.cx, p.y - c.cy) <= c.radius) return c;
    }
    return null;
  }

  // Straighten: the drawn line, in circle units (x right, y up), goes
  // through Lens.straightenDelta, which says how far to turn the displayed
  // image counter-clockwise. Settings.rollForDrag (clockwise on screen,
  // with the lens's sign) applies a turn exactly as a drag of that angle
  // would, so a turn of -delta is what makes the line level or plumb.
  function applyStraighten() {
    const { circ, start, end } = straightenLine;
    const toUnit = (q) => ({ x: (q.x - circ.cx) / circ.radius, y: -(q.y - circ.cy) / circ.radius });
    const s = Lens.straightenDelta(toUnit(start), toUnit(end), state.fovDeg / 2);
    if (!s) return;
    const { sign } = Settings.dragSign(state, circ.lens, GL.physicalLens);
    state.rollDeg = Settings.rollForDrag(state.rollDeg, sign, -s.deltaDeg);
    reflectNum(NUM.roll, true);
    render();
    scheduleSave();
  }

  // Pick neutral: renders the preview with tone and detail off (so those
  // sliders cannot skew the pick), averages the picked area -- a small
  // patch for a click, the dragged rectangle for a drag -- in linear light,
  // and asks Wb.neutralFromRendered for the white balance that makes it
  // grey. Clipped and near-black pixels are left out (Wb.pickAverage); the
  // pick is refused only if too little of the area is usable. Going
  // through Kelvin/tint is not exact, so this measures and solves again a
  // couple of times; it converges in two or three passes.
  const PICK_HALF = 3;          // a click samples a 7 x 7 device-pixel patch
  const PICK_DRAG_MIN_PX = 6;   // smaller drags count as a click
  const PICK_MIN_USABLE = 0.25; // share of the area that must be usable
  const PICK_PASSES = 3;

  // Mean linear sRGB of `rect` (canvas pixels, inside `circ`) as rendered
  // with tone and detail off, or { error }.
  function measurePick(rect, circ) {
    return measureRegion(rect, (x, y) => Math.hypot(x + 0.5 - circ.cx, y + 0.5 - circ.cy) <= circ.radius);
  }

  // The same for any area: the pixels of `rect` for which inside(x, y)
  // (canvas pixels) is true. `clipped` says whether `rect` ran off the
  // canvas (the preview only shows part of the composition when zoomed).
  function measureRegion(rect, insideCanvas) {
    const saved = { tone: state.tone, detail: state.detail };
    state.tone = { ...DEFAULTS.tone };
    state.detail = { ...DEFAULTS.detail };
    GL.renderComposition(ctx, state, canvas.width, canvas.height, null, previewPlace);
    const x0 = Math.max(0, Math.floor(rect.x0)), y0 = Math.max(0, Math.floor(rect.y0));
    const w = Math.max(1, Math.min(canvas.width, Math.ceil(rect.x1)) - x0);
    const h = Math.max(1, Math.min(canvas.height, Math.ceil(rect.y1)) - y0);
    const c2 = document.createElement('canvas');
    c2.width = w; c2.height = h;
    const g = c2.getContext('2d', { willReadFrequently: true });
    g.drawImage(canvas, x0, y0, w, h, 0, 0, w, h);
    const px = g.getImageData(0, 0, w, h).data;
    state.tone = saved.tone;
    state.detail = saved.detail;
    const offCanvas = rect.x0 < 0 || rect.y0 < 0 || rect.x1 > canvas.width || rect.y1 > canvas.height;
    const a = Wb.pickAverage(px, w, h, (x, y) => insideCanvas(x0 + x, y0 + y));
    const total = a.used + a.clipped + a.dark;
    const clippedShare = total ? a.clipped / total : 0;
    if (!a.srgb || a.used < total * PICK_MIN_USABLE) {
      return {
        clippedShare,
        error: a.clipped >= a.dark
          ? 'That area is mostly clipped. Pick something bright but not blown out.'
          : 'That area is too dark to judge. Pick a mid or light grey.',
      };
    }
    return { srgb: a.srgb, used: a.used, skipped: a.clipped + a.dark, offCanvas, clippedShare };
  }

  function pickNeutralAt(rect, circ) {
    const physical = GL.physicalLens(state, circ.lens);
    const lenses = state.rawWbLinked ? ['A', 'B'] : [physical];
    if (!state.isRaw) {
      // JPEG: exact in one pass -- the rendering is a fixed matrix of the
      // camera's colour.
      const m = measurePick(rect, circ);
      if (!m.srgb) { render(); showPickNote(m.error || 'That area has no usable colour.'); return; }
      const s = JpegWb.solve(jpegAsShot(physical, m.srgb), [1, 1, 1]);
      if (!s) { render(); showPickNote('That area has no usable colour. Pick a neutral grey or white.'); return; }
      state.jpegWb = { A: { ...state.jpegWb.A }, B: { ...state.jpegWb.B } };
      for (const l of lenses) state.jpegWb[l] = { temp: s.temp, tint: s.tint };
      syncWbControls();
      render();
      scheduleSave();
      showPickNote('Set ' + fmtJw(s) + (lenses.length === 1 ? ` on lens ${physical}` : '') +
        (s.atLimit ? ' (at the slider limit)' : '') + '.' +
        (m.skipped ? ' Clipped or black pixels in the area were left out.' : ''));
      return;
    }
    const rk = Settings.RANGES.rawWb[physical];
    let kelvin = null, tint = null, atLimit = false, skipped = 0;
    for (let pass = 0; pass < PICK_PASSES; pass++) {
      const m = measurePick(rect, circ);
      if (m.srgb && pass === 0) skipped = m.skipped;
      const mat = state.rawCamToSrgb && state.rawCamToSrgb[physical];
      const neutral = m.srgb && mat ? Wb.neutralFromRendered(m.srgb, mat, state.rawWhiteBalance[physical]) : null;
      if (!neutral) {
        // A spot that is fine on the first pass stays fine; if the very
        // first measurement is unusable, nothing has been changed yet.
        if (pass === 0) {
          render();
          showPickNote(m.error || 'That area has no usable colour. Pick a neutral grey or white.');
          return;
        }
        break;
      }
      const kt = Wb.kelvinTintFromNeutral(neutral, state.rawMeta && state.rawMeta.colorMatrix1);
      kelvin = Math.max(rk.kelvin[0], Math.min(rk.kelvin[1], kt.kelvin));
      tint = Math.max(rk.tint[0], Math.min(rk.tint[1], kt.tint));
      atLimit = kelvin !== kt.kelvin || tint !== kt.tint;
      for (const l of lenses) state.rawWb[l] = { kelvin, tint };
      syncWbControls();   // also recomputes the neutral and matrix used next pass
      if (atLimit) break;
    }
    render();
    scheduleSave();
    showPickNote(`Set ${Math.round(kelvin)} K, tint ${tint > 0 ? '+' : ''}${Math.round(tint)}` +
      (lenses.length === 1 ? ` on lens ${physical}` : '') + (atLimit ? ' (at the slider limit)' : '') + '.' +
      (skipped ? ' Clipped or black pixels in the area were left out.' : ''));
  }
  function showPickNote(text) {
    wbPickNoteEl.textContent = text;
    wbPickNoteEl.classList.remove('hidden');
  }


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
    if (tool) {
      const p = pointerToCanvas(e);
      const circ = circleAt(p);
      if (!circ) return;
      if (tool === 'pick') {
        pickRect = { circ, start: p, end: p };
        drag = { kind: 'pick', pointerId: e.pointerId };
      } else {
        straightenLine = { circ, start: p, end: null };
        drag = { kind: 'straighten', pointerId: e.pointerId };
      }
      e.target.setPointerCapture(e.pointerId);
      return;
    }
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
    if (drag.kind === 'straighten') {
      straightenLine.end = pointerToCanvas(e);
      drawGuides();
      return;
    }
    if (drag.kind === 'pick') {
      pickRect.end = pointerToCanvas(e);
      drawGuides();
      return;
    }
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

  // A Straighten line shorter than this (device pixels) is treated as a
  // stray click and ignored.
  const STRAIGHTEN_MIN_PX = 12;
  function endDrag(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const kind = drag.kind;
    drag = null;
    stageEl.classList.remove('panning');
    if (kind === 'straighten') {
      const l = straightenLine;
      const ok = e.type === 'pointerup' && l && l.end &&
        Math.hypot(l.end.x - l.start.x, l.end.y - l.start.y) >= STRAIGHTEN_MIN_PX;
      if (ok) applyStraighten();
      setTool(ok ? null : 'straighten');
      pokeGuides();
    } else if (kind === 'pick') {
      const { circ, start, end } = pickRect;
      let rect = rectOf(start, end);
      if (rect.x1 - rect.x0 < PICK_DRAG_MIN_PX && rect.y1 - rect.y0 < PICK_DRAG_MIN_PX) {
        rect = { x0: start.x - PICK_HALF, y0: start.y - PICK_HALF, x1: start.x + PICK_HALF + 1, y1: start.y + PICK_HALF + 1 };
      }
      setTool(null);   // also clears pickRect and the overlay
      if (e.type === 'pointerup') pickNeutralAt(rect, circ);
    } else if (kind === 'roll') {
      pokeGuides();
    }
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
    noteEdit();
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
  const CURVE_KEYS = ['highlights', 'shadows', 'whites', 'blacks'];

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

  defNum('fov', { path: 'fovDeg', get: () => state.fovDeg, set: (v) => { state.fovDeg = v; },
    range: Settings.RANGES.fovDeg, fmt: fmtDeg });
  defNum('gap', { path: 'gapFrac', get: () => state.gapFrac, set: (v) => { state.gapFrac = v; },
    range: Settings.RANGES.gapFrac, scale: 100, fmt: fmtPct });
  defNum('margin', { path: 'marginFrac', get: () => state.marginFrac, set: (v) => { state.marginFrac = v; },
    range: Settings.RANGES.marginFrac, scale: 100, fmt: fmtPct });
  defNum('roll', { path: 'rollDeg', get: () => state.rollDeg, set: (v) => { state.rollDeg = v; },
    range: Settings.RANGES.rollDeg, fmt: fmtDeg });
  defNum('nudgeA', { path: 'nudgeDeg.A', get: () => state.nudgeDeg.A, set: (v) => { state.nudgeDeg.A = v; },
    range: Settings.RANGES.nudgeDeg.A, fmt: fmtDeg });
  defNum('nudgeB', { path: 'nudgeDeg.B', get: () => state.nudgeDeg.B, set: (v) => { state.nudgeDeg.B = v; },
    range: Settings.RANGES.nudgeDeg.B, fmt: fmtDeg });
  for (const k of EDGE_KEYS) {
    defNum(k, { path: 'edge.' + k, get: () => state.edge[k], set: (v) => { state.edge[k] = v; },
      range: Settings.RANGES.edge[k], fmt: (v) => formatEdgeValue(k, v) });
  }
  for (const k of TONE_KEYS) {
    defNum(k, { path: 'tone.' + k, get: () => state.tone[k], set: (v) => { state.tone[k] = v; },
      range: Settings.RANGES.tone[k], fmt: (v) => v.toFixed(2) });
  }
  // Signed whole numbers, as in Lightroom ("+25", "0", "-40"); a typed
  // leading "+" parses fine (Settings.parseReadout).
  for (const k of CURVE_KEYS) {
    defNum(k, { path: 'tone.' + k, get: () => state.tone[k], set: (v) => { state.tone[k] = v; },
      range: Settings.RANGES.tone[k], fmt: (v) => (v > 0 ? '+' : '') + String(Math.round(v)) });
  }
  for (const k of ['sharpenAmount', 'lumaNoise', 'colorNoise']) {
    defNum(k, { path: 'detail.' + k, get: () => state.detail[k], set: (v) => { state.detail[k] = v; },
      range: Settings.RANGES.detail[k], fmt: (v) => String(Math.round(v)) });
  }
  defNum('sharpenRadius', { path: 'detail.sharpenRadius', get: () => state.detail.sharpenRadius,
    set: (v) => { state.detail.sharpenRadius = v; },
    range: Settings.RANGES.detail.sharpenRadius, fmt: (v) => v.toFixed(1) });
  for (const lens of ['A', 'B']) {
    defNum('kelvin' + lens, {
      get: () => state.rawWb[lens].kelvin,
      range: Settings.RANGES.rawWb[lens].kelvin,
      toSlider: Wb.kelvinToSlider, fromSlider: Wb.sliderToKelvin,
      fmt: (v) => String(Math.round(v)),
      apply: (v) => setWbField(lens, 'kelvin', v),
      reset: () => asShotWb().kelvin,
    });
    defNum('tint' + lens, {
      get: () => state.rawWb[lens].tint,
      range: Settings.RANGES.rawWb[lens].tint,
      toSlider: Wb.tintToSlider, fromSlider: Wb.sliderToTint,
      fmt: (v) => String(Math.round(v)),
      apply: (v) => setWbField(lens, 'tint', v),
      reset: () => asShotWb().tint,
    });
  }
  for (const lens of ['A', 'B']) {
    for (const field of ['temp', 'tint']) {
      defNum('jw' + (field === 'temp' ? 'Temp' : 'Tint') + lens, {
        get: () => state.jpegWb[lens][field],
        range: Settings.RANGES.jpegWb[lens][field],
        fmt: (v) => { const r = Math.round(v); return (r > 0 ? '+' : '') + String(r); },
        apply: (v) => setJpegWbField(lens, field, v),
        reset: () => 0,
      });
    }
  }
  // JPEG quality is an output option, not a persisted/rendered setting, and
  // has no Settings.RANGES entry -- its own slider bounds are the range.
  defNum('quality', { path: 'quality', get: () => state.quality, set: (v) => { state.quality = v; },
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

  const LEVEL_IDS = ['roll', 'nudgeA', 'nudgeB'];
  function commitNum(d, v) {
    if (d.apply) { d.apply(v); return; }
    d.set(v);
    reflectNum(d, true);
    if (d.live) { render(); scheduleSave(); }
    if (LEVEL_IDS.includes(d.id)) pokeGuides();
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

  function resetNum(d) {
    const v = d.reset ? d.reset() : Settings.valueAt(DEFAULTS, d.path);
    if (typeof v !== 'number' || !Number.isFinite(v)) return;
    commitNum(d, Math.min(d.range[1], Math.max(d.range[0], v)));
    reflectNum(d, true);
  }

  for (const d of Object.values(NUM)) {
    d.slider.addEventListener('input', () => commitNum(d, fromSlider(d, parseFloat(d.slider.value))));
    d.slider.addEventListener('keydown', (e) => {
      // Up / down pick another slider (see the keyboard shortcuts).
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        if (e.altKey) return;
        e.preventDefault();
        moveSlider(e.key === 'ArrowUp' ? -1 : 1, d.slider);
        return;
      }
      nudgeKey(d, e);
    });
    // Double-click resets to the default (white balance: the file's as-shot
    // value). Either way the value is clamped to the slider's current range.
    d.slider.addEventListener('dblclick', () => resetNum(d));
    // 'change' fires on blur (and on Enter in most browsers); Enter is also
    // handled explicitly below so it applies everywhere.
    d.out.addEventListener('change', () => commitReadout(d));
    d.out.addEventListener('blur', () => reflectNum(d, true));
    d.out.addEventListener('focus', () => d.out.select());
    d.out.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commitReadout(d); d.out.select(); }
      else if (e.key === 'Escape') { e.preventDefault(); reflectNum(d, true); d.out.blur(); }
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        commitReadout(d);
        moveSlider(e.key === 'ArrowUp' ? -1 : 1, d.slider);
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
  // Auto tone: renders the whole composition small and off screen (so the
  // preview's zoom doesn't matter) with tone off, histograms the photo
  // pixels only -- inside each circle and inside the Edge falloff start,
  // the scopes' mask, so the surrounding black can't drag it brighter --
  // and lets AutoTone.solve set exposure, contrast and the four curve
  // sliders. Saturation (and black & white) are the user's and left alone.
  const AUTO_TONE_SIZE = 640;
  function autoTone() {
    if (!ctx || !state.sourceLensSize) return;
    const g = GL.exportGeometry(state);
    const k = Math.min(1, AUTO_TONE_SIZE / Math.max(g.width, g.height));
    const w = Math.max(1, Math.round(g.width * k)), h = Math.max(1, Math.round(g.height * k));
    const gl = ctx.gl;
    const saved = state.tone;
    // A merged HDR photo is rendered darker by its headroom (so nothing
    // clips in the 8-bit frame, and the shoulder is off), and AutoTone
    // reads it back in its real range.
    const hdrMax = state.rawMeta && state.rawMeta.hdrMax > 1 ? state.rawMeta.hdrMax : 1;
    const scale = hdrMax > 1 ? Edge.srgbEncode(hdrMax) : 1;
    state.tone = { ...DEFAULTS.tone, exposureEv: -Math.log2(scale) };
    const px = new Uint8Array(w * h * 4);
    const target = GL.makeExportTarget(gl, w, h);
    try {
      GL.renderComposition(ctx, state, w, h, target.fbo);
      GL.readCompositionStrips(gl, target.fbo, w, h, h, (rows, outY) => px.set(rows, outY * w * 4));
    } finally {
      GL.deleteExportTarget(gl, target);
      state.tone = saved;
    }
    const photo = state.edge.falloffStart;
    const include = Scopes.insideCircles(GL.placedLayout(state, w, h).circles.map((c) => ({
      cx: c.cx, cy: c.cy, radius: c.radius * photo,
    })));
    const hist = Scopes.histogram(px, w, h, { bins: 256, mode: 'luma', include });
    const t = AutoTone.solve(hist.channels[0], { rawMax: hdrMax, scale });
    if (!t) return;
    state.tone = Object.assign({}, state.tone, t);
    syncControlsFromState();
    render();
    scheduleSave();
  }
  document.getElementById('autoTone').addEventListener('click', autoTone);

  function syncControlsFromState() {
    toneMonoEl.checked = !!state.tone.mono;
    sensorsEl.value = state.sensors;
    orientationEl.value = state.orientation;
    swapEl.checked = state.swap;
    for (const d of Object.values(NUM)) if (!d.apply) reflectNum(d, true);
    syncFovRange();
    // syncWbControls is a hoisted function declaration -- reflects whatever
    // rawWb/rawWbLinked Settings.load just restored, even though the panel
    // itself stays hidden until a raw file is loaded.
    syncWbControls();
    syncPanels();
    drawScope();
    updateLensControls();
  }

  // Black & white (edge.js mono), part of the tone settings.
  const toneMonoEl = document.getElementById('toneMono');
  function setMono(on) {
    state.tone = Object.assign({}, state.tone, { mono: on });
    toneMonoEl.checked = on;
    render();
    scheduleSave();
  }
  toneMonoEl.addEventListener('input', () => setMono(toneMonoEl.checked));

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
  // JPEG / .insp: the same, on the relative sliders.
  function setJpegWbField(lens, field, value) {
    if (!Number.isFinite(value)) { syncWbControls(); return; }
    const range = Settings.RANGES.jpegWb[lens][field];
    value = Math.max(range[0], Math.min(range[1], value));
    const lenses = state.rawWbLinked ? ['A', 'B'] : [lens];
    state.jpegWb = { A: { ...state.jpegWb.A }, B: { ...state.jpegWb.B } };
    for (const l of lenses) state.jpegWb[l][field] = value;
    syncWbControls();
    render();
    scheduleSave();
  }

  // The camera's rendering of a lens's colour (linear sRGB) behind what is
  // rendered now under its JPEG white balance.
  function jpegAsShot(lens, rendered) {
    const w = state.jpegWb[lens];
    return JpegWb.apply(JpegWb.inv(JpegWb.matrix(w.temp, w.tint)), rendered);
  }
  function fmtJw(s) {
    const f = (v) => { const r = Math.round(v); return (r > 0 ? '+' : '') + r; };
    return `temperature ${f(s.temp)}, tint ${f(s.tint)}`;
  }

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
      state.jpegWb = { A: { ...state.jpegWb.A }, B: { ...state.jpegWb.A } };
    }
    syncWbControls();
    render();
    scheduleSave();
  });

  // The loaded raw file's own white balance as Kelvin/tint, or the
  // built-in default when there is none.
  function asShotWb() {
    if (!state.rawAsShotNeutral) return { ...DEFAULTS.rawWb.A };
    return Wb.kelvinTintFromNeutral(state.rawAsShotNeutral, state.rawMeta && state.rawMeta.colorMatrix1);
  }

  wbResetEl.addEventListener('click', () => {
    if (!state.isRaw) {
      state.jpegWb = { A: { temp: 0, tint: 0 }, B: { temp: 0, tint: 0 } };
      syncWbControls();
      render();
      scheduleSave();
      return;
    }
    if (!state.rawAsShotNeutral) return;
    const kt = asShotWb();
    state.rawWb = {
      A: { kelvin: kt.kelvin, tint: kt.tint },
      B: { kelvin: kt.kelvin, tint: kt.tint },
    };
    syncWbControls();
    render();
    scheduleSave();
  });

  // Auto white balance (autowb.js): from each lens's raw plane, inside
  // the photo (the lens circle out to the Edge falloff start). Linked:
  // both lenses measured together, one result; unlinked: once per lens.
  const wbAutoEl = document.getElementById('wbAuto');
  // JPEG / .insp: the same grey-pixel estimate on the camera's rendering
  // (linear sRGB, read back from the lens texture, subsampled), starting
  // from "as shot"; the tint kept within JPEG_AUTO_TINT of it.
  const JPEG_AUTO_TINT = 30;
  function jpegSamples(i, radiusFrac) {
    const size = ctx.textureSize[i];
    if (!ctx.textures[i] || !size) return [];
    const w = size.width, h = size.height;
    const step = Math.max(1, Math.floor(Math.max(w, h) / 400));
    const cx = w / 2, cy = h / 2, r2 = Math.pow(radiusFrac * Math.min(w, h) / 2, 2);
    const out = [];
    for (let y = 0; y < h; y += step) {
      const row = GL.readLensRgba(ctx, i, { x: 0, y, w, h: 1 });
      for (let x = 0; x < w; x += step) {
        if ((x - cx) * (x - cx) + (y - cy) * (y - cy) > r2) continue;
        const r = row[x * 4], g = row[x * 4 + 1], b = row[x * 4 + 2];
        if (Math.max(r, g, b) >= 250 || Math.max(r, g, b) < 8 || Math.min(r, g, b) === 0) continue;
        out.push([Wb.srgbDecode(r / 255), Wb.srgbDecode(g / 255), Wb.srgbDecode(b / 255)]);
      }
    }
    return out;
  }

  function autoWhiteBalanceJpeg() {
    const radiusFrac = Lens.radiusForFov(state.fovDeg, state.thetaMaxDeg) * state.edge.falloffStart;
    const lenses = state.lensCount === 1 ? ['A'] : ['A', 'B'];
    const slot = (L) => (L === 'A' ? 0 : 1);
    const groups = state.rawWbLinked
      ? [{ lenses, samples: lenses.flatMap((L) => jpegSamples(slot(L), radiusFrac)) }]
      : lenses.map((L) => ({ lenses: [L], samples: jpegSamples(slot(L), radiusFrac) }));
    const next = { A: { ...state.jpegWb.A }, B: { ...state.jpegWb.B } };
    const parts = [];
    for (const g of groups) {
      const r = AutoWb.estimate(g.samples, [1, 1, 1]);
      const s = r && JpegWb.solve(r.neutral, [1, 1, 1]);
      if (!s) continue;
      s.tint = Math.max(-JPEG_AUTO_TINT, Math.min(JPEG_AUTO_TINT, s.tint));
      for (const L of g.lenses) next[L] = { temp: s.temp, tint: s.tint };
      if (state.rawWbLinked && state.lensCount === 2) next.B = { ...next.A };
      parts.push((groups.length > 1 ? g.lenses[0] + ' ' : '') + fmtJw(s));
    }
    if (!parts.length) { showPickNote('Auto found nothing to measure: the photo is all clipped or black.'); return; }
    commitHistory();
    state.jpegWb = next;
    syncWbControls();
    render();
    scheduleSave();
    commitHistory();
    showPickNote('Auto: ' + parts.join(', ') + '.');
  }

  function autoWhiteBalance() {
    if (ctx && state.sourceLensSize && !state.isRaw) return autoWhiteBalanceJpeg();
    if (!ctx || !state.isRaw || !state.rawMeta) return false;
    const radiusFrac = Lens.radiusForFov(state.fovDeg, state.thetaMaxDeg) * state.edge.falloffStart;
    const samplesOf = (i) => {
      const info = ctx.lensInfo[i], size = ctx.textureSize[i];
      if (!info || !info.plane || !size) return [];
      const m = info.rawMeta;
      return AutoWb.sample(info.plane, size.width, size.height, m.cfa, m.black, m.white,
        radiusFrac * Math.min(size.width, size.height) / 2);
    };
    const cm = state.rawMeta.colorMatrix1;
    const lenses = state.lensCount === 1 ? ['A'] : ['A', 'B'];
    const groups = state.rawWbLinked
      ? [{ lenses, samples: lenses.flatMap((L) => samplesOf(L === 'A' ? 0 : 1)) }]
      : lenses.map((L) => ({ lenses: [L], samples: samplesOf(L === 'A' ? 0 : 1) }));
    const parts = [];
    const next = { A: { ...state.rawWb.A }, B: { ...state.rawWb.B } };
    for (const g of groups) {
      const r = AutoWb.estimate(g.samples, state.rawAsShotNeutral);
      if (!r) continue;
      const kt = AutoWb.toKelvinTint(r.neutral, cm, state.rawAsShotNeutral ? asShotWb().tint : 0);
      for (const L of g.lenses) next[L] = { kelvin: kt.kelvin, tint: kt.tint };
      if (state.rawWbLinked && state.lensCount === 2) next.B = { ...next.A };
      parts.push((groups.length > 1 ? g.lenses[0] + ' ' : '') +
        `${Math.round(kt.kelvin)} K ${kt.tint >= 0 ? '+' : ''}${Math.round(kt.tint)}`);
    }
    if (!parts.length) {
      showPickNote('Auto found nothing to measure: the photo is all clipped or black.');
      return;
    }
    // One undo step, however soon the next edit follows.
    commitHistory();
    state.rawWb = next;
    syncWbControls();
    render();
    scheduleSave();
    commitHistory();
    showPickNote('Auto: ' + parts.join(', ') + '.');
  }
  wbAutoEl.addEventListener('click', autoWhiteBalance);


  // -- Match lenses (wbmatch.js) -------------------------------------------
  // Two sampling circles pinned to the photo -- a target on one lens, a
  // source on the other -- joined by a dashed line; letting go of one sets
  // the source lens's white balance so its circle's colour matches the
  // target's (hue and saturation; white balance can't change brightness).
  // Drawn as SVG over the canvas, in canvas pixels, redrawn by render().
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const matchLayerEl = document.getElementById('matchLayer');
  const wbMatchEl = document.getElementById('wbMatch');
  const wbMatchSwapEl = document.getElementById('wbMatchSwap');
  const MATCH_PASSES = 4;
  const MATCH_START_R = 0.06;
  let match = null;   // { target, source }: { lens, uv, r } each

  // Each shown lens's circle on the canvas, by physical lens.
  function matchDiscs() {
    const out = {};
    const crop = Lens.radiusForFov(state.fovDeg, state.thetaMaxDeg);
    for (const c of previewLayout().circles) {
      out[GL.physicalLens(state, c.lens)] = {
        cx: c.cx, cy: c.cy, radius: c.radius, crop, circ: c,
        roll: GL.circleDraw(state, c.lens).rollDeg * Math.PI / 180,
      };
    }
    return out;
  }

  const svgEl = (name, attrs, parent) => {
    const el = document.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    if (parent) parent.appendChild(el);
    return el;
  };
  const matchEls = {};
  function buildMatchLayer() {
    matchLayerEl.replaceChildren();
    matchEls.line = svgEl('line', { class: 'm-line' }, matchLayerEl);
    matchEls.arrow = svgEl('polygon', { class: 'm-arrow' }, matchLayerEl);
    for (const role of ['target', 'source']) {
      const g = svgEl('g', { class: 'm-pip m-' + role }, matchLayerEl);
      matchEls[role] = {
        g,
        halo: svgEl('circle', { class: 'm-halo' }, g),
        ring: svgEl('circle', { class: 'm-ring' }, g),
        dot: svgEl('circle', { class: 'm-dot' }, g),
        handle: svgEl('circle', { class: 'm-handle' }, g),
        label: svgEl('text', { class: 'm-label' }, g),
      };
      matchEls[role].label.textContent = role === 'target' ? 'Target' : 'Matching colour';
      bindPip(role);
    }
  }

  // Where each circle is on the canvas now, or null if its lens is not shown.
  function pipOnScreen(pip, discs) {
    const d = discs[pip.lens];
    if (!d) return null;
    const c = WbMatch.lensToScreen(pip.uv, d);
    return { x: c.x, y: c.y, r: WbMatch.radiusToScreen(pip.r, d), disc: d };
  }

  function drawMatch() {
    matchLayerEl.classList.toggle('hidden', !match);
    if (!match || !ctx || !state.sourceLensSize) return;
    const vr = canvas.getBoundingClientRect(), sr = stageEl.getBoundingClientRect();
    matchLayerEl.style.left = (vr.left - sr.left) + 'px';
    matchLayerEl.style.top = (vr.top - sr.top) + 'px';
    matchLayerEl.style.width = vr.width + 'px';
    matchLayerEl.style.height = vr.height + 'px';
    matchLayerEl.setAttribute('viewBox', `0 0 ${canvas.width} ${canvas.height}`);
    const px = canvas.width / Math.max(1, vr.width);   // canvas pixels per CSS pixel
    matchLayerEl.style.setProperty('--px', px);
    const discs = matchDiscs();
    const at = {};
    for (const role of ['target', 'source']) {
      const s = pipOnScreen(match[role], discs), e = matchEls[role];
      at[role] = s;
      e.g.style.display = s ? '' : 'none';
      if (!s) continue;
      for (const c of [e.halo, e.ring]) { c.setAttribute('cx', s.x); c.setAttribute('cy', s.y); c.setAttribute('r', s.r); }
      e.dot.setAttribute('cx', s.x); e.dot.setAttribute('cy', s.y); e.dot.setAttribute('r', 2.5 * px);
      const h = Math.SQRT1_2 * s.r;
      e.handle.setAttribute('cx', s.x + h); e.handle.setAttribute('cy', s.y - h); e.handle.setAttribute('r', 5 * px);
      const pip = match[role];
      e.g.classList.toggle('clipped', !!pip.clipped);
      e.label.textContent = (role === 'target' ? 'Target' : 'Matching colour') + (pip.clipped ? ' – clipped' : '');
      e.label.setAttribute('x', s.x); e.label.setAttribute('y', s.y - s.r - 6 * px);
      e.label.setAttribute('font-size', 11 * px);
    }
    // Rim to rim, the arrow (mid-way) pointing at the circle that changes.
    const line = matchEls.line, arrow = matchEls.arrow;
    const t = at.target, s = at.source;
    const len = t && s ? Math.hypot(s.x - t.x, s.y - t.y) : 0;
    const show = len > t?.r + s?.r + 12 * px;
    line.style.display = show ? '' : 'none';
    arrow.style.display = show ? '' : 'none';
    if (show) {
      const ux = (s.x - t.x) / len, uy = (s.y - t.y) / len;
      const a = { x: t.x + ux * t.r, y: t.y + uy * t.r }, b = { x: s.x - ux * s.r, y: s.y - uy * s.r };
      const head = 10 * px, wing = 5.5 * px;
      line.setAttribute('x1', a.x); line.setAttribute('y1', a.y);
      line.setAttribute('x2', b.x); line.setAttribute('y2', b.y);
      const tip = { x: (a.x + b.x) / 2 + ux * head / 2, y: (a.y + b.y) / 2 + uy * head / 2 };
      const bx = tip.x - ux * head, by = tip.y - uy * head;
      arrow.setAttribute('points', `${tip.x},${tip.y} ${bx - uy * wing},${by + ux * wing} ${bx + uy * wing},${by - ux * wing}`);
    }
  }

  // Drag the body to move a circle, the rim handle to resize it; the
  // wheel resizes too. Dragged onto the other circle's lens, the two
  // change sides: the other one takes the spot this one came from.
  function bindPip(role) {
    const e = matchEls[role];
    const drag = (ev, mode) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      const pip = match[role], start = { ...pip, uv: pip.uv.slice() };
      const target = ev.currentTarget;
      try { target.setPointerCapture(ev.pointerId); } catch (err) { /* synthetic */ }
      const grab = pointerToCanvas(ev);
      const at0 = pipOnScreen(pip, matchDiscs());
      const off = at0 ? { x: at0.x - grab.x, y: at0.y - grab.y } : { x: 0, y: 0 };
      const move = (m) => {
        const p = pointerToCanvas(m), discs = matchDiscs();
        if (mode === 'size') {
          const s = pipOnScreen(pip, discs);
          if (s) pip.r = WbMatch.clampRadius(WbMatch.radiusToLens(Math.hypot(p.x - s.x, p.y - s.y), s.disc));
        } else {
          const q = { x: p.x + off.x, y: p.y + off.y };
          const c = circleAt(q);
          if (c) {
            const lens = GL.physicalLens(state, c.lens);
            pip.lens = lens;
            pip.uv = WbMatch.screenToLens(q, discs[lens]);
          }
        }
        checkClipped(role);
        drawMatch();
      };
      const up = () => {
        target.removeEventListener('pointermove', move);
        target.removeEventListener('pointerup', up);
        target.removeEventListener('pointercancel', up);
        const other = match[role === 'target' ? 'source' : 'target'];
        if (!WbMatch.differentLenses(match.target, match.source)) {
          other.lens = start.lens;
          other.uv = start.uv.slice();
          drawMatch();
        }
        applyMatch();
      };
      target.addEventListener('pointermove', move);
      target.addEventListener('pointerup', up);
      target.addEventListener('pointercancel', up);
    };
    e.ring.addEventListener('pointerdown', (ev) => drag(ev, 'move'));
    e.halo.addEventListener('pointerdown', (ev) => drag(ev, 'move'));
    e.dot.addEventListener('pointerdown', (ev) => drag(ev, 'move'));
    e.label.addEventListener('pointerdown', (ev) => drag(ev, 'move'));
    e.handle.addEventListener('pointerdown', (ev) => drag(ev, 'size'));
    let wheelTimer = null;
    e.g.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      match[role].r = WbMatch.clampRadius(match[role].r * Math.pow(1.1, ev.deltaY < 0 ? 1 : -1));
      drawMatch();
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(applyMatch, 300);
    }, { passive: false });
  }

  // Whether a circle's area is mostly clipped (its colour unknowable), for
  // drawMatch to show -- checked as it is dragged or resized, a few times a
  // second, and whenever it is measured.
  const CLIP_SHOW = 0.5, CLIP_CHECK_MS = 120;
  let clipCheckAt = 0;
  function markClipped(role, m) {
    match[role].clipped = !!m && (m.clippedShare || 0) >= CLIP_SHOW;
  }
  function checkClipped(role) {
    const now = performance.now();
    if (now - clipCheckAt < CLIP_CHECK_MS) return;
    clipCheckAt = now;
    const s = pipOnScreen(match[role], matchDiscs());
    if (!s) return;
    markClipped(role, measurePip(s));
    render();   // measuring drew the tone-off frame
  }

  // The average of a circle, clipped to its lens's photo (inside the Edge
  // falloff start).
  function measurePip(s) {
    const lensR = s.disc.radius * state.edge.falloffStart;
    const rect = { x0: s.x - s.r, y0: s.y - s.r, x1: s.x + s.r, y1: s.y + s.r };
    return measureRegion(rect, (x, y) =>
      Math.hypot(x + 0.5 - s.x, y + 0.5 - s.y) <= s.r &&
      Math.hypot(x + 0.5 - s.disc.cx, y + 0.5 - s.disc.cy) <= lensR);
  }

  function applyMatch() {
    if (!match || (state.isRaw && !state.rawMeta)) return;
    const src = match.source.lens, tgt = match.target.lens;
    const discs = matchDiscs();
    const ts = pipOnScreen(match.target, discs);
    if (!ts || !pipOnScreen(match.source, discs)) { showPickNote('Show both lenses to match them.'); return; }
    const mt = measurePip(ts);
    markClipped('target', mt);
    markClipped('source', measurePip(pipOnScreen(match.source, discs)));
    if (!mt.srgb) { render(); showPickNote('Target: ' + mt.error); return; }
    const wasLinked = state.rawWbLinked;
    if (!state.isRaw) {
      // JPEG: exact in one pass.
      const ms = measurePip(pipOnScreen(match.source, discs));
      if (!ms.srgb) { render(); showPickNote('Matching colour: ' + ms.error); return; }
      const s = JpegWb.solve(jpegAsShot(src, ms.srgb), mt.srgb);
      if (!s) { render(); showPickNote('Those colours leave nothing to match.'); return; }
      commitHistory();
      state.rawWbLinked = false;
      state.jpegWb = Object.assign({ A: { ...state.jpegWb.A }, B: { ...state.jpegWb.B } }, { [src]: { temp: s.temp, tint: s.tint } });
      syncWbControls();
      render();
      scheduleSave();
      commitHistory();
      showPickNote(`Matched lens ${src} to ${tgt}: ${fmtJw(s)}` + (s.atLimit ? ' (at the slider limit)' : '') + '.' +
        (wasLinked ? ' A and B are now unlinked.' : '') +
        (mt.offCanvas || ms.offCanvas ? ' Part of a circle is off screen; only what is shown was sampled.' : ''));
      return;
    }
    const rk = Settings.RANGES.rawWb[src];
    let kt = null, off = mt.offCanvas, atLimit = false;
    commitHistory();
    for (let pass = 0; pass < MATCH_PASSES; pass++) {
      const ms = measurePip(pipOnScreen(match.source, matchDiscs()));
      if (!ms.srgb) { if (pass === 0) { render(); showPickNote('Source: ' + ms.error); return; } break; }
      off = off || ms.offCanvas;
      const n = WbMatch.solve(ms.srgb, mt.srgb, state.rawCamToSrgb[src], state.rawWhiteBalance[src], Dng.mat3Invert);
      if (!n) break;
      const raw = Wb.kelvinTintFromNeutral(n, state.rawMeta.colorMatrix1);
      kt = {
        kelvin: Math.max(rk.kelvin[0], Math.min(rk.kelvin[1], raw.kelvin)),
        tint: Math.max(rk.tint[0], Math.min(rk.tint[1], raw.tint)),
      };
      atLimit = kt.kelvin !== raw.kelvin || kt.tint !== raw.tint;
      state.rawWbLinked = false;
      state.rawWb = Object.assign({}, state.rawWb, { [src]: kt });
      syncWbControls();   // also the neutral and matrix the next pass uses
      if (atLimit) break;
    }
    render();
    scheduleSave();
    commitHistory();
    if (!kt) { showPickNote('Those colours leave nothing to match.'); return; }
    showPickNote(`Matched lens ${src} to ${tgt}: ${Math.round(kt.kelvin)} K, tint ${kt.tint >= 0 ? '+' : ''}${Math.round(kt.tint)}` +
      (atLimit ? ' (at the slider limit)' : '') + '.' + (wasLinked ? ' A and B are now unlinked.' : '') +
      (off ? ' Part of a circle is off screen; only what is shown was sampled.' : ''));
  }

  function startMatch() {
    if (!ctx || !state.sourceLensSize || state.lensCount !== 2) return;
    if (state.sensors !== 'both') { showPickNote('Show both lenses (Sensors: Both) to match them.'); return; }
    const shown = previewLayout().circles.map((c) => GL.physicalLens(state, c.lens));
    match = {
      target: { lens: shown[0], uv: [0.5, 0.5], r: MATCH_START_R },
      source: { lens: shown[1], uv: [0.5, 0.5], r: MATCH_START_R },
    };
    wbMatchEl.setAttribute('aria-pressed', 'true');
    wbMatchSwapEl.classList.remove('hidden');
    showPickNote('Drag the circles onto the same kind of surface in each lens; the lens with the Matching colour circle then matches the Target.');
    drawMatch();
  }

  function stopMatch() {
    match = null;
    wbMatchEl.setAttribute('aria-pressed', 'false');
    wbMatchSwapEl.classList.add('hidden');
    drawMatch();
  }

  buildMatchLayer();
  wbMatchEl.addEventListener('click', () => (match ? stopMatch() : startMatch()));
  wbMatchSwapEl.addEventListener('click', () => {
    if (!match) return;
    match = { target: match.source, source: match.target };
    drawMatch();
    applyMatch();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && match && !tool && !numBySlider.has(document.activeElement)) stopMatch();
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

  // DNG is only offered for raw sources; loading a JPEG/.insp while it is
  // selected falls back to JPEG.
  // A merged HDR photo can't be written as DNG yet (the 16-bit writer
  // would clip it): it exports as JPEG while DNG stays the chosen format
  // for the raw photos.
  const isMergedHdr = () => !!(state.rawMeta && state.rawMeta.floatPlanes);
  function effectiveFormat() {
    return state.format === 'dng' && isMergedHdr() ? 'jpeg' : state.format;
  }
  function updateExportLabel() {
    const dngOpt = formatEl.querySelector('option[value="dng"]');
    dngOpt.disabled = !state.isRaw || isMergedHdr();
    dngOpt.title = isMergedHdr() ? 'DNG of a merged HDR photo comes with HDR export' : '';
    if (state.format === 'dng' && !state.isRaw) state.format = 'jpeg';
    const fmt = effectiveFormat();
    formatEl.value = fmt;
    exportBtn.textContent = { png: 'Export PNG', dng: 'Export DNG' }[fmt] || 'Export JPEG';
    qualityEl.disabled = fmt !== 'jpeg';
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
  // Renders `renderState` at full export resolution into a new 2D canvas
  // and returns it, or reports why it can't (fail) and returns null.
  // Synchronous, so a print can use it from inside `beforeprint`.
  function renderFullCanvas(renderState, verb) {
    const g = GL.exportGeometry(renderState);
    const gl = ctx.gl;
    let target = null;
    const smaller = `Try a smaller FOV, remove padding, or ${verb} one lens at a time.`;
    try {
      const limit = Math.min(ctx.maxTextureSize, ctx.maxRenderbufferSize);
      if (g.width > limit || g.height > limit) {
        fail(`This GPU caps render targets at ${limit}px; the requested ${verb} ` +
          `(${g.width}x${g.height}) exceeds it. ` + smaller);
        return null;
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
          `(it gave ${outCanvas.width}x${outCanvas.height} instead). ` + smaller);
        return null;
      }
      target = GL.makeExportTarget(gl, g.width, g.height);
      if (!target.complete) {
        fail(`This GPU could not allocate a ${g.width}x${g.height} render target ` +
          `(framebuffer status ${target.status}). ` + smaller);
        return null;
      }
      GL.renderComposition(ctx, renderState, g.width, g.height, target.fbo);

      const c2d = outCanvas.getContext('2d');
      GL.readCompositionStrips(gl, target.fbo, g.width, g.height, EXPORT_STRIP_ROWS,
        (rowsRGBA, outY, rows) => {
          const clamped = new Uint8ClampedArray(rowsRGBA.buffer, rowsRGBA.byteOffset, rowsRGBA.length);
          c2d.putImageData(new ImageData(clamped, g.width, rows), 0, outY);
        });
      return outCanvas;
    } finally {
      if (target) GL.deleteExportTarget(gl, target);
    }
  }

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
    if (opts.format === 'dng') return exportDng(exportState);
    const g = GL.exportGeometry(exportState);
    try {
      // Developing on the CPU: wait for the current settings' result.
      await GL.developSettled(ctx, exportState);
      const outCanvas = renderFullCanvas(exportState, 'export');
      if (!outCanvas) return false;

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
      return true;
    } catch (e) {
      fail(e.message === 'TOBLOB_FAILED'
        ? `The browser could not encode a ${g.width}x${g.height} image. ` +
          'Try PNG, a smaller FOV, or exporting one lens at a time.'
        : 'Export failed: ' + e.message);
      return false;
    }
  }

  // DNG export (raw sources): renders linear camera RGB with the lens edge
  // (COMPOSITE_DNG_FS) into a float target at full export size and writes
  // a 16-bit linear-raw DNG. Tone and detail are left to the raw converter;
  // white balance goes in as AsShotNeutral -- the first shown lens's, with
  // the other lens's pixels re-expressed so it keeps its own balance.
  function exportDng(exportState) {
    const physical = Settings.visibleLenses(state, GL.physicalLens)[0];
    const neutral = state.rawWhiteBalance[physical];
    const meta = state.rawMeta;
    // The background colour is display sRGB; the file wants camera RGB.
    const bgLin = state.background.map(Wb.srgbDecode);
    const toCam = Dng.mat3Invert(Dng.camToSrgbForNeutral(meta.colorMatrix1, neutral));
    const bgCam = toCam
      ? [0, 1, 2].map((i) => Math.min(1, Math.max(0,
        neutral[i] * (toCam[i * 3] * bgLin[0] + toCam[i * 3 + 1] * bgLin[1] + toCam[i * 3 + 2] * bgLin[2]))))
      : [0, 0, 0];
    const dngState = Object.assign({}, exportState, {
      dngOutput: true, dngNeutral: neutral, background: bgCam,
    });
    const g = GL.exportGeometry(dngState);
    const gl = ctx.gl;
    const smaller = 'Try a smaller FOV, remove padding, or export one lens at a time.';
    const limit = Math.min(ctx.maxTextureSize, ctx.maxRenderbufferSize);
    if (g.width > limit || g.height > limit) {
      fail(`This GPU caps render targets at ${limit}px; the requested export ` +
        `(${g.width}x${g.height}) exceeds it. ` + smaller);
      return false;
    }
    let target = null;
    try {
      target = GL.makeFloatExportTarget(gl, g.width, g.height, ctx.floatBlend);
      if (!target.complete) {
        fail(`This GPU could not allocate a ${g.width}x${g.height} float render target ` +
          `(framebuffer status ${target.status}). ` + smaller);
        return false;
      }
      GL.renderComposition(ctx, dngState, g.width, g.height, target.fbo);
      const data = new Uint16Array(g.width * g.height * 3);
      GL.readCompositionStripsFloat(gl, target.fbo, g.width, g.height, 64, (rows, outY, n) => {
        let o = outY * g.width * 3;
        for (let i = 0; i < g.width * n * 4; i += 4) {
          data[o++] = Math.round(rows[i] * 65535);
          data[o++] = Math.round(rows[i + 1] * 65535);
          data[o++] = Math.round(rows[i + 2] * 65535);
        }
      });
      const bytes = DngWrite.write({
        width: g.width, height: g.height, data,
        colorMatrix1: meta.colorMatrix1, calibrationIlluminant1: meta.calibrationIlluminant1,
        asShotNeutral: neutral, make: meta.make, model: meta.model, dateTime: meta.dateTime,
      });
      download(new Blob([bytes], { type: 'image/x-adobe-dng' }),
        Lens.exportFilename(state.sourceName, GL.exportLabel(state), state.fovDeg, 'dng'));
      return true;
    } catch (e) {
      fail('DNG export failed: ' + e.message);
      return false;
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

  // Export with several photos selected: opens, renders and saves each in
  // turn with its own edits and the current Output settings (a DNG only
  // for raw photos; the others as JPEG), then returns to the photo that
  // was open. Esc stops after the photo being written.
  let exportRun = null;
  async function exportSelected() {
    if (exportRun) return;
    const targets = photos.selected();
    const back = currentPhoto();
    const opts = { format: state.format, quality: state.quality, padToSensorSquare: state.padToSensorSquare };
    exportRun = { cancel: false };
    let done = 0;
    const failed = [];
    try {
      for (let i = 0; i < targets.length && !exportRun.cancel; i++) {
        stripNote('Exporting ' + (i + 1) + ' of ' + targets.length + ' — Esc to stop');
        const ok = (await openPhoto(targets[i], true)) &&
          (await exportImage(Object.assign({}, opts, { format: opts.format === 'dng' && (!state.isRaw || isMergedHdr()) ? 'jpeg' : opts.format })));
        if (ok) done++;
        else failed.push(Photos.nameOf(targets[i]) + (errorEl.textContent ? ' (' + errorEl.textContent + ')' : ''));
      }
    } finally {
      const stopped = exportRun.cancel;
      state.format = opts.format;
      if (back && photos.byId(back.id)) await openPhoto(back, true);
      exportRun = null;
      for (const e of targets) if (photos.byId(e.id) && e.id !== photos.currentId) photos.select(e.id, 'toggle');
      drawStrip();
      stripNote((stopped ? 'Export stopped: ' : 'Exported ') + done + (done === 1 ? ' photo' : ' photos'));
      if (failed.length) fail('Not exported: ' + failed.join('; '));
    }
  }
  document.addEventListener('keydown', (e) => {
    if (exportRun && e.key === 'Escape') { exportRun.cancel = true; e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);

  exportBtn.addEventListener('click', () => {
    if (!ctx || !state.sourceLensSize) return;
    if (photos.selected().length > 1) { exportSelected(); return; }
    exportImage({ format: effectiveFormat(), quality: state.quality, padToSensorSquare: state.padToSensorSquare });
  });

  // Print: the same full-resolution render as Export (same geometry and
  // padding, no encode), shown alone on the page by the print stylesheet
  // in index.html. The Print button and Ctrl/Cmd+P prepare it and then open
  // the dialog; a print started from the browser's menu is caught in
  // `beforeprint`, which is synchronous, and prepared there. The canvas
  // (hundreds of MB for a dual frame) is dropped once the dialog closes.
  function preparePrint() {
    if (!ctx || !state.sourceLensSize) return false;
    if (document.body.classList.contains('print-ready')) return true;
    clearMessages();
    let c = null;
    try {
      c = renderFullCanvas(state, 'print');
    } catch (e) {
      fail('Print failed: ' + e.message);
    }
    if (!c) return false;
    printBoxEl.replaceChildren(c);
    document.body.classList.add('print-ready');
    return true;
  }
  function releasePrint() {
    printBoxEl.replaceChildren();
    document.body.classList.remove('print-ready');
  }
  async function printImage() {
    if (!ctx || !state.sourceLensSize) return;
    try {
      await GL.developSettled(ctx, state);
    } catch (e) {
      fail('Print failed: ' + e.message);
      return;
    }
    if (preparePrint()) window.print();
  }
  printBtn.addEventListener('click', printImage);

  // -- History (Ctrl+Z) ---------------------------------------------------
  // Every edit reaches scheduleSave(), so that is where history hears of
  // it (noteEdit). A change is recorded once it has settled -- HISTORY_IDLE_MS
  // after the last input, and not while a pointer is still down -- so a
  // slider drag, or a held arrow key, is one step. Snapshots are the
  // persisted settings minus the view preferences (history.js).
  const HISTORY_IDLE_MS = 400;
  let editHistory = History.create();   // the open photo's (applyLoadedDescriptor swaps it)
  let historyTimer = null, historyPending = false, pointerHeld = false, restoring = false;
  const editSnapshot = () => History.editSnapshot(Settings.serialize(state));

  function noteEdit() {
    if (restoring) return;
    if (beforeView) { beforeView = false; updateBeforeBadge(); requestRender(); }
    historyPending = true;
    const cur = currentPhoto();
    if (cur && !cur.edited) { cur.edited = true; drawStrip(); }
    if (historyTimer) clearTimeout(historyTimer);
    historyTimer = setTimeout(() => { historyTimer = null; if (!pointerHeld) commitHistory(); }, HISTORY_IDLE_MS);
  }

  function commitHistory() {
    if (historyTimer) { clearTimeout(historyTimer); historyTimer = null; }
    if (!historyPending) return;
    historyPending = false;
    if (editHistory.record(editSnapshot())) { storeCurrent(); scheduleThumb(); }
  }

  function resetHistory() {
    if (historyTimer) { clearTimeout(historyTimer); historyTimer = null; }
    historyPending = false;
    editHistory.reset(editSnapshot());
  }

  document.addEventListener('pointerdown', () => { pointerHeld = true; }, true);
  const pointerDone = () => {
    pointerHeld = false;
    if (historyPending && !historyTimer) commitHistory();
  };
  document.addEventListener('pointerup', pointerDone, true);
  document.addEventListener('pointercancel', pointerDone, true);

  function applySnapshot(snap) {
    restoring = true;
    try {
      Object.assign(state, snap);
      syncControlsFromState();
      updateSensorsAvailability();
      updateSwapAvailability();
      render();
      saveSettings();
    } finally {
      restoring = false;
    }
    scheduleThumb();
  }

  function undo() {
    commitHistory();
    const s = editHistory.undo();
    if (s) applySnapshot(s);
  }
  function redo() {
    commitHistory();
    const s = editHistory.redo();
    if (s) applySnapshot(s);
  }

  // -- Photos (the strip: photos.js, strip.js, thumbs.js) -------------------
  // Any number of files can be open; only one -- the current photo -- is
  // decoded onto the GPU (loadFile). Switching keeps the photo being left's
  // edits and undo history in its strip entry, and its edits in storage
  // (by name, size and date) once it has been edited, so it opens again as
  // it was left, now or on a later visit. A photo never opened starts from
  // the settings in use (the last-used ones), as a single file always did.
  const photos = Photos.createList();
  const photoStore = Photos.createStore(window.localStorage);
  const stripNoteEl = document.getElementById('stripNote');
  let loadingId = null;
  const strip = Strip.create(document.getElementById('strip'), {
    open: (id) => { const e = photos.byId(id); if (e) openPhoto(e); },
    select: (id, mode) => { photos.select(id, mode); drawStrip(); },
    remove: (id) => removePhoto(id),
    selectSet: (id) => selectSet(id),
    toggle: () => { state.stripShown = !state.stripShown; saveSettings(); drawStrip(); },
  });
  function drawStrip(scroll) {
    strip.render(photos, { shown: state.stripShown, loadingId, scroll });
    // Merge HDR: the selected raw photos, when they can merge.
    const sel = photos.selected().filter((e) => e.dng && !e.members);
    const can = HdrMerge.canMerge(sel.map((e) => e.dng));
    mergeHdrBtn.disabled = !can.ok || !!exportRun;
    mergeHdrBtn.title = can.ok ? 'Merge the ' + sel.length + ' selected exposures into one HDR photo' : can.reason;
    // Several selected: Export writes each of them (exportSelected).
    updateExportLabel();
    const n = photos.selected().length;
    if (n > 1) exportBtn.textContent = exportBtn.textContent.replace(/^Export/, 'Export ' + n);
  }
  function stripNote(text) { stripNoteEl.textContent = text || ''; }
  const currentPhoto = () => photos.byId(photos.currentId);
  // Where next / previous count from: the photo being opened, if any, so
  // quick key presses walk on instead of reopening the same neighbour.
  const targetPhoto = () => photos.byId(loadingId) || currentPhoto();

  // The open photo's edits into its entry and, once edited, storage: at
  // every settled change (commitHistory), so they survive the tab closing,
  // and when leaving it.
  function storeCurrent() {
    const cur = currentPhoto();
    if (!cur || !loaded()) return;
    // A copy: the snapshot shares objects (tone, detail...) with the live
    // state, which the next photo's sliders change in place.
    cur.edits = JSON.parse(JSON.stringify(editSnapshot()));
    if (cur.edited) photoStore.save(cur.key, cur.edits);
    warnIfStoreFull();
  }
  // Kept on screen: shown again after each load (which clears the
  // messages as it starts), never while one is starting.
  function warnIfStoreFull() {
    if (!photoStore.fellBack || loadingId !== null) return;
    warn('Browser storage is full or unavailable: edits are kept only until this page is closed.');
  }

  function leavePhoto() {
    const cur = currentPhoto();
    if (!cur || !loaded()) return;
    commitHistory();
    cur.history = editHistory;
    storeCurrent();
    if (!cur.rendered || zoom) snapshotThumb(cur, true);
  }

  // `byExport`: Export N's own switching; nothing else switches meanwhile.
  async function openPhoto(entry, byExport) {
    if (exportRun && !byExport) return false;
    if (entry.id === photos.currentId && loaded() && loadingId === null) return true;
    leavePhoto();
    loadingId = entry.id;
    drawStrip();
    const edits = entry.edits || photoStore.load(entry.key);
    const source = entry.members ? { members: entry.members.map((m) => m.file), name: entry.name } : entry.file;
    const ok = await loadFile(source, { edits, history: entry.history, beforeCommit: leavePhoto });
    // A merged photo opened for the first time starts from Auto tone, so
    // the highlights it recovered show at once.
    if (ok && entry.members && !edits) {
      restoring = true;
      try { autoTone(); } finally { restoring = false; }
      resetHistory();
    }
    if (ok) {
      photos.currentId = entry.id;
      photos.select(entry.id, 'only');
      entry.error = null;
    } else if (loadingId === entry.id && errorEl.textContent) {
      entry.error = errorEl.textContent;
    }
    if (loadingId === entry.id) loadingId = null;
    if (ok && entry.pastedPending) {
      // Edits pasted while it was closed: one undo step on its history.
      entry.pastedPending = false;
      historyPending = true;
      commitHistory();
    }
    drawStrip(true);
    if (ok) scheduleThumb();
    warnIfStoreFull();
    return ok;
  }

  // The open photo's strip thumbnail, as edited: the preview canvas cropped
  // to the composition (previewPlace), copied straight after a render (a
  // WebGL canvas can only be read in the task that drew it). At Fit the
  // canvas holds the whole composition; zoomed in, only `force` (leaving
  // the photo) renders once at Fit for it.
  function snapshotThumb(entry, force) {
    if (!entry || entry.id !== photos.currentId || !loaded() || beforeView) return;
    if (zoom && !force) return;
    const saved = zoom;
    zoom = null;
    render();
    const p = previewPlace;
    const s = Thumbs.SIZE / Math.max(p.w, p.h);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(p.w * s));
    c.height = Math.max(1, Math.round(p.h * s));
    c.getContext('2d').drawImage(canvas, p.x, p.y, p.w, p.h, 0, 0, c.width, c.height);
    if (saved) { zoom = saved; render(); }
    c.toBlob((b) => {
      if (!b || !photos.byId(entry.id)) return;
      if (entry.thumb) URL.revokeObjectURL(entry.thumb);
      entry.thumb = URL.createObjectURL(b);
      entry.rendered = true;
      drawStrip();
    }, 'image/jpeg', 0.85);
  }
  // After an edit settles or a photo opens -- once Detail has developed,
  // when that runs on the CPU in the background.
  let thumbFrame = 0;
  function scheduleThumb() {
    const entry = currentPhoto();
    if (!entry || !ctx) return;
    GL.developSettled(ctx, state).catch(() => {}).then(() => {
      if (thumbFrame) cancelAnimationFrame(thumbFrame);
      thumbFrame = requestAnimationFrame(() => { thumbFrame = 0; snapshotThumb(entry); });
    });
  }

  // Copy / paste edits (Ctrl+Shift+C / V): every edit (Photos.pasteable),
  // onto every selected photo. A photo that is not
  // open gets them in its stored edits, and as an undo step when it opens.
  let clipboardEdits = null;
  const copyEditsBtn = document.getElementById('copyEdits');
  const pasteEditsBtn = document.getElementById('pasteEdits');
  function copyEdits() {
    if (!loaded()) return false;
    commitHistory();
    clipboardEdits = Photos.pasteable(editSnapshot());
    pasteEditsBtn.disabled = false;
    stripNote(photos.entries.length > 1 ? 'Edits copied — Ctrl-click photos, then Paste' : 'Edits copied');
  }
  function pasteEdits() {
    if (!clipboardEdits || !loaded()) return false;
    const targets = photos.selected();
    for (const e of targets) {
      const edits = JSON.parse(JSON.stringify(clipboardEdits));
      if (e.id === photos.currentId) {
        // The lens-count guards a load applies (applyLoadedDescriptor).
        if (state.lensCount === 1) edits.sensors = 'A';
        if ('swap' in edits) edits.swap = Settings.resolveSwapForLoad(edits.swap, state.lensCount);
        commitHistory();
        applySnapshot(Object.assign(editSnapshot(), edits));
        historyPending = true;
        commitHistory();
        e.edited = true;
      } else {
        const base = e.edits || photoStore.load(e.key) || {};
        e.edits = Object.assign({}, base, edits);
        e.edited = true;
        e.pastedPending = true;
        photoStore.save(e.key, e.edits);
        warnIfStoreFull();
        // Its rendered thumbnail is out of date: back to the quick one.
        if (e.rendered) {
          e.rendered = false;
          if (e.thumb) URL.revokeObjectURL(e.thumb);
          e.thumb = null;
          queueThumbs([e]);
        }
      }
    }
    drawStrip();
    stripNote('Edits pasted onto ' + targets.length + (targets.length === 1 ? ' photo' : ' photos'));
  }
  copyEditsBtn.addEventListener('click', () => copyEdits());
  pasteEditsBtn.addEventListener('click', () => pasteEdits());

  // New files join the strip (a file already in it is not added twice).
  // The first opens when nothing is open yet, and a single file chosen or
  // dropped on its own opens straight away, as it always did.
  function addFiles(files) {
    const list = Array.from(files);
    const { added, skipped } = photos.add(list);
    for (const e of added) e.edited = photoStore.has(e.key);
    drawStrip();
    queueThumbs(added);
    let opened = Promise.resolve(false);
    if (list.length === 1 && !skipped.length) {
      const e = added[0] || photos.entries.find((x) => x.key === Photos.keyOf(list[0]));
      if (e) opened = openPhoto(e);
    } else if (added.length && !loaded() && loadingId === null) {
      opened = openPhoto(added[0]);
    }
    // After openPhoto, whose load clears the messages as it starts.
    if (skipped.length) warn('Not a photo this app opens (.insp, .jpg, .dng): ' + skipped.join(', '));
    return opened;
  }

  async function removePhoto(id) {
    const e = photos.byId(id);
    if (!e || exportRun) return;
    if (id === loadingId) { loadSeq++; loadingId = null; }
    const wasCurrent = id === photos.currentId;
    if (wasCurrent) leavePhoto();
    const next = photos.remove(id);
    if (e.thumb) URL.revokeObjectURL(e.thumb);
    if (e.dng) updateSets();
    if (wasCurrent) {
      photos.currentId = null;
      if (next) await openPhoto(next);
      else closePhoto();
    }
    drawStrip();
  }

  // The last photo removed: back to the empty drop screen.
  function closePhoto() {
    loadSeq++;
    if (ctx) for (let i = 0; i < 2; i++) GL.releaseLens(ctx, i);
    stopMatch();
    Object.assign(state, { sourceName: '', sourceLensSize: 0 });
    document.body.classList.remove('loaded');
    dropEl.classList.remove('hidden');
    exportBtn.disabled = true;
    printBtn.disabled = true;
    updateFileHeader();
    editHistory = History.create();
    resetHistory();
  }

  // Quick thumbnails (thumbs.js), one file at a time in the background.
  let thumbQueue = Promise.resolve();
  function queueThumbs(entries) {
    for (const e of entries) {
      thumbQueue = thumbQueue.then(async () => {
        if (!e.file || !photos.byId(e.id)) return;
        // A DNG's header: exposure and capture time, for bracket sets.
        if (/\.dng$/i.test(e.file.name) && e.dng === undefined) {
          e.dng = await Thumbs.dngHeader(e.file);
          updateSets();
        }
        if (e.thumb || !photos.byId(e.id)) return;
        try {
          const blob = await Thumbs.quick(e.file);
          if (e.thumb || !photos.byId(e.id)) return;
          e.thumb = URL.createObjectURL(blob);
          drawStrip();
        } catch (err) { /* the tile keeps its name on black */ }
      });
    }
  }

  // -- HDR: bracket sets and merging (hdrmerge.js) --
  const mergeHdrBtn = document.getElementById('mergeHdr');
  function updateSets() {
    const sets = HdrMerge.detectSets(photos.entries.filter((e) => e.dng && !e.members)
      .map((e) => ({ id: e.id, meta: e.dng })));
    for (const e of photos.entries) e.set = null;
    for (const s of sets) for (const id of s) photos.byId(id).set = s;
    drawStrip();
  }
  function selectSet(id) {
    const e = photos.byId(id);
    if (!e || !e.set) return;
    const have = new Set(photos.selected().map((x) => x.id));
    for (const x of e.set) if (!have.has(x)) photos.select(x, 'toggle');
    drawStrip();
  }
  // The selected exposures merged into a new photo after the last of them
  // (or the one already made from them), opened.
  function mergeSelected() {
    if (exportRun) return Promise.resolve(false);
    const sel = photos.selected().filter((e) => e.dng && !e.members)
      .sort((a, b) => photos.indexOf(a.id) - photos.indexOf(b.id));
    if (!HdrMerge.canMerge(sel.map((e) => e.dng)).ok) return Promise.resolve(false);
    const key = HdrMerge.mergeKey(sel.map((e) => e.key));
    const stem = Photos.nameOf(sel[0]).replace(/\.[^.]+$/, '');
    const entry = photos.insertAfter(sel[sel.length - 1].id, { key, name: stem + '_HDR', members: sel });
    entry.edited = photoStore.has(key);
    drawStrip();
    return openPhoto(entry);
  }
  mergeHdrBtn.addEventListener('click', () => mergeSelected());

  function stepPhoto(dir) {
    const from = targetPhoto();
    const next = from && photos.neighbour(from.id, dir);
    if (!next) return false;
    openPhoto(next);
  }

  // -- Keyboard shortcuts (shortcuts.js) -----------------------------------
  // Up / down (and , / .) walk the sliders of the open sections in page
  // order; from nothing they resume at the slider last used.
  const beforeBadgeEl = document.getElementById('beforeBadge');
  const helpEl = document.getElementById('help');
  const helpBtnEl = document.getElementById('helpToggle');
  let lastSlider = null;
  const sliderEls = Object.values(NUM).map((d) => d.slider);
  const numBySlider = new Map(Object.values(NUM).map((d) => [d.slider, d]));
  document.addEventListener('focusin', (e) => { if (numBySlider.has(e.target)) lastSlider = e.target; });

  function visibleSliders() {
    const all = Array.from(document.querySelectorAll('input[type=range]')).filter((el) => sliderEls.includes(el));
    // A collapsed section's sliders still have a layout box in current
    // Chrome, so the closed <details> is checked for explicitly.
    return all.filter((el) => !el.disabled && !el.closest('details:not([open])') &&
      (el.checkVisibility ? el.checkVisibility() : el.getClientRects().length > 0));
  }

  function moveSlider(dir, from) {
    const list = visibleSliders();
    const active = from || (numBySlider.has(document.activeElement) ? document.activeElement : null);
    let next;
    if (!active && lastSlider && list.includes(lastSlider)) next = lastSlider;
    else next = list[Shortcuts.step(list.indexOf(active), list.length, dir)];
    if (!next) return;
    next.focus();
    next.scrollIntoView({ block: 'nearest' });
  }

  // B: black & white on / off, one undo step each.
  function toggleMono() {
    if (!loaded()) return false;
    commitHistory();
    setMono(!state.tone.mono);
    commitHistory();
  }

  // R / Shift+R: Camera roll a quarter turn either way.
  function rotateBy(dir) {
    if (!loaded()) return false;
    // Each press is its own undo step, however quick the next one.
    commitHistory();
    commitNum(NUM.roll, Shortcuts.rotated(state.rollDeg, dir));
    reflectNum(NUM.roll, true);
    commitHistory();
  }

  // Slider drags are run here rather than by the browser, so Shift can
  // switch to fine (a tenth of the speed) at any moment of a drag -- the
  // browser's own drag can't be changed once it has started. A press
  // without Shift jumps the thumb to the pointer, as the browser's does;
  // with Shift it stays where it was. Pressing or letting go of Shift
  // mid-drag re-anchors at the current value, so the thumb never jumps.
  const FINE_DRAG = 0.1;
  const THUMB_PX = 11;   // index.html's slider thumb
  for (const d of Object.values(NUM)) {
    const s = d.slider;
    s.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || s.disabled) return;
      e.preventDefault();
      s.focus();
      try { s.setPointerCapture(e.pointerId); } catch (err) { /* a synthetic or lost pointer */ }
      const min = parseFloat(s.min), max = parseFloat(s.max);
      const rect = s.getBoundingClientRect();
      const track = Math.max(1, rect.width - THUMB_PX);
      const set = (v) => {
        const before = s.value;
        s.value = Math.min(max, Math.max(min, v));
        if (s.value !== before) commitNum(d, fromSlider(d, parseFloat(s.value)));
      };
      if (!e.shiftKey) set(min + (e.clientX - rect.left - THUMB_PX / 2) / track * (max - min));
      let x0 = e.clientX, v0 = parseFloat(s.value), fine = e.shiftKey;
      const move = (m) => {
        if (m.shiftKey !== fine) { fine = m.shiftKey; x0 = m.clientX; v0 = parseFloat(s.value); }
        set(v0 + (m.clientX - x0) / track * (max - min) * (fine ? FINE_DRAG : 1));
      };
      const end = () => {
        s.removeEventListener('pointermove', move);
        s.removeEventListener('pointerup', end);
        s.removeEventListener('pointercancel', end);
      };
      s.addEventListener('pointermove', move);
      s.addEventListener('pointerup', end);
      s.addEventListener('pointercancel', end);
    });
  }

  function updateBeforeBadge() {
    beforeBadgeEl.classList.toggle('hidden', !beforeView);
  }

  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || '');
  function buildHelp() {
    const list = helpEl.querySelector('.keys');
    list.replaceChildren();
    let group = null;
    for (const row of Shortcuts.TABLE) {
      if (row.group !== group) {
        group = row.group;
        const h = document.createElement('div');
        h.className = 'sub-h';
        h.textContent = group;
        list.appendChild(h);
      }
      const r = document.createElement('div');
      r.className = 'key-row';
      const k = document.createElement('kbd');
      const show = Shortcuts.showFor(row, state.keyLayout);
      k.textContent = isMac ? show.replace(/Ctrl\+/g, '⌘').replace(/Shift\+/g, '⇧') : show;
      const l = document.createElement('span');
      l.textContent = row.label;
      r.append(l, k);
      list.appendChild(r);
    }
  }
  function toggleHelp(show) {
    const on = show === undefined ? helpEl.classList.contains('hidden') : show;
    helpEl.classList.toggle('hidden', !on);
    helpBtnEl.setAttribute('aria-pressed', String(on));
  }
  buildHelp();
  // The keyboard layout (a preference, saved with the settings).
  const keyLayoutEl = document.getElementById('keyLayout');
  keyLayoutEl.value = state.keyLayout;
  keyLayoutEl.addEventListener('input', () => {
    state.keyLayout = keyLayoutEl.value;
    buildHelp();
    saveSettings();
  });
  helpBtnEl.addEventListener('click', () => toggleHelp());
  helpEl.querySelector('.close').addEventListener('click', () => toggleHelp(false));

  const loaded = () => !!(ctx && state.sourceLensSize);
  const ACTIONS = {
    undo, redo,
    prevSlider: () => moveSlider(-1),
    nextSlider: () => moveSlider(1),
    nudgeUp: (e) => nudgeKey(numBySlider.get(document.activeElement),
      { key: 'ArrowRight', shiftKey: e.shiftKey && e.key !== '+', ctrlKey: false, metaKey: false, altKey: false, preventDefault() {} }),
    nudgeDown: (e) => nudgeKey(numBySlider.get(document.activeElement),
      { key: 'ArrowLeft', shiftKey: e.shiftKey, ctrlKey: false, metaKey: false, altKey: false, preventDefault() {} }),
    resetSlider: () => resetNum(numBySlider.get(document.activeElement)),
    leaveSlider: () => document.activeElement.blur(),
    toggleZoom: () => { if (!loaded()) return false; if (zoom) zoomToFit(); else setZoom(1); },
    zoomFit: () => { if (!loaded()) return false; zoomToFit(); },
    zoom100: () => { if (!loaded()) return false; setZoom(1); },
    zoomIn: () => { if (!loaded()) return false; stepZoomBy(1); },
    zoomOut: () => { if (!loaded()) return false; stepZoomBy(-1); },
    autoWb: () => autoWhiteBalance(),
    toggleMono: () => toggleMono(),
    rotateCw: () => rotateBy(1),
    rotateCcw: () => rotateBy(-1),
    // Before / after: shown while the key is held (see the keyup below).
    beforeAfter: (e) => {
      if (!loaded()) return false;
      if (e.repeat || beforeView) return;
      setBeforeView(true);
    },
    open: () => { fileEl.click(); },
    export: () => { if (!loaded() || exportBtn.disabled) return false; exportBtn.click(); },
    // With nothing loaded, Ctrl+P is the browser's own print.
    print: () => { if (!loaded()) return false; printImage(); },
    help: () => toggleHelp(),
    copyEdits: () => copyEdits(),
    pasteEdits: () => pasteEdits(),
    nextPhoto: () => stepPhoto(1),
    prevPhoto: () => stepPhoto(-1),
  };

  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.isComposing) return;
    const a = document.activeElement;
    if (e.key === 'Escape' && !helpEl.classList.contains('hidden')) { toggleHelp(false); e.preventDefault(); return; }
    const typing = !!a && (a.tagName === 'SELECT' || a.tagName === 'TEXTAREA' ||
      (a.tagName === 'INPUT' && a.type !== 'range' && a.type !== 'checkbox'));
    const action = Shortcuts.match(e, { typing, onSlider: numBySlider.has(a), layout: state.keyLayout });
    if (!action || !ACTIONS[action]) return;
    if (ACTIONS[action](e) === false) return;
    e.preventDefault();
  });

  function setBeforeView(on) {
    if (beforeView === on) return;
    beforeView = on;
    updateBeforeBadge();
    render();
  }
  // Letting go of the before / after key (or the window losing focus while
  // it is held) goes back to the edited picture.
  document.addEventListener('keyup', (e) => {
    if (!beforeView) return;
    const a = document.activeElement;
    if (Shortcuts.match(e, { typing: false, onSlider: numBySlider.has(a), layout: state.keyLayout }) === 'beforeAfter') {
      setBeforeView(false);
    }
  });
  window.addEventListener('blur', () => setBeforeView(false));

  window.addEventListener('beforeprint', preparePrint);
  window.addEventListener('afterprint', releasePrint);

  loadSettings();
  resetHistory();
  keyLayoutEl.value = state.keyLayout;
  buildHelp();
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
  fileEl.addEventListener('change', () => {
    if (fileEl.files.length) addFiles(fileEl.files);
    fileEl.value = '';   // choosing the same file again still fires
  });
  document.addEventListener('dragover', (e) => { e.preventDefault(); });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
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
    ensureCtx();
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

  // Browser-side JS/GLSL parity for the global tone (Task 19): renders
  // Shaders.TONE_PARITY_FS -- COMPOSITE_FS's own TONE_GLSL -- over 256
  // synthetic inputs for each of a set of tone settings (every control at
  // its extremes, alone and combined, plus exposure pushing luminance past
  // 1 and pure black with lifted Blacks), reads the float results back and
  // compares them with Edge.applyTone on the same inputs.
  const TONE_PARITY_CASES = (() => {
    const z = { exposureEv: 0, contrast: 0, saturation: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0 };
    const cases = [z];
    for (const k of CURVE_KEYS) for (const v of [-100, -35, 60, 100]) cases.push({ ...z, [k]: v });
    for (const h of [-100, 100]) for (const s of [-100, 100]) for (const w of [-100, 100]) for (const b of [-100, 100]) {
      cases.push({ ...z, highlights: h, shadows: s, whites: w, blacks: b });
    }
    cases.push({ exposureEv: 1.5, contrast: 0.3, saturation: -0.4, highlights: -70, shadows: 45, whites: 20, blacks: -15 });
    cases.push({ exposureEv: -2, contrast: -0.5, saturation: 0.8, highlights: 30, shadows: -60, whites: -80, blacks: 90 });
    cases.push({ exposureEv: 0.6, contrast: 0.2, saturation: 0.1, highlights: 0, shadows: 0, whites: 0, blacks: 0 });
    return cases;
  })();

  function toneParityInput(x) {
    return [x / 255, (255 - x) / 255 * 0.8 + 0.1, ((x * 37) % 256) / 255];
  }
  // TONE_PARITY_FS's local base coefficients (A, B) at x.
  function toneParityCoef(x) {
    return [((x * 29) % 64) / 64, ((x * 13) % 32) / 64];
  }

  function checkToneParity() {
    ensureCtx();
    const gl = ctx.gl;
    const prog = GL.program(gl, Shaders.FULLSCREEN_VS, Shaders.TONE_PARITY_FS);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 256, 1, 0, gl.RGBA, gl.FLOAT, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindVertexArray(ctx.vao);
    gl.disable(gl.BLEND);
    gl.viewport(0, 0, 256, 1);
    gl.useProgram(prog);
    const u = (n) => gl.getUniformLocation(prog, n);
    const out = new Float32Array(256 * 4);
    let maxDiff = 0, worst = null;
    // rawMax 4 and 16: a merged HDR photo (the shoulder), inputs up to its
    // brightest value.
    for (const rawMax of [1, 4, 16]) {
    const scale = rawMax > 1 ? Edge.srgbEncode(rawMax) : 1;
    gl.uniform1f(u('uRawMax'), rawMax);
    gl.uniform1f(u('uInputScale'), scale);
    for (const local of [false, true]) {
      for (const t of TONE_PARITY_CASES) {
        gl.uniform3f(u('uTone'), t.exposureEv, t.contrast, t.saturation);
        gl.uniform4f(u('uToneCurve'), t.highlights, t.shadows, t.whites, t.blacks);
        gl.uniform1f(u('uLocal'), local ? 1 : 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.readPixels(0, 0, 256, 1, gl.RGBA, gl.FLOAT, out);
        for (let x = 0; x < 256; x++) {
          const want = Edge.applyTone(toneParityInput(x).map((v) => v * scale), t,
            local ? toneParityCoef(x) : undefined, rawMax);
          for (let c = 0; c < 3; c++) {
            const d = Math.abs(out[x * 4 + c] - want[c]);
            if (d > maxDiff) { maxDiff = d; worst = { tone: t, rawMax, local, x, c, gpu: out[x * 4 + c], js: want[c] }; }
          }
        }
      }
    }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo); gl.deleteTexture(tex); gl.deleteProgram(prog);
    console.log('tone parity: ' + TONE_PARITY_CASES.length + ' settings x 256 inputs, global and local, max abs diff =', maxDiff,
      maxDiff < 5e-4 ? '(OK, below 5e-4)' : '(FAIL, exceeds 5e-4)');
    return { maxDiff, cases: TONE_PARITY_CASES.length, worst };
  }

  // Shaders.DEV_PARITY_INPUT_FS's synthetic opponent pixel, computed
  // identically (every value is exact in float16).
  function detailParityInput(x, y) {
    const edge = x + y < 64 ? 0.25 : 0.625;
    const m = (v, n) => ((v % n) + n) % n;
    return [
      edge + m(x * 37 + y * 91, 17) / 256,
      (m(x * 53 + y * 29, 13) - 6) / 256,
      (m(x * 71 + y * 43, 19) - 9) / 256,
    ];
  }
  const DETAIL_PARITY_CASES = [
    { sharpenAmount: 0, sharpenRadius: 1, lumaNoise: 0, colorNoise: 0 },
    { sharpenAmount: 150, sharpenRadius: 0.5, lumaNoise: 0, colorNoise: 0 },
    { sharpenAmount: 80, sharpenRadius: 2, lumaNoise: 0, colorNoise: 0 },
    { sharpenAmount: 0, sharpenRadius: 1, lumaNoise: 100, colorNoise: 0 },
    { sharpenAmount: 0, sharpenRadius: 1, lumaNoise: 0, colorNoise: 100 },
    { sharpenAmount: 60, sharpenRadius: 1.2, lumaNoise: 35, colorNoise: 50 },
  ];
  const DETAIL_PARITY_SIGMAS = [1, 0.5, 0.25, 0.12, 0.06].map((f) => [0.02 * f, 0.012 * f, 0.012 * f]);

  // Compares the develop passes (GL.runDevelop, JPEG mode) with
  // Detail.develop over a 64 x 64 synthetic image for each case above. The
  // passes work in float16, so agreement is to ~1e-3, not float32's 1e-6.
  function checkDetailParity() {
    ensureCtx();
    const gl = ctx.gl;
    const n = 64;
    const inputProg = GL.program(gl, Shaders.FULLSCREEN_VS, Shaders.DEV_PARITY_INPUT_FS);
    const scratch = [0, 1, 2].map(() => GL.makeDevTarget(gl, n, n));
    const img = new Float32Array(n * n * 3);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) img.set(detailParityInput(x, y), (y * n + x) * 3);
    const out = new Float32Array(n * n * 4);
    let maxDiff = 0, worst = null;
    for (const p of DETAIL_PARITY_CASES) {
      gl.bindVertexArray(ctx.vao);
      gl.disable(gl.BLEND);
      gl.bindFramebuffer(gl.FRAMEBUFFER, scratch[0].fbo);
      gl.viewport(0, 0, n, n);
      gl.useProgram(inputProg);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const r = GL.runDevelop(ctx, scratch, p, DETAIL_PARITY_SIGMAS, 0, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, r.out.fbo);
      gl.readPixels(0, 0, n, n, gl.RGBA, gl.FLOAT, out);
      const js = Detail.develop(img, n, n, p, DETAIL_PARITY_SIGMAS);
      for (let i = 0; i < n * n; i++) {
        const want = Detail.fromOpp(js[i * 3], js[i * 3 + 1], js[i * 3 + 2]).map((v) => Math.min(1, Math.max(0, v)));
        for (let c = 0; c < 3; c++) {
          const d = Math.abs(out[i * 4 + c] - want[c]);
          if (d > maxDiff) maxDiff = d, worst = { detail: p, x: i % n, y: Math.floor(i / n), c, gpu: out[i * 4 + c], js: want[c] };
        }
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    for (const t of scratch) GL.freeDevTarget(gl, t);
    gl.deleteProgram(inputProg);
    console.log('detail parity: ' + DETAIL_PARITY_CASES.length + ' settings x 4096 pixels, max abs diff =', maxDiff,
      maxDiff < 4e-3 ? '(OK, below 4e-3)' : '(FAIL, exceeds 4e-3)');
    return { maxDiff, cases: DETAIL_PARITY_CASES.length, worst };
  }

  // Float raw parity (a merged HDR photo's input path): with a DNG open,
  // renders the composition from its 16-bit planes and again from float
  // copies ((v - black) / (white - black), black 0, white 1), Detail off,
  // and compares. Leaves everything as it was.
  function checkFloatRawParity() {
    if (!ctx || !state.isRaw || state.rawMeta.floatPlanes) return null;
    const gl = ctx.gl;
    const g = GL.exportGeometry(state);
    const k = Math.min(1, 512 / Math.max(g.width, g.height));
    const w = Math.max(1, Math.round(g.width * k)), h = Math.max(1, Math.round(g.height * k));
    const shown = Object.assign({}, state, { detail: DEFAULTS.detail });
    const renderFloat = (st) => {
      const t = GL.makeFloatExportTarget(gl, w, h, true);
      const out = new Float32Array(w * h * 4);
      try {
        GL.renderComposition(ctx, st, w, h, t.fbo);
        GL.readCompositionStripsFloat(gl, t.fbo, w, h, h, (rows, y) => out.set(rows, y * w * 4));
      } finally { GL.deleteExportTarget(gl, t); }
      return out;
    };
    const a = renderFloat(shown);
    const saved = ctx.textures.slice();
    const made = [];
    const meta = state.rawMeta;
    try {
      for (let i = 0; i < ctx.textures.length; i++) {
        const info = ctx.lensInfo[i], size = ctx.textureSize[i];
        if (!info || !info.plane || !size) continue;
        const range = meta.whiteLevel - meta.blackLevel;
        const f = Float32Array.from(info.plane, (v) => (v - meta.blackLevel) / range);
        const t = GL.makeBayerTexture(gl, f, size.width, size.height);
        made.push(t.tex);
        ctx.textures[i] = t.tex;
      }
      const b = renderFloat(Object.assign({}, shown, {
        rawMeta: Object.assign({}, meta, { blackLevel: 0, whiteLevel: 1, floatPlanes: true, hdrMax: 1 }),
      }));
      let maxDiff = 0;
      for (let i = 0; i < a.length; i++) maxDiff = Math.max(maxDiff, Math.abs(a[i] - b[i]));
      console.log('float raw parity: max abs diff =', maxDiff, maxDiff < 1e-3 ? '(OK, below 1e-3)' : '(FAIL, exceeds 1e-3)');
      return { maxDiff };
    } finally {
      for (let i = 0; i < saved.length; i++) ctx.textures[i] = saved[i];
      for (const t of made) gl.deleteTexture(t);
      render();
    }
  }

  window.App = {
    loadFile, state, render, rollFor: Lens.rollFor, checkParity, checkToneParity, checkDetailParity,
    setZoom, zoomToFit, getZoom: () => (zoom ? Object.assign({}, zoom) : null),
    previewLayout,
    saveSettings, loadSettings, exportImage, preparePrint, releasePrint,
    // The measured noise per lens slot (raw profile, per-layer sigmas once
    // noise reduction has run), for checking the measurement.
    noiseInfo: () => (ctx ? ctx.lensInfo.map((i) => i && { noise: i.noise, sigmas: i.sigmas }) : null),
    // Where Detail develops and what it costs; developBudget(bytes) makes
    // the GPU pretend to have only that much for it (Infinity: no limit),
    // to try the tiled and CPU fallbacks.
    developInfo: () => GL.developInfo(ctx, state),
    developSettled: () => GL.developSettled(ctx, state),
    developBudget: (bytes) => { GL.setDevelopBudget(ctx, bytes); render(); },
    undo, redo, canUndo: () => editHistory.canUndo(), canRedo: () => editHistory.canRedo(), autoWhiteBalance,
    // The photo strip, for checking it.
    addFiles,
    photos: () => {
      const sel = new Set(photos.selected().map((e) => e.id));
      return photos.entries.map((e) => ({
        id: e.id, name: Photos.nameOf(e), edited: e.edited, error: e.error, thumb: !!e.thumb, rendered: e.rendered,
        hdr: e.set ? e.set.length : 0, merged: !!e.members,
        current: e.id === photos.currentId, selected: sel.has(e.id),
      }));
    },
    openPhotoAt: (i) => openPhoto(photos.entries[i]),
    selectPhoto: (i, mode) => { photos.select(photos.entries[i].id, mode); drawStrip(); },
    removePhotoAt: (i) => removePhoto(photos.entries[i].id),
    copyEdits, pasteEdits, exportSelected, checkFloatRawParity, mergeSelected,
  };
})();
