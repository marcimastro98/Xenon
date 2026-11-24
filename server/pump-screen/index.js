'use strict';
// The pump screens' one store and live state, shared by the routes and the actions
// Bit, the Deck and the menu run (actions.js). Loading this file joins the pump's moments to the situations engine,
// so their facts are read while a pump screen has a moment that needs them.

const { DATA_DIR } = require('../engine/paths.js');
const { broadcastSSE } = require('../http/sse-clients.js');
const screensOff = require('../screens-off/state.js');
const Sources = require('../capabilities/situation-sources.js');
const { createPumpStore } = require('./store.js');
const { createPumpLive } = require('./live.js');
const { createChange } = require('./change.js');
const { createPumpActions } = require('./actions.js');
const { openInIcue, icueImportAvailable } = require('./icue.js');
const { createPumpDetect } = require('./detect.js');
const { PORT } = require('../engine/port.js');
const { UPLOADS_DIR } = require('../engine/uploads-dir.js');
const { createPumpBackup } = require('./backup.js');
const { createPumpRing } = require('./ring.js');
const { installedPumpWidgets } = require('./widgets.js');
const { createPumpPresence } = require('./presence.js');
const { startPumpDirect } = require('./direct-start.js');

const store = createPumpStore({ dataDir: DATA_DIR, warn: (msg) => console.warn(msg) });
// Which screens show Xenon now: one that comes or goes redraws the menu and the ring.
const presence = createPumpPresence({ changed: () => live.push(true) });
const here = (id) => presence.here(id);
// The ring of lights around the pump: read lazily, the lighting bridge loads its SDK on demand.
const ring = createPumpRing({ store, here, setRing: (state) => require('../lights/lighting.js').setPumpRing(state) });
const live = createPumpLive({ store, here, broadcast: broadcastSSE, quiet: () => screensOff.quiet(), changed: (now) => ring.refresh(now) });
const leave = Sources.addSource(live.source);

const detect = createPumpDetect({ warn: (msg) => console.warn(msg) });
// Xenon on a pump screen with no other program in between (direct.js); null where it cannot.
const direct = startPumpDirect({ store, detect, port: PORT, dataDir: DATA_DIR, changed: () => live.push(true) });
// What the menu and Bit say about it: on, and what it does now (off, none, busy, drawing, failed).
const directState = () => (direct ? { on: store.peek()?.direct === true, ...direct.state() } : null);

const actions = createPumpActions({
  store, live, change: createChange({ store, live }),
  openIcue: () => openInIcue({ warn: (msg) => console.warn(msg) }),
  widgets: installedPumpWidgets,
  here,
  direct: direct ? { state: directState, refresh: () => direct.refresh() } : null,
});

// What the Xenon menu's Screens page draws: every pump screen, the Store widgets it can
// show, whether iCUE's import can open here, the pumps plugged in (to offer the first step while none has shown up),
// the address NZXT CAM is given, what the ring shows now and whether Xenon holds a ring of its own to paint
// (the iCUE LINK hub Airflow holds: lighting-native/held.js), so its Lights need no iCUE.
function heldRing() {
  const { ledsOf } = require('../lights/pump-ring.js');
  return require('../lighting-native/held.js').devices().some((d) => ledsOf(d));
}

async function menuState() {
  const { screens, widgets } = await actions.run({ type: 'pumpGet' });
  // sound: whether this PC can read how loud it is, for the ring's pulse (audio/audio-levels.js).
  const sound = require('../audio/audio-levels.js').available();
  // cannot: the needs of the ring's effects this PC cannot follow now (lights/pc-inputs.js: the fans).
  const cannot = require('../lights/pc-inputs.js').cannot();
  // accent: the theme's colour, for the swatch of a line whose colours follow the theme.
  const accent = require('../settings/current.js').hub.settings?.accent;
  return {
    screens, widgets, icue: icueImportAvailable(), sound, cannot, accent, detected: await detect(), url: `http://127.0.0.1:${PORT}/pump-face`,
    direct: directState(), ring: ring.now(), ringHeld: heldRing(),
  };
}

// The pump screens' part of a settings backup (server.js buildBackup / applyBackup).
const backup = createPumpBackup({ store, dir: UPLOADS_DIR, changed: () => live.push(true) });

// The ring starts from the saved settings once they are read (theme/off need no page).
store.ready().then(() => ring.refresh(live.decide())).catch(() => {});

function stop() {
  leave();
  direct?.stop().catch(() => {});
  ring.stop();
  presence.stop();
}

module.exports = { store, live, ring, presence, actions, menuState, backup, stop, direct };
