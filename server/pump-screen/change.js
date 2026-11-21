'use strict';
// One change to the pump screens, the same whoever asks: the menu or a phone (POST /pump),
// a Deck key or Bit (actions.js). `b` is one of
//   { screen, patch }                  settings (edit.js patchScreen)
//   { screen, setup }                  a one-tap setup
//   { screen, show, minutes }          a face now, for that long (live.js pin)
//   { screen, show: null }             automatic again
//   { screen, forget: true }           the screen and its record gone
// Answers {} or the store's { model } when it worked, { error, choices? } when not.

const Model = require('../js/pump/pump-model.js');
const Edit = require('./edit.js');
const { screenIds } = require('./moments.js');

function createChange({ store, live }) {
  return async function change(b) {
    const id = Model.screenId(b.screen);
    if (!id) return { error: 'bad_screen' };
    if (b.show !== undefined) {
      const model = await store.ready();
      if (!screenIds(model).includes(id)) return { error: 'unknown_screen', choices: screenIds(model) };
      if (b.show === null) { live.unpin(id); return {}; }
      return live.pin(id, b.show, b.minutes);
    }
    const step = b.forget === true ? (m) => Edit.forgetScreen(m, id)
      : (m) => Edit.patchScreen(m, id, b.setup != null ? { setup: b.setup } : b.patch);
    const out = await store.update(step);
    if (!out.error) live.push(true);
    return out;
  };
}

module.exports = { createChange };
