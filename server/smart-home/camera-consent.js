'use strict';
// Whether Bit may send a camera picture to the AI to say who or what is there
// (settings.home.bitCameras: 'ask' the first time, 'yes', 'no'). Only the person changes it: a
// tap on the buttons under Bit's question (POST /api/home/cameras/consent, in
// CSRF_MUTATION_PATHS) or Settings. The AI has no tool that reaches it. "Only this time" is a yes
// for the next look in the next two minutes, kept in memory and used once.

const { readBody } = require('../http/read-body.js');
const changeOne = require('../settings/change-one.js');
const { normalizeHome } = require('./home-settings.js');

const ONCE_MS = 2 * 60 * 1000;
const MAX_BODY_BYTES = 512;
const MAX_PIC = 300;
let onceUntil = 0;
let oncePic = '';

// `pic` is the picture the question stood under (camera-look.js picOf): the yes is for that camera.
function grantOnce(now = Date.now(), pic = '') {
  onceUntil = now + ONCE_MS;
  oncePic = typeof pic === 'string' ? pic.slice(0, MAX_PIC) : '';
}

/** True once after "Only this time", within two minutes, for the camera it was said of. */
function takeOnce(now = Date.now(), pic = '') {
  if (now > onceUntil || (oncePic && pic !== oncePic)) return false;
  onceUntil = 0;
  return true;
}

// A yes given under "it does not leave the PC" holds only for an AI on this PC ('local'):
// with any other AI Bit asks again, naming where the picture would go.
const LOCAL_AI = new Set(['ollama', 'localapi']);

/** 'yes' | 'no' | 'ask' for this AI, from the stored settings. */
function modeOf(settings, provider) {
  const mode = normalizeHome(settings?.home).bitCameras;
  if (mode !== 'local') return mode;
  return LOCAL_AI.has(provider) ? 'yes' : 'ask';
}

// { choice: 'yes' } from now on (with local: true when the question was about an AI on this PC), { choice: 'once' } this time. "No" changes nothing: the
// picture is already in the reply, and Bit asks again next time.
async function route(req, _res, { json }) {
  let choice;
  let local = false;
  let pic = '';
  try { ({ choice, local, pic } = JSON.parse(await readBody(req, MAX_BODY_BYTES))); } catch { /* answered below */ }
  if (choice === 'once') {
    grantOnce(Date.now(), pic);
    json({ ok: true, choice });
  } else if (choice === 'yes') {
    await changeOne.updateHubSettingKey('home', (h) => normalizeHome({ ...(h || {}), bitCameras: local === true ? 'local' : 'yes' }));
    json({ ok: true, choice });
  } else {
    json({ ok: false, error: 'bad_request' });
  }
}

module.exports = { route, takeOnce, grantOnce, modeOf, ONCE_MS, _reset: () => { onceUntil = 0; oncePic = ''; } };
