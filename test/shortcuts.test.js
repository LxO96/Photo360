'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Shortcuts = require('../src/shortcuts.js');

const FREE = { typing: false, onSlider: false };
const SLIDER = { typing: false, onSlider: true };
const TYPING = { typing: true, onSlider: false };
const k = (key, mods) => Object.assign({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false }, mods);

test('undo and redo, with Ctrl or Cmd', () => {
  assert.strictEqual(Shortcuts.match(k('z', { ctrlKey: true }), FREE), 'undo');
  assert.strictEqual(Shortcuts.match(k('z', { metaKey: true }), FREE), 'undo');
  assert.strictEqual(Shortcuts.match(k('Z', { ctrlKey: true, shiftKey: true }), FREE), 'redo');
  assert.strictEqual(Shortcuts.match(k('y', { ctrlKey: true }), FREE), 'redo');
});

test('in a number box, undo is the box\'s own and single keys do nothing', () => {
  assert.strictEqual(Shortcuts.match(k('z', { ctrlKey: true }), TYPING), null);
  assert.strictEqual(Shortcuts.match(k('y', { ctrlKey: true }), TYPING), null);
  assert.strictEqual(Shortcuts.match(k('z'), TYPING), null);
  assert.strictEqual(Shortcuts.match(k('\\'), TYPING), null);
  // ...but the Ctrl file and view keys still work.
  assert.strictEqual(Shortcuts.match(k('o', { ctrlKey: true }), TYPING), 'open');
  assert.strictEqual(Shortcuts.match(k('0', { ctrlKey: true }), TYPING), 'zoomFit');
});

test('arrows up / down and , / . move between sliders', () => {
  for (const ctx of [FREE, SLIDER]) {
    assert.strictEqual(Shortcuts.match(k('ArrowUp'), ctx), 'prevSlider');
    assert.strictEqual(Shortcuts.match(k('ArrowDown'), ctx), 'nextSlider');
    assert.strictEqual(Shortcuts.match(k(','), ctx), 'prevSlider');
    assert.strictEqual(Shortcuts.match(k('.'), ctx), 'nextSlider');
  }
});

test('+ / - and reset act only on a focused slider', () => {
  assert.strictEqual(Shortcuts.match(k('+', { shiftKey: true }), SLIDER), 'nudgeUp');
  assert.strictEqual(Shortcuts.match(k('='), SLIDER), 'nudgeUp');
  assert.strictEqual(Shortcuts.match(k('-'), SLIDER), 'nudgeDown');
  assert.strictEqual(Shortcuts.match(k('Backspace'), SLIDER), 'resetSlider');
  assert.strictEqual(Shortcuts.match(k('Delete'), SLIDER), 'resetSlider');
  assert.strictEqual(Shortcuts.match(k('-'), FREE), null);
  assert.strictEqual(Shortcuts.match(k('Backspace'), FREE), null);
});

test('view and file keys', () => {
  assert.strictEqual(Shortcuts.match(k('z'), FREE), 'toggleZoom');
  assert.strictEqual(Shortcuts.match(k('1', { ctrlKey: true }), FREE), 'zoom100');
  assert.strictEqual(Shortcuts.match(k('=', { ctrlKey: true }), FREE), 'zoomIn');
  assert.strictEqual(Shortcuts.match(k('-', { ctrlKey: true }), FREE), 'zoomOut');
  assert.strictEqual(Shortcuts.match(k('\\'), FREE), 'beforeAfter');
  assert.strictEqual(Shortcuts.match(k('E', { ctrlKey: true, shiftKey: true }), FREE), 'export');
  assert.strictEqual(Shortcuts.match(k('e', { ctrlKey: true }), FREE), null);   // the browser's own
  assert.strictEqual(Shortcuts.match(k('p', { ctrlKey: true }), FREE), 'print');
  assert.strictEqual(Shortcuts.match(k('?', { shiftKey: true }), FREE), 'help');
  assert.strictEqual(Shortcuts.match(k('z', { altKey: true }), FREE), null);
});

test('stepping through the sliders stops at the ends', () => {
  assert.strictEqual(Shortcuts.step(-1, 5, 1), 0);
  assert.strictEqual(Shortcuts.step(-1, 5, -1), 4);
  assert.strictEqual(Shortcuts.step(4, 5, 1), 4);
  assert.strictEqual(Shortcuts.step(0, 5, -1), 0);
  assert.strictEqual(Shortcuts.step(2, 5, 1), 3);
  assert.strictEqual(Shortcuts.step(0, 0, 1), -1);
});

