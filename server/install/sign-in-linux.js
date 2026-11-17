'use strict';
// Linux: whether systemd started this engine as the user's unit, whether the Xenon app starts
// at sign-in, and the display of the session once the desktop has one.
//
// The unit (xenon-backend.service) is started by the user's systemd, which itself starts at
// the user's first sign-in and ends with the last session. The engine's control group names
// the unit, so a start by hand or from the desktop's autostart list is told apart: neither
// says when the session began, and no tab opens for them. The first start of the unit in the
// life of that systemd is taken for the sign-in, when it comes within the limit of that
// systemd's own start (browser-auto-open.js); a restart after a crash or an update is not, nor
// is a unit installed and started hours into a session.
//
// The unit starts with the user's systemd, before the desktop has a display, and the desktop
// tells systemd about its display a little later. So the engine's own environment usually
// names none, and display() asks systemd for the session's. Where the user's systemd runs
// from boot with no session (lingering) no display ever comes, and no tab opens.

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const P = require('./sign-in-parse.js');
const { appSignInEntry } = require('./launcher-paths.js');
const { textIfThere } = require('./sign-in-file.js');

// The unit install.sh and the app register (UNIT_NAME there).
const UNIT = 'xenon-backend.service';
const SHOW_TIMEOUT_MS = 4000;

const readText = (file) => fs.promises.readFile(file, 'utf8');

/**
 * @param {{ env?: Record<string, string | undefined>, ppid?: number, readFile?: (file: string) => Promise<string> }} [deps]
 * @returns {Promise<{ id: string, ageMs: number } | null>} null for an engine the unit did not
 *   start, and when /proc does not say when it and its systemd started
 */
async function signIn({ env = process.env, ppid = process.ppid, readFile = readText } = {}) {
  try {
    if (!P.inUnit(await readFile('/proc/self/cgroup'), UNIT)) return null;
    // systemd names itself to its units; it is also their parent.
    const named = Number(env.MANAGERPID);
    const manager = Number.isInteger(named) && named > 0 ? named : ppid;
    const started = P.procStartTicks(await readFile('/proc/' + manager + '/stat'));
    const boot = String(await readFile('/proc/sys/kernel/random/boot_id')).trim();
    // How long after its systemd this engine started: the unit starts with it at sign-in.
    const ageMs = P.ticksBetweenMs(started, P.procStartTicks(await readFile('/proc/self/stat')));
    return started && boot && Number.isFinite(ageMs) ? { id: boot + ':' + started, ageMs } : null;
  } catch {
    return null;
  }
}

/**
 * Rejects when the entry is there and cannot be read: only a file that is not there is a "no".
 * @returns {Promise<boolean>} whether the Xenon app has an autostart entry that is not switched off
 */
async function appAtSignIn({ env = process.env, home = os.homedir(), readFile = readText } = {}) {
  const entry = appSignInEntry('linux', { home, env });
  if (!entry) return false;
  const text = await textIfThere(entry, readFile);
  return text !== null && !P.desktopEntryOff(text);
}

/** xdg-open needs the session's display, which a unit started before the desktop does not have. */
const canOpen = (env = process.env) => P.hasDisplay(env);

// What the user's systemd holds for the programs it starts, one NAME=value a line.
function showEnvironment() {
  return new Promise((resolve, reject) => {
    execFile('systemctl', ['--user', 'show-environment'], { timeout: SHOW_TIMEOUT_MS, maxBuffer: 256 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

/**
 * The variables a browser needs to open on the session's display, to add to the engine's own
 * when the browser is started: none when the engine already has a display, the ones the
 * desktop gave systemd otherwise. Asked again while the answer is null (sign-in-open.js).
 * @param {{ env?: Record<string, string | undefined>, show?: () => Promise<string> }} [deps]
 * @returns {Promise<Record<string, string> | null>} null while no display is known
 */
async function display({ env = process.env, show = showEnvironment } = {}) {
  if (P.hasDisplay(env)) return {};
  let session = {};
  try { session = P.sessionEnv(await show()); } catch { return null; }
  return P.hasDisplay(session) ? session : null;
}

module.exports = { signIn, appAtSignIn, canOpen, display, UNIT };
