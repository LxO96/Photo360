# File Strip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open many photos at once, show them in a thumbnail strip, switch between them with per-photo edits, copy/paste edits, and export a selection.

**Architecture:** Two new pure modules (node-testable, UMD like the rest): `photos.js` (photo keys, the per-photo edit store with an LRU index, the paste filter, the strip list/selection model) and `thumbs.js` (EXIF thumbnail location, decimated DNG preview, plus browser-only wrappers that turn a `File` into a thumbnail blob). A browser-only `strip.js` draws the filmstrip DOM and reports clicks. `app.js` owns the flow: only one photo is ever decoded onto the GPU (the existing `loadFile`), switching saves the current photo's edits and history into its entry, and loads are superseded by newer switches.

**Tech Stack:** Plain browser JS (no build step, UMD modules loaded by `<script>` in `index.html`), WebGL2 (existing), node:test for unit tests (`npm test` → `node test/run.js`), headless Chrome via the scratchpad `cdp.py` for the end-to-end check.

**Spec:** `docs/superpowers/specs/2026-09-30-file-strip-design.md`

## Global Constraints

- `Testfiles/` is read-only; never modify or commit it.
- Commit only when the user asks (the "Commit" steps below are grouped into one commit at the end unless the user says otherwise); commit trailer:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01NAsU7VqpR8gJ3VXdXEEAus`.
- Work on a new branch `feature/file-strip` from `feature/wb-match` (main is behind; the user has not merged yet).
- Photo key: `name + '|' + size + '|' + lastModified`.
- Per-photo storage key `photo360.photo.v1.<key>`, index key `photo360.photos.v1`, LRU cap **500**.
- Thumbnails: ~**256 px** long side.
- Rendered preview refresh: at the history settle point (400 ms idle / pointerup).
- Paste leaves out per-lens geometry: `rollDeg`, `nudgeDeg`.
- Strip hidden with fewer than two photos; collapse state is an app-level (view) setting.
- Spelling in UI copy: British ("colour").

## Review Focus

1. Switching photos quickly (click A, B, C before A finishes decoding) — only the last click must end up open, with its own edits; nothing leaks textures. → Task 4 headless step "rapid switching".
2. Opening a raw photo that has stored edits — the stored white balance must win over the file's as-shot WB that `applyLoadedDescriptor` writes. → Task 4 headless step checks `rawWb` survives a round trip.
3. A mixed drop (DNG + .insp + a .txt) — unsupported files skipped with one note, the rest added once each; dropping the same files again adds nothing. → Task 1 unit test (`addFiles` dedupe/skip) and Task 4 headless step.
4. Undo after switching away and back — history is the photo's own, not the other photo's. → Task 4 headless step.
5. localStorage full / unavailable — edits still work for the session, one warning. → Task 1 unit test with a throwing storage.

---

### Task 1: `photos.js` — keys, per-photo store, paste filter, strip model

**Files:**
- Create: `photos.js`
- Test: `test/photos.test.js`

**Interfaces:**
- Consumes: nothing (pure).
- Produces (global `Photos` in the browser, `module.exports` in node):
  - `keyOf(file) -> string` (`file` has `name`, `size`, `lastModified`)
  - `SUPPORTED: RegExp` (`/\.(insp|jpe?g|dng)$/i`)
  - `PASTE_SKIP: string[]` = `['rollDeg', 'nudgeDeg']`
  - `pasteable(edits) -> object` (a copy without `PASTE_SKIP` keys)
  - `createStore(storage, cap = 500) -> { load(key) -> object|null, save(key, edits) -> boolean, has(key) -> boolean, fellBack: boolean }`
  - `createList() -> { entries, add(files) -> {added: Entry[], skipped: string[]}, remove(id) -> Entry|null (the neighbour to open, or null), indexOf(id), byId(id), neighbour(id, dir) -> Entry|null, select(id, mode) , selected() -> Entry[] }`
    - `Entry = { id: number, file, key, thumb: string|null, rendered: boolean, edits: object|null, history: object|null, edited: boolean, error: string|null }`
    - `select(id, 'only' | 'toggle' | 'range')` (toggling the open photo is a no-op and does not move the range anchor); `current` is tracked via `list.currentId` (set by the caller) and is always in `selected()`.

- [ ] **Step 1: Write the failing tests** — `test/photos.test.js`:

```js
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

