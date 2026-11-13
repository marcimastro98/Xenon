// How often the PC numbers are read: memory details, network, device batteries during a game,
// and whether the user is away.

const RAM_INFO_RETRY_MS = 60 * 1000;

// Each surface polls on its own clock and every reading is a collector run with
// three pings, so whoever asks just after someone else shares that reading. Under
// the 3 s poll of the System tile, which still gets a new one each time.
const NETWORK_FRESH_MS = 2500;

// Adaptive cadence: 15s while the user is active (presence changes slowly),
// 5s once the PC looks unattended — dismissing the Ambient screensaver and the
// vitals return-credit both hinge on spotting the RETURN quickly, and a
// GetLastInputInfo read via the persistent worker costs microseconds. The fast
// tick only runs while nobody is at the PC, so it taxes no one. When a fresh
// sample shows activity resumed, the status broadcast goes out immediately so
// clients react within one probe tick instead of also waiting for the 3s timer.
const IDLE_POLL_MS = 15000;
const IDLE_POLL_FAST_MS = 5000;
const IDLE_AWAY_SEC = 45;   // deliberately below the 60s minimum screensaver threshold

// Each read is a PowerShell and a process asking the dongles. Through a game five
// minutes still keeps a low mouse on screen, and stays inside battery.js STALE_MS.
const BATTERY_POLL_GAME_MS = 5 * 60 * 1000;

module.exports = {
  RAM_INFO_RETRY_MS, NETWORK_FRESH_MS, IDLE_POLL_MS, IDLE_POLL_FAST_MS, IDLE_AWAY_SEC,
  BATTERY_POLL_GAME_MS,
};
