'use strict';
// RivaTuner's readings over exclusive full screen (index.js). No route of its own: its
// state rides on GET /api/gamemode/status and the menu's state. Listed in
// feature-routes.js so it starts with the engine and gives its slot back at shutdown.

const rtss = require('./index.js');

rtss.start();

module.exports = { routes: {}, stop: rtss.stop };
