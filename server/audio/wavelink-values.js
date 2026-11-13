// Elgato Wave Link: the check of its saved settings, and the state widgets get while it is
// switched off.

// The disabled shape must carry the same KEYS as the live one, or the widget
// reads `channels` as undefined the moment the integration is switched off and
// renders an error instead of the "turn it on in Settings" line it has.
const WL_OFF_STATE = Object.freeze({
  enabled: false, connected: false, dialect: 0, version: '',
  channels: [], mixes: [], outputs: { mainId: '', mainOutputId: '', mainListed: false, devices: [] }, monitor: null,
  capabilities: { meters: false, effects: false, outputDevices: false, monitorSwitch: false, namedMixes: false },
});

// Elgato Wave Link config: opt-in enable + optional pinned port (0 = auto-scan
// the 1824..1834 range). No secrets — the local WS is unauthenticated.
function normalizeWaveLinkSettings(v) {
  const s = v && typeof v === 'object' ? v : {};
  const port = parseInt(s.port, 10);
  return { enabled: s.enabled === true, port: (port >= 1 && port <= 65535) ? port : 0 };
}


module.exports = { WL_OFF_STATE, normalizeWaveLinkSettings };
