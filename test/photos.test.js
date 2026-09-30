'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Photos = require('../photos.js');

const f = (name, size = 10, lastModified = 1) => ({ name, size, lastModified });
function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    _m: m,
  };
}

test('keyOf joins name, size and date', () => {
  assert.strictEqual(Photos.keyOf(f('a.dng', 5, 7)), 'a.dng|5|7');
});

test('pasteable copies every edit, levelling included', () => {
  const e = { rollDeg: 3, nudgeDeg: { A: 1, B: 2 }, tone: { exposureEv: 1 }, fovDeg: 200 };
  const p = Photos.pasteable(e);
  assert.deepStrictEqual(p, e);
  p.tone.exposureEv = 5;
  assert.strictEqual(e.tone.exposureEv, 1, 'a deep copy');
});

test('store saves and loads per key', () => {
  const s = Photos.createStore(memStorage());
  assert.strictEqual(s.load('k'), null);
  assert.ok(s.save('k', { tone: { exposureEv: 1 } }));
  assert.deepStrictEqual(s.load('k'), { tone: { exposureEv: 1 } });
  assert.ok(s.has('k'));
});

test('store keeps only the most recent `cap` photos', () => {
  const st = memStorage();
  const s = Photos.createStore(st, 3);
  for (const k of ['a', 'b', 'c']) s.save(k, { v: k });
  s.load('a');            // loading does not reorder; saving does
  s.save('a', { v: 'a2' });
  s.save('d', { v: 'd' }); // evicts b, the least recently saved
  assert.strictEqual(s.load('b'), null);
  assert.deepStrictEqual(s.load('a'), { v: 'a2' });
  assert.strictEqual(st.getItem('photo360.photo.v1.b'), null);
  assert.deepStrictEqual(JSON.parse(st.getItem('photo360.photos.v1')), ['d', 'a', 'c']);
});

test('store falls back to memory when storage throws', () => {
  const bad = { getItem() { throw new Error('no'); }, setItem() { throw new Error('full'); }, removeItem() {} };
  const s = Photos.createStore(bad);
  assert.strictEqual(s.save('k', { v: 1 }), false);
  assert.ok(s.fellBack);
  assert.deepStrictEqual(s.load('k'), { v: 1 });
});

test('store ignores a corrupt record', () => {
  const st = memStorage();
  st.setItem('photo360.photo.v1.k', '{nope');
  assert.strictEqual(Photos.createStore(st).load('k'), null);
});

test('list adds supported files once and reports the rest', () => {
  const l = Photos.createList();
  const r = l.add([f('a.dng'), f('b.insp'), f('notes.txt'), f('c.JPG')]);
  assert.deepStrictEqual(r.added.map((e) => e.file.name), ['a.dng', 'b.insp', 'c.JPG']);
  assert.deepStrictEqual(r.skipped, ['notes.txt']);
  const again = l.add([f('a.dng'), f('d.dng')]);
  assert.deepStrictEqual(again.added.map((e) => e.file.name), ['d.dng']);
  assert.strictEqual(l.entries.length, 4);
});

test('neighbour and remove pick the next photo, else the previous', () => {
  const l = Photos.createList();
  const [a, b, c] = l.add([f('a.dng'), f('b.dng'), f('c.dng')]).added;
  assert.strictEqual(l.neighbour(a.id, 1), b);
  assert.strictEqual(l.neighbour(a.id, -1), null);
  assert.strictEqual(l.remove(b.id), c);
  assert.strictEqual(l.remove(c.id), a);
  assert.strictEqual(l.remove(a.id), null);
  assert.strictEqual(l.entries.length, 0);
});

test('selection: only, toggle, range; the current photo is always in it', () => {
  const l = Photos.createList();
  const [a, b, c, d] = l.add([f('a.dng'), f('b.dng'), f('c.dng'), f('d.dng')]).added;
  l.currentId = a.id;
  l.select(a.id, 'only');
  assert.deepStrictEqual(l.selected(), [a]);
  l.select(c.id, 'toggle');
  assert.deepStrictEqual(l.selected(), [a, c]);
  l.select(a.id, 'toggle');                 // cannot drop the current photo
  assert.deepStrictEqual(l.selected(), [a, c]);
  l.select(d.id, 'range');                  // from the last clicked (c) to d
  assert.deepStrictEqual(l.selected(), [a, c, d]);
  l.select(b.id, 'only');
  l.currentId = b.id;
  assert.deepStrictEqual(l.selected(), [b]);
});