test('pasteable drops per-lens geometry and copies the rest', () => {
  const e = { rollDeg: 3, nudgeDeg: { A: 1, B: 2 }, tone: { exposureEv: 1 }, fovDeg: 200 };
  const p = Photos.pasteable(e);
  assert.deepStrictEqual(p, { tone: { exposureEv: 1 }, fovDeg: 200 });
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test 2>&1 | grep -E "^not ok|Cannot find module" | head`
Expected: `Cannot find module '../photos.js'`.

- [ ] **Step 3: Implement `photos.js`**

```js
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Photos = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // The photos in the strip (app.js / strip.js) and each one's own edits.
  // A photo is known by its name, size and date, so reopening the same file
  // later finds its edits again; the edits live in localStorage, one record
  // per photo, with an index (most recently saved first) that caps how many
  // are kept. When storage is unavailable or full, edits are kept in memory
  // for the session instead (`fellBack`, for app.js to say so once).
  const INDEX_KEY = 'photo360.photos.v1';
  const RECORD_PREFIX = 'photo360.photo.v1.';
  const CAP = 500;
  const SUPPORTED = /\.(insp|jpe?g|dng)$/i;
  // Pasting edits onto another photo leaves out what belongs to that
  // photo's own lenses: the levelling.
  const PASTE_SKIP = ['rollDeg', 'nudgeDeg'];

  const keyOf = (file) => file.name + '|' + file.size + '|' + file.lastModified;
  const clone = (v) => JSON.parse(JSON.stringify(v));

  function pasteable(edits) {
    const out = {};
    for (const k of Object.keys(edits)) if (!PASTE_SKIP.includes(k)) out[k] = clone(edits[k]);
    return out;
  }

  function createStore(storage, cap) {
    const max = cap || CAP;
    const memory = new Map();
    const store = { fellBack: false };
    function readIndex() {
      try {
        const v = JSON.parse(storage.getItem(INDEX_KEY) || '[]');
        return Array.isArray(v) ? v.filter((k) => typeof k === 'string') : [];
      } catch (e) { return []; }
    }
    store.load = (key) => {
      if (memory.has(key)) return clone(memory.get(key));
      try {
        const raw = storage.getItem(RECORD_PREFIX + key);
        if (!raw) return null;
        const v = JSON.parse(raw);
        return v && typeof v === 'object' ? v : null;
      } catch (e) { return null; }
    };
    store.has = (key) => store.load(key) !== null;
    store.save = (key, edits) => {
      try {
        const index = readIndex().filter((k) => k !== key);
        index.unshift(key);
        while (index.length > max) storage.removeItem(RECORD_PREFIX + index.pop());
        storage.setItem(RECORD_PREFIX + key, JSON.stringify(edits));
        storage.setItem(INDEX_KEY, JSON.stringify(index));
        memory.delete(key);
        return true;
      } catch (e) {
        memory.set(key, clone(edits));
        store.fellBack = true;
        return false;
      }
    };
    return store;
  }

  function createList() {
    let nextId = 1, anchorId = null;
    const picked = new Set();
    const list = { entries: [], currentId: null };
    list.indexOf = (id) => list.entries.findIndex((e) => e.id === id);
    list.byId = (id) => list.entries.find((e) => e.id === id) || null;
    list.add = (files) => {
      const added = [], skipped = [];
      for (const file of files) {
        if (!SUPPORTED.test(file.name)) { skipped.push(file.name); continue; }
        const key = keyOf(file);
        if (list.entries.some((e) => e.key === key)) continue;
        const entry = { id: nextId++, file, key, thumb: null, rendered: false,
          edits: null, history: null, edited: false, error: null };
        list.entries.push(entry);
        added.push(entry);
      }
      return { added, skipped };
    };
    list.neighbour = (id, dir) => list.entries[list.indexOf(id) + dir] || null;
    list.remove = (id) => {
      const i = list.indexOf(id);
      if (i < 0) return null;
      list.entries.splice(i, 1);
      picked.delete(id);
      return list.entries[i] || list.entries[i - 1] || null;
    };
    list.select = (id, mode) => {
      if (mode === 'toggle') {
        if (id === list.currentId) return;   // the open photo stays selected
        if (picked.has(id)) picked.delete(id); else picked.add(id);
      } else if (mode === 'range' && anchorId !== null) {
        const a = list.indexOf(anchorId), b = list.indexOf(id);
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) picked.add(list.entries[i].id);
      } else {
        picked.clear();
        picked.add(id);
      }
      anchorId = id;
    };
    list.selected = () => list.entries.filter((e) => picked.has(e.id) || e.id === list.currentId);
    return list;
  }

  return { INDEX_KEY, RECORD_PREFIX, CAP, SUPPORTED, PASTE_SKIP, keyOf, pasteable, createStore, createList };
});
```

- [ ] **Step 4: Run tests** — `npm test 2>&1 | tail -8` → all pass (previous 411 + the new ones).
- [ ] **Step 5: Commit point** (hold until the user asks) — `photos.js`, `test/photos.test.js`.

---

### Task 2: `thumbs.js` — EXIF thumbnail and decimated DNG preview

**Files:**
- Create: `thumbs.js`
- Test: `test/thumbs.test.js`

**Interfaces:**
- Consumes: `Dng.parse(bytes)` (existing; returns `{width, height, littleEndian, cfaPattern, blackLevel, whiteLevel, asShotNeutral, stripOffset, ...}` or null), `Exif` internals are *not* used (own small reader here).
- Produces (global `Thumbs`):
  - `SIZE = 256`
  - `exifThumbnail(bytes: Uint8Array) -> {offset, length} | null` — the JPEG thumbnail (IFD1 tags 0x0201/0x0202) inside the first APP1 Exif segment, offsets absolute in `bytes`.
  - `dngDecimate(meta, readPair, size = SIZE) -> {width, height, rgba: Uint8ClampedArray}` — `readPair(y)` returns a `Uint16Array` holding rows `y` and `y+1` of the CFA plane (length `2 * meta.width`). Samples one 2×2 Bayer block every `step = 2 * ceil(max(w, h) / (2 * size))` pixels; black/white normalised, multiplied by `1 / asShotNeutral[c]` (then divided by the max so green-ish stays 1), sRGB-encoded.
  - Browser only: `quick(file) -> Promise<Blob>` (JPEG/.insp: EXIF thumbnail if present else `createImageBitmap(file, {resizeWidth})`; DNG: sparse read + `dngDecimate`), returns a PNG/JPEG blob.

- [ ] **Step 1: Write the failing tests** — `test/thumbs.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Thumbs = require('../thumbs.js');

// A JPEG with an APP1 Exif segment whose IFD1 points at a 4-byte "thumbnail".
function jpegWithThumb() {
  const tiff = [];
  const u16 = (v) => tiff.push(v & 255, v >> 8);
  const u32 = (v) => tiff.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, v >>> 24);
  tiff.push(0x49, 0x49); u16(42); u32(8);          // II, magic, IFD0 at 8
  u16(0); u32(14);                                   // IFD0: no entries, next IFD at 14
  u16(2);                                            // IFD1: 2 entries
  u16(0x0201); u16(4); u32(1); u32(44);              // JPEGInterchangeFormat -> 44
  u16(0x0202); u16(4); u32(1); u32(4);               // ...Length -> 4
  u32(0);                                            // no next IFD
  while (tiff.length < 44) tiff.push(0);
  tiff.push(0xff, 0xd8, 0xff, 0xd9);                 // the "thumbnail"
  const payload = [0x45, 0x78, 0x69, 0x66, 0, 0].concat(tiff);
  const len = payload.length + 2;
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, len >> 8, len & 255].concat(payload, [0xff, 0xda, 0, 2]));
}

test('exifThumbnail finds the IFD1 JPEG', () => {
  const b = jpegWithThumb();
  const t = Thumbs.exifThumbnail(b);
  assert.ok(t);
  assert.strictEqual(t.length, 4);
  assert.deepStrictEqual(Array.from(b.subarray(t.offset, t.offset + 4)), [0xff, 0xd8, 0xff, 0xd9]);
});

test('exifThumbnail is null without Exif or without IFD1', () => {
  assert.strictEqual(Thumbs.exifThumbnail(Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0, 2])), null);
  assert.strictEqual(Thumbs.exifThumbnail(Uint8Array.from([1, 2, 3])), null);
});

