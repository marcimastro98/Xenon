'use strict';

// Opaque item ids for the Dev cleanup sources. Derived from what the id stands
// for (model name, folder, disk file) rather than its position, so an overview
// rebuilt between the user's look and their tap can never shift an id onto a
// different item. Still opaque: a hash prefix, never the value itself.

const crypto = require('crypto');

const ID_RE = /^[a-z][0-9a-f]{12}$/;
const stableId = (prefix, key) => prefix + crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 12);

module.exports = { stableId, ID_RE };
