'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Photos = require('../src/photos.js');

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

test('pasteable leaves out the sun: each shot has its own', () => {
  const p = Photos.pasteable({ tone: { exposureEv: 1 }, sun: { on: true, status: 'auto' } });
  assert.deepStrictEqual(p, { tone: { exposureEv: 1 } });
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

test('insertAfter places a virtual entry after another, deduped by key', () => {
  const l = Photos.createList();
  const [a, b] = l.add([f('a.dng'), f('b.dng')]).added;
  const m = l.insertAfter(a.id, { key: 'HDR|x', file: null, name: 'a_HDR' });
  assert.deepStrictEqual(l.entries.map((e) => e.id), [a.id, m.id, b.id]);
  assert.strictEqual(m.key, 'HDR|x');
  assert.strictEqual(l.insertAfter(b.id, { key: 'HDR|x', file: null }), m);
  assert.strictEqual(Photos.nameOf(m), 'a_HDR');
  assert.strictEqual(Photos.nameOf(a), 'a.dng');
});

// -- Capture time, sorting and shooting groups ------------------------------
const shot = (name, o) => Object.assign({ id: name, file: f(name), shot: null }, o);

test('captureTime reads the camera file name first, else the EXIF date', () => {
  assert.strictEqual(Photos.captureTime('IMG_20240825_173735_00_003.dng', '2024:08:25 15:37:36'),
    Date.UTC(2024, 7, 25, 17, 37, 35) / 1000);
  assert.strictEqual(Photos.captureTime('holiday.jpg', '2024:08:25 15:37:36'), Date.UTC(2024, 7, 25, 15, 37, 36) / 1000);
  assert.strictEqual(Photos.captureTime('holiday.jpg', ''), null);
});

test('sortByShot orders by capture time, then name; unknown times last', () => {
  const es = [
    shot('c.dng', { shot: { time: 20 } }), shot('b.dng', { shot: null }),
    shot('a.dng', { shot: { time: 20 } }), shot('d.dng', { shot: { time: 5 } }),
  ];
  assert.deepStrictEqual(Photos.sortByShot(es).map((e) => e.id), ['d.dng', 'a.dng', 'c.dng', 'b.dng']);
});

test('groupsOf: same camera, within 5 s of the previous, exposures within 3 EV', () => {
  const s = (t, ev, model = 'X') => ({ time: t, model, ev });
  const es = [
    shot('1', { shot: s(100, 0) }), shot('2', { shot: s(103, 2) }), shot('3', { shot: s(107, -1) }),   // a group
    shot('4', { shot: s(113, 0) }),                                                                // 6 s later: alone
    shot('5', { shot: s(200, 0) }), shot('6', { shot: s(201, 4) }),                                // 4 EV apart: split
    shot('7', { shot: s(300, 0) }), shot('8', { shot: s(301, 0, 'Y') }),                           // other camera: split
    shot('9', { shot: null }),
  ];
  assert.deepStrictEqual(Photos.groupsOf(es).map((g) => g.map((e) => e.id)),
    [['1', '2', '3'], ['4'], ['5'], ['6'], ['7'], ['8'], ['9']]);
});

test('exposureLabel shows shutter and ISO', () => {
  assert.strictEqual(Photos.exposureLabel({ exposureTime: 1 / 146, iso: 100 }), '1/146 · ISO 100');
  assert.strictEqual(Photos.exposureLabel({ exposureTime: 2.5, iso: 800 }), '2.5 s · ISO 800');
  assert.strictEqual(Photos.exposureLabel({ exposureTime: 1 / 60 }), '1/60');
  assert.strictEqual(Photos.exposureLabel({}), '');
});

test('groupInfo marks what varies as shown, and the darkest exposure', () => {
  const s = (t, iso) => ({ shot: { time: 1, model: 'X', exposureTime: t, iso, ev: Math.log2(t * iso / 100) } });
  const same = Photos.groupInfo([s(1 / 150.8, 100), s(1 / 151, 100)]);   // both show 1/151
  assert.strictEqual(same.shutter, false);
  assert.strictEqual(same.iso, false);
  assert.strictEqual(same.darkest, null);
  const br = Photos.groupInfo([s(1 / 146, 100), s(1 / 60, 164)]);
  assert.strictEqual(br.shutter, true);
  assert.strictEqual(br.iso, true);
  assert.ok(Math.abs(br.darkest - Math.log2(1 / 146)) < 1e-12);
});

test('pasting edits carries the film settings', () => {
  const out = Photos.pasteable({ film: { stock: 'golden200', gauge: 's16', grain: 1, halation: 0.5 }, sun: { on: true } });
  assert.deepStrictEqual(out.film, { stock: 'golden200', gauge: 's16', grain: 1, halation: 0.5 });
  assert.ok(!('sun' in out));
});
