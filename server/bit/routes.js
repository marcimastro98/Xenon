'use strict';
// The person's own Bit (structure-conventions.md §5, listed in feature-routes.js).
//
//   GET  /api/bit         the Bit as the app draws it: seed, number, stage, name,
//                         what it wears and owns, how far each trait has come.
//                         A paired phone may: it is the same dashboard. Never
//                         the counts behind the traits (traits.js), only the
//                         closed month's recap for its card (months.js).
//   POST /api/bit/hatch   the egg hatches (hatch.js): a call to the hub, or a
//                         Bit born here after days without one. A phone may.
//   POST /api/bit/wear    { worn: [item ids] } from what the Bit owns. A phone may.
//   POST /api/bit/name    { name } shown on the card; '' clears it. A phone may.
//   POST /api/bit/prefs   { place?, reactions?, sounds?, classic?, roam?, warp?, spot?, desk?, deskX? }: where
//                         the companion lives (on the desktop too) and how much it does. A phone may.
//                         Also asks the hub for its Bit items (items.js) when its list is old.
//   POST /api/bit/claim   { item } a supporter's item of the month, kept for good with the
//                         PC's pass (keep.js). The PC only: it uses the pass.
//   POST /api/bit/buy     { item, consent? } a shop item for Sparks (keep.js). The PC only:
//                         it spends Sparks.
//   POST /api/bit/publish { public } shows the Bit on xenon-app.com or takes it
//                         down (publish.js): the hub hears its name, outfit and
//                         stage, nothing else. A phone may: the same sheet.
// Each change is told to every surface as the 'bit' event (the same answer).
// Every POST is in CSRF_MUTATION_PATHS: another site must not name or dress it.

const { createRoutes } = require('./handlers.js');
const bit = require('./index.js');
const { hub } = require('../settings/current.js');
const { broadcastSSE } = require('../http/sse-clients.js');

const made = createRoutes({
  store: bit.store, hatch: bit.hatch, founder: bit.founder, publish: bit.publish, keep: bit.keep, items: bit.items, settings: () => hub.settings, changed: (b) => broadcastSSE('bit', b),
});

// Written out key by key: tools/restructure reads this list from the text.
module.exports = {
  routes: {
    'GET /api/bit': made['GET /api/bit'],
    'POST /api/bit/hatch': made['POST /api/bit/hatch'],
    'POST /api/bit/wear': made['POST /api/bit/wear'],
    'POST /api/bit/name': made['POST /api/bit/name'],
    'POST /api/bit/prefs': made['POST /api/bit/prefs'],
    'POST /api/bit/claim': made['POST /api/bit/claim'],
    'POST /api/bit/buy': made['POST /api/bit/buy'],
    'POST /api/bit/publish': made['POST /api/bit/publish'],
  },
  stop: bit.stop,
};
