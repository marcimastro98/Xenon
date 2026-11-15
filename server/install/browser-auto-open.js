// Whether this start of the engine opens the dashboard in the browser: the rule alone, every
// fact handed in.

// How long after the sign-in the engine may start and still be the start of that sign-in.
// Only Windows is measured against it (sign-in-windows.js): its start task leaves no trace of
// who ran it, and a cold sign-in can take minutes to reach the engine. Past this the start is
// taken for something else: a restart by hand, an update, a crash.
const SIGN_IN_WINDOW_MS = 10 * 60 * 1000;

// The port of the installed engine. A copy on any other port (XENON_PORT) is one a developer
// or a test runs beside it: it opens nothing, the switch is not offered from it, and it
// leaves the installed engine's old task alone.
const INSTALLED_PORT = 3030;

const no = (why, remember = false) => ({ open: false, why, remember });

/**
 * One tab per sign-in, and only for someone who asked for it in a real browser.
 * `remember` says the sign-in must be written down as seen, whatever `open` says: the first
 * start that meets a sign-in uses it up, so a restart later in the same session (an update,
 * a crash, the switch turned on afterwards) never opens a tab of its own.
 * @param {object} facts a fact left out counts as "no"
 * @param {boolean} [facts.sideCopy] a copy run beside the installed engine (XENON_PORT)
 * @param {{ id: string, ageMs: number } | null} [facts.signIn] the sign-in this start belongs to
 *   and how long after it the engine started; null when the system cannot say
 * @param {string} [facts.seenId] the last sign-in a start of this engine met
 * @param {boolean} [facts.armed] a dashboard in a real browser asked for the tab
 * @param {boolean} [facts.wanted] the switch in Settings is on
 * @param {boolean} [facts.appAtSignIn] the Xenon app opens at sign-in and shows the dashboard
 * @param {boolean} [facts.canOpen] this system has a way to open a browser from here
 * @param {number} [windowMs]
 * @returns {{ open: boolean, why: string, remember: boolean }}
 */
function signInOpenDecision(facts, windowMs = SIGN_IN_WINDOW_MS) {
  const { sideCopy, signIn, seenId, armed, wanted, appAtSignIn, canOpen } = facts || {};
  if (sideCopy) return no('side_copy');
  if (!signIn || typeof signIn.id !== 'string' || !signIn.id) return no('start_unknown');
  if (signIn.id === seenId) return no('sign_in_seen');
  // From here on this start is the first to meet the sign-in.
  const { ageMs } = signIn;
  if (typeof ageMs !== 'number' || !(ageMs >= 0 && ageMs <= windowMs)) return no('not_a_sign_in', true);
  if (armed !== true) return no('never_asked', true);
  if (wanted !== true) return no('switched_off', true);
  if (appAtSignIn) return no('app_shows_it', true);
  if (!canOpen) return no('cannot_open', true);
  return { open: true, why: 'sign_in', remember: true };
}

module.exports = { SIGN_IN_WINDOW_MS, INSTALLED_PORT, signInOpenDecision };
