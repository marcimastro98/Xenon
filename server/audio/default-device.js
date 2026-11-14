// Makes a sound device the default one, for calls too unless the user said otherwise.

const { svvExec } = require('./svv-exec.js');
const { hub } = require('../settings/current.js');

// Make a device the default. Windows keeps three defaults per direction:
// Console and Multimedia (together, what the Sound panel calls the Default
// Device) and Communications (what Discord, Teams and call apps use), and
// SoundVolumeView sets one role per call or 'all'. Everything in Xenon that
// switches a device comes through here, so one setting decides for all of
// them. Asked on Discord: "would only swap the default device (not the
// communication device)". macOS and Linux have one default and ignore roles.
async function setDefaultAudioDevice(id, settings) {
  const s = settings || hub.settings || {};
  if (process.platform !== 'win32' || s.audioSetCommunications !== false) {
    await svvExec(['/SetDefault', id, 'all']);
    return;
  }
  await svvExec(['/SetDefault', id, '0']);   // Console
  await svvExec(['/SetDefault', id, '1']);   // Multimedia
}

module.exports = { setDefaultAudioDevice };