// An RGGB plane: the left half red light, the right half blue, 16 x 8.
function plane(w, h) {
  const p = new Uint16Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const red = x < w / 2;
    const c = (y % 2) * 2 + (x % 2);                  // 0 R, 1 G, 2 G, 3 B
    const v = c === 0 ? (red ? 4000 : 100) : c === 3 ? (red ? 100 : 4000) : 100;
    p[y * w + x] = 100 + v;                           // black level 100
  }
  return p;
}

test('dngDecimate samples Bayer blocks into colours and size', () => {
  const w = 16, h = 8, p = plane(w, h);
  const meta = { width: w, height: h, cfaPattern: [0, 1, 1, 2], blackLevel: 100, whiteLevel: 4100,
    asShotNeutral: [1, 1, 1] };
  const rows = [];
  const out = Thumbs.dngDecimate(meta, (y) => { rows.push(y); return p.subarray(y * w, (y + 2) * w); }, 4);
  assert.strictEqual(out.width, 4);
  assert.strictEqual(out.height, 2);
  assert.ok(rows.every((y) => y % 2 === 0), 'reads start on even rows');
  const px = (x, y) => Array.from(out.rgba.subarray((y * out.width + x) * 4, (y * out.width + x) * 4 + 4));
  const left = px(0, 0), right = px(3, 1);
  assert.ok(left[0] > 200 && left[2] < 80, 'left is red: ' + left);
  assert.ok(right[2] > 200 && right[0] < 80, 'right is blue: ' + right);
  assert.strictEqual(left[3], 255);
});

test('dngDecimate reads far fewer rows than the plane has', () => {
  const w = 512, h = 256, p = new Uint16Array(w * h);
  const meta = { width: w, height: h, cfaPattern: [0, 1, 1, 2], blackLevel: 0, whiteLevel: 65535, asShotNeutral: [1, 1, 1] };
  let reads = 0;
  Thumbs.dngDecimate(meta, (y) => { reads++; return p.subarray(y * w, (y + 2) * w); }, 64);
  assert.ok(reads <= 32, 'reads ' + reads);
});

