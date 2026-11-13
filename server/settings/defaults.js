// The settings a new install starts with: the eight parts next to this file put together, in
// the order they are saved and sent.

const { HUB_DEFAULTS_LOOK } = require('./defaults-look.js');
const { HUB_DEFAULTS_SCREEN } = require('./defaults-screen.js');
const { HUB_DEFAULTS_APP } = require('./defaults-app.js');
const { HUB_DEFAULTS_TILES } = require('./defaults-tiles.js');
const { HUB_DEFAULTS_ASSISTANT } = require('./defaults-assistant.js');
const { HUB_DEFAULTS_FEATURES } = require('./defaults-features.js');
const { HUB_DEFAULTS_CONNECTIONS } = require('./defaults-connections.js');
const { HUB_DEFAULTS_INSTALL } = require('./defaults-install.js');

const DEFAULT_HUB_SETTINGS = Object.freeze({
  ...HUB_DEFAULTS_LOOK,
  ...HUB_DEFAULTS_SCREEN,
  ...HUB_DEFAULTS_APP,
  ...HUB_DEFAULTS_TILES,
  ...HUB_DEFAULTS_ASSISTANT,
  ...HUB_DEFAULTS_FEATURES,
  ...HUB_DEFAULTS_CONNECTIONS,
  ...HUB_DEFAULTS_INSTALL,
});

module.exports = { DEFAULT_HUB_SETTINGS };
