'use strict';
// A key that shows or hides a widget on the screen (`key` on a placed widget,
// js/layers-model.js). Pressed: the widget switches between shown and hidden.
// Held: it shows only while the keys are down. What it hides goes out with the
// rules' answer as `whenOff` (opaque ids), so the layer pages need nothing new.
//
// The state lives only here: after a restart every widget is back on the screen.
// Holding needs the key's release, which only Xenon Helper reports (`release` in
// its `ready` line). Without it (Linux, an older helper) a press shows the widget
// for PEEK_MS instead, and the menu says so.
const LayersModel = require('./js/layers-model.js');

const PEEK_MS = 4000;
const SLOT_PREFIX = 'widget-';

// layers()   the stored layers (identity changes on a write)
// onChange() what is hidden moved: push it now, not on the next tick
function createWidgetKeys({ layers, onChange = () => {}, peekMs = PEEK_MS, timers = { setTimeout, clearTimeout } }) {
  const switchedOff = new Set();
  const held = new Set();
  const peeks = new Map();   // id -> timer
  let canRelease = false;
  let seen;
  let keyed = new Map();     // box lead id -> { combo, hold? }

  function read() {
    const raw = layers();
    if (raw === seen) return keyed;
    seen = raw;
    const cur = LayersModel.normalize(raw);
    keyed = new Map(LayersModel.boxes(cur.widgets).filter((b) => b.lead.key).map((b) => [b.lead.id, b.lead.key]));
    // A widget gone, or a key taken away or moved to the other way, starts over.
    for (const id of switchedOff) if (!keyed.has(id) || keyed.get(id).hold) switchedOff.delete(id);
    for (const id of held) if (!keyed.has(id) || !keyed.get(id).hold) held.delete(id);
    for (const [id, t] of peeks) if (!keyed.has(id) || !keyed.get(id).hold) { timers.clearTimeout(t); peeks.delete(id); }
    return keyed;
  }

  // The rows for the hotkey table: one per box with a key, never on a combo
  // `taken` already holds, at most `room` of them.
  function bindings(taken = [], room = Infinity) {
    const used = new Set(taken);
    const out = [];
    for (const [id, key] of read()) {
      if (out.length >= room) break;
      if (used.has(key.combo)) continue;
      used.add(key.combo);
      out.push({ slot: SLOT_PREFIX + id, combo: key.combo, widgetId: id });
    }
    return out;
  }

  function peek(id) {
    if (peeks.has(id)) timers.clearTimeout(peeks.get(id));
    const t = timers.setTimeout(() => { peeks.delete(id); onChange(); }, peekMs);
    if (t && typeof t.unref === 'function') t.unref();
    peeks.set(id, t);
  }

  function press(id) {
    const key = read().get(id);
    if (!key) return false;
    if (!key.hold) {
      if (!switchedOff.delete(id)) switchedOff.add(id);
    } else if (canRelease) {
      if (held.has(id)) return true;   // a key's own repeat
      held.add(id);
    } else {
      peek(id);
    }
    onChange();
    return true;
  }

  function release(id) {
    if (!held.delete(id)) return false;
    onChange();
    return true;
  }

  // The helper went away: no release will come for what it held.
  function releaseAll() {
    if (!held.size) return;
    held.clear();
    onChange();
  }

  function setRelease(on) {
    canRelease = on === true;
    if (!canRelease) releaseAll();
  }

  // Box lead ids the keys hide now.
  function hidden() {
    const out = [];
    for (const [id, key] of read()) {
      const off = key.hold ? !held.has(id) && !peeks.has(id) : switchedOff.has(id);
      if (off) out.push(id);
    }
    return out;
  }

  function stop() {
    for (const t of peeks.values()) timers.clearTimeout(t);
    peeks.clear();
    held.clear();
    switchedOff.clear();
  }

  return {
    bindings, press, release, releaseAll, setRelease, hidden, stop,
    holdsRelease: () => canRelease,
  };
}

module.exports = { createWidgetKeys, PEEK_MS };