test('Swedish layout: before / after on < or §, not \ (which needs AltGr there)', () => {
  const SE = { typing: false, onSlider: false, layout: 'swedish' };
  assert.strictEqual(Shortcuts.match(k('<'), SE), 'beforeAfter');
  assert.strictEqual(Shortcuts.match(k('§'), SE), 'beforeAfter');
  assert.strictEqual(Shortcuts.match(k('\\'), SE), null);
  assert.strictEqual(Shortcuts.match(k('<'), FREE), null);
  // AltGr+'+' types \ as Ctrl+Alt: never a shortcut.
  assert.strictEqual(Shortcuts.match(k('\\', { ctrlKey: true, altKey: true }), FREE), null);
  // What already works on a Swedish keyboard.
  assert.strictEqual(Shortcuts.match(k('+', { ctrlKey: true }), SE), 'zoomIn');
  assert.strictEqual(Shortcuts.match(k('?', { shiftKey: true }), SE), 'help');
  assert.strictEqual(Shortcuts.match(k('+'), { ...SE, onSlider: true }), 'nudgeUp');
  const row = Shortcuts.TABLE.find((r) => r.action === 'beforeAfter');
  assert.strictEqual(Shortcuts.showFor(row, 'swedish'), '< or §');
  assert.strictEqual(Shortcuts.showFor(row, 'standard'), '\\');
});

test('R turns a quarter turn, Shift+R back, wrapping at 180', () => {
  assert.strictEqual(Shortcuts.match(k('r'), FREE), 'rotateCw');
  assert.strictEqual(Shortcuts.match(k('R', { shiftKey: true }), FREE), 'rotateCcw');
  assert.strictEqual(Shortcuts.match(k('r'), TYPING), null);
  assert.strictEqual(Shortcuts.rotated(0, 1), 90);
  assert.strictEqual(Shortcuts.rotated(90, 1), -180);
  assert.strictEqual(Shortcuts.rotated(-180, -1), 90);
  assert.strictEqual(Shortcuts.rotated(12.5, -1), -77.5);
  assert.strictEqual(Shortcuts.rotated(170, 1), -100);
});

test('B toggles black & white', () => {
  assert.strictEqual(Shortcuts.match(k('b'), FREE), 'toggleMono');
  assert.strictEqual(Shortcuts.match(k('b'), SLIDER), 'toggleMono');
  assert.strictEqual(Shortcuts.match(k('b'), TYPING), null);
  assert.strictEqual(Shortcuts.match(k('b', { ctrlKey: true }), FREE), null);
});

test('Shift+W is auto white balance; plain W is nothing', () => {
  assert.strictEqual(Shortcuts.match(k('W', { shiftKey: true }), FREE), 'autoWb');
  assert.strictEqual(Shortcuts.match(k('w'), FREE), null);
  assert.strictEqual(Shortcuts.match(k('W', { shiftKey: true }), TYPING), null);
});

test('every action in the help list has a key, and every row a label', () => {
  for (const row of Shortcuts.TABLE) {
    assert.ok(row.label && row.show && row.group, JSON.stringify(row));
    if (row.action) assert.ok(row.keys.length, row.action);
  }
});

test('photo navigation: PageDown/PageUp, and Ctrl+arrows off the sliders', () => {
  assert.strictEqual(Shortcuts.match(k('PageDown'), FREE), 'nextPhoto');
  assert.strictEqual(Shortcuts.match(k('PageUp'), SLIDER), 'prevPhoto');
  assert.strictEqual(Shortcuts.match(k('ArrowRight', { ctrlKey: true }), FREE), 'nextPhoto');
  assert.strictEqual(Shortcuts.match(k('ArrowLeft', { ctrlKey: true }), FREE), 'prevPhoto');
  assert.strictEqual(Shortcuts.match(k('ArrowRight', { ctrlKey: true }), SLIDER), null);
  assert.strictEqual(Shortcuts.match(k('ArrowRight', { ctrlKey: true }), TYPING), null);
  assert.strictEqual(Shortcuts.match(k('PageDown'), TYPING), null);
});

test('copy and paste edits, not while typing', () => {
  assert.strictEqual(Shortcuts.match(k('C', { ctrlKey: true, shiftKey: true }), FREE), 'copyEdits');
  assert.strictEqual(Shortcuts.match(k('V', { ctrlKey: true, shiftKey: true }), SLIDER), 'pasteEdits');
  assert.strictEqual(Shortcuts.match(k('V', { ctrlKey: true, shiftKey: true }), TYPING), null);
  assert.strictEqual(Shortcuts.match(k('c', { ctrlKey: true }), FREE), null);
});

test('the swedish layout has the photo keys too', () => {
  const SV = { typing: false, onSlider: false, layout: 'swedish' };
  assert.strictEqual(Shortcuts.match(k('PageDown'), SV), 'nextPhoto');
  assert.strictEqual(Shortcuts.match(k('C', { ctrlKey: true, shiftKey: true }), SV), 'copyEdits');
});
