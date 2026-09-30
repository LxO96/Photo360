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
  // Keys pasting edits onto another photo leaves out. None: photos from
  // one shoot share their levelling too (Camera roll, lens nudge), and a
  // photo that needs its own is levelled after pasting.
  const PASTE_SKIP = [];

  const keyOf = (file) => file.name + '|' + file.size + '|' + file.lastModified;
  // A photo's name: its file's, or its own (a merged HDR photo has no file).
  const nameOf = (entry) => entry.name || (entry.file ? entry.file.name : '');
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

  // The strip's photos in order, and which are selected (for paste and
  // Export N). `currentId` -- the open photo, set by app.js -- always
  // counts as selected.
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
    // A photo with no file of its own (a merged HDR photo: `fields` carry
    // its key, name and members), placed after `afterId`; the one already
    // there if its key is.
    list.insertAfter = (afterId, fields) => {
      const have = list.entries.find((e) => e.key === fields.key);
      if (have) return have;
      const entry = Object.assign({ id: nextId++, file: null, key: '', thumb: null, rendered: false,
        edits: null, history: null, edited: false, error: null }, fields);
      const i = list.indexOf(afterId);
      list.entries.splice(i < 0 ? list.entries.length : i + 1, 0, entry);
      return entry;
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
      } else if (mode === 'range' && anchorId !== null && list.indexOf(anchorId) >= 0) {
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

  return { INDEX_KEY, RECORD_PREFIX, CAP, SUPPORTED, PASTE_SKIP, keyOf, nameOf, pasteable, createStore, createList };
});
