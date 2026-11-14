// The engine's own Performance Mode session, made when the engine starts: the process table,
// priorities, the culprit finder and Core Shield, each working only when asked.

const { nativeCollectors } = require('../system/native-collectors.js');
const { createPerfSession } = require('./index.js');
const { DATA_DIR } = require('../engine/paths.js');

const perfSession = createPerfSession({ collectors: nativeCollectors, dataDir: DATA_DIR });

module.exports = { perfSession };
