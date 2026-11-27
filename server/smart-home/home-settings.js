// The home's own choices, apart from each connection: whether a ring at the door shows a card
// and reaches the paired phone, whether Bit may send a camera picture to the AI to look at
// it ('ask' the first time, 'yes', 'local' = yes only with an AI on this PC, or 'no'), and whether the PC keeps what happened at home
// (home-events.js). The browser keeps the same rule in js/settings/normalize-settings.js (its `home`).
'use strict';

const CAMERA_LOOK = Object.freeze(['ask', 'yes', 'local', 'no']);
const HOME_DEFAULTS = Object.freeze({ doorbell: true, doorbellPush: true, bitCameras: 'ask', log: true });

function normalizeHome(value) {
  const src = value && typeof value === 'object' ? value : {};
  return {
    doorbell: src.doorbell !== false,
    doorbellPush: src.doorbellPush !== false,
    bitCameras: CAMERA_LOOK.includes(src.bitCameras) ? src.bitCameras : HOME_DEFAULTS.bitCameras,
    log: src.log !== false,
  };
}

module.exports = { CAMERA_LOOK, HOME_DEFAULTS, normalizeHome };
