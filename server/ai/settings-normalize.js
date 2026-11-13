// Checks the saved settings of Bit: which AI features are on, the proactive messages and the
// wake word.

// Mirrors the client-side normalizeAiFeatures: every flag must be exactly
// `true` to count — anything else collapses to false (opt-in by design).
function normalizeServerAiFeatures(value) {
  const v = value && typeof value === 'object' ? value : {};
  return {
    enabled: v.enabled === true,
    genesis: v.genesis === true,
    gameCompanion: v.gameCompanion === true,
    guardian: v.guardian === true,
    ambient: v.ambient === true,
    pcControl: v.pcControl === true,
  };
}

function normalizeProactive(value) {
  const v = value && typeof value === 'object' ? value : {};
  return {
    thermal: v.thermal !== false,
    recap: v.recap !== false,
    morning: v.morning !== false,
    anomaly: v.anomaly !== false,
  };
}

// Local "Hey Bit" wake word — strict opt-in (privacy: enabling means the
// server keeps the microphone open while a dashboard is on screen).
function normalizeWakeWord(value) {
  const v = value && typeof value === 'object' ? value : {};
  return { enabled: v.enabled === true };
}

module.exports = { normalizeServerAiFeatures, normalizeProactive, normalizeWakeWord };
