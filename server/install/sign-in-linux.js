'use strict';
// Linux: whether systemd started this engine as the user's unit, and whether the Xenon app
// starts at sign-in.
//
// The unit (xenon-backend.service) is started by the user's systemd, which itself starts at
// the user's first sign-in and ends with the last session. The engine's control group names
// the unit, so a start by hand or from the desktop's autostart list is told apart: neither
// says when the session began, and no tab opens for them. The first start of the unit in the
// life of that systemd is taken for the sign-in; a restart after a crash or an update is not.
// Where the user's systemd runs from boot without a session (lingering), there is no display
// to open a browser on, and canOpen says so.

const fs = require('node:fs');
const os = require('node:os');
const P = require('./sign-in-parse.js');
const { appSignInEntry } = require('./launcher-paths.js');

// The unit install.sh and the app register (UNIT_NAME there).
const UNIT = 'xenon-backend.service';

const readText = (file) => fs.promises.readFile(file, 'utf8');

/**
 * @param {{ env?: Record<string, string | undefined>, ppid?: number, readFile?: (file: string) => Promise<string> }} [deps]
 * @returns {Promise<{ id: string, ageMs: number } | null>} null for an engine the unit did not start
 */
async function signIn({ env = process.env, ppid = process.ppid, readFile = readText } = {}) {
  try {
    if (!P.inUnit(await readFile('/proc/self/cgroup'), UNIT)) return null;
    // systemd names itself to its units; it is also their parent.
    const named = Number(env.MANAGERPID);
    const manager = Number.isInteger(named) && named > 0 ? named : ppid;
    const started = P.procStartTicks(await readFile('/proc/' + manager + '/stat'));
    const boot = String(await readFile('/proc/sys/kernel/random/boot_id')).trim();
    return started && boot ? { id: boot + ':' + started, ageMs: 0 } : null;
  } catch {
    return null;
  }
}

/** @returns {Promise<boolean>} whether the Xenon app has an autostart entry that is not switched off */
async function appAtSignIn({ env = process.env, home = os.homedir(), readFile = readText } = {}) {
  const entry = appSignInEntry('linux', { home, env });
  if (!entry) return false;
  try { return !P.desktopEntryOff(await readFile(entry)); } catch { return false; }   // no entry
}

/** xdg-open needs the session's display, which a unit started before the desktop does not have. */
const canOpen = (env = process.env) => !!(env.DISPLAY || env.WAYLAND_DISPLAY);

module.exports = { signIn, appAtSignIn, canOpen, UNIT };
