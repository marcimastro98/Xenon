// Switching off the lights Xenon drives itself when the PC shuts down, restarts or sleeps, and
// on again when it wakes: the watcher is made when the engine starts and runs only while Xenon
// drives lights.

const lighting = require('../lights/lighting.js');
const { createSessionWatch } = require('./session-watch.js');

// Shutdown / restart / sleep: switch off the lights Xenon drives itself first
// (session-watch.js says why node cannot see these on its own). Runs only
// while native lighting is on, the one thing that would otherwise stay lit on
// standby power; iCUE takes its devices back by itself.
const _sessionWatch = createSessionWatch({
  onEvent: (ev) => {
    // console.warn: only warn/error reach server.log (startup-log.js), and a report of
    // lights left on needs to say whether the PC told us.
    console.warn('[session-watch] ' + ev);
    return ev === 'resume' ? lighting.powerUp() : lighting.powerDown();
  },
});

module.exports = { _sessionWatch };
