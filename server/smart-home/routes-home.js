'use strict';
// Bit and the house (structure-conventions.md §5, listed in feature-routes.js).
//
//   POST /api/home/cameras/consent  { choice: 'yes' | 'once' } the person's tap under
//                                   Bit's question before it first looks at a camera
//                                   (camera-consent.js): 'yes' is saved in Settings,
//                                   'once' lets one look through within 2 minutes.
//                                   A phone may: it holds the same chat. In
//                                   CSRF_MUTATION_PATHS: no other site may say yes.
//   GET  /api/home/events           the home log (home-events.js) for widgets granted the
//                                   `homeEvents` stream: kind, place and time, newest
//                                   first, or log_off; not_granted while no installed widget
//                                   has that grant. A phone may read it.

const cameraConsent = require('./camera-consent.js');
const homeLog = require('./home-events.js');
const { settingsReader } = require('../settings/read-cache.js');

async function homeEvents(_req, _res, { json, sdkStreamGranted }) {
  if (!sdkStreamGranted('homeEvents')) { json({ ok: false, error: 'not_granted' }); return; }
  json(await homeLog.forWidgets(await settingsReader.read().catch(() => null)));
}

module.exports = {
  routes: {
    'POST /api/home/cameras/consent': cameraConsent.route,
    'GET /api/home/events': homeEvents,
  },
};
