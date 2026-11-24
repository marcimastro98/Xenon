// The newest full system reading (system-info.js puts it here), for a reader that must not
// start one of its own: the readings RivaTuner draws over a game (server/rtss/).

let latest = { info: null, at: 0 };

/** @param {any} info a full reading, never a partial one */
function rememberSystemInfo(info) {
  latest = { info, at: Date.now() };
}

/** The newest full reading, or null once it is older than `maxAgeMs`. @param {number} maxAgeMs */
function latestSystemInfo(maxAgeMs) {
  return Date.now() - latest.at <= maxAgeMs ? latest.info : null;
}

module.exports = { rememberSystemInfo, latestSystemInfo };
