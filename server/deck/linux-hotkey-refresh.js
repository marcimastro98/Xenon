// Brings the Linux desktop's shortcut entries in line with the chosen search shortcut and page
// shortcuts.

const { _hotkey } = require('./hotkey-state.js');
const { _linuxHotkey } = require('./engine-linux-hotkey.js');

// On Linux the page shortcuts are desktop entries like the Spotlight one, one
// per slot, and the desktop runs a command rather than pushing an event — so
// each carries its own index in the URL it pokes. Registering is a one-shot
// write, so this reconciles the whole set on every settings save and reports
// per-slot state the same way the helper does.
function refreshLinuxHotkey(want, combo, pages) {
  if (want) {
    if (_hotkey.state !== 'listening' || _hotkey.combo !== combo) {
      _hotkey.state = 'starting';
      _linuxHotkey.register(combo).then((r) => {
        _hotkey.state = r.state || (r.ok ? 'listening' : 'error');
        _hotkey.combo = r.ok ? combo : '';
      }).catch(() => { _hotkey.state = 'error'; _hotkey.combo = ''; });
    }
  } else {
    _hotkey.state = 'off';
    _hotkey.combo = '';
    _linuxHotkey.unregister().catch(() => { /* nothing registered */ });
  }
  const wanted = pages.map((b) => ({
    slot: b.slot,
    combo: b.combo,
    // The name the desktop's keyboard settings list it under.
    name: b.slot === 'overlay' ? 'Xenon overlay' : b.slot === 'replay' ? 'Xenon replay' : b.slot === 'menu' ? 'Xenon menu'
      : b.widgetId ? 'Xenon widget ' + (pages.filter((x) => x.widgetId).indexOf(b) + 1)
      : (b.keyId ? 'Xenon shortcut ' : 'Xenon page ') + (Number(b.slot.split('-')[1]) + 1),
    // The index is the binding's position in the WHOLE table, not among the
    // pages, so the press routes through the same _hotkey.bindings the helper
    // path uses and there is one router rather than two.
    route: '/pages/hotkey-press?i=' + _hotkey.bindings.indexOf(b),
  }));
  _linuxHotkey.syncSlots(wanted).then((r) => {
    _hotkey.slots = {};
    for (const [slot, res] of Object.entries((r && r.slots) || {})) {
      _hotkey.slots[slot] = (r.ok && res) ? (res.state || (res.ok ? 'listening' : 'error')) : 'error';
    }
    if (r && !r.ok) for (const b of wanted) _hotkey.slots[b.slot] = r.state || 'error';
  }).catch(() => {
    _hotkey.slots = {};
    for (const b of wanted) _hotkey.slots[b.slot] = 'error';
  });
}

module.exports = { refreshLinuxHotkey };
