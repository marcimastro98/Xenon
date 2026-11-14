'use strict';
// How long a Store entry's description may be: the shared limit, or a fixed one when the shared
// file is not there.

// Descriptions are a small Markdown subset (shared/src/rich-text.js); the limit
// lives there. Same guard as above, with the hub's number as the fallback.
let DESCRIPTION_MAX = 800;
try { DESCRIPTION_MAX = require('../shared/src/rich-text.js').DESCRIPTION_MAX; }
catch { /* keep the fallback */ }

module.exports = { DESCRIPTION_MAX };
