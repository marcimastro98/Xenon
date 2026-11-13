// Turns one camera detection into alerts on the screens, one per kind the user switched on, and
// not again for the same camera and kind until the waiting time is over.

const { broadcastSSE } = require('../http/sse-clients.js');
const { UNIFI_COOLDOWN_MAX } = require('./limits.js');
const { unifiNotify } = require('./unifi-notify-state.js');

const _unifiNotifyCooldown = new Map();   // "camId|kind" -> last-broadcast ms

// Handle one decoded detection: fan its kinds out to individual toasts, each gated
// by the user's per-kind toggle and the per-camera+kind cooldown. Reads the notify
// snapshot cached by refreshUnifiEventsWatch (which runs on every settings save and
// SSE membership change) — a busy camera must not cost a settings read per event.
function _onUnifiDetection(det) {
  if (!det || !det.camId || !Array.isArray(det.kinds)) return;
  const notify = unifiNotify.snapshot;
  if (!notify || notify.enabled !== true) return;
  const types = notify.types;
  const cooldownMs = notify.cooldownMs;
  const now = Date.now();
  for (const kind of det.kinds) {
    if (types[kind] !== true) continue;
    const key = det.camId + '|' + kind;
    const last = _unifiNotifyCooldown.get(key) || 0;
    if (now - last < cooldownMs) continue;
    _unifiNotifyCooldown.set(key, now);
    // Bound the cooldown map: drop the oldest entries if it grows too large.
    if (_unifiNotifyCooldown.size > UNIFI_COOLDOWN_MAX) {
      const drop = _unifiNotifyCooldown.size - UNIFI_COOLDOWN_MAX;
      let i = 0;
      for (const k of _unifiNotifyCooldown.keys()) { if (i++ >= drop) break; _unifiNotifyCooldown.delete(k); }
    }
    broadcastSSE('unifi_event', { camId: det.camId, name: det.name || det.camId, kind, at: det.at || now });
  }
}

module.exports = { _unifiNotifyCooldown, _onUnifiDetection };
