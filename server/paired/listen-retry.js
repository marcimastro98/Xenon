// How long the engine keeps asking for its port when another program holds it.

const EADDRINUSE_MAX_RETRIES = 15;   // ~15 s of retrying before giving up
const EADDRINUSE_RETRY_MS = 1000;

module.exports = { EADDRINUSE_MAX_RETRIES, EADDRINUSE_RETRY_MS };
