// Where it is noted that the capture engine was checked for this version of the app.

const path = require('node:path');
const { DATA_DIR } = require('../engine/paths.js');

// The capture engine is compiled, so like the helper it cannot ride in the
// source zip the self-update applies: it is its own release asset, covered by
// the same Ed25519-signed SHA256SUMS and fetched through the same verified path.
// One difference: nobody ever declined the engine (the helper is optional in the
// installer), and every install made before it existed lacks it, so a MISSING
// engine is fetched from this version's release, not only refreshed. Until it is
// there the capture features stay hidden (`requires`), never broken.
const CAPTURE_CHECK_MARKER = path.join(DATA_DIR, 'capture-checked.txt');

module.exports = { CAPTURE_CHECK_MARKER };
