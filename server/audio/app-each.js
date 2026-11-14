// Sends one audio command to every session of an app, in one direction.

const { svvExec } = require('./svv-exec.js');
const { readSoundVolumeRows } = require('./volume-rows.js');
const { F } = require('./svv-csv.js');

// Per-app volume and mute reach one direction of an app (app-audio/sessions.js):
// the microphone slider no longer moves the same app's output.
const _appSessions = require('../app-audio/sessions.js').createAppSessions({ readRows: readSoundVolumeRows, F });
async function svvEachApp(app, dir, args) {
  const targets = await _appSessions.targets(app, dir);
  if (!targets.length) throw new Error('no_app_session');
  for (const t of targets) await svvExec(args(t));
}

module.exports = { _appSessions, svvEachApp };
