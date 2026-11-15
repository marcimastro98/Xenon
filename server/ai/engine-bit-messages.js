// The engine's inbox of what Bit has to tell the person.

const path = require('node:path');
const { broadcastSSE } = require('../http/sse-clients.js');
const { createBitMessages } = require('../bit-messages.js');
const { DATA_DIR } = require('../engine/paths.js');
const { hub } = require('../settings/current.js');

// What Bit has to tell the person, one inbox for every screen (bit-messages.js).
const bitMessages = createBitMessages({
  file: path.join(DATA_DIR, 'bit-messages.json'),
  settings: () => hub.settings,
  onChange: () => broadcastSSE('bit-messages', {}),
});

module.exports = { bitMessages };