test('dngDecimate applies the as-shot neutral', () => {
  const w = 4, h = 4, p = new Uint16Array(w * h).fill(1100);   // flat grey sensor values
  const meta = { width: w, height: h, cfaPattern: [0, 1, 1, 2], blackLevel: 100, whiteLevel: 4100,
    asShotNeutral: [0.5, 1, 1] };                                 // red sensor is half as sensitive
  const out = Thumbs.dngDecimate(meta, (y) => p.subarray(y * w, (y + 2) * w), 2);
  const [r, g, b] = out.rgba;
  assert.ok(r > g && Math.abs(g - b) <= 1, [r, g, b].join());
});
```

- [ ] **Step 2: Run to verify it fails** — `npm test 2>&1 | grep -m3 "Cannot find module"` → `../thumbs.js`.

- [ ] **Step 3: Implement `thumbs.js`**

```js
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Thumbs = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Quick thumbnails for the strip, made without the GPU pipeline: the
  // camera's own EXIF thumbnail for a JPEG/.insp, and for a DNG (these carry
  // no preview) a coarse read of the raw plane -- one 2x2 Bayer block every
  // `step` pixels, only the rows it needs. They show the capture as shot
  // (both fisheye circles); app.js swaps in a snapshot of the edited
  // composition once a photo has been opened.
  const SIZE = 256;

  // The JPEG thumbnail in the Exif APP1 segment (IFD1's JPEGInterchangeFormat
  // and ...Length), as absolute offsets into `bytes`, or null.
  function exifThumbnail(bytes) {
    try {
      if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
      let o = 2;
      while (o + 4 <= bytes.length && bytes[o] === 0xff) {
        const marker = bytes[o + 1];
        const len = (bytes[o + 2] << 8) | bytes[o + 3];
        if (marker === 0xda || len < 2) return null;
        const seg = o + 4;
        if (marker === 0xe1 && bytes[seg] === 0x45 && bytes[seg + 1] === 0x78 && bytes[seg + 2] === 0x69 &&
            bytes[seg + 3] === 0x66 && bytes[seg + 4] === 0 && bytes[seg + 5] === 0) {
          const t = seg + 6;
          const le = bytes[t] === 0x49;
          const u16 = (p) => (le ? bytes[p] | (bytes[p + 1] << 8) : (bytes[p] << 8) | bytes[p + 1]);
          const u32 = (p) => (le
            ? (bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16) | (bytes[p + 3] << 24)) >>> 0
            : ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) >>> 0);
          const ifd0 = t + u32(t + 4);
          const ifd1Rel = u32(ifd0 + 2 + 12 * u16(ifd0));
          if (!ifd1Rel) return null;
          const ifd1 = t + ifd1Rel;
          let off = 0, n = 0;
          for (let i = 0; i < u16(ifd1); i++) {
            const e = ifd1 + 2 + 12 * i, tag = u16(e);
            if (tag === 0x0201) off = u32(e + 8);
            if (tag === 0x0202) n = u32(e + 8);
          }
          if (!off || !n || t + off + n > bytes.length) return null;
          return { offset: t + off, length: n };
        }
        o += 2 + len;
      }
      return null;
    } catch (e) { return null; }
  }

  const srgb = (v) => {
    const c = Math.min(1, Math.max(0, v));
    return 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
  };

  // `readPair(y)`: rows y and y+1 of the CFA plane (y even), as a Uint16Array.
  function dngDecimate(meta, readPair, size) {
    const w = meta.width, h = meta.height, long = size || SIZE;
    const step = 2 * Math.max(1, Math.ceil(Math.max(w, h) / (2 * long)));
    const ow = Math.max(1, Math.floor(w / step)), oh = Math.max(1, Math.floor(h / step));
    const rgba = new Uint8ClampedArray(ow * oh * 4);
    const span = Math.max(1, meta.whiteLevel - meta.blackLevel);
    const n = meta.asShotNeutral;
    const gain = [1 / n[0], 1 / n[1], 1 / n[2]];
    const gmax = Math.max(gain[0], gain[1], gain[2]);
    for (let c = 0; c < 3; c++) gain[c] /= gmax;
    // cfaPattern: the colour (0 R, 1 G, 2 B) at (0,0), (1,0), (0,1), (1,1).
    const cfa = meta.cfaPattern;
    for (let oy = 0; oy < oh; oy++) {
      const rows = readPair(oy * step);
      for (let ox = 0; ox < ow; ox++) {
        const x = ox * step;
        const sum = [0, 0, 0], cnt = [0, 0, 0];
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
          const c = cfa[dy * 2 + dx];
          sum[c] += (rows[dy * w + x + dx] - meta.blackLevel) / span;
          cnt[c]++;
        }
        const i = (oy * ow + ox) * 4;
        for (let c = 0; c < 3; c++) rgba[i + c] = srgb(cnt[c] ? (sum[c] / cnt[c]) * gain[c] : 0);
        rgba[i + 3] = 255;
      }
    }
    return { width: ow, height: oh, rgba };
  }

  // -- Browser only ---------------------------------------------------------
  const HEAD = 1 << 18;   // an .insp's Exif thumbnail sits in its first 256 KB

  async function bytesOf(file, start, end) {
    return new Uint8Array(await file.slice(start, end).arrayBuffer());
  }

  function canvasBlob(width, height, draw) {
    const c = document.createElement('canvas');
    c.width = width; c.height = height;
    draw(c.getContext('2d'));
    return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('thumbnail encode failed'))), 'image/jpeg', 0.85));
  }

  async function quickJpeg(file) {
    const head = await bytesOf(file, 0, HEAD);
    const t = exifThumbnail(head);
    const src = t ? new Blob([head.subarray(t.offset, t.offset + t.length)], { type: 'image/jpeg' })
      : file.slice(0, file.size, 'image/jpeg');
    const bmp = await createImageBitmap(src, { resizeWidth: SIZE * 2, resizeQuality: 'medium' });
    try {
      const s = Math.min(1, (SIZE * 2) / Math.max(bmp.width, bmp.height));
      return await canvasBlob(Math.round(bmp.width * s), Math.round(bmp.height * s),
        (g) => g.drawImage(bmp, 0, 0, Math.round(bmp.width * s), Math.round(bmp.height * s)));
    } finally { bmp.close(); }
  }

  // The DNG header and IFDs, without reading the 37 MB plane: a zero-filled
  // buffer the size of the file (untouched pages cost nothing), with the
  // first 64 KB and the IFD region copied in, is enough for Dng.parse.
  // Falls back to the whole file when that does not parse.
  async function dngMeta(file) {
    const first = await bytesOf(file, 0, Math.min(file.size, 1 << 16));
    const le = first[0] === 0x49;
    const ifd0 = le ? (first[4] | (first[5] << 8) | (first[6] << 16) | (first[7] << 24)) >>> 0
      : ((first[4] << 24) | (first[5] << 16) | (first[6] << 8) | first[7]) >>> 0;
    const sparse = new Uint8Array(file.size);
    sparse.set(first, 0);
    if (ifd0 >= first.length) {
      const tailEnd = Math.min(file.size, ifd0 + (1 << 20));
      sparse.set(await bytesOf(file, ifd0, tailEnd), ifd0);
    }
    let meta = root().Dng.parse(sparse);
    if (!meta) meta = root().Dng.parse(new Uint8Array(await file.arrayBuffer()));
    return meta;
  }
  const root = () => globalThis;

  async function quickDng(file) {
    const meta = await dngMeta(file);
    if (!meta) throw new Error('not a supported DNG');
    const rowBytes = meta.width * 2;
    const step = 2 * Math.max(1, Math.ceil(Math.max(meta.width, meta.height) / (2 * SIZE)));
    const pairs = new Map();
    const oh = Math.floor(meta.height / step);
    await Promise.all(Array.from({ length: oh }, async (_, oy) => {
      const y = oy * step;
      const b = await bytesOf(file, meta.stripOffset + y * rowBytes, meta.stripOffset + (y + 2) * rowBytes);
      const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
      const u = new Uint16Array(meta.width * 2);
      for (let i = 0; i < u.length; i++) u[i] = dv.getUint16(i * 2, meta.littleEndian);
      pairs.set(y, u);
    }));
    const out = dngDecimate(meta, (y) => pairs.get(y));
    return canvasBlob(out.width, out.height, (g) => g.putImageData(new ImageData(out.rgba, out.width, out.height), 0, 0));
  }

  function quick(file) {
    return /\.dng$/i.test(file.name) ? quickDng(file) : quickJpeg(file);
  }

  return { SIZE, exifThumbnail, dngDecimate, quick };
});
```

- [ ] **Step 4: Run tests** — `npm test 2>&1 | tail -8` → all pass.
- [ ] **Step 5: Commit point** — `thumbs.js`, `test/thumbs.test.js`.

---

### Task 3: Shortcuts for the strip

**Files:**
- Modify: `shortcuts.js` (TABLE `File` group, EXTRA, `match` typing rule)
- Test: `test/shortcuts.test.js`

**Interfaces:**
- Produces actions: `nextPhoto`, `prevPhoto`, `copyEdits`, `pasteEdits`.
  - `nextPhoto` / `prevPhoto`: PageDown / PageUp anywhere except while typing; Ctrl+→ / Ctrl+← except on a slider (Ctrl+arrow is fine-adjust there) or while typing (word jump).
  - `copyEdits`: Ctrl+Shift+C; `pasteEdits`: Ctrl+Shift+V — not while typing.

- [ ] **Step 1: Failing tests** — append to `test/shortcuts.test.js`:

```js
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
```

- [ ] **Step 2: Run** — `npm test 2>&1 | grep -E "^not ok" ` → the three new tests fail.

- [ ] **Step 3: Implement** — in `shortcuts.js`:
  - Add a `Photos` group before `Help` in TABLE:

```js
    { group: 'Photos', label: 'Next / previous photo', show: 'Page Down / Page Up  or  Ctrl+→ / Ctrl+←',
      action: null, keys: [] },
    { group: 'Photos', label: 'Copy edits', show: 'Ctrl+Shift+C', action: 'copyEdits',
      keys: [{ key: 'c', ctrl: true, shift: true }], noTyping: true },
    { group: 'Photos', label: 'Paste edits (onto the selected photos)', show: 'Ctrl+Shift+V', action: 'pasteEdits',
      keys: [{ key: 'v', ctrl: true, shift: true }], noTyping: true },
```

  - Add to EXTRA:

```js
    { action: 'nextPhoto', keys: [{ key: 'pagedown' }, { key: 'arrowright', ctrl: true, offSlider: true }] },
    { action: 'prevPhoto', keys: [{ key: 'pageup' }, { key: 'arrowleft', ctrl: true, offSlider: true }] },
