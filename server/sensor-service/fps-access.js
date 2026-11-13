'use strict';
// Whether Windows lets this engine read frame rates, and if not, what fixes it.
//
// PresentMon needs administrator rights or membership of Performance Log Users.
// Since 5.1.0 the engine never runs elevated, so the sensor setup
// (enable-sensors.ps1) adds the user to that group and records the outcome in
// "%ProgramData%\Xenon Sensors\fps-access-<sid>.json", a folder only an
// administrator can write. A group joined after sign-in reaches only processes
// started after the next sign-in, which is the step people miss.
//
//   null      it reads, or nothing to say (not Windows, not known yet)
//   'signin'  the user is in the group: sign out of Windows and back in
//   'rights'  not in the group (sensors never set up, or the group refused):
//             the sensor setup grants it
//
// The process token never changes, so whoami runs once per engine. The record
// is read again on each refresh, since the setup can run without a restart.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { SERVICE_NAME } = require('./reader.js');

const PERF_LOG_USERS = 'S-1-5-32-559';
// High or System integrity: an elevated engine traces without the group.
const ELEVATED = ['S-1-16-12288', 'S-1-16-16384'];
const SID_RE = /^S-1-(5-21|12-1)(-\d{1,10}){4}$/;
const MAX_RECORD_BYTES = 4096;
const RECHECK_MS = 60000;

// `whoami /user /groups /fo csv /nh`: the first row is the user, the rest the
// groups. Only SIDs are read, never names, which change with the language.
function parseToken(text) {
  const sids = String(text || '').match(/"S-1-[\d-]+"/g) || [];
  const list = sids.map((s) => s.slice(1, -1));
  const user = list.find((s) => SID_RE.test(s)) || null;
  const canTrace = list.includes(PERF_LOG_USERS) || ELEVATED.some((s) => list.includes(s));
  return { user, canTrace };
}

function stateOf(token, record) {
  if (!token || token.canTrace || !token.user) return null;
  if (record && record.v === 1 && record.sid === token.user && record.member === true) return 'signin';
  return 'rights';
}

function createFpsAccess({ env = process.env, platform = process.platform, run = execFile, fsp = fs.promises, now = Date.now } = {}) {
  const enabled = platform === 'win32' && !!env.ProgramData;
  const dir = path.join(env.ProgramData || 'C:\\ProgramData', SERVICE_NAME);
  let token;          // undefined = not asked yet, null = whoami failed
  let state = null;
  let refused = false; // the setup tried and Windows said no (not "never set up")
  let checkedAt = -Infinity;
  let pending = null;

  function readToken() {
    const whoami = path.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'whoami.exe');
    return new Promise((resolve) => {
      run(whoami, ['/user', '/groups', '/fo', 'csv', '/nh'], { windowsHide: true, timeout: 15000 },
        (err, stdout) => resolve(err ? null : parseToken(stdout)));
    });
  }

  async function readRecord(sid) {
    try {
      const file = path.join(dir, 'fps-access-' + sid + '.json');
      const st = await fsp.stat(file);
      if (!st.isFile() || st.size > MAX_RECORD_BYTES) return null;
      const o = JSON.parse(await fsp.readFile(file, 'utf8'));
      return o && typeof o === 'object' ? o : null;
    } catch { return null; }
  }

  async function refresh() {
    if (!enabled) return null;
    checkedAt = now();
    if (token === undefined) token = await readToken();
    const record = token && token.user && !token.canTrace ? await readRecord(token.user) : null;
    state = stateOf(token, record);
    refused = state === 'rights' && !!record && record.v === 1 && record.sid === token.user && record.member === false;
    return state;
  }

  // Worth a pop-up, not just a line in the tile: 'signin', or 'refused' when the
  // setup ran and the group said no. Someone who never set up the sensors is
  // told in the tile and Settings only.
  function worthTelling() {
    return state === 'signin' ? 'signin' : refused ? 'refused' : null;
  }

  // For callers that cannot wait (the perf stream's tick): the last answer,
  // asking again in the background at most once a minute.
  function current() {
    if (enabled && !pending && now() - checkedAt >= RECHECK_MS) {
      pending = refresh().catch(() => null).finally(() => { pending = null; });
    }
    return state;
  }

  return { refresh, current, worthTelling };
}

let shared = null;
const instance = () => (shared = shared || createFpsAccess());

module.exports = { createFpsAccess, instance, parseToken, stateOf, PERF_LOG_USERS };
