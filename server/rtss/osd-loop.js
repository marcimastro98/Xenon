'use strict';
// When Xenon writes its readings into RivaTuner's slot, and when it gives the slot back.
//
// Only over a game in exclusive full screen: there no window can show, so RTSS draws
// the readings inside the game. In borderless or windowed full screen Xenon's own
// overlay shows them, and writing to RTSS too would put every number on screen twice.
// So the slot is given back as soon as the game leaves exclusive, closes, or the
// option goes off, and when the engine stops. A slot a crashed engine left behind is
// given back the first time the next engine reads the option on: not at start, which
// comes before the engine has read the settings (the option would read off).
//
// One look every 3 s while the option is on, with no game in exclusive: is RivaTuner
// open (its memory opened and closed at once), is a game running. With the option off
// nothing is opened at all. While RivaTuner is open the frame reader is asked to run
// (`want`), before any game: a game may refuse a trace that starts after it does.

const OWNER = 'Xenon';
const IDLE_MS = 3000;
const LIVE_MS = 1000;   // RTSS's own readings refresh once a second too

// deps: {
//   memory: { write(owner, text) → 'written'|'busy'|'full'|'closed', release(owner), running() },
//   enabled(), gameRunning(), exclusive(), text() → Promise<string>,
//   want(on)? the frame reader is wanted (true) or no longer (false), timers?
// }
function createOsdLoop(deps) {
  const timers = deps.timers || { setTimeout, clearTimeout };
  let timer = null;
  let holding = false;
  let last = '';
  let stopped = true;
  let wanting = false;
  let swept = false;

  function sweep() {
    if (swept) return;
    swept = true;
    try { deps.memory.release(OWNER); } catch { /* RTSS not running: no slot to find */ }
  }

  function wantReader(on) {
    if (on === wanting) return;
    wanting = on;
    try { deps.want?.(on); } catch { /* the reader keeps its own rule */ }
  }

  function rtssOpen() {
    try { return deps.memory.running() === true; } catch { return false; }
  }

  function giveBack() {
    if (!holding) return;
    holding = false;
    last = '';
    try { deps.memory.release(OWNER); } catch { /* RTSS closed: its slots went with it */ }
  }

  function schedule(ms) {
    if (stopped) return;
    timer = timers.setTimeout(tick, ms);
    timer?.unref?.();
  }

  async function tick() {
    timer = null;
    let wait = IDLE_MS;
    try {
      const on = deps.enabled();
      if (on) sweep();
      wantReader(on && rtssOpen());
      const game = on && deps.gameRunning();
      if (game) wait = LIVE_MS;
      const text = game && deps.exclusive() ? await deps.text() : '';
      if (stopped) return;
      if (text) {
        last = deps.memory.write(OWNER, text);
        // 'busy' still holds the slot: the text goes in on the next try.
        holding = last === 'written' || last === 'busy';
      } else giveBack();
    } catch { giveBack(); }
    schedule(wait);
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    schedule(IDLE_MS);
  }

  function stop() {
    stopped = true;
    if (timer) timers.clearTimeout(timer);
    timer = null;
    giveBack();
    wantReader(false);
  }

  // What the option's row says: whether RTSS runs, and whether it draws Xenon's readings now.
  function state() {
    const running = rtssOpen();
    return { running, showing: running && holding && last === 'written' };
  }

  // Whether RivaTuner holds Xenon's readings over a game now: the engine keeps reading
  // the sensors for it even with no dashboard connected.
  const drawing = () => !stopped && holding;

  return { start, stop, state, drawing, OWNER };
}

module.exports = { createOsdLoop, OWNER, IDLE_MS, LIVE_MS };
