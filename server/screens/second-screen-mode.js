// Setting the size of the second screen's picture: the virtual display is made when it is
// missing, and the person is told when a restart is needed.

const { readHubSettings } = require('../settings/read.js');
const { secondScreen, screenCapture } = require('./second-screen-hosts.js');

// Apply a resolution to the virtual display. Fast path: commit the advertised mode
// live via the helper (no UAC, no device churn) — this is what actually makes the
// chosen resolution stick (a new VDD monitor sits at a stale 800x600 default until
// a mode is committed). Fallback: if the mode isn't advertised yet (display missing
// or created by an older single-mode config), (re)create it with the full preset
// config — which is elevated but idempotent (remove-then-install one, never spam) —
// then commit again.
async function applySecondScreenMode(mode, opts) {
  const soft = !!(opts && opts.soft);
  let width = mode && mode.width;
  let height = mode && mode.height;
  // Soft auto-restore (the tile re-asserting the saved resolution on every load):
  // trust the *persisted* resolution from settings.json, not the client-sent one.
  // On a fresh page load the tile may fire this before its hubSettings is populated
  // and would otherwise send the 1080p default — silently clobbering the user's
  // saved mode, which is exactly the "I have to re-apply every time" bug. The server
  // always has the authoritative saved value, so resolve it here.
  if (soft) {
    try {
      const s = await readHubSettings();
      const ss = s && s.secondScreen;
      if (ss && ss.width > 0 && ss.height > 0) { width = ss.width; height = ss.height; }
    } catch (e) { /* fall back to the client-sent mode */ }
  }
  const m = { monitor: 'virtual', width, height };
  if (!(m.width > 0 && m.height > 0)) return { ok: false, code: 'bad_args' };

  try {
    const r = await screenCapture.setMode(m);
    if (r && r.ok) return { ok: true, code: 'mode_applied', width: r.width, height: r.height };
  } catch (e) { /* fall through to (re)create */ }

  // Silent auto-restore path (tile re-asserting the saved resolution on load): never
  // fall back to the elevated device (re)create — a UAC prompt on every restart is
  // exactly what we're avoiding. The user can re-apply manually from Settings.
  if (soft) return { ok: false, code: 'needs_apply' };

  const created = await secondScreen.createDisplay(mode);
  if (!(created && created.ok)) return created;
  if (created.code === 'display_needs_reboot') return created;

  try {
    const r2 = await screenCapture.setMode(m);
    if (r2 && r2.ok) return { ok: true, code: 'mode_applied', width: r2.width, height: r2.height };
  } catch (e) { /* display exists; mode may settle after a reboot */ }
  return { ok: true, code: 'display_ready' };
}

module.exports = { applySecondScreenMode };