```

  - In `match`, after the layout check:

```js
        if (k.offSlider && ctx.onSlider) continue;
        if (ctx.typing && (!ctrl || row.noTyping || k.offSlider || row.action === 'undo' || row.action === 'redo')) continue;
```
    (replacing the existing `if (ctx.typing && ...)` line). Update the table comment to mention `noTyping` / `offSlider`.

- [ ] **Step 4: Run** — `npm test 2>&1 | tail -8` → all pass (existing shortcut tests unchanged).
- [ ] **Step 5: Commit point** — `shortcuts.js`, `test/shortcuts.test.js`.

---

### Task 4: Multi-file opening, per-photo edits and history, the strip UI

**Files:**
- Create: `strip.js` (browser-only DOM for the filmstrip)
- Modify: `index.html` (strip markup + CSS, `multiple` on `#file`, scripts `photos.js`, `thumbs.js`, `strip.js` before `app.js`), `app.js` (loadFile superseding, `openPhoto`, `applyLoadedDescriptor(descriptor, restore)`, add/drop, keys), `history.js` (`VIEW_KEYS` gains `'stripShown'`), `settings.js` (`PERSISTED_KEYS` gains `'stripShown'`)
- Test: `test/history.test.js` (VIEW_KEYS), headless check (scratchpad)

**Interfaces:**
- Consumes: `Photos.createList/createStore/keyOf`, `Thumbs.quick`, `History.create/editSnapshot`, `Settings.sanitize/serialize`.
- Produces:
  - `strip.js` global `Strip.create(el, handlers) -> { render(list), setThumb(entry) }`; `handlers = { open(id), select(id, mode), remove(id), toggle() }`.
  - app.js internals: `addFiles(files: FileList|File[])`, `openPhoto(entry) -> Promise<boolean>`, `loadFile(file, restore?) -> Promise<boolean>` (true when this load committed), `leavePhoto()` (saves current entry), `photos` (the list), `photoStore`.
  - `window.App` gains `photos: () => photos.entries.map(e => ({ id: e.id, name: e.file.name, edited: e.edited, error: e.error, thumb: !!e.thumb, rendered: e.rendered, current: e.id === photos.currentId, selected: ... }))`, `openPhotoAt(i)`, `addFiles`.

- [ ] **Step 1: VIEW_KEYS test** — in `test/history.test.js` add:

```js
test('the strip being shown is a view preference, not an edit', () => {
  assert.ok(History.VIEW_KEYS.includes('stripShown'));
  assert.ok(Settings.PERSISTED_KEYS.includes('stripShown'));
});
```
Run `npm test` → fails. Add `'stripShown'` to `History.VIEW_KEYS` and `Settings.PERSISTED_KEYS`; add `stripShown: true` to `state` in `app.js` (next to `keyLayout`). Run → passes.

- [ ] **Step 2: Markup and CSS** (`index.html`):
  - `<input id="file" type="file" accept=".insp,.jpg,.jpeg,.dng,image/jpeg" multiple hidden>`; Open button title "Open .insp, .jpg or .dng files"; drop lead "Drop .insp, .jpg or .dng fisheye files here".
  - Body grid: `grid-template-rows: 40px minmax(0, 1fr) auto;` and `#panel { grid-row: 2 / 4; }` (panel keeps full height); after `#stage` add:

```html
  <div id="strip" class="hidden" aria-label="Photos">
    <div class="strip-head">
      <button id="stripToggle" class="btn ghost" type="button" aria-expanded="true" title="Show or hide the photos">Photos <span id="stripCount"></span></button>
      <span class="spring"></span>
      <button id="copyEdits" class="btn ghost" type="button" title="Copy this photo's edits (Ctrl+Shift+C)">Copy edits</button>
      <button id="pasteEdits" class="btn ghost" type="button" disabled title="Paste edits onto the selected photos (Ctrl+Shift+V)">Paste</button>
    </div>
    <div id="stripList" role="listbox" aria-multiselectable="true"></div>
  </div>
```

  - CSS (in the stage section):

```css
  #strip { grid-column: 1; grid-row: 3; background: var(--bar); border-top: 1px solid var(--line); min-width: 0; user-select: none; }
  #strip .strip-head { display: flex; align-items: center; gap: 6px; padding: 4px 10px; }
  #strip .strip-head .spring { flex: 1; }
  #stripCount { color: var(--mut); }
  #stripList { display: flex; gap: 6px; overflow-x: auto; padding: 0 10px 8px; height: 84px; }
  #strip.collapsed #stripList { display: none; }
  .thumb { position: relative; flex: none; height: 76px; aspect-ratio: 2 / 1; border: 1px solid var(--line-2);
    border-radius: 3px; background: #000 center / contain no-repeat; cursor: pointer; }
  .thumb.current { outline: 2px solid var(--accent); outline-offset: 1px; }
  .thumb.selected { border-color: var(--accent-soft); box-shadow: inset 0 0 0 999px rgba(255,255,255,.06); }
  .thumb .name { position: absolute; left: 4px; bottom: 2px; right: 18px; font-size: 10px; color: #ddd;
    text-shadow: 0 0 3px #000; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .thumb .dot { position: absolute; right: 5px; bottom: 5px; width: 6px; height: 6px; border-radius: 50%; background: var(--accent); }
  .thumb .rm { position: absolute; top: 2px; right: 2px; width: 16px; height: 16px; line-height: 14px; padding: 0;
    border: 0; border-radius: 50%; background: rgba(0,0,0,.6); color: #ddd; font-size: 12px; display: none; cursor: pointer; }
  .thumb:hover .rm { display: block; }
  .thumb.error { border-color: var(--err); }
  .thumb.error::after { content: '!'; position: absolute; top: 3px; left: 6px; color: var(--err); font-weight: 700; }
  .thumb.loading { opacity: .6; }
```

  - Scripts: add `<script src="photos.js"></script>`, `<script src="thumbs.js"></script>`, `<script src="strip.js"></script>` just before `app.js`.

- [ ] **Step 3: `strip.js`**

