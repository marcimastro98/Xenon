'use strict';
// The pump screens' routes (structure-conventions.md §5, listed in feature-routes.js).
//
//   GET  /pump        every screen with what it shows now, for the face page. The PC
//                     only: it is in CSRF_MUTATION_PATHS for the POST, and a phone's
//                     menu reads the pumps inside the menu's own state.
//   POST /pump        a change: { screen, patch } | { screen, setup } | { screen, show,
//                     minutes } (a face now) | { screen, show: null } (automatic again)
//                     | { screen, forget: true }. A paired phone may: it is the user's
//                     dashboard. In CSRF_MUTATION_PATHS.
//   POST /pump/hello  the face page on a pump says which screen it is and its size.
//                     Kept in memory, never written (store.js). The PC only; in
//                     CSRF_MUTATION_PATHS.
//   POST /pump/colors  the face page says the colours of what it shows, for the ring of
//                     lights around the pump (ring.js). Kept in memory. The PC only; in
//                     CSRF_MUTATION_PATHS.
//   POST /pump/picture  a picture of the person's own for the Picture face (picture.js):
//                     answers its /uploads/ address. A paired phone may, as with a
//                     slideshow's pictures. In CSRF_MUTATION_PATHS.
//   GET  /pump-face   the face page itself, which iCUE's widget or NZXT CAM shows on
//                     the pump. The PC only (refused-paths.js); a page in cross-site.js
//                     PAGES, because iCUE's widget frames it from file://.
//   GET  /pump-widget  a Store widget as a pump's face (pump-widget.html), framed by the
//                     face page. The PC only (refused-paths.js), a page in PAGES like it.
// Opening the iCUE widget is an action (pumpIcue, actions.js), run on the PC only.

const { createRoutes } = require('./handlers.js');
const { createPictureUpload } = require('./picture.js');
const { UPLOADS_DIR } = require('../engine/uploads-dir.js');
const pump = require('./index.js');
const { hub } = require('../settings/current.js');

const made = createRoutes({ store: pump.store, live: pump.live, ring: pump.ring, settings: () => hub.settings });

// Written out key by key: tools/restructure reads this list from the text.
module.exports = {
  routes: {
    'GET /pump': made['GET /pump'],
    'POST /pump': made['POST /pump'],
    'POST /pump/hello': made['POST /pump/hello'],
    'POST /pump/colors': made['POST /pump/colors'],
    'GET /pump-face': made['GET /pump-face'],
    'GET /pump-widget': made['GET /pump-widget'],
    'POST /pump/picture': createPictureUpload({
      store: pump.store, dir: UPLOADS_DIR, pinned: () => pump.live.pinnedShows(), warn: (m) => console.warn(m),
    }),
  },
  stop: pump.stop,
};
