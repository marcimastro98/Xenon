// Gives each saved list a number higher than the last one, so a screen can tell the newer of
// two copies.

// Every write of the list gets a higher number, sent with the list (broadcast,
// edit answer, load), so a screen can tell which of two lists is newer and
// never shows an older one over a newer one. Time-based so it keeps rising
// across restarts.
const _nextListSeq = (prev) => Math.max(Date.now(), prev + 1);

module.exports = { _nextListSeq };