```js
(function (root) {
  'use strict';
  // The filmstrip's DOM (index.html #strip): one button per photo, redrawn
  // from the list app.js keeps (photos.js). Clicks go back through
  // `handlers`; nothing here changes the list itself.
  function create(el, handlers) {
    const listEl = el.querySelector('#stripList');
    const countEl = el.querySelector('#stripCount');
    el.querySelector('#stripToggle').addEventListener('click', () => handlers.toggle());
    listEl.addEventListener('click', (e) => {
      const t = e.target.closest('.thumb');
      if (!t) return;
      const id = Number(t.dataset.id);
      if (e.target.closest('.rm')) { handlers.remove(id); return; }
      if (e.shiftKey) handlers.select(id, 'range');
      else if (e.ctrlKey || e.metaKey) handlers.select(id, 'toggle');
      else handlers.open(id);
    });
    function render(list, opts) {
      el.classList.toggle('hidden', list.entries.length < 2);
      el.classList.toggle('collapsed', !opts.shown);
      el.querySelector('#stripToggle').setAttribute('aria-expanded', String(opts.shown));
      countEl.textContent = list.entries.length ? '(' + list.entries.length + ')' : '';
      const sel = new Set(list.selected().map((e) => e.id));
      const byId = new Map([...listEl.children].map((n) => [Number(n.dataset.id), n]));
      const nodes = list.entries.map((e) => {
        let n = byId.get(e.id);
        if (!n) {
          n = document.createElement('div');
          n.className = 'thumb';
          n.dataset.id = e.id;
          n.setAttribute('role', 'option');
          n.innerHTML = '<span class="name"></span><button class="rm" type="button" aria-label="Remove">&times;</button>';
        }
        n.title = e.error ? e.file.name + ' — ' + e.error : e.file.name;
        n.querySelector('.name').textContent = e.file.name;
        n.style.backgroundImage = e.thumb ? 'url("' + e.thumb + '")' : '';
        n.classList.toggle('current', e.id === list.currentId);
        n.classList.toggle('selected', sel.has(e.id));
        n.classList.toggle('error', !!e.error);
        n.classList.toggle('loading', e.id === opts.loadingId);
        n.setAttribute('aria-selected', String(sel.has(e.id)));
        let dot = n.querySelector('.dot');
        if (e.edited && !dot) { dot = document.createElement('span'); dot.className = 'dot'; n.appendChild(dot); }
        if (!e.edited && dot) dot.remove();
        return n;
      });
      listEl.replaceChildren(...nodes);
      const cur = listEl.querySelector('.current');
      if (cur) cur.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    return { render };
  }
  root.Strip = { create };
})(typeof globalThis !== 'undefined' ? globalThis : this);
```

- [ ] **Step 4: app.js — superseded loads and restore on load.**
  - Change `async function loadFile(file)` to `async function loadFile(file, restore)`; at the top `const my = ++loadSeq;` (declare `let loadSeq = 0;` above it). Right after `const descriptor = await Source.decode(...)`:

```js
      // A newer switch (openPhoto) has started since: drop this one.
      if (my !== loadSeq) {
        if (descriptor.bitmaps) for (const b of descriptor.bitmaps) b.close();
        return false;
      }
```
    and also check `my !== loadSeq` after `await file.arrayBuffer()` (return false). End of try: `applyLoadedDescriptor(descriptor, restore); return true;`. In the catch: `fail(...); return false;`.
  - `applyLoadedDescriptor(descriptor, restore)`: after `Object.assign(state, patch);` add

```js
    // This photo's own edits (openPhoto), sanitized like stored settings,
    // win over what the file itself says (its as-shot white balance).
    if (restore && restore.edits) {
      const merged = Object.assign(Settings.serialize(state), restore.edits);
      const clean = Settings.sanitize(state, merged);
      for (const k of Object.keys(restore.edits)) if (k in clean) state[k] = clean[k];
      if (descriptor.lensCount === 1) state.sensors = 'A';
      state.swap = Settings.resolveSwapForLoad(state.swap, descriptor.lensCount);
    }
```
    and replace the final `resetHistory();` with

```js
    // History is per photo: a photo opened before gets its own back.
    if (restore && restore.history) { editHistory = restore.history; historyPending = false; }
    else { editHistory = History.create(); resetHistory(); }
```
    (`const editHistory` becomes `let editHistory`; move its declaration above `loadFile` or keep it where it is — `applyLoadedDescriptor` only runs after init.) `syncControlsFromState()` must run after the restore — add it right after the restore block if the existing per-control syncing below does not cover every field (it does not: call `syncControlsFromState();` there).

- [ ] **Step 5: app.js — the photo flow.** Add a `// -- Photos (the strip) --` section near the load code:

```js
  const photos = Photos.createList();
  const photoStore = Photos.createStore(window.localStorage);
  let loadingId = null, storeWarned = false;
  const strip = Strip.create(document.getElementById('strip'), {
    open: (id) => { const e = photos.byId(id); if (e) openPhoto(e); },
    select: (id, mode) => { photos.select(id, mode); drawStrip(); },
    remove: (id) => removePhoto(id),
    toggle: () => { state.stripShown = !state.stripShown; saveSettings(); drawStrip(); render(); },
  });
  function drawStrip() { strip.render(photos, { shown: state.stripShown, loadingId }); }
  const currentPhoto = () => photos.byId(photos.currentId);

  // Keeps the open photo's edits and undo history in its entry (and its
  // edits in storage) before another photo replaces it on the GPU.
  function leavePhoto() {
    const cur = currentPhoto();
    if (!cur || !loaded()) return;
    commitHistory();
    cur.history = editHistory;
    cur.edits = editSnapshot();
    if (cur.edited) {
      if (!photoStore.save(cur.key, cur.edits) && !storeWarned) {
        storeWarned = true;
        warn('Browser storage is full or unavailable: edits are kept only until this page is closed.');
      }
    }
    snapshotThumb(cur, true);
  }

  async function openPhoto(entry) {
    if (entry.id === photos.currentId && loaded()) return true;
    leavePhoto();
    loadingId = entry.id;
    drawStrip();
    const edits = entry.edits || photoStore.load(entry.key);
    const ok = await loadFile(entry.file, { edits, history: entry.history });
    if (loadingId === entry.id) loadingId = null;
    if (ok) {
      photos.currentId = entry.id;
      photos.select(entry.id, 'only');
      entry.error = null;
    } else if (!ok && errorEl.textContent) {
      entry.error = errorEl.textContent;
    }
    drawStrip();
    return ok;
  }

  function addFiles(files) {
    const { added, skipped } = photos.add(Array.from(files));
    for (const e of added) e.edited = photoStore.has(e.key);
    if (skipped.length) warn('Not a supported photo (.insp, .jpg, .dng): ' + skipped.join(', '));
    drawStrip();
    queueThumbs(added);
    const first = added[0];
    if (first && !loaded()) openPhoto(first);
    else if (added.length === 1 && files.length === 1) openPhoto(first);   // a single file opened: show it, as before
  }

  async function removePhoto(id) {
    const e = photos.byId(id);
    if (!e) return;
    const wasCurrent = id === photos.currentId;
    if (wasCurrent) leavePhoto();
    const next = photos.remove(id);
    if (e.thumb) URL.revokeObjectURL(e.thumb);
    if (wasCurrent) {
      photos.currentId = null;
      if (next) await openPhoto(next);
      else closePhoto();
    }
    drawStrip();
  }
```
  - `closePhoto()`: returns to the empty drop screen — `GL.releaseLenses(ctx)` if it exists, else leave textures (check gl.js for a release function: `GL.releaseLens(ctx, slot)` exists per settings comment; call it for slots 0 and 1), `state.sourceName = null; state.sourceLensSize = 0;`, `document.body.classList.remove('loaded'); dropEl.classList.remove('hidden'); exportBtn.disabled = true; printBtn.disabled = true; updateFileHeader();`.
  - Hook `noteEdit()`: after `historyPending = true;` add `const cur = currentPhoto(); if (cur && !cur.edited) { cur.edited = true; drawStrip(); }` (skipped while `restoring`, which already returns early).
  - Replace the file-input and drop handlers:

