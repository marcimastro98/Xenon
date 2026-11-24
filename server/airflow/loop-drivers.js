'use strict';
// Each fan driver answers in its own time, one call at a time and in the order asked. A tick
// waits for a driver's reading or command at most WAIT_MS: a LINK hub waiting on USB (2 s a
// call, server/hid/bounded-call.js) or on libuv's shared pool must never hold the board's
// commands, since the sensor service hands those fans to the BIOS after 5 s without one
// (23 Nov 2026). A driver still busy is not asked again: its last reading stands while it
// is recent (it carries its own age, which the safety layer judges), and it gets the next
// tick's command instead of this one. Letting go (release) always reaches it, after the
// call it is busy with.
const { within } = require('./within.js');
const { STALE_MS } = require('./limits.js');

const WAIT_MS = 500;

/** @param {{ clock?: () => number, waitMs?: number }} [opts] */
function createDriverCalls({ clock = Date.now, waitMs = WAIT_MS } = {}) {
  /** @type {Map<any, Promise<void>>} the end of each busy driver's line of calls */
  const lines = new Map();
  /** @type {Map<any, { value: any, at: number }>} each driver's last reading and when it landed */
  const last = new Map();

  /**
   * One call to one driver, after the calls asked of it before.
   * @template T @param {any} d @param {(d: any) => Promise<T>} fn @returns {Promise<T>}
   */
  function run(d, fn) {
    const out = (lines.get(d) || Promise.resolve()).then(() => fn(d));
    const end = out.then(() => {}, () => {});
    lines.set(d, end);
    end.then(() => { if (lines.get(d) === end) lines.delete(d); });
    return out;
  }
  const busy = (/** @type {any} */ d) => lines.has(d);

  /** @param {any} d */
  function read(d) {
    return run(d, (x) => x.poll()).catch(() => null)
      .then((value) => { last.set(d, { value, at: clock() }); return value; });
  }
  /** @param {any} d */
  function recent(d) {
    const r = last.get(d);
    return r && clock() - r.at <= STALE_MS ? r.value : null;
  }

  /**
   * Every driver's reading for this tick, null for one that failed or has none recent.
   * `all` waits for every driver to answer now (a look, with no fans held).
   * @param {any[]} drivers @param {boolean} all
   */
  function poll(drivers, all) {
    return Promise.all(drivers.map(async (d) => {
      if (all) return read(d);
      if (!busy(d)) await within(read(d), waitMs);
      return recent(d);
    }));
  }

  /**
   * `send(driver)` to every driver not busy; `queue` sends it to a busy one too, after its
   * call (letting go). Waits at most WAIT_MS for them.
   * @param {any[]} drivers @param {(d: any) => Promise<void>} send @param {boolean} queue
   */
  async function act(drivers, send, queue) {
    const flights = drivers.filter((d) => queue || !busy(d)).map((d) => run(d, send).catch(() => {}));
    await within(Promise.all(flights), waitMs);
  }

  return { run, poll, act };
}

module.exports = { createDriverCalls, WAIT_MS };
