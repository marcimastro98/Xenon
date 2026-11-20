'use strict';
// The pass trial asked from the app (js/store-supporters/trial-sheet.js), with no code
// to copy: the sheet sends the email, then waits for the email's button. The work is in
// trial-link.js; this file only reads the request and answers.
//
// Every path is closed to paired devices (REMOTE_ADMIN in paired/refused-paths.js):
// the request names this PC to the hub and the poll hands back a trial code, so a
// paired phone opens the hub's /trial page instead. The three POSTs are in
// CSRF_MUTATION_PATHS. The trial pass comes with the engine's hands (trialPass).

const { createTrialClaim } = require('./trial-link.js');

const MAX_BODY_BYTES = 2048;

let claims = null;   // made at the first request: DATA_DIR and the trial pass come with it

function claimsOf(dataDir, hands) {
  if (!claims) claims = createTrialClaim({ dataDir, trialPass: hands.trialPass });
  return claims;
}

async function pending(_req, _res, { json, err500, dataDir }, hands) {
  try { json(await claimsOf(dataDir, hands).pending()); } catch (e) { err500(e.message); }
}

async function request(req, _res, { json, err500, readBody, dataDir }, hands) {
  let body = null;
  try { body = JSON.parse(await readBody(req, MAX_BODY_BYTES)); } catch { /* answered below */ }
  if (!body || typeof body !== 'object') { json({ ok: false, error: 'bad_request' }); return; }
  try {
    json(await claimsOf(dataDir, hands).request({ email: body.email, news: body.news === true, lang: body.lang }));
  } catch (e) { err500(e.message); }
}

async function poll(_req, _res, { json, err500, dataDir }, hands) {
  try { json(await claimsOf(dataDir, hands).poll()); } catch (e) { err500(e.message); }
}

async function forget(_req, _res, { json, err500, dataDir }, hands) {
  try { json(await claimsOf(dataDir, hands).forget()); } catch (e) { err500(e.message); }
}

function stop() { claims = null; }

module.exports = {
  routes: {
    'GET /api/community/trial/pending': pending,
    'POST /api/community/trial/request': request,
    'POST /api/community/trial/poll': poll,
    'POST /api/community/trial/forget': forget,
  },
  stop,
};
