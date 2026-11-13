// The named values a script can set to light a Deck key: checked, bounded, and sent to the
// screens only when they change.

const { broadcastSSE } = require('../http/sse-clients.js');
const { stateRelays } = require('./state-relays.js');

// ── Script states: a Deck key that mirrors something Xenon cannot see ───────
// Deck keys light up from sixteen things Xenon knows about — the mic, OBS, Home
// Assistant, a widget's published state. What they could not do is mirror
// anything ELSE on the machine: asked on Discord by someone with an AppleScript
// that swaps between two audio outputs, who wanted the key to carry a different
// icon per output. The key already supports two faces (deck-model.js
// `stateStyle`); what was missing was something to tell it which side it is on.
//
// So: a named value any local script can set, and any key can bind to. The
// AppleScript ends with one curl and the icon follows.
//
// A SEPARATE store from the SDK one on purpose. /sdk/deck-states is a full-map
// MIRROR of what the widgets in the dashboard page are publishing — it replaces
// the map on every relay — so a script writing into it would erase every widget
// state and be erased right back on the next relay. These merge instead, and
// nothing else writes here.
const SCRIPT_STATES_MAX = 64;
const SCRIPT_STATE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const _scriptStates = { states: {} };

// Set or clear one named value. A null/absent value REMOVES it, so a script can
// tidy up after itself rather than leaving a key lit forever. Returns the reason
// it refused, or '' on success.
function setScriptState(name, value) {
  const key = String(name == null ? '' : name).trim();
  if (!SCRIPT_STATE_NAME_RE.test(key)) return 'bad_name';
  if (value == null || value === '') {
    if (!Object.hasOwn(_scriptStates.states, key)) return '';
    delete _scriptStates.states[key];
  } else {
    // A new name past the cap is refused; an existing one may always be updated,
    // or a full map would freeze at whatever happened to fill it first.
    if (!Object.hasOwn(_scriptStates.states, key)
      && Object.keys(_scriptStates.states).length >= SCRIPT_STATES_MAX) return 'too_many';
    _scriptStates.states[key] = String(value).slice(0, 200);
  }
  const sig = JSON.stringify(_scriptStates);
  if (sig !== stateRelays.scripts) {
    stateRelays.scripts = sig;
    broadcastSSE('script_states', _scriptStates);
  }
  return '';
}

module.exports = { SCRIPT_STATES_MAX, SCRIPT_STATE_NAME_RE, _scriptStates, setScriptState };
