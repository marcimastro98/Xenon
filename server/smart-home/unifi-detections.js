// Turns one camera detection into alerts on the screens, one per kind the user switched on, and
// not again for the same camera and kind until the waiting time is over.

const { broadcastSSE } = require('../http/sse-clients.js');
const { UNIFI_COOLDOWN_MAX } = require('./limits.js');
const { unifiNotify } = require('./unifi-notify-state.js');
const doorbell = require('./doorbell.js');
const homeLog = require('./home-events.js');

const _unifiNotifyCooldown = new Map();   // "camId|kind" -> last-broadcast ms

function notifyKind(det, kind, cooldownMs, now) {
  const key = det.camId + '|' + kind;
  const last = _unifiNotifyCooldown.get(key) || 0;
  if (now - last < cooldownMs) return;
  _unifiNotifyCooldown.set(key, now);
  // Bound the cooldown map: drop the oldest entries if it grows too large.
  if (_unifiNotifyCooldown.size > UNIFI_COOLDOWN_MAX) {
    const drop = _unifiNotifyCooldown.size - UNIFI_COOLDOWN_MAX;
    let i = 0;
    for (const k of _unifiNotifyCooldown.keys()) { if (i++ >= drop) break; _unifiNotifyCooldown.delete(k); }
  }
  broadcastSSE('unifi_event', { camId: det.camId, name: det.name || det.camId, kind, at: det.at || now });
}

// A ring is the doorbell's card (doorbell.js); with that card switched off it stays an ordinary camera alert.
// Handle one decoded detection: fan its kinds out to individual toasts, each gated
// by the user's per-kind toggle and the per-camera+kind cooldown. Reads the notify
// snapshot cached by refreshUnifiEventsWatch (which runs on every settings save and
// SSE membership change) — a busy camera must not cost a settings read per event.
function _onUnifiDetection(det) {
  if (!det || !det.camId || !Array.isArray(det.kinds)) return;
  homeLog.fromUnifi(det);
  const notify = unifiNotify.snapshot;
  if (!notify) return;
  const now = Date.now();
  if (det.kinds.includes('ring') && notify.types.ring === true) {
    doorbell.fromUnifi(det)
      .then((card) => { if (card === 'off' && notify.enabled === true) notifyKind(det, 'ring', notify.cooldownMs, now); })
      .catch(() => {});
  }
  if (notify.enabled !== true) return;
  for (const kind of det.kinds) {
    if (kind !== 'ring' && notify.types[kind] === true) notifyKind(det, kind, notify.cooldownMs, now);
  }
}

module.exports = { _unifiNotifyCooldown, _onUnifiDetection };
