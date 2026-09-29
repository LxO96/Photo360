'use strict';
const test = require('node:test');
const assert = require('node:assert');
const History = require('../history.js');
const Settings = require('../settings.js');

test('undo and redo walk back and forth through recorded changes', () => {
  const h = History.create();
  h.reset({ a: 1 });
  h.record({ a: 2 });
  h.record({ a: 3 });
  assert.deepStrictEqual(h.undo(), { a: 2 });
  assert.deepStrictEqual(h.undo(), { a: 1 });
  assert.strictEqual(h.undo(), null);
  assert.deepStrictEqual(h.redo(), { a: 2 });
  assert.deepStrictEqual(h.redo(), { a: 3 });
  assert.strictEqual(h.redo(), null);
});

test('a new change after undo drops the redo branch', () => {
  const h = History.create();
  h.reset({ a: 1 });
  h.record({ a: 2 });
  h.undo();
  assert.ok(h.canRedo());
  h.record({ a: 5 });
  assert.ok(!h.canRedo());
  assert.deepStrictEqual(h.undo(), { a: 1 });
});

test('recording the same state is not a step', () => {
  const h = History.create();
  h.reset({ a: 1, b: { c: 2 } });
  assert.strictEqual(h.record({ a: 1, b: { c: 2 } }), false);
  assert.ok(!h.canUndo());
});

test('reset clears both stacks', () => {
  const h = History.create();
  h.reset({ a: 1 });
  h.record({ a: 2 });
  h.undo();
  h.reset({ a: 9 });
  assert.ok(!h.canUndo() && !h.canRedo());
});

test('history keeps only the last LIMIT steps', () => {
  const h = History.create(3);
  h.reset(0);
  for (let i = 1; i <= 5; i++) h.record(i);
  assert.strictEqual(h.undo(), 4);
  assert.strictEqual(h.undo(), 3);
  assert.strictEqual(h.undo(), 2);
  assert.strictEqual(h.undo(), null);
});

test('snapshots are copies: changing a returned one changes nothing inside', () => {
  const h = History.create();
  const s = { t: { x: 1 } };
  h.reset(s);
  s.t.x = 5;
  h.record({ t: { x: 2 } });
  const back = h.undo();
  assert.deepStrictEqual(back, { t: { x: 1 } });
  back.t.x = 7;
  h.redo();
  assert.deepStrictEqual(h.undo(), { t: { x: 1 } });
});

test('the edit snapshot leaves out the view preferences, and only those', () => {
  const keys = Settings.PERSISTED_KEYS;
  const serialized = Object.fromEntries(keys.map((k) => [k, k]));
  const snap = History.editSnapshot(serialized);
  for (const k of History.VIEW_KEYS) assert.ok(keys.includes(k), k);
  assert.deepStrictEqual(Object.keys(snap).sort(), keys.filter((k) => !History.VIEW_KEYS.includes(k)).sort());
  for (const k of ['tone', 'detail', 'edge', 'rollDeg', 'rawWb', 'fovDeg']) assert.ok(k in snap, k);
});
