'use strict';
// Opens the dashboard in the browser when this start of the engine is the user's sign-in, and
// says whether that can happen on this computer.
//
// Nothing outside the engine takes part: no scheduled task, no script file, no entry in the
// system's start-up list. The engine is already started at sign-in by its own installer; here
// it asks the system which sign-in this start belongs to, writes that sign-in down as used,
// and opens its own address once. Every later start in the same session (an update, a crash,
// a restart by hand) reads what was written and opens nothing. browser-auto-open.js is the
// rule, the sign-in-<system>.js files are what each system can say, sign-in-browser.js starts
// the browser.
//
// Whatever cannot be learned ends in no tab. A system that cannot say whether the app starts
// at sign-in, or whether the old browser task is still there, throws, and the start opens
// nothing. Where the display comes after the engine (Linux) the start waits for it, for a
// bounded time and with the sign-in already written down, so a restart meanwhile opens nothing.

const { signInOpenDecision, INSTALLED_PORT } = require('./browser-auto-open.js');
const { pickBackend } = require('./sign-in.js');
const seenStore = require('./sign-in-seen.js');
const { readHubSettings } = require('../settings/read.js');
const { openOwnAddress } = require('./sign-in-browser.js');

const NOTHING = Object.freeze({ open: false, why: 'failed', remember: false });
const LOG_PREFIX = '[startup] dashboard in the browser at sign-in: ';
// How often and for how long a start waits for the session's display.
const DISPLAY_POLL_MS = 5000;
const DISPLAY_WAIT_MS = 2 * 60 * 1000;
const no = (why) => ({ open: false, why, remember: true });

// The waits in progress, so shutdown ends them (stop). Their timers never keep the engine alive.
const pauses = new Set();
/** @returns {Promise<boolean>} true when the time passed, false when the engine is stopping */
function pause(ms) {
  return new Promise((resolve) => {
    const entry = { end: (/** @type {boolean} */ _passed) => {} };
    const timer = setTimeout(() => entry.end(true), ms);
    timer.unref();
    entry.end = (passed) => { clearTimeout(timer); pauses.delete(entry); resolve(passed); };
    pauses.add(entry);
  });
}

/** Ends every wait for a display: the start that was waiting opens nothing. */
function stop() {
  for (const entry of [...pauses]) entry.end(false);
}

// When this process started, by the clock the system's sign-in time is measured on.
const processStartedAtMs = () => Date.now() - Math.round(process.uptime() * 1000);

// What the work is done with; a test hands in its own so no browser and no system is touched.
/** @param {any} [deps] */
function parts(deps = {}) {
  return {
    startedAtMs: processStartedAtMs(),
    readSettings: readHubSettings,
    readSeen: seenStore.readSeen,
    writeSeen: seenStore.writeSeen,
    open: openOwnAddress,
    pause,
    displayPollMs: DISPLAY_POLL_MS,
    displayWaitMs: DISPLAY_WAIT_MS,
    log: (line) => console.log(line),
    ...deps,
    backend: 'backend' in deps ? deps.backend : pickBackend(process.platform),
  };
}

/** The engine's own address, built from its port alone: never from anything a request said. */
function dashboardUrl(port) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('no port');
  return 'http://127.0.0.1:' + port + '/';
}