```js
  fileEl.addEventListener('change', () => { if (fileEl.files.length) addFiles(fileEl.files); fileEl.value = ''; });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });
```
    An existing single-file flow (a new file while one is open) now adds it and opens it (the `added.length === 1` rule above).
  - Thumbnails queue (one at a time, idle):

```js
  let thumbQueue = Promise.resolve();
  function queueThumbs(entries) {
    for (const e of entries) {
      thumbQueue = thumbQueue.then(async () => {
        if (e.thumb || !photos.byId(e.id)) return;
        try {
          const blob = await Thumbs.quick(e.file);
          if (!e.rendered && photos.byId(e.id)) { e.thumb = URL.createObjectURL(blob); drawStrip(); }
        } catch (err) { /* placeholder with the name stays */ }
      });
    }
  }
```
  - Keys: in the shortcut action map add

```js
    nextPhoto: () => { const c = currentPhoto(); const n = c && photos.neighbour(c.id, 1); if (!n) return false; openPhoto(n); },
    prevPhoto: () => { const c = currentPhoto(); const n = c && photos.neighbour(c.id, -1); if (!n) return false; openPhoto(n); },
```
  - Rendering around the strip: the stage shrinks when the strip shows; the existing `ResizeObserver` on `#stage` already re-renders.
  - `window.App` additions as listed under Interfaces.

- [ ] **Step 6: Headless check (scratchpad `strip_check.py` using `cdp.py`).** Serve the repo with `nocache.py` on 8766; open `index.html`; use `DOM.setFileInputFiles` on `#file` with `Testfiles/IMG_20240825_174907_00_020.dng`, `Testfiles/IMG_20260511_094146_00_004.insp`, `Testfiles/Sunscreen.insp` (read-only use). Then evaluate, in order, asserting each:
  1. `App.photos().length === 3`, first is current; within 5 s every `thumb` is true.
  2. Set `App.state.tone.exposureEv = 1` via the Exposure slider's input event; wait 500 ms; `App.photos()[0].edited === true`.
  3. **Raw WB round trip:** set lens A temp slider to a new value; `openPhotoAt(1)`; `openPhotoAt(0)`; `App.state.rawWb.A.temp` equals the value set, and `exposureEv === 1`.
  4. Photo 1 (`.insp`) `exposureEv` is the last-used value (1) — the spec's "starts from last used" — and its own later change does not alter photo 0.
  5. **Undo per photo:** on photo 0, `App.undo()` reverts only photo 0's last change; switch to 1 and back; `App.canUndo()` still reflects photo 0's history.
  6. **Rapid switching:** call `openPhotoAt(1); openPhotoAt(2); openPhotoAt(0)` without awaiting; after 5 s current is photo 0 and `App.state.sourceName` is its name; no console errors.
  7. **Mixed drop:** `App.addFiles([...same three File objects..., new File(['x'], 'notes.txt')])` → still 3 photos, a warning names notes.txt.
  8. Screenshot `strip.png` for the user.
- [ ] **Step 7: Commit point** — `strip.js`, `index.html`, `app.js`, `history.js`, `settings.js`, `test/history.test.js`.

---

### Task 5: Rendered previews and copy / paste edits

**Files:**
- Modify: `app.js`, `index.html` (buttons already added in Task 4)

**Interfaces:**
- Consumes: `photos`, `photoStore`, `currentPhoto()`, `commitHistory()`, `applySnapshot(snap)`, `Photos.pasteable`.
- Produces: `snapshotThumb(entry, force)`, `copyEdits()`, `pasteEdits()`; actions `copyEdits` / `pasteEdits`; `window.App.copyEdits/pasteEdits/selectPhoto(i, mode)`.

- [ ] **Step 1: Rendered preview.** In app.js:

