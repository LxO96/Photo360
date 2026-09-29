(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Shortcuts = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // The keyboard shortcuts: one table, read both by match() (which key
  // does what) and by the help overlay (app.js), so the list shown is the
  // list that works. Borrowed from Lightroom and Photoshop where they
  // have one. `ctrl` means Ctrl, or Cmd on a Mac; a `shift` of undefined
  // means either; a `layout` limits a key to one keyboard layout (LAYOUTS)
  // and `show` may differ per layout the same way. Single keys (no ctrl)
  // never fire while typing in a number box, and neither do undo/redo
  // there (the box's own text undo).
  //
  // Layouts: on a Swedish keyboard \ needs AltGr (which reads as
  // Ctrl+Alt), so before/after moves to < (beside left Shift) or §. The
  // rest already works there (Ctrl++ zooms in, ? is Shift++).
  const LAYOUTS = ['standard', 'swedish'];
  const TABLE = [
    { group: 'Edit', label: 'Undo', show: 'Ctrl+Z', action: 'undo', keys: [{ key: 'z', ctrl: true, shift: false }] },
    { group: 'Edit', label: 'Redo', show: 'Ctrl+Shift+Z / Ctrl+Y', action: 'redo',
      keys: [{ key: 'z', ctrl: true, shift: true }, { key: 'y', ctrl: true, shift: false }] },
    { group: 'Sliders', label: 'Previous / next slider', show: '↑ / ↓  or  , / .', action: null, keys: [] },
    { group: 'Sliders', label: 'Change the value (Shift coarse, Ctrl fine)', show: '← / →  or  − / +', action: null, keys: [] },
    { group: 'Sliders', label: 'Reset the slider', show: 'Backspace / Delete', action: 'resetSlider',
      keys: [{ key: 'backspace' }, { key: 'delete' }], slider: true },
    { group: 'Sliders', label: 'Leave the slider', show: 'Esc', action: 'leaveSlider', keys: [{ key: 'escape' }], slider: true },
    { group: 'Sliders', label: 'Fine drag (a tenth of the speed; press any time)', show: 'Shift+drag', action: null, keys: [] },
    { group: 'Image', label: 'Rotate 90° / back', show: 'R / Shift+R', action: null, keys: [] },
    { group: 'Image', label: 'Black & white on / off', show: 'B', action: 'toggleMono', keys: [{ key: 'b', shift: false }] },
    { group: 'Image', label: 'Auto white balance', show: 'Shift+W', action: 'autoWb',
      keys: [{ key: 'w', shift: true }] },
    { group: 'View', label: 'Fit / 100%', show: 'Z', action: 'toggleZoom', keys: [{ key: 'z' }] },
    { group: 'View', label: 'Fit', show: 'Ctrl+0', action: 'zoomFit', keys: [{ key: '0', ctrl: true }] },
    { group: 'View', label: '100%', show: 'Ctrl+1', action: 'zoom100', keys: [{ key: '1', ctrl: true }] },
    { group: 'View', label: 'Zoom in / out', show: 'Ctrl+= / Ctrl+−', action: null, keys: [] },
    { group: 'View', label: 'Before / after (Tone and Detail off)', show: { standard: '\\', swedish: '< or §' },
      action: 'beforeAfter',
      keys: [{ key: '\\', layout: 'standard' }, { key: '<', layout: 'swedish' }, { key: '§', layout: 'swedish' }] },
    { group: 'File', label: 'Open', show: 'Ctrl+O', action: 'open', keys: [{ key: 'o', ctrl: true }] },
    { group: 'File', label: 'Export', show: 'Ctrl+Shift+E', action: 'export', keys: [{ key: 'e', ctrl: true, shift: true }] },
    { group: 'File', label: 'Print', show: 'Ctrl+P', action: 'print', keys: [{ key: 'p', ctrl: true, shift: false }] },
    { group: 'Help', label: 'This list', show: '?', action: 'help', keys: [{ key: '?' }] },
  ];
  // Keys with no row of their own in the list (shown combined above).
  const EXTRA = [
    { action: 'zoomIn', keys: [{ key: '=', ctrl: true }, { key: '+', ctrl: true }] },
    { action: 'zoomOut', keys: [{ key: '-', ctrl: true }, { key: '_', ctrl: true }] },
    { action: 'prevSlider', keys: [{ key: 'arrowup' }, { key: ',' }] },
    { action: 'nextSlider', keys: [{ key: 'arrowdown' }, { key: '.' }] },
    { action: 'nudgeUp', keys: [{ key: '+' }, { key: '=' }], slider: true },
    { action: 'nudgeDown', keys: [{ key: '-' }], slider: true },
    { action: 'rotateCw', keys: [{ key: 'r', shift: false }] },
    { action: 'rotateCcw', keys: [{ key: 'r', shift: true }] },
  ];
  const ALL = TABLE.filter((r) => r.action).concat(EXTRA);

  // The action for a keydown, or null. `ev`: { key, ctrlKey, metaKey,
  // shiftKey, altKey }; ctx: { typing (focus in a text box or select),
  // onSlider (focus on a slider), layout (LAYOUTS; default standard) }.
  function match(ev, ctx) {
    const layout = ctx.layout || 'standard';
    const key = String(ev.key || '').toLowerCase();
    const ctrl = !!(ev.ctrlKey || ev.metaKey);
    if (ev.altKey) return null;
    for (const row of ALL) {
      for (const k of row.keys) {
        if (k.key !== key || !!k.ctrl !== ctrl) continue;
        if (k.layout && k.layout !== layout) continue;
        if (k.shift !== undefined && k.shift !== !!ev.shiftKey) continue;
        if (ctx.typing && (!ctrl || row.action === 'undo' || row.action === 'redo')) continue;
        if (row.slider && !ctx.onSlider) continue;
        return row.action;
      }
    }
    return null;
  }

  // What a row's keys read as on `layout`.
  function showFor(row, layout) {
    return typeof row.show === 'string' ? row.show : (row.show[layout] || row.show.standard);
  }

  // Camera roll turned a quarter turn (dir +1 / -1), kept in [-180, 180).
  function rotated(roll, dir) {
    const r = ((roll + 90 * dir + 180) % 360 + 360) % 360 - 180;
    return Math.round(r * 1e9) / 1e9;
  }

  // The index `dir` (+1 / -1) steps from `i` in a list of n, clamped; from
  // nothing (i < 0) down starts at the top and up at the bottom.
  function step(i, n, dir) {
    if (!n) return -1;
    if (i < 0) return dir > 0 ? 0 : n - 1;
    return Math.min(n - 1, Math.max(0, i + dir));
  }

  return { LAYOUTS, TABLE, match, showFor, rotated, step };
});
