'use strict';
// Opens the dashboard in the browser when this start of the engine is the user's sign-in, and
// says whether that can happen on this computer.
//
// Nothing outside the engine takes part: no scheduled task, no script file, no entry in the
// system's start-up list. The engine is already started at sign-in by its own installer; here
// it asks the system which sign-in this start belongs to, writes that sign-in down as used,
// and opens its own address once. Every later start in the same session (an update, a crash,
// a restart by hand) reads what was written and opens nothing. browser-auto-open.js is the
// rule, the sign-in-<system>.js files are what each system can say.

const { signInOpenDecision, INSTALLED_PORT } = require('./browser-auto-open.js');
const { pickBackend } = require('./sign-in.js');
const seenStore = require('./sign-in-seen.js');
const { readHubSettings } = require('../settings/read.js');
const { openExternalPath } = require('../deck/open-external-path.js');

const NOTHING = Object.freeze({ open: false, why: 'failed', remember: false });
const LOG_PREFIX = '[startup] dashboard in the browser at sign-in: ';

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
    open: openExternalPath,
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
    canOpen: !!p.backend.canOpen(),
  };
  const first = signInOpenDecision(facts);
  // Written before anything opens: a start that cannot write the sign-in down opens nothing,
  // because the next start could not tell that this one already did.
  if (first.remember) await p.writeSeen(signIn.id);
  // Asked last and only when a tab is about to open: it reads a task and the registry.
  if (first.open && await p.backend.appAtSignIn()) return signInOpenDecision({ ...facts, appAtSignIn: true });
  return first;
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
    if (verdict.open) await p.open(dashboardUrl(port));
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
    if (port !== INSTALLED_PORT || !p.backend || !p.backend.canOpen()) return false;
    if (!(await p.backend.signIn({ startedAtMs: p.startedAtMs }))) return false;
    return !(await p.backend.appAtSignIn());
  } catch {
    return false;
  }
}

module.exports = { openDashboardAtSignIn, signInOpenSupported, dashboardUrl };