```js
  // A small picture of the open photo as edited, for its strip thumbnail:
  // the preview canvas, cropped to the composition (previewPlace), copied
  // right after a render (the WebGL buffer is only readable in the same
  // task). Only at Fit, where the canvas holds the whole composition,
  // unless `force` (leaving the photo), which renders at Fit for it.
  function snapshotThumb(entry, force) {
    if (!entry || !loaded() || beforeView) return;
    if (zoom && !force) return;
    const saved = zoom;
    zoom = null;
    render();
    const p = previewPlace;
    const s = Thumbs.SIZE / Math.max(p.width, p.height);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(p.width * s));
    c.height = Math.max(1, Math.round(p.height * s));
    c.getContext('2d').drawImage(canvas, p.x, p.y, p.width, p.height, 0, 0, c.width, c.height);
    zoom = saved;
    if (saved) render();
    c.toBlob((b) => {
      if (!b || !photos.byId(entry.id)) return;
      if (entry.thumb) URL.revokeObjectURL(entry.thumb);
      entry.thumb = URL.createObjectURL(b);
      entry.rendered = true;
      drawStrip();
    }, 'image/jpeg', 0.85);
  }
```
  (Check `previewPlace`'s field names in `View.visibleRect`/`GL.placedLayout` — use its real x/y/width/height names.) Call `snapshotThumb(currentPhoto())` at the end of `commitHistory()` when `editHistory.record(...)` returned true, and at the end of `openPhoto` on success (after `drawStrip`), via `requestAnimationFrame` so the first frame has rendered. With Detail developing on the CPU the first snapshot may show the undeveloped frame; also call it from the `ctx.dev.onProgress` completion if `GL.developSettled` resolves — keep it simple: `GL.developSettled(ctx, state).then(() => snapshotThumb(currentPhoto()))`.

- [ ] **Step 2: Copy / paste.**

```js
  let clipboardEdits = null;
  function copyEdits() {
    if (!loaded()) return false;
    commitHistory();
    clipboardEdits = Photos.pasteable(editSnapshot());
    pasteBtn.disabled = false;
    note('Edits copied' + (photos.entries.length > 1 ? ' — select photos and paste' : ''));
  }
  function pasteEdits() {
    if (!clipboardEdits || !loaded()) return false;
    const targets = photos.selected();
    for (const e of targets) {
      if (e.id === photos.currentId) {
        commitHistory();
        applySnapshot(Object.assign(editSnapshot(), clipboardEdits));
        historyPending = true;
        commitHistory();              // one undo step
        e.edited = true;
      } else {
        const base = e.edits || photoStore.load(e.key) || {};
        e.edits = Object.assign({}, base, JSON.parse(JSON.stringify(clipboardEdits)));
        e.edited = true;
        photoStore.save(e.key, e.edits);
        if (e.rendered) { e.rendered = false; if (e.thumb) URL.revokeObjectURL(e.thumb); e.thumb = null; queueThumbs([e]); }
      }
    }
    drawStrip();
    note('Edits pasted onto ' + targets.length + (targets.length === 1 ? ' photo' : ' photos'));
  }
```
  - `note(msg)`: if app.js has no neutral status line, use `warn` styled text via the existing `#detailMem`-like pattern — check for an existing info/status element (`showPickNote` exists for the match tool: reuse its element via a small `note()` wrapper, or add `function note(msg) { warningEl.textContent = msg; }` next to `warn`).
  - A photo that is not open but has `e.edits` from paste: `openPhoto` passes `entry.edits` first, so the pasted edits apply when it opens; its `history` is left as is — the paste becomes the new state (record it: after load, if `entry.pastedPending`, call `historyPending = true; commitHistory();`). Implement by setting `e.pastedPending = true` in paste and handling it at the end of `openPhoto`.
  - Buttons: `copyEditsBtn.addEventListener('click', copyEdits); pasteBtn.addEventListener('click', pasteEdits);`; key actions `copyEdits`, `pasteEdits` in the shortcut map (`preventDefault` is done by the shared handler when an action returns anything but `false` — check the existing keydown handler and follow it).

- [ ] **Step 3: Headless check** (extend `strip_check.py`):
  1. After an edit on photo 0 settles, `App.photos()[0].rendered === true`.
  2. `App.copyEdits()`; `App.selectPhoto(1, 'toggle')`; `App.selectPhoto(2, 'toggle')`; `App.pasteEdits()`; open photo 2 → `exposureEv` equals photo 0's, `rollDeg` is photo 2's own (set a distinct roll on photo 2 beforehand).
  3. Real key events via cdp `key` steps: Ctrl+Shift+C then Ctrl+Shift+V do not open DevTools-like side effects and trigger the actions (check `App` state), and PageDown switches photo.
- [ ] **Step 4: Commit point** — `app.js`.

---

### Task 6: Export the selection

**Files:**
- Modify: `app.js` (`updateExportLabel`, export click, Esc)

**Interfaces:**
- Consumes: `photos.selected()`, `openPhoto(entry)`, `exportImage(opts)`.
- Produces: `exportSelected()`; `window.App.exportSelected`.

- [ ] **Step 1: Implement**

```js
  let exportRun = null;   // { cancel: boolean } while exporting several
  async function exportSelected() {
    const targets = photos.selected();
    const back = currentPhoto();
    const opts = { format: state.format, quality: state.quality, padToSensorSquare: state.padToSensorSquare };
    exportRun = { cancel: false };
    try {
      for (let i = 0; i < targets.length && !exportRun.cancel; i++) {
        note('Exporting ' + (i + 1) + ' of ' + targets.length + ' — Esc to stop');
        if (!(await openPhoto(targets[i]))) continue;
        await exportImage(opts);
      }
    } finally {
      const stopped = exportRun.cancel;
      exportRun = null;
      if (back && photos.byId(back.id)) await openPhoto(back);
      note(stopped ? 'Export stopped' : 'Exported ' + targets.length + ' photos');
    }
  }
```
  - Export button click: `if (photos.selected().length > 1) exportSelected(); else exportImage(...)` (existing call). Format/quality are the open photo's Output settings (they are app state, not per photo — as the spec says each photo keeps its *edits*).
  - `updateExportLabel()`: when `photos.selected().length > 1`, the button text is `'Export ' + n`; call `updateExportLabel()` from `drawStrip()`.
  - Esc: in the keydown handler, before shortcut matching, `if (exportRun && e.key === 'Escape') { exportRun.cancel = true; e.preventDefault(); return; }`.
  - Ctrl+Shift+E (`export` action) goes through `exportBtn.click()` already, so it follows.
- [ ] **Step 2: Headless check** — select photos 0 and 1, `await App.exportSelected()`; using `Browser.setDownloadBehavior` to the scratchpad `downloads/` dir, two files appear with each source's stem; photo 0 is current afterwards.
- [ ] **Step 3: Commit point** — `app.js`.

---

### Task 7: Docs and final verification

**Files:**
- Modify: `README.md` (a "Several photos" section: opening many, the strip, per-photo edits, copy/paste, Export N, keys), Keys help comes from the table automatically.

- [ ] **Step 1:** Write the README section (short, matching its tone).
- [ ] **Step 2:** `npm test` — all pass; paste the tail.
- [ ] **Step 3:** Run the whole `strip_check.py` again; send `strip.png` to the user.
- [ ] **Step 4:** Commit when the user asks: one commit `feat: open several photos -- filmstrip, per-photo edits, copy/paste, export selection` with the trailer.
