'use strict';
// The facts behind "only while I listen to music": what the rules on the placed
// widgets and pages ask, read from the sources the server already has, and only
// while a rule uses them. No timer of its own: tick() rides the 3 s status tick, and
// the answer goes out as `whenOff` (opaque widget ids) in the status payload, so an
// app's name never leaves the server.
const LayersModel = require('./js/layers-model.js');
const LayerWhen = require('./js/layer-when.js');

const IDLE_AFTER_S = 300;
// Busy needs two readings in a row, and a clear fall to end, so a spike moves nothing.
const BUSY_ON = 85;
const BUSY_OFF = 70;
const BUSY_TICKS = 2;
// Read on the tick from values the server keeps anyway.
const CHEAP = Object.freeze(['game', 'live', 'recording', 'timer', 'dnd']);
// Worth a process or a query: each waits this long before it is asked again.
const EVERY_MS = Object.freeze({ music: 3000, call: 6000, open: 15000, battery: 30000 });

// layers()   the stored layers (identity changes on a write)
// read       { game, live, recording, timer, dnd, cpu, idleSec, front } answer now;
//            { music, call, open, battery } may answer later
// isOwnApp   the name of a window of ours: touching a widget must not change the
//            app "in front", or a widget for Excel would vanish when it is pressed
// onChange() the hidden list moved outside a tick
// onPlan()   the set of facts in use moved (a source may need arming)
// onFacts(f) every settled reading, for the pages
function createSituations({ layers, read, isOwnApp = () => false, onChange = () => {}, onPlan = () => {}, onFacts = () => {}, clock = () => new Date(), warn = () => {} }) {
  const facts = { front: '', open: [], battery: null, now: null };
  const askedAt = new Map();
  const flying = new Set();
  const known = new Set();
  let seen;
  let cur = null;
  let need = new Set();
  let off = [];
  let busyRun = 0;

  function plan() {
    const raw = layers();
    if (raw === seen) return;
    seen = raw;
    cur = raw ? LayersModel.normalize(raw) : null;
    const rules = cur ? [...cur.widgets.map((w) => w.when), ...cur.pages.map((p) => p.when)] : [];
    const next = LayerWhen.factsNeeded(rules);
    const moved = [...next].sort().join() !== [...need].sort().join();
    need = next;
    if (moved) onPlan();
  }

  function readBusy() {
    const cpu = Number(read.cpu());
    if (!Number.isFinite(cpu)) return;
    if (facts.busy) { if (cpu < BUSY_OFF) { facts.busy = false; busyRun = 0; } return; }
    busyRun = cpu >= BUSY_ON ? busyRun + 1 : 0;
    if (busyRun >= BUSY_TICKS) facts.busy = true;
  }

  function readFront() {
    const name = LayerWhen.appKey(read.front());
    if (name && !isOwnApp(name)) facts.front = name;
  }

  function readCheap() {
    for (const fact of CHEAP) if (need.has(fact)) facts[fact] = read[fact]() === true;
    if (need.has('idle')) { const s = read.idleSec(); facts.idle = s != null && s >= IDLE_AFTER_S; }
    if (need.has('busy')) readBusy();
    if (need.has('front')) readFront();
    if (need.has('now')) { const d = clock(); facts.now = { minutes: d.getHours() * 60 + d.getMinutes(), day: d.getDay() }; }
  }

  const shape = {
    music: (v) => v === true,
    call: (v) => v === true,
    open: (v) => (Array.isArray(v) ? [...new Set(v.map(LayerWhen.appKey).filter(Boolean))] : []),
    battery: (v) => (v && Number.isFinite(v.percent) ? { percent: v.percent, plugged: !!v.plugged } : null),
  };

  function readSlow() {
    const at = Date.now();
    for (const [fact, every] of Object.entries(EVERY_MS)) {
      if (!need.has(fact) || flying.has(fact) || at - (askedAt.get(fact) || 0) < every) continue;
      flying.add(fact);
      askedAt.set(fact, at);
      Promise.resolve()
        .then(() => read[fact]())
        .then((value) => { facts[fact] = shape[fact](value); })
        .catch(() => warn('situations: could not read ' + fact))
        .finally(() => { flying.delete(fact); known.add(fact); settle(true); });
    }
  }

  // Nothing is decided on a fact not read yet: a widget would blink out at every start.
  const ready = () => Object.keys(EVERY_MS).every((fact) => !need.has(fact) || known.has(fact));

  function hiddenNow() {
    if (!cur) return [];
    return cur.widgets.filter((w) => w.when && !LayerWhen.shows(w.when, facts)).map((w) => w.id).sort();
  }

  function settle(notify) {
    if (!ready()) return;
    const next = hiddenNow();
    const moved = next.join() !== off.join();
    off = next;
    if (need.size) onFacts(facts);
    if (moved && notify) onChange();
  }

  function tick() {
    plan();
    if (!need.size) { off = []; return; }
    readCheap();
    readSlow();
    settle(false);
  }

  return {
    tick,
    hidden: () => off,
    needs(fact) { plan(); return need.has(fact); },
  };
}

module.exports = { createSituations, IDLE_AFTER_S, BUSY_ON, BUSY_OFF };
