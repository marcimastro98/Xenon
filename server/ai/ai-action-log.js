'use strict';

// In-memory ring buffer of the AI's recent state-mutating actions, so the user
// can SEE what Xenon did and UNDO the regrettable ones (a notes overwrite, a bulk
// clear, a just-created item). Deliberately NOT persisted: an undo is a
// short-term affordance, and restoring a stale snapshot after a restart would be
// worse than offering none. The `undo` field is a plain data descriptor
// ({ kind, ... }) — the server maps a kind to its restore effect — so this module
// stays pure and unit-testable.

const MAX_ENTRIES = 25;

function createAiActionLog({ now = Date.now } = {}) {
  const entries = []; // oldest first, newest last
  let seq = 0;

  function record({ name, label, undo = null }) {
    seq += 1;
    const entry = {
      id: `a${now().toString(36)}${seq.toString(36)}`,
      ts: now(),
      name: String(name || ''),
      label: String(label || ''),
      undo: undo || null,
      undone: false,
    };
    entries.push(entry);
    while (entries.length > MAX_ENTRIES) entries.shift();
    return entry;
  }

  function list() {
    return entries.map((e) => ({
      id: e.id, ts: e.ts, name: e.name, label: e.label,
      undoable: !!e.undo && !e.undone, undone: e.undone,
    }));
  }

  function get(id) {
    return entries.find((e) => e.id === id) || null;
  }

  function markUndone(id) {
    const e = get(id);
    if (e) e.undone = true;
    return e;
  }

  // The most recent still-undoable action (what an "undo last" affordance targets).
  function lastUndoable() {
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].undo && !entries[i].undone) return entries[i];
    }
    return null;
  }

  return { record, list, get, markUndone, lastUndoable };
}

module.exports = { createAiActionLog, MAX_ENTRIES };
