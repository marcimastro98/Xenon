'use strict';
// The Xenon AI edge glow: which screens light up while a voice chat is on.
// The setting lives in hubSettings.aiEdgeGlow; the main dashboard reads it
// (js/ai-edge-glow.js) and the native shell draws the glow, so this file only
// changes the choice.
//
// deps (injected):
//   host     { available() } — the native shell reported itself (layers-host.js);
//            the glow is drawn by the same shell
//   settings { setAiEdgeGlow(mode) } — writes the setting under the settings lock

const MODES = Object.freeze(['auto', 'main', 'second', 'all', 'off']);

function available(host) {
  return !!(host && typeof host.available === 'function' && host.available());
}

async function setScreens(d, action) {
  const mode = MODES.includes(action.screens) ? action.screens : null;
  if (!mode) return { ok: false, error: 'bad_screens', choices: MODES.slice() };
  if (!d.settings || typeof d.settings.setAiEdgeGlow !== 'function') return { ok: false, error: 'unavailable' };
  const saved = await d.settings.setAiEdgeGlow(mode);
  return saved ? { ok: true, screens: saved } : { ok: false, error: 'failed' };
}

module.exports = { MODES, available, setScreens };