async function decide(port, p) {
  if (port !== INSTALLED_PORT) return signInOpenDecision({ sideCopy: true });
  const signIn = p.backend ? await p.backend.signIn({ startedAtMs: p.startedAtMs }) : null;
  if (!signIn) return signInOpenDecision({ signIn: null });
  const seenId = await p.readSeen();
  if (seenId === null) return { open: false, why: 'seen_unreadable', remember: false };
  const settings = (await p.readSettings()) || {};
  const facts = {
    sideCopy: false,
    signIn,
    seenId,
    armed: settings.autoOpenArmed === true,
    wanted: settings.autoOpenBrowser !== false,
    appAtSignIn: false,
    // A system that learns its display later (display) can open, just not yet.
    canOpen: !!p.backend.canOpen() || typeof p.backend.display === 'function',
  };
  const first = signInOpenDecision(facts);
  // Written before anything opens: a start that cannot write the sign-in down opens nothing,
  // because the next start could not tell that this one already did.
  if (first.remember) await p.writeSeen(signIn.id);
  if (!first.open) return first;
  // Asked last and only when a tab is about to open: these read tasks and the registry.
  if (await p.backend.appAtSignIn()) return signInOpenDecision({ ...facts, appAtSignIn: true });
  // The task older versions opened the browser with may still be there, and still work: two
  // tabs otherwise. It is removed a minute after every start (browser-auto-open-task.js).
  if (typeof p.backend.oldLauncher === 'function' && await p.backend.oldLauncher()) return no('old_task');
  return first;
}

/**
 * The session variables to open the browser with, asked until the system has a display or the
 * wait is over. A system that needs none (no `display`) answers at once.
 * @returns {Promise<{ env?: Record<string, string>, why?: string }>} `why` when no browser can be opened
 */
async function sessionToOpenOn(p) {
  if (typeof p.backend.display !== 'function') return {};
  const tries = Math.floor(p.displayWaitMs / p.displayPollMs);
  for (let attempt = 0; ; attempt += 1) {
    const env = await p.backend.display();
    if (env) return { env };
    if (attempt >= tries) return { why: 'no_display' };
    if (!(await p.pause(p.displayPollMs))) return { why: 'stopped' };
  }
}

/**
 * Called once, when the engine is listening. Never rejects: a start-up that cannot open a
 * tab is still a start-up.
 * @param {{ port: number }} engine the port this engine listens on
 * @param {object} [deps] stand-ins for tests
 * @returns {Promise<{ open: boolean, why: string, remember: boolean }>} `open` is true only when the tab was opened
 */
async function openDashboardAtSignIn({ port }, deps) {
  let log = (line) => console.log(line);
  // A line that cannot be written is not worth a start-up either.
  const say = (line) => { try { log(line); } catch { /* nowhere left to say it */ } };
  /** @type {{ open: boolean, why: string, remember: boolean }} */
  let verdict = NOTHING;
  try {
    const p = parts(deps);
    log = p.log;
    verdict = await decide(port, p);
    if (verdict.open) {
      const session = await sessionToOpenOn(p);
      if (session.why) verdict = no(session.why);
      else await p.open(dashboardUrl(port), session.env);
    }
  } catch (e) {
    verdict = { ...NOTHING, why: verdict.open ? 'open_failed' : 'failed', remember: verdict.remember };
    say(LOG_PREFIX + verdict.why + ' (' + (e?.message || e) + ')');
    return verdict;
  }
  // A copy beside the installed engine says nothing: it is every test run.
  if (verdict.why !== 'side_copy') say(LOG_PREFIX + (verdict.open ? 'opened' : 'not opened (' + verdict.why + ')'));
  return verdict;
}

/**
 * Whether the switch means anything here: the engine can tell a sign-in start, can open a
 * browser, and the Xenon app is not already the thing that opens at sign-in.
 * @param {{ port: number }} engine
 * @param {object} [deps] stand-ins for tests
 * @returns {Promise<boolean>}
 */
async function signInOpenSupported({ port }, deps) {
  try {
    const p = parts(deps);
    if (port !== INSTALLED_PORT || !p.backend) return false;
    // One look for a display that may come later: the answer is asked again (auto-open-switch.js).
    if (!p.backend.canOpen() && !(typeof p.backend.display === 'function' && await p.backend.display())) return false;
    if (!(await p.backend.signIn({ startedAtMs: p.startedAtMs }))) return false;
    return !(await p.backend.appAtSignIn());
  } catch {
    return false;
  }
}

module.exports = { openDashboardAtSignIn, signInOpenSupported, dashboardUrl, stop };
