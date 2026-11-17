'use strict';
// "Ask Bit" from a notification where there is no dashboard to answer in.
//
// The alerts window of "widgets only" (js/alerts/screen-alerts.js) hands the question
// here, and the search window opens the same way its shortcut opens it
// (routeSpotlightHotkey in server.js). When it shows, the search page takes the
// question (js/search/spotlight-chat.js) and puts it in Bit's chat box, unsent.
//
// One question is kept, in memory and for a short time: a few words the app
// wrote itself, never stored or sent anywhere. Both paths are POST, listed in
// CSRF_MUTATION_PATHS and closed to paired devices (remote-access.js): neither a
// web page nor a phone may pop a window on this PC.

const MAX_CHARS = 500;
const KEEP_MS = 30 * 1000;
const MAX_BODY_BYTES = 4 * 1024;

let pending = null;

// Pure: the question as the chat box will take it, or '' when it is not one.
function cleanQuestion(raw) {
  if (typeof raw !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const text = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return text.slice(0, MAX_CHARS);
}

function keep(text, now = Date.now()) {
  pending = text ? { text, at: now } : null;
}

// The kept question, once; a stale one is dropped.
function take(now = Date.now()) {
  const p = pending;
  pending = null;
  return p && now - p.at <= KEEP_MS ? p.text : '';
}

async function ask(req, _res, { json, readBody, openSpotlight }) {
  let text = '';
  try { text = cleanQuestion(JSON.parse(await readBody(req, MAX_BODY_BYTES)).text); }
  catch { json({ ok: false, error: 'bad_request' }); return; }
  if (!text) { json({ ok: false, error: 'bad_request' }); return; }
  keep(text);
  try { openSpotlight(); } catch { json({ ok: false, error: 'open_failed' }); return; }
  json({ ok: true });
}

async function takeQuestion(_req, _res, { json }) {
  json({ ok: true, text: take() });
}

function stop() { pending = null; }

module.exports = {
  routes: { 'POST /spotlight/ask': ask, 'POST /spotlight/ask/take': takeQuestion },
  stop,
  cleanQuestion,
  keep,
  take,
  KEEP_MS,
};
