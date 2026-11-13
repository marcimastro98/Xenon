// The key states widgets publish, as the dashboard page reports them: rebuilt value by value,
// bounded, and sent on to the Deck window only when they change.

const { broadcastSSE } = require('../http/sse-clients.js');
const { stateRelays } = require('../deck/state-relays.js');

// ── SDK deck states relay ────────────────────────────────────────────────────
// Widget-published deck states live in the DASHBOARD page (postMessage bridge in
// custom-widget.js) — but the Virtual Deck popup hosts no widget frames, so the
// host page mirrors each change here (POST /sdk/deck-states) and the server
// re-broadcasts it as the `sdk_states` SSE event + seeds it on connect. Values
// are re-validated and re-built key-by-key (never spread), bounded, and carry
// only projected state — no widget code, no secrets. In-memory only.
// 256 = the true client-side bound (32 packages × 8 declared states); the
// per-value cap MUST match onBridgeState's 200-char cap in custom-widget.js or
// a value-equality sdkState binding matches on the dashboard but not in the popup.
const SDK_DECK_STATES_MAX = 256;

const _sdkDeckStates = { states: {}, meta: {} };
function acceptSdkDeckStates(body) {
  if (!body || typeof body !== 'object') return false;
  const states = {};
  const meta = {};
  let count = 0;
  const rawStates = (body.states && typeof body.states === 'object') ? body.states : {};
  const rawMeta = (body.meta && typeof body.meta === 'object') ? body.meta : {};
  for (const key of Object.keys(rawStates)) {
    if (count >= SDK_DECK_STATES_MAX) break;
    if (typeof key !== 'string' || !key || key.length > 120) continue;
    count++;
    states[key] = String(rawStates[key] == null ? '' : rawStates[key]).slice(0, 200);
    const m = rawMeta[key];
    if (m && typeof m === 'object') {
      const clean = {};
      if (typeof m.label === 'string' && m.label) clean.label = m.label.slice(0, 24);
      if (typeof m.icon === 'string' && m.icon) clean.icon = m.icon.slice(0, 8);
      if (typeof m.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(m.color.trim())) clean.color = m.color.trim();
      if (Object.keys(clean).length) meta[key] = clean;
    }
  }
  _sdkDeckStates.states = states;
  _sdkDeckStates.meta = meta;
  const sig = JSON.stringify(_sdkDeckStates);
  if (sig === stateRelays.widgetKeys) return false;
  stateRelays.widgetKeys = sig;
  broadcastSSE('sdk_states', _sdkDeckStates);
  return true;
}

module.exports = { SDK_DECK_STATES_MAX, _sdkDeckStates, acceptSdkDeckStates };
