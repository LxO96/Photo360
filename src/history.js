(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.History = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Undo / redo over snapshots of the edit settings (app.js decides what a
  // snapshot holds and when a change is finished -- a whole slider drag,
  // not every input event -- and calls record() then). Snapshots are plain
  // JSON-able values, stored as JSON strings: compared by content, and
  // never shared with the live state.
  const LIMIT = 100;

  // The keys of a Settings.serialize()d state that are edits (undoable);
  // the rest -- open panels, the scopes -- are view preferences.
  const VIEW_KEYS = ['panels', 'scopesShown', 'scopeMode', 'scopeChannels', 'scopeScale', 'keyLayout', 'stripShown'];

  function editSnapshot(serialized) {
    const out = {};
    for (const k of Object.keys(serialized)) if (!VIEW_KEYS.includes(k)) out[k] = serialized[k];
    return out;
  }

  function create(limit) {
    const max = limit || LIMIT;
    let undo = [], redo = [], current = null;
    return {
      // Starts over from `snap` (a new file): nothing to undo or redo.
      reset(snap) {
        undo = []; redo = [];
        current = JSON.stringify(snap);
      },
      // A finished change: if `snap` differs from the current state, the
      // current one becomes undoable and redo is cleared. Returns whether
      // it was a change.
      record(snap) {
        const s = JSON.stringify(snap);
        if (current === null) { current = s; return false; }
        if (s === current) return false;
        undo.push(current);
        if (undo.length > max) undo.shift();
        redo = [];
        current = s;
        return true;
      },
      // The snapshot to go back / forward to, or null.
      undo() {
        if (!undo.length) return null;
        redo.push(current);
        current = undo.pop();
        return JSON.parse(current);
      },
      redo() {
        if (!redo.length) return null;
        undo.push(current);
        current = redo.pop();
        return JSON.parse(current);
      },
      canUndo: () => undo.length > 0,
      canRedo: () => redo.length > 0,
    };
  }

  return { LIMIT, VIEW_KEYS, editSnapshot, create };
});
