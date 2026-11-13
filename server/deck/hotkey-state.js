// The global shortcut listener as the engine holds it: the helper process, the keys it was
// handed, and how it is stopped.

// Global Spotlight hotkey (helper-gated, opt-in). The helper's hotkey-serve
// owns a RegisterHotKey + message loop and pushes a line per press; the server
// opens/refocuses the /spotlight Edge app-mode window on the main PC. State is
// surfaced to Settings via GET /search/hotkey-status; 'taken' means another
// app (PowerToys Run on Alt+Space, typically) owns the combo.
const _hotkey = { proc: null, combo: '', combos: '', state: 'off', diedAt: 0, failures: 0, bindings: [], slots: {} };

// The table the helper is handed, in the order it is handed it: the helper
// addresses a combo by its POSITION, so this array IS the wire format and the
// index of a press is an index into it.
//
// Spotlight goes first when it is on, which is also the compatibility story: a
// helper too old to understand a list registers only the first combo and
// reports a press with no index, which reads as index 0 — so on a stale binary
// the search shortcut still works and the page ones are simply absent, rather
// than the whole feature failing.
const MAX_HOTKEY_BINDINGS = 16;

// One pending retry at a time. Without it a single helper crash disabled the
// global shortcut until the user re-saved settings or restarted the app:
// refreshHotkeyListener() is only called from POST /settings and at boot.
const HOTKEY_RETRY_MS = 15000;
const HOTKEY_RETRY_MAX_MS = 5 * 60 * 1000;

function _stopHotkeyListener() {
  const p = _hotkey.proc;
  _hotkey.proc = null;
  if (!p) return;
  try { p.stdin.end(); } catch {}
  const force = setTimeout(() => { try { p.kill(); } catch {} }, 2000);
  force.unref();
  p.once('exit', () => clearTimeout(force));
}

module.exports = {
  _hotkey, MAX_HOTKEY_BINDINGS, HOTKEY_RETRY_MS, HOTKEY_RETRY_MAX_MS, _stopHotkeyListener,
};
