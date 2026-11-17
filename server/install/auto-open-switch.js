'use strict';
// What the engine tells the switch in Settings about the browser tab at sign-in, and what it
// keeps when the switch is turned.
//
// Turning the switch registers nothing with the system. It writes one settings key
// (autoOpenArmed) that the engine reads at the next sign-in, and that only a dashboard in a
// real browser at the PC can set: the page keeps the app and an embedded view from asking,
// and the engine refuses the address to a paired device (remote-access.js REMOTE_DENY) and to a
// page on another site (CSRF_MUTATION_PATHS).

const { PORT, updateHubSettingKey, readHubSettings } = require('./engine-link.js');
const { signInOpenSupported } = require('./sign-in-open.js');

// The app's own start at sign-in can be switched on or off while the engine runs, so the
// system is asked again, at most this often however many pages ask.
const SUPPORT_TTL_MS = 60 * 1000;

/** A check of whether the tab can open here that keeps its answer for `ttlMs`. */
function createSupportCheck({ check = signInOpenSupported, ttlMs = SUPPORT_TTL_MS, now = Date.now } = {}) {
  let answer = null;
  let at = 0;
  return (engine) => {
    if (answer && now() - at < ttlMs) return answer;
    at = now();
    answer = Promise.resolve().then(() => check(engine)).catch(() => false);
    return answer;
  };
}

const saveArmed = (on) => updateHubSettingKey('autoOpenArmed', () => on);

/**
 * @param {{ supported?: (engine: { port: number }) => Promise<boolean>, readSettings?: () => Promise<any>,
 *   setArmed?: (on: boolean) => Promise<any>, port?: number }} [deps] stand-ins for tests
 * @returns {{ state: () => Promise<object>, turn: (on: boolean) => Promise<object> }} the two
 *   answers of /startup/auto-open, in the shape the page reads: { ok, supported, enabled }
 */
function createAutoOpenSwitch({ supported = createSupportCheck(), readSettings = readHubSettings, setArmed = saveArmed, port = PORT } = {}) {
  // `supported`: the engine can open the tab at sign-in on this computer, so the switch is
  // shown. `enabled`: a real browser asked for it.
  async function state() {
    const can = await supported({ port });
    const settings = can ? await readSettings() : null;
    return { ok: true, supported: can, enabled: !!settings && settings.autoOpenArmed === true };
  }

  // Turning it off is always honoured. Turning it on where the tab could not open changes
  // nothing: the page hides the switch on that answer.
  async function turn(on) {
    const can = await supported({ port });
    if (on === true && !can) return { ok: true, supported: false, enabled: false };
    return { ok: true, supported: can, enabled: (await setArmed(on === true)) === true };
  }

  return { state, turn };
}

const autoOpenSwitch = createAutoOpenSwitch();

module.exports = { createSupportCheck, createAutoOpenSwitch, autoOpenSwitch, SUPPORT_TTL_MS };
