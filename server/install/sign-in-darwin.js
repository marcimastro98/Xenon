'use strict';
// macOS: whether launchd started this engine as the login agent, and whether the Xenon app
// starts at sign-in.
//
// install.sh registers the engine alone as a LaunchAgent that runs node itself, and launchd
// names the agent in the environment of what it starts. An engine the Xenon app started (the
// other way macOS runs it) has no such name: the app is on screen then, and no tab is wanted.
// The agent starts at sign-in, and again after a crash or an update; the first of those
// starts since the Mac booted is taken for the sign-in. A boot is told from the next by the
// id macOS gives each one (kern.bootsessionuuid), not by the time of the boot: that time
// moves when the clock is set, and every later start would then look like a new boot.
// macOS gives the engine nothing that names the login session, so signing out and in again on
// the same boot opens no second tab, and nothing that says when the user signed in, so the
// first start of the agent is not measured against a time limit as it is on the other systems.

const { execFile } = require('node:child_process');
const os = require('node:os');
const P = require('./sign-in-parse.js');
const { appSignInEntry } = require('./launcher-paths.js');
const { fileThere } = require('./sign-in-file.js');

// The label install.sh gives the agent (LABEL there).
const AGENT_LABEL = 'com.marcimastro98.xenon.backend';
const SYSCTL_TIMEOUT_MS = 4000;

// The id of this boot, as `sysctl` prints it; '' when it cannot be asked.
function bootSessionId() {
  return new Promise((resolve) => {
    try {
      execFile('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], { timeout: SYSCTL_TIMEOUT_MS },
        (err, stdout) => resolve(err ? '' : String(stdout)));
    } catch { resolve(''); }
  });
}

/**
 * @param {{ env?: Record<string, string | undefined>, boot?: () => Promise<string> }} [deps]
 * @returns {Promise<{ id: string, ageMs: number } | null>} null for an engine launchd did not
 *   start as the agent, and when the Mac does not say which boot this is
 */
async function signIn({ env = process.env, boot = bootSessionId } = {}) {
  if (env.XPC_SERVICE_NAME !== AGENT_LABEL) return null;
  const session = P.bootSession(await boot());
  return session ? { id: 'boot-' + session, ageMs: 0 } : null;
}

/**
 * Rejects when the folder cannot be looked into: only a file that is not there is a "no".
 * @returns {Promise<boolean>} whether the Xenon app has its own login agent
 */
async function appAtSignIn({ home = os.homedir(), exists = fileThere } = {}) {
  const entry = appSignInEntry('darwin', { home });
  return !!entry && exists(entry);
}

// `open` is part of the system.
const canOpen = () => true;

module.exports = { signIn, appAtSignIn, canOpen, AGENT_LABEL };
