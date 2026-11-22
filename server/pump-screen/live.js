'use strict';
// The face each pump screen shows now, decided on the server and sent to every
// open page as the `pump` event when it changes. The facts come from the
// situations engine, which reads them only while a moment asks (situation-sources.js);
// a face someone asked for ("pinned") lives here, in memory, never on disk.

const Model = require('../js/pump/pump-model.js');
const Faces = require('../js/pump/pump-faces.js');
const LayerWhen = require('../js/layers/layer-when.js');
const { faceNow, rulesOf, screenIds } = require('./moments.js');

// Minutes a face asked for stays; 0 = until "automatic" again.
const PIN_MINUTES = Object.freeze([0, 1, 5, 15, 60]);
const FOREVER = Number.MAX_SAFE_INTEGER;
// Read only while a screen shows the text of its alerts: on air, the text hides anyway.
const ON_AIR = Object.freeze([LayerWhen.parse('live'), LayerWhen.parse('recording')]);

// changed(now): told after every change of the settings, and when a screen's face moves (the
// ring of lights reads them again: each line moves it its own way).
// here(id): whether that screen shows Xenon now (presence.js): only those ask for readings.
function createPumpLive({ store, broadcast, here = (_id) => true, quiet = () => false, clock = () => Date.now(), changed = (_now) => {} }) {
  const pins = new Map();
  let facts = {};
  let sent = '';
  let rulesFor = null;
  let rulesKey = '';
  let rules = [];

  function decide() {
    const model = store.peek();
    if (!model) return {};
    const now = clock();
    const out = {};
    for (const id of screenIds(model)) {
      const pin = pins.get(id);
      if (pin && pin.until <= now) pins.delete(id);
      const screen = Model.screenFor(model, id);
      out[id] = faceNow(screen, facts, { pinned: pins.get(id), quiet: quiet(), now });
      if (!screen.alerts.hideText && (facts.live || facts.recording)) out[id].onAir = true;
    }
    return out;
  }

  // Sends the faces when one moved; `force` after a change of the settings themselves,
  // which the pages then read again (`changed`).
  function push(force = false) {
    const now = decide();
    const json = JSON.stringify(now);
    if (json === sent && !force) return;
    sent = json;
    changed(now);
    broadcast('pump', force ? { now, changed: true } : { now });
  }

  function pin(id, show, minutes = 0) {
    const face = Faces.normalizeFace(show);
    const mins = PIN_MINUTES.includes(Number(minutes)) ? Number(minutes) : 0;
    if (!face) return { error: 'bad_face', choices: Faces.FACES };
    pins.set(id, { show: face, until: mins ? clock() + mins * 60000 : FOREVER });
    push();
    return { ok: true };
  }

  function unpin(id) {
    pins.delete(id);
    push();
  }

  return {
    decide,
    push,
    pin,
    unpin,
    // The faces pinned for now, never saved: their pictures stay on disk (picture.js).
    pinnedShows: () => [...pins.values()].map((p) => p.show),
    // A situation source: the moments' rules (read again only when the model is new).
    source: {
      rules() {
        const model = store.peek();
        const ids = model ? screenIds(model).filter(here) : [];
        const key = ids.join(',');
        if (model !== rulesFor || key !== rulesKey) {
          rulesFor = model;
          rulesKey = key;
          const shown = ids.some((id) => !Model.screenFor(model, id).alerts.hideText);
          rules = model ? [...rulesOf(model, ids), ...(shown ? ON_AIR : [])] : [];
        }
        return rules;
      },
      onFacts(next) { facts = { ...next }; push(); },
    },
  };
}

module.exports = { createPumpLive, PIN_MINUTES };
