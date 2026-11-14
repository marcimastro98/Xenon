// What stops the live Discord watch while one runs, and the one way to stop it.

/** @type {{ stop: (() => void) | null }} */
const discordWatch = { stop: null };

// Stops the watch when one is running. A second call does nothing. A stop that throws
// leaves the watch as it was, so the next call tries again.
function stopDiscordWatch() {
  const stop = discordWatch.stop;
  if (stop) { stop(); discordWatch.stop = null; }
}

module.exports = { discordWatch, stopDiscordWatch };
